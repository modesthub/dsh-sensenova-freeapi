## Why

当前 `sensennova` 通过宿主内置的 `llm-pi-ai` 接入，而内置可配置 provider 每个路由只支持一个 `apiKeyEnv`，无法配置多个 API Key（账号）并在密钥失效时自动轮换。需要一个独立插件注册 `sensenova` 路由，提供「同一 baseURL 下多账号 401 轮换 + 429 交宿主退避」能力。

## What Changes

- 新增插件 `dsh-sensenova-freeapi`（仓库 `alaxrpg/dsh-sensenova-freeapi`，目录 `deepseek-harness-plugin/dsh-sensenova-freeapi/`），按 alpha 线发布。
- 注册独立的 `sensenova` provider 路由，与现有 `llm-pi-ai` 的 `sensennova`（双 n）并存，互不冲突。
- 提供多账号配置：默认账号 `apiKeyEnv`（默认 `SENSENOVA_API_KEY`）+ 共享 `apiBase`（默认 `https://token.sensenova.cn/v1`）+ 额外账号 `accounts[]` + 手动钉选 `activeAccount`。
- 提供多账号轮换：仅 401 禁用该 key 并自动切换到下一个可用账号；429 不轮换、不冷却（SenseNova 渠道常态性 RPM 瞬时超限，一个会话固定使用一个 key，保护服务端按 key 命中的 prompt 缓存），直接抛 `RATE_LIMIT` 交由宿主重试层退避后原 key 重试。
- 实时拉取模型目录：`GET /v1/models`（OpenAI 兼容端点，需先取得可用 key）。
- 提供 Web 设置页：`apiBase`、默认 key、账号增删、`activeAccount` 选择。
- 显式排除（不实现）：用量 dashboard、`/commandcode` 命令、浏览器登录流、web search 后端、plan/计费感知选择器、套餐/优惠/峰谷价快照、推理强度快照、图片门控快照、5 小时窗口探测。

## Capabilities

### New Capabilities

- `sensenova-provider`: 以 OpenAI 兼容协议接入 SenseNova 端点，注册 `sensenova` 路由并提供多账号配置与轮换、`/v1/models` 模型目录、Web 设置页。

### Modified Capabilities

<!-- 无既有 capability 被修改 -->

## Impact

- 新增 npm 包与 GitHub 仓库；`package.json` 的 `peerDependencies` 使用 `>=0.1.2-alpha.3`（不设上界），宿主接口包只进 `peerDependencies`。
- 注册到宿主 `llm` 服务：`registerAdapter(['sensenova'], adapter)` + `registerConfigurableProviders([...])` + 设置段 `llm-sensenova`。
- 客户端新增 `settings.section` 与 `settings.models.provider-card` 两个槽位。
- 凭据走宿主凭据服务（`SENSENOVA_API_KEY` 及 `accounts[].apiKeyEnv`），API key 原文不进日志、不发送给模型。
