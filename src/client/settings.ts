/**
 * SenseNova 设置页的领域层（无 JSX）：把 `llm-sensenova` 设置命名空间与
 * credentials 域桥接到页面状态。宿主是唯一事实来源，保存即热生效。
 *
 * 与 @mars-sea/dsh-commandcode-provider 的 SettingsController 同构，但只保留
 * 多账户配置所需的最小面：apiBase、默认凭据引用 apiKeyEnv、accounts 增删与
 * activeAccount 单选；API key 一律经 credentials 域写入（credential-ref），
 * 页面不回显明文。
 */

/** 设置命名空间与 provider 路由（与冻结契约一致）。 */
export const SENSENOVA_NS = 'llm-sensenova';
export const SENSENOVA_ROUTE = 'sensenova';
export const SENSENOVA_DISPLAY_NAME = 'SenseNova';

/** 默认 apiBase 与默认凭据环境变量。 */
export const DEFAULT_API_BASE = 'https://token.sensenova.cn/v1';
export const DEFAULT_API_KEY_ENV = 'SENSENOVA_API_KEY';
/** 默认每 key 并发生成请求上限（并发闸缺省值）。 */
export const DEFAULT_CONCURRENCY = 1;
/** 默认关闭「配额类 429 换 key」（尊重既有「429 不换 key」决策，见 design D5）。 */
export const DEFAULT_QUOTA_ROTATION = false;

/**
 * 并发闸排队等待上限的缺省值（毫秒）＝ host 侧 `DEFAULT_QUEUE_TIMEOUT_MS`。
 * ⚠️ client bundle 无法 import host 模块，改动 `concurrency.ts` 时须同步这里。
 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;

/** `queueTimeoutMs` 的界面下限，与 host schema 的 `z.natural().min(1_000)` 对齐。 */
export const QUEUE_TIMEOUT_MIN_MS = 1_000;

/**
 * 默认开启限流事件记录器 ＝ host 侧 `Config.errorLog` 的 `.default(true)`。
 * 注意语义与 {@link DEFAULT_QUOTA_ROTATION} **相反**：这里"缺省即开启"，
 * 因此归一化只在显式读到 `false` 时才关闭（见 {@link normalizeErrorLog}）。
 */
export const DEFAULT_ERROR_LOG = true;

/** 把并发上限输入归一化为正整数（非法/无法解析回退默认 1）。 */
export function normalizeConcurrency(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed >= 1) return parsed;
  }
  return DEFAULT_CONCURRENCY;
}

/** 把 quotaRotation 存储值归一化为布尔（仅严格 true 视为开，其余回退默认关）。 */
export function normalizeQuotaRotation(value: unknown): boolean {
  return value === true ? true : DEFAULT_QUOTA_ROTATION;
}

/**
 * 把 errorLog 存储值归一化为布尔。语义与 {@link normalizeQuotaRotation} 相反：
 * 缺省为**开**，因此仅显式 `false` 才关闭；未配置（undefined）视为开。
 */
export function normalizeErrorLog(value: unknown): boolean {
  return value === false ? false : DEFAULT_ERROR_LOG;
}

/** 把排队超时输入归一化为 ≥ 1s 的整数毫秒（非法/过小回退缺省 60s）。 */
export function normalizeQueueTimeoutMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= QUEUE_TIMEOUT_MIN_MS) {
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= QUEUE_TIMEOUT_MIN_MS) return parsed;
  }
  return DEFAULT_QUEUE_TIMEOUT_MS;
}

// ── 错误记录（诊断区块，2026-09-18）───────────────────────────────────────

/**
 * 错误记录只读路由。⚠️ 与 host 侧 `error-log-api.ts` 的 `ERROR_LOG_ROUTE`
 * **必须同值** —— client bundle 无法 import host 模块，改动时两边一起改。
 */
export const ERROR_LOG_ROUTE = '/api/sensenova/errorLog';

// ── 「当前模型 + 全部参数」面板（只读，2026-09-23 Phase 5）────────────────

/**
 * 模型信息只读路由。⚠️ 与 host 侧 `model-info-api.ts` 的 `MODEL_INFO_ROUTE`
 * **必须同值** —— client bundle 无法 import host 模块。
 */
export const MODEL_INFO_ROUTE = '/api/sensenova/modelInfo';

/** 一个请求参数的三态可改性：✅可改 / ⚙️插件级默认 / ❌不可改。 */
export type ParamMutability = 'host' | 'l2' | 'none';

/** 一个参数行的展示形状（host 侧 `ModelParamSpec` 的 client 视图）。 */
export interface ModelParamView {
  key: string;
  label: string;
  range: string;
  serverDefault: string;
  hostSupport: 'yes' | 'no';
  l2: boolean;
  note?: string;
  /** 由 hostSupport + l2 派生（host 侧算好，client 不重复判断）。 */
  mutability: ParamMutability;
}

/** 一个模型的事实表（host 侧 `ModelFactSheet` 的 client 视图）。 */
export interface ModelFactView {
  id: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  visionNote?: string;
  textOnlyBehavior?: 'hallucinates' | 'refuses';
  efforts: readonly string[];
  blockedL2Params: readonly string[];
  notes: readonly string[];
}

/** 账户池摘要（host 侧 `AccountPoolSummary` 的 client 视图）。 */
export interface AccountPoolView {
  slots: number;
  refs: readonly string[];
  activeAccount: string;
  quotaRotation: boolean;
}

/** 设置传输层探针（host 侧 `SettingsValueProbe` 的 client 视图）。 */
export interface SettingsProbeView {
  serviceAvailable: boolean;
  accountsInSettings: number;
  namespacesSeen: number;
  writable?: boolean;
  error?: string;
}

/** 模型信息面板的快照（host 侧 `ModelInfoSnapshot` 的 client 视图）。 */
export interface ModelInfoSnapshotView {
  available: boolean;
  error?: string;
  selection?: { provider?: string; model?: string; reasoningEffort?: string };
  accounts?: AccountPoolView;
  settingsProbe?: SettingsProbeView;
  resolved?: {
    name?: string;
    inputModalities?: readonly string[];
    contextWindow?: number;
    defaultMaxTokens?: number;
    efforts?: readonly { id?: string; name?: string; description?: string }[];
    defaultEffort?: string;
  };
  facts?: ModelFactView;
  params: readonly ModelParamView[];
  l2Allowed: readonly string[];
  probedAt: string;
}

/** 模型信息面板的状态机（与错误记录区块同款：idle / loading / ready / error）。 */
export interface ModelInfoState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  snapshot?: ModelInfoSnapshotView;
}

export const IDLE_MODEL_INFO_STATE: ModelInfoState = { status: 'idle' };

/** 把宿主侧「可改性」收敛成三态。host 侧已算好，这里只做形状防御。 */
function mutabilityOf(row: { hostSupport?: unknown; l2?: unknown }): ParamMutability {
  if (row.hostSupport === 'yes') return 'host';
  return row.l2 === true ? 'l2' : 'none';
}

/**
 * 归一化宿主返回的快照。**绝不抛**：字段缺失/类型不符一律取兜底值，
 * 保证面板在旧 host / 数据不完整时只显示"信息不全"而不是崩掉。
 */
export function normalizeModelInfoState(raw: unknown): ModelInfoState {
  if (typeof raw !== 'object' || raw === null) return { status: 'error' };
  const source = raw as Record<string, unknown>;
  const rawParams = Array.isArray(source.params) ? source.params : [];
  const params: ModelParamView[] = [];
  for (const item of rawParams) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.key !== 'string' || row.key === '') continue;
    params.push({
      key: row.key,
      label: typeof row.label === 'string' ? row.label : row.key,
      range: typeof row.range === 'string' ? row.range : '',
      serverDefault: typeof row.serverDefault === 'string' ? row.serverDefault : '',
      hostSupport: row.hostSupport === 'yes' ? 'yes' : 'no',
      l2: row.l2 === true,
      ...(typeof row.note === 'string' && row.note !== '' ? { note: row.note } : {}),
      mutability: mutabilityOf(row),
    });
  }
  // ⚠️ 账户池与 params 在 `available === false` 时**也要保留**：即使用户拿不到
  // "当前默认模型"，"接线了几个账户"仍然是他要看的核心信息（2026-09-24）。
  const rawAccounts = typeof source.accounts === 'object' && source.accounts !== null
    ? (source.accounts as Record<string, unknown>)
    : undefined;
  const accounts: AccountPoolView | undefined = rawAccounts === undefined
    ? undefined
    : {
      slots: typeof rawAccounts.slots === 'number' ? rawAccounts.slots : 0,
      refs: Array.isArray(rawAccounts.refs) ? (rawAccounts.refs as readonly string[]) : [],
      activeAccount: typeof rawAccounts.activeAccount === 'string' ? rawAccounts.activeAccount : '',
      quotaRotation: rawAccounts.quotaRotation === true,
    };
  const resolved = typeof source.resolved === 'object' && source.resolved !== null
    ? (source.resolved as Record<string, unknown>)
    : undefined;
  const selection = typeof source.selection === 'object' && source.selection !== null
    ? (source.selection as Record<string, unknown>)
    : undefined;
  const rawFacts = typeof source.facts === 'object' && source.facts !== null
    ? (source.facts as Record<string, unknown>)
    : undefined;
  const rawProbe = typeof source.settingsProbe === 'object' && source.settingsProbe !== null
    ? (source.settingsProbe as Record<string, unknown>)
    : undefined;
  const settingsProbe: SettingsProbeView | undefined = rawProbe === undefined
    ? undefined
    : {
      serviceAvailable: rawProbe.serviceAvailable === true,
      accountsInSettings: typeof rawProbe.accountsInSettings === 'number' ? rawProbe.accountsInSettings : -1,
      namespacesSeen: typeof rawProbe.namespacesSeen === 'number' ? rawProbe.namespacesSeen : 0,
      ...(typeof rawProbe.writable === 'boolean' ? { writable: rawProbe.writable } : {}),
      ...(typeof rawProbe.error === 'string' ? { error: rawProbe.error } : {}),
    };
  const snapshot: ModelInfoSnapshotView = {
    available: source.available === true,
    ...(typeof source.error === 'string' ? { error: source.error } : {}),
    ...(accounts !== undefined ? { accounts } : {}),
    ...(settingsProbe !== undefined ? { settingsProbe } : {}),
    ...(selection !== undefined && typeof selection.model === 'string'
      ? {
        selection: {
          ...(typeof selection.provider === 'string' ? { provider: selection.provider } : {}),
          model: selection.model,
          ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
        },
      }
      : {}),
    ...(resolved !== undefined
      ? {
        resolved: {
          ...(typeof resolved.name === 'string' ? { name: resolved.name } : {}),
          ...(Array.isArray(resolved.inputModalities) ? { inputModalities: resolved.inputModalities as readonly string[] } : {}),
          ...(typeof resolved.contextWindow === 'number' ? { contextWindow: resolved.contextWindow } : {}),
          ...(typeof resolved.defaultMaxTokens === 'number' ? { defaultMaxTokens: resolved.defaultMaxTokens } : {}),
          ...(Array.isArray(resolved.efforts)
            ? {
              efforts: (resolved.efforts as { id?: unknown; name?: unknown; description?: unknown }[]).map((row) => ({
                ...(typeof row.id === 'string' ? { id: row.id } : {}),
                ...(typeof row.name === 'string' ? { name: row.name } : {}),
                ...(typeof row.description === 'string' ? { description: row.description } : {}),
              })),
            }
            : {}),
          ...(typeof resolved.defaultEffort === 'string' ? { defaultEffort: resolved.defaultEffort } : {}),
        },
      }
      : {}),
    ...(rawFacts !== undefined
      ? {
        facts: {
          id: typeof rawFacts.id === 'string' ? rawFacts.id : '',
          displayName: typeof rawFacts.displayName === 'string' ? rawFacts.displayName : '',
          contextWindow: typeof rawFacts.contextWindow === 'number' ? rawFacts.contextWindow : 0,
          maxOutputTokens: typeof rawFacts.maxOutputTokens === 'number' ? rawFacts.maxOutputTokens : 0,
          vision: rawFacts.vision === true,
          ...(typeof rawFacts.visionNote === 'string' ? { visionNote: rawFacts.visionNote } : {}),
          ...(rawFacts.textOnlyBehavior === 'hallucinates' || rawFacts.textOnlyBehavior === 'refuses'
            ? { textOnlyBehavior: rawFacts.textOnlyBehavior }
            : {}),
          efforts: Array.isArray(rawFacts.efforts) ? (rawFacts.efforts as readonly string[]) : [],
          blockedL2Params: Array.isArray(rawFacts.blockedL2Params) ? (rawFacts.blockedL2Params as readonly string[]) : [],
          notes: Array.isArray(rawFacts.notes) ? (rawFacts.notes as readonly string[]) : [],
        },
      }
      : {}),
    params,
    l2Allowed: Array.isArray(source.l2Allowed) ? (source.l2Allowed as readonly string[]) : [],
    probedAt: typeof source.probedAt === 'string' ? source.probedAt : '',
  };
  return { status: 'ready', snapshot };
}

/** 区块一次展示的条数（host 侧上限 200，这里够看一屏即可，避免拖长页面）。 */
export const ERROR_LOG_PREVIEW_LIMIT = 20;

/** 一条错误记录（与 host 侧 `ErrorLogEntry` 同形）。 */
export interface ErrorLogEntryView {
  ts: string;
  model: string;
  code: string;
  /** `'rate'`（code 8）/ `'rpm'`（请求数限流）/ `'tpm'`（token 限流）/ `''`。 */
  kind: string;
  rotated: boolean;
  attempt: number;
  message: string;
  retryFloorMs?: number;
  providerRetryAfterMs?: number;
  /** 探测档位索引（0 起）；仅 rpm/tpm 有。长期停在最大值 = 档位锁死。 */
  probeHits?: number;
  /** 本 key 是否因本次命中被踢出运行态（取代已移除的 `saturated`，2026-09-27）。 */
  kicked?: boolean;
  /** 事件产生时 key 池的运行态把数（2026-09-27）。 */
  poolRunning?: number;
  /** 事件产生时 key 池的阻塞态把数（2026-09-27）。 */
  poolBlocked?: number;
  /** 可读账户名（2026-09-27 新增，列表「账户」列）。 */
  accountLabel?: string;
  /** credential-ref 名（2026-09-27 新增，列表「API」列）。 */
  accountRef?: string;
  /** key 指纹（sha256 前 8 位）。 */
  account: string;
}

export interface ErrorLogState {
  /** `idle` = 尚未拉取（区块默认状态：**不自动请求**，打开设置页不产生额外 I/O）。 */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** 日志文件是否存在。false = 从未发生过限流，**属正常**（文件是懒创建的）。 */
  available: boolean;
  /** 日志文件绝对路径（展示给用户，方便直接去 tail）。 */
  path: string;
  /** 统计窗口（毫秒）。 */
  windowMs: number;
  total: number;
  distinctCodes: number;
  distinctModels: number;
  entries: ErrorLogEntryView[];
  /** 日志文件超出 host 读取上限时为 true（统计口径随之收窄）。 */
  truncated: boolean;
  /** 展开的行下标（一次只展开一条）；null = 全部收起。 */
  expandedRow: number | null;
}

export const IDLE_ERROR_LOG_STATE: ErrorLogState = {
  status: 'idle',
  available: false,
  path: '',
  windowMs: 24 * 60 * 60 * 1000,
  total: 0,
  distinctCodes: 0,
  distinctModels: 0,
  entries: [],
  truncated: false,
  expandedRow: null,
};

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 把路由返回的 JSON 归一化为区块状态（纯函数）。
 *
 * 与 host 侧同一原则：**坏数据只降级、绝不抛** —— 这块是辅助信息，不能让设置页崩。
 * 服务端已经做过一次字段裁剪，这里再兜一次是为了防止"host 升级了、client 还是旧包"
 * 这种版本错配（插件以 `link:` 挂载，两侧产物可能不同步）。
 */
export function normalizeErrorLogState(
  raw: unknown,
  expandedRow: number | null = null,
): ErrorLogState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...IDLE_ERROR_LOG_STATE, status: 'error', expandedRow };
  }
  const record = raw as Record<string, unknown>;
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const entries: ErrorLogEntryView[] = [];
  for (const item of rawEntries) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    entries.push({
      ts: textOf(entry.ts),
      model: textOf(entry.model),
      code: textOf(entry.code),
      kind: textOf(entry.kind),
      rotated: entry.rotated === true,
      attempt: numberOf(entry.attempt),
      message: textOf(entry.message),
      ...(typeof entry.retryFloorMs === 'number' ? { retryFloorMs: entry.retryFloorMs } : {}),
      ...(typeof entry.providerRetryAfterMs === 'number'
        ? { providerRetryAfterMs: entry.providerRetryAfterMs }
        : {}),
      ...(typeof entry.probeHits === 'number' ? { probeHits: entry.probeHits } : {}),
      ...(typeof entry.kicked === 'boolean' ? { kicked: entry.kicked } : {}),
      ...(typeof entry.poolRunning === 'number' ? { poolRunning: entry.poolRunning } : {}),
      ...(typeof entry.poolBlocked === 'number' ? { poolBlocked: entry.poolBlocked } : {}),
      ...(typeof entry.accountLabel === 'string' && entry.accountLabel !== ''
        ? { accountLabel: entry.accountLabel }
        : {}),
      ...(typeof entry.accountRef === 'string' && entry.accountRef !== ''
        ? { accountRef: entry.accountRef }
        : {}),
      account: textOf(entry.account),
    });
  }
  return {
    status: 'ready',
    available: record.available === true,
    path: textOf(record.path),
    windowMs: numberOf(record.windowMs) || IDLE_ERROR_LOG_STATE.windowMs,
    total: numberOf(record.total),
    distinctCodes: numberOf(record.distinctCodes),
    distinctModels: numberOf(record.distinctModels),
    entries,
    truncated: record.truncated === true,
    // 刷新后条数可能变少 ⇒ 越界的展开下标要收回，否则会"卡"在已不存在的行上。
    expandedRow: expandedRow !== null && expandedRow < entries.length ? expandedRow : null,
  };
}

// ── 重试策略（2026-09-17 W1）─────────────────────────────────────────────

/**
 * `maxDelayMs` 的界面硬下限（毫秒）＝ host 侧 `QUOTA_RETRY_AFTER_CEILING_MS`。
 *
 * ⚠️ 这是本页最不"可调"的参数，原因：宿主 `dsh-llm-retry` 对
 * `providerRetryAfterMs > policy.maxDelayMs` 的处理是**直接放弃重试**
 * （`return next()`，不是夹到上限）⇒ 把上限调到低于适配器能吐出的 pra 上限
 * 会制造"死亡区"：落入其中的限流请求不会等待，而是让**整个回合立即失败**。
 * 这是纯负收益配置，因此界面上不接受更小的值（host 侧 `mergeRetryPolicy`
 * 还有第二道兜底）。允许**调大**。
 *
 * 与 host 常量的同步关系：改动 `adapter.ts` 的 `QUOTA_RETRY_AFTER_CEILING_MS`
 * 时必须同步这里（client bundle 无法 import host 模块）。
 */
export const RETRY_MAX_DELAY_FLOOR_MS = 300_000;

/** 重试策略的可编辑形状（页面以字符串草稿呈现，保存时才归一化为数字）。 */
export interface RetryPolicyDraft {
  mode: 'normal' | 'always';
  maxRetries: string;
  maxDelayMs: string;
  initialDelayMs: string;
  jitterRatio: string;
}

/** 可编辑的数字字段（mode 走单独的单选方法）。 */
export type RetryNumberField = 'maxRetries' | 'maxDelayMs' | 'initialDelayMs' | 'jitterRatio';

/** 缺省草稿：与 host 侧 `DEFAULT_RETRY_POLICY_CONFIG` 的数值保持一致。 */
export const DEFAULT_RETRY_DRAFT: RetryPolicyDraft = {
  mode: 'normal',
  maxRetries: '24',
  maxDelayMs: String(RETRY_MAX_DELAY_FLOOR_MS),
  initialDelayMs: '500',
  jitterRatio: '0.1',
};

function numberText(value: unknown, fallback: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback;
}

/** 从设置快照的 `retryPolicy` 读出草稿；缺失或非法时回退缺省。 */
export function normalizeRetryPolicyDraft(raw: unknown): RetryPolicyDraft {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_RETRY_DRAFT;
  const record = raw as Record<string, unknown>;
  const rawBackoff = record.backoff;
  const backoff =
    typeof rawBackoff === 'object' && rawBackoff !== null && !Array.isArray(rawBackoff)
      ? (rawBackoff as Record<string, unknown>)
      : {};
  return {
    mode: record.mode === 'always' ? 'always' : 'normal',
    maxRetries: numberText(record.maxRetries, DEFAULT_RETRY_DRAFT.maxRetries),
    maxDelayMs: numberText(backoff.maxDelayMs, DEFAULT_RETRY_DRAFT.maxDelayMs),
    initialDelayMs: numberText(backoff.initialDelayMs, DEFAULT_RETRY_DRAFT.initialDelayMs),
    jitterRatio: numberText(backoff.jitterRatio, DEFAULT_RETRY_DRAFT.jitterRatio),
  };
}

function clampNumber(text: string, fallback: number, min: number, max: number): number {
  const trimmed = text.trim();
  // ⚠️ 必须先挡空串：`Number('')` 是 0（有限），否则清空输入框会把值写成 0。
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** `MAX_TIMER_DELAY_MS`（host 侧 `dsh-llm` 的上限）。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 把页面草稿组装成 host schema 接受的 `retryPolicy` 载荷（全量字段）。
 *
 * 全量写入是刻意的：host schema 对每个字段有独立缺省，但**部分写入**会让
 * 未写的字段取 host 缺省（而不是保留用户此前的值）。这里总是带上全部字段，
 * 让"改一项"不会意外重置其他项。
 */
export function buildRetryPolicyPayload(draft: RetryPolicyDraft): Record<string, unknown> {
  return {
    mode: draft.mode === 'always' ? 'always' : 'normal',
    maxRetries: Math.round(clampNumber(draft.maxRetries, 24, 0, 1_000_000)),
    backoff: {
      initialDelayMs: Math.round(clampNumber(draft.initialDelayMs, 500, 1, MAX_TIMER_DELAY_MS)),
      // 防悬崖：与 host 的 mergeRetryPolicy 同向兜底（绝不接受更小的值）。
      maxDelayMs: Math.max(
        Math.round(clampNumber(draft.maxDelayMs, RETRY_MAX_DELAY_FLOOR_MS, 1, MAX_TIMER_DELAY_MS)),
        RETRY_MAX_DELAY_FLOOR_MS,
      ),
      jitterRatio: clampNumber(draft.jitterRatio, 0.1, 0, 1),
    },
  };
}

// ── key 池策略（2026-09-27 新增）────────────────────────────────────────────────
//
// 与 `retryPolicy` 完全同一范式：字符串草稿 → `clampNumber` → 全量载荷。
// 数值范围必须与 host 的 `ConfigSchema.poolPolicy` 和 `normalizePoolPolicy()` 保持一致
// （client bundle 无法 import host 模块，只能手工同步 —— 改一处要同步两处）。

/** key 池策略的可编辑形状（字符串草稿，保存时才归一化为数字）。 */
export interface PoolPolicyDraft {
  kickThreshold: string;
  probeInitialMs: string;
  probeBackoffFactor: string;
  probeMaxMs: string;
  capacity: string;
}

/** 可编辑的数字字段名。 */
export type PoolNumberField = keyof PoolPolicyDraft;

/** 缺省草稿：与 host 侧 `DEFAULT_KEY_POOL_PARAMS` 数值一致。 */
export const DEFAULT_POOL_DRAFT: PoolPolicyDraft = {
  kickThreshold: '2',
  probeInitialMs: '15000',
  probeBackoffFactor: '2',
  probeMaxMs: '60000',
  capacity: '10',
};

/** 从设置快照的 `poolPolicy` 读出草稿；缺失或非法时回退缺省。 */
export function normalizePoolPolicyDraft(raw: unknown): PoolPolicyDraft {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return DEFAULT_POOL_DRAFT;
  const record = raw as Record<string, unknown>;
  return {
    kickThreshold: numberText(record.kickThreshold, DEFAULT_POOL_DRAFT.kickThreshold),
    probeInitialMs: numberText(record.probeInitialMs, DEFAULT_POOL_DRAFT.probeInitialMs),
    probeBackoffFactor: numberText(record.probeBackoffFactor, DEFAULT_POOL_DRAFT.probeBackoffFactor),
    probeMaxMs: numberText(record.probeMaxMs, DEFAULT_POOL_DRAFT.probeMaxMs),
    capacity: numberText(record.capacity, DEFAULT_POOL_DRAFT.capacity),
  };
}

/**
 * 把页面草稿组装成 host schema 接受的 `poolPolicy` 载荷（**全量字段**）。
 *
 * 与 `buildRetryPolicyPayload` 同一理由：全量写入是刻意的，部分写入会让未写的字段取
 * host 缺省（而不是保留用户此前的值），"改一项"就会意外重置其他项。
 */
export function buildPoolPolicyPayload(draft: PoolPolicyDraft): Record<string, unknown> {
  const probeInitialMs = Math.round(clampNumber(draft.probeInitialMs, 15_000, 5_000, 300_000));
  return {
    kickThreshold: Math.round(clampNumber(draft.kickThreshold, 2, 1, 10)),
    probeInitialMs,
    probeBackoffFactor: clampNumber(draft.probeBackoffFactor, 2, 1, 10),
    // 与 host 的 `normalizePoolPolicy` 同向兜底：退避上限不得低于起手间隔。
    probeMaxMs: Math.max(Math.round(clampNumber(draft.probeMaxMs, 60_000, 5_000, 600_000)), probeInitialMs),
    capacity: Math.round(clampNumber(draft.capacity, 10, 1, 10)),
  };
}

/** 可编辑的设置字段。 */
export type FieldName = 'apiBase' | 'apiKeyEnv' | 'activeAccount' | 'concurrency' | 'queueTimeoutMs';

/** accounts 数组元素（与冻结契约一致）。 */
export interface AccountConfig {
  id: string;
  label: string;
  apiKeyEnv: string;
}

/** 设置命名空间中的用户配置形状。 */
export interface SenseNovaConfig {
  apiBase?: string;
  apiKeyEnv?: string;
  accounts?: AccountConfig[];
  activeAccount?: string;
  modelSelection?: { include?: string[]; exclude?: string[] };
  /** 每 key 并发生成请求上限（正整数，默认 1）。 */
  concurrency?: number;
  /** 并发闸排队等待上限（毫秒，≥1000，默认 60000）。 */
  queueTimeoutMs?: number;
  /** 配额类 429 是否粘性换 key（默认 false；开启后 401 行为不变，429 仍不冷却账号）。 */
  quotaRotation?: boolean;
  /** 是否把每次限流落成 JSONL 事件（默认 true，路径见 host `error-log.ts`）。 */
  errorLog?: boolean;
  /**
   * 重试策略（host 侧 `llm-sensenova.retryPolicy`，2026-09-17 W1 起可编辑）。
   * host 的 schema 为每个字段给了字段级缺省，因此读到的一般是完整形状。
   */
  retryPolicy?: {
    mode?: 'normal' | 'always';
    maxRetries?: number;
    backoff?: {
      initialDelayMs?: number;
      maxDelayMs?: number;
      jitterRatio?: number;
    };
  };
  /**
   * key 池策略（host 侧 `llm-sensenova.poolPolicy`，2026-09-27 起可编辑）。
   * 与 `retryPolicy` 一样，host schema 给了字段级缺省 ⇒ 读到的一般是完整形状。
   */
  poolPolicy?: {
    kickThreshold?: number;
    probeInitialMs?: number;
    probeBackoffFactor?: number;
    probeMaxMs?: number;
    capacity?: number;
  };
}

/** credentials 域提供的面（对齐参考实现的 remote.credentials）。 */
export interface CredentialView {
  configured: boolean;
  writable: boolean;
}

export interface CredentialsDescribeResult {
  ok: boolean;
  value?: Record<string, CredentialView>;
}

export interface CredentialsFace {
  describe(refs: string[]): Promise<CredentialsDescribeResult>;
  set(ref: string, value: string): Promise<{ ok: boolean }>;
  unset(ref: string): Promise<{ ok: boolean }>;
}

/** 设置 scope 的最小面（对齐 SettingsScope<T>）。 */
export interface ScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable';
  value: T | undefined;
  base: unknown;
  user: unknown;
  writable: boolean;
  mode: 'host' | 'memory';
}

/**
 * 设置域的最小结构面（本插件自建，不 import harness 类型以维持零运行时依赖）。
 *
 * ⚠️ **它描述的是上游 `@deepseek-ai/dsh-client-ui-settings` 的 `ConfigForm<T>`**
 * （0.1.7 由 `SettingsScope<T>` 改名而来）。自建结构化接口的代价是**上游改签名时
 * `tsc` 不会报警**，所以字段必须与上游逐项对齐、且每次升级都要人工比对：
 *
 * | 上游 `ConfigForm<T>`（0.1.7） | 本接口 |
 * |---|---|
 * | `getSnapshot(): ConfigFormSnapshot<T>` | ✅ |
 * | `subscribe(listener): () => void` | ✅ |
 * | `set(field, value): Promise<boolean>` | ✅ |
 * | `unset(field): Promise<boolean>` | ✅ |
 *
 * `set`/`unset` 的返回类型在 0.1.7 由 `Promise<void>` 变为 **`Promise<boolean>`**
 * （true = 宿主接受，false = 拒绝或跳过；传输失败则 reject）。本插件不读返回值，
 * 但接口写成真实形状才能让"上游再变"时至少有一处显式描述可比对。
 */
export interface SettingsScope<T> {
  getSnapshot(): ScopeSnapshot<T>;
  subscribe(fn: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  unset(field: string): Promise<boolean>;
}

/** 页面渲染用的账户行。 */
export interface AccountView {
  id: string;
  ref: string;
  label: string;
  labelDraft: string;
  keyDraft: string;
  configured: boolean;
  writable: boolean;
  added: boolean;
  clearStaged: boolean;
}

/** 页面渲染用的设置快照（稳定引用，变更时整体替换）。 */
export interface SettingsState {
  available: boolean;
  writable: boolean;
  route: string;
  displayName: string;
  apiBase: string;
  apiBaseDraft: string;
  apiKeyEnv: string;
  apiKeyEnvDraft: string;
  defaultConfigured: boolean;
  defaultWritable: boolean;
  defaultKeyDraft: string;
  defaultClearStaged: boolean;
  accounts: AccountView[];
  activeAccount: string;
  activeAccountDraft: string;
  /** 当前实际生效账户 id（'default' 指默认账户卡，'' 表示无已配置账户）。 */
  effectiveActiveAccountId: string;
  /** 当前实际生效账户的可读标签（用于自动模式下展示「当前: xxx」）。 */
  effectiveActiveAccountLabel: string;
  /** 已配置（有可用密钥）的账户总数（含默认）。 */
  configuredCount: number;
  /** 账户总数（含默认账户，不含未保存新增行）。 */
  totalCount: number;
  concurrency: number;
  concurrencyDraft: string;
  /** 并发闸排队等待上限（毫秒，实际生效值，默认 60000）。 */
  queueTimeoutMs: number;
  /** 排队超时的当前展示值（含未保存 staged，字符串草稿）。 */
  queueTimeoutMsDraft: string;
  /** 配额类 429 粘性换 key 开关（实际生效值，默认 false）。 */
  quotaRotation: boolean;
  /** 开关的当前展示值（含未保存 staged）。 */
  quotaRotationDraft: boolean;
  /** 限流事件记录器开关（实际生效值，默认 true）。 */
  errorLog: boolean;
  /** 记录器开关的当前展示值（含未保存 staged）。 */
  errorLogDraft: boolean;
  /**
   * 错误记录诊断区块的状态（**只读**：不参与 `dirty` / 保存流程，
   * 它展示的是运行数据而不是配置）。命名避开 `errorLog`（已被上面的开关占用）。
   */
  diagnostics: ErrorLogState;
  /**
   * 「当前模型 + 全部参数」面板的状态（**只读**，2026-09-23 Phase 5）。
   * 与 `diagnostics` 同款：不参与 `dirty` / 保存流程，用户点「刷新」才请求。
   */
  modelInfo: ModelInfoState;
  /** 实际生效的重试策略（来自 host 快照；缺失时回退缺省草稿）。 */
  retryPolicy: RetryPolicyDraft;
  /** 重试策略的当前展示值（含未保存 staged）。 */
  retryPolicyDraft: RetryPolicyDraft;
  /** 实际生效的 key 池策略（来自 host 快照；缺失时回退缺省草稿）。 */
  poolPolicy: PoolPolicyDraft;
  /** key 池策略的当前展示值（含未保存 staged）。 */
  poolPolicyDraft: PoolPolicyDraft;
  dirty: boolean;
  saving: boolean;
  failed: boolean;
  savedCount: number;
}

/** 稳定的外部状态订阅源（uSES 兼容，供 slots 的 hooks 注入）。 */
export interface SnapshotStore<T> {
  getSnapshot(): T;
  subscribe(fn: () => void): () => void;
  set(value: T): void;
}

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** 创建一个小型可观察快照 store（参考实现的 createSnapshotStore 精简版）。 */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(value) {
      if (Object.is(value, snapshot)) return;
      snapshot = value;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          console.error('[dsh-sensenova-freeapi] snapshot subscriber failed:', error);
        }
      }
    },
  };
}

/** 与宿主 credentials 的 canonical credential-ref 规则一致（POSIX shell 标识符）。 */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function canonicalCredentialRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed !== '' && CREDENTIAL_REF_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** 从 section 值中读取凭据引用；未配置时回退默认，非法值则视为无凭据。 */
function credentialRefOf(apiKeyEnv: unknown): string | undefined {
  if (apiKeyEnv === undefined) return DEFAULT_API_KEY_ENV;
  return canonicalCredentialRef(apiKeyEnv);
}

/** 从 section 值中读取 apiBase（空则回退默认）。 */
function apiBaseOf(apiBase: unknown): string {
  return typeof apiBase === 'string' && apiBase.length > 0 ? apiBase : DEFAULT_API_BASE;
}

/** 从 section 值中解析 stored accounts（过滤非法条目）。 */
function storedAccountsOf(raw: unknown): AccountConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: AccountConfig[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const label = record.label;
    const apiKeyEnv = canonicalCredentialRef(record.apiKeyEnv);
    if (apiKeyEnv === undefined) continue;
    out.push({
      id: typeof id === 'string' && id.trim() !== '' ? id.trim() : apiKeyEnv,
      label: typeof label === 'string' && label.trim() !== '' ? label.trim() : apiKeyEnv,
      apiKeyEnv,
    });
  }
  return out;
}

export class SenseNovaSettingsController {
  private readonly scope: SettingsScope<SenseNovaConfig>;
  private readonly credentials: CredentialsFace;

  private stagedApiBase: string | undefined;
  private stagedApiKeyEnv: string | undefined;
  private stagedActiveAccount: string | undefined;
  private stagedConcurrency: string | undefined;
  /** 排队超时的 staged 编辑（字符串草稿，保存时归一化为毫秒数）。 */
  private stagedQueueTimeoutMs: string | undefined;
  private stagedQuotaRotation: boolean | undefined;
  /** 限流事件记录器开关的 staged 编辑。 */
  private stagedErrorLog: boolean | undefined;

  /**
   * 错误记录诊断区块的状态。**独立于配置流程**：不参与 `dirty`、没有 staged ——
   * 它是一次性拉取的运行数据（只读）。放进同一个 controller 只为复用已有的快照
   * 订阅与 publish 链路，免得为一个区块另建一套 store。
   */
  private diagnostics: ErrorLogState = { ...IDLE_ERROR_LOG_STATE };
  private modelInfoState: ModelInfoState = { ...IDLE_MODEL_INFO_STATE };
  /** 重试策略的 staged 编辑（只存被改动的键，保存时与快照值合并成全量载荷）。 */
  private stagedRetry: Partial<RetryPolicyDraft> | undefined;
  /** key 池策略的未保存编辑（与 `stagedRetry` 同一机制）。 */
  private stagedPool: Partial<PoolPolicyDraft> | undefined;

  private defaultKeyDraft = '';
  private defaultClearStaged = false;

  private addedAccounts: AccountConfig[] = [];
  private removedIds = new Set<string>();
  private labelDrafts = new Map<string, string>();
  private keyDrafts = new Map<string, string>();
  private keyClears = new Set<string>();

  private credentialStates = new Map<string, CredentialView>();

  /** 上一次成功 describeAll 查询过的 refs 集合键（去重排序拼接）；用于检测快照替换引入的新 ref。 */
  private describedRefsKey = '';

  private saving = false;
  private failed = false;
  private savedCount = 0;

  private readonly listeners = new Set<() => void>();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(scope: SettingsScope<SenseNovaConfig>, credentials: CredentialsFace) {
    this.scope = scope;
    this.credentials = credentials;
    this.disposers.push(
      scope.subscribe(() => {
        this.publish();
        // 快照替换可能引入新 credential-ref（典型：构造时快照 loading、就绪后 accounts
        // 才可见），集合变化时重查凭据配置状态，避免额外账户残留「未配置」误报。
        this.describeIfRefsChanged();
      }),
    );
    void this.describeAll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.listeners.clear();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 默认账户的凭据引用：优先 staged 草稿，其次 section 值，最后回退默认。 */
  credentialRef(): string | undefined {
    return credentialRefOf(this.stagedApiKeyEnv ?? this.sectionValue('apiKeyEnv'));
  }

  storedAccounts(): AccountConfig[] {
    return storedAccountsOf(this.sectionValue('accounts'));
  }

  /** 当前 section 值（快照未就绪时 undefined）。 */
  private sectionValue(field: keyof SenseNovaConfig): unknown {
    return this.scope.getSnapshot().value?.[field];
  }

  /** 页面状态面。 */
  state(): SettingsState {
    const snapshot = this.scope.getSnapshot();
    const ref = this.credentialRef();
    const defaultView = ref === undefined ? undefined : this.credentialStates.get(ref);
    const accounts = this.effectiveAccounts();
    const apiBase = apiBaseOf(this.sectionValue('apiBase'));
    const apiKeyEnv = credentialRefOf(this.sectionValue('apiKeyEnv')) ?? '';
    const activeAccount = typeof this.sectionValue('activeAccount') === 'string' ? (this.sectionValue('activeAccount') as string) : '';
    const concurrency = normalizeConcurrency(this.sectionValue('concurrency'));
    const queueTimeoutMs = normalizeQueueTimeoutMs(this.sectionValue('queueTimeoutMs'));
    const quotaRotation = normalizeQuotaRotation(this.sectionValue('quotaRotation'));
    const errorLog = normalizeErrorLog(this.sectionValue('errorLog'));
    const retryPolicy = normalizeRetryPolicyDraft(this.sectionValue('retryPolicy'));
    const poolPolicy = normalizePoolPolicyDraft(this.sectionValue('poolPolicy'));
    const effectiveActiveAccountId = this.effectiveActiveAccountId(activeAccount, defaultView?.configured ?? false);
    const effectiveActiveAccountLabel = this.effectiveActiveAccountLabel(effectiveActiveAccountId, accounts);
    const configuredCount = (defaultView?.configured ? 1 : 0) + accounts.filter((a) => a.configured).length;
    const totalCount = 1 + accounts.filter((a) => !a.added).length;

    const dirty =
      this.stagedApiBase !== undefined ||
      this.stagedApiKeyEnv !== undefined ||
      this.stagedActiveAccount !== undefined ||
      this.stagedConcurrency !== undefined ||
      this.stagedQueueTimeoutMs !== undefined ||
      this.stagedQuotaRotation !== undefined ||
      this.stagedErrorLog !== undefined ||
      this.stagedRetry !== undefined ||
      this.stagedPool !== undefined ||
      this.defaultKeyDraft !== '' ||
      this.defaultClearStaged ||
      this.addedAccounts.length > 0 ||
      this.removedIds.size > 0 ||
      this.labelDrafts.size > 0 ||
      this.keyDrafts.size > 0 ||
      this.keyClears.size > 0;

    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      route: SENSENOVA_ROUTE,
      displayName: SENSENOVA_DISPLAY_NAME,
      apiBase,
      apiBaseDraft: this.stagedApiBase ?? apiBase,
      apiKeyEnv,
      apiKeyEnvDraft: this.stagedApiKeyEnv ?? apiKeyEnv,
      defaultConfigured: defaultView?.configured ?? false,
      defaultWritable: defaultView?.writable ?? true,
      defaultKeyDraft: this.defaultKeyDraft,
      defaultClearStaged: this.defaultClearStaged,
      accounts,
      activeAccount,
      activeAccountDraft: this.stagedActiveAccount ?? activeAccount,
      effectiveActiveAccountId,
      effectiveActiveAccountLabel,
      configuredCount,
      totalCount,
      concurrency,
      concurrencyDraft: this.stagedConcurrency ?? String(concurrency),
      queueTimeoutMs,
      queueTimeoutMsDraft: this.stagedQueueTimeoutMs ?? String(queueTimeoutMs),
      quotaRotation,
      quotaRotationDraft: this.stagedQuotaRotation ?? quotaRotation,
      errorLog,
      errorLogDraft: this.stagedErrorLog ?? errorLog,
      diagnostics: this.diagnostics,
      modelInfo: this.modelInfoState,
      retryPolicy,
      retryPolicyDraft: { ...retryPolicy, ...this.stagedRetry },
      poolPolicy,
      poolPolicyDraft: { ...poolPolicy, ...this.stagedPool },
      dirty,
      saving: this.saving,
      failed: this.failed,
      savedCount: this.savedCount,
    };
  }

  /**
   * 计算当前实际生效账户 id：
   * - 显式钉选（activeAccount 非空且指向已保存账户）→ 该 id；
   * - 自动模式 → 默认账户已配置取 'default'，否则第一个已配置账户行 id，均无则 ''。
   * UI 据此展示「活动/当前」标记（运行时 401 禁用后的顺延以实际可用账号为准）。
   */
  private effectiveActiveAccountId(activeAccount: string, defaultConfigured: boolean): string {
    if (activeAccount !== '') {
      const pinned = this.effectiveAccounts().find((a) => a.id === activeAccount);
      if (pinned !== undefined && pinned.configured) return pinned.id;
      // 钉选账户未配置时视为自动。
    }
    if (defaultConfigured) return 'default';
    const firstConfigured = this.effectiveAccounts().find((a) => a.configured);
    return firstConfigured !== undefined ? firstConfigured.id : '';
  }

  /**
   * 当前实际生效账户的可读标签：'default' → 「默认账户」，
   * 其余取账户行 labelDraft（空则回退「账户 N」），无生效则 ''。
   * 用于自动模式下下拉选项与总览条展示「当前: xxx」。
   */
  private effectiveActiveAccountLabel(id: string, accounts: AccountView[]): string {
    if (id === '') return '';
    if (id === 'default') return '默认账户';
    const account = accounts.find((a) => a.id === id);
    if (account === undefined) return id;
    const label = account.labelDraft.trim();
    return label !== '' ? label : `账户 ${accounts.indexOf(account) + 1}`;
  }

  /** 合并 stored（减 staged 删除）与 staged 新增，得到展示用账户行。 */
  private effectiveAccounts(): AccountView[] {
    const stored = this.storedAccounts()
      .filter((a) => !this.removedIds.has(a.id))
      .map((a) => ({ ...a, added: false }));
    const added = this.addedAccounts.map((a) => ({ ...a, added: true }));
    return [...stored, ...added].map((a) => {
      const view = this.credentialStates.get(a.apiKeyEnv);
      return {
        id: a.id,
        ref: a.apiKeyEnv,
        label: a.label,
        labelDraft: this.labelDrafts.get(a.id) ?? a.label,
        keyDraft: this.keyDrafts.get(a.id) ?? '',
        configured: view?.configured ?? false,
        writable: view?.writable ?? true,
        added: a.added,
        clearStaged: this.keyClears.has(a.id),
      };
    });
  }

  // ---- 编辑动作 ----

  edit(field: FieldName, text: string): void {
    if (field === 'apiBase') this.stagedApiBase = text;
    else if (field === 'apiKeyEnv') this.stagedApiKeyEnv = text;
    else if (field === 'activeAccount') this.stagedActiveAccount = text;
    else if (field === 'concurrency') this.stagedConcurrency = text;
    else if (field === 'queueTimeoutMs') this.stagedQueueTimeoutMs = text;
    this.failed = false;
    this.publish();
  }

  editDefaultKey(text: string): void {
    this.defaultKeyDraft = text;
    this.defaultClearStaged = false;
    this.failed = false;
    this.publish();
  }

  toggleDefaultKeyClear(): void {
    this.defaultClearStaged = !this.defaultClearStaged;
    if (this.defaultClearStaged) this.defaultKeyDraft = '';
    this.failed = false;
    this.publish();
  }

  addAccount(): void {
    const usedRefs = new Set<string>([
      ...(this.credentialRef() !== undefined ? [this.credentialRef() as string] : []),
      ...this.storedAccounts().map((a) => a.apiKeyEnv),
      ...this.addedAccounts.map((a) => a.apiKeyEnv),
    ]);
    let n = 2;
    while (usedRefs.has(`${DEFAULT_API_KEY_ENV}_${n}`)) n += 1;
    const apiKeyEnv = `${DEFAULT_API_KEY_ENV}_${n}`;

    const usedIds = new Set<string>([...this.storedAccounts().map((a) => a.id), ...this.addedAccounts.map((a) => a.id)]);
    let k = this.storedAccounts().length + this.addedAccounts.length + 2;
    let id = `account-${k}`;
    while (usedIds.has(id)) {
      k += 1;
      id = `account-${k}`;
    }

    this.addedAccounts.push({ id, label: `账户 ${k}`, apiKeyEnv });
    this.failed = false;
    void this.describeAll();
    this.publish();
  }

  removeAccount(id: string): void {
    const addedIndex = this.addedAccounts.findIndex((a) => a.id === id);
    if (addedIndex >= 0) this.addedAccounts.splice(addedIndex, 1);
    else this.removedIds.add(id);
    this.labelDrafts.delete(id);
    this.keyDrafts.delete(id);
    this.keyClears.delete(id);
    const currentActive = this.sectionValue('activeAccount');
    if (this.stagedActiveAccount === id || (this.stagedActiveAccount === undefined && currentActive === id)) {
      this.stagedActiveAccount = '';
    }
    this.failed = false;
    this.publish();
  }

  editAccountLabel(id: string, text: string): void {
    this.labelDrafts.set(id, text);
    this.failed = false;
    this.publish();
  }

  editAccountKey(id: string, text: string): void {
    this.keyDrafts.set(id, text);
    this.keyClears.delete(id);
    this.failed = false;
    this.publish();
  }

  toggleAccountKeyClear(id: string): void {
    if (this.keyClears.has(id)) this.keyClears.delete(id);
    else {
      this.keyDrafts.delete(id);
      this.keyClears.add(id);
    }
    this.failed = false;
    this.publish();
  }

  /** activeAccount 单选：'' 表示自动（默认账户优先）。 */
  setActiveAccount(id: string): void {
    this.stagedActiveAccount = id;
    this.failed = false;
    this.publish();
  }

  /** 配额类 429 换 key 开关（staged，保存后经 settings 命名空间持久化并热生效）。 */
  setQuotaRotation(on: boolean): void {
    this.stagedQuotaRotation = on;
    this.failed = false;
    this.publish();
  }

  /**
   * 限流事件记录器开关（staged）。
   *
   * host 侧该配置**故意做成 thunk**（`deps.errorLog: () => SenseNovaErrorLog | undefined`），
   * 因此保存后立刻生效、无需重注册适配器；关掉即静默，不影响请求路径。
   */
  setErrorLog(on: boolean): void {
    this.stagedErrorLog = on;
    this.failed = false;
    this.publish();
  }

  /**
   * 拉取错误记录（只读，2026-09-18）。
   *
   * 走 HTTP 路由而不是 settings 通道：诊断数据不是配置 —— 塞进 settings 会污染
   * `settings.yaml`，且每次刷新都产生 revision 变化、误触 `onChange`。同源请求
   * 自带 cookie 鉴权，所以这里无需处理凭据。**不自动调用**（保持 idle，避免打开
   * 设置页就产生 I/O），由用户点「刷新」触发。
   */
  async refreshErrorLog(): Promise<void> {
    if (this.diagnostics.status === 'loading') return;
    this.diagnostics = { ...this.diagnostics, status: 'loading' };
    this.publish();
    try {
      const response = await fetch(`${ERROR_LOG_ROUTE}?limit=${ERROR_LOG_PREVIEW_LIMIT}`, {
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(`llm-sensenova: error log HTTP ${response.status}`);
      this.diagnostics = normalizeErrorLogState(await response.json(), this.diagnostics.expandedRow);
    } catch {
      // 路由缺失（旧 host / 非 web profile）或网络异常 ⇒ 降级为 error 态，由 UI 显示
      // 「暂不可用」。绝不抛：这块是辅助信息，不能影响设置页其余部分。
      this.diagnostics = { ...IDLE_ERROR_LOG_STATE, status: 'error' };
    }
    this.publish();
  }

  /** 展开/收起一条错误记录（再点同一条即收起，一次只开一条）。 */
  toggleErrorLogRow(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.diagnostics.entries.length) return;
    this.diagnostics = {
      ...this.diagnostics,
      expandedRow: this.diagnostics.expandedRow === index ? null : index,
    };
    this.publish();
  }

  /**
   * 拉取「当前模型 + 全部参数」快照（只读，2026-09-23 Phase 5）。
   *
   * 与 `refreshErrorLog()` 完全同一约定：不自动调用（打开设置页不产生 I/O）、
   * 走 HTTP 路由而非 settings 通道、异常一律降级为 error 态**绝不抛**。
   */
  async refreshModelInfo(): Promise<void> {
    if (this.modelInfoState.status === 'loading') return;
    this.modelInfoState = { status: 'loading' };
    this.publish();
    try {
      const response = await fetch(MODEL_INFO_ROUTE, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`llm-sensenova: model info HTTP ${response.status}`);
      this.modelInfoState = normalizeModelInfoState(await response.json());
    } catch {
      // 路由缺失（旧 host / 非 web profile）或网络异常 ⇒ 降级为 error 态。
      this.modelInfoState = { status: 'error' };
    }
    this.publish();
  }

  /** 重试策略：模式单选（staged）。 */
  setRetryMode(mode: 'normal' | 'always'): void {
    this.stagedRetry = { ...this.stagedRetry, mode };
    this.failed = false;
    this.publish();
  }

  /** 重试策略：数字字段编辑（staged，保存时才归一化为数字）。 */
  editRetry(field: RetryNumberField, text: string): void {
    this.stagedRetry = { ...this.stagedRetry, [field]: text };
    this.failed = false;
    this.publish();
  }

  /** key 池策略：数字字段编辑（staged，与 `editRetry` 同一机制）。 */
  editPool(field: PoolNumberField, text: string): void {
    this.stagedPool = { ...this.stagedPool, [field]: text };
    this.failed = false;
    this.publish();
  }

  /** 丢弃所有 staged 编辑。 */
  discard(): void {
    this.stagedApiBase = undefined;
    this.stagedApiKeyEnv = undefined;
    this.stagedActiveAccount = undefined;
    this.stagedConcurrency = undefined;
    this.stagedQueueTimeoutMs = undefined;
    this.stagedQuotaRotation = undefined;
    this.stagedErrorLog = undefined;
    this.stagedRetry = undefined;
    this.stagedPool = undefined;
    this.defaultKeyDraft = '';
    this.defaultClearStaged = false;
    this.addedAccounts = [];
    this.removedIds.clear();
    this.labelDrafts.clear();
    this.keyDrafts.clear();
    this.keyClears.clear();
    this.failed = false;
    this.publish();
  }

  /** 凭据域状态重读（外部写入 key 后刷新已配置/可写徽标）。 */
  async refreshCredentials(): Promise<void> {
    await this.describeAll();
  }

  /** 当前页面涉及的 credential-ref 集合键（默认 ref + stored/added 账户 ref）。 */
  private currentRefsKey(): string {
    const ref = this.credentialRef();
    const refs = new Set<string>([
      ...(ref !== undefined ? [ref] : []),
      ...this.storedAccounts().map((a) => a.apiKeyEnv),
      ...this.addedAccounts.map((a) => a.apiKeyEnv),
    ]);
    return [...refs].sort().join(',');
  }

  /** refs 集合与上次成功查询不同则重查；查询失败保留旧键，下次快照变更自然重试。 */
  private describeIfRefsChanged(): void {
    if (this.currentRefsKey() === this.describedRefsKey) return;
    void this.describeAll();
  }

  /** 查询所有本页涉及的凭据引用的配置状态。 */
  private async describeAll(): Promise<void> {
    const refs = [
      ...(this.credentialRef() !== undefined ? [this.credentialRef() as string] : []),
      ...this.storedAccounts().map((a) => a.apiKeyEnv),
      ...this.addedAccounts.map((a) => a.apiKeyEnv),
    ];
    if (refs.length === 0) {
      this.describedRefsKey = '';
      return;
    }
    let response: CredentialsDescribeResult;
    try {
      response = await this.credentials.describe(refs);
    } catch {
      return;
    }
    if (!response.ok) return;
    this.describedRefsKey = this.currentRefsKey();
    let changed = false;
    for (const ref of refs) {
      const view = response.value?.[ref];
      const next: CredentialView = {
        configured: view?.configured ?? false,
        writable: view?.writable ?? true,
      };
      const prev = this.credentialStates.get(ref);
      if (prev === undefined || prev.configured !== next.configured || prev.writable !== next.writable) {
        this.credentialStates.set(ref, next);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  /** 写入某个凭据引用，然后重读配置状态。 */
  private async writeKeyTo(ref: string, value: string): Promise<boolean> {
    const canonicalRef = canonicalCredentialRef(ref);
    if (canonicalRef === undefined) return false;
    try {
      const result = await this.credentials.set(canonicalRef, value);
      if (!result.ok) return false;
    } catch {
      return false;
    }
    await this.describeAll();
    return this.credentialStates.get(canonicalRef)?.configured ?? false;
  }

  private async unsetKey(ref: string): Promise<boolean> {
    const canonicalRef = canonicalCredentialRef(ref);
    if (canonicalRef === undefined) return false;
    try {
      const result = await this.credentials.unset(canonicalRef);
      if (!result.ok) return false;
    } catch {
      return false;
    }
    await this.describeAll();
    return this.credentialStates.get(canonicalRef)?.configured !== true;
  }

  /** 持久化 accounts 列表。 */
  private async writeAccounts(): Promise<boolean> {
    const base = [
      ...this.storedAccounts().filter((a) => !this.removedIds.has(a.id)),
      ...this.addedAccounts,
    ];
    const seen = new Set<string>();
    const list: AccountConfig[] = [];
    for (const a of base) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      const label = this.labelDrafts.get(a.id)?.trim();
      list.push({
        id: a.id,
        label: label !== undefined && label !== '' ? label : a.label,
        apiKeyEnv: a.apiKeyEnv,
      });
    }
    await this.scope.set('accounts', list);
    return true;
  }

  /** 保存所有 staged 编辑。 */
  async save(): Promise<void> {
    if (this.saving) return;
    const state = this.state();
    if (!state.dirty) return;
    this.saving = true;
    this.failed = false;
    this.publish();

    let landed = true;
    try {
      // 1. 凭据域写入：默认 key、清 key、额外账户 key。
      const defaultRef = this.credentialRef();
      if (this.defaultClearStaged) {
        if (defaultRef === undefined || !(await this.unsetKey(defaultRef))) landed = false;
      } else if (this.defaultKeyDraft.trim() !== '') {
        if (defaultRef === undefined || !(await this.writeKeyTo(defaultRef, this.defaultKeyDraft.trim()))) landed = false;
      }
      for (const id of this.keyClears) {
        const account = this.effectiveAccounts().find((a) => a.id === id);
        if (account !== undefined && !(await this.unsetKey(account.ref))) landed = false;
      }
      for (const [id, text] of this.keyDrafts) {
        const value = text.trim();
        if (value === '' || this.keyClears.has(id)) continue;
        const account = this.effectiveAccounts().find((a) => a.id === id);
        if (account !== undefined && !(await this.writeKeyTo(account.ref, value))) landed = false;
      }

      // 2. 设置字段写入（apiBase / apiKeyEnv / activeAccount / accounts）。
      if (this.stagedApiBase !== undefined) {
        const value = this.stagedApiBase.trim();
        if (value === '') await this.scope.unset('apiBase');
        else await this.scope.set('apiBase', value);
      }
      if (this.stagedApiKeyEnv !== undefined) {
        const canonicalRef = canonicalCredentialRef(this.stagedApiKeyEnv);
        if (this.stagedApiKeyEnv.trim() === '') await this.scope.unset('apiKeyEnv');
        else if (canonicalRef === undefined) landed = false;
        else await this.scope.set('apiKeyEnv', canonicalRef);
      }
      if (this.stagedActiveAccount !== undefined) {
        if (this.stagedActiveAccount === '') await this.scope.unset('activeAccount');
        else await this.scope.set('activeAccount', this.stagedActiveAccount);
      }
      if (this.stagedConcurrency !== undefined) {
        const value = normalizeConcurrency(this.stagedConcurrency);
        await this.scope.set('concurrency', value);
      }
      if (this.stagedQueueTimeoutMs !== undefined) {
        // 过小/非法输入回退缺省 60s（不是回退 1000）：host schema 是 `min(1_000)`，
        // 写一个 1s 的排队上限会让 p90 > 1s 的排队必然超时 = 丢失重试机会。
        await this.scope.set('queueTimeoutMs', normalizeQueueTimeoutMs(this.stagedQueueTimeoutMs));
      }
      if (this.stagedQuotaRotation !== undefined) {
        await this.scope.set('quotaRotation', this.stagedQuotaRotation);
      }
      if (this.stagedErrorLog !== undefined) {
        await this.scope.set('errorLog', this.stagedErrorLog);
      }
      if (this.stagedRetry !== undefined) {
        // 全量写入：只改一项时也要带上其余字段，否则未写的字段会取 host schema
        // 的字段级缺省（等于把用户此前的设置悄悄重置）。`retryPolicy` 是顶层
        // 单字段，`scope.set` 的 path 为 `['retryPolicy']`，整体替换即可
        // （`applyPathOp` 对顶层字段直接 `{...section, retryPolicy: value}`）。
        const merged: RetryPolicyDraft = {
          ...normalizeRetryPolicyDraft(this.sectionValue('retryPolicy')),
          ...this.stagedRetry,
        };
        await this.scope.set('retryPolicy', buildRetryPolicyPayload(merged));
      }
      if (this.stagedPool !== undefined) {
        // 与 `retryPolicy` 同一理由：全量写入，避免"改一项"把其余字段重置成 host 缺省。
        const mergedPool: PoolPolicyDraft = {
          ...normalizePoolPolicyDraft(this.sectionValue('poolPolicy')),
          ...this.stagedPool,
        };
        await this.scope.set('poolPolicy', buildPoolPolicyPayload(mergedPool));
      }
      if (this.addedAccounts.length > 0 || this.removedIds.size > 0 || this.labelDrafts.size > 0) {
        await this.writeAccounts();
      }
    } catch {
      landed = false;
    }

    this.saving = false;
    this.failed = !landed;
    if (landed) {
      this.savedCount += 1;
      this.discard();
    }
    this.publish();
  }

  private publish(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[dsh-sensenova-freeapi] state subscriber failed:', error);
      }
    }
  }
}
