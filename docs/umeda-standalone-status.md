# Umeda 独立中转：WIP 进度

此分支保存尚未完成的实现，不代表已部署或可直接交付。

目标链路：手机／其他电脑通过 Cloudflare Worker + SQLite Durable Object 连接执行电脑，
执行电脑使用本地供应商配置直接调用用户的大模型 API；设备互联不要求 Cindy 账号。

## 当前实现

- `packages/device-link-relay/cloudflare/worker.ts`：单个命名 Durable Object 承载私有中转，
  复用现有 Hub、配对和设备证书验证；WebSocket attachment 保存休眠恢复所需的连接状态。
- 初始化要求部署环境固定 `UMEDA_OWNER_PUBLIC_KEY`，主人签名覆盖初始化信息及凭证哈希。
  公钥不是秘密，主人私钥及设备凭证保留在客户端现有安全存储中。
- Desktop 本地模式允许配置自建中转，新增准备主人身份、初始化并连接 Worker 的本机 IPC 和设置入口。
  退出线路时关闭旧连接；官方账号能力仍受原有账号权限控制。
- Mobile 用显式构建变量 `EXPO_PUBLIC_UMEDA_MODE=1` 启用独立模式。它使用本地数据 owner，
  不生成账号 token，不将本地模式标为已认证账号；等待设备身份及中转配置恢复后才挂载业务树。
  在此模式下，普通 API 请求只允许发往已配置并持有设备凭证的自建中转。
- 原设备协议、配对证明和逐帧签名继续使用；跨账号分享、云端伙伴和官方推送不属于独立中转能力。
- Worker 附件暂存使用 Durable Object storage：单文件 8 MiB，总容量 256 MiB，保留 24 小时，
  签名 URL 最长一小时。超过上限明确报错。Node 中转原有容量保持原实现。
  大文件能力需要后续单独适配，不能将此实现描述为与 Node 中转容量完全相同。

## 已执行的验证

- 共享 `device-link` 测试：58 个文件，1,231 项通过。
- Node 中转：19 项测试通过；真实加入、签名通信和自动重连互通测试通过。
- Worker 平台端口测试：4 项通过，覆盖初始化签名、持久化配对、休眠状态恢复、撤销设备和附件 Range。
  这些是内存平台端口测试，不能代替真实 workerd／Cloudflare 验证。
- Desktop 配置、运行时及能力边界：26 项定向测试通过。
- `device-link` 及 Worker 类型检查通过；Wrangler `deploy --dry-run` 打包通过。

上述是阶段性检查记录，不代表后续修改或完整 CI 已通过。

## 未完成及恢复工作入口

1. 完成 Desktop、Mobile 全量类型检查。Mobile 曾发现独立 Provider 导入路径错误，已修正，待重跑确认。
   首次 Mobile 检查还触发过默认 Node 堆内存上限；需按本机预算配置检查进程内存。
2. 执行真实 workerd 互通：`pnpm --filter @cindy/device-link-relay run interop:cloudflare`。
   Node 基线入口为 `pnpm --filter @cindy/device-link-relay run interop`。
3. 完成客户端本地模式启动、配对、断线恢复和换 owner 回归；增加独立模式专属入口的行为覆盖。
   Light/Dark 界面尚未实机目检。
4. 完成手机安装包的更新隔离：当前独立 JS 启动树跳过官方启动检查，仍需验证原生 Expo Updates
   配置及手动更新入口，避免独立包被官方 bundle 覆盖。不能把 JS 构建变量等同于原生隔离已经完成。
5. 补齐协议说明和配置使用文档，完成存储并发及真实休眠恢复审查。
6. 在本地验证完成后进行 Cloudflare 登录、固定主人公钥、部署及公网端到端验证。
   本分支尚未执行线上部署，不包含账号凭证、设备私钥或 LLM API Key。

Worker 配置在 `packages/device-link-relay/wrangler.jsonc`。
可用 `pnpm --filter @cindy/device-link-relay cloudflare:dev` 启动本地开发；
部署命令为 `pnpm --filter @cindy/device-link-relay cloudflare:deploy`，仅在完成上述准备并获授权后执行。
