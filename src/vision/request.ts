/**
 * 池感知的视觉请求：把视觉识别接进 freeapi 的同一套限流机制。
 *
 * **为什么必须重写而不是复用 vision-aid 的 runChain**：那版在 `orchestrator.ts:104`
 * 用 `resolveApiKey(ctx, keyRef)` 取**唯一一把** key 后直接 fetch，既不进 key 池、
 * 不占并发闸，也不上报 429 —— 视觉与主请求各跑各的轮换，却抢同一批账户配额，
 * 于是互相加剧限流。本模块把每次视觉请求当作一次「一等公民请求」：
 *
 *   1. key 由 freeapi 的 `resolveApiKey` 给出（组模式下走组轮换）；
 *   2. 并发额度取自**同一个** `KeyedConcurrencyGate`（组键或 key 键）；
 *   3. 429 走 `classify429Body` 分类，上报 key 池 / 组池 / AIMD，并按配额策略换 key；
 *   4. 成功同样回写池（清 strikes、清组退避、衰减 gap）；
 *   5. 每次尝试落一行 `runtime.jsonl`（`phase: 'vision'`），与主请求同源可查。
 *
 * 与主 adapter 的差异只有一处：这里**非流式**（`stream:false`），一次拿完整 JSON。
 * 视觉描述本来就不是逐字流式消费的，非流式换来了更简单的错误归类。
 *
 * @module dsh-sensenova-freeapi/vision/request
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import {
  QUOTA_RETRY_AFTER_CEILING_MS,
  applyUpwardJitter,
  classify429Body,
  plan429RetryAfterMs,
} from '../adapter.ts';
import { parseRetryAfterMs } from '../accounts.ts';
import type { KeyedConcurrencyGate, Release } from '../concurrency.ts';
import { fingerprint, type SenseNovaRateLimitEvent } from '../error-log.ts';

/** 每个模型最多换几次 key（不含首次尝试）。视觉是前台交互，不宜无限轮换。 */
export const VISION_MAX_KEY_ROTATIONS = 2;

/** 视觉请求可用的宿主侧能力（由 index.ts 的 apply 注入）。 */
export interface VisionRuntime {
  /** 当前 apiBase。 */
  apiBase: () => string;
  /** 每 key（或每组）并发上限。 */
  concurrency: () => number;
  /** 并发闸排队上限（毫秒）。 */
  queueTimeoutMs: () => number;
  /** 配额类 429 是否换 key。 */
  quotaRotation: () => boolean;
  /** 已配置账户数（决定轮换上限的参考值）。 */
  accountCount: () => number;
  /** 取一把可用 key（组模式下走组轮换）。 */
  resolveApiKey: () => Promise<string>;
  /** 换下一把 key；无可用者返回 undefined。 */
  rotateApiKey: (
    rejectedKey: string,
    rejection: 'invalid-credential' | 'quota-exhausted',
    exclude?: ReadonlySet<string>,
  ) => Promise<string | undefined>;
  /** 与主请求共享的并发闸。 */
  gate: () => KeyedConcurrencyGate;
  /**
   * 这次 attempt 该用哪个闸键、多少额度。
   * 组调度启用时返回 `group:<i>` + 组容量，否则返回 key 本身 + 并发上限。
   */
  gateKeyOf: (key: string) => { key: string; limit: number; groupIndex?: number };
  /** 429 上报（内部同时处理 key 池踢出、组池退避、AIMD 放大）。 */
  reportRateLimit: (key: string, kind: 'tpm' | 'rpm' | 'rate' | 'quota_exhausted') => {
    kicked: boolean;
    running: number;
    blocked: number;
  };
  /** 成功回写（清 key strikes、清组退避、AIMD 衰减）。 */
  reportSuccess: (key: string) => void;
  /** 当前组间隙（毫秒）；无组调度时 undefined。 */
  groupGapMs?: () => number | undefined;
  /** 跨组时的组间隙等待（毫秒）；无组调度时 undefined。 */
  groupOf?: (key: string) => number | undefined;
  /** key → 可读描述（账户名 + credential-ref 名）。 */
  describeKey?: (key: string) => { label: string; ref: string } | undefined;
  /**
   * 实时 key 事件（2026-11-03）：视觉请求与主对话共用同一批 key，因此也要在设置页
   * 的 key 网格上按真实节奏闪灯。可选；未注入时静默。
   */
  onKeyEvent?: (key: string, kind: 'start' | 'rate-limit') => void;
  /** 运行日志写入。 */
  record?: (event: SenseNovaRateLimitEvent) => void;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
  /** 可注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
}

/** 单次尝试记录（信封 `metadata.attempts`，与 vision-aid 的 MCP 兼容格式一致）。 */
export interface VisionAttempt {
  model: string;
  status: 'ok' | 'failed';
  latency_ms: number;
  error?: string;
  /** 本次用的账户可读名（不含密钥值）。 */
  account?: string;
  /** 本次是否由轮换产生（首次尝试为 false）。 */
  rotated: boolean;
}

/** 视觉链的成功结果。 */
export interface VisionChainResult {
  text: string;
  model: string;
  attempts: VisionAttempt[];
  /** 实际使用的凭据引用名（可读，不含密钥值）。 */
  accountRef?: string;
}

/** 可中止的等待（跨组组间隙用）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 从 OpenAI 兼容响应里取 `choices[0].message.content`。 */
function extractText(data: unknown): string {
  if (typeof data !== 'object' || data === null) throw new Error('response is not a JSON object');
  const choices = (data as { choices?: unknown }).choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (typeof first === 'object' && first !== null) {
      const message = (first as { message?: unknown }).message;
      if (typeof message === 'object' && message !== null) {
        const content = (message as { content?: unknown }).content;
        if (typeof content === 'string' && content.trim() !== '') return content;
      }
    }
  }
  throw new Error(`response had no choices[0].message.content: ${JSON.stringify(data).slice(0, 300)}`);
}

/** 429 响应体的形态摘要（与 adapter 的 rateLimitDetail 同口径）。 */
function rateLimitDetail(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null) return bodyText.slice(0, 80);
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return bodyText.slice(0, 80);
    const code = (error as { code?: unknown }).code;
    const message = (error as { message?: unknown }).message;
    const parts: string[] = [];
    if (code !== undefined) parts.push(`code=${String(code)}`);
    if (typeof message === 'string' && message !== '') parts.push(message.slice(0, 80));
    return parts.join(', ');
  } catch {
    return bodyText.slice(0, 80);
  }
}

/** 取错误码（数字转字符串；缺失为空串）。 */
function extractCode(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const error = typeof parsed === 'object' && parsed !== null
      ? (parsed as { error?: unknown }).error
      : undefined;
    const code = typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
    return code === undefined ? '' : String(code);
  } catch {
    return '';
  }
}

/** 一次 POST（非流式）。返回状态与文本，不抛 HTTP 错误 —— 由调用方分类。 */
async function postOnce(params: {
  runtime: VisionRuntime;
  apiBase: string;
  model: string;
  apiKey: string;
  body: object;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; text: string; headers: Headers }> {
  const doFetch = params.runtime.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(params.timeoutMs);
  const signal = params.signal === undefined ? timeout : AbortSignal.any([params.signal, timeout]);
  // 实时闪灯：视觉请求同样点亮它实际使用的 key（绿）。
  params.runtime.onKeyEvent?.(params.apiKey, 'start');
  const response = await doFetch(`${params.apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${params.apiKey}`,
      ...attributionHeaders(),
    },
    body: JSON.stringify({ model: params.model, ...params.body, stream: false }),
    // 凭据请求拒重定向（web/AGENTS.md 的硬约定）。
    redirect: 'error',
    signal,
  });
  const text = await response.text().catch(() => '');
  return { ok: response.ok, status: response.status, text, headers: response.headers };
}

/**
 * 从 taskType 派生「视觉模式」（2026-11-02）。
 *
 * 日志里必须能一眼分开两类调用 —— 它们用同一批 key、写同一份文件：
 *   `'bridge'` 拖图自动识别（用户拖进对话框，桥先把图转成观察文本）
 *   `'tool'`   主模型主动调用 describe_image / describe_images
 *   `'chat'`   主模型调用 chat（纯文本，验证连通性/兜底）
 *
 * @param taskType - runVisionChain 收到的任务类型。
 * @returns 模式标签。
 */
export function visionModeOf(taskType: string): 'bridge' | 'tool' | 'chat' {
  if (taskType === 'bridge') return 'bridge';
  if (taskType === 'chat') return 'chat';
  return 'tool';
}

/** 中文可读标签，写进日志 message，便于直接 grep。 */
export function visionLabelOf(taskType: string): string {
  if (taskType === 'bridge') return '拖图识别';
  if (taskType === 'chat') return '工具·纯文本';
  if (taskType === 'image_reasoning_multi') return '工具·多图';
  return '工具·单图';
}

/**
 * 跑一次视觉链：逐模型尝试，每个模型内按配额策略轮换 key。
 *
 * 失败语义：全部模型 + 全部轮换都失败后抛聚合错误（工具层包成信封的 `error`）。
 *
 * @param options.content - 已构造好的 content 数组（image_url + text）。
 * @param options.models - 故障转移顺序。
 * @param options.timeoutMs - 单次请求超时。
 * @param options.taskType - 仅用于日志分类（image_reasoning / chat / bridge）。
 */
export async function runVisionChain(options: {
  runtime: VisionRuntime;
  content: Array<Record<string, unknown>>;
  models: string[];
  timeoutMs: number;
  taskType: string;
  signal?: AbortSignal;
}): Promise<VisionChainResult> {
  const { runtime } = options;
  const now = runtime.now ?? Date.now;
  const visionMode = visionModeOf(options.taskType);
  const visionLabel = visionLabelOf(options.taskType);
  const apiBase = runtime.apiBase();
  const queueMs = runtime.queueTimeoutMs();
  const concurrency = runtime.concurrency();
  const rotationAllowed = runtime.quotaRotation();
  const maxRotationsByAccounts = Math.max(1, Math.min(VISION_MAX_KEY_ROTATIONS, runtime.accountCount()));
  const attempts: VisionAttempt[] = [];
  const tried = new Set<string>();
  let apiKey: string;
  try {
    apiKey = await runtime.resolveApiKey();
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  let lastError = '';

  for (const model of options.models) {
    let rotation = 0;
    while (rotation <= maxRotationsByAccounts) {
      if (options.signal?.aborted === true) {
        throw options.signal.reason ?? new DOMException('aborted', 'AbortError');
      }
      tried.add(apiKey);
      const gate = runtime.gateKeyOf(apiKey);
      const started = now();
      let release: Release | undefined;
      try {
        release = await runtime.gate().acquire(gate.key, gate.limit, options.signal, queueMs);
        const response = await postOnce({
          runtime,
          apiBase,
          model,
          apiKey,
          body: { messages: [{ role: 'user', content: options.content }] },
          timeoutMs: options.timeoutMs,
          signal: options.signal,
        });
        const described = runtime.describeKey?.(apiKey);
        const latency = Math.round(now() - started);

        if (response.ok) {
          let text: string;
          try {
            text = extractText(JSON.parse(response.text) as unknown);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            attempts.push({
              model,
              status: 'failed',
              latency_ms: latency,
              error: message,
              ...(described !== undefined ? { account: described.label } : {}),
              rotated: rotation > 0,
            });
            lastError = message;
            break; // 响应体异常：换模型，不重试同一模型
          }
          // 成功是池已恢复的最强证据：清 key strikes + 清组退避 + AIMD 衰减。
          runtime.reportSuccess(apiKey);
          attempts.push({
            model,
            status: 'ok',
            latency_ms: latency,
            ...(described !== undefined ? { account: described.label } : {}),
            rotated: rotation > 0,
          });
          runtime.record?.({
            ts: new Date(now()).toISOString(),
            model,
            status: response.status,
            code: '',
            kind: '',
            quota: false,
            message: `视觉·${visionLabel} ok`,
            rotated: rotation > 0,
            attempt: attempts.length,
            account: fingerprint(apiKey),
            session: '',
            phase: 'vision',
            result: 'ok',
            latencyMs: latency,
            visionMode,
            visionTask: options.taskType,
            ...(described !== undefined ? { accountLabel: described.label, accountRef: described.ref } : {}),
          });
          return {
            text,
            model,
            attempts,
            ...(described !== undefined ? { accountRef: described.ref } : {}),
          };
        }

        // ── 非 2xx ────────────────────────────────────────────────────────
        lastError = `HTTP ${response.status}: ${response.text.slice(0, 300)}`;
        attempts.push({
          model,
          status: 'failed',
          latency_ms: latency,
          error: lastError,
          ...(described !== undefined ? { account: described.label } : {}),
          rotated: rotation > 0,
        });

        if (response.status === 401) {
          // 密钥失效：`rotateApiKey('invalid-credential')` 内部会把该 key 从账户池、
          // key 池、组池里永久移除，不需要这里再补一刀。然后换一把继续同一模型。
          const next = await runtime.rotateApiKey(apiKey, 'invalid-credential', tried);
          if (next !== undefined && !tried.has(next) && rotation < maxRotationsByAccounts) {
            apiKey = next;
            rotation += 1;
            continue;
          }
          break;
        }

        if (response.status === 429) {
          // 实时闪灯：视觉请求撞 429 同样红闪该 key。
          runtime.onKeyEvent?.(apiKey, 'rate-limit');
          const classified = classify429Body(response.text);
          const kind = classified.kind === 'quota_exhausted'
            ? 'quota_exhausted'
            : classified.kind ?? 'rate';
          const poolState = runtime.reportRateLimit(apiKey, kind);
          const headerMs = parseRetryAfterMs(response.headers.get('retry-after'));
          const plan = plan429RetryAfterMs(classified, undefined, headerMs);
          const providerRetryAfterMs = plan === undefined
            ? undefined
            : plan.respectHeader
              ? Math.min(plan.baseMs, QUOTA_RETRY_AFTER_CEILING_MS)
              : applyUpwardJitter(plan.baseMs, QUOTA_RETRY_AFTER_CEILING_MS, Math.random);
          runtime.record?.({
            ts: new Date(now()).toISOString(),
            model,
            status: response.status,
            code: extractCode(response.text),
            kind,
            quota: classified.quota,
            message: rateLimitDetail(response.text),
            rotated: false,
            attempt: attempts.length,
            account: fingerprint(apiKey),
            session: '',
            phase: 'vision',
            result: 'error',
            latencyMs: latency,
            visionMode,
            visionTask: options.taskType,
            kicked: poolState.kicked,
            poolRunning: poolState.running,
            poolBlocked: poolState.blocked,
            ...(providerRetryAfterMs !== undefined ? { providerRetryAfterMs } : {}),
            ...(described !== undefined ? { accountLabel: described.label, accountRef: described.ref } : {}),
          });
          if (!rotationAllowed || rotation >= maxRotationsByAccounts) break;
          const next = await runtime.rotateApiKey(apiKey, 'quota-exhausted', tried);
          if (next === undefined || tried.has(next)) break;
          // 只在真的换到**另一组**时等待 AIMD 组间隙（同组换 key 不必降速）。
          const gapMs = runtime.groupGapMs?.();
          const prevGroup = runtime.groupOf?.(apiKey);
          const nextGroup = runtime.groupOf?.(next);
          if (gapMs !== undefined && gapMs > 0 && prevGroup !== nextGroup) {
            await sleep(gapMs, options.signal);
          }
          apiKey = next;
          rotation += 1;
          continue;
        }

        // 404 / 400 / 5xx：该模型不可用，换下一个模型（不重试、不轮换）。
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({
          model,
          status: 'failed',
          latency_ms: Math.round(now() - started),
          error: message,
          rotated: rotation > 0,
        });
        lastError = message;
        if (options.signal?.aborted === true) throw error;
        break;
      } finally {
        release?.();
      }
    }
  }

  throw new Error(
    `all ${options.models.length} vision model(s) failed (${options.models.join(', ')}); last error: ${lastError}`,
  );
}
