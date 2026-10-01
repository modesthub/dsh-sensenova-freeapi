## Why

SenseNova 的 `GET /v1/models` 目录是「脏」的：它混入了文生图模型（`sensenova-u1-fast` / `sensenova-u1.5-lite`，`output_modalities` 为 `image`）与已下线路由的旧模型（`sensenova-6.7-flash-lite`，调用返回 404 "model route not found"）。插件 `listModels()` 原样透传全部条目，导致宿主模型选择器出现不可用选项。同时插件丢弃了目录的多模态声明（硬编码 `inputModalities: ['text']`）、以原始 id 作为显示名（`sensenova-6.7-flash-lite` 而非 `Sensenova 6.7 Flash Lite`），并沿用宿主默认重试策略（5 次、退避上限 10 秒），与使用需求不符。上下文大小虽已部分读取目录字段，但模型解析还没有把 `listModels()` 获取的上下文、最大输出和思考级别等能力完整自动传给宿主。

## What Changes

- 模型目录过滤：仅保留 `output_modalities` 含 `text` 的对话模型；对已知不可路由条目（至少 `sensenova-6.7-flash-lite`）及运行时已标记失败的 stale 条目从目录中排除，未知 stale 条目首次请求由 404 兜底并写入进程内失败缓存。
- 模型不可用兜底：`stream()` 收到 404 "model route not found" / "model is not found" 时，抛出明确的模型不可用错误而非裸 404。
- 多模态声明：`inputModalities` 从目录的 `input_modalities` 读取，恢复文本+图像模型的多模态能力。
- Provider 重试策略：重试上限 1000 次、本地退避延迟上限 3 秒（`maxDelayMs=3000`），覆盖宿主默认的 10 秒上限；服务端提供超过 3 秒的 `Retry-After` 时不透传为 provider 延迟，避免突破上限。
- 显示名标准化：模型显示名使用标准可读名称（如 `sensenova-6.7-flash-lite` → `Sensenova 6.7 Flash Lite`）。
- 模型能力自动配置：每次 `listModels()` 获取目录后用新快照更新缓存，`resolveModel()` 自动生成 `context`、`defaultMaxTokens` 与 `reasoning`；只采用目录明确声明的上下文、最大输出和思考级别，不凭空生成能力。
- 手动模型可选覆盖：在用户设置中持久化文本模型的 `include`/`exclude` 选择；`include` 可重新加入已知或运行时判定 stale 的文本模型，`exclude` 可隐藏自动暴露的文本模型，image-only 模型始终不进入当前 chat 选择器。

## Capabilities

### New Capabilities

<!-- 无——能力 `sensenova-provider` 已由 add-sensenova-provider-plugin 引入，本变更仅硬化其行为。 -->

### Modified Capabilities

- `sensenova-provider`: 模型目录过滤、模型不可用错误兜底、多模态声明、模型能力自动配置、手动模型可选覆盖、provider 重试策略与模型显示名标准化。

## Impact

- 代码：`src/adapter.ts`（目录解析、`listModels()`、`resolveModel()`、`stream()`、`httpError()`、`providerRetryPolicy()`）及 `src/accounts.ts` 的 Retry-After 上限映射；账号冷却仍保留服务端原始时长，只有提交给 provider 重试层的延迟受 3000ms 上限约束。
- 测试：`tests/adapter.test.ts` 新增目录过滤、失败缓存、模型不可用错误、重试策略、显示名、多模态、上下文大小、最大输出与思考级别的用例，并增加手动模型选择覆盖用例。
- 客户端设置：`src/index.ts`、`src/client/settings.ts`、`src/client/section.tsx`、`src/client/locales.ts` 增加模型 include/exclude 配置、持久化和本地化设置入口。
- 运行时行为：`sensenova` 路由默认只显示可路由的对话模型；用户可显示/隐藏文本模型并重新加入 stale 文本模型，但 image-only 模型始终排除；模型能力随 `listModels()` 目录更新自动同步；重试策略从 5 次/10 秒变为 1000 次/3 秒；服务端超过 3 秒的 Retry-After 不会突破 provider 延迟上限。
- 归档顺序：先完成并归档 `add-sensenova-provider-plugin`，建立 `sensenova-provider` 主 spec 基线，再归档本变更的 `MODIFIED Requirements`。
- 无新增依赖；`resolveRetryPolicy` 复用 `@deepseek-ai/dsh-llm` 既有导出。
