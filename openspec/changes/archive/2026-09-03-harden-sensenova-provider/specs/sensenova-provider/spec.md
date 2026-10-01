## MODIFIED Requirements

### Requirement: 模型目录

系统 SHALL 从 `{apiBase}/models` 实时获取模型目录，并仅暴露可作为对话模型路由的条目：`output_modalities` 必须包含 `text`，且条目 id 不得命中已知不可路由清单或进程内失败缓存；系统 SHALL 从目录字段声明每个模型的输入模态与标准可读显示名；在没有任何可用 key 时返回空目录而不阻塞路由注册。

#### Scenario: 拉取模型目录

- **WHEN** 存在至少一个可用账号 key
- **THEN** 系统调用 `{apiBase}/models` 并返回端点声明的文本对话模型

#### Scenario: 拉取并过滤模型目录

- **WHEN** 存在至少一个可用账号 key，且端点返回的目录包含文生图模型（`output_modalities` 不含 `text`）与已知不可路由模型 `sensenova-6.7-flash-lite`
- **THEN** 系统调用 `{apiBase}/models`，只返回 `output_modalities` 含 `text` 且未被标记不可路由的对话模型，文生图模型与已知 stale 模型被排除

#### Scenario: 运行时剔除未知 stale 模型

- **WHEN** 某个目录中的文本模型请求返回 `MODEL_NOT_FOUND`
- **THEN** 系统将该模型 id 写入进程内失败缓存，后续成功的 `listModels()` 不再返回该模型，直到适配器生命周期结束

#### Scenario: 声明多模态输入

- **WHEN** 目录中某模型的 `input_modalities` 含 `image`
- **THEN** 系统将该模型的 `inputModalities` 声明为 `['text', 'image']`，而非硬编码的 `['text']`

#### Scenario: 标准显示名

- **WHEN** `resolveModel()` 解析模型 id `sensenova-6.7-flash-lite`
- **THEN** 系统以标准名称 `Sensenova 6.7 Flash Lite` 返回该模型元数据，而非原始 id

#### Scenario: 无 key 时不阻塞

- **WHEN** 没有任何账号解析出 key
- **THEN** 系统返回空模型目录，路由仍保持已注册状态

### Requirement: 流式生成

系统 SHALL 以 OpenAI 兼容协议调用 `{apiBase}/chat/completions`，将 SSE 响应翻译为宿主流式块（文本、推理、工具调用、用量、结束），每个出站请求 SHALL 携带 `attributionHeaders()`；当请求因模型不可路由被拒绝时，系统 SHALL 给出明确的模型不可用错误。

#### Scenario: 正常流式生成

- **WHEN** 用户以 `sensenova` 路由发起生成请求
- **THEN** 系统向 `{apiBase}/chat/completions` 发送请求，并将 SSE 流翻译为宿主流式块直至 `finish`

#### Scenario: 模型不可路由

- **WHEN** 响应返回 404 且错误信息为 `model route not found` 或 `model is not found`
- **THEN** 系统以明确的模型不可用错误结束本次生成，而非抛出一个无上下文的通用 404

#### Scenario: 流开始后失败不回放

- **WHEN** SSE 已开始输出内容后请求失败
- **THEN** 系统以该错误结束本次生成，不将已消费的生成回放到另一账号

## ADDED Requirements

### Requirement: 模型能力自动配置

系统 SHALL 在 `listModels()` 获取目录后缓存每个模型的能力元数据，并在 `resolveModel()` 中按模型 id 自动生成对应配置：上下文大小优先取目录的 `context_length`、`context_window`、`max_context_length` 或 `contextLength`；最大输出优先取 `max_tokens`、`max_output_tokens`、`max_completion_tokens` 或对应驼峰字段；思考/推理能力只接受目录明确提供的 `reasoning_efforts`、`reasoning_levels`，或嵌套 `reasoning.efforts` / `thinking.efforts` 词表，并映射为宿主 `reasoning.efforts` 与 `defaultEffort`。每个 effort id SHALL 原样保留为 wire value 并包装为宿主 `ReasoningEffortId`；只有能匹配已解析词表的默认级别才可设置。系统不得用固定值覆盖已声明的模型能力，也不得从只有 `reasoning_effort` / `thinking` 支持标记或 `supported_parameters` 标记的目录条目虚构思考级别。

#### Scenario: 按目录配置上下文大小

- **WHEN** `listModels()` 返回某模型的 `context_length` 为 `262144`，随后调用该模型的 `resolveModel()`
- **THEN** 返回的 `context.contextWindow` 为 `262144`，而不是通用的固定默认值

#### Scenario: 按目录配置最大输出

- **WHEN** 目录为某模型声明 `max_output_tokens` 或等价最大输出字段
- **THEN** `resolveModel()` 返回对应的 `defaultMaxTokens`，供宿主自动配置请求上限

#### Scenario: 按目录配置思考级别

- **WHEN** 目录提供 `reasoning_efforts` 词表 `low`、`medium`、`high`，并声明 `medium` 为默认级别
- **THEN** `resolveModel()` 将相同 wire value 映射到 `reasoning.efforts` 与 `reasoning.defaultEffort`，后续请求使用宿主选定的 `reasoning_effort`

#### Scenario: 目录刷新后同步能力

- **WHEN** 再次调用 `listModels()` 后同一模型的上下文大小或思考级别发生变化
- **THEN** 后续 `resolveModel()` 使用最新目录值，不继续使用旧缓存

#### Scenario: 目录仅标记支持但未提供词表

- **WHEN** 模型目录只有 `reasoning_effort`、`thinking` 或 `supported_parameters` 支持标记，没有可选级别词表
- **THEN** 系统不向宿主虚构思考级别，保持该项未知或使用 provider 自身默认行为

### Requirement: 手动模型可选覆盖

系统 SHALL 在 `llm-sensenova` 用户设置中持久化文本模型的 `include` 与 `exclude` 选择，并在每次 `listModels()` 刷新时应用：`include` 可覆盖已知不可路由清单与进程内失败缓存，将目录中的 stale 文本模型重新加入；`exclude` 可隐藏自动暴露的文本模型；同一模型同时出现在两者时 `exclude` SHALL 优先；`output_modalities` 不含 `text` 的 image-only 模型无论如何不得加入当前 `chat completions` 选择器；未出现在最新目录中的 id 不得仅凭手动配置虚构模型条目。手动加入的模型仍 SHALL 经过原有 `MODEL_NOT_FOUND` 错误兜底。

#### Scenario: 手动重新加入 stale 文本模型

- **WHEN** 用户在 `modelSelection.include` 中配置 `sensenova-6.7-flash-lite`，且 `/models` 返回该 id 为文本输出模型
- **THEN** `listModels()` 返回该模型及其目录元数据，即使它命中已知不可路由清单或失败缓存；实际请求仍按 `MODEL_NOT_FOUND` 规则处理

#### Scenario: 手动隐藏自动暴露的文本模型

- **WHEN** 用户在 `modelSelection.exclude` 中配置一个目录返回且可路由的文本模型
- **THEN** `listModels()` 不返回该模型，且刷新目录不会清除该手动选择

#### Scenario: image-only 模型不可手动加入

- **WHEN** 用户在 `modelSelection.include` 中配置 `sensenova-u1-fast`，且目录声明其 `output_modalities` 仅含 `image`
- **THEN** `listModels()` 不返回该模型，不将图片生成模型伪装为 chat completions 模型

#### Scenario: 手动选择在目录刷新后保留

- **WHEN** 连续调用 `listModels()` 获取不同目录快照
- **THEN** `include` 与 `exclude` 选择始终来自用户设置并继续应用，不随目录能力缓存刷新而丢失

#### Scenario: 手动配置未知模型

- **WHEN** 用户配置的模型 id 不存在于最新 `/models` 目录
- **THEN** 系统不凭该配置生成无目录元数据的模型条目

### Requirement: Provider 重试策略

系统 SHALL 为 `sensenova` 路由声明 `normal` 重试策略：最多重试 1000 次，本地指数退避单次延迟上限 3 秒（3000 毫秒），覆盖宿主默认的 10 秒上限；服务端提供的 `Retry-After` 超过 3000 毫秒时 SHALL NOT 作为 provider 延迟透传，也不得截断后透传，改由本地策略计算，避免突破 3 秒上限；429 不产生账号冷却（见 add「429 不冷却不轮换」），`Retry-After` 仅在大于 0 且不超过 3000 毫秒时作为 `providerRetryAfterMs` 透传。

#### Scenario: 限流时按策略重试

- **WHEN** 请求收到 429 限流响应且未提供超过 3000 毫秒的 `Retry-After`
- **THEN** 宿主按该路由声明的策略重试，最多 1000 次，且每次重试的退避延迟不超过 3000 毫秒

#### Scenario: 本地退避延迟封顶

- **WHEN** 本地退避延迟按指数增长
- **THEN** 单次重试延迟在达到 3000 毫秒后 SHALL NOT 继续增长，即使 jitter 生效也不得超过该上限

#### Scenario: 超长 Retry-After 不突破上限

- **WHEN** 429 响应的 `Retry-After` 大于 3000 毫秒
- **THEN** 插件不向宿主透传该超长 `providerRetryAfterMs`，宿主使用本地退避策略继续重试，延迟上限仍为 3000 毫秒
