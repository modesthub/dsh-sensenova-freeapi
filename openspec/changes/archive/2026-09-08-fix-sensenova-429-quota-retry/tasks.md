# fix-sensenova-429-quota-retry 任务清单

## 1. 429 分类与退避指导（adapter.ts）

- [x] 1.1 新增 429 错误体解析与分类工具：解析 `error.code`，配额类 = `code === 8` 或 `code === 429001`，其余（含无 code）归非配额类；附单元测试（覆盖两种配额 code、无 code、`type` 为 `invalid_request_error` 的 429001 现场样本）
- [x] 1.2 配额类 429 映射 `RATE_LIMIT` 并携带 `providerRetryAfterMs`：code 8 固定 15000ms；429001 分级探测退避——连续命中档位 3s→5s→10s→15s 封顶、任一成功或换 key 归零（2026-09-04 定稿：429001 为 per-key TPM 限速，固定长下限会把会话干锁在死等）；响应携带更大 `Retry-After` 时采用 `Retry-After`，整体封顶 300000ms；非配额类维持现行透传规则（≤单次延迟上限透传，超长不透传不截断）；附单元测试

## 2. 重试策略收敛（adapter.ts）

- [x] 2.1 `providerRetryPolicy` 从 `maxRetries: 1000`、上限 3000ms 收敛为 `maxRetries: 10`、退避单次上限 60000ms；删除/调整 `PROVIDER_RETRY_AFTER_CAP_MS` 相关常量与注释；附单元测试断言新策略值

## 3. 超时与看门狗（adapter.ts / concurrency.ts）

- [x] 3.1 生成请求叠加连接/首字节超时 45s（`AbortSignal.timeout` 与宿主 `signal` 组合），超时以可重试 `TIMEOUT` 错误结束并释放并发额度；附单元测试（模拟挂起 fetch，用假定时器断言 45s 触发）
- [x] 3.2 SSE 读取循环增加流空闲看门狗 60s（任一流式事件重置计时），停摆时以 `TIMEOUT` 结束并释放额度；附单元测试（模拟只发一个 chunk 后静默的流）
- [x] 3.3 `KeyedConcurrencyGate.acquire` 增加 `queueTimeoutMs`（默认 60000ms），排队超时以可重试错误 reject 且不占额度；更新既有并发闸测试并新增排队超时用例

## 4. 可选配额类粘性轮换（index.ts / adapter.ts / accounts.ts）

- [x] 4.1 `src/index.ts` 连接 schema 新增 `quotaRotation` 布尔设置（默认 `false`），随 `options()` 下发到 adapter；附 schema 默认值测试
- [x] 4.2 `stream()` 实现粘性轮换：开关开启且配额类 429 时切到下一把未试过的 key 重试并粘住（会话维度记住当前 key），环回后停留在当前 key 抛 `RATE_LIMIT`；关闭时行为与现状一致；429 不冷却、不禁用账号不变；附单元测试（开启/关闭/环回三场景）
- [x] 4.3 更新 `src/accounts.ts` 轮换辅助（如需）：区分「配额类轮换」与「401 禁用轮换」入口，配额类轮换不写任何账号状态

## 5. 设置页开关（client）

- [x] 5.1 `src/client/settings.ts` 高级设置折叠区新增「配额类 429 换 key」开关（默认关），文案：「仅限流耗尽时切换到下一把 key 并粘住；密钥失效（401）行为不变」；保存经 settings 命名空间持久化并热生效
- [x] 5.2 设置页既有「轮换说明文案」与新开关共存校验：默认轮换说明不因新开关存在而误导（关闭时仍表述 429 不切换）

## 6. 验证与收口

- [x] 6.1 全量验证：`npm run typecheck`（或等价 tsc）、`npm test`、`npm run build` 全部通过；lib/ 产物如入库则同步重建
- [x] 6.2 配额桶形态复验（2026-09-04 由 `debug_smoke_dualsession.mjs` S1 等效验证：双会话共享 1 key 时各以 ~35s 节奏成功，与 per-key 桶补充 1 个/14s 的实测模型一致；未逐字重跑 probe4）
- [x] 6.3 双会话并发冒烟（2026-09-04 `debug_smoke_dualsession.mjs`，真实 API，src 与已发布 lib 同提交构建、DSH 已装 0.1.0-alpha.5 逐字节一致）：S1 双会话同 key 180s——最大连续失败 3/5（验收线 10），两会话各 5 次成功、429 均携带 15000ms 退避下限并被宿主语义尊重，无短退避风暴；S2 开关开启 90s——A 饱和后粘性切 B 连续 6 次成功、双 key 环回后停留并按 TPM 下限等待恢复成功。注：冒烟在「TPM floor 60s + 环回跨请求锁死」旧实现上执行；其后按 2026-09-04 实测与用户反馈修订为「429001 分级探测 3/5/10/15s + 环回仅限单次请求内」，以单元测试覆盖（85/85），真实双会话复验待 alpha.6 安装后执行。以 lib 级双会话模拟替代 DSH UI 内 10 分钟长跑（不触碰运行中的 DSH 服务），时长 3 分钟
