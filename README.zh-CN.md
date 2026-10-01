# dsh-sensenova-freeapi

非官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）LLM 提供商插件，对接 **SenseNova**（OpenAI 兼容 API）。注册 `sensenova` 提供商路由，附带 Models 页卡片、实时模型目录，以及**单共享 baseURL 上的多账户 API-key 轮换**。

> 参考实现：[`@mars-sea/dsh-commandcode-provider`](https://github.com/Mars-Sea/dsh-commandcode-provider)（MIT）。本插件只保留多账户连接能力；登录流程、用量面板、套餐窗口、命令行工具均已裁剪。

## 功能

- 注册提供商路由 `sensenova`（显示名 **SenseNova**）。
- 实时模型目录：`GET {apiBase}/v1/models`。
- OpenAI 兼容流式输出：`POST {apiBase}/v1/chat/completions`（SSE）。
- 图片输入：视觉模型（如 `kimi-k3`、`sensenova-6.8-flash-lite`）的持久化图片解析为
  Base64 Data-URL 发送；单图解析失败只跳过该图，不打断整次请求。
  - **按宿主版本下发正确的请求目标**：`Attachments.readImageRequest()` 的第二参数在
    **0.1.6 变更过形状** —— 0.1.5 是 `ImageRequestPolicy {maxPixels, maxBytes}`，
    0.1.6 是 `ImageRequestTarget {width, height, maxBytes}`。本插件由
    `requestImageTarget(ref)` 按图片自身尺寸算出目标，并**同时带上 0.1.5 的 `maxPixels`**，
    使同一份返回值在两条版本线上都能通过存储层校验（降级回 0.1.5 无需回滚）。
    > ⚠️ 这是 0.1.6 升级时**唯一真正打断读图功能**的改动：传旧形状会被
    > `checkedInteger(target.width)` 抛 `INVALID_ATTACHMENT_REF`
    > （`Image request width must be a positive integer.`），若被上层 `catch {}` 吞掉，
    > 就表现为「模型读图读不对」——其实是**一个像素都没发出去**。
  - **遵守宿主 0.1.6 的 offload 契约**：被宿主标记 `offloaded` 的图片（由
    `compaction-image-offload` 在官方路由触发 `IMAGE_OFFLOAD_REQUIRED` 后决定）
    **不发字节**，改为宿主措辞一致的占位文本，且不会触发附件解析。
- 单个共享 baseURL 上的多个 API 密钥（账户），自动轮换：
  - `429 Too Many Requests` → 冷却该密钥（尊重 `Retry-After`；缺失时兜底 60 s）。
  - `401 Unauthorized` → 禁用该密钥，直到存储的凭据发生变化。
  - 全部密钥耗尽 → 以 `RATE_LIMIT` / `INVALID_CREDENTIAL` 暴露最早恢复时间。
- Web 设置页（Models 页卡片 + 独立设置页）。

## 环境要求

- DSH 宿主 `>=0.1.2-alpha.3`（alpha 线）。
- Node.js `>=22`。

> 兼容性说明：运行时导入面是 `@deepseek-ai/dsh-llm` 自 `0.1.1-rc.2` 起就存在的稳定子集
> （`LlmAdapter`、`LlmError`、`ReasoningEffortId`、`assertUsableApiKey`、
> `attributionHeaders`、`errorChain`、`resolveRetryPolicy`）；漂移符号 `ToolCallId`
> 改为本地定义（`src/brand.ts`，恒等返回）。因此在 `0.1.1-rc.2` 宿主上可正常运行时加载；
> peer 下限 `>=0.1.2-alpha.3` 是类型支持起点（`ToolCallId` 类型首次出现于此版本）。
>
> **DSH 0.1.6 适配（v0.1.0-alpha.8 起）**：0.1.6 把插件依赖解析改为 **runtime 模式**并引入
> 运行时卸载（`@deepseek-ai/dsh-hmr`），同时对 provider 契约做了三处调整 ——
> `LlmImageRequestPricing.priceImages()` 的入参由 `ImageAttachmentRef[]` 改为
> `ImageBlock[]`、新增 `ImageBlock.offloaded` 与 `IMAGE_OFFLOAD_REQUIRED`，以及
> **`AttachmentStore.readImageRequest()` 的第二参数由 `ImageRequestPolicy` 改为
> `ImageRequestTarget`**（harness commit `ba30b73f7b`）。本插件
> **不实现** `imageRequestPricing`，故第一条无影响；`offloaded` 与请求目标按下述方式遵守：
> 前者经 `isOffloadedImage()` 结构化读取、后者由 `requestImageTarget()` 双形状下发，
> **在 0.1.5 与 0.1.6 的类型下均可通过 `tsc`**，运行时在 0.1.5 上自然退化为旧行为
> ⇒ 降级回 0.1.5 无需回滚本插件源码。
> 插件的全部注册都挂在 `ctx.*` 作用域、无长生命周期句柄、模块级状态均为不可变常量，
> 因而可被安全运行时卸载。
>
> **v0.1.0-alpha.9（2026-09-20）**：修复上面第三条漏改导致的**读图全线静默失效**
> （详见「图片输入」小节）。新增 `tests/image-request-target.test.ts` 作为回归护栏 ——
> 它 **不 mock `resolveImage`**，而是贴着 `readImageRequest` 断言第二参数形状，并复刻
> 存储层的参数校验；在漏改的代码上该文件必然失败。此前 160 个单测全绿却线上全丢图，
> 盲区正是「单测把 `resolveImage` 整个 mock 掉了」+「插件自建结构化接口使 `tsc` 看不见
> 上游契约漂移」。

## 安装

```bash
dsh plugin --profile <name> add dsh-sensenova-freeapi
```

或从本地路径安装：

```bash
dsh plugin --profile <name> add ./dsh-sensenova-freeapi
```

随后在 Models 页配置 **SenseNova**：默认凭据环境变量为 `SENSENOVA_API_KEY`，默认 baseURL 为 `https://token.sensenova.cn/v1`。

## 配置

插件安装 `llm-sensenova` 设置段，包含以下字段：

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `apiBase` | string | `https://token.sensenova.cn/v1` | 所有账户共享的 baseURL。 |
| `apiKeyEnv` | credential-ref | `SENSENOVA_API_KEY` | 默认账户的凭据引用。 |
| `accounts[]` | array | `[]` | 额外账户：`{ id, label, apiKeyEnv }`。 |
| `activeAccount` | string | `""` | 首选账户 id；空表示自动 / 首个可用。 |

API 密钥经 DSH 凭据服务存储，绝不打印到日志、也绝不发送给模型。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm run build    # tsdown → lib/
pnpm test         # node --import tsx --test tests/**/*.test.ts
```

## 许可证

MIT
