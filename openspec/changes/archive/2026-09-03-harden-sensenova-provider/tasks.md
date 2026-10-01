## 1. 模型目录与能力元数据解析

- [x] 1.1 扩展 `CatalogEntry`，保存 `inputModalities`、`contextWindow`、最大输出 token、思考/推理级别及默认级别。
- [x] 1.2 建立已知不可路由模型清单（至少 `sensenova-6.7-flash-lite`）与进程内失败缓存，作为目录过滤条件。
- [x] 1.3 在 `parseCatalog()` 读取 `output_modalities` 与 `input_modalities`，仅收录 `output_modalities` 含 `text` 且未命中不可路由清单/失败缓存的模型。
- [x] 1.4 解析上下文字段 `context_length`、`context_window`、`max_context_length`、`contextLength`，以及最大输出字段 `max_tokens`、`max_output_tokens`、`max_completion_tokens` 和对应驼峰别名。
- [x] 1.5 解析 `reasoning_efforts`、`reasoning_levels`、`reasoning.efforts`、`thinking.efforts` 词表及默认级别；只有明确词表才暴露 reasoning，未知字段不阻塞其他模型。
- [x] 1.6 让目录刷新以新快照原子替换旧缓存，保留失败标记，避免 `listModels()` 返回新目录而 `resolveModel()` 仍读取旧能力。

## 2. 宿主模型信息自动配置

- [x] 2.1 实现显式品牌映射与可读回退规则，将模型 id 标准化为显示名，并应用到 `listModels()` 与 `resolveModel()`。
- [x] 2.2 将目录声明的 `input_modalities` 映射为宿主 `inputModalities`，不再硬编码为 `['text']`。
- [x] 2.3 让 `resolveModel()` 优先使用目录提供的 `contextWindow` 和 `defaultMaxTokens`，不得以固定默认值覆盖已声明值。
- [x] 2.4 将目录 effort id 原样包装为宿主 `ReasoningEffortId`，映射 `reasoning.efforts` 与匹配的 `defaultEffort`，使宿主自动传递 `reasoning_effort`。
- [x] 2.5 当目录只有 `reasoning_effort`/`thinking`/`supported_parameters` 支持标记而没有词表时，不虚构思考级别；目录未提供上下文或最大输出时保留明确的兼容回退。

## 3. 模型不可路由与 Retry-After 处理

- [x] 3.1 在 `httpError()` 识别 404 且错误体包含 `model route not found` 或 `model is not found`，返回明确的 `MODEL_NOT_FOUND` 错误并标记对应模型 id。
- [x] 3.2 确保 `MODEL_NOT_FOUND` 不触发账号轮换或 provider 重试，其他 404 仍保持通用错误行为。
- [x] 3.3 对 429 的服务端 `Retry-After` 做 provider 延迟上限处理：超过 3000 毫秒时整值不透传 `providerRetryAfterMs`，不得先截断为 3000 毫秒后再透传；账号冷却仍保留原始冷却时间，provider 延迟与账号冷却使用独立阈值。

## 4. Provider 重试策略

- [x] 4.1 在 `SensenovaAdapter.providerRetryPolicy()` 返回 `normal` 策略，配置 `maxRetries=1000` 与 `backoff.maxDelayMs=3000`。
- [x] 4.2 保留默认 `initialDelayMs`、`jitterRatio` 与可重试错误集合，并确保本地指数退避（含 jitter）不超过 3000 毫秒。

## 5. 测试

- [x] 5.1 为文生图模型过滤、已知 stale 模型过滤、文本模型保留和运行时失败缓存新增 `tests/adapter.test.ts` 用例。
- [x] 5.2 为多模态输入、上下文大小、最大输出及目录刷新后的能力同步新增用例。
- [x] 5.3 为 reasoning 词表映射、默认级别、`ReasoningEffortId`、仅支持标记时不虚构级别新增用例。
- [x] 5.4 为标准显示名（包括 `sensenova-6.7-flash-lite` → `Sensenova 6.7 Flash Lite`）新增用例。
- [x] 5.5 为 404 模型不可路由错误、失败标记及不轮换账号新增用例。
- [x] 5.6 为 provider 重试策略新增用例，断言 `maxRetries=1000`、`maxDelayMs=3000`、jitter 后仍不超过上限。
- [x] 5.7 为 `Retry-After` 大于 3000 毫秒不透传 provider 延迟、但保留账号冷却语义新增用例。

## 6. 验证

- [x] 6.1 执行 `pnpm run typecheck` 并通过。
- [x] 6.2 执行 `pnpm test` 并通过。
- [x] 6.3 执行 `pnpm run build` 并通过。
- [x] 6.4 在当前插件目录执行 `openspec validate --strict harden-sensenova-provider` 并通过。

## 7. 手动模型可选列表

- [x] 7.1 扩展 host `SensenovaConfig`、`Config` schema 和解析后的 adapter options，持久化 `modelSelection.include` 与 `modelSelection.exclude`，对 id 去空白、去重并保持稳定顺序。
- [x] 7.2 将手动选择注入 `SensenovaAdapter`，按“image-only 始终排除、显式 exclude 优先、include 覆盖 stale 自动过滤、未出现在目录中的 id 不合成条目”的顺序应用。
- [x] 7.3 保证手动 include 的 stale 文本模型仍使用目录能力元数据，并继续经过 `MODEL_NOT_FOUND` 404 兜底，不绕过安全错误处理。
- [x] 7.4 在 SenseNova 设置页增加 include/exclude 模型 id 编辑控件、未保存状态、保存/重置及中英文文案；配置保存后热更新 host adapter。
- [x] 7.5 为手动重新加入 stale 文本模型、隐藏正常文本模型、禁止手动加入 image-only、include/exclude 冲突、目录刷新保留配置和未知 id 不合成条目新增测试。
- [ ] 7.6 运行 `pnpm run typecheck`、`pnpm test`、`pnpm run build` 与 `openspec validate --strict harden-sensenova-provider`，仅在各项有证据通过后勾选本组验证任务。
