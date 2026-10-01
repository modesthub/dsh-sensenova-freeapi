## Context

设置页 UI 由三层组成：`src/client/section.tsx`（React 组件）、`src/client/index.ts`（样式注入 `injectPageCss`）、`src/client/locales.ts`（zh/en 文案）。领域层 `src/client/settings.ts` 的 `SenseNovaSettingsController` 与 `@mars-sea/dsh-commandcode-provider` 的 `SettingsController` 同构，本次不动。参考实现的设置页源码已从其 sourcemap 提取核对（`section.tsx` 998 行 + 样式注入），关键模式：`cc-field` 单列堆叠 + `cc-field+.cc-field` hairline 分隔、`cc-reset` 无边框文本按钮、徽标 `white-space: nowrap`、标签 `min-width: 0`、`select.cc-input` 自绘 chevron、`AdvancedSection` 折叠卡、`useSavedFlash` 2500ms 定时复位。宿主提供 `--dsw-alias-*` 设计令牌，且两个插件的 client inject 链完全一致，令牌可直接使用。

## Goals / Non-Goals

**Goals:**
- 消灭 7 个缺失 CSS 类导致的所有渲染缺陷，TSX 引用的类与样式表一一对应。
- 账户行、活动账户选择、高级设置收纳、动作按钮样式全面对齐参考实现模式。
- 凭据引用名从 UI 完全消失（用户明确要求）。
- 轮换文案与 `src/adapter.ts`/`src/accounts.ts` 的实际行为一致。

**Non-Goals:**
- 不动领域层 `settings.ts`：保存语义、staged 草稿、凭据写入路径、`llm-sensenova` 命名空间契约全部保持。
- 不加用量卡（SenseNova 无对应 Remote 端点）、不做字段级重置（需领域层 user-layer 追踪）、不做版本 footer 与更新检查、不引入宿主 `Button` 原语（继续手写样式）。
- 不给活动账户下拉加「默认账户」显式选项，`''` = 自动的语义不变。
- host 侧（`src/adapter.ts`、`src/accounts.ts`）零改动。

## Decisions

- **凭据引用名完全撤出 UI**：删除默认账户卡的「默认凭据引用」字段与账户行的引用名展示。领域层 `edit('apiKeyEnv')` 通道保留但不再有 UI 入口；内部解析（默认 `SENSENOVA_API_KEY`、额外账户 `SENSENOVA_API_KEY_N`）照旧，说明保留在 README。备选「收进高级设置折叠区」被否决：用户明确表示不需要关心内部命名。
- **账户行单列堆叠**：对齐 `cc-field` 模式——行头一行放「备注名标签 + 徽标（未保存/已配置/活动）+ 文本动作（清除已存密钥/撤销、显示/隐藏、删除）」，下方全宽备注名输入、全宽密钥输入、提示。多账户卡内部以 `sn-accountRow + sn-accountRow { border-top }` 分隔，不用嵌套边框盒。备选「保留双栏但加 `flex-wrap`」被否决：治标不治本，仍需 nowrap/min-width 补丁且与参考实现不一致。
- **文本化动作按钮**：`sn-reset` 从有边框按钮改为无边框文本样式（12px、`--dsw-alias-label-secondary`、hover 变 primary、disabled 半透明）。该类被「添加账户」「显示/隐藏」「清除已存密钥」「重置」复用，改一处全页生效；需逐一核对 Models 卡片（`card.tsx`）对 `sn-reset` 的使用不被误伤。
- **活动账户改下拉**：`<select class="sn-input">` + `appearance:none` + SVG chevron 背景（照搬参考实现的 `select.cc-input` 方案），选项：`''` 自动 + 已保存账户（`!added`，label 取存储标签）。重置文本按钮调 `setActiveAccount('')`。「活动」徽标保留在行头作只读指示，补 `sn-badgeActive` 样式区分于「已配置」。
- **高级设置折叠卡**：组件内 `useState(false)`，`aria-expanded`/`aria-controls` + chevron。已自定义计数按「值 ≠ 默认」判断（`apiBase !== DEFAULT_API_BASE`、include 非空、exclude 非空各计 1 项），不引入领域层 overridden 追踪。收纳字段：API 地址、手动加入模型、隐藏模型。
- **设计令牌切换**：颜色全部改用 `--dsw-alias-border-l2`、`--dsw-alias-bg-layer-1/3`、`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-brand-primary`、`--dsw-alias-label-error` 等，均保留现有硬编码 fallback，旧宿主不致裸奔。
- **savedFlash 定时复位**：改用 `useEffect` + `setTimeout(2500)` + cleanup 的参考实现模式，替换现有 render-phase setState 且永不复位的版本。
- **文案修正**：`accountsHint` zh/en 改为「密钥失效（401）时自动切换；429 限流不切换、由宿主重试层退避后原 key 重试」；删除 `apiKeyEnv`/`accountKeyEnv` 相关键，新增高级设置、下拉、折叠相关键。

## Risks / Trade-offs

- [存量用户曾把 `apiKeyEnv` 改成非默认值，UI 移除入口后无法从页面改回] → 控制器仍尊重存储值照常解析；README 记录通过用户设置文档手动修改的路径；该字段自插件发布以来无宣传入口，实际影响面趋近于零。
- [`sn-reset` 文本化波及 Models 卡片按钮] → 实现时逐一核对 `card.tsx` 的类使用，必要时为卡片单独保留描边样式类。
- [select 原生下拉在深/浅主题下的 chevron 与选项对比度] → chevron 使用 `--dsw-alias-label-tertiary`（带 fallback `#888f98`），与参考实现同款 SVG。
- [折叠区隐藏了「隐藏模型」这类排查时会用到的字段] → 折叠头显示已自定义计数徽标，非零即可见，与参考实现行为一致。

## Migration Plan

纯客户端 UI 层变更：构建（`pnpm build`）→ bump `package.json` version → 走插件市场更新生效。无数据迁移、无设置结构变化；回滚即退回上一发布版本。

## Open Questions

（无——字段收纳范围、下拉选项语义、P2 取舍均已在探索阶段与用户确认。）
