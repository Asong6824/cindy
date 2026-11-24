import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';
import { createLocalCliProviderRegistry, discoverLocalCliProviders, type LocalCliProviderIo } from '../localCliProviders.js';

// Test value: discoverLocalCliProviders -> real provider projection and main-only key lookup.
// Regression: existing CLI API settings were treated as missing official subscription logins.
// Coverage gap: native auth tests only cover OAuth; these cases never read real HOME or spawn CLI.
// Minimal failure: a custom model_provider + OPENAI_API_KEY, or settings.env with an API token.
// Tier: unit (in-memory IO, separate from DB/catalog integration). Timing recorded in delivery.
function fixture(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): LocalCliProviderIo {
  const home = path.resolve('fixture-cli-home');
  const stored = new Map(Object.entries(files).map(([file, content]) => [path.join(home, ...file.split('/')), content]));
  return { home, env, read: async file => stored.get(file) ?? null };
}

const codexConfig = 'model = "custom-codex"\nmodel_provider = "relay"\n[model_providers.relay]\nbase_url = "https://relay.example/v1"\nwire_api = "responses"';
const claudeSettings = JSON.stringify({ env: {
  ANTHROPIC_BASE_URL: 'https://claude-relay.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'fixture-claude-key',
  ANTHROPIC_MODEL: 'custom-sonnet', ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-sonnet',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'custom-haiku',
} });

describe('local CLI API connections', () => {
  it('projects both API routes and models without including keys in catalog configs', async () => {
    const items = await discoverLocalCliProviders(fixture({
      '.codex/config.toml': codexConfig, '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-codex-key"}',
      '.claude/settings.json': claudeSettings,
    }));
    expect(items).toHaveLength(2);
    expect(items.map(item => buildUserProvider(item.config))).toMatchObject([
      { auth: { method: 'apiKey' }, routing: { codex: { upstream: 'https://relay.example/v1' } },
        models: { codex: [{ id: 'custom-codex', defaultEnabled: true }] } },
      { auth: { method: 'apiKey' }, routing: { 'claude-code': { upstream: 'https://claude-relay.example/anthropic' } },
        models: { 'claude-code': [{ id: 'custom-sonnet' }, { id: 'custom-haiku' }] } },
    ]);
    expect(JSON.stringify(items.map(item => item.config))).not.toContain('fixture-');
  });

  it('uses the selected Codex profile and its explicit env_key without falling back to other keys', async () => {
    const files = { '.codex/config.toml': codexConfig + '\n' +
      'env_key = "RELAY_KEY"\n[profiles.work]\nmodel = "profile-model"\n',
    '.codex/auth.json': '{"OPENAI_API_KEY":"wrong-fixture-key"}' };
    files['.codex/config.toml'] = 'profile = "work"\n' + files['.codex/config.toml'];
    expect(await discoverLocalCliProviders(fixture(files))).toEqual([]);
    const [item] = await discoverLocalCliProviders(fixture(files, { RELAY_KEY: 'right-fixture-key' }));
    expect(item.apiKey).toBe('right-fixture-key');
    expect(item.config.runtimes.codex?.models[0].id).toBe('profile-model');
  });

  it('honors CLI home overrides and inherited API environment without reading default homes', async () => {
    const io = fixture({ 'alternate/config.toml': codexConfig,
      'alternate/auth.json': '{"OPENAI_API_KEY":"fixture-alternate-key"}' });
    io.env = { CODEX_HOME: path.join(io.home, 'alternate'), CLAUDE_CONFIG_DIR: path.join(io.home, 'empty'),
      ANTHROPIC_BASE_URL: 'https://env-relay.example', ANTHROPIC_API_KEY: 'fixture-env-key', ANTHROPIC_MODEL: 'env-model' };
    const items = await discoverLocalCliProviders(io);
    expect(items.map(item => item.apiKey)).toEqual(['fixture-alternate-key', 'fixture-env-key']);
  });

  it.each(['tokens', 'unsupported-wire', 'unsafe-url', 'missing-model'])('does not turn %s into an API connection', async kind => {
    let config = codexConfig;
    let auth = '{"OPENAI_API_KEY":"fixture-key"}';
    if (kind === 'tokens') auth = '{"tokens":{"access_token":"fixture-oauth-token"}}';
    if (kind === 'unsupported-wire') config = config.replace('"responses"', '"unknown"');
    if (kind === 'unsafe-url') config = config.replace('https://relay.example/v1', 'https://user:secret@relay.example/v1');
    if (kind === 'missing-model') config = config.replace('model = "custom-codex"', '');
    expect(await discoverLocalCliProviders(fixture({ '.codex/config.toml': config, '.codex/auth.json': auth }))).toEqual([]);
  });

  it('isolates malformed settings and never executes a Claude apiKeyHelper', async () => {
    const items = await discoverLocalCliProviders(fixture({ '.codex/config.toml': 'malformed [[[',
      '.claude/settings.json': claudeSettings }));
    expect(items.map(item => item.agent)).toEqual(['claude-code']);
    expect(await discoverLocalCliProviders(fixture({ '.claude/settings.json':
      '{"apiKeyHelper":"must-not-execute","model":"some-model"}' }))).toEqual([]);
  });

  it('keeps custom headers main-only and does not read user settings in UI mock mode', async () => {
    const io = fixture({ '.codex/config.toml': codexConfig + '\n[model_providers.relay.http_headers]\nx-tenant = "private-tenant"',
      '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-key"}' });
    const items = await discoverLocalCliProviders(io);
    const registry = createLocalCliProviderRegistry();
    const [config] = registry.replace(items, () => true);
    expect(registry.readHeaders(config.id, 'codex')).toEqual({ 'x-tenant': 'private-tenant' });
    expect(JSON.stringify(buildUserProvider(config))).not.toContain('private-tenant');
    io.env.XDT_UI_MOCK = '1';
    io.read = async () => { throw new Error('UI mock must not read local configuration'); };
    expect(await discoverLocalCliProviders(io)).toEqual([]);
  });

  it('does not import official Claude subscription tokens as API credentials', async () => {
    expect(await discoverLocalCliProviders(fixture({ '.claude/settings.json': JSON.stringify({ env: {
      ANTHROPIC_AUTH_TOKEN: 'fixture-oauth-token', ANTHROPIC_MODEL: 'some-model',
    } }) }))).toEqual([]);
  });

  it('revokes an entire key snapshot on owner change or config removal and changes identity with the destination', async () => {
    const files = { '.codex/config.toml': codexConfig, '.codex/auth.json': '{"OPENAI_API_KEY":"fixture-key"}' };
    const items = await discoverLocalCliProviders(fixture(files));
    const registry = createLocalCliProviderRegistry();
    let authorized = true;
    const [config] = registry.replace(items, () => authorized);
    expect(registry.readKey(config.id, 'codex')).toBe('fixture-key');
    expect(registry.readKey(config.id, 'claude-code')).toBeNull();
    authorized = false;
    expect(registry.readKey(config.id, 'codex')).toBeNull();
    authorized = true;
    registry.replace([], () => authorized);
    expect(registry.readKey(config.id, 'codex')).toBeNull();
    const [changed] = await discoverLocalCliProviders(fixture({ ...files,
      '.codex/config.toml': codexConfig.replace('relay.example', 'different.example') }));
    expect(changed.config.id).not.toBe(config.id);
  });
});
