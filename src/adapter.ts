/**
 * SenseNova（OpenAI 兼容）provider 适配器（host 侧）。
 *
 * 复用参考插件 @mars-sea/dsh-commandcode-provider 的适配器结构，但只保留
 * OpenAI 兼容的目录拉取与 SSE 流式翻译，外加「流开始前的 401 账号轮换」
 * （429 不轮换：一个会话固定一个 key，保护服务端按 key 命中的 prompt 缓存，
 * 429 交由宿主重试层退避后原 key 重试）。
 * 与 pi-ai 的 `toStreamChunks` 不同，这里直接消费 OpenAI SSE（`data:` 行、
 * `[DONE]`、`choices[].delta`、`finish_reason`、`usage`），不引入第三方流库。
 *
 * 适配器刻意不依赖 cordis/schemastery：每请求的连接事实与 key 解析/轮换
 * 全部通过构造注入，node 测试可直接驱动。
 *
 * @module dsh-sensenova-freeapi/adapter
 */
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  attributionHeaders,
  errorChain,
  offloadedImageText,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import { ToolCallId } from './brand.ts';
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ModelModality,
  RequestMessage,
  ResolvedRetryPolicy,
  RetryPolicyConfig,
  StreamChunk,
  TokenUsage,
  ToolCallBlock,
} from '@deepseek-ai/dsh-llm';
import { parseRetryAfterMs } from './accounts.ts';
import { DEFAULT_QUEUE_TIMEOUT_MS, KeyedConcurrencyGate, type Release } from './concurrency.ts';
import { extractErrorCode, fingerprint, summarize, type SenseNovaErrorLog } from './error-log.ts';

/**
 * SenseNova 目录通常不披露上下文字段，这里用 131072 作为合理默认
 * （DeepSeek 系列与 SenseNova 常见模型窗口）；目录有字段时优先采用。
 */
const DEFAULT_CONTEXT_WINDOW = 131_072;
const MODELS_TIMEOUT_MS = 10_000;
/**
 * 非配额 429 的 Retry-After 采信上限（毫秒）：网关头部值超过它就不采信，
 * 回落到本地退避。**不再兼任重试策略的退避上限**——那个已拆到
 * `RETRY_POLICY_MAX_DELAY_MS`（见下，2026-09-17 拆开以消除悬崖）。
 * fix-sensenova-429-quota-retry（2026-09-04 实测）：原 3000ms 与配额窗口量级
 * 不符——TPM 为 60 秒窗口，提升到 60000ms（spec 允许区间 60–120s 的下沿）。
 */
const PROVIDER_RETRY_AFTER_CAP_MS = 60_000;
/**
 * 本适配器可能吐出的 `providerRetryAfterMs` 绝对上限（毫秒）：宽松上限，
 * 防止网关异常 Retry-After 把退避拖到分钟级以外；不影响 TPM 分级档（3–15s）与
 * code 8 固定档（15s）的正常取值。
 *
 * ⚠️ **这个值同时是"悬崖"不变量的一半**：`RETRY_POLICY_MAX_DELAY_MS` 必须 ≥ 它，
 * 否则宿主会对落入 (maxDelayMs, ceiling] 区间的 `pra` 直接放弃重试。
 * `tests/adapter.test.ts` 有一条断言守住这个不变量。
 */
export const QUOTA_RETRY_AFTER_CEILING_MS = 300_000;
/**
 * 提交给宿主重试策略的退避单次上限（毫秒），即 `ResolvedRetryPolicy.backoff.maxDelayMs`。
 *
 * fix-sensenova-429-cliff（2026-09-17 实测）：必须 **≥** 本文件能吐出的
 * `providerRetryAfterMs` 上限。宿主 llm-retry 的判断是
 * `if (pra > policy.maxDelayMs) { if (mode === 'normal') return next() }`
 * —— 超过就**彻底放弃重试**（不是夹到上限），回合立即 error。
 *
 * 原取值沿用 `PROVIDER_RETRY_AFTER_CAP_MS`（60_000），而上游封顶是
 * `QUOTA_RETRY_AFTER_CEILING_MS`（300_000）→ 60~300s 成为"死亡区"：
 * 0917 会话里 `pra > 60000` 恰好出现 2 次（turn 25 = 149344、turn 27 = 61696），
 * **2/2 都未被重试，正是当天唯二回合失败**。
 *
 * 现在两者取同一上限 ⇒ `pra > maxDelayMs` **结构性恒为假**，悬崖无法被构造。
 * 副作用：`maxDelayMs` 同时是 `localDelay()`（无 pra 时的本地指数退避）的封顶，
 * 因此 TIMEOUT 这类无指导的失败，本地退避也会放宽到 300s 上限；仅在连续
 * 多次重试后才会接近该值（500ms 起、×2），可接受。
 */
const RETRY_POLICY_MAX_DELAY_MS = QUOTA_RETRY_AFTER_CEILING_MS;

/**
 * 缺省重试次数预算。**刻意不同于官方的 `DEFAULT_MAX_RETRIES = 5`**：
 * 见 `DEFAULT_RETRY_POLICY_CONFIG` 的数值沿革（10 次的累计窗口仅 33 秒，
 * 对分钟级 TPM 窗口不够，曾导致 13/16 个回合作废）。
 */
export const DEFAULT_RETRY_MAX_RETRIES = 24;
/** 缺省本地退避起点（毫秒）＝官方的 `DEFAULT_INITIAL_DELAY_MS`。 */
export const DEFAULT_RETRY_INITIAL_DELAY_MS = 500;
/** 缺省抖动比例＝官方的 `DEFAULT_JITTER_RATIO`。 */
export const DEFAULT_RETRY_JITTER_RATIO = 0.1;

/**
 * 缺省重试策略配置：`llm-sensenova.retryPolicy` 未配置时的回落值。
 * `index.ts` 的 `RetryPolicyFieldsSchema` 用上面三个标量常量做字段级缺省，
 * 避免两处硬编码漂移。
 *
 * 数值沿革（均为实测驱动，勿凭直觉调小）：
 * - `maxRetries: 24`（2026-09-16）：原 10 次 × 短退避累计窗口仅约 33 秒，对分钟级
 *   TPM 窗口严重不足，直接导致 **13/16 个回合作废**（`turn/end` reason=error）、
 *   8/10 个 subagent 被 429 杀死。429 的代价是"整个回合作废"，比多等几分钟昂贵
 *   得多。若仍不足，应走"429 熔断降级到备用模型"而不是继续加次数。
 * - `backoff.maxDelayMs: 300_000`（2026-09-17）：与 `QUOTA_RETRY_AFTER_CEILING_MS`
 *   对齐以**结构性消除悬崖**（宿主对 `pra > maxDelayMs` 是直接放弃重试，不是夹到
 *   上限），详见 `RETRY_POLICY_MAX_DELAY_MS` 的说明。
 */
export const DEFAULT_RETRY_POLICY_CONFIG: RetryPolicyConfig = {
  mode: 'normal',
  maxRetries: DEFAULT_RETRY_MAX_RETRIES,
  backoff: { maxDelayMs: RETRY_POLICY_MAX_DELAY_MS },
};

/**
 * `DEFAULT_RETRY_POLICY_CONFIG` 的解析结果（模块级缓存）。
 * `resolveRetryPolicy()` 每次调用都新建 frozen 对象，而 `providerRetryPolicy()`
 * 既可能被宿主在注册时调用、也可能被测试反复调用，缓存一份即可。
 */
const FALLBACK_RETRY_POLICY: ResolvedRetryPolicy = resolveRetryPolicy(
  DEFAULT_RETRY_POLICY_CONFIG,
  'llm-sensenova.retryPolicy',
);

/** 配额类 429（code 8，rps/rpm exhausted）退避下限（毫秒）。2026-09-04 实测：速率桶补充 ≈1 个/14s，15s 覆盖一个完整补充周期。 */
export const QUOTA_RATE_RETRY_FLOOR_MS = 15_000;
/** 生成请求连接/首字节超时（毫秒）。2026-09-04 实测：传输挂起 ≈1/5 且无 RST，45s 覆盖大 prompt 建连+首包（design D4/D6）。 */
export const CONNECT_TIMEOUT_MS = 45_000;
/** SSE 流空闲看门狗（毫秒）：距上一事件 ≥ 该值无任何 chunk/事件即按停摆结束。2026-09-04 实测：思考期渠道有空事件/心跳自然重置计时（design D4/D6）。 */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;
/** 已知不可路由的模型 id 清单（已下线路由，调用返回 404/403）。 */
export const KNOWN_UNROUTABLE_MODELS: ReadonlySet<string> = new Set([
  'sensenova-6.7-flash-lite',
  // ⚠️ 2026-09-23 Phase 0 实测：目录里与 `deepseek-flash` 并列存在，是**诱饵 id**。
  // 实测返回 403 / `code: 7` / "model is not available in the current token plan"。
  // v4.1 唯一可调的 id 是 `deepseek-flash`。不过滤掉它 ⇒ 用户在选择器里选到就必然失败。
  'deepseek-v4.1-flash',
]);
/** 明确的模型不可用错误码（不在默认可重试集合内，故不触发 provider 重试）。 */
const MODEL_NOT_FOUND_CODE = 'MODEL_NOT_FOUND';
/**
 * 模型 id → 标准显示名的显式品牌映射。
 *
 * 🔴 2026-09-23 补齐：此前只有 6.7-flash-lite 一条，其余模型在选择器里显示裸 id
 * （`deepseek-flash` / `kimi-k3`），用户无法判断「deepseek-flash」其实是 V4.1。
 */
const DISPLAY_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ['sensenova-6.7-flash-lite', 'Sensenova 6.7 Flash Lite'],
  ['sensenova-6.8-flash-lite', 'SenseNova 6.8 Flash Lite'],
  ['deepseek-v4-flash', 'DeepSeek V4 Flash'],
  ['deepseek-flash', 'DeepSeek V4.1 Flash'],
  ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['glm-5.2', 'GLM-5.2'],
  ['kimi-k3', 'Kimi K3'],
]);

/**
 * 模型族推理档位（**值为 API wire 原值，直接透传**）。
 *
 * 🔴 **2026-09-23 Phase 0 按服务端实测重新标定（131 用例）—— 以 400 报错原文为准，不照文档**：
 *
 * | 模型 | 服务端权威词表 | 文档口径 | 差异 |
 * |---|---|---|---|
 * | `sensenova-6.8-flash-lite` | `low medium high xhigh none` | `low medium max high` + none | **文档的 `max` 是错的（实测 400）**；`xhigh` 文档没提但可用 |
 * | `deepseek-v4-flash` | `low medium high xhigh none` | `low medium high max` + none | 同上 |
 * | `deepseek-flash`(v4.1) | 全 7 档均通过 | `none low high max` | 文档漏了 `medium`/`xhigh`/`minimal` |
 * | `glm-5.2` | 全 7 档均通过 | 全 7 档 | ✅ 一致 |
 * | `kimi-k3` | 全 7 档均通过 | `low medium high max` | 文档漏了 `minimal`/`xhigh`/`none` |
 *
 * ⚠️ **`max` 绝不能加给 lite / v4**：服务端原文
 * `field ReasoningEffort invalid, should be one of: low, medium, high, xhigh, none`。
 * 照文档加上去 ⇒ 用户一选到它就吃 400。
 *
 * ⚠️ **`deepseek-v4-pro` 未在 Phase 0 复测**（不在本次 5 模型范围），**原值保留不动** ——
 * 不引入未经实测的值。
 *
 * 数组顺序 = UI 展示顺序。`none` 一律排首位，对齐官方 `llm-deepseek` 的
 * `Off / Low / High / Max` 范式（`packages/llm/llm-deepseek/src/model-info.ts:9-40`）。
 */
export const KNOWN_EFFORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['sensenova-6.8-flash-lite', ['none', 'low', 'medium', 'high', 'xhigh']],
  ['deepseek-v4-flash', ['none', 'low', 'medium', 'high', 'xhigh']],
  ['deepseek-flash', ['none', 'low', 'medium', 'high', 'xhigh', 'minimal', 'max']],
  ['deepseek-v4-pro', ['low', 'high', 'max']],
  ['glm-5.2', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
  ['kimi-k3', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']],
]);

/** 手动模型可选覆盖（用户设置持久化）。 */
export interface ModelSelection {
  include: readonly string[];
  exclude: readonly string[];
}

export interface SensenovaConnection {
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
}

const EMPTY_MODEL_SELECTION: ModelSelection = { include: [], exclude: [] };

/** 生成请求三段超时注入（毫秒，测试用）；缺省用模块级常量/并发闸默认。 */
export interface SensenovaTimeouts {
  /** 连接/首字节超时；缺省 CONNECT_TIMEOUT_MS。 */
  connectMs?: number;
  /** SSE 流空闲看门狗；缺省 STREAM_IDLE_TIMEOUT_MS。 */
  streamIdleMs?: number;
  /** 并发闸排队超时；缺省 concurrency.DEFAULT_QUEUE_TIMEOUT_MS。 */
  queueMs?: number;
}

// ── 图片（多模态）支持 ──────────────────────────────────────────────────
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
export const DOCUMENTED_VISION_MODELS = new Set(['kimi-k3', 'sensenova-6.8-flash-lite', 'deepseek-flash']);

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
export const DOCUMENTED_TEXT_ONLY_MODELS = new Set(['deepseek-v4-flash', 'glm-5.2']);

/**
 * 模型级输出预算覆盖（token）。
 *
 * 规则：**`min(服务端实测上限, 131072)`**，2026-09-23 Phase 0 用「超限值触发 400
 * 读报错原文」拿到服务端权威区间：
 *
 * | 模型 | 服务端区间（400 原文） | 文档口径 | 决策 |
 * |---|---|---|---|
 * | `sensenova-6.8-flash-lite` | `[1, 65536]` | 默认 65535，范围一致 | **65536** |
 * | `deepseek-v4-flash` | `[1, 384000]` | 未给范围 | **131072** |
 * | `deepseek-flash`(v4.1) | `[1, 393216]` | 范围一致 | **131072** |
 * | `glm-5.2` | `[1, 131072]` | 范围一致 | **131072** |
 * | `kimi-k3` | `[1, 1048576]` | 默认 128K | **131072** |
 *
 * **为什么取 `min(上限, 131072)` 而不是服务端最大值**：
 * 上报的 `defaultMaxTokens` 会被宿主**物化成真发出去的 `max_tokens`**
 * （`@deepseek-ai/dsh-llm/src/index.ts:881`）。它是**上限**不是**目标** ——
 * 调大不会强制生成长文本；但它是「失控生成」的天花板，而**思考 token 与输出共享
 * 这份预算** ⇒ 上限越高，最坏情况的 TPM 冲击越大。
 * 131072 恰好等于各模型文档给出的「思考模式默认预算」，既不截断思考，也不留
 * 384K / 1M 的尾部风险。规则只有一条，不必逐模型论证。
 *
 * ⚠️ 兜底语义：用户在 agent preset 里设了 `maxTokens` 时会**覆盖**本表
 * （`AgentOptions.maxTokens`，`packages/core/agent/src/runtime-types.ts:26-35`）。
 * 本表只是「没人指定时」的默认值。
 */
export const MODEL_MAX_OUTPUT_OVERRIDES: ReadonlyMap<string, number> = new Map([
  ['sensenova-6.8-flash-lite', 65_536],
  ['deepseek-v4-flash', 131_072],
  ['deepseek-flash', 131_072],
  ['glm-5.2', 131_072],
  ['kimi-k3', 131_072],
]);

/**
 * 模型级上下文窗口覆盖（token）。
 *
 * 目的与 `MODEL_MAX_OUTPUT_OVERRIDES` 相同：**冷目录下能力不退化**。
 * `resolveModel` 不会主动拉目录（只有 `listModels` 会），因此首次打开模型选择器时
 * 只能拿到 `DEFAULT_CONTEXT_WINDOW`（131072）—— 对全部 5 个模型都是错的
 * （4 个是 1M、lite 是 262144）。目录热时以目录为准（本表不覆盖目录已给的更小值，
 * 见 `resolveModel` 的取值顺序）。
 *
 * 数据来源：2026-09-23 目录实测 + 文档示例，两处一致。
 */
export const MODEL_CONTEXT_OVERRIDES: ReadonlyMap<string, number> = new Map([
  ['sensenova-6.8-flash-lite', 262_144],
  ['deepseek-v4-flash', 1_048_576],
  ['deepseek-flash', 1_048_576],
  ['glm-5.2', 1_048_576],
  ['kimi-k3', 1_048_576],
]);

// ── L2：插件级请求参数默认值 ──────────────────────────────────────────────
//
// 背景：宿主 `GenerateOptions` 只允许传 12 个字段
// （`@deepseek-ai/dsh-llm/src/types.ts:486-526`），**没有** `top_p` / `seed` /
// 频率惩罚 / `do_sample` 等。这些参数在"每次会话可调"这一层**做不到**（要改上游），
// 但可以在**连接级**由插件注入请求体 —— 这就是 L2。
//
// ⚠️ 语义边界：L2 是**连接级默认值**，与 `concurrency` / `queueTimeoutMs` 同性质，
// **不是** per-session 可调项。设置页必须标注清楚，否则会被误认为"改了没反应"。

/** 可由插件注入的请求参数（L2）。 */
export type SensenovaRequestParamKey =
  | 'top_p' | 'frequency_penalty' | 'presence_penalty' | 'seed' | 'do_sample';

/**
 * 每模型允许注入的 L2 参数白名单。
 *
 * 🔴 **2026-09-23 Phase 0 实测得出 —— 绝不能"把文档里所有参数一次性注入"**：
 *
 * - **`kimi-k3` 全部排除**：传 `frequency_penalty: 0.5` → 400
 *   `field FrequencyPenalty invalid, only 0 is allowed for this model`；
 *   其文档还写明 `temperature` 固定 1、`top_p` 固定 0.95 ⇒ 注入只会制造失败。
 * - **`n` 不在候选集里**：实测 v4 / v4.1 / kimi 上 `n:2` 被**静默降到 1**
 *   （`choices.length === 1`），只在 lite 真生效；而且它是 v4
 *   「`n` + `parallel_tool_calls` + `response_format` 三者同时 → 400」的参与者。
 *   DSH 不需要多候选 ⇒ **不提供该参数**。
 * - **`do_sample` 只有 glm-5.2 有**（其文档独有字段）。
 * - `8.9-flash-lite` / `deepseek-v4-flash` / `deepseek-flash` / `glm-5.2`
 *   的 `top_p` + 频率惩罚 + 存在惩罚 + `seed` 组合实测 **200 通过**。
 * - 表外模型（未来新增）**一律不注入**：宁可少发，不要因未知能力吃 400。
 */
export const MODEL_L2_PARAM_SUPPORT: ReadonlyMap<string, ReadonlySet<SensenovaRequestParamKey>> = new Map([
  ['sensenova-6.8-flash-lite', new Set<SensenovaRequestParamKey>(['top_p', 'frequency_penalty', 'presence_penalty', 'seed'])],
  ['deepseek-v4-flash', new Set<SensenovaRequestParamKey>(['top_p', 'frequency_penalty', 'presence_penalty', 'seed'])],
  ['deepseek-flash', new Set<SensenovaRequestParamKey>(['top_p', 'frequency_penalty', 'presence_penalty', 'seed'])],
  ['glm-5.2', new Set<SensenovaRequestParamKey>(['top_p', 'frequency_penalty', 'presence_penalty', 'seed', 'do_sample'])],
  ['kimi-k3', new Set<SensenovaRequestParamKey>()],
]);

/** L2 参数的连接级取值（全部可选；未设置即不注入）。 */
export interface SensenovaRequestParams {
  /** 核采样阈值；思考模式下服务端会把 < 0.95 抬到 0.95，非思考模式固定 1.0 并被忽略。 */
  topP?: number;
  /** 频率惩罚。思考模式下不生效（服务端不报错）。 */
  frequencyPenalty?: number;
  /** 存在惩罚。思考模式下不生效（服务端不报错）。 */
  presencePenalty?: number;
  /** 随机种子（Beta）。 */
  seed?: number;
  /** 仅 glm-5.2：`false` 时忽略 temperature/top_p，输出更稳定（适合代码/翻译）。 */
  doSample?: boolean;
}

/**
 * 按模型白名单过滤 L2 参数，产出可直接并入请求体的字段。
 *
 * @param model - wire 模型 id。
 * @param params - 连接级配置取值。
 * @returns 仅含该模型允许且确实配置了的字段；表外模型返回空对象。
 */
export function l2ParamsFor(model: string, params: SensenovaRequestParams): Record<string, unknown> {
  const allowed = MODEL_L2_PARAM_SUPPORT.get(model);
  if (allowed === undefined) return {};
  const out: Record<string, unknown> = {};
  if (allowed.has('top_p') && params.topP !== undefined) out.top_p = params.topP;
  if (allowed.has('frequency_penalty') && params.frequencyPenalty !== undefined) out.frequency_penalty = params.frequencyPenalty;
  if (allowed.has('presence_penalty') && params.presencePenalty !== undefined) out.presence_penalty = params.presencePenalty;
  if (allowed.has('seed') && params.seed !== undefined) out.seed = params.seed;
  if (allowed.has('do_sample') && params.doSample !== undefined) out.do_sample = params.doSample;
  return out;
}

/** 0.1.5 的每请求图片预算形状（`ImageRequestPolicy`：像素总量 + 编码字节目标）。 */
export interface ImageRequestPolicyLike {
  maxPixels: number;
  maxBytes: number;
}

/**
 * 0.1.6 的每请求图片目标形状（`ImageRequestTarget`：目标边长 + 编码字节目标）。
 *
 * 🔴 **0.1.6 的破坏性变更点**：`AttachmentStore.readImageRequest` 的第二参数由
 * `ImageRequestPolicy {maxPixels,maxBytes}` 改为 `ImageRequestTarget {width,height,maxBytes}`
 * （harness commit `ba30b73f7b`「求解器留在 llm-deepseek，存储层只接收目标尺寸」）。
 * 存储层用 `checkedInteger(target.width)` 强校验，传旧形状必然抛
 * `INVALID_ATTACHMENT_REF`（"Image request width must be a positive integer."）。
 */
export interface ImageRequestTargetLike {
  width: number;
  height: number;
  maxBytes: number;
}

/**
 * 默认图片预算（对齐 DSH llm-pi-ai 默认：2048² 像素 / 1MB 编码目标）。
 *
 * 2026-09-17：此前 adapter.ts 与 index.ts 各写了一份字面量（值相同），
 * `tsc --noEmit` 的 `noUnusedLocals` 把 adapter 这份判为死代码。改为导出后由
 * index.ts 引用，既消除重复又保留单一事实来源。
 */
export const DEFAULT_IMAGE_POLICY: ImageRequestPolicyLike = { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 };

/**
 * 由图片自身尺寸求出请求目标，并**同时带上 0.1.5 的 `maxPixels`** ⇒ 同一份返回值
 * 在 0.1.5（读 `maxPixels`/`maxBytes`）与 0.1.6（读 `width`/`height`/`maxBytes`）上
 * 都能通过校验，降级回 0.1.5 不必回滚本文件。
 *
 * 尺寸投影刻意复刻 harness `@deepseek-ai/dsh-attachment` 的 `requestImageDimensions()`
 * （`packages/attachment/attachment/src/request-projection.ts`）：按 `maxPixels` 等比
 * 缩放、长边取地板/短边取四舍五入、再逐像素回退直到不超预算。**不 import 那个包**是
 * 为了不新增外部依赖（tsdown 的 external 约定）；代价是这段数学必须与上游保持一致。
 *
 * @param ref - 持久化图片引用（至少含 `width`/`height`）。
 * @param maxPixels - 像素总量预算；缺省 `DEFAULT_IMAGE_POLICY.maxPixels`。
 * @param maxBytes - 编码字节目标；缺省 `DEFAULT_IMAGE_POLICY.maxBytes`。
 * @returns 0.1.6 形状 + `maxPixels` 兼容字段。
 */
export function requestImageTarget(
  ref: Pick<ImageAttachmentRefLike, 'width' | 'height'>,
  maxPixels: number = DEFAULT_IMAGE_POLICY.maxPixels,
  maxBytes: number = DEFAULT_IMAGE_POLICY.maxBytes,
): ImageRequestTargetLike & { maxPixels: number } {
  const { width, height } = ref;
  // 尺寸异常（缺字段/非正）时退回 1×1 的正整数目标：宁可变糊，也不要因校验抛错丢掉整张图。
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1, maxBytes, maxPixels };
  }
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height, maxBytes, maxPixels };
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale));
    let projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    }
    return { width: projectedWidth, height: projectedHeight, maxBytes, maxPixels };
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale));
  let projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1;
    projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
  }
  return { width: projectedWidth, height: projectedHeight, maxBytes, maxPixels };
}

/** DSH 持久化图片引用的最小结构（对齐 @deepseek-ai/dsh-attachment 的 ImageAttachmentRef）。 */
export interface ImageAttachmentRefLike {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

/**
 * 附件服务的图片读取子集（对齐 DSH `AttachmentStore.readImageRequest`）。
 *
 * ⚠️ 第二参数刻意写成**双形状可选**（0.1.5 的 `maxPixels` + 0.1.6 的 `width`/`height`）。
 * 本文件不 import `@deepseek-ai/dsh-attachment` 的类型（避免新增包依赖）⇒
 * **上游契约漂移 `tsc` 完全看不见**：2026-09-20 的读图全线失效就是这样漏过去的
 * （详见 `requestImageTarget` 注释）。改这里时**必须人工比对**上游 `types.ts`。
 */
export interface ImageAttachmentsLike {
  readImageRequest(
    ref: ImageAttachmentRefLike,
    target: Partial<ImageRequestPolicyLike> & Partial<ImageRequestTargetLike> & { maxBytes: number },
    signal?: AbortSignal,
  ): Promise<{ mediaType: string; data: Uint8Array }>;
}

/**
 * 造出 adapter 的 `resolveImage` 依赖：把宿主持久化附件读成请求字节。
 *
 * 抽成独立函数（而不是写成 `index.ts` 里 deps 字面量中的内联箭头函数）是为了**可测**：
 * 回归护栏必须贴着真实的 `readImageRequest` 调用点断言第二参数形状；若改成 mock
 * `resolveImage` 自身，就永远测不到「契约漂移」这一类失效（本插件 160 个单测当年
 * 全绿却线上全丢图，正是这个盲区）。
 *
 * @param getAttachments - 取当前附件服务；未挂载时返回 undefined。
 * @returns 单图解析函数；附件服务缺失时返回 undefined（该图被跳过，正文仍发出）。
 */
export function createResolveImage(
  getAttachments: () => ImageAttachmentsLike | undefined,
): (ref: ImageAttachmentRefLike, signal?: AbortSignal) => Promise<{ mediaType: string; data: Uint8Array } | undefined> {
  return async (ref, signal) => {
    const attachments = getAttachments();
    if (attachments === undefined) return undefined;
    const image = await attachments.readImageRequest(ref, requestImageTarget(ref), signal);
    return { mediaType: image.mediaType, data: image.data };
  };
}

export interface SensenovaAdapterDeps {
  /** 每请求的连接事实（apiBase、账户数、并发上限、配额轮换开关）。 */
  options: () => SensenovaConnection;
  /**
   * 解析一个可用 key（无可解析 key 时抛 MISSING_CREDENTIAL）。
   *
   * `hint.preferredKey` 是**偏好**而非强制：实现（`index.ts`）会把它交给 key 池校验，
   * 仅当该 key 仍处于运行态时才采纳，否则回落到运行态的正确一把。这是「会话粘性」不退化成
   * 死锁的关键 —— 粘住的 key 若已被踢入阻塞态或被 401 移除，会自动让位。
   */
  resolveApiKey: (
    connection: SensenovaConnection,
    hint?: { preferredKey?: string },
  ) => Promise<string>;
  /**
   * 轮换到下一个 key：401（'invalid-credential'）永久禁用被拒账号并从池中移除；
   * 配额类 429（'quota-exhausted'）不写任何账号状态，仅用于换 key（design D5）。
   *
   * @param exclude - 本轮已试过的 key（适配器的 `tried`）。池会跳过它们，并在运行态
   *   候选耗尽时借用阻塞态中「阻塞最久」的一把（**不改变其相位**）。
   * @returns undefined 表示无更多可试的 key。
   */
  rotateApiKey: (
    rejectedKey: string,
    rejection: 'invalid-credential' | 'quota-exhausted',
    exclude?: ReadonlySet<string>,
  ) => Promise<string | undefined>;
  /**
   * 上报一次限流分类，由 `index.ts` 转交 key 池处理（2026-09-27 新增）。
   *
   * **只有 `'tpm'` 会累计连续命中并在达阈值时把该 key 踢出运行态**；`'rpm'` / `'rate'`
   * 只记不踢（它们是秒级桶、15s 量级自愈，踢掉只会白白损失该 key 上的 prompt cache）。
   *
   * @returns 池的两态把数与本次是否发生踢出；未注入时返回 undefined（纯 adapter 单测场景）。
   */
  reportRateLimit?: (
    key: string,
    kind: 'tpm' | 'rpm' | 'rate',
  ) => { kicked: boolean; running: number; blocked: number } | undefined;
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
  describeKey?: (key: string) => { label: string; ref: string } | undefined;
  fetchImpl?: typeof fetch;
  /** 每 key 并发闸；缺省为进程内实例（可注入以利测试）。 */
  concurrencyGate?: KeyedConcurrencyGate;
  /** 三段超时注入（测试用）；缺省为生产常量。 */
  timeouts?: SensenovaTimeouts;
  /**
   * 图片字节解析（视觉模型需要）：把宿主持久化附件引用读成请求用字节。
   * 缺省或返回 undefined 时，该图片被静默跳过（正文仍按纯文本发送）。
   */
  resolveImage?: (
    ref: ImageAttachmentRefLike,
    signal?: AbortSignal,
  ) => Promise<{ mediaType: string; data: Uint8Array } | undefined>;
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
}

/** 目录条目：宿主所需的能力元数据快照（listModels 后缓存，resolveModel 消费）。 */
interface CatalogEntry {
  id: string;
  name: string;
  inputModalities: readonly ModelModality[];
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: LlmModelReasoningInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 把模型 id 标准化为可读显示名：显式映射优先，否则按品牌前缀回退。 */
function displayNameFor(id: string): string {
  const override = DISPLAY_NAME_OVERRIDES.get(id);
  if (override !== undefined) return override;
  const normalized = id.trim();
  // 回退规则：按连字符/下划线切词（点号属于版本号，如 6.8、u1.5，需保留），
  // 再按大写边界切词，首字母大写其余小写。
  const words = normalized
    .split(/[-_]+/)
    .filter((part) => part !== '')
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/));
  if (words.length === 0) return normalized;
  const titled = words.map((word) => (word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word));
  return titled.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 展平一条 tool 消息的内容为纯文本（OpenAI `role:"tool"` 的 content 是字符串）。
 *
 * ⚠️ **0.1.7 起不再需要递归**：`ToolResultBlock`（`type: 'tool-result'`）已从
 * `ContentBlockMap` 中移除，工具结果改为**一等消息** `ToolResultMessage`
 * （`role: 'tool'`）。也就是说内容块不再嵌套工具结果，没有可递归的层级。
 */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text;
      // 工具结果里的图片本来只投影为文本；被 offload 的那些必须留下占位文本，
      // 否则模型完全不知道这里曾有图（0.1.6 契约）。
      if (block.type === 'image' && isOffloadedImage(block)) return offloadedImageText(block.attachment);
      return '';
    })
    .join('');
}

/** 拼出某条消息的可见文本（`RequestMessage` 含无身份的 `RequestUserInput`，两者都有 `content`）。 */
function flattenText(message: RequestMessage): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
}

/**
 * 该图片块是否被宿主标记为「本条请求不要发送」。
 *
 * 刻意不写成 `block.offloaded === true`：`ImageBlock.offloaded` 是 **0.1.6 新增**的
 * 字段（0.1.5 的 `ImageBlock` 只有 `type` + `attachment`）。经这个结构化参数读取，
 * 本文件在 0.1.5 与 0.1.6 的类型下都能通过 `tsc`；运行时在 0.1.5 上恒为 `false`，
 * 行为退化为改动前的样子 ⇒ **降级回 0.1.5 不需要回滚本插件的源码**。
 */
function isOffloadedImage(block: { offloaded?: unknown }): boolean {
  return block.offloaded === true;
}

/**
 * 收集一条消息内容里的图片引用。
 *
 * ⚠️ **0.1.7 起不再递归**：`ToolResultBlock` 已从 `ContentBlockMap` 移除，工具结果
 * 成了一等消息（`role: 'tool'`）⇒ 图片只出现在各消息内容的**顶层**，没有嵌套层级。
 * 上层按消息逐条调用本函数，因此工具消息里的图片同样会被收到。
 *
 * ⚠️ **跳过被 offload 的图片**：那是宿主持久化的「本条请求不要再发图」决定（由
 * `compaction-image-offload` 在官方路由触发 `IMAGE_OFFLOAD_REQUIRED` 后写下的
 * `image/offload` 事件投影而来）。0.1.6 的契约是**每条路由**都为这些出现位置发送
 * 占位文本（见 `ImageBlock.offloaded` 的注释）。若这里照样去解析并发送字节，就会
 * 把宿主刻意省掉的图片重新塞回请求里 —— 既违背决定，又可能直接撑爆请求体
 * （本路由没有任何总字节预算）。
 */
function collectImageRefs(
  blocks: readonly ContentBlock[],
  refs: Map<string, ImageAttachmentRefLike>,
): void {
  for (const block of blocks) {
    if (block.type === 'image' && !isOffloadedImage(block)) {
      refs.set(block.attachment.attachmentId, block.attachment);
    }
  }
}

/**
 * 把消息历史里的图片预解析为 Base64 Data-URL。
 * kimi-k3 只接受 `data:image/...;base64,...`（不支持公网 URL），6.8-flash-lite
 * 同样接受 Base64，故统一按 data URL 发送；单图解析失败只跳过该图，不打断请求。
 */
async function prepareImageDataUrls(
  messages: readonly RequestMessage[],
  resolveImage: SensenovaAdapterDeps['resolveImage'],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const refs = new Map<string, ImageAttachmentRefLike>();
  for (const message of messages) collectImageRefs(message.content, refs);
  const out = new Map<string, string>();
  if (refs.size === 0 || resolveImage === undefined) return out;
  for (const ref of refs.values()) {
    try {
      const resolved = await resolveImage(ref, signal);
      if (resolved !== undefined) {
        out.set(ref.attachmentId, `data:${resolved.mediaType};base64,${Buffer.from(resolved.data).toString('base64')}`);
      }
    } catch {
      // 单图解析失败不打断整次请求：跳过该图，正文仍按纯文本发送。
    }
  }
  return out;
}

/** 从目录条目读取一个正数能力字段（按优先级），缺失/非法返回 undefined。 */
function firstPositiveNumber(raw: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

function firstContextField(raw: Record<string, unknown>): number | undefined {
  return firstPositiveNumber(raw, ['context_length', 'context_window', 'max_context_length', 'contextLength']);
}

function firstMaxOutputField(raw: Record<string, unknown>): number | undefined {
  // max_output_length 是 SenseNova /models 目录的实际字段名，置首优先；OpenAI 风格字段保留兜底。
  return firstPositiveNumber(raw, ['max_output_length', 'max_tokens', 'max_output_tokens', 'max_completion_tokens', 'maxTokens', 'maxOutputTokens', 'maxCompletionTokens']);
}

/**
 * 解析一个模型的输出预算：**静态覆盖表优先，目录字段兜底**。
 *
 * ⚠️ 目录的 `max_output_length` 被证实不可信（2026-09-23 实测：8/9 模型都是
 * `65536` 占位值，把 v4.1 的 131072 与 kimi 的 128K 都压成一半）。
 * 因此**已知模型一律走 `MODEL_MAX_OUTPUT_OVERRIDES`**，只有表外的新模型才回落目录值。
 */
function maxOutputFor(raw: Record<string, unknown>, modelId: string): number | undefined {
  return MODEL_MAX_OUTPUT_OVERRIDES.get(modelId) ?? firstMaxOutputField(raw);
}

/**
 * 把目录声明的输入模态映射为宿主 ModelModality 列表；未声明时回退 ['text']。
 * 另按 DOCUMENTED_VISION_MODELS 修正滞后的元数据（补 image）。
 */
function inputModalitiesFrom(raw: Record<string, unknown>, modelId?: string): readonly ModelModality[] {
  const declared = raw.input_modalities;
  const modalities: ModelModality[] = [];
  if (Array.isArray(declared)) {
    for (const item of declared) {
      const modality = toString(item);
      if (modality === 'text' || modality === 'image') {
        if (!modalities.includes(modality)) modalities.push(modality);
      }
    }
  }
  // 文档已确认的视觉模型：元数据缺 image 时补上，否则宿主的 image admission gate
  // （llm 服务）会把图片投影成文本占位，请求里根本不会带图。
  if (modelId !== undefined && DOCUMENTED_VISION_MODELS.has(modelId) && !modalities.includes('image')) {
    modalities.push('image');
  }
  if (!modalities.includes('text')) modalities.unshift('text');
  return modalities;
}

/** 读取目录中的 effort 词表字段；返回字符串数组或 undefined（无明确词表）。 */
function effortListField(raw: Record<string, unknown>): readonly string[] | undefined {
  for (const key of ['reasoning_efforts', 'reasoning_levels']) {
    const value = raw[key];
    if (Array.isArray(value)) {
      const efforts = value.filter((item): item is string => typeof item === 'string' && item !== '');
      if (efforts.length > 0) return efforts;
    }
  }
  return undefined;
}

/** 读取嵌套 reasoning.efforts / thinking.efforts 词表；返回字符串数组或 undefined。 */
function nestedEffortListField(raw: Record<string, unknown>): readonly string[] | undefined {
  for (const key of ['reasoning', 'thinking']) {
    const holder = raw[key];
    if (!isRecord(holder)) continue;
    const efforts = holder.efforts;
    if (Array.isArray(efforts)) {
      const list = efforts.filter((item): item is string => typeof item === 'string' && item !== '');
      if (list.length > 0) return list;
    }
  }
  return undefined;
}

/** 读取目录中的默认 effort 字段；返回字符串或 undefined。 */
function defaultEffortField(raw: Record<string, unknown>): string | undefined {
  const direct = raw.default_reasoning_effort;
  if (typeof direct === 'string' && direct !== '') return direct;
  for (const key of ['reasoning', 'thinking']) {
    const holder = raw[key];
    if (isRecord(holder)) {
      const value = holder.defaultEffort ?? holder.default_effort;
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return undefined;
}

/**
 * 目录是否**明确排除** reasoning。
 *
 * 🔴 2026-09-23 语义修正（取代原 `hasReasoningSupport`）：旧逻辑要求「目录必须
 * **声明**支持 reasoning」才允许静态表生效。但 Phase 0 实测目录 9/9 模型**都不给
 * effort 词表**，而部分目录条目压根没有 `supported_features` 字段 —— 旧逻辑会把
 * 「沉默」误判成「不支持」，冷目录下档位选择器因此消失。
 *
 * 新语义：**只有目录明确列出 `supported_features` 且其中不含 `reasoning`** 才拦下
 * 静态表；其余情形（没条目、条目里没这个字段、条目声明了 reasoning）都放行。
 * 也就是说：目录的「沉默」不等于「否定」。
 *
 * @returns true = 目录明确说不支持 reasoning，应隐藏档位。
 */
function catalogExcludesReasoning(raw: Record<string, unknown>): boolean {
  const features = raw.supported_features;
  return Array.isArray(features) && !features.includes('reasoning');
}

/**
 * 档位展示元数据：wire 原值 → 用户可读文案。
 *
 * 🔴 2026-09-23 新增。此前 `name` 直接取 wire 原值 ⇒ 选择器里显示小写 `none`，
 * 排在 `low/medium/high` **之后**、且无任何说明。实测这正是用户「感觉插件没提供
 * 思考开关」的真实原因 —— **开关一直存在，只是长成了裸标识符 + 末位**。
 * 对齐官方 `llm-deepseek` 的 `Off / Low / High / Max` 范式
 * （`packages/llm/llm-deepseek/src/model-info.ts:9-40`）。
 *
 * ⚠️ **只有 `name`/`description` 可以改，`id` 必须是 wire 原值** ——
 * 本适配器把 `reasoningEffort` 原样透传进请求体（`buildOpenAiBody`），
 * 所以 id 写错（例如照抄官方的 `off`）会被服务端 400 拒掉。
 *
 * 文案语言：`name` 用英文（选择器里空间紧、且与官方 UI 一致），
 * `description` 用中文（说明槽位给母语收益最大）。适配器层拿不到客户端 locale，
 * 这两处**无法**走插件的 zh/en 本地化。
 */
export const EFFORT_LABELS: ReadonlyMap<string, { name: string; description: string }> = new Map([
  ['none', { name: 'Off', description: '关闭思考通道，直接作答。适合简单问答、内容提取、格式转换，延迟最低。' }],
  ['minimal', { name: 'Minimal', description: '最轻量思考。仅 glm-5.2 / kimi-k3 / v4.1 接受。' }],
  ['low', { name: 'Low', description: '轻度推理，延迟与 token 消耗较低。适合简单任务与延迟敏感场景。' }],
  ['medium', { name: 'Medium', description: '中等推理，在速度与效果之间平衡。适合一般分析与内容生成。' }],
  ['high', { name: 'High', description: '增强推理，多数模型的服务端默认档。适合常规推理、代码生成。' }],
  ['xhigh', { name: 'Extra High', description: '更高强度推理。是 6.8-flash-lite 与 v4-flash 的服务端上限档。' }],
  ['max', { name: 'Max', description: '深度推理，消耗最多 token 与时间。适合复杂推理、长程任务。' }],
]);

/**
 * 解析一个模型的可选档位。
 *
 * 优先级：**目录词表 > 静态表**。目录词表实测从未出现过（9/9 模型都不给
 * `reasoning_efforts`/`reasoning_levels`），所以实际全部走静态表。
 *
 * ⚠️ 冷目录必须也能给出档位：`resolveModel` 不会主动拉目录（只有 `listModels` 会），
 * 因此首次打开模型选择器时 `raw` 是空记录。空记录 ⇒ 信任静态表；
 * 有记录但未声明 reasoning ⇒ 尊重目录（不放档位）。
 */
function reasoningInfoFrom(raw: Record<string, unknown>, modelId: string): LlmModelReasoningInfo | undefined {
  const efforts = effortListField(raw) ?? nestedEffortListField(raw);
  const knownEfforts = KNOWN_EFFORTS.get(modelId);
  const selectedEfforts = efforts ?? (
    knownEfforts !== undefined && !catalogExcludesReasoning(raw) ? knownEfforts : undefined
  );
  if (selectedEfforts === undefined || selectedEfforts.length === 0) return undefined;
  const infos = selectedEfforts.map((effort) => {
    const label = EFFORT_LABELS.get(effort);
    return {
      id: ReasoningEffortId(effort),
      name: label?.name ?? effort,
      ...(label !== undefined ? { description: label.description } : {}),
    };
  });
  const defaultEffort = efforts !== undefined ? defaultEffortField(raw) : undefined;
  const defaultId = defaultEffort !== undefined && selectedEfforts.includes(defaultEffort)
    ? ReasoningEffortId(defaultEffort)
    : undefined;
  return {
    efforts: infos,
    ...(defaultId !== undefined ? { defaultEffort: defaultId } : {}),
  };
}

/** 解析 OpenAI 模型目录为目录条目；应用自动过滤与手动 include/exclude 覆盖。 */
function parseCatalog(value: unknown, failedModels: ReadonlySet<string>, selection: ModelSelection): CatalogEntry[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new LlmError('llm-sensenova: unexpected models response shape', 'PROVIDER_PROTOCOL_ERROR');
  }
  const include = new Set(selection.include);
  const exclude = new Set(selection.exclude);
  const out: CatalogEntry[] = [];
  for (const raw of value.data) {
    if (!isRecord(raw)) continue;
    const id = toString(raw.id);
    if (id === undefined || id === '') continue;
    // 1) image-only 永远排除：output_modalities 必须含 text，否则不可进入 chat 选择器。
    const output = raw.output_modalities;
    const outputsText = Array.isArray(output) ? output.some((item) => toString(item) === 'text') : false;
    if (!outputsText) continue;
    // 2) 显式 exclude 优先（即使 include 也排除）。
    if (exclude.has(id)) continue;
    // 3) 显式 include 可重新加入目录中的已知/失败 stale 文本模型。
    // 4) 否则按已知不可路由清单与失败缓存过滤。
    if (!include.has(id)) {
      if (KNOWN_UNROUTABLE_MODELS.has(id)) continue;
      if (failedModels.has(id)) continue;
    }
    const contextWindow = firstContextField(raw);
    const maxOutputTokens = maxOutputFor(raw, id);
    const reasoning = reasoningInfoFrom(raw, id);
    out.push({
      id,
      name: displayNameFor(id),
      inputModalities: inputModalitiesFrom(raw, id),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    });
  }
  return out;
}

/** 把 OpenAI 消息历史翻译为 OpenAI 请求体消息数组（imageData：附件 id → Base64 Data-URL）。 */
function toOpenAiMessages(options: GenerateOptions, imageData: ReadonlyMap<string, string>): unknown[] {
  const systemParts: string[] = [];
  if (options.system !== undefined && options.system !== '') systemParts.push(options.system);
  for (const message of options.messages) {
    // `developer` 是 0.1.7 新增的角色（0.1.6 只有 system/user/assistant）。官方 DeepSeek
    // 适配器对线协议**刻意推迟**它（`unsupported('developer message')`）；本适配器选择把它
    // 折进系统前缀 —— 指令不丢，且不必为 SenseNova 未验证的 wire role 冒险。
    if (message.role === 'system' || message.role === 'developer') systemParts.push(flattenText(message));
  }
  const systemText = systemParts.filter(Boolean).join('\n\n');

  const messages: unknown[] = [];
  if (systemText !== '') messages.push({ role: 'system', content: systemText });
  // 历史 assistant tool-call 清洗状态：SenseNova 会对 name/arguments 为空的 tool_call 报 400
  // （invalid tool_call function, function/name/arguments cannot be empty）。
  // 上轮失败产生的空 tool_call 不能原样回放：name 为空的调用直接丢弃（含其孤立 tool-result），
  // arguments 空串补 '{}'，id 空串合成稳定 id 并让对应 tool-result 跟随映射。
  const toolCallIdRemap = new Map<string, string>();
  let syntheticToolCallSeq = 0;
  for (const message of options.messages) {
    if (message.role === 'system' || message.role === 'developer') continue;
    // 🆕 0.1.7：工具结果成了**一等消息**（`role: 'tool'`，带 `toolCallId`/`isError`），
    // 不再是嵌在 user content 里的 `tool-result` 块。只回放能映射到已登记 tool_call 的
    // 结果：孤立结果与映射不到的坏历史 id 直接丢弃，避免 SenseNova 报 400。
    if (message.role === 'tool') {
      const remappedId = toolCallIdRemap.get(message.toolCallId);
      if (remappedId === undefined) continue;
      messages.push({
        role: 'tool',
        tool_call_id: remappedId,
        content: toolResultText(message.content) || '(no output)',
      });
      continue;
    }
    if (message.role === 'assistant') {
      const text = flattenText(message);
      const toolCalls = message.content.filter((block): block is ToolCallBlock => block.type === 'tool-call');
      const sanitizedCalls = [];
      for (const call of toolCalls) {
        if (call.name === '' || call.name === undefined) {
          continue; // name 为空的失败 tool_call 丢弃；其 tool-result 因映射不到 id 同步被丢弃
        }
        syntheticToolCallSeq += 1;
        const keptId = call.id !== '' && call.id !== undefined ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
        toolCallIdRemap.set(call.id, keptId);
        sanitizedCalls.push({
          id: keptId,
          type: 'function',
          function: { name: call.name, arguments: call.arguments !== '' && call.arguments !== undefined ? call.arguments : '{}' },
        });
      }
      if (text === '' && sanitizedCalls.length === 0) continue; // 空壳 assistant 消息（content:null 且无 tool_calls）同样会被拒收
      const entry: Record<string, unknown> = { role: 'assistant', content: text !== '' ? text : null };
      if (sanitizedCalls.length > 0) entry.tool_calls = sanitizedCalls;
      messages.push(entry);
      continue;
    }
    // 余下只有 user 角色：文本 + 图片（工具结果已在上面 `role === 'tool'` 分支处理，
    // 0.1.7 起不再嵌在 user content 里）。
    const text = flattenText(message);
    const images: string[] = [];
    const omitted: string[] = [];
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      // offload 掉的图片：不发字节，改为占位文本（0.1.6 契约，见 collectImageRefs 注释）。
      if (isOffloadedImage(block)) {
        omitted.push(offloadedImageText(block.attachment));
        continue;
      }
      const url = imageData.get(block.attachment.attachmentId);
      if (url !== undefined) images.push(url);
    }
    // 占位文本并入正文（追加在可见文本之后）。
    const bodyText = [text, ...omitted].filter((part) => part !== '').join('\n');
    if (images.length > 0) {
      // 有图必须发 content 数组（kimi-k3 强制要求）；图片在前、文本在后（官方示例顺序）。
      messages.push({
        role: 'user',
        content: [
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ...(bodyText !== '' ? [{ type: 'text', text: bodyText }] : []),
        ],
      });
    } else if (bodyText !== '') {
      messages.push({ role: 'user', content: bodyText });
    }
  }
  return messages;
}

/** 组装 OpenAI /chat/completions 请求体。 */
export function buildOpenAiBody(
  options: GenerateOptions,
  imageData: ReadonlyMap<string, string>,
  l2Params: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const tools = (options.tools ?? []).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  return {
    model: options.model,
    messages: toOpenAiMessages(options, imageData),
    stream: true,
    // 🔴 2026-09-23 显式写死 —— 此前完全依赖服务端默认值（实测缺省确实为 true）。
    //
    // 为什么不能依赖默认值：实测显式传 `{ include_usage: false }` 时 **usage 帧会整个消失**
    // （finish 帧后直接 `[DONE]`，不报错、不缺字段）。⇒ 上游哪天把缺省翻成 false，
    // `assistant/message` 的 `usage` 会**静默变空**，本插件的限流记账与
    // `llm-rate-limit` 的真实记账会一起静默失效，症状和"日志是空的"一样难查。
    // 显式写死把"默认值依赖"变成"契约"。
    stream_options: { include_usage: true },
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {}),
    // L2（连接级默认值，按模型白名单过滤后并入）。放在最后 ⇒ 不与宿主显式传入的
    // 同名字段冲突（宿主目前没有这些字段，但保留顺序以策后向兼容）。
    ...l2Params,
  };
}

/** OpenAI usage → 宿主 TokenUsage（inputTokens 为未缓存输入，缓存读单独计）。 */
function mapUsage(usage: Record<string, unknown>): TokenUsage {
  const prompt = toNumber(usage.prompt_tokens);
  const completion = toNumber(usage.completion_tokens);
  const total = toNumber(usage.total_tokens);
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined;
  const cacheRead = promptDetails !== undefined ? toNumber(promptDetails.cached_tokens) : 0;
  const reasoning = completionDetails !== undefined ? toNumber(completionDetails.reasoning_tokens) : 0;
  return {
    inputTokens: Math.max(0, prompt - cacheRead),
    outputTokens: completion,
    totalTokens: total > 0 ? total : prompt + completion,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** OpenAI finish_reason → 宿主 FinishReason。 */
function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' };
    case 'tool_calls':
    case 'function_call': return { kind: 'tool-calls' };
    case 'length': return { kind: 'max-tokens' };
    case 'aborted': return { kind: 'aborted', failure: { message: 'SenseNova stream aborted', code: 'ABORTED' } };
    default: return { kind: 'stop' };
  }
}

/** 解析一行 SSE；返回解析后的数据对象，`[DONE]` 或空行/注释行返回 undefined。 */
function parseSseDataLine(line: string): unknown {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return undefined;
  if (trimmed.startsWith('data:')) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === '[DONE]') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** SSE 翻译期间的增量组装状态。 */
interface SseState {
  nextIndex: number;
  textIndex: number;
  textContent: string;
  reasoningIndex: number;
  reasoningContent: string;
  toolIndexById: Map<string, number>;
  toolIndexByProtocolIndex: Map<number, number>;
  /** 无 index 且无 id 的退化分片：name → 槽位（name 是工具边界）。 */
  toolIndexByAnonymousName: Map<string, number>;
  /** 最近一次无键续片指向的槽（无 name 续片回退目标）。 */
  lastAnonymousIndex: number;
  toolIdByIndex: Map<number, string>;
  toolNameByIndex: Map<number, string>;
  toolArgsByIndex: Map<number, string>;
  sawContent: boolean;
  pendingUsage: TokenUsage | undefined;
  usageEmitted: boolean;
  finished: boolean;
}

function createSseState(): SseState {
  return {
    nextIndex: 0,
    textIndex: -1,
    textContent: '',
    reasoningIndex: -1,
    reasoningContent: '',
    toolIndexById: new Map(),
    toolIndexByProtocolIndex: new Map(),
    toolIndexByAnonymousName: new Map(),
    lastAnonymousIndex: -1,
    toolIdByIndex: new Map(),
    toolNameByIndex: new Map(),
    toolArgsByIndex: new Map(),
    sawContent: false,
    pendingUsage: undefined,
    usageEmitted: false,
    finished: false,
  };
}

function closeText(state: SseState): StreamChunk[] {
  if (state.textIndex < 0) return [];
  const chunk: StreamChunk = {
    type: 'block-end',
    index: state.textIndex,
    block: { type: 'text', text: state.textContent },
  };
  state.textIndex = -1;
  state.textContent = '';
  return [chunk];
}

function closeReasoning(state: SseState): StreamChunk[] {
  if (state.reasoningIndex < 0) return [];
  const chunk: StreamChunk = {
    type: 'block-end',
    index: state.reasoningIndex,
    block: { type: 'reasoning', text: state.reasoningContent },
  };
  state.reasoningIndex = -1;
  state.reasoningContent = '';
  return [chunk];
}

function closeToolCalls(state: SseState): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [index, args] of [...state.toolArgsByIndex.entries()]) {
    const name = state.toolNameByIndex.get(index) ?? '';
    if (name === '') continue; // name 始终未到达的残缺调用不产出 tool-call block，避免污染历史导致后续 400
    const id = state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`;
    chunks.push({
      type: 'block-end',
      index,
      block: {
        type: 'tool-call',
        id: ToolCallId(id),
        name,
        arguments: args !== '' ? args : '{}',
      },
    });
  }
  state.toolArgsByIndex.clear();
  state.toolIdByIndex.clear();
  state.toolNameByIndex.clear();
  state.toolIndexById.clear();
  state.toolIndexByProtocolIndex.clear();
  state.toolIndexByAnonymousName.clear();
  state.lastAnonymousIndex = -1;
  return chunks;
}

/** 将事件中的 usage 转成单次 usage chunk，避免 finish/trailing 重复发出。 */
function usageChunksFrom(event: unknown, state: SseState): StreamChunk[] {
  if (state.usageEmitted || !isRecord(event)) return [];
  const usageRec = isRecord(event.usage) ? event.usage : undefined;
  if (state.pendingUsage === undefined && usageRec === undefined) return [];
  const usage = state.pendingUsage ?? mapUsage(usageRec as Record<string, unknown>);
  state.pendingUsage = undefined;
  state.usageEmitted = true;
  return [{ type: 'usage', usage }];
}

/** 处理一个 OpenAI SSE 数据对象，返回对应的宿主 StreamChunk 序列。 */
function processChunkEvent(event: unknown, state: SseState): StreamChunk[] {
  if (!isRecord(event)) return [];
  const choices = event.choices;
  if (!Array.isArray(choices)) return usageChunksFrom(event, state);
  const chunks: StreamChunk[] = [];
  for (const rawChoice of choices) {
    if (state.finished) break;
    if (!isRecord(rawChoice)) continue;
    const delta = isRecord(rawChoice.delta) ? rawChoice.delta : undefined;
    const finishReasonRaw = rawChoice.finish_reason;
    const finishReason = typeof finishReasonRaw === 'string' && finishReasonRaw !== '' && finishReasonRaw !== 'null' ? finishReasonRaw : undefined;

    if (delta !== undefined) {
      const content = toString(delta.content) ?? '';
      // 6.8 系使用 reasoning，其他模型使用 reasoning_content；同一事件以前者为优先。
      const reasoning = toString(delta.reasoning_content) ?? toString(delta.reasoning) ?? '';
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : [];

      if (reasoning !== '') {
        chunks.push(...closeText(state));
        if (state.reasoningIndex < 0) {
          state.reasoningIndex = state.nextIndex;
          state.nextIndex += 1;
          chunks.push({ type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' });
        }
        state.reasoningContent += reasoning;
        chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text: reasoning });
      }

      if (content !== '') {
        chunks.push(...closeReasoning(state));
        if (state.textIndex < 0) {
          state.textIndex = state.nextIndex;
          state.nextIndex += 1;
          chunks.push({ type: 'block-start', index: state.textIndex, blockType: 'text' });
        }
        state.textContent += content;
        state.sawContent = true;
        chunks.push({ type: 'text-delta', index: state.textIndex, text: content });
      }

      for (const tc of toolCalls) {
        const id = toString(tc.id) ?? '';
        const protocolIndex = typeof tc.index === 'number' && Number.isInteger(tc.index) ? tc.index : undefined;
        const fn = isRecord(tc.function) ? tc.function : undefined;
        const name = fn !== undefined ? (toString(fn.name) ?? '') : '';
        const argsDelta = fn !== undefined ? (toString(fn.arguments) ?? '') : '';
        // OpenAI 规范的 index 优先；非规范响应依次回退到稳定 id、匿名 name。
        let index: number | undefined;
        if (protocolIndex !== undefined) {
          index = state.toolIndexByProtocolIndex.get(protocolIndex);
        } else if (id !== '') {
          index = state.toolIndexById.get(id);
        } else if (name !== '') {
          // name 是匿名分片流的工具边界：同 name 归同槽（可能跨事件续片）。
          index = state.toolIndexByAnonymousName.get(name);
        } else {
          // 纯 arguments 续片：无 name 无法标识工具，续最近匿名槽（防御性，
          // 真实网关不会发既无 index/id 也无 name 的分片流）。
          index = state.lastAnonymousIndex >= 0 ? state.lastAnonymousIndex : undefined;
        }
        if (index === undefined) {
          chunks.push(...closeText(state), ...closeReasoning(state));
          index = state.nextIndex;
          state.nextIndex += 1;
          if (protocolIndex !== undefined) state.toolIndexByProtocolIndex.set(protocolIndex, index);
          if (id !== '') state.toolIndexById.set(id, index);
          if (name !== '' && protocolIndex === undefined && id === '') {
            state.toolIndexByAnonymousName.set(name, index);
            state.lastAnonymousIndex = index;
          }
          state.toolIdByIndex.set(index, id);
          state.toolNameByIndex.set(index, name);
          state.toolArgsByIndex.set(index, '');
          chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
          state.sawContent = true;
        }
        if (id !== '') {
          state.toolIdByIndex.set(index, id);
          state.toolIndexById.set(id, index);
        }
        if (name !== '') state.toolNameByIndex.set(index, name);
        if (protocolIndex === undefined && id === '' && name !== '') {
          state.toolIndexByAnonymousName.set(name, index);
          state.lastAnonymousIndex = index;
        }
        const accumulated = (state.toolArgsByIndex.get(index) ?? '') + argsDelta;
        state.toolArgsByIndex.set(index, accumulated);
        const effectiveName = state.toolNameByIndex.get(index) ?? '';
        chunks.push({
          type: 'tool-call-delta',
          index,
          id: ToolCallId(state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`),
          ...(effectiveName !== '' ? { name: effectiveName } : {}),
          argumentsDelta: argsDelta,
        });
      }
    }

    if (finishReason !== undefined) {
      state.finished = true;
      chunks.push(...closeText(state), ...closeReasoning(state), ...closeToolCalls(state));
      chunks.push(...usageChunksFrom(event, state));
      chunks.push({ type: 'finish', reason: mapFinishReason(finishReason) });
      continue;
    }

    const usageRec = isRecord(event.usage) ? event.usage : undefined;
    if (usageRec !== undefined && state.pendingUsage === undefined) {
      state.pendingUsage = mapUsage(usageRec);
    }
  }
  return chunks;
}

/** 把 OpenAI SSE 响应体翻译为宿主 StreamChunk 序列。 */
async function* parseOpenAiSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): AsyncIterable<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = createSseState();
  let buffer = '';
  let finished = false;
  // 流空闲看门狗（design D4，2026-09-04 实测：思考期渠道有空事件/心跳自然重置）：
  // 每次读到事件即重置计时；距上一事件 ≥ idleTimeoutMs 无任何 chunk/事件时以
  // TimeoutError 中断挂起的 read，走 finally 释放额度并在 catch 映射可重试 TIMEOUT。
  let watchdogReject: ((error: unknown) => void) | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogReject?.(new DOMException(`SenseNova stream idle for ${idleTimeoutMs}ms`, 'TimeoutError'));
    }, idleTimeoutMs);
  };
  const disarmWatchdog = () => {
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };
  try {
    for (;;) {
      // read 与看门狗竞争：看门狗先触发则中断挂起的 read（消费侧背压不计入空闲）。
      const read: ReadableStreamReadResult<Uint8Array> = await new Promise((resolve, reject) => {
        watchdogReject = reject;
        reader.read().then(resolve, reject);
        armWatchdog();
      });
      disarmWatchdog();
      const { done, value } = read;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseSseDataLine(line);
        if (event === undefined) continue;
        if (finished) {
          for (const chunk of usageChunksFrom(event, state)) yield chunk;
          continue;
        }
        for (const chunk of processChunkEvent(event, state)) {
          yield chunk;
          if (chunk.type === 'finish') finished = true;
        }
      }
    }
    if (buffer.trim() !== '') {
      const event = parseSseDataLine(buffer);
      if (event !== undefined) {
        if (finished) {
          for (const chunk of usageChunksFrom(event, state)) yield chunk;
        } else {
          for (const chunk of processChunkEvent(event, state)) {
            yield chunk;
            if (chunk.type === 'finish') finished = true;
          }
        }
      }
    }
    if (!finished) {
      const trailing = [...closeText(state), ...closeReasoning(state), ...closeToolCalls(state)];
      for (const chunk of trailing) yield chunk;
      if (!state.sawContent) {
        throw new LlmError('llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复', 'EMPTY_RESPONSE');
      }
      if (state.pendingUsage !== undefined) yield { type: 'usage', usage: state.pendingUsage };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  } catch (error) {
    // 连接超时 signal（与 fetch 共用）在流阶段触发时，reason 为 TimeoutError：
    // 同样按可重试 TIMEOUT 收口（宿主 signal abort 保持原样透传）。
    if ((signal?.aborted && isTimeoutReason(signal.reason)) || isTimeoutReason(error)) {
      throw new LlmError(
        `llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`,
        'TIMEOUT',
        { cause: error },
      );
    }
    if (signal?.aborted || error instanceof LlmError) throw error;
    throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, 'TRANSPORT', { cause: error });
  } finally {
    disarmWatchdog();
    await reader.cancel().catch(() => void 0);
    reader.releaseLock();
  }
}

/** 判断错误文本是否为「模型不可路由」的 404 措辞。 */
function isModelNotFoundText(errText: string): boolean {
  const lower = errText.toLowerCase();
  return lower.includes('model route not found') || lower.includes('model is not found');
}

/** 是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason(value: unknown): value is Error {
  return value instanceof Error && value.name === 'TimeoutError';
}

/** 429 分类结果：配额类附带退避下限（毫秒）；非配额类下限为 undefined。 */
export interface RateLimit429Classification {
  quota: boolean;
  retryFloorMs: number | undefined;
  /**
   * 配额子类。三者的**恢复窗口长度完全不同**，因此退避策略也必须分开：
   *
   * - `'rate'` / `'rpm'` —— **请求数**限流（rpm/rps），窗口是**秒级到 1 分钟**（实测 15s 桶）。
   * - `'tpm'` —— **token 数**限流，窗口是**分钟级**（实测 60s 滑动窗口）。
   *
   * 🔴 2026-09-24 新增 `'rpm'` 并把它从 `'tpm'` 里拆出来：此前 `EndpointRPMExceeded`
   * 只靠 message 兜底（`inference exceeds tpm/rpm limit` 同时含 "tpm" 与 "rpm"，
   * 正则必然命中 tpm）⇒ **请求数限流被塞进 token 限流的 3/5/10/15/30/60/120s 档位序列**，
   * 今天实测有 37 条 RPM 记录被迫等待 **120 秒**（秒级窗口等 2 分钟纯属浪费）。
   * 更糟的是它会**推高 TPM 的探测计数** —— 两类事件互相污染，档位只升不降。
   */
  kind: 'rate' | 'rpm' | 'tpm' | undefined;
}

/**
 * 429001 分级探测退避档位（毫秒）——每次宿主重试各自重新探测，等待随连续 429001
 * 次数递增，任一成功即清零、恢复后立即回到最短档 3s。
 *
 * 2026-09-16 实测修订（0916 会话日志）：原档位封顶 15s 过短。
 * pro 段实测「每成功步摊到 2.5~7.5 次 429」，且宿主 llm-retry 的 maxRetries 只有 10，
 * 按原档位（3/5/10/15 封顶）累计重试窗口仅约 33 秒，对分钟级 TPM 窗口严重不足 ——
 * 结果是 **整整 13/16 个回合因重试预算耗尽被丢弃**（turn/end reason=error），
 * 而同一会话切到 flash 后 2/2 回合全部完成。退避太短是"回合被杀"的直接原因。
 * 现延长到 3/5/10/15/30/60/120s（累计约 4 分钟），并配合 providerRetryPolicy 的
 * maxRetries 一起放宽（见 providerRetryPolicy）。
 * 官方文档将 429 统一标注为 quota_exceeded_error 且建议「指数退避重试」，未公开数值；
 * 实测 key A 30k 请求 429001、key B 同刻通过 → per-key 限速差异，短探测 + 换 key 优先。
 */
export const TPM_PROBE_BACKOFF_STEPS_MS: readonly number[] =
  [3_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000];

/**
 * **请求数**限流（rpm/rps）的分级探测退避档位（毫秒）。
 *
 * 🔴 2026-09-24 新增。为什么不复用 {@link TPM_PROBE_BACKOFF_STEPS_MS}：
 * 两者恢复窗口差一个量级 —— 请求数桶按秒/分钟补充（实测 code 8 是 15s 桶），
 * 而 token 桶是 60s 滑动窗口。等 120s 对一个 15s 桶没有任何额外收益，
 * 只会在**每个**宿主重试周期白白多花 105 秒。
 *
 * 上限取 30s（= 2 个 15s 桶），足够跨过请求数限流的恢复窗口；
 * 若连 30s 都恢复不了，说明是更上层的账号级饱和，继续拉长等待也无意义
 * （实测依据：今天在 120s 档连续 90 分钟零成功，拉长等待与成功率无关）。
 */
export const RPM_PROBE_BACKOFF_STEPS_MS: readonly number[] =
  [3_000, 5_000, 10_000, 15_000, 30_000];

/**
 * 🔴 2026-09-27 **移除**：原「全池饱和时最多连续跳过几轮 key 轮换」常量（值 4）。
 *
 * 移除理由（实测确认，同日诊断报告见 `output/dsh-0.1.7-rc.2-plugin-adaptation-report.md`
 * 之前的根因分析）：它的判据 `atTopFloor` 把 **RPM 顶档与 TPM 顶档等价看待**，而
 * `RPM_PROBE_BACKOFF_STEPS_MS` 只有 5 档（3/5/10/15/30s）、是**秒级桶**、恢复远快于宿主
 * 重试间隔 ⇒ **纯 RPM 限流第 5 轮就进入「不换 key」状态**（实测每轮请求数
 * `[3,3,3,3,1,1,1,1,3,1,1,1]`）。再叠加「档位计数只在 2xx 时清零」⇒ 短路⇒零成功⇒
 * 计数永不清零⇒顶档判据永真，构成**正反馈死锁**，只能重启 web 解开。
 *
 * 该职能现由 `key-pool.ts` 的运行态/阻塞态双列表接管：key 进了阻塞态就不再被 agent
 * 请求选中（等价于「跳过轮换」但不会锁死），而恢复权交给**不与 agent 请求耦合**的
 * 探测调度器 —— 这正是旧机制做不到的部分。
 */

/**
 * 命名像"配额耗尽"、实为**速率限流**的 429 error.code（商汤实测）：
 * 三者挂在同一句 message `inference exceeds tpm/rpm limit` 下，账号配额充足时同样返回，
 * 属商汤 code 命名误导。必须与 8 / 429001 同等对待，否则 quotaRotation 在换到这类
 * 账户后会因"不识别"而停止轮换（死锁在单个 key 上）。
 */
const QUOTA_ALIAS_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'ModelAccountTpmRateLimitExceeded',
  'quota_exceeded_error',
]);

/**
 * 是否为**请求数**限流（rpm）的 code。
 *
 * 🔴 为什么用模式匹配而不是白名单：商汤的 code 会随版本漂移（2026-09-23 起
 * v4.1 把 429003/8 换成了 `RateLimitExceeded.Endpoint{RPM,TPM}Exceeded` 这一族命名）。
 * 白名单每漂移一次就漏一次，而这一族的命名**自带语义**（RPM/TPM 写在 code 里），
 * 按语义匹配比枚举形态更耐漂移。已实测覆盖：`RateLimitExceeded.EndpointRPMExceeded`、
 * `ModelAccountRpmRateLimitExceeded`；并确认不会误伤 `...EndpointTPMExceeded` /
 * `ModelAccountTpmRateLimitExceeded`（"Tpm" 不含子串 "rpm"）。
 */
function isRpmCode(code: unknown): boolean {
  return typeof code === 'string' && /rpm/i.test(code);
}

/** 429 响应体的形态摘要（原始 error.code + message），用于错误消息与日志诊断。 */
function rateLimitDetail(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!isRecord(parsed) || !isRecord(parsed.error)) return bodyText.slice(0, 80);
    const code = parsed.error.code;
    const message = parsed.error.message;
    const parts: string[] = [];
    if (code !== undefined) parts.push(`code=${String(code)}`);
    if (typeof message === 'string' && message !== '') parts.push(message.slice(0, 80));
    return parts.join(', ');
  } catch {
    return bodyText.slice(0, 80);
  }
}

/**
 * 解析 429 响应体并分类为「可轮换的限流」及其退避档位。
 *
 * 商汤 429 存在多种 error.code 形态（实测至少四种，且会随版本漂移）：
 *   - `8`                              rps/rpm exhausted（速率桶，补充 ≈1 个/14s）
 *   - `429001`                         inference tpm exhausted（TPM 60s 窗口）
 *   - `insufficient_quota`             ← 命名误导：message 同为 tpm/rpm 限流，实为速率限流
 *   - `ModelAccountTpmRateLimitExceeded` 账号级 TPM 限流
 * 历史实现只认前两种，导致后两种被判为「非配额类」→ 不触发 key 轮换、也不走分级探测。
 * 现按「code 白名单 + message 兜底 + 429 一律可轮换」三级判定：HTTP 429 本身就是限流，
 * 换 key 是唯一主动手段，未知形态一律按 TPM 类处理（kind:'tpm'，3s 起分级探测）。
 */
export function classify429Body(bodyText: string): RateLimit429Classification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  const code = error?.code;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (code === 8 || code === '8') {
    return { quota: true, retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS, kind: 'rate' };
  }
  if (code === 429001 || code === '429001') {
    return { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' };
  }
  // 🔴 必须在 message 兜底**之前**：`inference exceeds tpm/rpm limit` 这句 message
  // 同时含 "tpm" 与 "rpm"，下面的正则必然先命中 tpm ⇒ 请求数限流会被塞进
  // token 限流的 120s 档位（2026-09-24 实测 37 条 RPM 记录被迫等 120 秒）。
  if (isRpmCode(code)) {
    return { quota: true, retryFloorMs: RPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'rpm' };
  }
  if (typeof code === 'string' && QUOTA_ALIAS_CODES.has(code)) {
    return { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' };
  }
  // message 兜底：限流措辞（tpm/rpm/rate limit/quota）一律按 TPM 类处理。
  if (/tpm|rpm|rate.?limit|quota/i.test(message)) {
    return { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' };
  }
  // 保底：任何 HTTP 429 都是限流，一律可轮换（避免商汤新增 code 时轮换静默失效）。
  return { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' };
}

// ── 429 退避：基础值计划 + 单向上抖（W9 重构 2026-09-17，两个纯函数）────────
//
// 抽出的动因：原先这两件事耦合在 `httpError` 内部，且用
// `Math.min(base * (1 + random()*0.3), CEILING)` 一步完成 —— 当 base 接近天花板时
// 上抖会被截断，返回值退化成常量 base，**等于没抖动**，并发会话再次同时醒来。
//
// 背景（2026-09-16 实测 0916 会话日志）：宿主 `llm-retry` 对 `providerRetryAfterMs`
// 是**原样采信**、不叠加自己的 `jitterRatio`（`packages/llm/llm-retry/src/index.ts:234`）
// —— 只要这里返回常量，所有并发会话就会在同一毫秒一起醒来（惊群），0916 实测
// 8 个 subagent 同时重试使 code=8（rpm exhausted）反复触发。
// 因此对自己算出的探测档加**单向上抖**（base ~ 1.3×base）：单向而非双向，是为了
// 保证不低于 base —— 退避下限（15s 桶补充周期、TPM 探测档）本身是"最早可以重试的
// 时刻"，抖动只能往后推迟，不能提前。

/** 上抖幅度比例（base 的 0~30%）。 */
const RETRY429_JITTER_RATIO = 0.3;

/**
 * 429 退避的「基础值」计划（纯函数）。
 *
 * 只回答"该等多久"，不回答"要不要随机化"——后者交给 {@link applyUpwardJitter}。
 */
export interface Retry429Plan {
  /** 未抖动的基础等待（毫秒）。 */
  baseMs: number;
  /** 网关给出了明确且不小于我方下限的 Retry-After ⇒ 尊重服务端指令，不加抖动。 */
  respectHeader: boolean;
}

/**
 * 由 429 分类结果、动态下限与 Retry-After 头算出基础等待。
 *
 * @param classified - {@link classify429Body} 的静态分类（提供静态 floor）
 * @param dynamicFloorMs - stream 层算好的配额类动态下限（429001 分级探测档），优先于静态 floor
 * @param headerMs - 网关 Retry-After（毫秒）
 * @returns 计划；无任何可用依据时 undefined（交由宿主自己的指数退避）
 */
export function plan429RetryAfterMs(
  classified: RateLimit429Classification,
  dynamicFloorMs: number | undefined,
  headerMs: number | undefined,
): Retry429Plan | undefined {
  const floorMs = dynamicFloorMs ?? classified.retryFloorMs;
  // 非正数的 Retry-After 视为无效头：实测有网关返回 0 表示"立即重试"，
  // 照单采信它等于不等待（立刻再撞一次 429）。
  const header = headerMs !== undefined && headerMs > 0 ? headerMs : undefined;
  if (floorMs !== undefined) {
    // 网关值 >= 我方下限 → 采信网关；小于下限 → 用下限（下限是"最早可重试时刻"，不能被压低）。
    const respectHeader = header !== undefined && header >= floorMs;
    return { baseMs: Math.max(floorMs, header ?? 0), respectHeader };
  }
  // 无分类下限：仅当裸头不超过 CAP 才采信（过大疑似异常值，宁可交给上层指数退避）。
  if (header !== undefined && header <= PROVIDER_RETRY_AFTER_CAP_MS) {
    return { baseMs: header, respectHeader: true };
  }
  return undefined;
}

/**
 * 给基础等待加**单向上抖**，并保证结果不越过天花板（纯函数，`random` 注入以便测试）。
 *
 * 🔴 不变量（两条都必须成立，见同名单测）：
 *   1. `applyUpwardJitter(b, c, r) >= min(b, c)` —— 只向后推迟，绝不提前；
 *   2. `applyUpwardJitter(b, c, r) <= c`         —— 绝不越过天花板。
 *
 * 第 2 条尤其不可放松：`ceilingMs` 是防悬崖不变量的上界，越过它会让宿主因
 * `providerRetryAfterMs > policy.maxDelayMs` **直接放弃重试**（回合立即失败，
 * 见 W1 的 `QUOTA_RETRY_AFTER_CEILING_MS` 注释）。所以当上抖空间不足时，
 * 退让方向必须是"往小抖"，**而不是抬高天花板**。
 */
export function applyUpwardJitter(baseMs: number, ceilingMs: number, random: () => number): number {
  const headroom = ceilingMs - baseMs;
  if (headroom <= 0) return ceilingMs; // 已封顶：无处可抖，且绝不能越过天花板
  const jitterSpan = Math.round(baseMs * RETRY429_JITTER_RATIO);
  const width = jitterSpan <= headroom ? jitterSpan : headroom;
  return baseMs + Math.round(random() * width);
}

/** 把预流 HTTP 失败映射为稳定 LlmError。
 * dynamicFloorMs：stream 层算好的配额类动态退避下限（429001 分级探测），
 * 覆盖 classify429Body 返回的静态 floor；undefined 时用静态 floor。 */
function httpError(status: number, errText: string, retryAfterMs: number | undefined, dynamicFloorMs?: number): LlmError {
  if (status === 401) {
    return new LlmError(
      'llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效',
      'INVALID_CREDENTIAL',
      { status: 401 },
    );
  }
  if (status === 404 && isModelNotFoundText(errText)) {
    return new LlmError(
      'llm-sensenova: SenseNova model is not routable — the model id is no longer served；SenseNova 模型不可路由：该模型 id 已下线',
      MODEL_NOT_FOUND_CODE,
      { status: 404 },
    );
  }
  if (status === 429) {
    // SenseNova 429 分类（见 classify429Body）：code 8（速率桶）/ 429001（TPM）/
    // insufficient_quota 等别名 code / message 兜底 / 未知形态一律按可轮换限流。
    // 退避下限 providerRetryAfterMs：429001 用 stream 层分级探测档（3/5/10/15/30/60/120s，
    // 成功清零），code 8 用静态 floor（15s≈一个桶补充周期）；Retry-After 更大时优先，
    // 整体封顶 300s。
    //
    // 单向上抖的完整理由（惊群、为什么只向后推迟、为什么不越天花板）见上方
    // plan429RetryAfterMs / applyUpwardJitter 的模块注释。
    const classified = classify429Body(errText);
    const plan = plan429RetryAfterMs(classified, dynamicFloorMs, retryAfterMs);
    let providerRetryAfterMs: number | undefined;
    if (plan !== undefined) {
      providerRetryAfterMs = plan.respectHeader
        // 尊重网关指令时也要夹天花板：网关可能给出远大于天花板的等待，
        // 直接照搬会让宿主因 `pra > policy.maxDelayMs` 放弃整个重试
        // ⇒ 宁可截断，也要留在安全区内（防悬崖优先于"完全听网关"）。
        ? Math.min(plan.baseMs, QUOTA_RETRY_AFTER_CEILING_MS)
        : applyUpwardJitter(plan.baseMs, QUOTA_RETRY_AFTER_CEILING_MS, Math.random);
    }
    // 保留原始 error.code / message 作为诊断摘要：此前统一文案会丢弃形态信息，
    // 使日志/UI 无法区分 429001 与 insufficient_quota（后者命名像"配额耗尽"，
    // 实为速率限流，曾导致误判"配额超出"）。
    const detail = rateLimitDetail(errText);
    return new LlmError(`llm-sensenova: SenseNova API error 429 — rate limited (${detail})；SenseNova API 返回 429：请求被限流（${detail}）`, 'RATE_LIMIT', {
      status: 429,
      ...(providerRetryAfterMs !== undefined ? { providerRetryAfterMs } : {}),
    });
  }
  return new LlmError(`llm-sensenova: SenseNova API error ${status}: ${errText.slice(0, 500)}`, 'PROVIDER_HTTP_ERROR', { status });
}

/** SenseNova（OpenAI 兼容）适配器。 */
export class SensenovaAdapter extends LlmAdapter {
  private readonly deps: SensenovaAdapterDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly gate: KeyedConcurrencyGate;
  private catalog: CatalogEntry[] = [];
  /** 进程内失败缓存：运行时返回 MODEL_NOT_FOUND 的模型 id，直到适配器生命周期结束。 */
  private readonly failedModels = new Set<string>();
  /**
   * 配额类 429 粘住 key（design D5，仅 quotaRotation 开启时读写）：
   * 有 sessionId 的请求按会话分桶（同一会话后续请求粘住切换后的 key）；
   * 无 sessionId 的请求共享进程级桶（undefined 键）——宿主 GenerateOptions
   * 仅提供 sessionId 这一会话标识，粘性粒度即「会话（无标识时为进程）」，
   * 与 spec「同一会话后续请求继续使用新 key」对齐。条目仅存内存，随适配器
   * 生命周期结束。
   */
  private readonly quotaStickyKeys = new Map<string | undefined, string>();
  /**
   * 429001 连续命中计数（per-session，分级探测用）：决定本次请求的探测档位
   * TPM_PROBE_BACKOFF_STEPS_MS[count]。
   *
   * 推进单位 = **一次 stream() 调用**（= 一次宿主重试周期），见 stream() 内的
   * 「W3」注释：档位快照在入口取一次，轮换出的新 key 复用同一档，整轮结束才 +1；
   * 仅请求真正成功（拿到 2xx）时清零。仅内存，随适配器生命周期。
   */
  private readonly tpmHitCounts = new Map<string | undefined, number>();
  /**
   * 请求数限流（rpm）的连续命中计数，**与 {@link tpmHitCounts} 完全隔离**。
   *
   * 🔴 2026-09-24 新增。不隔离的后果有两个，都是实测抓到的：
   *   1. RPM 事件推高 TPM 档位 —— 两类限流的恢复窗口差一个量级（秒级 vs 分钟级），
   *      混在一个计数里会让 token 限流凭空少探测好几轮；
   *   2. RPM 自己吃到 TPM 的 120s 档 —— 今天 37 条 RPM 记录被迫等 120 秒。
   * 推进/清零规则与 tpmHitCounts 完全一致（每轮 +1、2xx 清零）。
   */
  private readonly rpmHitCounts = new Map<string | undefined, number>();
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

  constructor(deps: SensenovaAdapterDeps) {
    super();
    this.deps = deps;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.gate = deps.concurrencyGate ?? new KeyedConcurrencyGate();
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'SenseNova' };
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    // 2026-09-17（W1）：策略改为配置化。
    //
    // 值来自 `llm-sensenova.retryPolicy`（`index.ts` 的 `resolveAdapterOptions`
    // 经 `resolveRetryPolicy()` 解析后放进 connection）。宿主**在 registerAdapter
    // 时捕获**本返回值，此后每请求不再读 ⇒ 改配置必须触发
    // `registration.replace()`（见 `index.ts` 的 `ensureRegistrationFacts`）。
    //
    // 缺省回落到 `FALLBACK_RETRY_POLICY`，其取值与改造前的硬编码完全等价
    // （normal / maxRetries=24 / maxDelayMs=300000），因此未配置的用户行为不变。
    //
    // 📌 调参入口：设置 → SenseNova → 高级选项 → 重试策略。改完保存即生效
    // （onChange → replace），**不需要重建 lib 或重启 web**——这正是 W1 的目的。
    return this.deps.options().retryPolicy ?? FALLBACK_RETRY_POLICY;
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const connection = this.deps.options();
    let apiKey: string;
    try {
      apiKey = await this.deps.resolveApiKey(connection);
    } catch {
      return [];
    }
    const response = await this.fetchImpl(`${connection.apiBase}/models`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...attributionHeaders(),
      },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (response.status === 401) {
      throw new LlmError('llm-sensenova: SenseNova API rejected the API key (401)', 'INVALID_CREDENTIAL', { status: 401 });
    }
    if (!response.ok) {
      throw new LlmError(`llm-sensenova: models endpoint returned HTTP ${response.status}`, 'PROVIDER_HTTP_ERROR', { status: response.status });
    }
    const parsed: unknown = await response.json();
    // 以新快照原子替换缓存（保留失败标记），避免 listModels 新目录与 resolveModel 旧能力不一致。
    const models = parseCatalog(parsed, this.failedModels, connection.modelSelection ?? EMPTY_MODEL_SELECTION);
    this.catalog = models;
    return models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.inputModalities,
    }));
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = this.catalog.find((m) => m.id === model);
    // 🔴 静态表优先、目录只作兜底（2026-09-23 改）—— 与视觉白名单同一策略。
    //
    // 三条实测理由：
    //   ① 目录 `max_output_length` 8/9 是 65536 占位值，会把 v4.1 的 131072 与
    //      kimi 的 128K 都压成一半 ⇒ 走 `MODEL_MAX_OUTPUT_OVERRIDES` 硬覆盖。
    //   ② `resolveModel` **不主动拉目录**（只有 `listModels` 会），首次打开模型选择器
    //      时 entry 恒为 undefined ⇒ 档位/预算/上下文会**整个掉空**；若此刻有调用方
    //      指定了 effort，宿主会在**发出前**抛 `UNSUPPORTED_REASONING_EFFORT`
    //      （报错指向"模型不支持"，与真实原因无关，极难归因）⇒ 走静态表。
    //   ③ 目录 `input_modalities` 对 v4.1 / kimi-k3 长期只报 `["text"]`，热目录也不修正
    //      ⇒ 由 `DOCUMENTED_VISION_MODELS` 在 `inputModalitiesFrom` 内补 image。
    //
    // 上下文窗口的顺序**相反**（目录优先）：实测目录的 `context_length` 是正确的
    // （lite 262144 / 其余 1M），静态表只用于冷目录兜底。
    // ⚠️ reasoning 的兜底条件必须是「**entry 整个缺失**」，而不是「entry.reasoning 为
    // undefined」：后者可能是目录**明确排除**了 reasoning（`supported_features` 里没有它），
    // 此时回落静态表等于无视目录的明确表态。单测「目录明确排除 reasoning 才隐藏档位」
    // 抓的正是这个错误。
    const reasoning = entry !== undefined ? entry.reasoning : reasoningInfoFrom({}, model);
    const contextWindow = entry?.contextWindow ?? MODEL_CONTEXT_OVERRIDES.get(model) ?? DEFAULT_CONTEXT_WINDOW;
    const maxOutput = MODEL_MAX_OUTPUT_OVERRIDES.get(model) ?? entry?.maxOutputTokens;
    return {
      provider,
      id: model,
      name: displayNameFor(model),
      inputModalities: entry?.inputModalities ?? inputModalitiesFrom({}, model),
      context: { contextWindow },
      ...(maxOutput !== undefined ? { defaultMaxTokens: maxOutput } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.deps.options();
    // 视觉模型：先把历史里的图片解析成 Base64 Data-URL（kimi-k3 只接受这种形式）。
    const imageData = await prepareImageDataUrls(options.messages, this.deps.resolveImage, options.signal);
    // L2 连接级默认值：按**本次请求的模型**过滤白名单后并入请求体。
    // 每请求重算（读 `deps.options()`）⇒ 改了配置即刻生效，无需 replace。
    const l2Params = l2ParamsFor(options.model, connection.requestParams ?? {});
    const body = JSON.stringify(buildOpenAiBody(options, imageData, l2Params));
    const tried = new Set<string>();
    const limit = connection.concurrency;
    // 三段超时（design D4/D6，2026-09-04 实测）：生产用常量，测试可注入小值。
    const connectMs = this.deps.timeouts?.connectMs ?? CONNECT_TIMEOUT_MS;
    const streamIdleMs = this.deps.timeouts?.streamIdleMs ?? STREAM_IDLE_TIMEOUT_MS;
    // 测试注入优先；生产走连接事实（settings 的 queueTimeoutMs，缺省 60s）。
    const queueMs = this.deps.timeouts?.queueMs ?? connection.queueMs;
    const quotaRotation = connection.quotaRotation === true;
    // 粘性起点（design D5）：开关开启时把「该会话粘住的 key」作为**偏好**交给池校验，
    // 而不是直接拿来用 —— 池只在它仍处于运行态时才采纳；若它已被踢入阻塞态或被 401
    // 移除，池会自动落到运行态的正确一把。
    //
    // 🔴 2026-09-27 修正：旧写法 `stickyKey ?? await resolveApiKey(connection)` 会把已失效
    // 的粘性 key 直接用于请求，是「粘性退化成死锁」的残留路径。
    // 开关关闭时不读写指针，行为与现状完全一致。
    const stickyKey = quotaRotation ? this.quotaStickyKeys.get(options.sessionId) : undefined;
    let apiKey = await this.deps.resolveApiKey(
      connection,
      stickyKey !== undefined ? { preferredKey: stickyKey } : undefined,
    );
    let response: Response | undefined;
    // 当前 attempt 持有的并发额度；成功进入流式阶段后保持到 finally 释放。
    let release: Release | undefined;
    // 各 attempt 的连接超时清理（清计时器 + 摘除宿主 abort 转发 listener），finally 统一执行。
    const connectCleanups: Array<() => void> = [];

    // W3（2026-09-17）：429001 探测档位的推进单位 = **一次 stream() 调用**（= 一次宿主
    // 重试周期），而不是内部 attempt。原先的读/递增写在 attempt 循环里，配额轮换的
    // `continue` 会让同一次调用内反复递增 —— 3 账号时一次宿主重试最多吃掉 3 档，
    // 7 档只够约 2.3 次重试，之后长期停在 120s 平台期（maxRetries 的预算被浪费在
    // 没有区分度的区间里）。现在在入口取一份档位快照：循环内所有 internal attempt
    // （含轮换出的新 key）共用同一档，整轮失败才在 finally 里 +1。
    const probeKey = options.sessionId;
    const entryHits = this.tpmHitCounts.get(probeKey) ?? 0;
    const entryProbeFloorMs =
      TPM_PROBE_BACKOFF_STEPS_MS[Math.min(entryHits, TPM_PROBE_BACKOFF_STEPS_MS.length - 1)];
    // RPM 档位快照：与 TPM **各自独立**（见 rpmHitCounts 注释，2026-09-24）。
    const entryRpmHits = this.rpmHitCounts.get(probeKey) ?? 0;
    const entryRpmFloorMs =
      RPM_PROBE_BACKOFF_STEPS_MS[Math.min(entryRpmHits, RPM_PROBE_BACKOFF_STEPS_MS.length - 1)];
    let probeHitThisCall = false;
    let rpmHitThisCall = false;
    // 拿到 2xx 时循环内已清零计数；用该标志阻止 finally 再把它加回去。
    let probeResetBySuccess = false;
    // 🔴 2026-09-27：原「全池饱和」判定（`atTopFloor` / `saturateSkips` / `saturated`）
    // 已随 `quotaSaturated` 字段一起移除。它曾在此处决定 `rotationAllowed`，从而在
    // 判定池子打满时**主动跳过整个 key 轮换**。移除后轮换不再被任何全局标志抑制：
    // 「哪些 key 不该再试」改由 `key-pool.ts` 的运行态列表表达（进了阻塞态就不再被
    // agent 请求选中），而该状态可被探测主动解除 —— 不再有「一短路就出不来」的死锁。
    // W4：本轮内第几个 internal attempt（1 起，用于限流事件记录）。
    let attemptIndex = 0;

    try {
      for (let rotations = 0; ; ) {
        attemptIndex += 1;
        tried.add(apiKey);
        // 按本次 attempt 实际使用的 key 获取并发额度；排队期间中止会在此 reject
        // （不占额度），排队超时以 TimeoutError reject（同样不占额度），统一映射
        // 可重试 TIMEOUT 交宿主重试层（design D4）。await 抛出时 release 保持
        // undefined，finally 不误放他人额度。
        try {
          release = await this.gate.acquire(apiKey, limit, options.signal, queueMs);
        } catch (error) {
          if (!isTimeoutReason(error)) throw error;
          throw new LlmError(
            `llm-sensenova: request queued behind the per-key concurrency limit for over ${queueMs ?? DEFAULT_QUEUE_TIMEOUT_MS}ms；SenseNova 请求排队超时（未占用并发额度），交宿主重试层退避后重试`,
            'TIMEOUT',
            { cause: error },
          );
        }
        let attempt: Response;
        try {
          // 连接/首字节超时（design D4，2026-09-04 实测传输挂起 ≈1/5 且无 RST）：
          // 自管 AbortController + setTimeout，响应头到达即清除计时器——超时只约束
          // 建连/首包阶段（不可用 AbortSignal.timeout：undici 下它会在整个 body
          // 读取阶段持续生效，超过 connectMs 的健康长流会被误杀）。控制器全程转发
          // 宿主 abort，body 阶段的中止语义与直传宿主 signal 等价。
          const connectController = new AbortController();
          const connectTimer = setTimeout(() => {
            connectController.abort(new DOMException('connect timed out', 'TimeoutError'));
          }, connectMs);
          const onHostAbort = () => connectController.abort(options.signal?.reason);
          if (options.signal !== undefined) {
            if (options.signal.aborted) connectController.abort(options.signal.reason);
            else options.signal.addEventListener('abort', onHostAbort, { once: true });
          }
          connectCleanups.push(() => {
            clearTimeout(connectTimer);
            options.signal?.removeEventListener('abort', onHostAbort);
          });
          attempt = await this.fetchImpl(`${connection.apiBase}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
              ...attributionHeaders(),
            },
            body,
            signal: connectController.signal,
          });
          // 响应头已到达：连接超时使命完成（finally 里的 clearTimeout 为幂等兜底）。
          clearTimeout(connectTimer);
        } catch (error) {
          release();
          release = undefined;
          if (options.signal?.aborted) throw error;
          if (isTimeoutReason(error)) {
            throw new LlmError(
              `llm-sensenova: request to ${connection.apiBase} timed out after ${connectMs}ms；SenseNova 请求建连或首包超时（已释放并发额度），交宿主重试层处理`,
              'TIMEOUT',
              { cause: error },
            );
          }
          throw new LlmError(`llm-sensenova: request to ${connection.apiBase} failed: ${errorChain(error)}；连接 SenseNova API 失败，通常是网络或代理问题`, 'TRANSPORT', { cause: error });
        }
        if (attempt.ok) {
          response = attempt;
          // 请求成功：分级探测计数归零（下次再限流从最短档 3s 重新探测）。
          // TPM / RPM 两套计数在成功时清零 —— 成功是唯一的「本会话档位已恢复」证据。
          this.tpmHitCounts.delete(options.sessionId);
          this.rpmHitCounts.delete(options.sessionId);
          // 池侧同样以成功为「已恢复」的最强证据：清零该 key 的连续命中计数；
          // 若它正处于阻塞态（被本轮借用后打成功）⇒ 立即挂回运行态末尾。
          this.deps.reportSuccess?.(apiKey);
          probeResetBySuccess = true;
          break; // 额度随 response 保留，由外层 finally 在流结束后释放
        }
        const errText = await attempt.text().catch(() => '');
        const retryAfterMs = parseRetryAfterMs(attempt.headers.get('retry-after'));
        // 404 模型不可路由：标记失败且不轮换/不重试。
        const modelNotFound = attempt.status === 404 && isModelNotFoundText(errText);
        if (modelNotFound) {
          release();
          release = undefined;
          this.failedModels.add(options.model);
          throw httpError(attempt.status, errText, retryAfterMs);
        }
        // 429：SenseNova 渠道常态性限流，不代表账号异常。不冷却账号；默认不轮换 key
        // （一个会话固定使用一个 key，保护服务端按 key 命中的 prompt 缓存），直接抛
        // RATE_LIMIT 交宿主重试层自动退避后原 key 重试。quotaRotation 开启时，限流类
        // 429（见 classify429Body：8 / 429001 / insufficient_quota 等别名 / 未知形态）
        // 粘性切换到下一把未试过的 key 重试本次请求；环回无新 key 时**解除本会话粘性**
        // 并抛 RATE_LIMIT，避免永久锁死在已耗尽的 key 上（粘性本为保缓存，不应成死锁）。
        // 401 轮换路径不变。并发闸已在源头抑制并发超限，此处为兜底。
        const classified = classify429Body(errText);
        const quota429 = attempt.status === 429 && classified.quota;
        // 429001 分级探测档位：连续命中计数决定本次退避（3/5/10/15s，封顶后保持），
        // 命中即 +1——每次宿主重试都带一个递增的探测等待，成功后清零回到最短档。
        let dynamicFloorMs: number | undefined;
        // 池侧上报（2026-09-27）：只有 **tpm 类**才累计「连续命中」并在达阈值时踢出运行态。
        // rpm / rate 是秒级桶（15s 量级自愈，实测 `code 8` 走 15s 档），踢掉它们只会白白
        // 损失该 key 上的 prompt cache 命中率 ⇒ 只上报不计数，不参与踢出判定。
        //
        // 上报返回值同时带回「本事件发生时池的两态把数」，用于限流事件的诊断字段。
        let kickedThisAttempt = false;
        let poolStateThisAttempt: { running: number; blocked: number } | undefined;
        if (classified.kind === 'tpm') {
          // W3：档位取入口快照（本轮内所有 internal attempt 共用同一档，不再就地递增）。
          dynamicFloorMs = entryProbeFloorMs;
          probeHitThisCall = true;
          if (quotaRotation) {
            const reported = this.deps.reportRateLimit?.(apiKey, 'tpm');
            kickedThisAttempt = reported?.kicked === true;
            poolStateThisAttempt = reported;
          }
        } else if (classified.kind === 'rpm') {
          // 请求数限流走**独立**档位（上限 30s）：秒级窗口等 120s 没有收益（2026-09-24）。
          dynamicFloorMs = entryRpmFloorMs;
          rpmHitThisCall = true;
          if (quotaRotation) poolStateThisAttempt = this.deps.reportRateLimit?.(apiKey, 'rpm');
        } else if (classified.kind === 'rate' && quotaRotation) {
          poolStateThisAttempt = this.deps.reportRateLimit?.(apiKey, 'rate');
        }
        // W4：把这次限流落成一条结构化事件（异步、不阻塞、绝不抛）。
        // 两个出口各自补齐差异字段：轮换（不抛出，需在换 key 前记录被拒的 key）
        // 与抛出（此时才知道最终 providerRetryAfterMs）。
        const eventFloorMs = dynamicFloorMs ?? classified.retryFloorMs;
        const emitRateLimitEvent = (outcome: {
          rotated: boolean;
          providerRetryAfterMs?: number;
          /** 本 key 是否因本次命中被踢出运行态（2026-09-27 取代已移除的 `saturated`）。 */
          kicked?: boolean;
        }): void => {
          const described = this.deps.describeKey?.(apiKey);
          this.deps.errorLog?.()?.record({
            ts: new Date().toISOString(),
            model: options.model,
            status: attempt.status,
            code: extractErrorCode(errText),
            kind: classified.kind ?? '',
            quota: classified.quota,
            message: summarize(rateLimitDetail(errText)),
            ...(eventFloorMs !== undefined ? { retryFloorMs: eventFloorMs } : {}),
            ...(retryAfterMs !== undefined && retryAfterMs > 0 ? { retryAfterHeaderMs: retryAfterMs } : {}),
            ...(outcome.providerRetryAfterMs !== undefined ? { providerRetryAfterMs: outcome.providerRetryAfterMs } : {}),
            // 🔴 2026-09-24 新增：当前探测档位索引（0 起）。同日实测该值长期停在 6（=120s）
            // 而期间零成功 ⇒ 光看 retryFloorMs 无法区分"档位锁死"与"正常高档"。
            ...(classified.kind === 'tpm' || classified.kind === 'rpm'
              ? { probeHits: classified.kind === 'tpm' ? entryHits : entryRpmHits }
              : {}),
            // 🔴 2026-09-27 新增池侧诊断（**取代**已移除的 saturated）：
            //   kicked       本 key 是否因本次命中被踢出运行态（仅 tpm 类且达阈值时 true）
            //   poolRunning  事件产生时运行态把数
            //   poolBlocked  事件产生时阻塞态把数
            ...(outcome.kicked !== undefined ? { kicked: outcome.kicked } : {}),
            ...(poolStateThisAttempt !== undefined
              ? { poolRunning: poolStateThisAttempt.running, poolBlocked: poolStateThisAttempt.blocked }
              : {}),
            rotated: outcome.rotated,
            attempt: attemptIndex,
            account: fingerprint(apiKey),
            // 🔴 2026-09-27 新增两个**可读**字段（设置页「错误记录」新增两列）：
            //   accountLabel  账户可读名（如「账户 2」）
            //   accountRef    该 key 的 credential-ref 名（如 SENSENOVA_API_KEY_2）。
            //                 它是**环境变量名不是密钥值** ⇒ 脱敏断言仍然成立。
            // `account` 指纹保留不动：它用于去重与跨会话关联，两者互补。
            ...(described !== undefined ? { accountLabel: described.label, accountRef: described.ref } : {}),
            session: fingerprint(options.sessionId),
          });
        };
        // 配额类 429 且开关开启：轮换到下一把本请求未试过的 key（tried 集合做单次
        // 请求内防乒乓——每次宿主重试都会清空 tried、重新探测各 key，因此配额恢复
        // 或另一把 key 空闲时下一次重试即可切过去；不再用跨请求环回 Set，那会把
        // 会话永久锁死在已耗尽的 key 上干等退避）。
        const quotaRotate = quota429 && quotaRotation;
        const rotatable = attempt.status === 401 || quotaRotate;
        // 🔴 2026-09-27：原 `rotationAllowed = (status === 401 || !saturated)` 守卫已随饱和
        // 机制一起移除。轮换不再被任何全局标志抑制 ——「该不该继续换」由 key 池的运行态
        // 列表表达，而池的 `pickNext` 在候选耗尽时自会返回 undefined，无需这里再加闸。
        if (rotatable && options.signal?.aborted !== true && rotations < connection.accountCount) {
          // 'quota-exhausted' 不写任何账号状态；401 仍走禁用轮换。
          // `tried` 作为 exclude 交给池：池在运行态环回时会跳过本轮已试过的 key，并在
          // 运行态候选耗尽时借用阻塞态中「阻塞最久」的一把（**不改变其相位**）。
          const next = await this.deps.rotateApiKey(
            apiKey,
            attempt.status === 401 ? 'invalid-credential' : 'quota-exhausted',
            tried,
          );
          if (next !== undefined && !tried.has(next)) {
            // W4：必须在 `apiKey = next` **之前**记录 —— 事件里的 account 指纹要指向
            // 被拒的那把 key，而不是即将接管的新 key。
            if (attempt.status === 429) emitRateLimitEvent({ rotated: true, kicked: kickedThisAttempt });
            const rejectedKey = apiKey;
            // 预流轮换：先释放旧 key 额度，下一轮为新 key 重新获取。
            release();
            release = undefined;
            apiKey = next;
            rotations += 1;
            if (quotaRotate) {
              this.quotaStickyKeys.set(options.sessionId, next); // 粘住新 key
              // 2026-09-16 实测修订：此处原为 `this.tpmHitCounts.delete(sessionId)`
              // （理由"新 key 配额新鲜，探测档位归零"）。但实测 2 把 key 会被**同时打满**，
              // 每次 429 都必然轮换 → 计数被反复清零 → 档位永远停在最短的 3s，
              // TPM_PROBE_BACKOFF_STEPS_MS 的后几档全是死代码（0916 日志：268 次
              // 429001 的 delayMs 无一例外都是 3000）。计数改为一律保留，
              // 只在请求真正成功时清零（见下方 `if (attempt.ok)`），使退避能真正升级。
              //
              // 🔴 2026-09-27 新增：被拒的 key 若刚被踢入阻塞态，要**清扫所有会话**指向它
              // 的粘性指针。否则那些会话下次仍以它为偏好起点 —— 虽然池会在 pickStart 处
              // 校验并落到运行态的正确一把，但留着失效指针会让「粘性保 cache」的意图失真。
              if (kickedThisAttempt) {
                for (const [session, sticky] of this.quotaStickyKeys) {
                  if (sticky === rejectedKey) this.quotaStickyKeys.delete(session);
                }
              }
            }
            continue;
          }
        }
        // 轮换候选已耗尽（或开关关闭）：限流类 429 解除本会话粘性，让下一次宿主重试从池里
        // 重新选择（可能回到先前暂时限流、此刻已恢复的 key），而不是固定卡在同一把 key 上。
        // 池的相位状态不受此影响 —— 它是池级共享的，与本会话粘性无关。
        if (quotaRotate) {
          this.quotaStickyKeys.delete(options.sessionId);
          // ⚠️ 不得在此清零 tpmHitCounts / rpmHitCounts：那两个是「退避档位」的推进计数，
          // 若在耗尽时清零，最需要长退避的「全部 key 都已打满」场景反而会退回 3s 高频探测。
          //
          // 🔴 2026-09-27：原 `this.quotaSaturated.set(probeKey, ...)` 已随饱和机制移除 ——
          // 「哪些 key 暂不可用」现在由 key-pool 的运行态列表表达，且可被探测主动解除。
        }
        release();
        release = undefined;
        const failure = httpError(attempt.status, errText, retryAfterMs, dynamicFloorMs);
        // W4：记录的 providerRetryAfterMs 与真正抛给宿主的是同一个值（含单向上抖）。
        if (attempt.status === 429) {
          emitRateLimitEvent({
            rotated: false,
            kicked: kickedThisAttempt,
            ...(failure.failure.providerRetryAfterMs !== undefined
              ? { providerRetryAfterMs: failure.failure.providerRetryAfterMs }
              : {}),
          });
        }
        throw failure;
      }

      if (response === undefined) {
        // 不可达：循环要么 break（成功）要么 throw；仅用于满足明确赋值分析。
        throw new LlmError('llm-sensenova: SenseNova API returned no response', 'PROVIDER_PROTOCOL_ERROR');
      }
      if (response.body === null) {
        throw new LlmError('llm-sensenova: SenseNova API returned no response body', 'PROVIDER_PROTOCOL_ERROR');
      }
      yield* parseOpenAiSse(response.body, options.signal, streamIdleMs);
    } finally {
      for (const cleanup of connectCleanups) cleanup();
      release?.();
      // W3：整轮（含轮换出的所有 internal attempt）只消耗一档。成功已在循环内清零，
      // 故仅在「本轮撞过 tpm 且最终未成功」时推进；本轮没撞 tpm（如纯传输错误、
      // code 8 速率桶）则档位不动。
      if (probeHitThisCall && !probeResetBySuccess) {
        this.tpmHitCounts.set(probeKey, entryHits + 1);
      }
      // RPM 计数独立推进（2026-09-24）：不共用 TPM 计数，理由见 rpmHitCounts 注释。
      if (rpmHitThisCall && !probeResetBySuccess) {
        this.rpmHitCounts.set(probeKey, entryRpmHits + 1);
      }
    }
  }
}
