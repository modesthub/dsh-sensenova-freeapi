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
});

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
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
  /** 组游标（下一请求优先考虑的组；pickNext 环回推进）。 */
  private cursor = 0;

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
  seed(groups: readonly (readonly string[])[], accountOf?: (key: string) => string | undefined): string[] {
    const dropped: string[] = [];
    // 重建 key→组 映射要与现有组保持一致：只处理「本次传入」的组，不碰旧组的键。
    const fresh: KeyGroup[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < groups.length; index += 1) {
      const keys = groups[index];
      if (keys === undefined || keys.length === 0) continue;
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
    this.cursor = clamp(this.cursor, 0, Math.max(0, this.groups.length - 1));
    return dropped;
  }

  #existingGroupState(index: number): Pick<KeyGroup, 'cooldownUntil' | 'strikes' | 'pending' | 'lastKeyIndex' | 'accountCooldown'> {
    const prior = this.groups[index];
    if (prior === undefined) return { cooldownUntil: 0, strikes: 0, pending: 0, lastKeyIndex: -1, accountCooldown: new Map() };
    return {
      cooldownUntil: prior.cooldownUntil,
      strikes: prior.strikes,
      pending: prior.pending,
      lastKeyIndex: prior.lastKeyIndex,
      accountCooldown: prior.accountCooldown,
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

  /**
   * 选中「下一把可用 key」：从游标开始环回。
   *   - pickStart（并发交错）：停留在当前组，组内轮转取可用 key；
   *   - pickNext（轮换语义）：跳到下一可用组落位；
   *   两组都会跳过「整组冷却且无在途」的组与「账户级冷却」的 key；
   *   全池无可用 key → undefined（调用方走 fail-fast 快返路径）。
   */
  pickStart(exclude?: ReadonlySet<string>): string | undefined {
    return this.#pick(exclude, false);
  }

  /** 推进组游标到下一可用组（轮换到下一组，避免同一账户连续撞 429 空转）。 */
  pickNext(exclude?: ReadonlySet<string>): string | undefined {
    return this.#pick(exclude, true);
  }

  #pick(exclude: ReadonlySet<string> | undefined, advance: boolean): string | undefined {
    const total = this.groups.length;
    if (total === 0) return undefined;
    const now = this.now();
    // pickNext 从游标的**下一组**开始环回；pickStart 停留在当前组。
    const start = advance ? (this.cursor + 1) % total : this.cursor;
    for (let step = 0; step < total; step += 1) {
      const index = (start + step) % total;
      const group = this.groups[index];
      if (group === undefined) continue;
      const cooling = group.cooldownUntil > now;
      if (cooling && group.pending === 0) continue; // 整组冷却且无在途 ⇒ 跳过
      const keys = group.keys;
      if (keys.length === 0) continue;
      if (advance) {
        // 轮换语义：取该组第一把「可用（不在 exclude、未被账户级冷却）」，落位该组。
        for (let offset = 0; offset < keys.length; offset += 1) {
          const key = keys[offset];
          if (key === undefined) continue;
          if (exclude !== undefined && exclude.has(key)) continue;
          if (this.#isAccountCooled(key, now)) continue;
          this.cursor = index;
          return key;
        }
        continue; // 该组全不可用 ⇒ 试下一组
      }
      // pickStart 语义：组内轮转（上一位的下一位起），逐把检查可用性。
      for (let offset = 1; offset <= keys.length; offset += 1) {
        const keyIndex = (group.lastKeyIndex + offset) % keys.length;
        const key = keys[keyIndex];
        if (key === undefined) continue;
        if (exclude !== undefined && exclude.has(key)) continue;
        if (this.#isAccountCooled(key, now)) continue;
        group.lastKeyIndex = keyIndex;
        return key;
      }
      // 该组 key 全被 exclude/账户冷却排除 ⇒ 尝试下一组（不推进游标）。
    }
    return undefined; // 全池无可用 key ⇒ fail-fast
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