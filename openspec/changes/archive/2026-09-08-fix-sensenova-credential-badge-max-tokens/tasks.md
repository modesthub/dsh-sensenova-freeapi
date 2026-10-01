# 任务：额外账户徽标读取时序与模型最大输出上限修复

## 1. 设置页凭据徽标读取时序修复

写文件组：`src/client/settings.ts`、`tests/settings.test.ts`

- [x] 1.1 在 `SenseNovaSettingsController` 的 scope 订阅回调中加入 credential-ref 集合对比：与上一次成功 `describeAll()` 查询过的集合不一致时重新执行 `describeAll()`（仅 `response.ok` 时更新集合快照），使快照 `loading→ready` 或 accounts 变化引入的新 ref 都能重查配置状态
- [x] 1.2 回归测试：fake scope 先以 `loading`（无 accounts）构造 controller 并完成首轮 describe，随后切 `ready`（含已配置凭据的账户 2）并触发订阅回调，断言该账户行 `configured` 为 true（对照 spec 场景「快照就绪后徽标反映真实配置」）

## 2. 模型输出上限解析修复

写文件组：`src/adapter.ts`、`tests/adapter.test.ts`

- [x] 2.1 `firstMaxOutputField()` 候选列表首位加入 `max_output_length`，OpenAI 风格字段（`max_tokens`/`max_output_tokens`/`max_completion_tokens` 及驼峰变体）保留兜底
- [x] 2.2 回归测试：目录条目仅含 `max_output_length: 65536` 时 `resolveModel()` 上报 `defaultMaxTokens: 65536`（对照 spec 场景「识别 SenseNova 目录的 max_output_length 字段」）；既有 `max_output_tokens` 用例继续通过

## 3. 验证

- [x] 3.1 `npm run typecheck` 与 `npm test` 全部通过
- [x] 3.2 `openspec validate --strict "fix-sensenova-credential-badge-max-tokens"` 通过
