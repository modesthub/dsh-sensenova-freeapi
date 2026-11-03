/**
 * v0.5 P1：单位请求组调度器（组粒度 key 池 + AIMD 组间隙）。
 *
 * 与 `key-pool.ts`（运行态/阻塞态双列表，负责 tpm 踢出与探测复活）**并行共存**：
 * 组池负责「组粒度轮换 + 账号级联动冷却 + 全池冷却快返 + AIMD 组间隙」，
 * key 池继续负责「被踢 key 的探测恢复」——两个池各自独立、互不写对方的相位。
 *
 * 单位请求组模型（v0.5 方案 §4.0，用户已拍板方向 2）：
 *   A 个账户、每账户 K 把 key ⇒ 组数 G = K，每组恰好 A 把（每账户 1 把）。
 *   组 i = { 账户1-kᵢ, 账户2-kᵢ, …, 账户A-kᵢ }；**组容量 = A 个并发**
 *   （同组最多 A 个请求在飞，超出进 `gate.acquire(group, limit)` 的队列）。
 *
 /**
 * 组内任一账户 429 → 两层退避（与 v0.5 方案 §4.0 的 AND 关系一致）：
 *   1. **本组整组退避**（组内 all keys 一并冷却，调度器切未退避的组）；
 *   2. **账户级联动**：该账户的其他 key（分布在其余各组）所在组的**该账户 key**
 *      被单独标记不可用（其余账户的 key 照常可选）——st-rotator 账号级联动
 *      （keypool.py:731-734）的组模型落点，
 *      防止「换组后同一账户再撞 429」的空转。
 *
 * 组退避公式（A=✅ 已拍板）：`delay = min(base × factor^(strikes-1), max) × (1 + U(0, jitter))`
 *   默认 base=90s、factor=2、max=300s、jitter=0.5 —— 组内第 n 次 429 用 n 作为 strikes。
 *
 * 组间间隙（方向 2 AIMD）：`gap₀=2000ms`；任何组撞 429 → `gap × 1.5`（上限 30000ms）；
 * 距上次 429 超过 `recoverWindowMs`（8s）且距上次衰减也超窗口 → `gap × 0.95`（下限 500ms，
 * 每窗口至多衰减一次，天然防抖）。
 *
 * 模块刻意**不依赖 cordis/schemastery**，时钟可注入（`now`），与 key-pool.ts
 * 同一测试范式：node 测试可直接驱动。
 *
 * @module dsh-sensenova-freeapi/group-pool
 */

/** nanoid 风格的组键前缀（gate.acquire 等外部键命名用）。 */
export const GROUP_KEY_PREFIX = 'group:';

/** 组粒度调度配置（v0.5 §5 参数映射表的插件侧副本）。 */
export interface GroupSchedulingConfig {
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
  groups?: { account: number; sizes: number[]; gaps?: number[] }[];
}

/** 缺省组调度配置（frozen，所有字段都有值，供 normalize 回落）。 */
export const DEFAULT_GROUP_SCHEDULING: Readonly<Required<GroupSchedulingConfig>> = Object.freeze({
  enabled: true,
  cooldownBaseMs: 90_000,
  cooldownFactor: 2,
  cooldownMaxMs: 300_000,
  cooldownJitter: 0.5,
  initialGroupGapMs: 2_000,
  groupGapMinMs: 500,
  groupGapMaxMs: 30_000,
  groupGapMultiplier: 1.5,
  groupGapRecoverFactor: 0.95,
  recoverWindowMs: 8_000,
  failFastMs: 8_000,
  mode: 'fixed',
  groupGapMs: 20_000,
  keyGapMs: 1_000,
  roundBudget: 2,
  grouping: 'by-account',
  groups: [],
});

/**
 * 按计划把一个账户的 key 切成若干组，并让出空档（2026-11-02）。
 *
 * @param keys  - 该账户的 key，**已按 slot 升序**。
 * @param sizes - 每组的把数，如 [4, 4]。
 * @param gaps  - 空档数（长度 = sizes.length + 1）：`gaps[i]` 是第 i 组前面的孤立 key 数，
 *                最后一项是末尾的孤立数。空档里的 key **不进任何组**（不参与轮换）。
 * @returns groups（每组 key 列表）+ orphans（未参与轮换的 key 数）。
 */
export function planGroups(
  keys: readonly string[],
  sizes: readonly number[],
  gaps: readonly number[] = [],
): { groups: string[][]; orphans: number } {
  const groups: string[][] = [];
  let cursor = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const gap = Math.max(0, Math.floor(gaps[index] ?? 0));
    cursor += gap;
    const size = Math.max(1, Math.floor(sizes[index] ?? 1));
    const slice = keys.slice(cursor, cursor + size);
    cursor += slice.length;
    if (slice.length > 0) groups.push(slice);
  }
  return { groups, orphans: Math.max(0, keys.length - cursor) };
}

/** 兼容旧调用：只取组，忽略空档信息（空档中的 key 视为不参与轮换）。 */
export function sliceGroups(keys: readonly string[], sizes: readonly number[]): string[][] {
  return planGroups(keys, sizes).groups;
}

/** 账户 id 自然序：account-2 排在 account-10 之前；无数字后缀的排后面按字典序。 */
export function compareAccountId(left: string, right: string): number {
  const a = /(\d+)\s*$/.exec(left);
  const b = /(\d+)\s*$/.exec(right);
  if (a !== null && b !== null) return Number(a[1]) - Number(b[1]) || left.localeCompare(right);
  if (a !== null) return -1;
  if (b !== null) return 1;
  return left.localeCompare(right);
}


/**
 * 归一化组调度配置：非法值逐个回落缺省，**绝不抛**（与 normalizePoolPolicy
 * 同一约定——抛会打断设置保存）。只保留合法字段；全非法时回落 DEFAULT。
 */
export function normalizeGroupScheduling(value: unknown): GroupSchedulingConfig {
  if (value === null || typeof value !== 'object') return { ...DEFAULT_GROUP_SCHEDULING };
  const input = value as Record<string, unknown>;
  const out: GroupSchedulingConfig = {};
  const num = (key: string, min: number, max: number): number | undefined => {
    // 与 normalizePoolPolicy 的 clampInt 同约定：非法或越界 → 回落缺省（undefined 让
    // resolvedGroupScheduling 补默认）；绝不钳到边界（钳制会让"配错的 7"变成"合法的 1"，
    // 掩盖配置错误）。
    const v = input[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return undefined;
    return v;
  };
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
  const cooldownBaseMs = num('cooldownBaseMs', 1_000, 600_000);
  if (cooldownBaseMs !== undefined) out.cooldownBaseMs = cooldownBaseMs;
  const cooldownFactor = num('cooldownFactor', 1, 10);
  if (cooldownFactor !== undefined) out.cooldownFactor = cooldownFactor;
  const cooldownMaxMs = num('cooldownMaxMs', cooldownBaseMs ?? DEFAULT_GROUP_SCHEDULING.cooldownBaseMs, 600_000);
  if (cooldownMaxMs !== undefined) out.cooldownMaxMs = cooldownMaxMs;
  const cooldownJitter = num('cooldownJitter', 0, 1);
  if (cooldownJitter !== undefined) out.cooldownJitter = cooldownJitter;
  const initialGroupGapMs = num('initialGroupGapMs', 100, 60_000);
  if (initialGroupGapMs !== undefined) out.initialGroupGapMs = initialGroupGapMs;
  const groupGapMinMs = num('groupGapMinMs', 100, 60_000);
  if (groupGapMinMs !== undefined) out.groupGapMinMs = groupGapMinMs;
  const groupGapMaxMs = num('groupGapMaxMs', groupGapMinMs ?? DEFAULT_GROUP_SCHEDULING.groupGapMinMs, 120_000);
  if (groupGapMaxMs !== undefined) out.groupGapMaxMs = groupGapMaxMs;
  const groupGapMultiplier = num('groupGapMultiplier', 1.01, 10);
  if (groupGapMultiplier !== undefined) out.groupGapMultiplier = groupGapMultiplier;
  const groupGapRecoverFactor = num('groupGapRecoverFactor', 0.5, 0.999);
  if (groupGapRecoverFactor !== undefined) out.groupGapRecoverFactor = groupGapRecoverFactor;
  const recoverWindowMs = num('recoverWindowMs', 1_000, 120_000);
  if (recoverWindowMs !== undefined) out.recoverWindowMs = recoverWindowMs;
  const failFastMs = num('failFastMs', 100, 120_000);
  if (failFastMs !== undefined) out.failFastMs = failFastMs;
  if (input.mode === 'adaptive' || input.mode === 'fixed') out.mode = input.mode;
  if (input.grouping === 'by-account' || input.grouping === 'by-slot') out.grouping = input.grouping;
  const groupGapMs = num('groupGapMs', 1_000, 600_000);
  if (groupGapMs !== undefined) out.groupGapMs = groupGapMs;
  const keyGapMs = num('keyGapMs', 0, 60_000);
  if (keyGapMs !== undefined) out.keyGapMs = keyGapMs;
  // 分组计划（2026-11-03 修复）：account + sizes 合法才收下，非法项跳过；
  // gaps 缺省为空数组。此前这里不认 groups ⇒ 运行期计划被丢，见字段注释。
  if (Array.isArray(input.groups)) {
    const plan: { account: number; sizes: number[]; gaps: number[] }[] = [];
    for (const entry of input.groups) {
      if (entry === null || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      const account = typeof row.account === 'number' && Number.isFinite(row.account) ? Math.round(row.account) : 0;
      if (account < 1) continue;
      const sizes = Array.isArray(row.sizes)
        ? row.sizes.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 1).map((n) => Math.round(n))
        : [];
      if (sizes.length === 0) continue;
      const gaps = Array.isArray(row.gaps)
        ? row.gaps.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0).map((n) => Math.round(n))
        : [];
      plan.push({ account, sizes, gaps });
    }
    if (plan.length > 0) out.groups = plan;
  }
  // 预算必须是整数轮（1-10）：0 会让「一轮都没走就抛」，与 fixed 模式语义相反。
  const roundBudget = num('roundBudget', 1, 10);
  if (roundBudget !== undefined) out.roundBudget = Math.round(roundBudget);
  // 只返回有效字段；调用方逐字段 ?? DEFAULT。空对象也合法（=全默认）。
  return out;
}

/** resolved 配置（缺省值全部补齐）。 */
export type ResolvedGroupScheduling = Required<GroupSchedulingConfig>;

/** 把归一化结果解析为「全字段都有值」的形态（供池内直接读）。 */
export function resolvedGroupScheduling(
  configured: GroupSchedulingConfig | undefined,
  fallback: Readonly<Required<GroupSchedulingConfig>> = DEFAULT_GROUP_SCHEDULING,
): ResolvedGroupScheduling {
  const src = configured ?? {};
  return {
    enabled: src.enabled ?? fallback.enabled,
    cooldownBaseMs: src.cooldownBaseMs ?? fallback.cooldownBaseMs,
    cooldownFactor: src.cooldownFactor ?? fallback.cooldownFactor,
    cooldownMaxMs: src.cooldownMaxMs ?? fallback.cooldownMaxMs,
    cooldownJitter: src.cooldownJitter ?? fallback.cooldownJitter,
    initialGroupGapMs: src.initialGroupGapMs ?? fallback.initialGroupGapMs,
    groupGapMinMs: src.groupGapMinMs ?? fallback.groupGapMinMs,
    groupGapMaxMs: src.groupGapMaxMs ?? fallback.groupGapMaxMs,
    groupGapMultiplier: src.groupGapMultiplier ?? fallback.groupGapMultiplier,
    groupGapRecoverFactor: src.groupGapRecoverFactor ?? fallback.groupGapRecoverFactor,
    recoverWindowMs: src.recoverWindowMs ?? fallback.recoverWindowMs,
    failFastMs: src.failFastMs ?? fallback.failFastMs,
    mode: src.mode ?? fallback.mode,
    groupGapMs: src.groupGapMs ?? fallback.groupGapMs,
    keyGapMs: src.keyGapMs ?? fallback.keyGapMs,
    roundBudget: src.roundBudget ?? fallback.roundBudget,
    grouping: src.grouping ?? fallback.grouping,
    groups: src.groups ?? fallback.groups,
  };
}

/** 组粒度的退避计算（组内第 n 次 429：strikes=n ⇒ delay = min(base×factor^(n-1), max) × (1+U(0,jitter))）。 */
export function groupCooldownMs(strikes: number, config: Readonly<Required<GroupSchedulingConfig>>, random: () => number = Math.random): number {
  const exponent = Math.max(1, strikes);
  const scaled = config.cooldownBaseMs * Math.pow(config.cooldownFactor, exponent - 1);
  const capped = Math.min(scaled, config.cooldownMaxMs);
  const jitter = config.cooldownJitter > 0 ? 1 + random() * config.cooldownJitter : 1;
  return Math.round(capped * jitter);
}

/** 单个组的运行时状态。 */
export interface KeyGroup {
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
export interface KeyGroupSnapshot extends KeyGroup {}

/** watchKey 的返回：adapter 判定全池冷却/日志 groupIndex 用。 */
export interface KeyGroupInfo {
  groupIndex: number;
  /** 本组可并发额度 = 组内 key 数（每账户一把 ⇒ 即账户数 A）。 */
  capacity: number;
  allCooled: boolean;
}

/** reportRateLimit 的返回：调用方（adapter/index）用于日志与轮换。 */
export interface GroupRateLimitReport {
  groupIndex: number;
  cooldownUntil: number;
  strikes: number;
}

/** reportRateLimit 的输入上下文（adapter 上报分类时并不知道账户归属，由 index 接线补全）。 */
export interface GroupRateLimitInput {
  /** 触发 429 的 key 原文。 */
  key: string;
  kind: 'tpm' | 'rpm' | 'rate' | 'quota_exhausted';
}

/** seed() 的组描述：显式给出账户与组号（新增形态）。 */
export interface SeedGroup {
  /** 组内 key 列表（顺序即组内轮换顺序）。 */
  keys: readonly string[];
  /** 所属账户 id。 */
  account: string;
  /** 该账户内的组序号（0 起，连续）。 */
  ordinal: number;
}

export interface SensenovaGroupPoolDeps {
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
export class SensenovaGroupPool {
  private readonly cfg: () => ResolvedGroupScheduling;
  private readonly now: () => number;
  private readonly random: () => number;
  private groups: KeyGroup[] = [];
  /** key → 组索引。 */
  private readonly keyToGroup = new Map<string, number>();
  /** key → 账户 id（联动冷却：同一账户的所有 key 所在组一起冷却）。 */
  private readonly keyToAccount = new Map<string, string>();
  /** 账户 id → 该账户全部 key。 */
  private readonly accountKeys = new Map<string, Set<string>>();
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
  private accountOrder: string[] = [];
  /** 下一个要轮到的账户在 accountOrder 中的下标。 */
  private accountCursor = 0;
  /** 账户 → 该账户「下一次该用第几组」（对组数取模）。 */
  private readonly groupCursor = new Map<string, number>();
  /** 账户 → 该账户的组下标列表（按 ordinal 升序）。 */
  private readonly ordinalsByAccount = new Map<string, number[]>();

  constructor(deps: SensenovaGroupPoolDeps) {
    this.cfg = () => resolvedGroupScheduling(deps.config());
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  /** 当前生效配置的只读视图（供外部同源读取 gap 初值等）。 */
  get config(): ResolvedGroupScheduling {
    return this.cfg();
  }

  /**
   * 建组并登记 key→组/账户映射（幂等：已在的组只更新 keys）。
   *
   * @param groups - 组内 key 列表（每组合计 A 把，即组容量）。
   * @param accountOf - key → 账户 id；同一账户的 key 分属不同组时，联动冷却会把
   *   它们各自所在的组**全部**冷却（账号级联动的实现基础）。
   */
  seed(groups: readonly (readonly string[] | SeedGroup)[], accountOf?: (key: string) => string | undefined): string[] {
    const dropped: string[] = [];
    // 重建 key→组 映射要与现有组保持一致：只处理「本次传入」的组，不碰旧组的键。
    const fresh: KeyGroup[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < groups.length; index += 1) {
      const entry = groups[index];
      if (entry === undefined) continue;
      // 两种入参形态：数组 = 旧形态（每组自成一个账户），对象 = 显式账户+组号。
      const isBare = Array.isArray(entry);
      const keys: readonly string[] = isBare ? (entry as readonly string[]) : (entry as SeedGroup).keys;
      if (keys.length === 0) continue;
      const account = isBare
        ? (accountOf?.(keys[0] ?? '') ?? `solo-${index}`)
        : (entry as SeedGroup).account;
      const ordinal = isBare ? 0 : (entry as SeedGroup).ordinal;
      const normalized = keys.filter((key) => typeof key === 'string' && key.length > 0);
      // 跨组重复 key 在本池内非法：丢弃重复者。
      const unique: string[] = [];
      for (const key of normalized) {
        if (seen.has(key)) {
          dropped.push(key);
          continue;
        }
        seen.add(key);
        unique.push(key);
      }
      fresh.push({
        index,
        keys: unique,
        account: account.length > 0 ? account : `solo-${index}`,
        ordinal,
        // 保留旧组状态（冷却/连击/strikes）——seed 幂等的意义就在于此。
        ...this.#existingGroupState(index),
      });
      for (const key of unique) {
        this.keyToGroup.set(key, index);
        if (accountOf !== undefined) {
          const account = accountOf(key);
          if (account !== undefined) {
            this.keyToAccount.set(key, account);
            let set = this.accountKeys.get(account);
            if (set === undefined) {
              set = new Set();
              this.accountKeys.set(account, set);
            }
            set.add(key);
          }
        }
      }
    }
    this.groups = fresh;
    this.#rebuildCarousel();
    // 清理已不存在的 key 残留映射。
    for (const [key] of this.keyToGroup) {
      if (!seen.has(key)) this.keyToGroup.delete(key);
    }
    for (const [key] of this.keyToAccount) {
      if (!seen.has(key)) {
        const account = this.keyToAccount.get(key);
        if (account !== undefined) this.accountKeys.get(account)?.delete(key);
        this.keyToAccount.delete(key);
      }
    }
    return dropped;
  }

  /**
   * 重建账户轮转序与「账户 → 组下标」索引。
   *
   * 账户序按 id 尾数自然升序（`account-2` < `account-10`），未带数字的按字典序排在后。
   * 组下标按 `ordinal` 升序，保证「第 r 次轮到该账户用第 r 组」。
   */
  #rebuildCarousel(): void {
    this.ordinalsByAccount.clear();
    const order: string[] = [];
    for (const group of this.groups) {
      let list = this.ordinalsByAccount.get(group.account);
      if (list === undefined) {
        list = [];
        this.ordinalsByAccount.set(group.account, list);
        order.push(group.account);
      }
      list.push(group.index);
    }
    for (const list of this.ordinalsByAccount.values()) {
      list.sort((a, b) => (this.groups[a]?.ordinal ?? 0) - (this.groups[b]?.ordinal ?? 0) || a - b);
    }
    order.sort(compareAccountId);
    this.accountOrder = order;
    // 已消失账户的组游标一并清掉（否则账户增删后残留相位）。
    for (const account of [...this.groupCursor.keys()]) {
      if (!this.ordinalsByAccount.has(account)) this.groupCursor.delete(account);
    }
    this.accountCursor = this.accountOrder.length === 0 ? 0 : this.accountCursor % this.accountOrder.length;
  }

  #existingGroupState(index: number): Pick<KeyGroup, 'cooldownUntil' | 'strikes' | 'pending' | 'lastKeyIndex' | 'accountCooldown' | 'usedStartedAt' | 'nextAvailableAt'> {
    const prior = this.groups[index];
    if (prior === undefined) {
      return { cooldownUntil: 0, strikes: 0, pending: 0, lastKeyIndex: -1, accountCooldown: new Map(), usedStartedAt: 0, nextAvailableAt: 0 };
    }
    return {
      cooldownUntil: prior.cooldownUntil,
      strikes: prior.strikes,
      pending: prior.pending,
      lastKeyIndex: prior.lastKeyIndex,
      accountCooldown: prior.accountCooldown,
      usedStartedAt: prior.usedStartedAt ?? 0,
      nextAvailableAt: prior.nextAvailableAt ?? 0,
    };
  }

  /** 组数。 */
  get size(): number {
    return this.groups.length;
  }

  /** 某 key 是否被账户级联动冷却排除（返回 true=不可用）。 */
  #isAccountCooled(key: string, now: number): boolean {
    const account = this.keyToAccount.get(key);
    if (account === undefined) return false;
    const index = this.keyToGroup.get(key);
    if (index === undefined) return false;
    const group = this.groups[index];
    if (group === undefined) return false;
    const until = group.accountCooldown.get(account);
    return until !== undefined && until > now;
  }

  /** 全池是否**完全没有**可服务 key（不含 exclude——调用方快返判定只看池本身）。 */
  #anyKeyAvailable(now: number): boolean {
    for (const group of this.groups) {
      if (group.cooldownUntil > now && group.pending === 0) continue;
      for (const key of group.keys) {
        if (!this.#isAccountCooled(key, now)) return true;
      }
    }
    return false;
  }

  /** 当前宏观轮转指向的账户（下一次轮到谁）。 */
  nextAccount(): string | undefined {
    return this.accountOrder[this.accountCursor];
  }

  /** 账户轮转序只读副本（日志 / 测试用）。 */
  get accounts(): readonly string[] {
    return this.accountOrder;
  }

  /** 各账户组数的最大值：一轮 = 该值个宏观周期（走遍全部组算 1 轮）。 */
  maxGroupCount(): number {
    let max = 0;
    for (const list of this.ordinalsByAccount.values()) {
      if (list.length > max) max = list.length;
    }
    return max;
  }

  /** 某账户当前该用的组下标（不推进游标）。 */
  currentGroupOf(account: string): number | undefined {
    const ordinals = this.ordinalsByAccount.get(account);
    if (ordinals === undefined || ordinals.length === 0) return undefined;
    const cursor = this.groupCursor.get(account) ?? 0;
    return ordinals[((cursor % ordinals.length) + ordinals.length) % ordinals.length];
  }

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
  step(exclude?: ReadonlySet<string>): { groupIndex: number; key: string } | undefined {
    const total = this.accountOrder.length;
    if (total === 0) return undefined;
    const now = this.now();
    for (let hop = 0; hop < total; hop += 1) {
      const account = this.accountOrder[this.accountCursor];
      this.accountCursor = (this.accountCursor + 1) % total;
      if (account === undefined) continue;
      const ordinals = this.ordinalsByAccount.get(account);
      if (ordinals === undefined || ordinals.length === 0) continue;
      const cursor = this.groupCursor.get(account) ?? 0;
      const groupIndex = ordinals[cursor % ordinals.length];
      if (groupIndex === undefined) continue;
      const group = this.groups[groupIndex];
      if (group === undefined || group.keys.length === 0) continue;
      if (Math.max(group.nextAvailableAt, group.cooldownUntil) > now && group.pending === 0) continue;
      // 组内按 lastKeyIndex 轮转（与改造前的 pickStart 一致）：成功请求也要摊到
      // 组内各把 key 上，否则只有第 1 把被反复使用，其余三把永远轮不到。
      const size = group.keys.length;
      for (let offset = 1; offset <= size; offset += 1) {
        const keyIndex = (group.lastKeyIndex + offset + size) % size;
        const key = group.keys[keyIndex];
        if (key === undefined) continue;
        if (exclude !== undefined && exclude.has(key)) continue;
        if (this.#isAccountCooled(key, now)) continue;
        group.lastKeyIndex = keyIndex;
        this.groupCursor.set(account, (cursor + 1) % ordinals.length);
        return { groupIndex, key };
      }
    }
    return undefined;
  }

  /** 请求入口取 key（走一步轮转）。 */
  pickStart(exclude?: ReadonlySet<string>): string | undefined {
    return this.step(exclude)?.key;
  }

  /** 429 后换一组再试（同一步轮转，天然落到下一个账户）。 */
  pickNext(exclude?: ReadonlySet<string>): string | undefined {
    return this.step(exclude)?.key;
  }

  /** 429 后换组：同时给出组号与 key（adapter 固定间隔路径用）。 */
  pickNextSlot(exclude?: ReadonlySet<string>): { groupIndex: number; key: string } | undefined {
    return this.step(exclude);
  }

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
  pickWithinGroup(groupIndex: number, exclude?: ReadonlySet<string>): string | undefined {
    const group = this.groups[groupIndex];
    if (group === undefined) return undefined;
    const now = this.now();
    // 本轮已结束且还在定时窗口内 ⇒ 该组不可再取（这是「组间定时」的强制执行点）。
    if (Math.max(group.nextAvailableAt, group.cooldownUntil) > now) return undefined;
    for (let index = 0; index < group.keys.length; index += 1) {
      const key = group.keys[index];
      if (key === undefined) continue;
      if (exclude !== undefined && exclude.has(key)) continue;
      if (this.#isAccountCooled(key, now)) continue;
      group.lastKeyIndex = index;
      return key;
    }
    return undefined;
  }

  /** 开始一轮组使用：记录起始时刻（已有进行中的一轮则不覆盖）。 */
  beginGroup(groupIndex: number): void {
    const group = this.groups[groupIndex];
    if (group === undefined) return;
    if (group.usedStartedAt === 0) group.usedStartedAt = this.now();
  }

  /**
   * 结束一轮组使用：置 `nextAvailableAt = max(now, usedStartedAt + gapMs)`。
   *
   * 这就是「组间定时」的实现 —— 一轮只花了 3 秒也要补到 gapMs，
   * 从而保证「轮回到本组」时已经过了 gapMs ×（组数−1）。
   *
   * @returns 实际补齐后的下次可用时刻
   */
  finishGroup(groupIndex: number, gapMs: number): number {
    const group = this.groups[groupIndex];
    if (group === undefined) return 0;
    // 幂等：本轮已经结束过（usedStartedAt 已清）就直接返回，不重新计时。
    // 否则反复调用会把 nextAvailableAt 越推越远，形成「永远等不到」的死锁。
    if (group.usedStartedAt === 0) return group.nextAvailableAt;
    const now = this.now();
    const target = group.usedStartedAt + Math.max(0, gapMs);
    group.nextAvailableAt = Math.max(now, target);
    group.usedStartedAt = 0;
    return group.nextAvailableAt;
  }

  /**
   * 按账户轮转序「窥视」下一个可用组（不推进任何游标）。
   *
   * 用于日志 / 诊断：真正取 key 走 step()（会推进游标）。
   *
   * @returns 组下标；undefined = 所有组都还没到点
   */
  pickAvailableGroup(now: number = this.now()): number | undefined {
    const total = this.accountOrder.length;
    if (total === 0) return undefined;
    for (let hop = 0; hop < total; hop += 1) {
      const account = this.accountOrder[(this.accountCursor + hop) % total];
      if (account === undefined) continue;
      const ordinals = this.ordinalsByAccount.get(account);
      if (ordinals === undefined || ordinals.length === 0) continue;
      const cursor = this.groupCursor.get(account) ?? 0;
      const index = ordinals[cursor % ordinals.length];
      if (index === undefined) continue;
      const group = this.groups[index];
      if (group === undefined || group.keys.length === 0) continue;
      const readyAt = Math.max(group.nextAvailableAt, group.cooldownUntil);
      if (readyAt > now) continue;
      return index;
    }
    return undefined;
  }

  /**
   * 距离「最早有一组可用」还要多久（毫秒）。
   *
   * 用于把所有组都试完后给宿主一个准确的 pra —— 不再拍脑袋固定 20s，
   * 而是「最早那个组的 nextAvailableAt 减现在」。
   */
  earliestAvailableIn(now: number = this.now()): number {
    let best = Number.POSITIVE_INFINITY;
    for (const group of this.groups) {
      if (group.keys.length === 0) continue;
      const readyAt = Math.max(group.nextAvailableAt, group.cooldownUntil);
      if (readyAt < best) best = readyAt;
    }
    if (!Number.isFinite(best)) return 0;
    return Math.max(0, best - now);
  }

  /**
   * 查询某 key 的组上下文（adapter 日志与全池冷却快返判定用）。
   *
   * @returns undefined=该 key 不属任何组（配置关闭或未 seed）⇒ 调用方走原 keyPool 路径。
   */
  watchKey(key: string): KeyGroupInfo | undefined {
    const index = this.keyToGroup.get(key);
    if (index === undefined) return undefined;
    const group = this.groups[index];
    if (group === undefined) return undefined;
    const allCooled = this.groups.length > 0 && !this.#anyKeyAvailable(this.now());
    return { groupIndex: index, capacity: group.keys.length, allCooled };
  }

  /**
   * 上报一次限流（组粒度，双层退避）：
   *   1. **本组整组冷却**（组内 all keys 一并冷却，strikes 按组累计，时长走组退避公式）；
   *   2. **账户级联动**：该账户分在其他组的 key 被标记账户级冷却（时长取组退避第一档，
   *      不再按他们各自的组 strikes 重复翻倍）——防止「换组后同一账户再撞 429」空转。
   * 返回本次命中的组信息（供 adapter/index 日志与轮换）。
   */
  reportRateLimit(input: GroupRateLimitInput): GroupRateLimitReport {
    const now = this.now();
    const cfg = this.cfg();
    const ownIndex = this.keyToGroup.get(input.key);
    const ownGroup = ownIndex !== undefined ? this.groups[ownIndex] : undefined;
    // 1. 本组整组退避
    let cooldownUntil = 0;
    let strikes = 0;
    if (ownGroup !== undefined) {
      const nextStrikes = ownGroup.strikes + 1;
      ownGroup.strikes = nextStrikes;
      const delay = groupCooldownMs(nextStrikes, cfg, this.random);
      ownGroup.cooldownUntil = now + delay;
      cooldownUntil = ownGroup.cooldownUntil;
      strikes = nextStrikes;
    }
    // 2. 账户级联动：同账户的其他 key 所在组 → 该账户在这些组内被标记冷却（第一档时长）。
    const account = this.keyToAccount.get(input.key);
    if (account !== undefined) {
      const siblingKeys = this.accountKeys.get(account);
      if (siblingKeys !== undefined) {
        const accountDelay = groupCooldownMs(1, cfg, this.random);
        for (const sibling of siblingKeys) {
          const index = this.keyToGroup.get(sibling);
          if (index === undefined || index === ownIndex) continue; // 本组已整冷，无需再标
          const group = this.groups[index];
          if (group === undefined) continue;
          group.accountCooldown.set(account, now + accountDelay);
        }
      }
    }
    return { groupIndex: ownIndex ?? -1, cooldownUntil, strikes };
  }

  /** 在途请求计数（pending_cooldown：在途请求会造成瞬时压力，不应在它还在飞时判冷却）。 */
  markPending(key: string, delta: 1 | -1): void {
    const index = this.keyToGroup.get(key);
    if (index === undefined) return;
    const group = this.groups[index];
    if (group === undefined) return;
    group.pending = Math.max(0, group.pending + delta);
  }

  /**
   * 成功是池已恢复的最强证据：清除本组整组冷却与连击，并**对称地**清除该账户
   * 在所有组的账户级冷却（该账户能打出成功 ⇒ 账户已恢复，兄弟组里对它的标记一并撤销）。
   */
  onSuccess(key: string): void {
    const ownIndex = this.keyToGroup.get(key);
    if (ownIndex !== undefined) {
      const group = this.groups[ownIndex];
      if (group !== undefined) {
        group.cooldownUntil = 0;
        group.strikes = 0;
      }
    }
    const account = this.keyToAccount.get(key);
    if (account === undefined) return;
    for (const group of this.groups) {
      group.accountCooldown.delete(account);
    }
  }

  /** 401 永久移除：从组内摘除该 key（组仍保留其余 key）。 */
  remove(key: string): void {
    const index = this.keyToGroup.get(key);
    if (index === undefined) return;
    const group = this.groups[index];
    if (group !== undefined) {
      const filtered = group.keys.filter((candidate) => candidate !== key);
      this.groups[index] = { ...group, keys: filtered };
    }
    this.keyToGroup.delete(key);
    const account = this.keyToAccount.get(key);
    if (account !== undefined) {
      this.accountKeys.get(account)?.delete(key);
      this.keyToAccount.delete(key);
    }
  }

  /** 只读快照（日志/测试）。 */
  groupsSnapshot(): KeyGroupSnapshot[] {
    return this.groups.map((group) => ({ ...group, keys: [...group.keys] }));
  }

  /** key → 组索引（供 adapter 构造 gate 键等）。 */
  groupIndexOf(key: string): number | undefined {
    return this.keyToGroup.get(key);
  }

  /** 是否启用组调度（外部 read 用）。 */
  enabled(): boolean {
    return this.cfg().enabled;
  }
}

/**
 * AIMD 组间隙控制器（方向 2）：
 *   gap₀ = initialGroupGapMs；
 *   任何组撞 429 → gap = min(gap × groupGapMultiplier, groupGapMaxMs)；
 *   距上次 429 超过 recoverWindowMs 且发生一次成功 → gap = max(gap × groupGapRecoverFactor, groupGapMinMs)。
 */
export class GroupGapController {
  private readonly cfg: () => ResolvedGroupScheduling;
  private readonly now: () => number;
  private gap: number;
  private lastHitAt: number;
  private lastDecayAt: number;

  constructor(deps: { config: () => GroupSchedulingConfig | undefined; now?: () => number }) {
    this.cfg = () => resolvedGroupScheduling(deps.config());
    this.now = deps.now ?? Date.now;
    this.gap = this.cfg().initialGroupGapMs;
    this.lastHitAt = -Infinity;
    this.lastDecayAt = -Infinity;
  }

  /** 当前目标组间隙（毫秒）。 */
  gapMs(): number {
    return this.gap;
  }

  /** 撞 429：放大组间隙（上限封顶），记录本次撞击时间。 */
  recordHit(now?: number): number {
    const at = now ?? this.now();
    const cfg = this.cfg();
    this.gap = Math.round(Math.min(this.gap * cfg.groupGapMultiplier, cfg.groupGapMaxMs));
    this.lastHitAt = at;
    return this.gap;
  }

  /**
   * 成功：距上次 429 超过 recoverWindowMs 且距上次衰减也超过该窗口时，按衰减因子
   * 缩小 gap（下限封底）——每窗口至多衰减一次，天然防抖。
   * 返回更新后的 gap（未触发衰减时原样返回）。
   */
  recordSuccess(now?: number): number {
    const at = now ?? this.now();
    const cfg = this.cfg();
    if (at - this.lastHitAt >= cfg.recoverWindowMs && at - this.lastDecayAt >= cfg.recoverWindowMs) {
      this.gap = Math.round(Math.max(this.gap * cfg.groupGapRecoverFactor, cfg.groupGapMinMs));
      this.lastDecayAt = at;
    }
    return this.gap;
  }

  /** 重置到初始 gap（配置变更 apply 重建时用）。 */
  reset(): void {
    this.gap = this.cfg().initialGroupGapMs;
    this.lastHitAt = -Infinity;
    this.lastDecayAt = -Infinity;
  }
}

/** 组键命名（gate.acquire 第一参数）：`group:3`。 */
export function groupGateKey(index: number): string {
  return `${GROUP_KEY_PREFIX}${index}`;
}