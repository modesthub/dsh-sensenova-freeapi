## Context

本变更跨越 provider 侧（host）与客户端 UI（web）两侧，涉及三条既有链路：

1. **生成请求链路**：`SensenovaAdapter.stream()`（`src/adapter.ts`）→ `resolveApiKey` → 401 预流轮换循环 → `fetch /chat/completions` → `parseOpenAiSse` 流式翻译。当前在请求发起前没有任何并发闸，瞬时并发超限依赖 429 后宿主重试层退避兜底。
2. **配置链路**：`Config`（schemastery schema，`src/index.ts`）→ `resolveAdapterOptions` → `SensenovaConnection`（`src/adapter.ts`），字段 `apiBase`/`accounts`/`activeAccount`/`modelSelection`。
3. **设置页链路**：`src/client/settings.ts`（领域层，无 JSX）→ `src/client/section.tsx`（React 组件）→ `src/client/index.ts`（`injectPageCss` 样式注入）→ `src/client/locales.ts`（文案）。

宿主 `dsh-llm` 未提供 provider 侧并发闸原语（`retry-policy` 只管重试退避，`dsh-llm-retry` 只管失败后的重试调度），并发闸需插件自研。宿主设计令牌 `--dsw-alias-*` 已核实：`--dsw-alias-brand-primary` 浅色为近黑、深色为近白；`--dsw-alias-label-primary` 与之一致；`--dsw-alias-label-primary-foreground` 为"主色上的反色前景"（浅色白、深色近黑），`--dsw-alias-brand-primary-weak` 在宿主令牌表中不存在。

## Goals / Non-Goals

**Goals:**
- 在 `stream()` 入口建立按 key 隔离的并发闸，从源头把同一 key 的并发生成请求压到配置上限内，超出排队而非立即失败。
- 修正主按钮文字令牌与「活动」徽标配色，实现自动模式下"当前实际生效账户"的可识别标记。
- 并发上限作为设置字段进入高级设置折叠区，默认 1，保存热生效。

**Non-Goals:**
- 不改动 429/401 语义本身：429 仍不轮换不冷却、401 仍禁用轮换；并发闸只是 429 兜底之前的源头抑制。
- 不对模型目录拉取（`listModels`）做并发限制。
- 不引入第三方并发库（保持插件零运行时依赖，peerDependencies 不变）。
- 不在 Models 页卡片展示并发上限或"生效账户"细节。

## Decisions

### D1：并发闸按 API key 隔离（每 key 独立上限）

- **选择**：新增 `src/concurrency.ts`，实现 `KeyedConcurrencyGate`，内部 `Map<key, 队列>`，`acquire(key, limit, signal)` 返回 `release` 函数；队列 FIFO；条目在队列排空后惰性删除。
- **理由**：spec 需求是"限制同一 API key 下的同时生成请求数"，且账号池本身以 key 为键去重。全局闸会让某个 key 的突发排队拖累其它 key，与多账号轮换设计冲突。
- **备选**：全局单一信号量 —— 被否决（违反 per-key 语义）；引入 `p-limit`/`async-sema` —— 被否决（几十行无依赖实现即可，且 node 测试可直驱）。

### D2：并发闸只作用于生成请求，且额度按"发起请求"粒度获取

- **选择**：仅在 `stream()` 中、`resolveApiKey` 之后、发起 `/chat/completions` fetch 前 `acquire`，并在包裹"本次 attempt + 流式翻译"的 `try/finally` 中 `release`。`listModels` 不加闸。
- **理由**：429 的触发点在生成接口；目录拉取是廉价的一次性调用（自带 10s 超时），不是限流热点，也不该与流并发耦合。
- **401 预流轮换的记账**：每次 attempt 按"该 attempt 实际使用的 key"获取额度；401 命中时先释放旧 key 额度、再为新 key 获取额度。401 预流轮换是流开始前的瞬态，对排队公平性无实质影响。429 不轮换，因此一个流从获取额度到结束始终持有同一 key 的额度。

### D3：额度释放在 async generator 的 `finally` 中完成

- **选择**：把"获取额度 → fetch → `yield* parseOpenAiSse`"整体包进 `try/finally`，`finally` 里 `release()`。
- **理由**：`stream()` 是 async generator，消费者提前 `return()`/`throw()` 都会触发 `finally`，保证额度在流被中途丢弃、报错或正常结束时都能可靠释放，不会泄漏并发额度。
- **取消语义**：排队等待期间 `signal` 中止 → `acquire` 抛取消错误且不占额度；已持额度时中止 → `finally` 立即释放。

### D4：配置字段 `concurrency`，正整数、默认 1

- **选择**：新增 schema 字段 `concurrency: z.natural().min(1).default(1)`（schemastery `natural()` = 非负整数，`min(1)` 约束为正），经 `resolveAdapterOptions` 归一化后进入 `SensenovaConnection`，最终传给 adapter 的并发闸。
- **理由**：默认 1 最保守（串行，绝不超过配额下限）；`natural().min(1)` 在 schema 层杜绝 0/负数/非法值，adapter 侧仍做防御性回退（非正整数或无法解析 → 1）。
- **字段名**：`concurrency`，与既有 `apiBase`/`apiKeyEnv`/`accounts`/`activeAccount`/`modelSelection` 的简洁命名一致；UI 显示名为「并发上限」。

### D5：活动账户可见性统一为派生值 `effectiveActiveAccountId`

- **选择**：在 `settings.ts` 领域层新增派生字段 `effectiveActiveAccountId`：显式钉选（`activeAccount` 非空且指向已保存账户）时取该 id；自动模式（空）时，`defaultConfigured` 为真取 `'default'`，否则取第一个 `configured` 账户行 id，均无则空串。`section.tsx` 据此统一渲染：默认账户卡在 `'default'` 时显示"当前"标记，账户行在 `id` 命中时显示标记。
- **理由**：把"谁生效"的判断集中到可测的领域层，避免在组件里散落两份判断；默认账户卡与账户行共享同一标记逻辑。
- **UI 已知边界**：设置页只感知"已配置"（凭据存在），感知不到运行时"是否被 401 禁用"；故自动模式标记基于"已配置"的最佳努力，与真实运行时（401 禁用后自动顺延）可能存在短暂差异，在提示文案中说明。

### D6：CSS 令牌修正与徽标配色

- **选择**：`.sn-btnPrimary` 的 `color` 改为 `var(--dsw-alias-label-primary-foreground, #fff)`；`.sn-badgeActive` 改为实心高对比 `background: var(--dsw-alias-button-primary-fill, #0f1115)` + `color: var(--dsw-alias-label-primary-foreground, #fff)`。自动模式"当前"标记复用 `sn-badgeActive` 样式，文案区分「活动」（显式钉选）与「当前」（自动生效）。
- **理由**：`--dsw-alias-brand-primary-weak` 不存在，旧 tint 永远回退到淡蓝，且 `color` 又取近黑 `brand-primary`，导致"淡蓝底 + 近黑字"与中性徽标同灰度；改实心主色填充后与"已配置/未配置"的中性配色形成明确对比，且不违反"配置状态徽标用中性色"的既有约束（「活动」是选中态指示，非配置状态）。

### D7：设置页并发上限字段

- **选择**：`FieldName` 增加 `'concurrency'`；`SenseNovaConfig`/`SettingsState` 增加对应字段与 staged 草稿；`AdvancedSettings` 折叠区内新增 number 输入（默认 1，`min=1`，非法输入在保存时按 1 回退）。`edit('concurrency', ...)`、`save()` 写入逻辑对齐既有 `apiBase` 的 staged 模式。
- **理由**：并发上限是低频字段，纳入既有高级设置折叠区，复用 staged 草稿与保存热生效链路，不新开保存路径。

## Risks / Trade-offs

- [并发上限设 1 仍可能 429（若 key 的配额对单并发也瞬时超限）] → 默认 1 已是保守下限，且 429 兜底链路（宿主重试退避后原 key 重试）完全保留，双保险。
- [async generator 额度泄漏] → 依赖 `finally` 语义（见 D3），配合 node 测试覆盖"正常结束/中途 throw/提前 return"三路径。
- [per-key 队列 Map 内存增长] → 条目排空即删；key 数量有界（账号数 + 默认），重启后自然清零。
- [自动模式"当前"标记与实际运行时 401 禁用顺延不一致] → 标记基于"已配置"的最佳努力，文案注明"实际以运行时可用账号为准"。
- [UI 新增字段对旧宿主/旧设置的兼容] → 新字段有 default，旧配置缺省即 1，无迁移；旧宿主令牌缺失时 CSS 均保留硬编码 fallback。

## Migration Plan

纯代码 + 配置字段新增：`pnpm build` → `pnpm typecheck` → `pnpm test` → bump `package.json` version → 走插件市场「更新」生效。无数据迁移、无设置结构破坏；旧版本回滚即恢复旧行为（并发闸随代码移除而消失，设置字段多出的 `concurrency` 键被旧代码忽略）。

## Open Questions

（无——并发机制、默认值、作用范围与 UI 标记语义均已在探索/确认阶段敲定，无需推迟的未知项。）
