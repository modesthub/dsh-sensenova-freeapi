/**
 * 错误记录的**只读 HTTP 接口**（2026-09-18，W5 之后的「诊断区块」）。
 *
 * 为什么走 HTTP 路由而不是 typert RPC：本场景只需"读一个日志文件并算几个数"，
 * 路由注册一行 `ctx.connection.fetch.register(...)` 即可，且同源请求自带 cookie
 * 鉴权 ⇒ client 侧 `fetch` 就能用，省掉一层 codegen/类型声明。
 *
 * 三条硬约束（都来自"这是设置页里的一小块区域"这个定位）：
 *  1. **不全量回传**：`sensenova-errors.jsonl` 上限 5 MB，直接塞给浏览器会卡。
 *     ⇒ 读文件后只在 host 侧聚合，client 只拿「三个数字 + 最近 N 条」。
 *  2. **懒创建、缺失即正常**：文件只在第一次真实 429 时出现 ⇒ 不存在时返回
 *     `available: false` 而不是报错（否则设置页会一直显示红字）。
 *  3. **永不抛**：读取/解析异常一律降级为"空快照 + available:false"，因为这块 UI
 *     是辅助信息，坏掉不能影响设置页本身（与 error-log.ts 的 `record()` 同一原则）。
 */

import { open, readFile, stat } from 'node:fs/promises';
import {
  ERROR_LOG_MESSAGE_MAX_CHARS,
  defaultErrorLogPath,
  type SenseNovaRateLimitEvent,
} from './error-log.ts';

/** 路由路径（client 侧硬编码同值；约定与官方路由一致，挂在 `/api/` 下）。 */
export const ERROR_LOG_ROUTE = '/api/sensenova/errorLog';

/**
 * 单次读取的字节上限。日志文件本身按 5 MB 滚动，所以默认值给足余量；
 * 万一被外部工具改大，也只读尾部并置 `truncated: true`（统计口径随之收窄，
 * 宁可标注也不无声截断）。
 */
export const ERROR_LOG_READ_LIMIT_BYTES = 16 * 1024 * 1024;

/** 统计窗口默认 24 小时。 */
export const ERROR_LOG_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 列表默认条数 / 上限（上限用于防止 URL 里塞一个巨大的 limit）。 */
export const ERROR_LOG_DEFAULT_LIMIT = 50;
export const ERROR_LOG_MAX_LIMIT = 200;

/** 前端展示用的一条记录（字段名与 JSONL 保持一致，避免两套命名需要对照）。 */
export interface ErrorLogEntry {
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
  /** 探测档位索引（0 起）；仅 rpm/tpm 有。长期停在最大值 = 档位锁死（2026-09-24 新增）。 */
  probeHits?: number;
  /** 本 key 是否因本次命中被踢出运行态（2026-09-27 新增，**取代已移除的 `saturated`**）。 */
  kicked?: boolean;
  /** 事件产生时 key 池的运行态把数（2026-09-27 新增）。 */
  poolRunning?: number;
  /** 事件产生时 key 池的阻塞态把数（2026-09-27 新增）。 */
  poolBlocked?: number;
  /** 可读账户名（如「账户 2」，2026-09-27 新增）。 */
  accountLabel?: string;
  /** 该 key 的 credential-ref 名（如 `SENSENOVA_API_KEY_2`，2026-09-27 新增）。 */
  accountRef?: string;
  /** key 指纹（sha256 前 8 位）。与 `accountLabel` 互补：指纹用于关联，名字用于人读。 */
  account: string;
}

/** 一次查询的完整答复。 */
export interface ErrorLogSnapshot {
  /** 日志文件是否存在。false = 从未发生过限流 ⇒ UI 显示"暂无记录"，不是错误。 */
  available: boolean;
  /** 日志文件绝对路径（便于用户直接去 `tail`）。 */
  path: string;
  /** 统计窗口（毫秒）。 */
  windowMs: number;
  /** 窗口内总条数。 */
  total: number;
  /** 窗口内出现过的不同 `error.code` 数量。 */
  distinctCodes: number;
  /** 窗口内出现过的不同模型数量。 */
  distinctModels: number;
  /** 最近记录，新的在前，最多 `limit` 条。 */
  entries: ErrorLogEntry[];
  /** 文件超过读取上限时为 true（此时统计只覆盖尾部，口径收窄）。 */
  truncated: boolean;
}

/** 解析失败或文件不可读时返回的空快照（UI 只需据此显示"暂无记录"）。 */
export function emptySnapshot(filePath: string, windowMs: number): ErrorLogSnapshot {
  return {
    available: false,
    path: filePath,
    windowMs,
    total: 0,
    distinctCodes: 0,
    distinctModels: 0,
    entries: [],
    truncated: false,
  };
}

/**
 * 把 JSONL 文本解析成事件数组（纯函数，便于单测）。
 *
 * @param text - 文件内容（或尾部切片）
 * @param dropFirst - true 时丢弃第一行：按字节截取尾部时首行大概率是半截 JSON。
 * @returns 可解析的事件，**保持文件顺序**（新的在后）；坏行直接跳过。
 */
export function parseErrorLogText(text: string, dropFirst = false): SenseNovaRateLimitEvent[] {
  const lines = text.split('\n');
  const start = dropFirst ? 1 : 0;
  const events: SenseNovaRateLimitEvent[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    // 尾部截取常留下一个不完整的最后一行（没有换行符结尾也有可能是完整的），
    // 统一由 `JSON.parse` 兜底：坏行跳过，不打断整批。
    if (line === undefined || line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        events.push(parsed as SenseNovaRateLimitEvent);
      }
    } catch {
      continue;
    }
  }
  return events;
}

/** 把事件压成前端要的一条。`message` 再截一次，防止旧版本写入的超长行撑爆 UI。 */
function toEntry(event: SenseNovaRateLimitEvent): ErrorLogEntry {
  return {
    ts: typeof event.ts === 'string' ? event.ts : '',
    model: typeof event.model === 'string' ? event.model : '',
    code: typeof event.code === 'string' ? event.code : '',
    kind: typeof event.kind === 'string' ? event.kind : '',
    rotated: event.rotated === true,
    attempt: typeof event.attempt === 'number' ? event.attempt : 0,
    message: typeof event.message === 'string'
      ? event.message.slice(0, ERROR_LOG_MESSAGE_MAX_CHARS)
      : '',
    ...(typeof event.retryFloorMs === 'number' ? { retryFloorMs: event.retryFloorMs } : {}),
    ...(typeof event.providerRetryAfterMs === 'number'
      ? { providerRetryAfterMs: event.providerRetryAfterMs }
      : {}),
    ...(typeof event.probeHits === 'number' ? { probeHits: event.probeHits } : {}),
    ...(typeof event.kicked === 'boolean' ? { kicked: event.kicked } : {}),
    ...(typeof event.poolRunning === 'number' ? { poolRunning: event.poolRunning } : {}),
    ...(typeof event.poolBlocked === 'number' ? { poolBlocked: event.poolBlocked } : {}),
    ...(typeof event.accountLabel === 'string' && event.accountLabel !== ''
      ? { accountLabel: event.accountLabel }
      : {}),
    ...(typeof event.accountRef === 'string' && event.accountRef !== ''
      ? { accountRef: event.accountRef }
      : {}),
    account: typeof event.account === 'string' ? event.account : '',
  };
}

export interface SummarizeOptions {
  filePath: string;
  windowMs: number;
  limit: number;
  /** 注入便于单测；默认 `Date.now()`。 */
  now?: number;
}

/**
 * 由事件列表算出快照（纯函数，便于单测）。
 *
 * 统计口径：**按事件时间戳落在窗口内**才算，而不是"文件里的最后 N 条"——
 * 因为文件可能几分钟没更新，用条数当窗口会让"近 24h 共 37 次"长期虚高。
 */
export function summarizeErrorLog(
  events: readonly SenseNovaRateLimitEvent[],
  options: SummarizeOptions,
): ErrorLogSnapshot {
  const now = options.now ?? Date.now();
  const cutoff = now - options.windowMs;
  const recent = events.filter((event) => {
    const parsed = Date.parse(typeof event.ts === 'string' ? event.ts : '');
    return Number.isFinite(parsed) && parsed >= cutoff;
  });

  const codes = new Set<string>();
  const models = new Set<string>();
  for (const event of recent) {
    if (typeof event.code === 'string' && event.code !== '') codes.add(event.code);
    if (typeof event.model === 'string' && event.model !== '') models.add(event.model);
  }

  // 列表取**全部事件**的尾部（而非只在窗口内的），这样调大窗口/文件静默时
  // 用户仍能看到最近发生过什么；窗口只约束上面三个数字。
  const tail = events.slice(Math.max(0, events.length - options.limit));
  return {
    available: true,
    path: options.filePath,
    windowMs: options.windowMs,
    total: recent.length,
    distinctCodes: codes.size,
    distinctModels: models.size,
    entries: tail.map(toEntry).reverse(),
    truncated: false,
  };
}

/** 读取日志文本；超过上限时只读**尾部**（真读尾部，不是读完再切）。 */
async function readWithinLimit(filePath: string): Promise<{ text: string; truncated: boolean }> {
  const info = await stat(filePath);
  if (info.size <= ERROR_LOG_READ_LIMIT_BYTES) {
    return { text: await readFile(filePath, 'utf8'), truncated: false };
  }
  // 超限：定位到尾部起点直接读，避免为一屏诊断信息把整个文件读进内存。
  // 切片起点大概率落在某行中间 ⇒ 调用方需 `dropFirst` 丢掉半截 JSON 首行。
  const handle = await open(filePath, 'r');
  try {
    const start = info.size - ERROR_LOG_READ_LIMIT_BYTES;
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString('utf8'), truncated: true };
  } finally {
    await handle.close();
  }
}

/**
 * 组装一次查询结果：读文件 → 解析 → 汇总。
 *
 * **绝不抛**：文件不存在（懒创建）、权限问题、解析异常，一律降级为空快照。
 */
export async function readErrorLogSnapshot(options: {
  filePath?: string;
  windowMs?: number;
  limit?: number;
  now?: number;
  env?: Record<string, string | undefined>;
} = {}): Promise<ErrorLogSnapshot> {
  const filePath = options.filePath ?? defaultErrorLogPath(options.env ?? process.env);
  const windowMs = options.windowMs ?? ERROR_LOG_DEFAULT_WINDOW_MS;
  // ⚠️ 必须显式挡 NaN：`Math.max(1, NaN)` 返回 NaN，于是 `slice(NaN)` 退化成
  // `slice(0)` = 返回**全部**记录（既不报错也不是空），是最隐蔽的一种越界。
  const requested = options.limit ?? ERROR_LOG_DEFAULT_LIMIT;
  const limit = Math.min(
    Math.max(1, Math.trunc(Number.isFinite(requested) ? requested : ERROR_LOG_DEFAULT_LIMIT)),
    ERROR_LOG_MAX_LIMIT,
  );
  try {
    const { text, truncated } = await readWithinLimit(filePath);
    const events = parseErrorLogText(text, truncated);
    return { ...summarizeErrorLog(events, { filePath, windowMs, limit, ...(options.now === undefined ? {} : { now: options.now }) }), truncated };
  } catch {
    return emptySnapshot(filePath, windowMs);
  }
}

/** 解析 query 里的数字参数（非法即回退默认）。 */
function numberParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * HTTP 处理函数：`GET /api/sensenova/errorLog?limit=50&windowMs=86400000`。
 *
 * ⚠️ **实测（2026-09-18）：`ctx.connection.fetch.register` 的 `methods` 在框架层就做了过滤** ——
 * 非 GET 请求不会被派发到这里，而是落回普通分发链、最终得到 **404**，不是本函数返回的 405。
 * 因此下面的 405 分支是**防御性兜底**（万一将来外层不再按 methods 过滤，行为仍然正确）；
 * 端到端只能观察到 404。单测里那条 405 断言是**直接调用本函数**验证的，不等于端到端路径。
 */
export async function handleErrorLogHttp(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { allow: 'GET' } });
  }
  const url = new URL(request.url);
  const snapshot = await readErrorLogSnapshot({
    limit: numberParam(url, 'limit', ERROR_LOG_DEFAULT_LIMIT),
    windowMs: numberParam(url, 'windowMs', ERROR_LOG_DEFAULT_WINDOW_MS),
  });
  return new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
