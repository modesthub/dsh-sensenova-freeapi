## 1. 思考档位静态表与能力暴露（src/adapter.ts）

- [x] 1.1 新增 `KNOWN_EFFORTS` 静态族表（modelId → wire 档位数组）：`sensenova-6.8-flash-lite: [low, medium, high, none]`、`deepseek-v4-flash: [low, medium, high, none]`、`deepseek-v4-pro: [low, high, max]`、`glm-5.2: [low, medium, high, none]`、`kimi-k3: [low, high, max]`
- [x] 1.2 扩展能力解析：目录条目 `supported_features` 含 `reasoning`（或仅有 reasoning 支持标记）且 id 命中静态表时，`resolveModel()` 返回 `reasoning.efforts`（wire 原值包装 `ReasoningEffortId`）；目录词表路径保持优先；不设 `defaultEffort`
- [x] 1.3 静态表未覆盖或目录无 reasoning 标记的模型不虚构档位；`parseCatalog`/`resolveModel` 目录缓存结构兼容（CatalogEntry.reasoning 可由静态表补全或保持 undefined）

## 2. 流式思考双字段与 tool-call 分桶修复（src/adapter.ts）

- [x] 2.1 `processChunkEvent` 同时读取 `delta.reasoning_content` 与 `delta.reasoning` 作为思考增量，`reasoning_content` 优先、`reasoning` 兜底，同一事件不双发
- [x] 2.2 `delta.tool_calls` 聚合键改为 `index` 优先：同 `index` 归同槽；无 `index` 用稳定 `id`；两者皆无按出现顺序自增开槽；槽内 id/name 增量覆盖、arguments 拼接
- [x] 2.3 核对 `closeToolCalls`（name 为空不发 block-end）与既有历史 tool_call 清洗在并行分片下的行为，无回归

## 3. 设置页样式对齐（src/client/index.ts / section.tsx / card.tsx）

- [x] 3.1 `sn-badge`/`sn-badgeActive` 去绿：背景改 `--dsw-alias-bg-module-platform` + `--dsw-alias-label-secondary` 文字（保留 fallback）；`sn-badgeMuted` 去底仅 tertiary 文字；核对 `card.tsx` 徽标语义不受影响
- [x] 3.2 `sn-footer` 右对齐（`justify-content:flex-end`）；重置按钮 ghost 化（透明底 + 描边 + hover primary），保存保持 primary；状态消息（failed/saved/unsaved）从按钮行分离到上方独立展示
- [x] 3.3 `section.tsx` 底部结构微调以支持状态消息分离；核对所有 TSX 类与样式表一一对应

## 4. 测试补充（tests/adapter.test.ts / settings.test.ts）

- [x] 4.1 档位暴露用例：目录 `supported_features` 含 reasoning + 静态表命中 → `resolveModel` 返回 efforts；命中表但目录无 reasoning 标记 → 不暴露；表外模型不暴露；目录词表存在时优先
- [x] 4.2 思考双字段用例：`delta.reasoning_content` 与 `delta.reasoning` 各自被映射为 reasoning 增量；同事件共存不双发
- [x] 4.3 tool-call 并行分桶用例：规范 `index` 并行、无键并行两类 SSE 经宿主 `BlockAssembler` 组装后块数一致、name 非空、arguments 完整
- [x] 4.4 若涉及设置页类名/文案断言同步调整

## 5. 验证

- [x] 5.1 `pnpm run typecheck` 通过
- [x] 5.2 `pnpm test` 全部通过（含新增用例）
- [x] 5.3 `pnpm build` 通过；核对构建产物 client bundle 中 TSX 类与样式表一致
- [x] 5.4 `openspec validate --strict fix-sensenova-reasoning-ui-toolcalls` 通过
