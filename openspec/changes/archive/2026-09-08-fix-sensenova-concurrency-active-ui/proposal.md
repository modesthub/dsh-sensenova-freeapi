## Why

SenseNova 设置页存在两个真实的视觉缺陷：其一，保存主按钮把文字色误设为 `--dsw-alias-label-primary`，而宿主该令牌与主按钮背景色 `--dsw-alias-brand-primary` 在浅/深主题下均为同色系（浅色近黑底近黑字、深色近白底近白字），导致按钮文字完全不可见；其二，「活动账户」徽标颜色弱到与「已配置」中性徽标几乎同灰度，且「自动（第一个可用账户）」模式下没有任何账户行被标记，用户无法判断当前实际生效的账户。

与此同时，SenseNova 渠道对 API key 存在并发限制，瞬时并发超限会触发 429（当前仅交由宿主重试层退避后原 key 重试，属于事后兜底而非源头抑制）。插件缺少 provider 侧并发闸，无法在发起请求前把并发压到配额以内。

## What Changes

- **修正主按钮文字令牌**：`.sn-btnPrimary` 的 `color` 从 `--dsw-alias-label-primary` 改为 `--dsw-alias-label-primary-foreground`，使按钮在浅/深主题下均呈现「主色底 + 反色前景」的高对比，文字清晰可读。
- **活动账户可见性增强**：「活动」徽标 `sn-badgeActive` 由弱 tint 改为实心高对比填充（主色底 + 反色文字），与「已配置/未配置」等中性状态徽标形成明确区分；并在自动模式下展示当前实际生效账户的标识。
- **Provider 侧并发闸（新增能力）**：在 `stream()` 入口增加并发限制，同一时刻发往 SenseNova 的生成请求数不超过配置上限，超出上限的请求排队等待，从源头抑制瞬时并发超限。429 语义不变——仍不轮换、不冷却，交由宿主重试层退避后原 key 重试，作为并发闸之外的兜底。
- **并发上限可配置（新增设置字段）**：在设置页「高级设置」折叠区新增「并发上限」数字字段，默认值 1，允许用户按自身 key 配额调整；配置经 settings 命名空间持久化并在下一次请求热生效。
- **主 spec 需求变更**：修改「Web 设置页」需求（主按钮文字、活动账户可见性、并发上限字段），新增「生成请求并发限制」需求，并同步修正「429 不冷却不轮换」需求的措辞以明确并发闸与 429 兜底的职责边界。

## Capabilities

### New Capabilities

（无——并发闸与 UI 变更均落在既有 `sensenova-provider` capability 内）

### Modified Capabilities

- `sensenova-provider`: 「Web 设置页」需求的行为变更（主按钮文字令牌修正、活动账户可见性、并发上限字段）；新增「生成请求并发限制」需求；「429 不冷却不轮换」需求措辞同步（明确并发闸与 429 兜底分工）。

## Impact

- 代码：`src/adapter.ts`（并发闸接入）、`src/index.ts`（并发上限 schema 与连接事实）、`src/client/index.ts`（CSS 令牌修正与活动徽标样式）、`src/client/section.tsx`（并发上限字段 UI、自动模式活动账户标识）、`src/client/settings.ts`（并发上限领域字段）、`src/client/locales.ts`（新增文案）。
- 新增模块：`src/concurrency.ts`（无依赖的信号量并发闸，供 node 测试直接驱动）。
- 测试：`tests/` 新增并发闸行为测试与设置字段测试；既有 `tests/settings.test.ts` 可能需同步活动账户相关断言。
- 影响面：不改动凭据写入路径、401 轮换语义、429 不轮换语义与 `llm-sensenova` 命名空间既有字段；`package.json` 依赖与 peerDependencies 不变。
