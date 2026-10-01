## Purpose

为 DeepSeek Harness 提供 SenseNova（OpenAI 兼容）LLM provider 接入：注册独立 `sensenova` 路由，支持在同一 baseURL 下配置多个 API Key 账号，在密钥失效（401）时自动轮换，429 限流交由宿主重试层退避后原 key 重试。

## ADDED Requirements

### Requirement: 注册 sensenova provider 路由

系统 SHALL 向宿主 llm 服务注册名为 `sensenova` 的 provider 路由，并声明为可配置 provider，显示名为 SenseNova。

#### Scenario: 路由注册成功

- **WHEN** 插件在宿主中加载
- **THEN** 宿主模型选择器中出现 `sensenova` provider 分组，且不与既有 `sensennova` 路由冲突

### Requirement: 多账号配置

系统 SHALL 支持在同一 `apiBase` 下配置一个默认账号与零到多个额外账号，每个账号包含标签与凭据引用（`apiKeyEnv`，POSIX shell 标识符形式的 credential-ref）。

#### Scenario: 仅默认账号

- **WHEN** 用户仅配置 `apiKeyEnv`（默认 `SENSENOVA_API_KEY`）而未配置 `accounts`
- **THEN** 系统使用该默认账号的 key 服务所有请求

#### Scenario: 额外账号参与轮换

- **WHEN** 用户配置了 `accounts` 列表
- **THEN** 每个具备合法 `apiKeyEnv` credential-ref 的条目都成为一个可轮换账号，无合法凭据引用的条目被忽略

#### Scenario: 手动钉选账号

- **WHEN** 用户设置 `activeAccount` 指向某个账号 id
- **THEN** 该账号在可用时优先服务请求，不可用时回退到第一个可用账号

### Requirement: 429 不冷却不轮换

系统 SHALL 在收到 429 响应时不做账号级冷却、不切换到其他账号：SenseNova 429 属渠道常态性 RPM 瞬时超限，不代表账号异常，一个会话固定使用一个 key（轮换会破坏服务端按 key 命中的 prompt 缓存）。系统 SHALL 以 `RATE_LIMIT` 错误结束本次请求，交由宿主重试层退避后使用原 key 重试；响应携带的 `Retry-After` 在大于 0 且不超过 3000 毫秒时作为 `providerRetryAfterMs` 透传给宿主。

#### Scenario: 429 不轮换不冷却

- **WHEN** 某账号请求收到 429 且存在其他可用账号
- **THEN** 系统不标记冷却、不切换账号，以 `RATE_LIMIT` 错误结束本次请求由宿主重试层退避后用原 key 重试

#### Scenario: 短 Retry-After 透传

- **WHEN** 429 响应携带 `Retry-After` 且换算毫秒值大于 0 且不超过 3000
- **THEN** 系统将该值作为 `providerRetryAfterMs` 附在 `RATE_LIMIT` 错误上透传给宿主

#### Scenario: 超长 Retry-After 不突破上限

- **WHEN** 429 响应的 `Retry-After` 大于 3000 毫秒
- **THEN** 系统不透传该值（不截断），由宿主本地退避策略计算延迟

### Requirement: 401 禁用账号

系统 SHALL 在收到 401 响应时将该账号的 key 标记为禁用，直到该 key 值在凭据服务中被修改。

#### Scenario: 401 禁用

- **WHEN** 某账号请求收到 401
- **THEN** 该账号被标记为禁用，后续请求不再选中它，直到存储的 key 值改变

### Requirement: 轮换与耗尽错误

系统 SHALL 仅在账号密钥失效（401）时自动切换到下一个可用账号；当所有账号都被 401 禁用时应给出明确错误。429 不触发轮换（见「429 不冷却不轮换」需求）。

#### Scenario: 401 触发自动轮换

- **WHEN** 当前账号在响应头返回前收到 401，且存在尚未尝试的可用账号
- **THEN** 系统标记该账号为禁用并改用下一个可用账号重试，每个 key 至多尝试一次

#### Scenario: 全账号被 401 拒绝

- **WHEN** 所有已配置账号均返回 401
- **THEN** 系统以 `INVALID_CREDENTIAL` 错误结束请求

### Requirement: 流式生成

系统 SHALL 以 OpenAI 兼容协议调用 `POST /v1/chat/completions`，将 SSE 响应翻译为宿主流式块（文本、推理、工具调用、用量、结束），每个出站请求 SHALL 携带 `attributionHeaders()`。

#### Scenario: 正常流式生成

- **WHEN** 用户以 `sensenova` 路由发起生成请求
- **THEN** 系统向 `{apiBase}/chat/completions` 发送请求，并将 SSE 流翻译为宿主流式块直至 `finish`

#### Scenario: 流开始后失败不回放

- **WHEN** SSE 已开始输出内容后请求失败
- **THEN** 系统以该错误结束本次生成，不将已消费的生成回放到另一账号

### Requirement: 模型目录

系统 SHALL 从 `GET /v1/models` 实时获取模型目录；在没有任何可用 key 时返回空目录而不阻塞路由注册。

#### Scenario: 拉取模型目录

- **WHEN** 存在至少一个可用账号 key
- **THEN** 系统调用 `{apiBase}/models` 并返回端点声明的模型列表

#### Scenario: 无 key 时不阻塞

- **WHEN** 没有任何账号解析出 key
- **THEN** 系统返回空模型目录，路由仍保持已注册状态

### Requirement: Web 设置页

系统 SHALL 提供 Web 设置页，允许配置 `apiBase`、默认 key、账号增删与 `activeAccount` 选择，并在宿主 Models 页提供 provider 卡片。

#### Scenario: 设置页可配置多账号

- **WHEN** 用户打开设置页的 sensenova 区域
- **THEN** 用户可以编辑 `apiBase`、默认 key、增删额外账号并选择 `activeAccount`

#### Scenario: Models 页显示卡片

- **WHEN** 宿主 Models 设置页渲染 sensenova 行
- **THEN** 显示该 provider 的卡片，提供进入设置页的入口

### Requirement: 凭据隐私

系统 SHALL 仅通过宿主凭据服务解析 API key，key 原文 SHALL NOT 写入日志或发送给任何模型或第三方。

#### Scenario: key 不落日志

- **WHEN** 系统解析、轮换或报错时涉及 API key
- **THEN** 日志与错误信息中不出现 key 原文，仅出现凭据引用名或账号标签
