import z from "@deepseek-ai/schemastery";
import { GenerateOptions, LlmAdapter, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
//#region src/concurrency.d.ts
/**
 * 每 API key 的并发闸（host 侧，无依赖）。
 *
 * SenseNova 渠道对 API key 存在并发限制，瞬时并发超限会触发 429。本模块在
 * provider 侧把同一 key 的并发生成请求压到配置上限内：达到上限的新请求排队
 * 等待（FIFO），前序请求释放额度后按序开始，而不是立即失败。429 语义不变，
 * 仍由宿主重试层退避后原 key 重试，此闸只是从源头抑制并发超限。
 *
 * 队列与在途计数均以 key 为键；key 条目在排空后惰性删除。排队等待受
 * `queueTimeoutMs`（默认 60s，2026-09-04 实测排队挂起需有界，见
 * fix-sensenova-429-quota-retry design D4）约束：超时以可重试 TimeoutError
 * reject 且不占额度，交宿主重试层退避后重试。本模块刻意不依赖 cordis，
 * node 测试可直接驱动。
 *
 * @module dsh-sensenova-freeapi/concurrency
 */
type Release = () => void;
/**
 * 按 key 隔离的并发闸：`acquire(key, limit, signal?, queueTimeoutMs?)` 在额度
 * 允许时立即返回 `release()`；达到上限时按 FIFO 排队，前序释放后唤起队首。
 * 排队期间 signal 中止则 reject 取消错误且不占额度；排队超过 `queueTimeoutMs`
 * （非法值回退默认 60s）则以可重试 TimeoutError reject，同样不占额度、从队列
 * 移除并清 abort listener。release 幂等，排空后惰性删除 key 条目。
 */
declare class KeyedConcurrencyGate {
  private readonly states;
  acquire(key: string, limit: unknown, signal?: AbortSignal, queueTimeoutMs?: number): Promise<Release>;
  /**
   * **非阻塞**获取额度：有额度立即返回 `release`，否则返回 `undefined`（**不排队**）。
   *
   * 2026-09-27 新增，专供「阻塞态 key 的恢复探测」使用：
   *   - 探测必须避开该 key 上正在飞行的 agent 请求 —— 否则探测拿到的 429 可能来自
   *     agent 请求造成的瞬时压力，而非该 key 的真实配额状态，结论不可信；
   *   - 排队等待又毫无意义 —— 拿不到额度就跳过这一轮，等下次 tick 再来。
   * 复用同一份 `inFlight` 计数即天然满足该约束，比另建一套探测专用计数更可靠。
   */
  tryAcquire(key: string, limit: unknown): Release | undefined;
  private releaseOf;
}
//#endregion
//#region src/error-log.d.ts
/**
 * 一条限流事件。字符串字段一律存在（未知写空串），便于 `jq` 直接按字段过滤。
 */
interface SenseNovaRateLimitEvent {
  /** ISO 8601 时间戳。 */
  ts: string;
  /** 请求的模型 id。 */
  model: string;
  /** HTTP 状态码。 */
  status: number;
  /** 原始 `error.code`（数字转字符串；缺失或非 JSON 体为空串）。**这是排查的主键。** */
  code: string;
  /**
   * `classify429Body` 的子类。
   *
   * - `'rate'` —— code 8 速率桶（固定 15s 下限）
   * - `'rpm'` —— 请求数限流（`…EndpointRPMExceeded` 一族，独立档位、上限 30s；2026-09-24 新增）
   * - `'tpm'` —— token 限流（分钟级窗口，分级探测 3s~120s）
   * - `''` —— 未分类
   *
   * 🔴 `'rpm'` 与 `'tpm'` **必须分开看**：两者恢复窗口差一个量级，
   * 混在一起统计会把"秒级窗口被强等 2 分钟"的浪费掩盖掉。
   */
  kind: string;
  /** 是否被判为「可轮换的限流」。 */
  quota: boolean;
  /** `code=…, message…` 摘要（≤{@link ERROR_LOG_MESSAGE_MAX_CHARS} 字符）。 */
  message: string;
  /** 分类给出的退避下限（动态档位优先）。 */
  retryFloorMs?: number;
  /** 网关 `Retry-After` 头解析出的毫秒值。 */
  retryAfterHeaderMs?: number;
  /** 最终抛给宿主的退避（含单向上抖）；轮换路径（不抛出）时缺省。 */
  providerRetryAfterMs?: number;
  /**
   * 本次是否触发了 key 轮换。
   *
   * ⚠️ v0.2.8：与 {@link quotaRotation} 对照看 —— `rotated: false` 且
   * `quotaRotation: false` 表示**轮换被功能开关关掉了**（配置丢失的典型现场）；
   * 两者都是 true 却仍不换，才是池里没有可换的 key。
   */
  rotated: boolean;
  /**
   * 本次请求时「配额类 429 换 key」开关的生效值（v0.2.8 新增）。
   *
   * 🔴 2026-10-27 实测加此项：配置丢失导致该开关静默降级为 false 时，
   * 旧日志里 `poolRunning/poolBlocked` 整列为空、`rotated` 恒为 false，
   * 现场「80 个账户却一直卡在 Default」缺少可直接判读的证据。
   */
  quotaRotation?: boolean;
  /** 本轮 `stream()` 内第几个 internal attempt（1 起）。 */
  attempt: number;
  /** key 指纹（sha256 前 8 位），**不是 key 原文**。 */
  account: string;
  /** sessionId 指纹（无 sessionId 时为空串）。 */
  session: string;
  /**
   * 本次请求所处的探测档位索引（0 起）。仅 `kind` 为 `'tpm'` / `'rpm'` 时写入。
   *
   * 🔴 2026-09-24 新增：`retryFloorMs` 只能看出"等多久"，看不出**档位是否已经锁死**。
   * 同日的故障正是"该值长期停在 6（=120s）且期间零成功" —— 有它才能一眼分辨
   * 「正常高档等待」与「档位锁死」。
   */
  probeHits?: number;
  /**
   * 本 key 是否因本次命中被**踢出运行态**（2026-09-27 新增，取代已移除的 `saturated`）。
   *
   * 只有 `kind === 'tpm'` 且达到「连续命中阈值」时才可能为 true —— rpm / rate 类
   * 只记不踢（秒级桶自愈快，踢掉只会白白损失该 key 的 prompt cache 命中率）。
   */
  kicked?: boolean;
  /** 事件产生时 key 池的**运行态**把数（2026-09-27 新增，池侧诊断）。 */
  poolRunning?: number;
  /** 事件产生时 key 池的**阻塞态**把数（2026-09-27 新增，池侧诊断）。 */
  poolBlocked?: number;
  /**
   * 可读的**账户名**（如「账户 2」，2026-09-27 新增）。
   *
   * 与 `account`（sha256 指纹）互补：指纹用于去重与跨会话关联，这个名字用于人读。
   * 它是用户在设置页填的 label，**不含 key 原文**。
   */
  accountLabel?: string;
  /**
   * 该 key 的 **credential-ref 名**（如 `SENSENOVA_API_KEY_2`，2026-09-27 新增）。
   *
   * ⚠️ 它是**环境变量名、不是密钥值**，因此可以安全写入日志 —— 本文件「绝不落 key 原文」
   * 的约定（见 `tests/error-log.test.ts` 的脱敏断言）依然成立。
   */
  accountRef?: string;
  /**
   * 事件阶段（v0.5 新增）：`request`（首次请求）/ `retry`（插件内原地等待后重试）/
   * `rotate`（换 key 后重试）/ `stream`（流式接收）/ `probe`（探针）。限流事件里
   * 该字段标 `request|retry|rotate` 之一；成功事件的 `stream` 表示流收完。
   */
  phase?: string;
  /**
   * 结果（v0.5 新增）：`ok`（成功）/ `error`（失败）/ `interrupted`（被中止）。
   * 旧限流事件省略该字段（隐含 error）。
   */
  result?: string;
  /** 单次上游往返耗时（毫秒，v0.5 新增）。 */
  latencyMs?: number;
  /** 命中的「单位请求组」索引（0 起，v0.5 P1 组粒度新增；落地前恒缺省）。 */
  groupIndex?: number;
  /** 本次实际应用的组间延时（毫秒，v0.5 P1 AIMD 组间隙新增）。 */
  groupGapMs?: number;
  /** 调度模式（`'fixed'` / `'adaptive'`）。未配置组调度时缺省。 */
  schedMode?: string;
  /** 固定模式下**配置的**组内 key 间等待（毫秒），不是实际睡眠时长。 */
  schedKeyGapMs?: number;
  /** 固定模式下**配置的**组间定时（毫秒）= 每组最低占用时长。 */
  schedGroupGapMs?: number;
  /**
   * 本次 attempt **实际**等待了多少毫秒（组内 keyGap 或组间补时）。
   *
   * 与 `schedKeyGapMs` 对照：配置 1000 而实际 998 属正常抖动；实际恒为 0 说明
   * 根本没走到等待分支（例如首把就成功，或走了别的分支）。
   */
  schedWaitMs?: number;
  /** 本次是该组内的第几把 key（1 起）。用于验证「组内 1→2→3→4 顺序」。 */
  schedStep?: number;
  /** 组循环轮次（1 起；2026-11-02 新增）。全组耗尽后进第 2 轮，两轮全败才抛宿主。 */
  schedRound?: number;
  /** 视觉调用模式：`'bridge'`（拖图自动识别）/ `'tool'`（主模型调用视觉工具）/ `'chat'`（纯文本工具）。 */
  visionMode?: string;
  /** 视觉调用的具体任务（`image_reasoning` / `image_reasoning_multi` / `chat` / `bridge`）。 */
  visionTask?: string;
  /**
   * 测试期诊断字段：错误体原文尾部（≤500 字符），供观察商汤真实返回结构；
   * P3 收敛时删除。**绝不含 key 原文**（错误体不落密钥的假设由 upstream 保证，若
   * 违反会在这里暴露——这正是它存在的意义）。
   */
  _rawBodyTail?: string;
}
/**
 * 限流事件记录器。
 *
 * 写入是**串行异步**的：`record()` 同步返回、内部排队落盘，调用方永远不 await
 * ⇒ 请求热路径不受磁盘影响。任何写失败都被吞掉，连续失败
 * {@link ERROR_LOG_MAX_CONSECUTIVE_FAILURES} 次后自动停用。
 *
 * ```ts
 * const log = new SenseNovaErrorLog();
 * log.record({ ... });        // 立即返回
 * await log.flush();          // 仅测试/优雅退出需要
 * ```
 */
declare class SenseNovaErrorLog {
  private readonly filePath;
  private readonly maxBytes;
  /** 串行链：保证 append 顺序，并把失败挡在链外继续工作。 */
  private chain;
  /** 已写入字节数；-1 = 尚未探测（首次写入时 stat 一次）。 */
  private bytes;
  private failures;
  constructor(options?: {
    filePath?: string;
    maxBytes?: number;
  });
  /** 当前日志文件绝对路径（诊断用）。 */
  get path(): string;
  /**
   * 记录一条事件。**同步返回，从不抛出**；写失败静默（连续失败后停用）。
   * @param event - 事件体。
   */
  record(event: SenseNovaRateLimitEvent): void;
  /** 等待在途写入结束（测试与优雅退出用）。 */
  flush(): Promise<void>;
  private append;
}
//#endregion
//#region src/group-pool.d.ts
/** 组粒度调度配置（v0.5 §5 参数映射表的插件侧副本）。 */
interface GroupSchedulingConfig {
  /** 总开关（默认 true；false 时组调度整体退化为原 key 池路径）。 */
  enabled?: boolean;
  /** 组退避底数（毫秒），默认 90_000（st-rotator cooldown baseTime=90s）。 */
  cooldownBaseMs?: number;
  /** 组退避指数，默认 2（st-rotator cooldown factor=2）。 */
  cooldownFactor?: number;
  /** 组退避上限（毫秒），默认 300_000（st-rotator cooldown maxTime=300s）。 */
  cooldownMaxMs?: number;
  /** 退避抖动比例，默认 0.5（`× (1 + U(0, jitter))`）。 */
  cooldownJitter?: number;
  /** AIMD 组间隙初始值（毫秒），默认 2_000。 */
  initialGroupGapMs?: number;
  /** AIMD 组间隙下限（毫秒），默认 500。 */
  groupGapMinMs?: number;
  /** AIMD 组间隙上限（毫秒），默认 30_000。 */
  groupGapMaxMs?: number;
  /** 撞 429 时组间隙的乘性放大，默认 1.5。 */
  groupGapMultiplier?: number;
  /** 无 429 恢复窗口内组间隙的乘性衰减，默认 0.95。 */
  groupGapRecoverFactor?: number;
  /** 「连续无 429」判定窗口（毫秒），默认 8_000。 */
  recoverWindowMs?: number;
  /** 全池冷却时的快返 Retry-After（毫秒），默认 8_000（acquire_fail_fast=8 秒）。 */
  failFastMs?: number;
  /**
   * 调度模式：
   * - `'adaptive'`（旧）：AIMD 组间隙，撞 429 就 ×1.5 放大。
   * - `'fixed'`（2026-11-01 新增，默认）：用固定的 `groupGapMs` 做「组间定时」，
   *   不再自适应。理由：AIMD 在「快拒零成本」的场景下会误判——它把网关层的
   *   瞬间拒绝当成「需要降速」的信号，结果越撞越慢，而真正该做的是换把 key 再试。
   */
  mode?: 'adaptive' | 'fixed';
  /**
   * 「组间定时」（毫秒），默认 20_000。
   *
   * 语义：一轮组使用（从组内第一次发请求，到最后一次响应结束）至少占用这么久。
   * 不足则记 `nextAvailableAt = usedStartedAt + groupGapMs`，该组在此期间不参与轮换。
   * 目的：4 组轮一圈时，每个账户两次使用之间至少隔 `groupGapMs × (组数−1)`。
   */
  groupGapMs?: number;
  /**
   * 「key 间定时」（毫秒），默认 1_000。
   *
   * 语义：组内一把 key 返回 429 后，等这么久再发下一把。
   * 目的：给刚撞墙的 key 一点喘息，同时控制单组的消耗速度。
   */
  keyGapMs?: number;
  /**
   * 429 轮次预算（2026-11-03）：走完几轮完整遍历仍全部 429 ⇒ 抛宿主。
   *
   * 语义：一轮 = max(各账户组数) 个宏观周期；每轮里每个账户按游标各走一步，
   * 组间按 groupGapMs 让位。默认 2（4 账户 × 5 组 = 2 × 20 = 40 个宏观周期、
   * 160 次尝试后抛宿主）。调大 = 在插件内多扛几轮、少让宿主退避；调小 = 更快
   * 把 429 交给宿主。只影响 fixed 模式。
   */
  roundBudget?: number;
  /**
   * 分组形状（2026-11-02），默认 `'by-account'`。
   *
   * - `'by-account'`：一组 = 一个账户的全部 key（组内换 key 是同账户换凭据）。
   *   实测（11-02 晨 22min）：每 key 压力更均匀（18-25 步），但同账户限流状态
   *   共享 ⇒ 组内 2/3/4 把命中率低，1.07 次成功/分钟。
   * - `'by-slot'`：组 i = 每个账户的第 i 把（组内换 key 即换账户）。
   *   实测（同日 33min）：每步都在试探不同账户的恢复，1.55 次成功/分钟，
   *   但单账户两次使用没有时间保底。
   * 切换即时生效（seed 幂等，下次请求重建组）。
   */
  grouping?: 'by-account' | 'by-slot';
  /**
   * 每账户的组切分计划（设置页「账户与分组」写的 scheduling.groups）。
   *
   * 例：{ account: 1, sizes: [4,4,4,4,4] } ⇒ 账户 1 的 20 把切成 5 组、每组 4 把；
   * gaps 长度 = sizes+1，表示每组前面/末尾有几个孤立 key（不进轮换）。
   *
   * 🔴 2026-11-03 修复：此前这个字段只存在于 schemastery schema，normalizeGroupScheduling
   * 不认识它 ⇒ 解析时被丢掉，seedGroups 永远读不到计划、回落「每个账户一组」，
   * 现场表现就是「界面明明分了 4 把一组，实际却按整账户 20 把连发」。
   */
  groups?: {
    account: number;
    sizes: number[];
    gaps?: number[];
  }[];
}
/** resolved 配置（缺省值全部补齐）。 */
type ResolvedGroupScheduling = Required<GroupSchedulingConfig>;
/** 单个组的运行时状态。 */
interface KeyGroup {
  index: number;
  keys: readonly string[];
  /** 所属账户 id（`account-1` 之类）；空串表示未标注（旧 seed 形态，每组合成一个账户）。 */
  account: string;
  /** 在该账户内的组序号（0 起）：第 r 次轮到该账户时用 `ordinal = 游标 % 组数`。 */
  ordinal: number;
  /** 组冷却截止（epoch ms）；0 表示未在冷却。整组退避用。 */
  cooldownUntil: number;
  /** 组内累计 429 次数（成功清零，退避公式的 n）。 */
  strikes: number;
  /** 在途（pending）请求数：>0 时该组即使冷却也算可用（pending_cooldown 语义）。 */
  pending: number;
  /** 组内游标：并发请求在组内轮转着拿不同 key（每账户一把）。 */
  lastKeyIndex: number;
  /** 账户级联动：accountId → 该账户在组内的冷却截止。 */
  accountCooldown: Map<string, number>;
  /**
   * 本组「本轮使用」的起始时刻（epoch ms）：组内第一次发请求时写入。
   * 用于计算「组间定时」——从首次发请求到最后一次响应结束的耗时。
   * 0 表示本组当前没有进行中的一轮。
   */
  usedStartedAt: number;
  /**
   * 本组下次可被使用的时刻（epoch ms）。
   *
   * 2026-11-01 新增（固定间隔调度）：一轮结束后置为
   * `max(now, usedStartedAt + groupGapMs)`。这样即使一轮只花 3 秒，
   * 该组也要等满 groupGapMs 才重新参与轮换，从而让「× (组数-1)」的
   * 冷却时间真正落在别的组身上。
   *
   * 与 `cooldownUntil` 的区别：`cooldownUntil` 是「因为在限流而被迫退避」，
   * 这个是「因为配额分摊而主动让位」。两者取 max 生效。
   */
  nextAvailableAt: number;
}
/** snapshot(): 对外只读快照的组列表。 */
interface KeyGroupSnapshot extends KeyGroup {}
/** watchKey 的返回：adapter 判定全池冷却/日志 groupIndex 用。 */
interface KeyGroupInfo {
  groupIndex: number;
  /** 本组可并发额度 = 组内 key 数（每账户一把 ⇒ 即账户数 A）。 */
  capacity: number;
  allCooled: boolean;
}
/** reportRateLimit 的返回：调用方（adapter/index）用于日志与轮换。 */
interface GroupRateLimitReport {
  groupIndex: number;
  cooldownUntil: number;
  strikes: number;
}
/** reportRateLimit 的输入上下文（adapter 上报分类时并不知道账户归属，由 index 接线补全）。 */
interface GroupRateLimitInput {
  /** 触发 429 的 key 原文。 */
  key: string;
  kind: 'tpm' | 'rpm' | 'rate' | 'quota_exhausted';
}
/** seed() 的组描述：显式给出账户与组号（新增形态）。 */
interface SeedGroup {
  /** 组内 key 列表（顺序即组内轮换顺序）。 */
  keys: readonly string[];
  /** 所属账户 id。 */
  account: string;
  /** 该账户内的组序号（0 起，连续）。 */
  ordinal: number;
}
interface SensenovaGroupPoolDeps {
  /** 每操作读一次配置（改配置即生效，无需重建池）。 */
  config: () => GroupSchedulingConfig | undefined;
  /** 可注入时钟（测试用）；缺省 Date.now。 */
  now?: () => number;
  /** 可注入随机源（测试用）；缺省 Math.random。 */
  random?: () => number;
}
/**
 * 组池：组游标轮换 + 账号级联动冷却 + 全池冷却判定。
 *
 * 线程模型：所有方法同步（除 seed 的幂等建组）；并发安全由调用方保证
 * （host 侧所有请求都过 Cordis 事件循环，天然串行）。
 */
declare class SensenovaGroupPool {
  #private;
  private readonly cfg;
  private readonly now;
  private readonly random;
  private groups;
  /** key → 组索引。 */
  private readonly keyToGroup;
  /** key → 账户 id（联动冷却：同一账户的所有 key 所在组一起冷却）。 */
  private readonly keyToAccount;
  /** 账户 id → 该账户全部 key。 */
  private readonly accountKeys;
  /**
   * 账户轮转序（宏观序列，永不跳过、永不换序）。
   *
   * 2026-11-02 改：原先是「全局组游标」，序列由组的排列顺序决定；现在宏观单位是
   * **账户**，组只是账户被轮到时才决定的「微观」选择。于是：
   *   - `accountOrder` 是账户的固定循环序；
   *   - `accountCursor` 指向**下一个**要轮到的账户；
   *   - `groupCursor` 是每个账户**各自**的组游标，轮到它并被真正用到时才 +1。
   *
   * 这样 4 账户 × 1 组 ⇒ 1→2→3→4（与改造前一致）；1 账户 × 3 组 ⇒ 1→1′→1″；
   * 3 账户 3/1/2 组 ⇒ 1→2→3→1′→2→3′→1″…（只有 1 组的账户每轮都用同一组，不跳过）。
   */
  private accountOrder;
  /** 下一个要轮到的账户在 accountOrder 中的下标。 */
  private accountCursor;
  /** 账户 → 该账户「下一次该用第几组」（对组数取模）。 */
  private readonly groupCursor;
  /** 账户 → 该账户的组下标列表（按 ordinal 升序）。 */
  private readonly ordinalsByAccount;
  constructor(deps: SensenovaGroupPoolDeps);
  /** 当前生效配置的只读视图（供外部同源读取 gap 初值等）。 */
  get config(): ResolvedGroupScheduling;
  /**
   * 建组并登记 key→组/账户映射（幂等：已在的组只更新 keys）。
   *
   * @param groups - 组内 key 列表（每组合计 A 把，即组容量）。
   * @param accountOf - key → 账户 id；同一账户的 key 分属不同组时，联动冷却会把
   *   它们各自所在的组**全部**冷却（账号级联动的实现基础）。
   */
  seed(groups: readonly (readonly string[] | SeedGroup)[], accountOf?: (key: string) => string | undefined): string[];
  /** 组数。 */
  get size(): number;
  /** 当前宏观轮转指向的账户（下一次轮到谁）。 */
  nextAccount(): string | undefined;
  /** 账户轮转序只读副本（日志 / 测试用）。 */
  get accounts(): readonly string[];
  /** 各账户组数的最大值：一轮 = 该值个宏观周期（走遍全部组算 1 轮）。 */
  maxGroupCount(): number;
  /** 某账户当前该用的组下标（不推进游标）。 */
  currentGroupOf(account: string): number | undefined;
  /**
   * 走一步宏观轮转（2026-11-02）：**宏观单位是账户，不是组**。
   *
   * 序列：账户按 accountOrder 固定循环，永不跳过、永不换序；微观：轮到某账户时
   * 用它的「当前组」= groupCursor[account] % 该账户组数。
   *
   * 该账户当前组此刻不可用（冷却 / 组间定时窗口 / 组内 key 全被 exclude 或账户级冷却）时，
   * 只让出这一次轮到的机会，**不推进它的组游标**，继续看下一个账户 —— 账户始终留在轮转序里，
   * 同账户的最短间隔（A−1 步）不被压缩；转满一圈仍无可用 ⇒ undefined（调用方等待或 fail-fast）。
   *
   * 组游标只在「这一组真的给出了 key」时前进，保证每组每轮只被用一次。
   */
  step(exclude?: ReadonlySet<string>): {
    groupIndex: number;
    key: string;
  } | undefined;
  /** 请求入口取 key（走一步轮转）。 */
  pickStart(exclude?: ReadonlySet<string>): string | undefined;
  /** 429 后换一组再试（同一步轮转，天然落到下一个账户）。 */
  pickNext(exclude?: ReadonlySet<string>): string | undefined;
  /** 429 后换组：同时给出组号与 key（adapter 固定间隔路径用）。 */
  pickNextSlot(exclude?: ReadonlySet<string>): {
    groupIndex: number;
    key: string;
  } | undefined;
  /**
   * 组内按 **keys 数组顺序**（即 slot 1→2→3→4）取第一把可用的 key。
   *
   * 与 `pickStart` 的「从 lastKeyIndex 轮转」不同：这里是从头顺序遍历，
   * 但会把**最后试到的下标**写回 `lastKeyIndex`。这样本组耗尽后，下一次
   * `pickStart`/`step` 从下一把起手又正好回到 slot 1，不会在第二轮把
   * 入口顺序变成 2→1→3→4。语义是「一轮之内按编号逐个试，下一轮仍从 1 开始」。
   *
   * @param groupIndex 组下标
   * @param exclude 本轮已试过的 key（不会被再次返回）
   * @returns undefined = 本组在本轮已无可用 key
   */
  pickWithinGroup(groupIndex: number, exclude?: ReadonlySet<string>): string | undefined;
  /** 开始一轮组使用：记录起始时刻（已有进行中的一轮则不覆盖）。 */
  beginGroup(groupIndex: number): void;
  /**
   * 结束一轮组使用：置 `nextAvailableAt = max(now, usedStartedAt + gapMs)`。
   *
   * 这就是「组间定时」的实现 —— 一轮只花了 3 秒也要补到 gapMs，
   * 从而保证「轮回到本组」时已经过了 gapMs ×（组数−1）。
   *
   * @returns 实际补齐后的下次可用时刻
   */
  finishGroup(groupIndex: number, gapMs: number): number;
  /**
   * 按账户轮转序「窥视」下一个可用组（不推进任何游标）。
   *
   * 用于日志 / 诊断：真正取 key 走 step()（会推进游标）。
   *
   * @returns 组下标；undefined = 所有组都还没到点
   */
  pickAvailableGroup(now?: number): number | undefined;
  /**
   * 距离「最早有一组可用」还要多久（毫秒）。
   *
   * 用于把所有组都试完后给宿主一个准确的 pra —— 不再拍脑袋固定 20s，
   * 而是「最早那个组的 nextAvailableAt 减现在」。
   */
  earliestAvailableIn(now?: number): number;
  /**
   * 查询某 key 的组上下文（adapter 日志与全池冷却快返判定用）。
   *
   * @returns undefined=该 key 不属任何组（配置关闭或未 seed）⇒ 调用方走原 keyPool 路径。
   */
  watchKey(key: string): KeyGroupInfo | undefined;
  /**
   * 上报一次限流（组粒度，双层退避）：
   *   1. **本组整组冷却**（组内 all keys 一并冷却，strikes 按组累计，时长走组退避公式）；
   *   2. **账户级联动**：该账户分在其他组的 key 被标记账户级冷却（时长取组退避第一档，
   *      不再按他们各自的组 strikes 重复翻倍）——防止「换组后同一账户再撞 429」空转。
   * 返回本次命中的组信息（供 adapter/index 日志与轮换）。
   */
  reportRateLimit(input: GroupRateLimitInput): GroupRateLimitReport;
  /** 在途请求计数（pending_cooldown：在途请求会造成瞬时压力，不应在它还在飞时判冷却）。 */
  markPending(key: string, delta: 1 | -1): void;
  /**
   * 成功是池已恢复的最强证据：清除本组整组冷却与连击，并**对称地**清除该账户
   * 在所有组的账户级冷却（该账户能打出成功 ⇒ 账户已恢复，兄弟组里对它的标记一并撤销）。
   */
  onSuccess(key: string): void;
  /** 401 永久移除：从组内摘除该 key（组仍保留其余 key）。 */
  remove(key: string): void;
  /** 只读快照（日志/测试）。 */
  groupsSnapshot(): KeyGroupSnapshot[];
  /** key → 组索引（供 adapter 构造 gate 键等）。 */
  groupIndexOf(key: string): number | undefined;
  /** 是否启用组调度（外部 read 用）。 */
  enabled(): boolean;
}
/**
 * AIMD 组间隙控制器（方向 2）：
 *   gap₀ = initialGroupGapMs；
 *   任何组撞 429 → gap = min(gap × groupGapMultiplier, groupGapMaxMs)；
 *   距上次 429 超过 recoverWindowMs 且发生一次成功 → gap = max(gap × groupGapRecoverFactor, groupGapMinMs)。
 */
declare class GroupGapController {
  private readonly cfg;
  private readonly now;
  private gap;
  private lastHitAt;
  private lastDecayAt;
  constructor(deps: {
    config: () => GroupSchedulingConfig | undefined;
    now?: () => number;
  });
  /** 当前目标组间隙（毫秒）。 */
  gapMs(): number;
  /** 撞 429：放大组间隙（上限封顶），记录本次撞击时间。 */
  recordHit(now?: number): number;
  /**
   * 成功：距上次 429 超过 recoverWindowMs 且距上次衰减也超过该窗口时，按衰减因子
   * 缩小 gap（下限封底）——每窗口至多衰减一次，天然防抖。
   * 返回更新后的 gap（未触发衰减时原样返回）。
   */
  recordSuccess(now?: number): number;
  /** 重置到初始 gap（配置变更 apply 重建时用）。 */
  reset(): void;
}
//#endregion
//#region src/adapter.d.ts
/** 手动模型可选覆盖（用户设置持久化）。 */
interface ModelSelection {
  include: readonly string[];
  exclude: readonly string[];
}
interface SensenovaConnection {
  apiBase: string;
  /** 已配置账户槽位总数，用于轮换上限（tried.size < accountCount）。 */
  accountCount: number;
  /** 每 key 并发生成请求上限（正整数）；非法值在并发闸内回退 1。 */
  concurrency?: number;
  /**
   * 并发闸排队超时（毫秒）；缺省 concurrency.DEFAULT_QUEUE_TIMEOUT_MS。
   * 长程任务下服务 p90 可超过默认 60s，排队超时会让请求直接失败并交宿主重试层
   * （每次重试都重排），是「并发 1 + 慢响应」场景的主要丢回合来源之一。
   */
  queueMs?: number;
  /** 配额类 429 粘性换 key 开关（默认关；开启后仅配额类 429 触发切换，design D5）。 */
  quotaRotation?: boolean;
  /**
   * 2026-10-23（方案2）：撞 429 后插件内原地等待重试的配置。
   *
   * 实测痛点：429 抛给宿主后触发 16~18s 指数退避空转（20 步任务 9 次重试，
   * delayMs p50=16.7s）。本配置让插件先原地等 `waitMs` 再重试同一把 key
   * （最多 `maxRetries` 次），成功则省掉一次宿主退避周期；用尽仍 429 才抛宿主。
   *
   * 默认开启（maxRetries **1**，2026-10-26 下调：3 次×20s=60s 的等待比宿主退避还长）；
   * `waitMs` 按模型取 {@link MODEL_CONNECT_RETRY_WAIT_MS}
   * （2026-10-31 统一下调到 5s），设置里显式配 `waitMs`
   * 或 `modelWaitMs` 可覆盖；`maxRetries: 0` 关闭（行为与原版一致）。
   *
   * 2026-10-25 实测依据：
   *  - 撞 429 后**立即重试**（0ms）成功率 2/5，**等 10s** 重试 3/3 → 2s 属"连击区"；
   *  - deepseek-flash 大请求（24k tokens）TPM 恢复 >15s，15~90s 间隔成功率都约 50%；
   *  - deepseek-v4-flash 配额宽松（单账户连发 4 个大请求全过），10s 足够。
   */
  connectRetry?: {
    maxRetries?: number;
    /** 全局缺省等待（毫秒）；未配 modelWaitMs 时作为兜底。 */
    waitMs?: number;
    /** 按模型 id 覆盖等待（毫秒），优先级高于 waitMs。 */
    modelWaitMs?: Record<string, number>;
  };
  /** 手动模型可选覆盖；缺省等价于空选择（自动过滤）。 */
  modelSelection?: ModelSelection;
  /**
   * 已解析的重试策略（`llm-sensenova.retryPolicy` 配置的产物）。
   *
   * ⚠️ 宿主的**注册表在 registerAdapter 时捕获**这个值，此后每请求不再读
   * ⇒ 改配置必须触发 `registration.replace()` 才会生效（见 `index.ts` 的
   * `ensureRegistrationFacts`）。缺省时 `providerRetryPolicy()` 回落到
   * `DEFAULT_RETRY_POLICY_CONFIG`。
   */
  retryPolicy?: ResolvedRetryPolicy;
  /**
   * L2 连接级请求参数默认值（`llm-sensenova.requestParams`）。
   *
   * ⚠️ **每请求从 `deps.options()` 重读**，因此改了配置即刻生效、无需
   * `registration.replace()`。真正的过滤在 `l2ParamsFor()` ——
   * 这里只承载用户填的值，**能不能发由模型白名单决定**。
   */
  requestParams?: SensenovaRequestParams;
  /**
   * 组粒度调度配置（`llm-sensenova.scheduling`，v0.5 P1）。
   *
   * 未配置时组调度**关闭**：gate 以 apiKey 为键、limit=每 key 并发（与 P0 行为一致）；
   * 配置后按 {@link GroupSchedulingConfig} 归一化（见 `group-pool.ts` 的
   * `resolvedGroupScheduling`），gate 改以 `group:<index>` 为键、limit=组容量（=账户数）。
   */
  scheduling?: GroupSchedulingConfig;
}
/** 生成请求三段超时注入（毫秒，测试用）；缺省用模块级常量/并发闸默认。 */
interface SensenovaTimeouts {
  /** 连接/首字节超时；缺省 CONNECT_TIMEOUT_MS。 */
  connectMs?: number;
  /** SSE 流空闲看门狗；缺省 STREAM_IDLE_TIMEOUT_MS。 */
  streamIdleMs?: number;
  /** 并发闸排队超时；缺省 concurrency.DEFAULT_QUEUE_TIMEOUT_MS。 */
  queueMs?: number;
}
/**
 * 官方文档确认支持视觉的模型表。**两种情形都要登记**：
 *
 * 1. **元数据滞后**：`/v1/models` 未标 `image`（如 kimi-k3，实测其
 *    `input_modalities` 只有 `["text"]`，但原生多模态、只吃 Base64 Data-URL）。
 * 2. **目录未加载**（2026-09-20 端到端实测新增）：`resolveModel` 在目录还没拉到时
 *    走 `inputModalitiesFrom({}, model)` 兜底。**兜底若返回 `['text']`，宿主会把
 *    该模型当成纯文本模型**，后果有二 ——
 *    ① `session-controller` 的入站闸门（`commands.ts:338`）直接拒收图片，
 *       报 `session/attachment-invalid / MODEL_DOES_NOT_SUPPORT_IMAGES`，
 *       UI 文案是"当前模型不支持图片，请切换支持图片的模型"；
 *    ② 就算绕过入站，`llm` 服务的 gate 也会把图片投影成文本占位。
 *    ⇒ **刚启动 `dsh web`、模型选择器还没打开过时贴图会被误拒**，
 *    而这与模型的真实能力无关（网关 `input_modalities` 明确含 image）。
 *
 * 登记在此的模型：目录拉到后仍按目录声明走（含 image 时去重不重复加）；
 * 目录未加载时由本表保证能力不退化。
 */
export declare const DOCUMENTED_VISION_MODELS: Set<string>;
/**
 * 文档确认**没有**视觉能力的模型（**不得**进入 `DOCUMENTED_VISION_MODELS`）。
 *
 * 2026-09-23 Phase 0 实测，两个「无视觉」模型收图后的行为**完全不同**，必须区分对待：
 *
 * | 模型 | 行为 | 证据 |
 * |---|---|---|
 * | `deepseek-v4-flash` | 🔴 **静默丢弃 + 会幻觉** | 同图两次：一次答「有一个由小点组成的**心形**图案，数字是**"9"**」（完整编造） |
 * | `glm-5.2` | ✅ **诚实拒答** | 两次均明确「我无法直接看到您提到的图片…不具备处理或识别图像的能力」 |
 *
 * 量化铁证：v4-flash 带图 `prompt_tokens = 109` vs **纯文本对照 `14`** ⇒
 * **图片被网关接受并计费了，但模型不使用它** ⇒ 模型按语义自锚定编内容。
 *
 * 本表**不参与能力上报**（不改变 `inputModalities`，那些模型仍是 `['text']`），
 * 仅供设置页「当前模型」面板显示警示文案，避免用户贴图后拿到幻觉答案却毫无报错。
 */
export declare const DOCUMENTED_TEXT_ONLY_MODELS: Set<string>;
/** L2 参数的连接级取值（全部可选；未设置即不注入）。 */
interface SensenovaRequestParams {
  /** 核采样阈值；思考模式下服务端会把 < 0.95 抬到 0.95，非思考模式固定 1.0 并被忽略。 */
  topP?: number;
  /** 频率惩罚。思考模式下不生效（服务端不报错）。 */
  frequencyPenalty?: number;
  /** 存在惩罚。思考模式下不生效（服务端不报错）。 */
  presencePenalty?: number;
  /** 随机种子（Beta）。 */
  seed?: number;
  /** 仅 GLM 系（5.2 / 5.3）：`false` 时忽略 temperature/top_p，输出更稳定（适合代码/翻译）。 */
  doSample?: boolean;
}
/** 0.1.5 的每请求图片预算形状（`ImageRequestPolicy`：像素总量 + 编码字节目标）。 */
interface ImageRequestPolicyLike {
  maxPixels: number;
  maxBytes: number;
}
/** DSH 持久化图片引用的最小结构（对齐 @deepseek-ai/dsh-attachment 的 ImageAttachmentRef）。 */
interface ImageAttachmentRefLike {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}
interface SensenovaAdapterDeps {
  /** 每请求的连接事实（apiBase、账户数、并发上限、配额轮换开关）。 */
  options: () => SensenovaConnection;
  /**
   * 解析一个可用 key（无可解析 key 时抛 MISSING_CREDENTIAL）。
   *
   * `hint.preferredKey` 是**偏好**而非强制：实现（`index.ts`）会把它交给 key 池校验，
   * 仅当该 key 仍处于运行态时才采纳，否则回落到运行态的正确一把。这是「会话粘性」不退化成
   * 死锁的关键 —— 粘住的 key 若已被踢入阻塞态或被 401 移除，会自动让位。
   */
  resolveApiKey: (connection: SensenovaConnection, hint?: {
    preferredKey?: string;
  }) => Promise<string>;
  /**
   * 轮换到下一个 key：401（'invalid-credential'）永久禁用被拒账号并从池中移除；
   * 配额类 429（'quota-exhausted'）不写任何账号状态，仅用于换 key（design D5）。
   *
   * @param exclude - 本轮已试过的 key（适配器的 `tried`）。池会跳过它们，并在运行态
   *   候选耗尽时借用阻塞态中「阻塞最久」的一把（**不改变其相位**）。
   * @returns undefined 表示无更多可试的 key。
   */
  rotateApiKey: (rejectedKey: string, rejection: 'invalid-credential' | 'quota-exhausted', exclude?: ReadonlySet<string>) => Promise<string | undefined>;
  /**
   * 上报一次限流分类，由 `index.ts` 转交 key 池处理（2026-09-27 新增）。
   *
   * **只有 `'tpm'` 会累计连续命中并在达阈值时把该 key 踢出运行态**；`'rpm'` / `'rate'`
   * 只记不踢（它们是秒级桶、15s 量级自愈，踢掉只会白白损失该 key 上的 prompt cache）。
   *
   * @returns 池的两态把数与本次是否发生踢出；未注入时返回 undefined（纯 adapter 单测场景）。
   */
  reportRateLimit?: (key: string, kind: 'tpm' | 'rpm' | 'rate') => {
    kicked: boolean;
    running: number;
    blocked: number;
  } | undefined;
  /**
   * 上报一次成功（agent 请求拿到 2xx）。池据此清零该 key 的连续命中计数；若它正处于
   * 阻塞态（被本轮借用后打成功）⇒ 立即挂回运行态末尾（2026-09-27 新增）。
   */
  reportSuccess?: (key: string) => void;
  /**
   * 反查一个 key 的**可读描述**（账户名 + credential-ref 名），仅供限流事件的
   * `accountLabel` / `accountRef` 两个展示字段使用（2026-09-27 新增）。
   *
   * 为什么用旁路反查而不是改 `resolveApiKey` 的返回值：后者会让 `stream()` 里的
   * `apiKey` 从 `string` 变成对象，牵动并发闸、`Bearer` 拼接、`tried` 集合、粘性映射
   * 等 10 余处；旁路索引把改动隔离在「事件写入」这一个点上。
   */
  describeKey?: (key: string) => {
    label: string;
    ref: string;
  } | undefined;
  /**
   * 实时 key 事件（2026-11-03）：把「这一把 key 开始发请求 / 撞了 429」交给宿主，
   * 由设置页的 key 网格按真实节奏闪绿/红（与「演示红/绿」共用同一套动画）。
   *
   * 可选：未注入（单测、无 UI 的 profile）时静默，不影响请求路径。
   */
  onKeyEvent?: (event: {
    key: string;
    kind: 'start' | 'rate-limit';
  }) => void;
  fetchImpl?: typeof fetch;
  /** 每 key 并发闸；缺省为进程内实例（可注入以利测试）。 */
  concurrencyGate?: KeyedConcurrencyGate;
  /** 三段超时注入（测试用）；缺省为生产常量。 */
  timeouts?: SensenovaTimeouts;
  /**
   * 图片字节解析（视觉模型需要）：把宿主持久化附件引用读成请求用字节。
   * 缺省或返回 undefined 时，该图片被静默跳过（正文仍按纯文本发送）。
   */
  resolveImage?: (ref: ImageAttachmentRefLike, signal?: AbortSignal) => Promise<{
    mediaType: string;
    data: Uint8Array;
  } | undefined>;
  /**
   * 每请求图片预算（缺省 `DEFAULT_IMAGE_POLICY`）。
   *
   * ⚠️ **当前 adapter 侧并未读取本字段**：图片预算是 `index.ts` 通过
   * `createResolveImage()` → `attachments.readImageRequest(ref, requestImageTarget(ref), signal)`
   * 下发的（见 `resolveImage`）。保留该字段是为了 adapter 将来需要自行重编码图片时
   * 有注入点；2026-09-17 的类型检查把上一版注释里的"缺省值"说法纠正为事实描述。
   */
  imagePolicy?: () => ImageRequestPolicyLike;
  /**
   * 限流事件记录器（W4）。**刻意做成 thunk**：`errorLog` 开关属于「每请求读」的
   * 配置，而不是注册时被捕获的事实 —— 用函数读取，用户关掉开关后无需
   * `registration.replace()` 即刻停止记录。返回 undefined 表示不记录。
   */
  errorLog?: () => SenseNovaErrorLog | undefined;
  /**
   * 组池（v0.5 P1）：单位请求组调度器。**刻意做成 thunk** —— 与 `errorLog` 同理，
   * 组调度是「每请求读」的配置：注入 undefined（未配置 scheduling 或开关关闭时）则
   * 本 adapter 保持 P0 行为（gate 以 apiKey 为键、无组轮换、无 AIMD 组间隙）。
   */
  groupPool?: () => SensenovaGroupPool | undefined;
  /** AIMD 组间隙控制器（v0.5 P1：任何组撞 429 → ×1.5，8s 无 429 → ×0.95）。 */
  groupGap?: () => GroupGapController | undefined;
}
/** SenseNova（OpenAI 兼容）适配器。 */
export declare class SensenovaAdapter extends LlmAdapter {
  private readonly deps;
  private readonly fetchImpl;
  private readonly gate;
  private catalog;
  /** 进程内失败缓存：运行时返回 MODEL_NOT_FOUND 的模型 id，直到适配器生命周期结束。 */
  private readonly failedModels;
  /**
   * 配额类 429 粘住 key（design D5，仅 quotaRotation 开启时读写）：
   * 有 sessionId 的请求按会话分桶（同一会话后续请求粘住切换后的 key）；
   * 无 sessionId 的请求共享进程级桶（undefined 键）——宿主 GenerateOptions
   * 仅提供 sessionId 这一会话标识，粘性粒度即「会话（无标识时为进程）」，
   * 与 spec「同一会话后续请求继续使用新 key」对齐。条目仅存内存，随适配器
   * 生命周期结束。
   */
  private readonly quotaStickyKeys;
  /**
   * 429001 连续命中计数（per-session，分级探测用）：决定本次请求的探测档位
   * TPM_PROBE_BACKOFF_STEPS_MS[count]。
   *
   * 推进单位 = **一次 stream() 调用**（= 一次宿主重试周期），见 stream() 内的
   * 「W3」注释：档位快照在入口取一次，轮换出的新 key 复用同一档，整轮结束才 +1；
   * 仅请求真正成功（拿到 2xx）时清零。仅内存，随适配器生命周期。
   */
  private readonly tpmHitCounts;
  /**
   * 请求数限流（rpm）的连续命中计数，**与 {@link tpmHitCounts} 完全隔离**。
   *
   * 🔴 2026-09-24 新增。不隔离的后果有两个，都是实测抓到的：
   *   1. RPM 事件推高 TPM 档位 —— 两类限流的恢复窗口差一个量级（秒级 vs 分钟级），
   *      混在一个计数里会让 token 限流凭空少探测好几轮；
   *   2. RPM 自己吃到 TPM 的 120s 档 —— 今天 37 条 RPM 记录被迫等 120 秒。
   * 推进/清零规则与 tpmHitCounts 完全一致（每轮 +1、2xx 清零）。
   */
  private readonly rpmHitCounts;
  /**
   * 🔴 2026-09-27 **移除**：原「全池饱和标记」`quotaSaturated: Map<string|undefined, number>`。
   *
   * 它记录「本会话已连续跳过几轮 key 轮换」，与同时被移除的 `SATURATION_SKIP_ROUNDS`
   * 常量、`atTopFloor`/`saturated` 判定、`rotationAllowed` 守卫一起构成旧短路机制。
   *
   * 移除原因见 `SATURATION_SKIP_ROUNDS` 处的说明（RPM 分支误判 + 计数永不清零 ⇒ 死锁）。
   * 其职能现由 `key-pool.ts` 的双列表接管，适配器只负责通过 `deps.reportRateLimit` /
   * `deps.reportSuccess` 上报分类结果，不再自己维护任何池状态。
   */
  constructor(deps: SensenovaAdapterDeps);
  providerInfo(provider: string): LlmProviderInfo;
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
//#endregion
//#region src/key-pool.d.ts
/**
 * SenseNova key 池：运行态 / 阻塞态双列表状态机。
 *
 * 背景（2026-09-27 重构）：旧的「全池饱和短路 + per-session 隐式计数器」在持续限流下会
 * 构成正反馈死锁 —— 计数只在 2xx 时清零，而短路导致零成功，于是计数永不清零、短路永不
 * 解除，只能重启进程。本模块用显式两态列表替代它：
 *
 *   - **运行态**：可被 agent 请求选中；连续 `kickThreshold` 次 tpm 类限流后被移出。
 *   - **阻塞态**：等待恢复；由外部调度器定期探测，成功即挂回运行态末尾。
 *
 * 三条不可让步的性质（与旧机制的区别全在这里）：
 *
 *   1. **保底**：运行态只剩 1 把时永不踢出 ⇒ 池不会因踢出而空，agent 请求永远发得出去。
 *   2. **借用**：运行态候选被 `exclude` 排空时，从阻塞态取「阻塞最久」的一把临时使用
 *      （**不改变其相位**），使一轮内仍能试满 `accountCount` 把。
 *   3. **恢复与 agent 请求解耦**：阻塞态的相位**只由探测结果决定**。保底状态下 agent
 *      请求会反复打在同一把 key 上（外部表现类似旧短路），但探测不经过 agent 请求路径
 *      ⇒ 不受「零成功」影响，随时能把 key 救回运行态。这是旧短路死锁的根治点。
 *
 * 纯模块：不 import cordis、不碰网络与磁盘，时钟可注入以便单测。
 *
 * @module dsh-sensenova-freeapi/key-pool
 */
/** 一把 key 在池内的相位。 */
type KeyPhase = 'running' | 'blocked';
/** 池策略参数（来自设置页 `poolPolicy`）。 */
interface KeyPoolParams {
  /** 连续多少次 tpm 类限流后踢出运行态（默认 2）。 */
  kickThreshold: number;
  /** 首次探测间隔毫秒（默认 15000）。 */
  probeInitialMs: number;
  /** 连续探测失败的退避倍率（默认 2 ⇒ 15/30/60s）。 */
  probeBackoffFactor: number;
  /** 探测间隔上限毫秒（默认 60000）。 */
  probeMaxMs: number;
  /** 池容量上限（默认 10；超出的 key 不被追踪）。 */
  capacity: number;
}
/** 池内一把 key 的运行状态。 */
interface KeyPoolEntry {
  /** key 原文（仅存内存；日志只写 sha256 指纹）。 */
  readonly key: string;
  /** 当前相位。 */
  phase: KeyPhase;
  /** 连续 tpm 类命中数（成功或探测成功时清零）。 */
  tpmStrikes: number;
  /** 进入阻塞态的时刻（epoch ms）；处于运行态时为 0。「阻塞最久」的判据。 */
  blockedSince: number;
  /** 连续探测失败次数（驱动 15/30/60s 退避）。 */
  probeAttempts: number;
  /** 上次探测时刻（epoch ms）；被踢出时置为踢出时刻。 */
  lastProbedAt: number;
}
/** 只读快照，供设置页只读面板展示。 */
interface KeyPoolSnapshot {
  readonly running: readonly string[];
  readonly blocked: readonly {
    readonly key: string;
    readonly blockedSince: number;
    readonly probeAttempts: number;
  }[];
  /** 上次选中的 key（当前正在使用的；v0.2.7，设置页指示器）。 */
  readonly currentKey: string | undefined;
  /** 上次选中 key 的下一把运行态 key（半隐形态预览）。 */
  readonly nextKey: string | undefined;
  /** 总槽位数（运行 + 阻塞，不含被 401 移除的）。 */
  readonly size: number;
}
/** 构造依赖。 */
interface SensenovaKeyPoolDeps {
  /** 每操作读取一次策略（支持设置页热改）。 */
  params: () => KeyPoolParams;
  /** 可注入时钟（测试用）；缺省 `Date.now`。 */
  now?: () => number;
}
/**
 * 运行态 / 阻塞态双列表 key 池。
 *
 * 实例应当是**池级单例**（由 `index.ts` 的 `apply()` 创建一次并注入适配器），
 * 因此其状态对所有会话共享 —— key 的配额本来就是全局属性。
 */
declare class SensenovaKeyPool {
  private readonly running;
  private readonly blocked;
  private readonly index;
  /** 上次选中的 key，作为环回起点（比维护数组下标更耐增删）。 */
  private lastPicked;
  private readonly opts;
  constructor(deps: SensenovaKeyPoolDeps);
  private now;
  private params;
  /** 池内被追踪的 key 总数（运行态 + 阻塞态）。 */
  get size(): number;
  /** 该 key 是否处于运行态。不在池内或已阻塞都返回 false。 */
  isRunning(key: string): boolean;
  /** 阻塞态条目（顺序 = 进入阻塞态的顺序）。 */
  blockedEntries(): readonly KeyPoolEntry[];
  /**
   * 把当前解析出的全部 key 灌入池。
   *
   * **幂等**：已存在的 key 保持其相位与计数（不重置），只有新 key 追加到运行态末尾。
   * 超过 `capacity` 的部分被忽略。
   *
   * @param keys - 按配置顺序解析出的 key（调用方已按 key 去重）。
   * @returns 因容量被丢弃的 key 数量（0 = 未截断），供调用方决定是否 warning。
   */
  seed(keys: readonly string[]): number;
  /**
   * 选本次请求的起始 key。
   *
   * 顺序：会话粘性 `preferred`（**必须在运行态**，否则忽略）→ 运行态首项 →
   * （运行态为空的兜底）阻塞最久的一把。
   *
   * ⚠️ 粘性 key 若已被踢出或被 401 移除，这里会自动落到运行态的正确一把 ——
   * 这是旧实现起始处 `stickyKey ?? resolveApiKey` 留下的死锁残留的修复点。
   */
  pickStart(preferred?: string): string | undefined;
  /**
   * 轮换到下一把 key。
   *
   * 从 `lastPicked` 的下一个位置在运行态里**环回**查找第一个不在 `exclude` 的 key；
   * 运行态候选全部被排除时，**借用**阻塞态中 `blockedSince` 最小（阻塞最久）且不在
   * `exclude` 的一把 —— 借用**不改变其相位**，仅本次使用。
   *
   * @param exclude - 本轮已试过的 key（适配器的 `tried` 集合）。
   * @returns 下一把 key；池内已无可试者返回 undefined（调用方据此结束本轮）。
   */
  pickNext(exclude: ReadonlySet<string>): string | undefined;
  /**
   * 记一次 tpm 类限流。
   *
   * - **运行态**：计数 +1；达到 `kickThreshold` 且**运行态多于 1 把**时移入阻塞态。
   * - **阻塞态**：**不计 strikes**（相位只由探测决定），但刷新 `lastProbedAt` ——
   *   刚被借用试过就不必马上再探测。
   * - **不在池内**：忽略。
   *
   * @returns `kicked` = 本次是否发生「运行态 → 阻塞态」迁移；`strikes` = 当前计数。
   */
  recordTpmStrike(key: string): {
    kicked: boolean;
    strikes: number;
  };
  /**
   * 记一次成功（agent 请求拿到 2xx）。
   *
   * 计数清零；若该 key 正处于阻塞态（被借用后成功）⇒ 立即挂回运行态末尾 ——
   * 「成功是池已恢复的最强证据」的落点。
   */
  onSuccess(key: string): void;
  /** 401 永久禁用：把该 key 从池中彻底移除。 */
  remove(key: string): void;
  /** 该条目的下次可探测时刻。 */
  nextProbeAt(entry: KeyPoolEntry): number;
  /** 探测间隔：`probeInitialMs × factor^probeAttempts`，封顶 `probeMaxMs`。 */
  probeIntervalMs(entry: KeyPoolEntry): number;
  /**
   * 回写一次探测结果。
   *
   * 成功 ⇒ 计数清零并挂回运行态末尾；失败 ⇒ `probeAttempts + 1`（下次退避更久）。
   * 两种情况都刷新 `lastProbedAt`。
   */
  recordProbe(entry: KeyPoolEntry, recovered: boolean): void;
  /** 只读快照（设置页诊断面板用）。 */
  snapshot(): KeyPoolSnapshot;
  /** 阻塞态中 `blockedSince` 最小且不在 `exclude` 的一把（即「阻塞最久」）。 */
  private oldestBlocked;
  private moveToBlocked;
  private moveToRunning;
  /** 从当前所属列表摘除（不改变相位字段，供上层决定挂到哪里）。 */
  private detach;
}
//#endregion
//#region src/vision/config.d.ts
/** 视觉辅助配置（schema 输出形状，全部可选）。 */
interface VisionConfig {
  /** 总开关：关掉后工具与读图桥都不工作（工具仍注册，但直接返回禁用错误）。 */
  enabled?: boolean;
  /** 视觉模型链（逗号分隔，故障转移顺序）。 */
  modelChain?: string;
  /** 单次视觉请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 全局静默读图桥模式。 */
  bridgeMode?: 'off' | 'on' | 'auto';
  /** 视觉观察提示（空 = 默认提示）。 */
  bridgePrompt?: string;
}
/** 解析后的视觉运行事实（全字段都有值，供请求路径直接读）。 */
interface ResolvedVisionOptions {
  enabled: boolean;
  modelChain: string[];
  timeoutMs: number;
  bridgeMode: 'off' | 'on' | 'auto';
  bridgePrompt: string;
}
//#endregion
//#region src/index.d.ts
export declare const name = "llm-sensenova";
export declare const inject: string[];
export declare const DEFAULT_API_KEY_ENV = "SENSENOVA_API_KEY";
export declare const DEFAULT_API_BASE = "https://token.sensenova.cn/v1";
/** 一个额外账户（settings 数组元素）。apiKeyEnv 为 credential-ref。 */
export interface SensenovaAccountConfig {
  id?: string;
  label?: string;
  apiKeyEnv?: string;
}
/** 插件配置（schemastery schema 的输出形状，所有字段均可选）。 */
export interface SensenovaConfig {
  apiKeyEnv?: string;
  apiBase?: string;
  accounts?: SensenovaAccountConfig[];
  activeAccount?: string;
  modelSelection?: {
    include?: string[];
    exclude?: string[];
  };
  /** 每 key 并发生成请求上限（正整数，默认 1）。 */
  concurrency?: number;
  /**
   * 同 key 并发上限下排队等待的上限（毫秒，默认 60000）。长程任务下服务
   * p90 可显著超过 60s，排队超时会直接丢弃本次尝试（交宿主重试层重排）。
   */
  queueTimeoutMs?: number;
  /** 配额类 429 粘性换 key（design D5，默认关；401 行为不变，任何 429 不冷却账号）。 */
  quotaRotation?: boolean;
  /**
   * host 侧重试策略（`llm-sensenova.retryPolicy`，2026-09-17 W1 新增）。
   *
   * 控制的是**宿主 `dsh-llm-retry` 的重试行为**，不是本适配器内部的 TPM 分级探测。
   * 未配置时取 `DEFAULT_RETRY_POLICY_CONFIG`（normal / 24 次 / maxDelayMs 300000）。
   *
   * ⚠️ `backoff.maxDelayMs` **必须 ≥ 本适配器能吐出的 `providerRetryAfterMs` 上限**
   * （`QUOTA_RETRY_AFTER_CEILING_MS` = 300_000），否则落入死亡区的请求会被宿主
   * **直接放弃重试**（不是夹到上限）——即"悬崖"。调小它等于重新引入悬崖。
   */
  retryPolicy?: RetryPolicyConfig;
  /**
   * 运行日志记录器开关（2026-09-17 W4 新增，默认开；v0.5 P0 起从「仅限流事件」升级为
   * 「每次请求的运行日志」，成功也记）。
   *
   * 开启时把每一次请求的结果落成一行 JSONL（`$DSH_HOME/logs/sensenova-runtime.jsonl`）：
   * `error.code` / 模型 / 账号指纹 / 退避档位 / 是否轮换 / 耗时 / 时间。异步写入、不阻塞
   * 请求、写失败静默，**绝不落 key 原文**（只写 sha256 前 8 位指纹）。
   * 属于「每请求读」的配置：关掉即刻停止记录，无需重建/重启。
   */
  errorLog?: boolean;
  /**
   * key 池策略（2026-09-27 新增，设置页「高级选项 → Key 池」）。
   *
   * 控制「运行态 / 阻塞态」双列表的行为。全部字段可选，未配置时取
   * `DEFAULT_KEY_POOL_PARAMS`（踢出阈值 2 / 探测 15s 起、退避倍率 2、上限 60s / 容量 10）。
   *
   * ⚠️ 它只在 `quotaRotation === true` 时生效 —— 踢出与借用都发生在「配额类 429 换 key」
   * 这条路径上；开关关闭时池不参与决策，行为与旧版一致。
   */
  poolPolicy?: KeyPoolParams;
  /**
   * L2 连接级请求参数默认值（2026-09-23 新增）。
   *
   * 宿主 `GenerateOptions` 只允许传 12 个字段
   * （`@deepseek-ai/dsh-llm/src/types.ts:486-526`），**没有** `top_p` / `seed` /
   * 频率惩罚 / `do_sample` ⇒ 这些参数在"每次会话可调"这一层做不到（要改上游），
   * 只能在**连接级**由插件注入请求体。
   *
   * ⚠️ **语义**：这是**连接级默认值**（与 `concurrency` / `queueTimeoutMs` 同性质），
   * **不是** per-session 可调项。全部可选，**未设置即不注入**。
   *
   * ⚠️ **不是所有模型都吃这些参数**：按 `MODEL_L2_PARAM_SUPPORT` 白名单过滤，
   * 例如 `kimi-k3` 传非 0 的频率惩罚会被服务端 400 硬拒 ⇒ 该模型全部排除。
   * 详见 `adapter.ts` 的白名单注释（含 Phase 0 实测证据）。
   */
  requestParams?: SensenovaRequestParams;
  /**
   * 组粒度调度（v0.5 P1 方向 2：组轮换 + AIMD 组间隙）。
   *
   * 「单位请求组」= 每个账户取一把 key 组成的横切面：账户数 A × 每账户 key 数 K
   * ⇒ 共 K 组，每组 A 把（每账户 1 把），组容量 = A 个并发。调度器以组为轮换单位：
   * 组内任一账户撞 429 ⇒ 本组整组退避（退避公式见 `group-pool.ts`）+ 该账户全部
   * key 打账户级联动标记，调度器切到未退避的组；全部组退避 ⇒ 全池冷却快返 429。
   *
   * 组间间隙按 AIMD 自适应：撞 429 ×1.5（上限 `groupGapMaxMs`），连续
   * `recoverWindowMs` 无 429 ×0.95（下限 `groupGapMinMs`）。
   *
   * `enabled: false` 时整体退化为 v0.5 P0 的 per-key 池路径（行为不变）。
   * 账户 label 不符合「账户-序号」约定时（无法划分组）同样自动回落。
   */
  scheduling?: GroupSchedulingConfig;
  /**
   * 视觉辅助（融合自 dsh-sensenova-vision-aid）。
   *
   * 开启后：三个工具（describe_image / describe_images / chat）可用，且纯文本
   * 主模型拖图会被自动转成视觉观察文本。所有视觉请求与主对话**共用**同一套
   * key 池、并发闸、组退避与运行日志 —— 这正是「视觉不再另起一套轮换」的落点。
   */
  vision?: VisionConfig;
}
/**
 * 对外导出的配置 schema。
 *
 * ⚠️ **类型断言是刻意的**：`.volatile()` 把字段类型包成 `Volatile<T>`，官方
 * `llm-deepseek` 因此把接口写成 `apiKeyEnv: Volatile<string>` 并在读取处用
 * `plainOptions()`（`isVolatile(v) ? v.get() : v`）逐字段解包。
 *
 * 本插件**保持 `SensenovaConfig` 为「解析后形态」**（下游 `resolveAdapterOptions()`、
 * `normalizeRequestParams()` 全按普通值读），schema 上的 volatile 标记只服务设置层
 * （`describe()` → `volatileForm()` 需要它才不跳过本 namespace）。故此处显式断言，
 * 避免为一个纯标注性改动重写整条读值路径。
 *
 * ⚠️ 这条断言成立的前提是**下游必须先经 `plainConfig()` 解包**（见 `apply()` 入口）。
 * 实测形状：带 volatile 的字段在 schema 输出里是 `{ get() }` 对象，
 * `JSON.stringify(Config({...}))` 会得到一串 `{}` ⇒ 不解包则 `config.accounts` 是引用、
 * `accounts.slots` 会读成 0。
 *
 * 验收判据（必须同时成立才说明"设置层修好、运行期没坏"）：
 * `GET /api/sensenova/modelInfo` 的 `settingsProbe.namespacesSeen` 从 **0 → 1**，
 * 且 `accounts.slots` 仍为 **3**。
 */
export declare const Config: z<SensenovaConfig>;
/**
 * 把带 volatile 引用的配置解包成普通值（对齐官方 `llm-deepseek` 的 `plainOptions()`）。
 *
 * 🔴 与 `.volatile()` 配套，缺了它整个插件会读到引用对象。
 *
 * @param config - `apply()` 收到的原始配置（字段可能是 volatile 引用）。
 * @returns 字段全部为普通值的配置，可直接交给 `resolveAdapterOptions()`。
 */
export declare function plainConfig(config: SensenovaConfig): SensenovaConfig;
/**
 * 从账户 label 解析**轮换排序键**（v0.2.6）。
 *
 * 约定 label 为「账户号-序号」（如 `2-3`），`Default` 视为 `1-0`。
 * 按 (序号, 账户号) 升序排列即得到交替顺序：1-0, 2-0, 3-0, 4-0, 1-1, 2-1 …
 *
 * @param label - 账户可读标签。
 * @returns 排序键；label 不符合约定时返回 undefined（调用方回退配置顺序）。
 */
export declare function accountRotationKey(label: string): {
  slot: number;
  account: number;
} | undefined;
/**
 * 按**交替顺序**重排账户（v0.2.6，导出供单测）。
 *
 * 为什么在轮换侧排序而不是要求用户手工排配置：账户级限流是独立桶，顺序排布
 * （某账户的 20 把全在前）会把前 19 次尝试全花在同一个桶上。实测 18 轮对照
 * （20 次尝试上限）：交替成功 72% / 顺序 50%，限流轮次下交替均 10 次尝试、顺序均 16 次。
 *
 * 只有**全部** label 都能解析时才重排；出现自定义命名则原样返回，避免按猜测语义
 * 打乱用户配置。
 *
 * @param accounts - 原始账户列表（按配置顺序）。
 * @returns 交错排序后的列表（或原列表）。
 */
export declare function interleavedAccounts<T extends {
  label: string;
}>(accounts: readonly T[]): readonly T[];
/** 一个解析后的账户槽位：id/label + 合法 credential-ref 名。 */
export interface ResolvedAccountSpec {
  id: string;
  label: string;
  /** 合法 credential-ref 名；非法输入不会保留原文。 */
  ref: string;
  /** 为兼容公开类型保留；当前解析路径始终为 false，不承载字面密钥。 */
  isLiteral: boolean;
}
/** resolveAdapterOptions 的输出：连接事实 + 账户槽位。 */
export interface ResolvedSensenovaOptions {
  apiBase: string;
  activeAccount: string;
  accounts: ResolvedAccountSpec[];
  concurrency: number;
  /** 并发闸排队超时（毫秒，默认 DEFAULT_QUEUE_TIMEOUT_MS）。 */
  queueTimeoutMs: number;
  /** 配额类 429 粘性换 key（默认 false）。 */
  quotaRotation: boolean;
  /** 已解析的重试策略（永不 undefined：未配置时取 DEFAULT_RETRY_POLICY_CONFIG）。 */
  retryPolicy: ResolvedRetryPolicy;
  /** 已归一化的 key 池策略（永不 undefined：缺省取 DEFAULT_KEY_POOL_PARAMS）。 */
  poolPolicy: KeyPoolParams;
  /** 限流事件记录器开关（默认 true）。 */
  errorLog: boolean;
  /**
   * L2 连接级请求参数默认值（已归一化；未配置时为空对象）。
   *
   * ⚠️ 这里只做"数值合法性"归一化；**能不能发给某个模型**由
   * `adapter.ts` 的 `MODEL_L2_PARAM_SUPPORT` 白名单在每请求时决定。
   */
  requestParams: SensenovaRequestParams;
  /** 已归一化的组调度配置（v0.5 P1；enabled=false 时组池不启用）。 */
  scheduling: GroupSchedulingConfig;
  /** 已归一化的视觉辅助配置（融合自 vision-aid，永不为 undefined）。 */
  vision: ResolvedVisionOptions;
  modelSelection?: ModelSelection;
}
/** 把配置的并发上限归一化为正整数（非正整数/无法解析回退 1）。 */
export declare function normalizeConcurrency(value: unknown): number;
/** 把配置的排队超时归一化为正整数毫秒；非法值回退 DEFAULT_QUEUE_TIMEOUT_MS。 */
export declare function normalizeQueueTimeout(value: unknown): number;
/**
 * 归一化 key 池策略（2026-09-27 新增）。
 *
 * 约定与其它归一化助手一致：**非法值回退缺省，绝不抛** —— 抛会打断设置保存、让整个
 * 设置页卡住（本插件在 `normalizeRequestParams` 处已确立该约定）。
 *
 * 额外维护一条不变量：`probeMaxMs >= probeInitialMs`。否则退避会「越等越短」，与
 * 探测退避的意图正好相反；违反时把 `probeMaxMs` 抬到 `probeInitialMs`。
 */
export declare function normalizePoolPolicy(value: unknown): KeyPoolParams;
/** 规范化用户模型选择配置；未配置时保持 undefined，便于 settings unset。 */
export declare function normalizeModelSelection(selection: SensenovaConfig['modelSelection']): ModelSelection | undefined;
/**
 * 把用户配置的 `retryPolicy` 与缺省值**逐层合并**（2026-09-17 W1）。
 *
 * ⚠️ 为什么不能写成 `config.retryPolicy ?? DEFAULT_RETRY_POLICY_CONFIG`：
 * 设置页允许只改其中一项（例如只调 `maxRetries`），而 `RetryPolicyConfig` 在
 * schema 里是 `z.union` 形状，用户只填部分键时缺省 `backoff` **未必被补全**
 * ⇒ `resolveRetryPolicy()` 会退回 schema 缺省 `maxDelayMs = 10_000`，而该值
 * 远小于适配器能吐出的 pra 上限（300_000）⇒ **悬崖立刻重现**。
 *
 * 逐层兜底把"防悬崖"从「用户必须填全」变成「结构性保证」。
 * 并集安全：`ALWAYS_POLICY_KEYS` 与 `NORMAL_POLICY_KEYS` 都接受
 * `maxRetries`/`retryableCodes`（后者明确注释为"切模式后保留的惰性字段"），
 * 因此合并出的对象无论走哪条分支都能通过 `validateKeys`。
 */
export declare function mergeRetryPolicy(config: RetryPolicyConfig | undefined): RetryPolicyConfig;
export declare function resolveAdapterOptions(config: SensenovaConfig): ResolvedSensenovaOptions;
export declare function apply(ctx: Context, config: SensenovaConfig): void;
/**
 * 探测用的固定模型 id。
 *
 * 用 v4.1 的 `deepseek-flash`：它已实测可路由，且**限流是 key 级的**（与服务端用哪个
 * 模型无关）⇒ 用哪个模型探测结论都一样。固定常量最简单，也不依赖会话上下文。
 */
export declare const PROBE_MODEL = "deepseek-flash";
/** 单次探测的超时（毫秒）。故意短于生产建连超时：探测要的是快速结论，不是结果本身。 */
export declare const PROBE_TIMEOUT_MS = 10000;
/**
 * 探测定时器的粒度（毫秒）。
 *
 * 2026-11-01：3_000 → 120_000（方案文档 §1.7 的 P0）。
 *
 * 原值 3s 意味着每个进程每小时最多跑 1,200 次探测。在 4 账户场景下这些探测
 * **本身就是限流的主要贡献者之一**——11-01 实测「DSH 已静默 56 分钟，deepseek
 * 仍然 429」，根因就是这条定时器在持续打 `deepseek-flash`。
 *
 * 为什么是 120s：实测「静默 10 分钟后单个 6 token 请求仍被拒」，恢复的真实
 * 时间尺度是分钟到小时级，不是秒级。3s 探测在这一尺度下纯属噪声，且每次探测
 * 都在给网关的「连续 429」计数 +1。120s 兼顾「及时发现恢复」与「不制造流量」。
 *
 * 注意：这里只调粒度，真正的退避仍由 key 池的 `probeInitialMs × factor^n` 决定，
 * 两者叠加后实际间隔 ≥ 120s。
 */
export declare const PROBE_TICK_MS = 600000;
export interface ProbeSchedulerDeps {
  /** 池：取阻塞态条目并回写探测结果。 */
  keyPool: SensenovaKeyPool;
  /** 并发闸 —— **必须与适配器是同一个实例**，否则避不开正在飞行的 agent 请求。 */
  gate: KeyedConcurrencyGate;
  /** 当前网关地址。 */
  apiBase: () => string;
  /** 当前每 key 并发上限（`tryAcquire` 的额度依据）。 */
  concurrency: () => number;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
  /** 可注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
  /** 覆盖探测模型（测试用）。 */
  model?: string;
  /** 覆盖单次探测超时（测试用）。 */
  timeoutMs?: number;
}
export interface ProbeScheduler {
  /**
   * 跑一次探测轮次：在**已到期**的阻塞态条目里，挑**第一把**能拿到并发额度的去探测。
   * 每轮**至多探测 1 把** —— 避免探测自身形成突发，反过来推高请求数限流。
   * @returns 本次是否真的发起了探测（供测试断言与诊断）。
   */
  tick: (signal?: AbortSignal) => Promise<boolean>;
}
/**
 * 创建阻塞态 key 的恢复探测调度器。
 *
 * **为什么必须有它**：agent 请求只会选中**运行态**的 key，阻塞态的 key 不会被任何 agent
 * 请求碰到 ⇒ 若不主动探测，它们永远回不来。这正是旧「全池饱和短路」无法自解的根源 ——
 * 它的恢复权握在「跳过轮数涨到 5」上，而那个计数只在请求成功时才清零，成功又依赖轮换，
 * 于是构成死锁。本调度器把「恢复」与「agent 请求」彻底解耦。
 *
 * 抽成工厂是为了**可测试**：单测直接调 `tick()`，不需要真实定时器，也不需要网络
 * （注入 `fetchImpl`）。`apply()` 只负责用 `ctx.effect` 包一层定时器。
 */
export declare function createProbeScheduler(deps: ProbeSchedulerDeps): ProbeScheduler;
//#endregion
export {};
//# sourceMappingURL=index.d.ts.map