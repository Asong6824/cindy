# Umeda 独立中转：WIP 进度

个人版现已按主人明确选择切为无设备身份验证模式；Worker 已更新，Desktop 已重启，
新版 iPhone 包已覆盖安装并启动，主人已确认直接连接后可以调用 Mac 并收到回复。

目标链路：手机／其他电脑通过 Cloudflare Worker + SQLite Durable Object 连接执行电脑，
执行电脑使用本地供应商配置直接调用用户的大模型 API；设备互联不要求 Cindy 账号。

## 当前实现

- `packages/device-link-relay/cloudflare/worker.ts`：单个命名 Durable Object 承载私有中转，
  复用现有 Hub 的路由与流量限制；WebSocket attachment 保存休眠恢复所需的连接状态。
  Wrangler 显式配置 `UMEDA_AUTH_MODE=none`，该路径不要求设备凭证，不签发或核对设备证书。
- 当前无验证模式自动建立中转，无初始化签名、配对、核对码或审批接口。
  设备 ID 是客户端自报的公开路由标签，不是身份凭证；任何能访问此公网地址的客户端均可接入。
  这是主人在了解公网访问后果后的明确自用选择，不是普通 Cindy / Node 中转的默认模式。
  旧身份数据保留，不删除；无验证路径只迁移设备名称、ID 和媒体存储信息，不读取旧凭证或私钥。
- Desktop 本地模式允许配置自建中转，通过本机设置入口直接连接 Worker，不再展示公钥、扫码或审批入口。
  退出线路时关闭旧连接。个人版启动默认恢复 `local-v1`，不读取云账号刷新凭证；
  登录及添加账号旧路由回到首页，移除设置和侧边栏的账号入口、退出按钮与模型登录推广；
  个人模式不显示官方手机包下载推广，避免安装到不匹配的账号版。
  模型供应商自己的 OAuth／API Key 及设备配对认证仍保留；旧账号数据不删除、不自动合并。
- Mobile 默认启用独立模式；`EXPO_PUBLIC_UMEDA_MODE=0` 仅用于显式旧账号构建／兼容性测试。
  手机设置和首页菜单不显示账号切换、退出和注销操作。它使用本地数据 owner，
  不生成账号 token，不将本地模式标为已认证账号；等待设备身份及中转配置恢复后才挂载业务树。
  在此模式下，普通 API 请求只允许发往当前已配置的自建中转，不发送 Authorization。
  手机优先使用构建时的 `EXPO_PUBLIC_UMEDA_RELAY_URL`，已有安装可沿用旧设置里的公开地址；
  地址由本地构建环境提供，不把个人地址写入仓库。两种来源均无需读取 SecureStore。
- 独立手机包的原生身份为 `app.umeda.cindy`（iOS / Android）、scheme 为 `umeda`，
  Expo Updates 在原生配置中禁用，不继承 EAS owner / project 或自建更新地址。
  显式切换构建模式时，原生生成与 JS 打包必须使用相同变量；不能通过向普通 Cindy
  安装包下发 JS 来切成独立包。默认个人包的原生身份已改变，需要单独冷构建、签名与安装。
  模拟器入口的 Metro 身份包含独立模式开关，拒绝复用普通账号模式的 Metro。
- 独立 iOS 包移除 Apple 登录、远程推送与通信通知能力，以支持个人团队签名；
  保留 App Group、分享扩展与主屏小组件。原生插件在增量 prebuild 时也会清理旧能力，
  避免仅修改配置而遗留旧 entitlement；此变更需要重新冷构建安装。
- Cloudflare 自用线路无需加入二维码；手机本地生成的任务／项目链接使用独立 scheme。
  原 Cindy 加入链接及 Node 中转行为保留。独立模式发件箱按本地 owner 恢复持久消息，
  不借用账号认证状态。
- Cloudflare 自用线路复用 v1 消息结构，但不发送或校验设备签名；Desktop / Mobile 同步采用
  显式 `None` 连接方案，WebSocket 不发 Authorization。Node 中转保留原配对、凭证和逐帧签名。
  本机远控与远程桌面开关仍生效。跨账号分享、云端伙伴和官方推送不属于独立中转能力。
- Worker 附件暂存使用 Durable Object storage：单文件 8 MiB，总容量 256 MiB，保留 24 小时，
  签名 URL 最长一小时。超过上限明确报错。Node 中转原有容量保持原实现。
  大文件能力需要后续单独适配，不能将此实现描述为与 Node 中转容量完全相同。

## 已执行的验证（2026-11-15）

- 共享 `device-link` 测试：58 个文件，1,231 项通过。
- 中转包全量：5 个文件、51 项通过（含 Node 的 19 项与 Worker 的 4 项）。
- Worker 平台端口测试：4 项通过，覆盖初始化签名、持久化配对、休眠状态恢复、撤销设备和附件 Range。
  这些是内存平台端口测试，不能代替真实 workerd／Cloudflare 验证。
- Node 与真实本地 workerd 均通过加入、签名通信和自动重连互通测试。
  真实 workerd 另外通过 256 KiB + 1 字节附件的分块上传／完整下载核对。
  本地 harness 使用 Miniflare 5 的官方 V4 配置转换器，并把临时 bundle 目录设为模块根目录；
  Worker 继承 `cloudflare:workers` 的 `DurableObject` 原生基类。
- Desktop 配置、运行时及能力边界：25 项定向测试通过。
- 个人模式改动的 Desktop 定向测试：14 个文件、207 项通过；Mobile 定向测试：5 个文件、64 项通过。
  Desktop / Mobile 全量类型检查、文档、测试卫生与术语表门禁通过；Mobile scope 与两个远程流程 smoke 通过。
- 首次真实启动发现 Renderer 身份初始化竞态：边界中的推送先到时，后到的更高 ownerGeneration
  稳定初始化结果仍需接纳；同代或更旧返回继续服从推送，不能倒退身份。已用
  `authService.test.ts` 的两个失败回归复现并修复，9 项服务测试通过（含同代边界不能提前放行）；
  个人模式变更后，真实窗口已无需登录直接进入主界面，并已检查用户菜单和通用设置。
- Mobile：8 个文件、137 项定向测试通过，覆盖独立构建、原生加入深链、账号与独立模式请求边界、发件箱持久恢复、任务链接及
  模拟器 Metro 身份的定向测试通过。发件箱和模拟器复用用例均在修复前复现失败，修复后通过。
- Desktop、Mobile、中转包（Node / Worker）的全量类型检查通过；Wrangler `deploy --dry-run`
  打包通过。共享 `device-link` 的类型由上述宿主检查覆盖。
- 个人模式成为默认值之前，普通 Cindy 的 iOS / Android 原生指纹曾与同环境基线一致。
  当前默认产物已改为独立包，该历史结果不能证明当前默认产物指纹不变，也不能替代真机构建。

- Desktop 页面检查实际执行 `pnpm ui:check --changed --theme all --case default`：
  129 个页面的 258 个双主题默认场景中，248 个通过、10 个失败。已检查概览及设置／供应商截图。
  失败集中于 `im-default-model` / `relay-service` 缺少 AuthProvider、`model-protocol-paths`
  缺少 `getModelPriceOverride` 宿主替身，以及两个 PR 预览场景的 iframe 沙箱脚本错误；
  对三组上下文／API 缺失追加 `--compare HEAD` 后，原始提交在 Light/Dark 下同样失败，
  确认为已有夹具缺口。两个 PR 场景的原始／当前代码定向复测均通过，仍保留全跑时的沙箱报错记录；
  未通过跳过断言、放宽沙箱或忽略控制台错误把总检结果改成通过。
  真实应用已覆盖本地启动、用户菜单、通用设置、供应商配置、中转连接与重启恢复；
  独立的启动门、路由及供应商引导卡仍没有页面夹具覆盖，不能把总检当作其双主题实机验收。

线上 Worker 关闭预览 URL；`keep_vars: true` 保留历史部署变量，当前模式不再使用主人公钥。
个人部署变量不固化进共享仓库。配置行为见
[Cloudflare Wrangler 配置文档](https://developers.cloudflare.com/workers/wrangler/configuration/)。

上述是阶段性检查记录，不代表后续修改或完整 CI 已通过。

## iPhone 构建与安装（2026-11-16）

- 已配置完整 Xcode 27.2、iOS 27.2 SDK 与 CocoaPods；按主人选择使用个人团队，
  三个原生 target 均由 Xcode 自动管理签名，未使用组织团队。
- 原生配置及构建入口回归共 50 项通过，Mobile 全量类型检查、scope 与测试卫生门禁通过。
  回归覆盖增量 prebuild 清除旧账号／推送能力，以及 SDK 58 使用 `--no-clean` 保留本地签名配置。
- iPhone Release 构建完成，复用现有构建脚本的隐式模块配置，规避 WechatOpenSDK 的显式模块扫描失败。
  产物通过 `codesign --verify --deep --strict`；原生 OTA 禁用、无更新 URL，内嵌 JS 与原生指纹匹配。
  构建产物、描述文件与设备标识均留在仓库之外。
- 独立包已成功安装到已连接的 iPhone。本机构建签名检查通过；首次启动被 iOS 安全检查拒绝后，
  主人在手机设置中信任开发者，并确认 Umeda 可以打开；设备进程查询确认主应用与小组件运行。
  主人提供的浅色截图确认进入任务首页、未出现账号登录页；尚未配对时首页显示连接与同步失败提示。
  Worker 公网健康与加入探测接口均返回 200。
- 主人完成手机加入操作后，Desktop「我的设备」显示一台 iPhone 在线；公网中转的双设备配对已验证。
  主人随后开启本机设备控制；Desktop 确认总开关与该手机的设备控制授权生效。
  主人在手机选择 Mac 发送一条简单回复测试，确认收到预期回复；
  至此手机 → 自有 Worker → Desktop 执行 → 手机回包的基本链路已通过主人实机验证。
  未据此推定停止、附件、远程桌面画面、断网恢复或长期休眠场景已通过。

## 无验证自用模式验收（2026-11-17）

- 主人明确选择连后台设备凭证与签名一并移除；实现限于个人 Cloudflare / 独立手机线路。
- 共享客户端 58 个文件、1,232 项通过；中转包 52 项通过；新增无验证 Worker 契约覆盖历史公开元数据迁移、
  不带凭证读取设备、不带签名转发消息与休眠恢复，原签名模式测试仍保留。
- 真实 workerd 的无验证互通与自动重连通过；Node 原有加入、签名通信与自动重连互通通过。
  Desktop 无 Authorization 的 REST、空密钥库恢复路由、运行时和已有签名回归通过；Mobile 预设地址／
  旧配置地址启动均不读安全存储，无凭证请求、无签名路径及两个远程 smoke 通过。
- Desktop / Mobile / Node relay / Worker 类型检查通过；Mobile scope、测试卫生、文档、术语及 i18n 门禁通过。
  页面默认 Light / Dark 检查仍被已记录的 AuthProvider 夹具缺口阻断，未标为通过；浅色真实设置页已核对。
- iPhone Release 包成功构建并通过系统签名检查；同一应用标识覆盖安装并成功启动。
  iOS / Android 指纹与前一版分别一致，原生 OTA 仍禁用。
- 线上 Worker `authMode=none`、版本 `0.3.1-umeda.2`；健康与加入探测信息均不要求鉴权。
  同一 Desktop 配置重启达到 ready，界面已移除公钥、二维码和加入审批入口，随后确认 iPhone 在线。
  主人保持新版手机在前台，直接发出测试消息并确认收到预期回复；本次未扫码或批准。
- 双端实机断网恢复、附件、停止和远程桌面画面尚未验证；自动重连结论来自真实本地 workerd。

## 当前交付边界与恢复入口

1. Desktop 已实机验证无需登录启动、连接私有中转及重启后的身份／中转自动恢复。
   手机已配对且 Desktop 确认在线；主人已验证通过手机调用 Mac 并收到回复。
   停止、附件、断线恢复及换 owner 仍待双设备验收。
   Light 已实机检查；Dark 尚未实机检查。
2. 独立手机包已完成真机构建、签名、安装与主人确认首次打开，并核对产物的原生 OTA 禁用；
   仍需页面与手动更新入口检查。个人团队签名需要定期重新签名安装；不能据安装成功声称完成 iPhone 验收。
   原生 E2E 尚未执行。
3. 完成存储并发及真实休眠恢复审查。本地 workerd 的通信与重连通过，不代表已经验证
   Cloudflare 平台真实休眠／唤醒、长期持久化或公网网络条件。
4. 初版的签名初始化与 401 / 403 验证属于历史记录；当前按主人选择改为公开、无设备身份验证的线路。
   旧身份留在原隔离开发配置中但不参与当前连接，不删除旧任务、配置或秘密。
   仓库不包含个人中转地址、账号凭证、设备私钥、主人公钥值或 LLM API Key。

Worker 配置在 `packages/device-link-relay/wrangler.jsonc`。
可用 `pnpm --filter @cindy/device-link-relay cloudflare:dev` 启动本地开发；
部署命令为 `pnpm --filter @cindy/device-link-relay cloudflare:deploy`，仅在完成上述准备并获授权后执行。

## 配置顺序

1. 在自己的 Cloudflare 账号确定 Worker 地址，发布本仓的 Worker（显式 `UMEDA_AUTH_MODE=none`）。
2. Desktop 本地模式填入 HTTPS 地址并点击连接；已有 Cloudflare 设置在重启后自动恢复。
3. 独立手机包构建时注入 `EXPO_PUBLIC_UMEDA_RELAY_URL`，安装后直接连接，无需扫码或批准。
   已配对的旧安装更新后也可只从旧配置读取地址，不读回旧秘密。
4. 同步更新 Worker、Desktop 和 Mobile。旧签名手机会拒绝新线路的未签名消息，不能仅更新 Worker。
   不改变 Node 中转或官方线路；独立包仍不接受普通 Cindy OTA。
5. HTTPS/WSS 仍正常校验证书；移除的是设备身份验证，并未关闭 TLS 或修改模型供应商的 OAuth / API Key。

具备完整 Xcode 与 Simulator runtime 的 macOS 可用既有安全入口检查独立包：
`EXPO_PUBLIC_UMEDA_MODE=1 pnpm mobile:sim:up -- --region=global`。原生编译与 Metro 启动均需保留
该变量；不要把普通模式的 Metro 端口交给独立包，也不要为复用已有安装而改回官方应用 ID。
