## Context

动机见 proposal.md。当前实现事实（均已直接读码/实测确认）：

- `src/adapter.ts` 的 `resolveModel()`（729-742 行）仅在目录缓存条目带 `reasoning`（词表）时返回 `reasoning`；`parseCatalog` 的 `reasoningInfoFrom`（211-223 行）只从词表字段构造。SenseNova `/models` 实测只给 `supported_features: ["reasoning"]`、无任何档位词表 → 无模型暴露档位。
- 宿主 `dsh-llm` 的 `resolveCallWithInfo` 会校验 `reasoning.efforts` 并把选定的 effort 落到 `GenerateOptions.reasoningEffort`（不透传则不发送），宿主模型选择器（`dsh-client-ui-model-selection`）只在 `model.reasoning` 存在时渲染档位选择。因此本插件只需要正确返回 `reasoning.efforts`，宿主全链路（UI 选择 → 校验 → 请求透传）即自动生效。
- `stream()` 的 `buildOpenAiBody`（325-340 行）已把 `options.reasoningEffort` 透传为 `reasoning_effort`，无需改动 wire 发送。
- SSE 解析 `processChunkEvent`（479-566 行）只读 `delta.reasoning_content`（493 行）；tool-call 分桶用 `tc.id ?? '__synthetic'`（519-549 行）。
- UI 层 `src/client/index.ts` 的 `injectPageCss` 以 `--dsw-alias-*` 设计令牌 + 硬编码 fallback 手写样式；徽标 `sn-badge` 用 `--dsw-alias-label-success` 当背景、footer `sn-footer` 左对齐、重置 `sn-reset` 是无边框文本。

参考实现 `@mars-sea/dsh-commandcode-provider`（node_modules 内，read-only）：`KNOWN_EFFORTS` 静态模型→档位表、`resolveModel` 暴露 `reasoning.efforts`、`cc-badge` 中性底、`cc-footer` 右对齐 + `Button variant=ghost/primary`。

## Goals / Non-Goals

**Goals:**
- 思考档位成为「可按模型选择」的能力：目录标记 reasoning + 静态族表 → 暴露 `reasoning.efforts`；宿主 UI/请求链自动生效，不改 `buildOpenAiBody` 之外的 wire。
- 流式思考增量双字段兼容（`reasoning_content` + `reasoning`）。
- tool-call 聚合键 `index` 优先，消灭并行分片错位。
- 设置页徽标中性化、footer 右对齐 + ghost/primary 按钮，对齐参考插件观感。
- 覆盖行为用宿主 `BlockAssembler` 组装口径做单测验收。

**Non-Goals:**
- 不做 provider 级思考档位默认值设置（保持网关默认），不引第三方依赖。
- 不动 `settings.ts` 领域层保存语义、凭据路径、429/401 轮换、目录过滤（image-only 排除等）。
- 不引入宿主 `Button`/`Badge` UI 原语（沿用现有手写样式注入，只改类定义）；除非参考实现证明必须，不重构整个设置页 DOM。
- 不处理 Anthropic 兼容端点（插件只接 OpenAI 兼容 `chat/completions`）。

## Decisions

- **思考档位：目录词表优先，静态族表兜底**。`reasoningInfoFrom` 已有词表路径保持；新增 `KNOWN_EFFORTS` 静态表（`Map<modelId, readonly string[]>`），仅当目录条目 `supported_features` 含 `reasoning`（或仅有 reasoning 支持标记）且 id 命中静态表时，把表值包装为 `ReasoningEffortId` 数组返回，**不设 `defaultEffort`**。备选「全部模型按族统一暴露」被否：会为 `sensenova-6.7-flash-lite` 这类不可路由/目录外模型虚构能力；「仅靠目录词表」被否：目录无词表（实测根因）。
- **档位表值域 = 官方文档**（用户确认，见 proposal）。wire 原值直传；`none` 是普通可选档位而非特殊开关（宿主把 effort 原样发 `reasoning_effort: none`，实测关闭思考）。
- **思考字段双读**：优先 `reasoning_content`，其次 `reasoning`，避免同一事件双发。状态机把两者都当作进入 reasoning 块的信号；`closeReasoning` 语义不变。
- **tool-call 聚合键 index 优先**：对齐 `dsh-llm-deepseek` 的 `call.index` 用法。同 index 换 id 视为新槽的冲突保护：以 `index` 为主键、槽内 id 覆盖更新（不因 id 变化重开槽），无 index 用 id、再退到出现顺序自增槽。`closeToolCalls` 保留（name 为空不发 block-end 的兜底在新键下不会误伤并行槽）。
- **徽标中性配色**：`sn-badge`/`sn-badgeActive` 背景改 `--dsw-alias-bg-module-platform`（fallback `rgba(127,127,127,.15)`）+ `--dsw-alias-label-secondary`，`sn-badgeMuted` 去底仅 tertiary 文字，保留 `white-space:nowrap`。fallback 值全部保留，旧宿主不裸奔。
- **footer 右对齐 + 按钮分级**：`sn-footer` 加 `justify-content:flex-end`；重置改 ghost 视觉（透明底、1px `--dsw-alias-border-l` 描边、secondary 文字、hover primary 描边/文字），保存保持 primary。状态消息（failed/saved/unsaved）移到按钮行上方独立一行（结构微调 `section.tsx`），与参考 `cc-footer` 分离。
- **验收口径**：tool-call 用「宿主 `BlockAssembler` 组装后的块」断言（沿用 handoff 结论，adapter 层 chunk 会漏判 name:"" 块）。

## Risks / Trade-offs

- [静态表与真实网关档位漂移（模型更新/下架）] → 目录 `supported_features` 无 reasoning 即不暴露，静态表只对目录内 reasoning 模型生效；档位 id 全是官方/实测值，漂移风险集中在网关新增档位，届时补表即可。
- [`none` 档位对部分模型可能被网关忽略] → 实测 deepseek-v4-flash/6.8/pro/kimi 均接受 none；glm-5.2 非流式接受。kimi 官方值域无 none（按官方口径不列）。
- [6.8 系 `delta.reasoning` 与 deepseek 系 `reasoning_content` 同事件共存] → 双读时以 reasoning_content 优先并只发一次，测试覆盖两字段独立/共存。
- [index 优先对复用 id 的畸形流] → index 为主键避免同 id 复用串槽；无 index+id 同时缺失的多工具极端形态按出现顺序分槽（已有测试形态）。
- [CSS 改动影响 Models 页卡片（复用 `sn-badge` 等类）] → 卡片同步核对，徽标中性化对卡片同样适用；若卡片需要独立视觉再单独加类。

## Migration Plan

纯代码 + 样式改动，无数据迁移、无设置结构变化：`pnpm typecheck` + `pnpm test` + `pnpm build` → bump `package.json` version → 插件市场更新生效；回滚即退回上一发布版本。

## Open Questions

（无——档位值域、none 语义、UI 方向、tool-call 验收口径均已在探索阶段与用户确认并实证。）
