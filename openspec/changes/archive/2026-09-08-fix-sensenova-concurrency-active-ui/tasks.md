## 1. 并发闸核心（新增 src/concurrency.ts）

- [x] 1.1 新增 `src/concurrency.ts`，实现 `KeyedConcurrencyGate`：`acquire(key, limit, signal?)` 返回 `release()`，内部按 key 维护 FIFO 等待队列与在途计数，排空后惰性删除条目；`limit` 非正整数时按 1 回退
- [x] 1.2 `acquire` 支持 `AbortSignal`：排队等待期间中止则抛出取消错误且不占额度；在途释放由调用方 `finally` 保证
- [x] 1.3 编写 `tests/concurrency.test.ts`：覆盖未超限直放、达到上限排队、上限为 1 串行、流结束释放、取消不占额度、非法 limit 回退默认

## 2. Provider 侧接入并发闸（src/adapter.ts）

- [x] 2.1 `SensenovaConnection` 增加 `concurrency` 字段（正整数，缺省 1）；`SensenovaAdapter` 构造注入并发闸（可注入以利测试，缺省为进程内实例）
- [x] 2.2 在 `stream()` 中 `resolveApiKey` 之后、发起 `/chat/completions` 之前按 key `acquire`，并用 `try/finally` 包裹 fetch + `yield* parseOpenAiSse`，确保额度释放；401 预流轮换时先释放旧 key 额度、再为新 key 获取额度
- [x] 2.3 目录拉取 `listModels` 不接入并发闸（保持现状）
- [x] 2.4 `tests/adapter.test.ts` 增补断言：`options()` 返回 `concurrency` 时 adapter 按此上限限闸；缺省按 1

## 3. 配置字段接入（src/index.ts）

- [x] 3.1 `SensenovaConfig` 与 `Config` schema 新增 `concurrency: z.natural().min(1).default(1)`
- [x] 3.2 `resolveAdapterOptions` 解析并归一化 `concurrency`（非正整数/无法解析回退 1），进入 `ResolvedSensenovaOptions` 与 `SensenovaConnection`

## 4. 设置页领域层（src/client/settings.ts）

- [x] 4.1 `FieldName` 增加 `'concurrency'`；`SenseNovaConfig`、`SettingsState` 增加 `concurrency` / `concurrencyDraft`；staged 草稿、`edit`、`discard`、`save` 对齐 `apiBase` 模式
- [x] 4.2 新增派生字段 `effectiveActiveAccountId`：显式钉选取该 id；自动模式按「默认已配置 → default，否则第一个已配置账户 id，均无则空」解析
- [x] 4.3 保存写入 `concurrency` 时校验：非法/非正整数按 1 回退；写入语义与既有字段一致（未变更不写）

## 5. 设置页 UI（src/client/section.tsx + src/client/index.ts + src/client/locales.ts）

- [x] 5.1 `injectPageCss` 修正 `.sn-btnPrimary` 文字色为 `--dsw-alias-label-primary-foreground`（保留 fallback）
- [x] 5.2 重写 `.sn-badgeActive` 为实心高对比填充（`button-primary-fill` 底 + `label-primary-foreground` 字）；移除不存在的 `--dsw-alias-brand-primary-weak` 依赖
- [x] 5.3 `AdvancedSettings` 折叠区新增「并发上限」number 输入（`min=1`，默认 1），复用 staged 草稿链路；`advancedCustomizedCount` 计入 `concurrency !== 1`
- [x] 5.4 默认账户卡在 `effectiveActiveAccountId === 'default'` 时显示「当前」标记；账户行在 id 命中时显示「活动/当前」标记，复用 `sn-badgeActive`
- [x] 5.5 `locales.ts` 新增/调整 zh/en 文案：`concurrency`、`concurrencyHint`、`activeAutoHint`（自动生效账户说明）等，删除废弃键

## 6. 验证

- [x] 6.1 跑通 `pnpm test`（含新增并发闸测试与既有测试），`pnpm typecheck` 通过
- [x] 6.2 `pnpm build` 通过，核对构建产物 client bundle 中 TSX 类名与样式表类名一致
- [x] 6.3 对照 spec 场景逐条自查：浅/深主题主按钮文字高对比、活动/当前徽标区分、自动模式生效账户标记、并发上限字段默认 1 且可保存、429 仍不轮换不冷却
- [x] 6.4 bump `package.json` version 并确认 peerDependencies/dependencies 无变化
