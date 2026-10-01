## 1. 样式层修复（src/client/index.ts）

- [x] 1.1 补齐缺失类定义：`sn-accountRow`、`sn-accountFields`（或按新结构废弃）、`sn-accountKeyRow`、`sn-btnPrimary`、`sn-badgeActive`、`sn-textarea`、`sn-models`
- [x] 1.2 清理死样式 `sn-account`、`sn-row`、`sn-btn`；核对 TSX 与样式表类名一一对应
- [x] 1.3 `sn-reset` 改为无边框文本按钮样式（12px、secondary 色、hover 变 primary、disabled 半透明），并核对 `card.tsx` 的按钮不受误伤
- [x] 1.4 徽标类（`sn-badge`/`sn-badgeMuted`/`sn-badgeActive`）加 `white-space: nowrap`；标签类加 `min-width: 0`
- [x] 1.5 颜色切换宿主 `--dsw-alias-*` 设计令牌（border-l2、bg-layer-1/3、label-primary/secondary/tertiary、brand-primary、label-error），全部保留现有硬编码 fallback
- [x] 1.6 新增 `select.sn-input` 自绘 chevron 样式（appearance:none + SVG 背景）与高级设置折叠头/chevron 样式

## 2. 设置页布局重写（src/client/section.tsx）

- [x] 2.1 重写 `AccountRow` 为单列堆叠：行头（备注名标签 + 徽标 + 文本动作按钮）+ 全宽备注名输入 + 全宽密钥输入 + 提示；移除凭据引用名展示；账户之间 hairline 分隔
- [x] 2.2 活动账户从 radio 列表 + 行内「设为活动账户」改为 `<select>`（自动 + 已保存账户，排除未保存新增行）+ 重置文本按钮；「活动」徽标保留在行头
- [x] 2.3 移除默认账户卡的「默认凭据引用」编辑字段，仅保留默认账户密钥字段
- [x] 2.4 新增「高级设置」折叠卡：收纳 API 地址、手动加入模型、隐藏模型；默认折叠、`aria-expanded`/`aria-controls`、chevron、已自定义项数徽标（按值 ≠ 默认计数）
- [x] 2.5 修复 `useSavedFlash`：改 `useEffect` + 2500ms 定时复位，替换 render-phase setState 且永不复位的实现

## 3. 文案修正（src/client/locales.ts）

- [x] 3.1 修正 zh/en `accountsHint`：密钥失效（401）时自动切换；429 限流不切换账户、由宿主重试层退避后原 key 重试
- [x] 3.2 删除 `apiKeyEnv`、`accountKeyEnv` 相关键；新增高级设置折叠、活动账户下拉、重置等新增 UI 的 zh/en 文案键

## 4. 验证

- [x] 4.1 同步调整 `tests/` 中涉及设置页文案与 UI 行为的断言，跑通全部测试
- [x] 4.2 `pnpm typecheck` 与 `pnpm build` 通过；核对构建产物 client bundle 中 TSX 类名与样式表类名一致
- [x] 4.3 对照 specs 场景逐条自查：窄窗口下账户行按钮文字不换行、凭据引用名不出现在页面任何位置、下拉与折叠行为、保存反馈 2.5 秒消失
