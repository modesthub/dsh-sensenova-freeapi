## MODIFIED Requirements

### Requirement: Web 设置页

系统 SHALL 提供 Web 设置页，允许配置默认账户密钥、增删账户并通过下拉选择活动账户，并在宿主 Models 页提供 provider 卡片。设置页 SHALL NOT 展示凭据引用名；低频配置字段 SHALL 收纳进默认折叠的高级设置区域；轮换说明文案 SHALL 与实际轮换行为一致（仅 401 切换账户，429 不切换）。

配置状态与路由徽标 SHALL 采用中性配色而非强调色：已配置/已启用徽标 SHALL 使用中性平台底色与次要文字色，未配置徽标 SHALL 仅用弱化文字色区分，不使用 success 绿作为徽标背景。

页面底部操作区 SHALL 右对齐排列，重置 SHALL 呈现为带描边/透明底的次按钮（ghost），保存 SHALL 为高亮主按钮（primary）；保存失败/成功/未保存状态消息 SHALL 与按钮行分离展示，不混排于同一行。

凭据配置状态徽标 MUST 反映凭据服务的真实持久化状态，不受设置快照加载时序影响：当设置快照从加载中转变为就绪（或页面涉及的 credential-ref 集合因此变化）时，系统 SHALL 重新查询这些引用的配置状态并更新徽标，不得因首次查询发生在快照就绪之前而将已持久化的账户残留显示为「未配置」。

#### Scenario: 设置页可配置多账号

- **WHEN** 用户打开设置页的 sensenova 区域
- **THEN** 用户可以配置默认账户密钥、增删账户并通过下拉框选择活动账户；API 地址与手动模型筛选位于高级设置折叠区内

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
- **THEN** 高级设置区域默认折叠，折叠头显示已自定义项数徽标；展开后可编辑 API 地址、手动加入模型与隐藏模型

#### Scenario: 轮换文案与行为一致

- **WHEN** 设置页渲染多账户轮换说明
- **THEN** 文案表述为「密钥失效（401）时自动切换到下一个可用账户；429 限流不切换账户、由宿主重试层退避后原 key 重试」

#### Scenario: 徽标不使用绿色强调

- **WHEN** 设置页或 Models 页卡片渲染「已配置」「未配置」「已启用」状态徽标与路由徽标
- **THEN** 徽标使用中性底色或弱化文字色，任何状态均不以 success 绿色作为背景色

#### Scenario: 底部操作右对齐且重置为次按钮

- **WHEN** 设置页渲染底部操作区且存在未保存变更
- **THEN** 重置为 ghost 样式次按钮、保存为主按钮，二者靠右对齐；状态消息不与按钮同处一行

#### Scenario: 保存反馈短暂显示

- **WHEN** 用户保存成功
- **THEN** 「已保存 ✓」反馈显示并在约 2.5 秒后自动消失

#### Scenario: Models 页显示卡片

- **WHEN** 宿主 Models 设置页渲染 sensenova 行
- **THEN** 显示该 provider 的卡片，卡片具备完整的容器样式（边框、圆角、内边距），提供进入设置页的入口

#### Scenario: 快照就绪后徽标反映真实配置

- **WHEN** 用户已保存某额外账户的 API key（凭据与设置均已持久化），随后重新打开设置页，且设置快照在凭据状态首次查询之后才从加载中转变为就绪
- **THEN** 该账户行的配置状态徽标显示「已配置」，Models 页卡片的已配置账户计数同样计入该账户，而非残留「未配置」

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
