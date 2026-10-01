## Why

SenseNova 插件当前存在三类真实缺陷，共同导致「对模型的设置不可用、配置页观感差、并行工具调用死循环」：

1. **思考深度不可配置（思考默认无法关闭/调档）**：`/v1/models` 目录只返回 `supported_features: ["reasoning"]` 支持标记，**从不返回档位词表**（实测目录 8 个模型的 key 里没有 `reasoning_efforts`/`thinking.efforts` 等任何档位字段）。适配器 `adapter.ts` 遵循「目录无词表就不虚构思考级别」的既有语义，`resolveModel()` 因此从不返回 `reasoning` 元数据 → 宿主模型选择器显示「当前模型未提供推理等级」，`reasoning_effort` 参数永不出现在请求体 → deepseek-v4-flash 等模型**永远以默认思考档运行、无法关闭思考或调档**（实测：deepseek-v4-flash 默认思考开、`reasoning_effort: none` 可关闭、`low/medium/high` 全接受；sensenova-6.8 默认 `medium`、`none` 可关闭）。官方文档 [platform.sensenova.cn/docs](https://platform.sensenova.cn/docs) 给出了每个模型的思考等级值域，静态档位表可行。
2. **思考过程可能不显示**：实测 6.8 系流式思考字段是 `delta.reasoning`（官方文档确认），DeepSeek/Kimi 系是 `delta.reasoning_content`；`adapter.ts:493` 只读 `reasoning_content`，6.8 系的思考过程被丢弃。
3. **设置页观感与操作不合格（用户反馈 + 截图）**：Provider 路由「sensenova」徽标是 success 绿底白字（`sn-badge` 用 `--dsw-alias-label-success` 作背景），过艳刺眼；页面底部 footer 左对齐、重置只是无边框文本，与参考实现 `@mars-sea/dsh-commandcode-provider`（徽标中性底、footer 右对齐 ghost 重置 + primary 保存）差距明显。
4. **流式 tool-call 分桶 bug（历史 handoff，未修）**：`adapter.ts:519-549` 用 `tc.id` 分桶、无 id 时全部并入 `__synthetic` 单槽，忽略 OpenAI 规范的 `index` 键 → 并行工具调用（规范 index 并行 / 无键并行）name/arguments 错位，坏块经宿主宽容组装后进入执行层产生 `unknown tool ""` / `invalid arguments` 报错并触发重试死循环（截图 N/1000）。

## What Changes

- **思考档位按模型族静态暴露（host 侧，`src/adapter.ts`）**：新增与参考插件 `KNOWN_EFFORTS` 同构的扁平静态表，仅对「目录 `supported_features` 含 `reasoning`」且静态表覆盖的模型，在 `resolveModel()` 返回 `reasoning.efforts`；effort id 为官方文档/实测的 wire 原值。档位口径（官方值域，用户已确认）：
  - `sensenova-6.8-flash-lite`: `low`/`medium`/`high`/`none`
  - `deepseek-v4-flash`: `low`/`medium`/`high`/`none`（实测四档全接受）
  - `deepseek-v4-pro`: `low`/`high`/`max`（官方；`medium`/`xhigh` 网关自行映射 `high`）
  - `glm-5.2`: `low`/`medium`/`high`/`none`（官方「思考/非思考」+ 实测 `none` 关思考）
  - `kimi-k3`: `low`/`high`/`max`（官方）
  - 一律**不设 `defaultEffort`**，保持网关各自默认（6.8=medium、kimi=max 等），宿主 `resolveCallWithInfo` 会在请求缺省时原样透传网关默认；`none` 作为普通档位进入选择器，选中后 wire 发送 `reasoning_effort: none`（实测关闭思考）。
- **思考字段双读（`src/adapter.ts`）**：流式解析同时读取 `delta.reasoning_content` 与 `delta.reasoning` 作为思考增量（前者 DeepSeek/Kimi 系、后者 6.8 系），不再丢弃 6.8 系思考过程。
- **tool-call 分桶修复（`src/adapter.ts`）**：SSE `delta.tool_calls` 聚合键改为 `index` 优先 → 稳定 `id` → 按出现顺序自增槽（对齐官方 `dsh-llm-deepseek`），槽内 id/name 增量覆盖保留；修好后规范 `index` 并行与无键并行经宿主 `BlockAssembler` 组装均产出与工具数一致、name 非空、arguments 完整 JSON 的块。
- **设置页样式对齐参考实现（`src/client/index.ts` + `section.tsx` + `card.tsx`）**：
  - 徽标去绿：`sn-badge`/`sn-badgeActive` 背景从 success 绿改为中性平台底（`--dsw-alias-bg-module-platform`）+ `--dsw-alias-label-secondary` 文字，对齐 `cc-badge`；`sn-badgeMuted` 用 tertiary 文字无底。
  - Footer 右对齐：`sn-footer` 改 `justify-content:flex-end`；重置按钮升格为 ghost 风格（细描边/透明底 + hover primary），保存保持 primary，与参考 `cc-footer` 的「ghost 重置 + primary 保存」按钮组一致；failed/saved/unsaved 状态消息与按钮行分离，不再混排。
- **不改**：`settings.ts` 领域层保存语义、凭据写入路径、`llm-sensenova` 命名空间契约、429/401 轮换策略、目录过滤规则。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `sensenova-provider`: 「流式生成」需求变更——tool-call 按 `index`/`id` 稳定分桶避免并行错位；思考增量同时接受 `delta.reasoning_content` 与 `delta.reasoning`。「模型能力自动配置」需求变更——思考档位改由「目录 `supported_features` 含 reasoning」+ 静态模型族档位表共同决定，不再依赖目录词表。「Web 设置页」需求变更——徽标中性配色、底部操作右对齐且重置按钮 ghost 化。

## Impact

- 代码：`src/adapter.ts`（思考档位静态表与 `resolveModel`、`buildOpenAiBody` 保持透传、SSE 思考双字段、tool-call 分桶键与 `closeToolCalls`）、`src/client/index.ts`（样式表徽标/footer 类重写）、`src/client/section.tsx`（footer 结构微调）、`src/client/card.tsx`（若徽标类名/语义变化同步）、`src/client/locales.ts`（如新增档位相关文案）。
- 测试：`tests/adapter.test.ts`（tool-call 并行分桶断言改为经宿主 `BlockAssembler` 组装验收、思考双字段用例、档位暴露用例）、`tests/settings.test.ts`（如涉及）。
- 不影响：`src/accounts.ts`、凭据写入路径、`package.json` 依赖与 peerDependencies、`llm-sensenova` 设置命名空间。
- 发布：bump `package.json` version → 插件市场更新生效。
