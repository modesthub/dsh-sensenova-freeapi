# sensenova-provider Specification

## Purpose
为 DeepSeek Harness 提供 SenseNova（OpenAI 兼容）LLM provider 接入：注册独立 `sensenova` 路由，支持在同一 baseURL 下配置多个 API Key 账号，在密钥失效（401）时自动轮换，429 限流交由宿主重试层退避后原 key 重试。

## Requirements

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

系统 SHALL 在收到 429 响应时解析错误体 `error.code`，区分「配额类 429」与「非配额类 429」：配额类包括速率配额耗尽（`code` 为 `8`，message 形如 `rps exhausted`/`rpm exhausted`）与推理 TPM 耗尽（`code` 为 `429001`，message 形如 `inference tpm exhausted`）。所有 429 仍 SHALL 不做账号级冷却、不禁用账号。

默认（`quotaRotation` 关闭）时，429 SHALL NOT 切换到其他账号，一个会话固定使用一个 key。系统 SHALL 提供「配额类 429 换 key」设置开关（默认关闭，收纳于高级设置折叠区）：开启后，仅配额类 429 SHALL 触发切换到下一把可用 key 并粘住新 key（同一会话后续请求继续使用新 key），环回一圈仍被配额类 429 拒绝时 SHALL 停留在当前 key 按退避下限等待；非配额类 429 在任何设置下 SHALL NOT 触发轮换。

对配额类 429，系统 SHALL 以 `RATE_LIMIT` 错误结束本次请求，并 SHALL 携带 `providerRetryAfterMs` 作为退避指导：速率类（code 8）为固定下限 15000 毫秒；TPM 类（code 429001）采用分级探测退避，档位 SHALL 随该会话连续命中次数递增为 3000 → 5000 → 10000 → 15000 毫秒后封顶，任一请求成功或切换到新 key 后 SHALL 归零重新从 3000 毫秒开始（2026-09-04 实测：429001 为 per-key 推理 token 限速，恢复时间不定，固定长下限会把会话干锁在死等；短档位递增探测 + 优先换 key 才能在恢复第一时间接上）。当响应携带 `Retry-After` 且换算毫秒值大于当前档位时，SHALL 采用 `Retry-After` 值，且采用值整体 SHALL NOT 超过 300000 毫秒（超出时按 300000 毫秒采用）。对非配额类 429（无 `error.code` 或其他 code），系统 SHALL 维持既有行为：`Retry-After` 在大于 0 且不超过重试策略单次延迟上限（见「Provider 重试策略」）时透传，否则不透传也不截断，由宿主本地退避策略计算。

#### Scenario: 429 不轮换不冷却

- **WHEN** 某账号请求收到 429 且存在其他可用账号，「配额类 429 换 key」开关处于关闭状态
- **THEN** 系统不标记冷却、不切换账号，以 `RATE_LIMIT` 错误结束本次请求由宿主重试层退避后用原 key 重试

#### Scenario: 开启轮换后配额类 429 粘性换 key

- **WHEN** 「配额类 429 换 key」开关开启，某会话的请求收到配额类 429（code 8 或 429001）且存在未在本次请求中试过的其他可用账号
- **THEN** 系统切换到下一把可用 key 重试本次请求，且该会话后续请求继续使用新 key，直至新 key 也收到配额类 429 再依序切换

#### Scenario: 轮换环回后停止切换

- **WHEN** 开关开启且本轮请求已按序试过所有可用账号均被配额类 429 拒绝
- **THEN** 系统停留在当前 key，按退避下限等待后重试，不再重复切换，也不禁用任何账号

#### Scenario: 速率配额耗尽给出分钟级退避下限

- **WHEN** 某账号请求收到 429 且错误体为 `{"error":{"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}}`（响应无 `Retry-After` 头）
- **THEN** 系统不标记冷却、不切换账号，以 `RATE_LIMIT` 错误结束本次请求，且错误携带 `providerRetryAfterMs` 不低于 15000 毫秒

#### Scenario: TPM 耗尽给出分级探测退避

- **WHEN** 某账号请求收到 429 且错误体包含 `error.code` 为 `429001`（inference tpm exhausted），且该会话此前已连续命中 n 次
- **THEN** 系统以 `RATE_LIMIT` 错误结束本次请求且不轮换账号，错误携带 `providerRetryAfterMs` 为分级档位第 min(n+1, 4) 档（3000/5000/10000/15000 毫秒）

#### Scenario: TPM 分级档位成功后归零

- **WHEN** 某会话经历 429001 分级退避后任一请求成功
- **THEN** 该会话的连续命中计数归零，下一次 429001 退避从 3000 毫秒重新开始

#### Scenario: 短 Retry-After 透传

- **WHEN** 非配额类 429 响应携带 `Retry-After` 且换算毫秒值大于 0 且不超过重试策略单次延迟上限
- **THEN** 系统将该值作为 `providerRetryAfterMs` 透传给宿主重试层

#### Scenario: 超长 Retry-After 不突破上限

- **WHEN** 非配额类 429 响应的 `Retry-After` 超过重试策略单次延迟上限
- **THEN** 系统不透传该值（不截断），由宿主本地退避策略计算延迟

#### Scenario: 配额类 429 不因多会话共享而互踢

- **WHEN** 两个会话使用同一 key 且先后收到配额类 429，轮换开关关闭
- **THEN** 两个会话各自按退避下限等待后用原 key 重试，系统不因 429 禁用任一账号

### Requirement: 生成请求并发限制

系统 SHALL 限制同一 API key 下同时进行的生成请求数，不超过配置的并发上限（默认 1）。当某 key 的在途请求数达到上限时，新的生成请求 SHALL 排队等待，在前序请求释放（流结束、失败或取消）后按先来先服务顺序开始，而非立即失败；排队期间或进行中的请求被取消 SHALL 不占用或立即释放额度。并发上限 SHALL 从设置命名空间读取，未配置、非正整数或无法解析时 SHALL 回退为 1。并发闸 SHALL 仅作用于生成请求（`/chat/completions`），SHALL NOT 作用于模型目录拉取。

#### Scenario: 未超限直接放行

- **WHEN** 某 key 的在途生成请求数小于并发上限
- **THEN** 新请求立即开始，不经过排队等待

#### Scenario: 达到上限时排队

- **WHEN** 某 key 的在途生成请求数达到并发上限
- **THEN** 新请求排队等待，在前序请求释放额度后开始，不被立即以错误拒绝

#### Scenario: 上限为一时串行

- **WHEN** 并发上限为 1 且多个生成请求并发进入
- **THEN** 请求按到达顺序串行开始，同一时刻该 key 至多有一个在途生成请求

#### Scenario: 流结束释放额度

- **WHEN** 某生成请求的流式输出结束（正常 finish 或错误终止）
- **THEN** 该 key 的一个并发额度被释放，排队中的下一个请求得以开始

#### Scenario: 取消不占用额度

- **WHEN** 排队中或进行中的生成请求被取消
- **THEN** 该请求不占用或立即释放并发额度，不影响其他请求的排队顺序

#### Scenario: 非法配置回退默认

- **WHEN** 并发上限未配置、非正整数或无法解析为数字
- **THEN** 按默认值 1 生效，不因非法值中断请求处理

### Requirement: 401 禁用账号

系统 SHALL 在收到 401 响应时将该账号的 key 标记为禁用，直到该 key 值在凭据服务中被修改。

#### Scenario: 401 禁用

- **WHEN** 某账号请求收到 401
- **THEN** 该账号被标记为禁用，后续请求不再选中它，直到存储的 key 值改变

### Requirement: 轮换与耗尽错误

系统 SHALL 在账号密钥失效（401）时自动切换到下一个可用账号；当所有账号都被 401 禁用时应给出明确错误。429 默认不触发轮换；仅当 `quotaRotation` 开启且响应属于配额类 429 时，系统才按「429 不冷却不轮换」需求切换到下一把可用 key 并粘住，非配额类 429 不触发轮换。

#### Scenario: 401 触发自动轮换

- **WHEN** 当前账号在响应头返回前收到 401，且存在尚未尝试的可用账号
- **THEN** 系统标记该账号为禁用并改用下一个可用账号重试，每个 key 至多尝试一次

#### Scenario: 全账号被 401 拒绝

- **WHEN** 所有已配置账号均返回 401
- **THEN** 系统以 `INVALID_CREDENTIAL` 错误结束请求

### Requirement: 流式生成

系统 SHALL 以 OpenAI 兼容协议调用 `{apiBase}/chat/completions`，将 SSE 响应翻译为宿主流式块（文本、推理、工具调用、用量、结束），每个出站请求 SHALL 携带 `attributionHeaders()`；当请求因模型不可路由被拒绝时，系统 SHALL 给出明确的模型不可用错误。请求体携带宿主选定的 `reasoning_effort`（含 `none`）时 SHALL 原样透传。

系统 SHALL 同时接受 `delta.reasoning_content`（DeepSeek/Kimi 系）与 `delta.reasoning`（SenseNova 6.8 系）作为推理增量，任一字段的增量 SHALL 映射为宿主 reasoning 块增量，不得因字段名差异丢弃思考过程。

系统 SHALL 将 `delta.tool_calls` 分片按 `index` 优先聚合：同一 `index` 的分片归入同一工具槽；无 `index` 但有稳定 `id` 时按 `id` 聚合；两者皆无时按分片出现顺序自增开槽；槽内 `id`/`name` 增量覆盖，`arguments` 增量拼接。并行工具分片（无论是否携带 `index`）SHALL 聚合为与工具数一致、`name` 非空、`arguments` 为完整 JSON 文本的工具调用块。

#### Scenario: 正常流式生成

- **WHEN** 用户以 `sensenova` 路由发起生成请求
- **THEN** 系统向 `{apiBase}/chat/completions` 发送请求，并将 SSE 流翻译为宿主流式块直至 `finish`

#### Scenario: 模型不可路由

- **WHEN** 响应返回 404 且错误信息为 `model route not found` 或 `model is not found`
- **THEN** 系统以明确的模型不可用错误结束本次生成，而非抛出一个无上下文的通用 404

#### Scenario: 流开始后失败不回放

- **WHEN** SSE 已开始输出内容后请求失败
- **THEN** 系统以该错误结束本次生成，不将已消费的生成回放到另一账号

#### Scenario: 透传思考档位

- **WHEN** 宿主为某模型选定 `reasoning_effort` 为 `none`、`low`、`medium`、`high` 或 `max` 之一
- **THEN** 出站请求体包含与选定值一致的 `reasoning_effort`，不做值域改写或丢弃

#### Scenario: 两种推理增量字段都被显示

- **WHEN** SSE 事件中 `delta.reasoning_content` 或 `delta.reasoning` 任一字段携带文本
- **THEN** 系统将对应文本作为 reasoning 块增量发射；两个字段都有值时按 `reasoning_content` 优先、`reasoning` 兜底，不重复发射

#### Scenario: 规范 index 并行工具分片聚合

- **WHEN** SSE 以带 `index` 的并行 `tool_calls` 分片流式返回多个工具（如 `index 0` 与 `index 1` 各自分片到达）
- **THEN** 经宿主组装后产出与工具数一致的 `tool-call` 块，每个块的 `name` 非空、`arguments` 为该工具完整合法的 JSON 文本，分片不串槽不错位

#### Scenario: 无键并行工具分片聚合

- **WHEN** SSE 的并行 `tool_calls` 分片既无 `index` 也无 `id`，多个工具的分片交错到达
- **THEN** 各工具按出现顺序分入独立槽，经宿主组装后每个 `tool-call` 块 `name` 非空、`arguments` 完整，不出现多工具 arguments 拼接或空 `name` 块

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

### Requirement: Web 设置页

系统 SHALL 提供 Web 设置页，允许配置默认账户密钥、增删账户并通过下拉选择活动账户，并在宿主 Models 页提供 provider 卡片。设置页 SHALL NOT 展示凭据引用名；低频配置字段 SHALL 收纳进默认折叠的高级设置区域；轮换说明文案 SHALL 与实际轮换行为一致：仅 401 自动切换账户；`quotaRotation` 关闭时 429 不切换，开启时仅配额类 429 可切换到下一把 key 并粘住。

配置状态与路由徽标 SHALL 采用中性配色而非强调色：已配置/已启用徽标 SHALL 使用中性平台底色与次要文字色，未配置徽标 SHALL 仅用弱化文字色区分，不使用 success 绿作为徽标背景。「活动」为选中态指示而非配置状态，SHALL 使用实心高对比填充（主色底 + 反色前景）以与中性状态徽标明确区分。

页面底部操作区 SHALL 右对齐排列，重置 SHALL 呈现为带描边/透明底的次按钮（ghost），保存 SHALL 为高亮主按钮（primary）；主按钮文字 SHALL 使用反色前景（`label-primary-foreground`）而非 `label-primary`，确保浅/深主题下均与主色背景高对比可见；保存失败/成功/未保存状态消息 SHALL 与按钮行分离展示，不混排于同一行。

凭据配置状态徽标 MUST 反映凭据服务的真实持久化状态，不受设置快照加载时序影响：当设置快照从加载中转变为就绪（或页面涉及的 credential-ref 集合因此变化）时，系统 SHALL 重新查询这些引用的配置状态并更新徽标，不得因首次查询发生在快照就绪之前而将已持久化的账户残留显示为「未配置」。

系统 SHALL 在高级设置折叠区提供「并发上限」数字输入字段（默认值 1，仅接受正整数），用于配置每个 API key 的同时生成请求数上限（见「生成请求并发限制」需求）。

#### Scenario: 设置页可配置多账号

- **WHEN** 用户打开设置页的 sensenova 区域
- **THEN** 用户可以配置默认账户密钥、增删账户并通过下拉框选择活动账户；API 地址、手动模型筛选、并发上限与配额类 429 换 key 开关位于高级设置折叠区内

#### Scenario: 账户行单列布局

- **WHEN** 设置页渲染任一账户行
- **THEN** 行头部单行展示备注名标签、配置状态徽标与动作按钮且按钮文字不换行，备注名输入与密钥输入各占满整行宽度，账户之间以分隔线区隔而非嵌套边框盒

#### Scenario: 不展示凭据引用名

- **WHEN** 设置页渲染默认账户或任一账户行
- **THEN** 页面任何位置不出现 `SENSENOVA_API_KEY` 等凭据引用名，也不提供引用名编辑入口；密钥输入框仅接受密钥原文

#### Scenario: 活动账户下拉选择

- **WHEN** 用户使用活动账户下拉框
- **THEN** 选项为「自动（第一个可用账户）」与已保存账户，未保存的新增行不出现在选项中；点击重置后回到自动

#### Scenario: 高级设置折叠

- **WHEN** 用户打开设置页
- **THEN** 高级设置区域默认折叠，折叠头显示已自定义项数徽标；展开后可编辑 API 地址、手动加入模型、隐藏模型、并发上限与配额类 429 换 key 开关

#### Scenario: 轮换文案与行为一致

- **WHEN** 设置页渲染多账户轮换说明与「配额类 429 换 key」开关
- **THEN** 文案明确表述「密钥失效（401）时自动切换到下一个可用账户；默认 429 限流不切换账户、由宿主重试层退避后原 key 重试；开启开关后仅配额类 429 可切换并粘住新 key」

#### Scenario: 徽标不使用绿色强调

- **WHEN** 设置页或 Models 页卡片渲染「已配置」「未配置」「已启用」状态徽标与路由徽标
- **THEN** 徽标使用中性底色或弱化文字色，任何状态均不以 success 绿色作为背景色

#### Scenario: 主按钮文字反色前景

- **WHEN** 设置页渲染底部操作区且存在未保存变更
- **THEN** 保存主按钮文字采用反色前景令牌，浅色主题下主色底 + 反色文字、深色主题下同样高对比，文字清晰可读而非与背景同色

#### Scenario: 活动账户徽标高对比

- **WHEN** 设置页渲染被钉选的账户行（`activeAccount` 指向该账户 id）
- **THEN** 该账户行显示实心高对比的「活动」徽标（主色底 + 反色文字），与「已配置/未配置」中性徽标在视觉上明确区分

#### Scenario: 自动模式显示实际生效账户

- **WHEN** 活动账户为「自动」且存在已配置账户
- **THEN** 页面显示当前实际生效账户的可识别标记：默认账户已配置时标记默认账户，否则标记第一个已配置账户行，用户无需切换即可识别生效账户

#### Scenario: 并发上限字段

- **WHEN** 用户展开高级设置
- **THEN** 出现「并发上限」数字输入字段，默认值为 1，仅接受正整数；保存后该值随设置持久化并热生效

#### Scenario: 底部操作右对齐且重置为次按钮

- **WHEN** 设置页渲染底部操作区且存在未保存变更
- **THEN** 重置为 ghost 样式次按钮、保存为主按钮，二者靠右对齐；状态消息不与按钮同处一行

#### Scenario: 保存反馈短暂显示

- **WHEN** 用户保存成功
- **THEN** 「已保存 ✓」反馈显示并在约 2.5 秒后自动消失

#### Scenario: 快照就绪后徽标反映真实配置

- **WHEN** 用户已保存某额外账户的 API key（凭据与设置均已持久化），随后重新打开设置页，且设置快照在凭据状态首次查询之后才从加载中转变为就绪
- **THEN** 该账户行的配置状态徽标显示「已配置」，Models 页卡片的已配置账户计数同样计入该账户，而非残留「未配置」

#### Scenario: Models 页显示卡片

- **WHEN** 宿主 Models 设置页渲染 sensenova 行
- **THEN** 显示该 provider 的卡片，卡片具备完整的容器样式（边框、圆角、内边距），提供进入设置页的入口

### Requirement: 凭据隐私

系统 SHALL 仅通过宿主凭据服务解析 API key，key 原文 SHALL NOT 写入日志或发送给任何模型或第三方。

#### Scenario: key 不落日志

- **WHEN** 系统解析、轮换或报错时涉及 API key
- **THEN** 日志与错误信息中不出现 key 原文，仅出现凭据引用名或账号标签

### Requirement: 模型能力自动配置

系统 SHALL 在 `listModels()` 获取目录后缓存每个模型的能力元数据，并在 `resolveModel()` 中按模型 id 自动生成对应配置：上下文大小优先取目录的 `context_length`、`context_window`、`max_context_length` 或 `contextLength`；最大输出优先取 `max_output_length`、`max_tokens`、`max_output_tokens`、`max_completion_tokens` 或对应驼峰字段（`max_output_length` 为 SenseNova 目录实际字段名，SHALL 优先识别）；输入模态取目录 `input_modalities`。

系统 SHALL 为模型声明可选的思考档位（`reasoning.efforts`），判定顺序 SHALL 为：目录明确提供档位词表（顶层 `reasoning_efforts`、`reasoning_levels` 或嵌套 `reasoning.efforts` / `thinking.efforts`）时采用目录词表；否则当目录 `supported_features` 含 `reasoning`（或仅有 `reasoning_effort`/`thinking` 支持标记）且该模型 id 命中内置的模型族档位表时，采用静态表中的档位；两者皆无时不声明思考档位。每个 effort id SHALL 原样保留为 wire value 并包装为宿主 `ReasoningEffortId`；静态表 SHALL NOT 设置 `defaultEffort`，保持网关自身默认思考档。系统不得对静态表之外的模型虚构档位。

内置模型族档位表 SHALL 至少覆盖以下模型并采用官方文档值域：`sensenova-6.8-flash-lite` 为 `low`/`medium`/`high`/`none`；`deepseek-v4-flash` 为 `low`/`medium`/`high`/`none`（实测接受）；`deepseek-v4-pro` 为 `low`/`high`/`max`；`glm-5.2` 为 `low`/`medium`/`high`/`none`；`kimi-k3` 为 `low`/`high`/`max`。

#### Scenario: 按目录配置上下文大小

- **WHEN** `listModels()` 返回某模型的 `context_length` 为 `262144`，随后调用该模型的 `resolveModel()`
- **THEN** 返回的 `context.contextWindow` 为 `262144`，而不是通用的固定默认值

#### Scenario: 按目录配置最大输出

- **WHEN** 目录为某模型声明 `max_output_tokens` 或等价最大输出字段
- **THEN** `resolveModel()` 返回对应的 `defaultMaxTokens`，供宿主自动配置请求上限

#### Scenario: 识别 SenseNova 目录的 max_output_length 字段

- **WHEN** `/models` 目录以 `max_output_length: 65536` 声明某模型（如 `deepseek-v4-flash`）的最大输出，且不含 `max_tokens` 等 OpenAI 风格字段，随后调用该模型的 `resolveModel()`
- **THEN** 返回的 `defaultMaxTokens` 为 `65536`，宿主在用户未显式设置上限时将其作为请求的 `max_tokens` 下发，模型输出不再受服务端默认上限（8192）截断

#### Scenario: 按目录配置思考级别

- **WHEN** 目录为某模型提供 `reasoning_efforts` 词表 `low`、`medium`、`high`，并声明 `medium` 为默认级别
- **THEN** `resolveModel()` 将相同 wire value 映射到 `reasoning.efforts` 与 `reasoning.defaultEffort`，静态表不参与覆盖

#### Scenario: 目录仅标记支持但未提供词表

- **WHEN** 模型目录只有 `reasoning_effort`、`thinking` 或 `supported_parameters`/`supported_features: ["reasoning"]` 支持标记，没有可选级别词表
- **THEN** 系统按内置模型族档位表决定：模型 id 命中静态表（如 `deepseek-v4-flash`）时返回对应 `reasoning.efforts`（如 `low`/`medium`/`high`/`none`）且不设 `defaultEffort`，宿主选择器可让用户选档（含 `none` 关思考）；id 不在静态表时保持该项未知，不虚构思考级别

#### Scenario: 目录刷新后同步能力

- **WHEN** 再次调用 `listModels()` 后同一模型的上下文大小或思考档位发生变化
- **THEN** 后续 `resolveModel()` 使用最新目录值（静态表仍按其 id 生效），不继续使用旧缓存

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

系统 SHALL 为 `sensenova` 路由声明 `normal` 重试策略：最大重试次数 SHALL 为有限值且默认不超过 10 次；本地指数退避单次延迟上限 SHALL 不低于 60000 毫秒且不超过 300000 毫秒（60000 毫秒 ≤ 上限 ≤ 300000 毫秒）。收到配额类 429（见「429 不冷却不轮换」）后的下一次重试延迟 SHALL 不低于该错误携带的 `providerRetryAfterMs`（TPM 类为该会话当前分级探测档位，code 8 为 15000 毫秒）。对非配额类 429，服务端提供的 `Retry-After` 超过单次延迟上限时 SHALL NOT 作为 provider 延迟透传，也不得截断后透传，改由本地策略计算；配额类的 `Retry-After` 采用规则见「429 不冷却不轮换」。429 不产生账号冷却。

#### Scenario: 持续限流时重试预算有限

- **WHEN** 请求连续收到配额类 429 且每次退避后重试仍失败
- **THEN** 宿主在不超过声明上限的有限重试次数内停止，向会话暴露明确的 `RATE_LIMIT` 失败，而不是以 3 秒级短退避持续重试上千次

#### Scenario: 配额类退避下限被遵守

- **WHEN** 某次配额类 429 携带 `providerRetryAfterMs` 10000 毫秒（TPM 分级第 3 档）
- **THEN** 下一次重试的实际延迟不低于 10000 毫秒，本地指数退避在达到单次延迟上限后不再增长

#### Scenario: 限流时按策略重试

- **WHEN** 请求收到 429 限流响应且未提供超过单次延迟上限的 `Retry-After`
- **THEN** 宿主按该路由声明的策略重试，重试次数不超过声明的有限上限；配额类 429 的下一次重试延迟不低于其 `providerRetryAfterMs`

#### Scenario: 本地退避延迟封顶

- **WHEN** 本地退避延迟按指数增长
- **THEN** 单次重试延迟在达到声明的单次延迟上限后 SHALL NOT 继续增长，即使 jitter 生效也不得超过该上限

#### Scenario: 超长 Retry-After 不突破上限

- **WHEN** 非配额类 429 响应的 `Retry-After` 超过声明的单次延迟上限
- **THEN** 插件不向宿主透传该超长 `providerRetryAfterMs`，宿主使用本地退避策略继续重试，单次延迟不超过声明的上限

### Requirement: 生成请求超时与看门狗

系统 SHALL 为发往 `{apiBase}/chat/completions` 的生成请求提供超时保护：请求建立到收到首个响应字节 SHALL 受连接超时约束（默认 45000 毫秒量级）；SSE 流读取 SHALL 受空闲看门狗约束（默认 60000 毫秒量级，收到任一流式事件即重置）；并发闸排队等待 SHALL 受排队超时约束（默认 60000 毫秒量级）。任一超时触发时，系统 SHALL 释放该请求持有的并发额度，并以可重试的 `TIMEOUT` 错误交宿主重试层处理，不得让请求无限挂起或长期占用并发额度。

#### Scenario: 传输挂起不长期占用额度

- **WHEN** 生成请求发出后服务端长时间不返回首字节且超过连接超时
- **THEN** 系统以 `TIMEOUT` 错误结束本次请求并释放其并发闸额度，宿主可按重试策略重试

#### Scenario: 流中途停摆被看门狗回收

- **WHEN** SSE 流已开始输出后超过空闲看门狗时长未收到任何新事件
- **THEN** 系统以 `TIMEOUT` 错误结束本次生成并释放并发额度，不继续无限等待

#### Scenario: 排队超时交还宿主重试层

- **WHEN** 请求在并发闸队列中等待超过排队超时时长仍未获得额度
- **THEN** 系统以可重试错误结束排队等待（不占额度），由宿主重试层按退避策略再次发起
