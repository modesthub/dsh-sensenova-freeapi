## Why

SenseNova 设置页存在真实渲染缺陷：`src/client/section.tsx` 引用的 7 个 CSS 类（`sn-accountRow`、`sn-accountFields`、`sn-accountKeyRow`、`sn-btnPrimary`、`sn-badgeActive`、`sn-textarea`、`sn-models`）未在样式表中定义，导致账户行挤压换行（「已配置」徽标与「删除」按钮文字竖排断裂）、保存按钮回退浏览器默认样式、Models 页卡片无容器样式。同时「多账户轮换」文案声称 429 时自动切换账户，与适配器「仅 401 轮换、429 原 key 退避重试」的实际行为相反。整体布局与交互明显落后于同构参考实现 `@mars-sea/dsh-commandcode-provider` 的设置页（单列账户行、下拉选择活动账户、高级设置折叠、文本化动作按钮）。

## What Changes

- 补齐全部缺失 CSS 类并清理死样式（`sn-account`、`sn-row`、`sn-btn`）；颜色从硬编码 fallback 切换到宿主 `--dsw-alias-*` 设计令牌（保留 fallback 值）。
- 账户行重写为单列堆叠布局：头部一行放备注名标签、徽标与动作按钮（全部 `white-space: nowrap`），下方依次为全宽备注名输入、全宽密钥输入、提示文字；账户之间用 hairline 分隔，不再使用嵌套边框盒与左右双栏挤压布局。
- 活动账户选择从「radio 列表 + 行内设为活动按钮」双入口收敛为一个下拉框（自动 + 已保存账户）与重置文本按钮；`''` = 自动的语义不变，未保存的新增行不出现在下拉中。
- 凭据引用名（`SENSENOVA_API_KEY` / `SENSENOVA_API_KEY_N`）从设置页 UI 完全移除：删除「默认凭据引用」编辑字段与账户行上的引用名展示；内部凭据解析机制与 `apiKeyEnv` 存储契约不变，说明保留在 README。
- 新增「高级设置」折叠卡收纳低频字段（API 地址、手动加入模型、隐藏模型），带已自定义项计数徽标与 `aria-expanded`/chevron，默认折叠。
- 修正 zh/en 轮换文案：「密钥失效（401）时自动切换到下一个可用账户；429 限流不切换、由宿主重试层退避后原 key 重试」。
- 「已保存 ✓」反馈改为显示 2.5 秒后自动消失（对齐参考实现的 saved-flash 模式）。
- 不改领域层 `src/client/settings.ts` 的保存语义、凭据写入路径与 `llm-sensenova` 命名空间契约；host 侧零改动。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `sensenova-provider`: 「Web 设置页」需求的 UI 行为变更——账户行单列布局、活动账户下拉选择、凭据引用名不展示、高级设置折叠、轮换文案与实际行为一致、保存反馈短暂显示。

## Impact

- 代码：`src/client/section.tsx`（布局重写）、`src/client/index.ts`（样式表补齐与重写）、`src/client/locales.ts`（文案增删改）；`src/client/card.tsx` 仅因 `sn-models` 补齐而受益，无代码改动。
- 测试：`tests/` 中涉及设置页文案与 UI 行为的断言需同步调整。
- 不影响：`src/adapter.ts`、`src/accounts.ts`、凭据写入路径、`package.json` 依赖与 peerDependencies。
