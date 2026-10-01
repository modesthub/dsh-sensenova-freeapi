# 设计：额外账户徽标读取时序与模型最大输出上限修复

## Context

见 proposal.md 的 Why：两个缺陷均已实测定位根因，宿主侧（dsh-client-ui-settings 的快照生命周期、dsh-llm 的 defaultMaxTokens 注入语义、SenseNova API 行为）无需改动，全部修复收敛在插件内。

关键宿主事实（实现约束）：

- 客户端 `SettingsScope` 构造时快照为 `loading`（宿主 `SettingsDescribeMirror` 初始 `idle`，需一次异步 RPC 才 ready）；此后每次快照替换都会调用 scope 的订阅回调。
- 宿主 `resolveCallWithInfo`（dsh-llm）仅在「用户未显式设置 maxTokens 且 adapter 上报 defaultMaxTokens」时注入默认值；`defaultMaxTokens` 语义是"每次请求下发的默认 max_tokens"，不是展示性能力字段。
- SenseNova `/models` 目录输出上限字段名为 `max_output_length`（实测 65536/131072）；带 `max_tokens: 65536` 的请求实测被接受。

## Goals / Non-Goals

**Goals:**

- 重进设置页（快照延迟就绪）后，额外账户的已配置徽标与 Models 卡片计数反映真实持久化状态。
- `resolveModel()` 按目录 `max_output_length` 上报 `defaultMaxTokens`，宿主自动下发默认 `max_tokens`，消除服务端 8192 默认上限截断。

**Non-Goals:**

- 不改变保存链路、凭据存储格式、settings schema。
- 不改变 429/401 轮换、并发闸、模型过滤等既有行为。
- 不在插件内做 max_tokens 钳制或用户可配上限（宿主已有 maxTokens 显式配置通道）。

## Decisions

### D1 徽标重查触发器：credential-ref 集合对比（而非仅 loading→ready 边沿）

`SenseNovaSettingsController` 在 scope 订阅回调中计算当前涉及的 credential-ref 集合（默认 ref + stored/added 账户 ref），与上一次成功 `describeAll()` 的集合对比；不一致则异步重新 `describeAll()`。

- 备选 A：仅检测快照 `loading→ready` 边沿。更窄，但会遗漏「快照已 ready 后 accounts 再次变化引入新 ref」（如外部写入 settings）的场景；集合对比天然覆盖两种情况且实现同样简单。
- 备选 B：在 `state()` 渲染路径里懒触发重查。把副作用混入同步渲染读取路径，容易造成渲染回路，不采用。
- 防重入：仅当 `describeAll()` 成功（`response.ok`）才更新"已查询集合"快照；失败时保留旧集合，下次 scope 变化自然重试，不劣于现状。`addAccount()` 内原有的显式 `describeAll()` 保留，与集合快照机制兼容。

### D2 `max_output_length` 放候选列表首位

`firstMaxOutputField()` 候选列表改为 `['max_output_length', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'maxTokens', 'maxOutputTokens', 'maxCompletionTokens']`。

- SenseNova 目录实际只提供 `max_output_length`，与 OpenAI 风格字段语义相同（最大输出 token 数），首位优先可确保在字段并存时取渠道原生声明。
- 备选：追加到列表末尾。仅当目录同时提供两种字段且语义冲突时才有差异；SenseNova 不存在该形态，首位更符合"渠道字段优先"直觉。

### D3 测试策略：宿主时序用可控 fake scope 复现

`tests/settings.test.ts` 用可变快照的 fake `SettingsScope` 复现宿主真实时序：先 `loading`（accounts 不可见）构造 controller 并完成一轮 describe，再切 `ready`（含已配置的账户 2）并触发订阅回调，断言徽标最终为已配置。`tests/adapter.test.ts` 新增仅含 `max_output_length` 的目录条目用例，断言 `resolveModel()` 上报 `defaultMaxTokens: 65536`；既有 `max_output_tokens` 用例保留作为兜底字段回归。

## Risks / Trade-offs

- [上报 defaultMaxTokens 后宿主将 65536 作为每次请求的 max_tokens 下发，思考与正文共享该上限] → 这是模型真实能力上限且实测 API 接受 65536 不报 400；若未来渠道收紧限制，错误会以 400 形式显式暴露，可再按渠道上限钳制。
- [describe 重试仅在 scope 变化时触发，宿主 credentials 域临时失败后可能短暂残留旧徽标] → 与现状一致不劣化；保存/刷新凭据/凭据事件路径仍会主动重查。
- [refs 集合对比在每个快照替换时执行] → 集合规模为个位数账户，字符串比较成本可忽略。

## Migration Plan

纯插件内小改，无存储/接口迁移；构建产物随插件版本发布，回滚即恢复旧插件版本。

## Open Questions

（无）
