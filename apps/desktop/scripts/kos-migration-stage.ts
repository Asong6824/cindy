import { stageKosMigration } from '../src/main/vault-sync/kosMigrationImport';

async function main() {
  const [source, indexedDb, destination, relayOrigin] = process.argv.slice(2);
  if (!source || !indexedDb || !destination || !relayOrigin || process.argv.length !== 6) {
    console.error('用法：kos-migration-stage.ts <快照目录> <IndexedDB 导出 JSON> <尚不存在的目标目录> <旧资料库的 HTTPS origin>');
    process.exitCode = 2;
    return;
  }
  try {
    console.log(JSON.stringify(await stageKosMigration(source, indexedDb, destination, relayOrigin), null, 2));
  } catch (error) {
    const code = error instanceof Error && /^KOS_(SNAPSHOT|MIGRATION)_[A-Z_]+$/.test(error.message) ? ` (${error.message})` : '';
    console.error(`未能生成 KOS 迁移副本${code}。如目标目录已有部分结果，请保留该目录，核对输入后选择新的目标目录重试。`);
    process.exitCode = 1;
  }
}

void main();
