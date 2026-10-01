## Context

本设计承接 `proposal.md` 的动机与范围，具体实现以 `specs/sensenova-provider/spec.md` 的已定要求和 `tasks.md` 的完成状态为准。当前适配器已经采用“目录快照驱动能力、请求前账号轮换、SSE 状态机翻译”的结构，相关实现集中在 `/Users/lizhiyuan/项目/deepseek-harness-plugin/dsh-sensenova-freeapi/src/adapter.ts` 与 `/Users/lizhiyuan/项目/deepseek-harness-plugin/dsh-sensenova-freeapi/src/accounts.ts`。

目录请求使用 `{apiBase}/models`，解析后只保留输出模态包含 `text` 的条目，并应用已知不可路由清单、适配器生命周期内的失败缓存及用户选择覆盖。目录快照原子替换 `catalog`，使后续 `resolveModel()` 消费同一批能力数据；没有可解析凭据时，目录请求直接返回空列表，不阻塞 provider 注册。

设置通过 `llm-sensenova` 命名空间接入。`src/index.ts` 负责 schema、credential-ref 严格归一化、模型选择归一化和热更新闭包；`src/client/settings.ts` 负责草稿、保存/重置及凭据状态；`src/client/section.tsx` 和 `src/client/locales.ts` 提供编辑控件与双语文案。API key 只通过宿主凭据服务或受控环境变量解析，文档、日志和界面状态不保存或输出密钥原文。

## Goals / Non-Goals

**Goals:**

- 以目录快照作为模型能力唯一运行时来源，自动同步上下文窗口、最大输出、输入模态与明确声明的 reasoning effort。
- 固化目录过滤和手动覆盖优先级：image-only 永远排除，`exclude` 优先于 `include`，`include` 只能恢复目录中存在的 stale 文本模型。
- 保持预流 HTTP 错误、账号冷却、provider 重试和 SSE 流内错误的边界清晰且可测试。
- 让设置字段经规范化后安全持久化，保存成功立即通过当前配置闭包热更新适配器选项。
- 在不新增依赖、不访问真实 API 的前提下，使用现有测试、类型检查、构建和 OpenSpec 校验验证行为。

**Non-Goals:**

- 不实现 image generation、非文本输出路由或为未知模型创建虚构目录条目。
- 不改变宿主凭据服务协议，不读取、打印、持久化或提交任何真实密钥。
- 不引入新的 HTTP/SSE/重试依赖，不改变已定的任务拆分和 spec 语义。
- 不以真实 SenseNova 服务验证外部 API 行为；本变更只覆盖 OpenAI 兼容协议边界及本地可确定逻辑。

## Decisions

### 目录数据流与快照

`listModels()` 先通过 `resolveApiKey()` 获取可用 key；解析失败返回空目录。成功请求后，`parseCatalog()` 按以下顺序处理每条记录：校验对象和 id → 要求 `output_modalities` 含 `text` → 应用 `exclude` → 若未被 `include` 覆盖则应用已知不可路由清单和 `failedModels` → 解析能力并加入结果。最终一次性替换 `catalog`，再映射成宿主模型列表。这样避免返回新目录而解析模型仍读取旧能力。

能力解析使用字段优先级：上下文依次读取 `context_length`、`context_window`、`max_context_length`、`contextLength`；最大输出依次读取 snake_case 与对应驼峰字段。输入模态只接受宿主支持的 `text`、`image`，去重后无有效声明回退为 `text`。reasoning 只从顶层 effort 词表或 `reasoning.efforts` / `thinking.efforts` 读取；每个 wire value 原样包装为 `ReasoningEffortId`，默认值仅在词表中存在时设置。仅有支持标记不生成 effort。

`resolveModel()` 按 id 从快照查找名称和能力；目录未声明上下文时使用现有兼容默认值，未声明最大输出或 reasoning 时不虚构对应能力。解析快照之外的模型仍可返回可读回退名称，但不会因此进入目录选择器。

### 配置归一化与热更新

`normalizeModelSelection()` 对 include/exclude 做类型过滤、trim、去空和稳定去重；保存页面使用换行或逗号解析为同样的规范形式，两个列表均为空时 unset `modelSelection`。`resolveAdapterOptions()` 重新应用默认值并严格校验所有 credential-ref，非法值转换为空引用且不保留原文。

`apply()` 保留 `current` 配置源及 `lastRaw/lastGood` 缓存。设置宿主调用 `setSource` 后，下一次 `options()` 读取新配置；`onChange` 清除解析缓存。适配器每次请求通过 `options()` 获取 apiBase、账户数量和模型选择，因此保存后的配置无需重建 provider 即可生效。凭据引用只传给 `credentialRef()`，再由 credentials 域解析，环境变量仅作受控兜底。

### 过滤优先级与 stale 兜底

过滤优先级固定为：

1. `output_modalities` 不含 `text`，立即排除，任何手动配置不得恢复。
2. `exclude` 命中，立即排除，即使同时命中 `include`。
3. `include` 命中时，允许目录中存在的已知 stale 或失败缓存文本模型进入列表。
4. 其余条目排除已知不可路由清单和 `failedModels`。

未知 stale 模型首次请求若返回 404 且错误体包含 `model route not found` 或 `model is not found`，先写入适配器进程内失败缓存，再抛出 `MODEL_NOT_FOUND`；该错误不轮换账号、不进入 provider 重试。后续目录刷新仍可由 `include` 显式恢复，但请求继续经过同一 404 兜底。手动配置不在最新目录中的 id 不合成条目。

### 错误、账号冷却与重试边界

请求前仅对 429 和 401 执行有限账号轮换；流已经成功建立并开始消费后，错误由 SSE 解析器直接结束当前生成，不回放到另一账号。404 模型不可路由是稳定的 `MODEL_NOT_FOUND`；其他 404 保持 `PROVIDER_HTTP_ERROR`；401 映射 `INVALID_CREDENTIAL`；429 映射 `RATE_LIMIT`。

账号池按 key 去重并保留拒绝状态。429 的服务端 `Retry-After` 原值用于账号冷却（缺省使用本地冷却），不因 provider 上限而截断；提交 provider 的 `providerRetryAfterMs` 仅在不超过 3000ms 时存在，超过时完全省略。适配器的 `normal` retry policy 固定 `maxRetries=1000`、`backoff.maxDelayMs=3000`，复用 `resolveRetryPolicy` 的既有初始延迟、jitter 和可重试错误集合；本地退避含 jitter 后仍由宿主上限封顶。两种等待语义相互独立。

### SSE 状态管理

`parseOpenAiSse()` 使用单一 `SseState` 跟踪文本、推理和工具调用块索引及累计内容，同时记录 `pendingUsage`、`usageEmitted`、`finished`。每个事件先解析 `data:` JSON，忽略空行、注释、非法 JSON 和 `[DONE]`；推理/文本/工具块切换时先关闭前一块。遇到 finish 时按顺序关闭活动块、最多发出一次 usage，再发出一次 finish；finish 后的 usage-only 事件仍可补发 usage，不重复 finish。流结束无 finish 时关闭剩余块并生成 stop；既无内容又无 finish 时报告 `EMPTY_RESPONSE`。读取器始终在 finally 中 cancel/release，abort 原样传播，其余传输异常包装为 `TRANSPORT`。

### 设置界面与隐私

设置控制器将模型选择作为独立 staged 草稿管理，dirty 状态覆盖 include/exclude；保存按“凭据域写入 → 设置字段写入 → 账户列表写入”执行，成功后清理草稿并触发热更新，失败保留草稿并显示失败状态。界面以 textarea 展示模型 id，不显示目录内容或密钥；API key 输入使用 password 控件，显示/隐藏仅作用于当前内存草稿，凭据状态只显示 configured/writable 布尔值。本设计不读取或输出任何凭据值。

### 测试、构建与环境验证

测试使用注入的 `fetchImpl`、凭据和设置 scope 构造确定性响应，覆盖目录过滤、能力刷新、reasoning 映射、显示名、404 失败缓存、账号不轮换、Retry-After 双阈值、SSE usage/finish 状态机以及设置归一化和保存。验证命令为 `pnpm run typecheck`、`pnpm test`、`pnpm run build` 与 `openspec validate --strict harden-sensenova-provider`；不调用真实 SenseNova API。由于当前环境使用 pnpm 符号链接，构建/类型解析应以仓库现有链接环境为准，不通过新增依赖或替换依赖路径规避问题。

## Risks / Trade-offs

- **目录字段可能缺失或格式异常** → 对能力字段采用正数和明确词表校验；缺失上下文保留现有兼容默认，其他能力保持未知，不阻塞其他模型。
- **失败缓存可能暂时隐藏恢复后的模型** → 缓存限定为适配器生命周期；用户可用 include 覆盖过滤，但实际请求仍执行 `MODEL_NOT_FOUND` 安全兜底。
- **超长 Retry-After 被 provider 层忽略后可能更早重试** → 账号池仍保留服务端原始冷却，只有 provider 延迟受 3000ms 上限约束，避免两个策略互相污染。
- **SSE finish、usage 顺序因服务端实现差异变化** → 状态机以幂等标志控制 usage/finish，尾部事件只补缺失信息，并对空响应显式报错。
- **设置保存涉及多个域，部分写入可能成功** → 凭据与设置写入均逐步捕获失败；失败时不清除草稿并通过 `failed` 暴露，后续可重试或重置。
- **pnpm 符号链接环境导致本地构建差异** → 记录命令和结果，依赖仓库现有链接；真实 API、外部部署和生产凭据验证保持未验证。

## Migration Plan

1. 先在当前 pnpm 符号链接环境执行类型检查、测试、构建和 `openspec validate --strict harden-sensenova-provider`，确认设计对应的现有实现与测试证据。
2. 部署时仅更新插件包及其 OpenSpec 文档，不执行配置迁移；旧配置缺少 `modelSelection` 时按空选择处理，已有 credential-ref 和账户配置继续沿用。
3. 发布后通过设置页配置 include/exclude；保存即热更新。运行时目录刷新自动建立新能力快照，失败缓存不跨进程持久化。
4. 回滚时恢复上一插件包版本即可；若曾保存模型选择，旧版本应忽略未知字段，凭据域和既有账户设置不需删除。发生目录或路由异常时先清空模型选择覆盖，再恢复上一版本。
5. 归档顺序固定为：先建立并归档 `add-sensenova-provider` 的 `sensenova-provider` 主 spec 基线，再归档本 change，使本 change 的 `MODIFIED Requirements` 有明确基线；不得在主 spec 建立前归档本 change。
