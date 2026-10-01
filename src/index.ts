/**
 * dsh-sensenova-freeapi — DeepSeek Harness 的 SenseNova（OpenAI 兼容）LLM
 * provider 插件（host 侧）。
 *
 * 注册 `sensenova` 路由并声明为可配置 provider（显示名 SenseNova），在 Models
 * 页提供卡片；设置段挂在 `llm-sensenova` 命名空间下，支持共享 `apiBase` 下
 * 的默认账号 + 多账号列表 + 手动钉选（activeAccount）。key 一律通过宿主
 * 凭据服务解析（环境变量兜底），原文不落日志。
 *
 * ```yaml
 * - id: llm-sensenova
 *   name: "dsh-sensenova-freeapi"
 *   config:
 *     apiKeyEnv: SENSENOVA_API_KEY
 * ```
 *
 * `name` 必须是完整包名（加载器按真实包名从 node_modules 解析）；YAML 中以
 * `@` 开头的标量必须加引号。
 *
 * @module dsh-sensenova-freeapi
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-settings';
// 仅为拿到 `ctx.connection` 的类型声明。`import type {}` 会被完全擦除 ⇒ 运行时不引入
// 依赖（本插件的 peerDependencies 里刻意没有它，避免在缺该包的 harness 上加载失败）。
import type {} from '@deepseek-ai/dsh-client-connection';
import {
  LlmError,
  assertUsableApiKey,
  attributionHeaders,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import type {
  NormalRetryPolicyConfig,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm';
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { SensenovaAccountPool, type AccountSlot } from './accounts.ts';
import {
  DEFAULT_RETRY_INITIAL_DELAY_MS,
  DEFAULT_RETRY_JITTER_RATIO,
  DEFAULT_RETRY_MAX_RETRIES,
  DEFAULT_IMAGE_POLICY,
  DEFAULT_RETRY_POLICY_CONFIG,
  QUOTA_RETRY_AFTER_CEILING_MS,
  SensenovaAdapter,
  createResolveImage,
  type ImageAttachmentsLike,
  type ModelSelection,
  type SensenovaRequestParams,
} from './adapter.ts';
import { DEFAULT_QUEUE_TIMEOUT_MS, KeyedConcurrencyGate } from './concurrency.ts';
import { SenseNovaErrorLog } from './error-log.ts';
import {
  DEFAULT_KEY_POOL_PARAMS,
  SensenovaKeyPool,
  type KeyPoolParams,
} from './key-pool.ts';
import { ERROR_LOG_ROUTE, handleErrorLogHttp } from './error-log-api.ts';
import {
  MODEL_INFO_ROUTE,
  handleModelInfoHttp,
  type ModelInfoDeps,
  type ResolvedModelInfoLike,
} from './model-info-api.ts';

export { SensenovaAdapter, DOCUMENTED_VISION_MODELS, DOCUMENTED_TEXT_ONLY_MODELS } from './adapter.ts';

export const name = 'llm-sensenova';
export const inject: string[] = ['llm'];

/** 复用的空集合：`rotateApiKey` 在无 exclude 时不必每次分配。 */
const EMPTY_KEY_SET: ReadonlySet<string> = new Set<string>();
const NS = 'llm-sensenova';
const PROVIDER = 'sensenova';
export const DEFAULT_API_KEY_ENV = 'SENSENOVA_API_KEY';
export const DEFAULT_API_BASE = 'https://token.sensenova.cn/v1';

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
  modelSelection?: { include?: string[]; exclude?: string[] };
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
   * 限流事件记录器开关（2026-09-17 W4 新增，默认开）。
   *
   * 开启时把每一次 429 落成一行 JSONL（`$DSH_HOME/logs/sensenova-errors.jsonl`）：
   * `error.code` / 模型 / 账号指纹 / 退避档位 / 是否轮换 / 时间。异步写入、不阻塞
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
}

/**
 * 重试策略 schema（2026-09-17 W1）。
 *
 * ⚠️ **为什么不用官方的 `RetryPolicySchema`**：它的 `backoff.maxDelayMs` 缺省是
 * `DEFAULT_MAX_DELAY_MS = 10_000`，而本适配器能吐出的 `providerRetryAfterMs`
 * 上限是 `QUOTA_RETRY_AFTER_CEILING_MS = 300_000`。用户在设置页**只要改了任意
 * 一项**（例如只调 `maxRetries`），union 分支就会用它自己的缺省把 `maxDelayMs`
 * 填成 10_000 ⇒ **悬崖立刻重现**（宿主对 `pra > maxDelayMs` 是直接放弃重试，
 * 不是夹到上限）。实测证据：`output/temp/probe-w1.mjs` 用例 ②（只给
 * `maxRetries: 30`，结果 `maxDelayMs` 变成 10000）。
 *
 * 改用**字段级独立缺省**的等价 schema：schemastery 对部分输入做深合并，缺失键
 * 各自取自己的缺省、互不污染（实测 `probe-w1b.mjs` 第三组）。
 *
 * 校验强度不变：`resolveRetryPolicy()` 仍在 `resolveAdapterOptions()` 里做最终
 * 校验（未知键、数值范围、`initialDelayMs ≤ maxDelayMs` 等），非法值照样被拒，
 * 且错误会在设置保存时暴露。`mode` 的 `z.union` 只用于 schema 层校验——
 * 设置页是本插件自写的组件（一个 `<select>`），不走通用 union 渲染。
 */
const RetryPolicyFieldsSchema = z.object({
  mode: z.union([z.const('normal'), z.const('always')]).default('normal'),
  maxRetries: z.natural().min(0).default(DEFAULT_RETRY_MAX_RETRIES),
  backoff: z.object({
    initialDelayMs: z.natural().min(1).default(DEFAULT_RETRY_INITIAL_DELAY_MS),
    // 🛡️ 防悬崖：缺省必须等于适配器能吐出的 pra 上限，**不能**取官方缺省 10_000。
    maxDelayMs: z.natural().min(1).default(QUOTA_RETRY_AFTER_CEILING_MS),
    jitterRatio: z.number().min(0).max(1).default(DEFAULT_RETRY_JITTER_RATIO),
  }),
});

/**
 * 插件配置 schema。
 *
 * 🔴🔴 **2026-09-24 关键修复：每个字段必须 `.volatile()`** —— 否则设置页读不到配置。
 *
 * 机制（`packages/settings/settings/src/schema.ts:37-47` + `index.ts:302-332`）：
 * ```ts
 * describe()      遍历 profile 条目，schema = entry.fiber.runtime.Config
 * volatileForm()  只保留 **meta.volatile === true** 的字段；一个都没有 ⇒ 返回 undefined
 * describe()      volatileForm === undefined ⇒ **整个 namespace 被跳过**（不报错）
 * 客户端           ConfigForms.get(ns) 找不到 view ⇒ status='unavailable'，
 *                 draft.value 永不更新 ⇒ **所有字段回落 schema 默认值**
 * ```
 * 本插件此前**一个字段都没标**（实测 `volatileForm(Config) === undefined`，
 * 且 `settings.describe()` 里 `namespacesSeen = 0`）⇒ 设置卡片显示的一直是默认值，
 * 而不是 patch 里真实配置的账户/并发/重试策略。官方 `llm-deepseek` 全部字段都标了
 * （`packages/llm/llm-deepseek/src/config.ts:93-111`），照抄其写法：
 * **叶子字段 `.default(...).volatile()`；嵌套对象整体 `.volatile()`**。
 *
 * 排查口诀：改了配置"界面不生效 / 显示默认值"时，先查该 namespace 在
 * `settings.describe()` 里是否出现（本插件用 `GET /api/sensenova/modelInfo` 的
 * `settingsProbe.namespacesSeen` 可直接看）。
 */
const ConfigSchema = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  apiBase: z.string().default(DEFAULT_API_BASE).volatile(),
  accounts: z.array(z.object({
    id: z.string().default(''),
    label: z.string().default(''),
    apiKeyEnv: z.string().role('credential-ref').default(''),
  })).default([]).volatile(),
  activeAccount: z.string().default('').volatile(),
  modelSelection: z.object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
  }).volatile(),
  concurrency: z.natural().min(1).default(1).volatile(),
  queueTimeoutMs: z.natural().min(1_000).default(DEFAULT_QUEUE_TIMEOUT_MS).volatile(),
  // 高级设置：「配额类 429 换 key」，默认关（design D5：尊重既有「429 不换 key」决策）。
  quotaRotation: z.boolean().default(false).volatile(),
  // 重试策略（2026-09-17 W1）：可配置，改完保存即生效（无需重建/重启）。
  //
  // ⚠️ 用本地的 `RetryPolicyFieldsSchema` 而非官方 `RetryPolicySchema`——
  // 理由见该 schema 上方的注释（官方 backoff 缺省 10_000 会重新引入悬崖）。
  retryPolicy: RetryPolicyFieldsSchema.volatile(),
  // 限流事件记录器（2026-09-17 W4）：默认开。路径固定为
  // `$DSH_HOME/logs/sensenova-errors.jsonl`（见 error-log.ts）。
  errorLog: z.boolean().default(true).volatile(),
  // key 池策略（2026-09-27 新增）。与 `retryPolicy` 同一范式：嵌套对象**整体** `.volatile()`。
  // 范围依据：探测间隔下限 5s 防高频打网关；上限与 TPM 顶档量级一致；容量上限 10 是
  // 本插件支持的最大账户槽位数（多出的 key 被忽略并 warn 一次）。
  poolPolicy: z.object({
    kickThreshold: z.natural().min(1).max(10).default(DEFAULT_KEY_POOL_PARAMS.kickThreshold),
    probeInitialMs: z.natural().min(5_000).max(300_000).default(DEFAULT_KEY_POOL_PARAMS.probeInitialMs),
    probeBackoffFactor: z.number().min(1).max(10).default(DEFAULT_KEY_POOL_PARAMS.probeBackoffFactor),
    probeMaxMs: z.natural().min(5_000).max(600_000).default(DEFAULT_KEY_POOL_PARAMS.probeMaxMs),
    capacity: z.natural().min(1).max(10).default(DEFAULT_KEY_POOL_PARAMS.capacity),
  }).volatile(),
  // L2 连接级请求参数默认值（2026-09-23 新增）。
  //
  // ⚠️ 子字段**刻意不加 `.default()`**。实测（`schema-probe2.mjs`）schemastery 对
  // 「无 default 的标量字段」会**整个丢弃**（不在输出里出现）⇒ 正好表达"未设置即不注入"；
  // 而「无 default 的嵌套对象」会被物化成 `{}`，这无害 —— `l2ParamsFor()` 的注入判据是
  // `field !== undefined`，空对象自然产不出任何字段。
  //
  // 若给子字段加上 `.default()`（例如 `top_p` 默认 1），schemastery 会把"用户没填"
  // 变成"永远注入 `top_p: 1`" —— 而 kimi-k3 对这类参数是硬拒（400），
  // 等于给该模型装了一个必然失败的开关。
  //
  // ⚠️ 这里的 `.volatile()` 打在**外层对象**上（与官方 `retryPolicy: RetryPolicySchema.volatile()`
  // 同一写法）：`volatileForm()` 见到对象自身 volatile 即整棵子树收下，不再逐层递归。
  requestParams: z.object({
    topP: z.number().min(0).max(1),
    frequencyPenalty: z.number().min(-2).max(2),
    presencePenalty: z.number().min(-2).max(2),
    seed: z.number().min(0).max(9_999_999),
    doSample: z.boolean(),
  }).volatile(),
});

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
export const Config = ConfigSchema as unknown as z<SensenovaConfig>;

/**
 * cordis 的 `Volatile<T>` 在运行期是一个**只带 `get()` 的对象**。
 *
 * 实测形状：`Object.keys(config.accounts)` = `['get']`，`JSON.stringify(config)` 里
 * 每个字段都是 `{}` ⇒ 直接把 `config.accounts` 当下发数组用会读到引用对象。
 *
 * 用**结构化判定**而不是 `@deepseek-ai/cosmokit` 的 `isVolatile()`：本插件的
 * tsdown `external` 白名单里没有 cosmokit（新增值 import 会被**打进产物**）。
 * 本插件的字段类型只有 string/number/boolean/array/plain-object，都不带 `get`
 * 方法，故该判定不会误伤。
 */
function isVolatileRef(value: unknown): value is { get(): unknown } {
  return typeof value === 'object' && value !== null
    && typeof (value as { get?: unknown }).get === 'function';
}

/**
 * 把带 volatile 引用的配置解包成普通值（对齐官方 `llm-deepseek` 的 `plainOptions()`）。
 *
 * 🔴 与 `.volatile()` 配套，缺了它整个插件会读到引用对象。
 *
 * @param config - `apply()` 收到的原始配置（字段可能是 volatile 引用）。
 * @returns 字段全部为普通值的配置，可直接交给 `resolveAdapterOptions()`。
 */
export function plainConfig(config: SensenovaConfig): SensenovaConfig {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as unknown as Record<string, unknown>)) {
    out[key] = isVolatileRef(value) ? value.get() : value;
  }
  return out as SensenovaConfig;
}

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
  modelSelection?: ModelSelection;
}

/** 把配置的并发上限归一化为正整数（非正整数/无法解析回退 1）。 */
export function normalizeConcurrency(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

/** 把配置的排队超时归一化为正整数毫秒；非法值回退 DEFAULT_QUEUE_TIMEOUT_MS。 */
export function normalizeQueueTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_QUEUE_TIMEOUT_MS;
}

/** 整数钳制：非法或越界一律回落缺省，**绝不抛**（与 `normalizeConcurrency` 同一约定）。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

/**
 * 归一化 key 池策略（2026-09-27 新增）。
 *
 * 约定与其它归一化助手一致：**非法值回退缺省，绝不抛** —— 抛会打断设置保存、让整个
 * 设置页卡住（本插件在 `normalizeRequestParams` 处已确立该约定）。
 *
 * 额外维护一条不变量：`probeMaxMs >= probeInitialMs`。否则退避会「越等越短」，与
 * 探测退避的意图正好相反；违反时把 `probeMaxMs` 抬到 `probeInitialMs`。
 */
export function normalizePoolPolicy(value: unknown): KeyPoolParams {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<KeyPoolParams>;
  const probeInitialMs = clampInt(raw.probeInitialMs, 5_000, 300_000, DEFAULT_KEY_POOL_PARAMS.probeInitialMs);
  const backoff = typeof raw.probeBackoffFactor === 'number' && Number.isFinite(raw.probeBackoffFactor)
    ? raw.probeBackoffFactor
    : DEFAULT_KEY_POOL_PARAMS.probeBackoffFactor;
  const probeMaxMs = clampInt(raw.probeMaxMs, 5_000, 600_000, DEFAULT_KEY_POOL_PARAMS.probeMaxMs);
  return {
    kickThreshold: clampInt(raw.kickThreshold, 1, 10, DEFAULT_KEY_POOL_PARAMS.kickThreshold),
    probeInitialMs,
    probeBackoffFactor: backoff >= 1 && backoff <= 10 ? backoff : DEFAULT_KEY_POOL_PARAMS.probeBackoffFactor,
    probeMaxMs: Math.max(probeMaxMs, probeInitialMs),
    capacity: clampInt(raw.capacity, 1, 10, DEFAULT_KEY_POOL_PARAMS.capacity),
  };
}

/** 领域层规范化模型 id：去除首尾空白、过滤空项、稳定去重。 */
function normalizeModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** 规范化用户模型选择配置；未配置时保持 undefined，便于 settings unset。 */
export function normalizeModelSelection(
  selection: SensenovaConfig['modelSelection'],
): ModelSelection | undefined {
  if (selection === undefined || selection === null || typeof selection !== 'object') return undefined;
  return {
    include: normalizeModelIds(selection.include),
    exclude: normalizeModelIds(selection.exclude),
  };
}

function resolveSlot(id: string, label: string, value: string): ResolvedAccountSpec {
  // 只接受 credential-ref；非法输入不保留原文，也不作为字面 API key 使用。
  const ref = typeof value === 'string' ? value.trim() : '';
  return isCredentialRefName(ref)
    ? { id, label, ref, isLiteral: false }
    : { id, label, ref: '', isLiteral: false };
}

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
export function mergeRetryPolicy(config: RetryPolicyConfig | undefined): RetryPolicyConfig {
  if (config === undefined) return DEFAULT_RETRY_POLICY_CONFIG;
  const base = DEFAULT_RETRY_POLICY_CONFIG as NormalRetryPolicyConfig;
  const override = config as NormalRetryPolicyConfig;
  const merged: NormalRetryPolicyConfig = {
    ...base,
    ...override,
    backoff: { ...base.backoff, ...override.backoff },
  };
  // 🛡️ 硬下限（防悬崖的第二道防线，第一道是 schema 的字段级缺省）：
  // `maxDelayMs` 低于适配器能吐出的 pra 上限时，落入 (maxDelayMs, 上限] 的请求会
  // **被宿主直接放弃重试**（不是夹到上限）——即"悬崖"。这是纯负收益的配置，
  // 因此这里兜住它，UI 侧也把输入下限钉在同一值。允许**调大**（>= 300_000），
  // 不允许调小。
  const backoff = merged.backoff ?? {};
  merged.backoff = {
    ...backoff,
    maxDelayMs: Math.max(backoff.maxDelayMs ?? 0, QUOTA_RETRY_AFTER_CEILING_MS),
  };
  return merged;
}

/**
 * 从原始 config 到解析后连接事实的唯一显式步骤。程序化构造可能绕过
 * Schemastery 归一化，因此每个默认值在此重新判定——既用于加载时的组合配置，
 * 也用于 settings 快照首次使用。
 */
/**
 * 归一化 L2 请求参数默认值。
 *
 * 遵循本插件的通用约定：**非法值一律回退「不注入」，绝不抛** —— 抛会打断设置保存，
 * 让整个设置页卡住。Schemastery 已在 schema 层做过范围校验，这里防御的是
 * "程序化构造绕过 schema"的情形（单测、profile patch 直写）。
 *
 * 返回值里只保留**合法**字段；全不合法时返回空对象 ⇒ `l2ParamsFor()` 自然不注入。
 */
function normalizeRequestParams(input: SensenovaRequestParams | undefined): SensenovaRequestParams {
  if (input === undefined) return {};
  const num = (v: unknown, min: number, max: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
  const out: SensenovaRequestParams = {};
  const topP = num(input.topP, 0, 1);
  if (topP !== undefined) out.topP = topP;
  const frequencyPenalty = num(input.frequencyPenalty, -2, 2);
  if (frequencyPenalty !== undefined) out.frequencyPenalty = frequencyPenalty;
  const presencePenalty = num(input.presencePenalty, -2, 2);
  if (presencePenalty !== undefined) out.presencePenalty = presencePenalty;
  const seed = num(input.seed, 0, 9_999_999);
  if (seed !== undefined) out.seed = seed;
  if (typeof input.doSample === 'boolean') out.doSample = input.doSample;
  return out;
}

export function resolveAdapterOptions(config: SensenovaConfig): ResolvedSensenovaOptions {
  const accounts: ResolvedAccountSpec[] = [];
  const defaultEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
  accounts.push(resolveSlot('default', 'Default', defaultEnv));
  for (const [index, account] of (config.accounts ?? []).entries()) {
    if (account === undefined) continue;
    const refName = typeof account.apiKeyEnv === 'string' && account.apiKeyEnv.trim() !== '' ? account.apiKeyEnv.trim() : undefined;
    if (refName === undefined) continue;
    const id = typeof account.id === 'string' && account.id.trim() !== '' ? account.id.trim() : `account-${index + 2}`;
    const label = typeof account.label === 'string' && account.label.trim() !== '' ? account.label.trim() : `Account ${index + 2}`;
    accounts.push(resolveSlot(id, label, refName));
  }
  const modelSelection = normalizeModelSelection(config.modelSelection);
  return {
    apiBase: config.apiBase ?? DEFAULT_API_BASE,
    activeAccount: typeof config.activeAccount === 'string' ? config.activeAccount : '',
    accounts,
    concurrency: normalizeConcurrency(config.concurrency),
    queueTimeoutMs: normalizeQueueTimeout(config.queueTimeoutMs),
    // 防御非布尔输入（程序化构造可能绕过 Schemastery 归一化）。
    quotaRotation: config.quotaRotation === true,
    // 重试策略：先逐层合并缺省值（防悬崖不变量），再交给官方解析器校验并冻结。
    retryPolicy: resolveRetryPolicy(
      mergeRetryPolicy(config.retryPolicy),
      'llm-sensenova.retryPolicy',
    ),
    // 默认开：只有显式 false 才关闭（缺失/非布尔 → true）。
    errorLog: config.errorLog !== false,
    // key 池策略（2026-09-27）：逐字段钳制，缺省取 DEFAULT_KEY_POOL_PARAMS。
    poolPolicy: normalizePoolPolicy(config.poolPolicy),
    // L2 连接级请求参数默认值（2026-09-23）。未配置时为空对象 ⇒ 不注入任何字段。
    requestParams: normalizeRequestParams(config.requestParams),
    ...(modelSelection !== undefined ? { modelSelection } : {}),
  };
}

export function apply(ctx: Context, config: SensenovaConfig): void {
  // 🔴 2026-09-24：`.volatile()` 让配置字段在运行期变成 `{get}` 引用，必须先解包。
  //
  // 为什么可以**只在 apply 入口解包一次**：0.1.7 的配置生效机制是
  // 「patch 变更 ⇒ app-boot 重组 ⇒ 本入口被重新 apply」（见下方路由注册处注释），
  // 所以每次 apply 解包拿到的都是当时最新的值，不会读出陈旧值。
  // 解包后对象身份稳定 ⇒ 下方 `options()` 的 memo（`raw === lastRaw`）照常命中，
  // 与改造前语义完全一致（改造前 `config` 也是同一个对象）。
  const resolvedConfig = plainConfig(config);
  // 0.1.7：`current` 不再由设置服务回灌 —— 配置变更会**重新 apply 本插件**（见下方
  // 路由注册处的说明），所以本次 apply 拿到的 `config` 就是唯一且最新的配置来源。
  const current = () => resolvedConfig;
  let lastRaw: SensenovaConfig | undefined;
  let lastGood: ResolvedSensenovaOptions | undefined;

  const options = (): ResolvedSensenovaOptions => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    const next = resolveAdapterOptions(raw);
    lastRaw = raw;
    lastGood = next;
    return next;
  };
  options();

  const resolveRef = async (spec: ResolvedAccountSpec): Promise<string | undefined> => {
    // 防御性校验：即使外部构造了 isLiteral=true，也不得让 ref 原文进入请求。
    if (spec.isLiteral || !isCredentialRefName(spec.ref)) return undefined;
    const ref = credentialRef(spec.ref);
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
      const resolved = await credentials.resolve(ref);
      if (resolved !== undefined && resolved.value !== undefined && resolved.value !== '') return resolved.value;
    }
    const ambient = launchEnvironmentOf(ctx).get(spec.ref);
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value;
    return undefined;
  };

  const slots = (): readonly AccountSlot[] => options().accounts.map((spec) => ({
    id: spec.id,
    label: spec.label,
    // 🔴 2026-09-27：新增 `ref` 透传。`ResolvedAccountSpec` 本来就有它（同文件上方定义），
    // 但旧 `AccountSlot` 没有这个字段 ⇒ 一路丢到这里，导致限流日志只能记 sha256 指纹
    // （如 `f9145012`）、无法显示可读的 credential-ref 名（如 `SENSENOVA_API_KEY_2`）。
    ref: spec.ref,
    resolveKey: () => resolveRef(spec),
  }));

  const preferredId = (): string | undefined => {
    const active = options().activeAccount;
    return active !== '' ? active : undefined;
  };

  const pool = new SensenovaAccountPool({ slots, preferredId });

  // ── key 池（2026-09-27 新增）──────────────────────────────────────────────────
  //
  // 「运行态 / 阻塞态」双列表，**池级共享** —— 本 `apply()` 内的单例，天然对所有会话
  // 生效（key 的配额本来就是全局属性，与「你在哪个对话里」无关）。
  //
  // 并发闸也在这里创建并与适配器**共享同一实例**：阻塞态 key 的恢复探测需要复用同一份
  // `inFlight` 计数，才能避开正在飞行的 agent 请求
  // （见 `KeyedConcurrencyGate.tryAcquire` 与 `key-pool.ts` 的模块说明）。
  const gate = new KeyedConcurrencyGate();
  // 每操作读一次（`options()` 自带 memo）⇒ 设置页改完保存即生效，池实例无需重建。
  const keyPoolParams = (): KeyPoolParams => options().poolPolicy;
  const keyPool = new SensenovaKeyPool({ params: keyPoolParams });
  /** key → 可读描述（账户名 + credential-ref 名），供限流事件的展示字段反查。 */
  const keyIndex = new Map<string, { label: string; ref: string }>();

  /** 登记一次凭据解析的结果，供 `describeKey` 反查（key 原文只在内存，绝不进日志）。 */
  const rememberKey = (key: string, slot: AccountSlot): void => {
    keyIndex.set(key, { label: slot.label, ref: slot.ref });
  };

  // W4：限流事件记录器（构造零副作用；首次写入时才创建 $DSH_HOME/logs）。
  const errorLog = new SenseNovaErrorLog();

  const resolveApiKey = async (
    connection: { apiBase: string; accountCount: number },
    hint?: { preferredKey?: string },
  ): Promise<string> => {
    const resolved = await pool.resolveKey();
    if (resolved === undefined) {
      throw new LlmError(
        `llm-sensenova: no API key for provider route "${PROVIDER}" (apiBase ${connection.apiBase}); store a key through the credentials service or settings；未配置 SenseNova API 密钥，请在设置页或凭据页配置`,
        'MISSING_CREDENTIAL',
      );
    }
    const fallbackKey = assertUsableApiKey(resolved.key, 'llm-sensenova', resolved.slot.label);
    rememberKey(fallbackKey, resolved.slot);
    // 把**全部**已解析账户灌进池（幂等：已存在者保持相位与计数，只有新 key 进运行态末尾）。
    // ⚠️ `resolvedAccounts()` 会重新解析每个槽位 —— 这是宿主的凭据契约要求
    // （「每次操作重新解析、禁止跨操作缓存」），不能为了省事而缓存。
    const all = await pool.resolvedAccounts();
    for (const account of all) rememberKey(account.key, account.slot);
    const dropped = keyPool.seed(all.map(account => account.key));
    if (dropped > 0) {
      ctx.logger.warn(
        'llm-sensenova: %d 个账户超出 key 池容量上限 %d，已被忽略（可调高设置页的「槽位上限」）',
        dropped,
        keyPoolParams().capacity,
      );
    }
    // `hint.preferredKey` 只是**偏好**：池仅在它仍处于运行态时才采纳，否则回落到运行态
    // 的正确一把。这是「会话粘性不会退化成死锁」的关键（2026-09-27）。
    return keyPool.pickStart(hint?.preferredKey) ?? fallbackKey;
  };

  const rotateApiKey = async (
    rejectedKey: string,
    rejection: 'invalid-credential' | 'quota-exhausted',
    exclude?: ReadonlySet<string>,
  ): Promise<string | undefined> => {
    // 'invalid-credential'（401）永久禁用被拒账号；'quota-exhausted'（配额类 429）
    // 不写任何账号状态，仅用于选取下一把可用 key（design D5）。
    pool.markRejected(rejectedKey, rejection);
    // 401 ⇒ 该 key 永久失效，从池中彻底移除。429 的相位由 keyPool 自己管
    // （`recordTpmStrike` 已达阈值时才会踢），此处不动。
    if (rejection === 'invalid-credential') keyPool.remove(rejectedKey);
    const next = keyPool.pickNext(exclude ?? EMPTY_KEY_SET);
    if (next === undefined) return undefined;
    // 直接用索引里的可读名做错误文案，**不再重新解析凭据**（省一次 N 槽位的异步解析）。
    const described = keyIndex.get(next);
    return assertUsableApiKey(next, 'llm-sensenova', described?.label ?? next);
  };

  const adapter = new SensenovaAdapter({
    options: () => {
      const resolved = options();
      return {
        apiBase: resolved.apiBase,
        accountCount: resolved.accounts.length,
        concurrency: resolved.concurrency,
        queueMs: resolved.queueTimeoutMs,
        quotaRotation: resolved.quotaRotation,
        // 重试策略随连接事实一起下发（adapter 的 providerRetryPolicy 读它）。
        retryPolicy: resolved.retryPolicy,
        // L2 连接级请求参数默认值（2026-09-23）：adapter 在每请求时按模型白名单过滤。
        requestParams: resolved.requestParams,
        ...(resolved.modelSelection !== undefined ? { modelSelection: resolved.modelSelection } : {}),
      };
    },
    resolveApiKey,
    rotateApiKey,
    // ── key 池接线（2026-09-27）────────────────────────────────────────────────
    // 并发闸与探测调度器**共享同一实例**（见上面 `gate` 的创建处说明）。
    concurrencyGate: gate,
    // 上报限流分类：**只有 'tpm' 会累计连续命中并在达阈值时把该 key 踢出运行态**；
    // 'rpm' / 'rate' 只记不踢（秒级桶自愈快，踢掉只损失该 key 的 prompt cache 命中率）。
    reportRateLimit: (key, kind) => {
      const poolState = (): { running: number; blocked: number } => {
        const state = keyPool.snapshot();
        return { running: state.running.length, blocked: state.blocked.length };
      };
      if (kind !== 'tpm') return { kicked: false, ...poolState() };
      const { kicked } = keyPool.recordTpmStrike(key);
      return { kicked, ...poolState() };
    },
    // 成功是「池已恢复」的最强证据：清零该 key 的连续命中计数；若它正被阻塞态借用后
    // 打成功 ⇒ 立即挂回运行态末尾。
    reportSuccess: (key) => keyPool.onSuccess(key),
    // 限流事件的两个可读展示字段（`accountLabel` / `accountRef`）由此反查。
    describeKey: (key) => keyIndex.get(key),
    // 视觉模型（kimi-k3、sensenova-6.8-flash-lite 等）需要把宿主持久化图片解析成
    // 请求字节：走附件服务的 readImageRequest（按其 0.1.6 契约的 ImageRequestTarget
    // 请求目标尺寸版本）；附件服务不可用时返回 undefined，adapter 会跳过该图并照常
    // 发送文本部分。
    //
    // 🔴 2026-09-20：这里此前内联传 `DEFAULT_IMAGE_POLICY`（0.1.5 的
    // `{maxPixels,maxBytes}`），而 0.1.6 要求 `{width,height,maxBytes}` ⇒ 存储层
    // `checkedInteger(target.width)` 抛 INVALID_ATTACHMENT_REF，异常被
    // `prepareImageDataUrls` 的空 catch 吞掉 ⇒ **图片静默全丢、请求退化成纯文本**，
    // 表现为"模型读图读不对"。改为 `createResolveImage()` 后由它按图求目标。
    resolveImage: createResolveImage(
      () => ctx.get('attachments' as never) as ImageAttachmentsLike | undefined,
    ),
    imagePolicy: () => DEFAULT_IMAGE_POLICY,
    // W4：限流事件记录器。实例只建一次（构造不碰磁盘，首次 record 才 mkdir/stat），
    // 用 thunk 读取开关 ⇒ 用户在设置页关掉「记录限流事件」即刻生效，无需 replace。
    errorLog: () => (options().errorLog ? errorLog : undefined),
  });

  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'SenseNova',
    settingsNs: NS,
    settingsPath: [],
  }]);

  // 路由注册。宿主的注册表在**注册时捕获** retry policy。
  //
  // 🔴 0.1.7 起这里**不再需要** W1（2026-09-17）那套 `registration.replace([PROVIDER])`
  // + `deepEqualJson` 护栏的刷新机制。原因与上面 installSection 的移除是同一件事：
  // 配置变更后的生效机制变成了「patch 变更 ⇒ app-boot 重组 ⇒ 本入口被**重新 apply**」
  // （上游 `packages/settings/settings/tests/live-config.ts` 就是这么驱动的：
  // `entry.update({ config })` + `entry.fiber.await()` ⇒ fiber 重建）。既然每次配置
  // 变更都会换来一次全新的 `apply()`，`registerAdapter` 自然用新 policy 重跑一次，
  // "注册时捕获的旧 policy"不可能残留 —— 那套机制遂成为死代码（tsc 的
  // `noUnusedLocals` 会直接把它报出来，本插件正是这样发现的）。
  ctx.llm.registerAdapter([PROVIDER], adapter);

  // ── 阻塞态 key 的恢复探测定时器（2026-09-27 新增）────────────────────────────
  //
  // 🔴 必须包在 `ctx.effect` 内：本插件要求可在运行时热卸载，**裸 `setInterval` 会泄漏**。
  // `ctx.effect(execute)` 的语义是「execute 立即执行，其返回的 disposer 在 fiber 卸载
  // 或手动 dispose 时运行」（vendor/cordis 的 `fiber.ts` 有明文），所以这里同时清定时器
  // **并中止在途探测** → 满足卸载约束。
  // （这条铁律插件自己记在 `model-info-api.ts` 模块头：禁放裸 setInterval / fs.watch / 模块级可变缓存。）
  const probeScheduler = createProbeScheduler({
    keyPool,
    gate,
    apiBase: () => options().apiBase,
    concurrency: () => options().concurrency,
  });
  ctx.effect(() => {
    const controller = new AbortController();
    const timer = setInterval(() => {
      void probeScheduler.tick(controller.signal);
    }, PROBE_TICK_MS);
    // 🔴 `unref()` 不是可选项。没有它，这个定时器会**保持事件循环活跃**，让任何
    // 「挂载了本插件但不会主动退出」的宿主进程无法结束 —— 实测 `tests/retry-policy.test.ts`
    // （它会真的调用 `apply()`）会因此永久挂起，看起来像测试卡死。
    // `unref()` 让定时器不参与「事件循环是否还有活儿」的判定，但**不影响**它在进程存活
    // 期间照常触发；而 fiber 卸载时下面的 cleaner 依然会 `clearInterval` ⇒ 不泄漏。
    timer.unref?.();
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, 'llm-sensenova: blocked-key probe scheduler');

  // 🔴 0.1.7 破坏性变更：`SettingsProvider.installSection()` 已随 `SettingsProvider` →
  // `SettingsForms` 的改名一并移除。新模型下配置段由**组合层**声明（profile patch 里
  // 本插件的条目 + 本包导出的 `Config` schema），设置页直接按 schema 渲染，插件不再
  // "安装"配置段；`configure({ auto: false })` 只是声明「本插件自带页面」的页面策略。
  // 官方 llm-deepseek 用的就是这一行（照抄以与上游保持一致）。
  //
  // 配置热更新也随之换了机制：patch 变更 ⇒ app-boot 重组 ⇒ 本入口被**重新 apply**，
  // 因此 `config` 始终是最新值。原先 installSection 的 `setSource`/`onChange` 活配置桥
  // 没有了对应物，`current()` 恒等于本次 apply 的 `config`。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
  });

  // 错误记录的**只读路由**（设置页「错误记录」区块的数据来源，2026-09-18）。
  //
  // 为什么用可选注入而不是 `export const inject`：`connection` 由 web/api 层提供，
  // 非 web profile（如 tui）可能没有 ⇒ 缺服务时只是不注册这条路由，插件本身照常
  // 加载（与 settings 的处理一致）。设置页那边会显示"不可用"而不是白屏。
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.fetch.register({
        path: ERROR_LOG_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleErrorLogHttp(request),
      }),
      `llm-sensenova: error log route ${ERROR_LOG_ROUTE}`,
    );
  });

  // 「当前模型 + 全部参数」的只读路由（2026-09-23，Phase 5）。
  //
  // 与错误记录路由同一范式与约束（懒拉取 / 缺失即正常 / 绝不抛 / 不做轮询）。
  //
  // ⚠️ `agentDefaultModel` 用 **lazy `ctx.get()`** 而不是再开一层 `ctx.inject([...])`：
  // 前者在服务缺失时每次请求返回 undefined（面板显示"不可用"），后者会让整个回调
  // 不执行 ⇒ 路由注册不上，面板 404。`llm` 是本插件的硬依赖，直接 get 即可。
  const modelInfoDeps = (): ModelInfoDeps => ({
    currentSelection: () => {
      try {
        const svc = ctx.get('agentDefaultModel' as never) as
          | { currentSelection?: () => unknown }
          | undefined;
        const raw = svc?.currentSelection?.();
        if (typeof raw !== 'object' || raw === null) return undefined;
        const selection = raw as { provider?: unknown; model?: unknown; reasoningEffort?: unknown };
        return {
          ...(typeof selection.provider === 'string' && selection.provider !== '' ? { provider: selection.provider } : {}),
          ...(typeof selection.model === 'string' && selection.model !== '' ? { model: selection.model } : {}),
          ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
            ? { reasoningEffort: selection.reasoningEffort }
            : {}),
        };
      } catch {
        return undefined;
      }
    },
    resolveModelInfo: async (provider: string, model: string) => {
      try {
        const llm = ctx.get('llm' as never) as
          | { resolveModelInfo?: (p: string, m: string) => Promise<unknown> }
          | undefined;
        const info = await llm?.resolveModelInfo?.(provider, model);
        return typeof info === 'object' && info !== null ? (info as ResolvedModelInfoLike) : undefined;
      } catch {
        return undefined;
      }
    },
    requestParams: options().requestParams,
    // 账户池摘要：读**插件当前生效的 config**，与设置页读的是同一份事实
    // ⇒ 可用于判定"界面显示的账户数是否与实际一致"。只回引用名，绝不含密钥值。
    accountPool: () => {
      const resolved = options();
      return {
        slots: resolved.accounts.length,
        refs: resolved.accounts.map((account) => account.ref),
        activeAccount: resolved.activeAccount,
        quotaRotation: resolved.quotaRotation,
      };
    },
    // 设置传输层探针（2026-09-24）：读 `settings.describe()` 里本插件 namespace 的
    // `value.accounts` 条数，与上面 accountPool() 逐级比对，定位"账户数对不上"断在哪。
    //
    // 为什么需要它：设置页读的是 `entry.fiber.config`（本插件的 `options()` 同源），
    // 而前端还可能因 **客户端 decode 失败（静默！）** 或快照未就绪而渲染出别的数。
    // 有了这两路 host 侧数字 + 前端渲染数，就能确定是哪一环的问题。
    settingsProbe: () => {
      try {
        const settings = ctx.get('settings' as never) as
          | {
            writable?: unknown;
            describe?: (options?: { redactSecrets?: boolean }) => unknown;
          }
          | undefined;
        // ⚠️ `writable` 在 **SettingsForms 服务自身**上（getter），不在单个 descriptor 里
        //（controller 的 `namespaceView()` 才把它挂在每个 namespace 视图上）。
        const writable = typeof settings?.writable === 'boolean' ? settings.writable : undefined;
        if (settings?.describe === undefined) {
          return { serviceAvailable: false, accountsInSettings: -1, namespacesSeen: 0 };
        }
        const described = settings.describe({ redactSecrets: true });
        if (!Array.isArray(described)) {
          return {
            serviceAvailable: true,
            accountsInSettings: -1,
            namespacesSeen: 0,
            ...(writable !== undefined ? { writable } : {}),
            error: 'describe-not-array',
          };
        }
        const hits = described.filter((row) => (row as { ns?: unknown })?.ns === NS);
        if (hits.length === 0) {
          return {
            serviceAvailable: true,
            accountsInSettings: -1,
            namespacesSeen: 0,
            ...(writable !== undefined ? { writable } : {}),
          };
        }
        const first = hits[0] as { value?: unknown };
        const value = typeof first.value === 'object' && first.value !== null
          ? (first.value as { accounts?: unknown })
          : undefined;
        const accountsRaw = value?.accounts;
        return {
          serviceAvailable: true,
          accountsInSettings: Array.isArray(accountsRaw) ? accountsRaw.length : -1,
          namespacesSeen: hits.length,
          ...(writable !== undefined ? { writable } : {}),
        };
      } catch (err) {
        return {
          serviceAvailable: false,
          accountsInSettings: -1,
          namespacesSeen: 0,
          error: String((err as Error)?.message ?? err).slice(0, 200),
        };
      }
    },
  });
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.connection.fetch.register({
        path: MODEL_INFO_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleModelInfoHttp(request, modelInfoDeps()),
      }),
      `llm-sensenova: model info route ${MODEL_INFO_ROUTE}`,
    );
  });
}

// ─────────────────── 阻塞态 key 的恢复探测（2026-09-27 新增）───────────────────

/**
 * 探测用的固定模型 id。
 *
 * 用 v4.1 的 `deepseek-flash`：它已实测可路由，且**限流是 key 级的**（与服务端用哪个
 * 模型无关）⇒ 用哪个模型探测结论都一样。固定常量最简单，也不依赖会话上下文。
 */
export const PROBE_MODEL = 'deepseek-flash';

/** 单次探测的超时（毫秒）。故意短于生产建连超时：探测要的是快速结论，不是结果本身。 */
export const PROBE_TIMEOUT_MS = 10_000;

/** 探测定时器的粒度（毫秒）。取 5s 以尊重最短 15s 的探测间隔。 */
export const PROBE_TICK_MS = 5_000;

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
export function createProbeScheduler(deps: ProbeSchedulerDeps): ProbeScheduler {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetchImpl ?? fetch;
  const model = deps.model ?? PROBE_MODEL;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  /**
   * 发一次「最小请求」，判断该 key 的配额是否已恢复。
   *
   * 判据**只有 HTTP 状态码**：2xx ⇒ 已恢复；其余（尤其 429）⇒ 未恢复。
   * 请求体刻意压到最小，且**显式关闭思考** —— v4.1 默认开启思考，不关的话这个"最小请求"
   * 并不小（Phase 0 实测 `reasoning_tokens` 20~29）。
   */
  const probeOne = async (key: string, signal?: AbortSignal): Promise<boolean> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await doFetch(`${deps.apiBase()}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        ...attributionHeaders(),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: true,
        // 🔴 必须显式关思考，否则「最小请求」不最小。
        reasoning_effort: 'none',
        // 🔴 必须显式写 true：显式 false 会让 usage 帧整个消失（Phase 0 实测）。
        stream_options: { include_usage: true },
      }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    // 只要状态码：立刻放掉 body，避免 SSE 未读完而占住连接。
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  };

  return {
    tick: async (signal?: AbortSignal): Promise<boolean> => {
      const at = now();
      for (const entry of deps.keyPool.blockedEntries()) {
        if (at < deps.keyPool.nextProbeAt(entry)) continue;
        // 非阻塞取额度：该 key 上有 agent 请求在飞 ⇒ 跳过本次，因为那种情况下的 429
        // 可能来自 agent 请求造成的瞬时压力，而不是该 key 的真实配额状态，结论不可信。
        const release = deps.gate.tryAcquire(entry.key, deps.concurrency());
        if (release === undefined) continue;
        let recovered = false;
        try {
          recovered = await probeOne(entry.key, signal);
        } catch {
          recovered = false; // 网络 / 超时 / 中止一律按「未恢复」计，由退避自限
        } finally {
          release();
        }
        deps.keyPool.recordProbe(entry, recovered);
        return true; // 每 tick 至多一把
      }
      return false;
    },
  };
}
