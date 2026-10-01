/**
 * SenseNova provider 的多账号池（host 侧，精简版）。
 *
 * 与参考插件 @mars-sea/dsh-commandcode-provider 的账号池相比，本实现只保留
 * 「401 禁用轮换」这一项能力：429 不做冷却（渠道常态性 RPM 瞬时超限，由宿主
 * 重试层退避后原 key 重试），没有 probeWindow、FiveHourWindowProbe、plan、
 * login 等任何无关功能。
 *
 * 轮换状态以 API key 字符串为键（key 原文永不写日志、不发往任何第三方）。
 * 同一个 key 被多个槽位引用时共享一条状态；key 在凭据服务中被改值后是
 * 新键、状态自然清零。状态只存内存，不持久化，重启后全部恢复可用。
 *
 * 本模块刻意不依赖 cordis：宿主事实一律通过注入 thunk 进入，node 测试可
 * 直接驱动。
 *
 * @module dsh-sensenova-freeapi/accounts
 */
import { LlmError } from '@deepseek-ai/dsh-llm';

/**
 * provider 层允许透传的 Retry-After 上限（毫秒）。
 * fix-sensenova-429-quota-retry（2026-09-04 实测）：TPM 为 60 秒窗口，上限提升到
 * 60000ms（原 3000ms 与配额窗口量级不符）；与 adapter.ts 的本地副本保持一致。
 */
export const PROVIDER_RETRY_AFTER_CAP_MS = 60_000;

/**
 * 拒绝类型：invalid-credential（401）→ 永久禁用；
 * rate-limit 与 quota-exhausted（429）→ 不写任何状态（见 markRejected）。
 */
export type Rejection = 'rate-limit' | 'invalid-credential' | 'quota-exhausted';

/** 单个 key 的轮换状态。目前仅 disabled（401 永久禁用），until 恒为 0。 */
export type RotationState = { kind: 'disabled'; until: 0 };

/** 一个账户槽位：id/label 用于展示与钉选，resolveKey 惰性解析出 key。 */
export interface AccountSlot {
  id: string;
  label: string;
  /**
   * 合法 credential-ref 名（如 `SENSENOVA_API_KEY_2`）。
   *
   * 🔴 2026-09-27 新增：原接口只有 id/label，导致 `ResolvedAccountSpec.ref` 在映射进
   * 槽位时被丢弃 ⇒ 限流日志只能记 sha256 指纹、无法显示「这把 key 是哪个引用」。
   * 它是**环境变量名、不是密钥值**，可以安全地写入日志与设置页。
   */
  ref: string;
  resolveKey: () => Promise<string | undefined>;
}

/** 已解析出 key 的账户（按 key 去重后的服务视图）。 */
export interface ResolvedAccount {
  slot: AccountSlot;
  key: string;
  state: RotationState | undefined;
}

/** 该状态此刻能否服务请求。undefined（从未被拒绝）或非 disabled 视为可用。 */
export function accountUsable(state: RotationState | undefined): boolean {
  return state === undefined || state.kind !== 'disabled';
}

/** 选择此刻应服务的账户：优先 preferredId（可用时），否则首个可用；全部不可用返回 undefined。 */
export function selectActiveAccount(
  accounts: readonly ResolvedAccount[],
  preferredId: string | undefined,
): ResolvedAccount | undefined {
  const usable = accounts.filter((account) => accountUsable(account.state));
  if (preferredId !== undefined && preferredId !== '') {
    const preferred = usable.find((account) => account.slot.id === preferredId);
    if (preferred !== undefined) return preferred;
  }
  return usable[0];
}

/**
 * 解析 HTTP Retry-After（延迟秒数或 HTTP-date）为毫秒；缺失/不可解析返回 undefined。
 * HTTP-date 早于 now 时返回 0（调用方自行丢弃）。
 */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const ms = Math.round(seconds * 1000);
    return Number.isFinite(ms) ? ms : undefined;
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/**
 * 记录一次拒绝。`invalid-credential`（401）永久禁用。
 * `rate-limit` 与 `quota-exhausted`（429，含 quotaRotation 开启时的配额类粘性换 key）
 * 不写任何状态：SenseNova 渠道常态性限流不代表账号异常，任何 429 都不冷却、
 * 不禁用账号（design D1/D5，2026-09-04 实测）；配额类粘性换 key 只选取下一把
 * 可用 key，被拒 key 保持可用。状态写入 `states`（以 key 为键），便于测试直接驱动。
 */
export function markRejected(
  states: Map<string, RotationState>,
  key: string,
  rejection: Rejection,
  _retryAfterMs?: number,
): void {
  if (rejection === 'invalid-credential') {
    states.set(key, { kind: 'disabled', until: 0 });
  }
}

export interface SensenovaAccountPoolDeps {
  /** 全部账户槽位（默认槽 + accounts 槽，无凭据条目由 resolveKey 惰性过滤）。 */
  slots: () => readonly AccountSlot[];
  /** 手动钉选的账户 id；undefined 表示自动（首个可用）。 */
  preferredId?: () => string | undefined;
}

/** SenseNova 多账号池：以 key 为键的轮换状态 + 解析/选择/拒绝。 */
export class SensenovaAccountPool {
  private readonly deps: SensenovaAccountPoolDeps;
  /** 以 API key 为键的轮换状态（key 原文不落日志）。 */
  readonly states = new Map<string, RotationState>();

  constructor(deps: SensenovaAccountPoolDeps) {
    this.deps = deps;
  }

  /** 解析每个槽位的 key 并按 key 去重（首个槽位胜出）；无 key 的槽位被忽略。 */
  async resolvedAccounts(): Promise<ResolvedAccount[]> {
    const out: ResolvedAccount[] = [];
    const seen = new Set<string>();
    for (const slot of this.deps.slots()) {
      const key = await slot.resolveKey();
      if (key === undefined || key === '') continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ slot, key, state: this.states.get(key) });
    }
    return out;
  }

  /**
   * 发放一个可用 key：优先 preferredId（可用时）否则首个可用。
   * 没有任何 key 解析出来 → 返回 undefined（调用方报 MISSING_CREDENTIAL）。
   * 全部不可用（全 disabled，仅 401 产生）→ INVALID_CREDENTIAL。
   * `options.exclude` 跳过某个 key（401 / 配额轮换时排除刚被拒绝的 key）。
   *
   * 🔴 **轮换必须从被排除项的下一个位置开始环回**（2026-09-18 修复）。
   * 旧写法是 `all.filter(k => k.key !== exclude)` 后取首选 —— 排除 default 会选中
   * `account-2`，再排除 `account-2` 又绕回 default（它仍是过滤后列表的首项），
   * 于是**列表首项与第二项之间乒乓，第 3 个及之后的槽位永远轮不到**。
   * 实测证据：用户配了 3 把 key（default / account-2 / account-3，三把哈希互异且
   * 均可用），而 9265 条 429 日志里只出现 **2 个账号指纹**（`f9145012` 4868 次、
   * `8cfe88e5` 4397 次，各占约一半），`account-3` 的指纹 `543bfdaf` **一次都没有**。
   */
  async resolveKey(options?: { exclude?: string }): Promise<{ key: string; slot: AccountSlot } | undefined> {
    const all = await this.resolvedAccounts();
    if (all.length === 0) return undefined;

    // 起点 = 被排除项的下一个下标（环回）。未找到（-1）或无排除项时退回 0 ⇒ 行为与旧版一致。
    const pivot = options?.exclude !== undefined
      ? all.findIndex((account) => account.key === options.exclude) + 1
      : 0;
    const start = ((pivot % all.length) + all.length) % all.length;
    const ordered = start === 0 ? all : [...all.slice(start), ...all.slice(0, start)];

    const candidates = options?.exclude !== undefined
      ? ordered.filter((account) => account.key !== options.exclude)
      : ordered;
    if (candidates.length === 0) return undefined;
    const chosen = selectActiveAccount(candidates, this.deps.preferredId?.());
    if (chosen !== undefined) return { key: chosen.key, slot: chosen.slot };

    // 全部不可用：只有 401 禁用一种状态（429 不再产生冷却，不会走到这里之外的状态）。
    throw new LlmError(
      `llm-sensenova: every configured SenseNova account (${all.length}) was rejected with 401 — check the stored API keys；已配置的 ${all.length} 个 SenseNova 账户密钥均被拒绝（401）——请在设置页检查存储的 API 密钥`,
      'INVALID_CREDENTIAL',
    );
  }

  /** 记录一次拒绝（委托给模块级 markRejected，共享同一状态 Map）。 */
  markRejected(key: string, rejection: Rejection, retryAfterMs?: number): void {
    markRejected(this.states, key, rejection, retryAfterMs);
  }
}
