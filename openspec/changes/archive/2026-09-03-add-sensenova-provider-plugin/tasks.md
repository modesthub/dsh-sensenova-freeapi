## 1. 项目骨架

- [x] 1.1 在 `deepseek-harness-plugin/dsh-sensenova-freeapi/` 建立包结构（`package.json`、`cordis.patch.yml`、`tsconfig.json`、`src/`、`src/client/`）
- [x] 1.2 编写 `package.json`：`name` 为 `dsh-sensenova-freeapi`，`type: module`，`main`/`types`/`exports` 指向 lib，`dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh.client` 声明 web 平台与注入
- [x] 1.3 编写 `cordis.patch.yml`：`insert` 一行 `llm-sensenova`，`name` 为完整包名 `"dsh-sensenova-freeapi"`，`config.apiKeyEnv: SENSENOVA_API_KEY`
- [x] 1.4 声明 `peerDependencies`（宿主接口包，`>=0.1.2-alpha.3`，不设上界）与必要的 `devDependencies`
- [ ] 1.5 建立 GitHub 仓库 `alaxrpg/dsh-sensenova-freeapi`（dsh-plugin topic、MIT、README）并配置本地 git 身份为 alaxrpg

## 2. 配置与账号池

- [x] 2.1 实现 `Config` schema（schemastery/zod）：`apiKeyEnv`（默认 `SENSENOVA_API_KEY`，credential-ref）、`apiBase`（默认 `https://token.sensenova.cn/v1`）、`accounts[]`（label/apiKeyEnv）、`activeAccount`
- [x] 2.2 实现 slot 归一化：default 槽 + accounts 槽，过滤无凭据条目
- [x] 2.3 实现账号池：状态以 key 为键，`resolvedAccounts()` 去重、`selectActiveAccount()`、`resolveKey()`
- [x] 2.4 实现 `markRejected`：`invalid-credential`（401）→ `disabled` 永久禁用；`rate-limit`（429）→ 不写任何状态（不冷却，见 spec「429 不冷却不轮换」）
- [x] 2.5 实现耗尽错误：全 disabled（仅 401 产生）→ `INVALID_CREDENTIAL`；429 单独作为 `RATE_LIMIT` 抛给宿主（`Retry-After` >0 且 ≤3000ms 透传 `providerRetryAfterMs`）

## 3. 适配器

- [x] 3.1 实现 `LlmAdapter` 子类：`providerInfo()` 返回 `{id: 'sensenova', name: 'SenseNova'}`
- [x] 3.2 实现 `listModels()` / `resolveModel()`：`GET {apiBase}/v1/models`，无 key 时返回空目录
- [x] 3.3 实现 `stream()`：`POST /v1/chat/completions`，携带 `attributionHeaders()` 与 `Authorization: Bearer <key>`
- [x] 3.4 实现流开始前的轮换循环：`tried` 集合 + `rotateApiKey`，仅 401 换下一个，429 不轮换直接抛 `RATE_LIMIT`，每个 key 至多尝试一次
- [x] 3.5 实现 OpenAI SSE → `StreamChunk` 翻译（文本/推理/工具调用/usage/finish），借鉴 `dsh-llm-pi-ai` 的 `toStreamChunks`
- [x] 3.6 `providerRetryPolicy()` 声明 normal / maxRetries=1000 / backoff 上限 3000ms，覆盖 429 高频常态

## 4. 插件入口与设置段

- [x] 4.1 实现 `apply(ctx, config)`：`registerConfigurableProviders` + `registerAdapter(['sensenova'], adapter)`
- [x] 4.2 接入凭据服务解析 key（`ctx.get('credentials')` → resolve，fallback 环境变量）
- [x] 4.3 `ctx.inject(['settings'])` → `settings.installSection(ctx, 'llm-sensenova', Config, config, {...})`

## 5. Web 设置页

- [x] 5.1 实现客户端 `apply`：注册 locale、绑定 `settingsScope` 到 `llm-sensenova`
- [x] 5.2 实现设置页控制器：字段编辑（apiBase / 默认 key / activeAccount）、账号增删与标签、key 编辑
- [x] 5.3 `ctx.slots.inject('settings.section', ...)` 注册整页（id `sensenova`）
- [x] 5.4 `ctx.slots.inject('settings.models.provider-card', ...)` 注册 Models 页卡片（key `llm-sensenova`）

## 6. 验证与发布

- [x] 6.1 `npm run typecheck` 与 `npm run build`（tsdown）通过
- [x] 6.2 单元测试：账号池轮换（429 不冷却不轮换/401 禁用/耗尽错误）、Retry-After 双阈值、SSE 翻译
- [ ] 6.3 本地装回验证：`dsh plugin --profile web add <path>` 后重启，Models 页出现 sensenova 卡片且目录可拉取
- [ ] 6.4 npm 发布 `dsh-sensenova-freeapi`（alpha dist-tag），市场验证更新检测
