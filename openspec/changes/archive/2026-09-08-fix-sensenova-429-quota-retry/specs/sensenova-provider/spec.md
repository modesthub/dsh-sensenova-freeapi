# sensenova-provider delta

## MODIFIED Requirements

### Requirement: 429 不冷却不轮换

系统 SHALL 在收到 429 响应时解析错误体 `error.code`，区分「配额类 429」与「非配额类 429」：配额类包括速率配额耗尽（`code` 为 `8`，message 形如 `rps exhausted`/`rpm exhausted`）与推理 TPM 耗尽（`code` 为 `429001`，message 形如 `inference tpm exhausted`）。所有 429 仍 SHALL 不做账号级冷却、不禁用账号。

默认（`quotaRotation` 关闭）时，429 SHALL NOT 切换到其他账号，一个会话固定使用一个 key。系统 SHALL 提供「配额类 429 换 key」设置开关（默认关闭，收纳于高级设置折叠区）：开启后，仅配额类 429 SHALL 触发切换到下一把可用 key 并粘住新 key（同一会话后续请求继续使用新 key），环回一圈仍被配额类 429 拒绝时 SHALL 停留在当前 key 按退避下限等待；非配额类 429 在任何设置下 SHALL NOT 触发轮换。

对配额类 429，系统 SHALL 以 `RATE_LIMIT` 错误结束本次请求，并 SHALL 携带 `providerRetryAfterMs` 作为退避指导：速率类（code 8）为固定下限 15000 毫秒；TPM 类（code 429001）采用分级探测退避，档位 SHALL 随该会话连续命中次数递增为 3000 → 5000 → 10000 → 15000 毫秒后封顶，任一请求成功或切换到新 key 后 SHALL 归零重新从 3000 毫秒开始（2026-09-04 实测：429001 为 per-key 推理 token 限速，恢复时间不定，固定长下限会把会话干锁在死等；短档位递增探测 + 优先换 key 才能在恢复第一时间接上）。当响应携带 `Retry-After` 且换算毫秒值大于当前档位时，SHALL 采用 `Retry-After` 值，且采用值整体 SHALL NOT 超过 300000 毫秒（超出时按 300000 毫秒采用）。对非配额类 429（无 `error.code` 或其他 code），系统 SHALL 维持既有行为：`Retry-After` 在大于 0 且不超过重试策略单次延迟上限（见「Provider 重试策略」）时透传，否则不透传也不截断，由宿主本地退避策略计算。

#### Scenario: 429 不轮换不冷却

- **WHEN** 某账号请求收到 429 且存在其他可用账号，「配额类 429 换 key」开关处于关闭状态
- **THEN** 系统不标记冷却、不切换账号，以 `RATE_LIMIT` 错误结束本次请求由宿主重试层退避后用原 key 重试

#### Scenario: 开启轮换后配额类 429 粘性换 key

- **WHEN** 「配额类 429 换 key」开关开启，某会话的请求收到配额类 429（code 8 或 429001）且存在未在本次请求中试过的其他可用账号
- **THEN** 系统切换到下一把可用 key 重试本次请求，且该会话后续请求继续使用新 key，直至新 key 也收到配额类 429 再依序切换

#### Scenario: 轮换环回后停止切换

- **WHEN** 开关开启且本轮请求已按序试过所有可用账号均被配额类 429 拒绝
- **THEN** 系统停留在当前 key，按退避下限等待后重试，不再重复切换，也不禁用任何账号

#### Scenario: 速率配额耗尽给出分钟级退避下限

- **WHEN** 某账号请求收到 429 且错误体为 `{"error":{"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}}`（响应无 `Retry-After` 头）
- **THEN** 系统不标记冷却、不切换账号，以 `RATE_LIMIT` 错误结束本次请求，且错误携带 `providerRetryAfterMs` 不低于 15000 毫秒

#### Scenario: TPM 耗尽给出分级探测退避

- **WHEN** 某账号请求收到 429 且错误体包含 `error.code` 为 `429001`（inference tpm exhausted），且该会话此前已连续命中 n 次
- **THEN** 系统以 `RATE_LIMIT` 错误结束本次请求且不轮换账号，错误携带 `providerRetryAfterMs` 为分级档位第 min(n+1, 4) 档（3000/5000/10000/15000 毫秒）

#### Scenario: TPM 分级档位成功后归零

- **WHEN** 某会话经历 429001 分级退避后任一请求成功
- **THEN** 该会话的连续命中计数归零，下一次 429001 退避从 3000 毫秒重新开始

#### Scenario: 短 Retry-After 透传

- **WHEN** 非配额类 429 响应携带 `Retry-After` 且换算毫秒值大于 0 且不超过重试策略单次延迟上限
- **THEN** 系统将该值作为 `providerRetryAfterMs` 透传给宿主重试层

#### Scenario: 超长 Retry-After 不突破上限

- **WHEN** 非配额类 429 响应的 `Retry-After` 超过重试策略单次延迟上限
- **THEN** 系统不透传该值（不截断），由宿主本地退避策略计算延迟

#### Scenario: 配额类 429 不因多会话共享而互踢

- **WHEN** 两个会话使用同一 key 且先后收到配额类 429，轮换开关关闭
- **THEN** 两个会话各自按退避下限等待后用原 key 重试，系统不因 429 禁用任一账号

### Requirement: Provider 重试策略

系统 SHALL 为 `sensenova` 路由声明 `normal` 重试策略：最大重试次数 SHALL 为有限值且默认不超过 10 次；本地指数退避单次延迟上限 SHALL 不低于 60000 毫秒且不超过 300000 毫秒（60000 毫秒 ≤ 上限 ≤ 300000 毫秒）。收到配额类 429（见「429 不冷却不轮换」）后的下一次重试延迟 SHALL 不低于该错误携带的 `providerRetryAfterMs`（TPM 类为该会话当前分级探测档位，code 8 为 15000 毫秒）。对非配额类 429，服务端提供的 `Retry-After` 超过单次延迟上限时 SHALL NOT 作为 provider 延迟透传，也不得截断后透传，改由本地策略计算；配额类的 `Retry-After` 采用规则见「429 不冷却不轮换」。429 不产生账号冷却。

#### Scenario: 持续限流时重试预算有限

- **WHEN** 请求连续收到配额类 429 且每次退避后重试仍失败
- **THEN** 宿主在不超过声明上限的有限重试次数内停止，向会话暴露明确的 `RATE_LIMIT` 失败，而不是以 3 秒级短退避持续重试上千次

#### Scenario: 配额类退避下限被遵守

- **WHEN** 某次配额类 429 携带 `providerRetryAfterMs` 10000 毫秒（TPM 分级第 3 档）
- **THEN** 下一次重试的实际延迟不低于 10000 毫秒，本地指数退避在达到单次延迟上限后不再增长

#### Scenario: 限流时按策略重试

- **WHEN** 请求收到 429 限流响应且未提供超过单次延迟上限的 `Retry-After`
- **THEN** 宿主按该路由声明的策略重试，重试次数不超过声明的有限上限；配额类 429 的下一次重试延迟不低于其 `providerRetryAfterMs`

#### Scenario: 本地退避延迟封顶

- **WHEN** 本地退避延迟按指数增长
- **THEN** 单次重试延迟在达到声明的单次延迟上限后 SHALL NOT 继续增长，即使 jitter 生效也不得超过该上限

#### Scenario: 超长 Retry-After 不突破上限

- **WHEN** 非配额类 429 响应的 `Retry-After` 超过声明的单次延迟上限
- **THEN** 插件不向宿主透传该超长 `providerRetryAfterMs`，宿主使用本地退避策略继续重试，单次延迟不超过声明的上限

## ADDED Requirements

### Requirement: 生成请求超时与看门狗

系统 SHALL 为发往 `{apiBase}/chat/completions` 的生成请求提供超时保护：请求建立到收到首个响应字节 SHALL 受连接超时约束（默认 45000 毫秒量级）；SSE 流读取 SHALL 受空闲看门狗约束（默认 60000 毫秒量级，收到任一流式事件即重置）；并发闸排队等待 SHALL 受排队超时约束（默认 60000 毫秒量级）。任一超时触发时，系统 SHALL 释放该请求持有的并发额度，并以可重试的 `TIMEOUT` 错误交宿主重试层处理，不得让请求无限挂起或长期占用并发额度。

#### Scenario: 传输挂起不长期占用额度

- **WHEN** 生成请求发出后服务端长时间不返回首字节且超过连接超时
- **THEN** 系统以 `TIMEOUT` 错误结束本次请求并释放其并发闸额度，宿主可按重试策略重试

#### Scenario: 流中途停摆被看门狗回收

- **WHEN** SSE 流已开始输出后超过空闲看门狗时长未收到任何新事件
- **THEN** 系统以 `TIMEOUT` 错误结束本次生成并释放并发额度，不继续无限等待

#### Scenario: 排队超时交还宿主重试层

- **WHEN** 请求在并发闸队列中等待超过排队超时时长仍未获得额度
- **THEN** 系统以可重试错误结束排队等待（不占额度），由宿主重试层按退避策略再次发起
