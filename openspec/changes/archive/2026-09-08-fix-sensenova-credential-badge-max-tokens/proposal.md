# 变更提案：修复额外账户徽标读取时序与模型最大输出上限

## Why

两个用户可感知缺陷（2026-09-03 探索已定位根因，持久化与宿主行为均已实测排除）：

1. **额外账户徽标显示「未配置」**：配置账户 2 的 API key 并保存后，重新进入设置页（页面刷新 / DSH 重启）时该账户显示为未配置。磁盘状态完全正常（`~/.dsh/.credentials.yaml` 与 `~/.dsh/settings.yaml` 均已持久化），缺陷在 UI 读取时序：`SenseNovaSettingsController` 构造时立即执行 `describeAll()`，此时宿主 settings 快照仍为 `loading`，`storedAccounts()` 为空，额外账户的 credential-ref 不在查询列表；此后快照变 ready 仅触发 `publish()`，不会重新查询凭据状态，徽标因此永久显示「未配置」。默认账户不受影响（构造时即被查询）。
2. **模型输出被服务端默认上限截断**：SenseNova `/models` 真实目录的输出上限字段名为 `max_output_length`，而 `firstMaxOutputField()` 候选列表不包含该字段，`maxOutputTokens` 恒为 `undefined`，`resolveModel()` 从不上报 `defaultMaxTokens`，宿主因此不注入默认值，请求体从不携带 `max_tokens`。SenseNova 服务端默认输出上限仅 8192；实测思考模型（如 `deepseek-v4-flash` 默认思考档）不带 `max_tokens` 长输出时 `finish_reason: length`、`completion_tokens: 8192` 且全部为 reasoning tokens——思考耗尽整个上限，正文零字输出。

## What Changes

- **凭据徽标读取时序修复**：settings scope 快照从 `loading` 转为 `ready`（或涉及的 credential-ref 集合发生变化）时，重新执行凭据配置状态查询（`describeAll()`），使额外账户在重进设置页后显示真实的已配置/未配置状态；Models 页 provider 卡片的已配置计数同步恢复正确。
- **模型输出上限解析修复**：`firstMaxOutputField()` 候选列表加入 `max_output_length`（放首位，OpenAI 风格字段保留兜底），使目录声明的真实上限（实测 `deepseek-v4-flash` 65536、`glm-5.2` 131072）经 `defaultMaxTokens` 上报，由宿主在用户未显式设置 `maxTokens` 时自动作为请求默认 `max_tokens` 下发。实测 `max_tokens: 65536` 被 API 正常接受（不报 400）。

两项修复互不依赖，均为插件内小改动；不涉及宿主接口或存储格式变更。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `sensenova-provider`：
  - 「Web 设置页」requirement 增加约束：凭据配置状态徽标 MUST 在设置快照就绪后反映真实持久化状态（快照 loading→ready 转变或 credential-ref 集合变化时重新查询），不得因构造时序残留「未配置」误报。
  - 「模型能力自动配置」requirement 修改：最大输出字段解析候选列表 SHALL 包含 `max_output_length`（SenseNova 目录实际字段名），`resolveModel()` 据此上报 `defaultMaxTokens`。

## Impact

- `src/client/settings.ts`：`describeAll()` 触发时机（scope 订阅回调检测快照就绪/ref 集合变化）。
- `src/adapter.ts`：`firstMaxOutputField()` 候选列表。
- `tests/settings.test.ts`、`tests/adapter.test.ts`：新增回归场景（快照延迟就绪的徽标状态；`max_output_length` 目录字段的 `defaultMaxTokens` 上报）。
- 用户可见行为变化：重进设置页后额外账户徽标正确；长输出与思考模型不再被服务端 8192 默认上限截断（各模型按目录声明上限输出）。
- 风险评估：`defaultMaxTokens` 上报后宿主会将其作为每次请求的 `max_tokens` 下发（思考 + 正文共享该上限），这是模型真实能力上限；已实测 API 接受 65536，无 400 风险。
