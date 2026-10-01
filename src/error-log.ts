/**
 * SenseNova 限流事件记录器（W4，2026-09-17）。
 *
 * 目的：把「每一次限流」落成结构化 JSONL，供事后统计（哪个 error.code 最常见、
 * 哪个账号/key 老是被限、退避档位实际走到第几档、轮换是否真的发生）。
 * 会话日志（`$DSH_HOME/sessions/`）里只有 `assistant/attempt` 的失败摘要，
 * 且与会话内容混在一起，做分布统计很别扭；这里独立成一条流。
 *
 * 设计约束（按重要性排序）：
 *  1. **绝不阻塞、绝不抛出**：日志写在请求热路径上，任何失败都只能静默吞掉
 *     （连续失败 N 次后自行停用，避免在只读盘/满盘上反复重试）。
 *  2. **绝不落 key 原文**：只写 sha256 前 8 位指纹（与账号脱敏约定一致）。
 *  3. 单文件超过 {@link ERROR_LOG_MAX_BYTES} 时滚动为 `<name>.1.jsonl`，**只留 1 份历史**
 *     —— 滚动会覆盖上一份，因此更早的事件会被丢弃。这是「存储有界」优先于
 *     「全量留档」的取舍：日志是诊断辅助，不是审计账本。
 *
 * ⚠️ 路径解析**刻意不复用** `@deepseek-ai/dsh-home-paths`：该包不是本插件的既有
 * peerDependency，为一个日志目录增加硬依赖会让插件在缺少该包的 harness 上**整个加载失败**
 * —— 日志不值得这种耦合。这里只做「`$DSH_HOME` 非空优先，否则 `~/.dsh`」这一条最小规则。
 *
 * @module dsh-sensenova-freeapi/error-log
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 单个日志文件的上限；超过即滚动（保留 1 份历史）。 */
export const ERROR_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 连续写入失败达到此数即停用记录器（不再尝试），避免坏路径上反复重试。 */
export const ERROR_LOG_MAX_CONSECUTIVE_FAILURES = 3;

/** message 摘要长度上限（原始体可能很长，且常常重复）。 */
export const ERROR_LOG_MESSAGE_MAX_CHARS = 200;

/** 日志文件相对 DSH home 的路径段。 */
export const ERROR_LOG_SEGMENTS: readonly string[] = ['logs', 'sensenova-errors.jsonl'];

/**
 * 一条限流事件。字符串字段一律存在（未知写空串），便于 `jq` 直接按字段过滤。
 */
export interface SenseNovaRateLimitEvent {
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
  /** 本次是否触发了 key 轮换。 */
  rotated: boolean;
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
}

/**
 * 把敏感值折叠成稳定短指纹（sha256 前 8 位十六进制）。
 * @param value - 原始值；undefined/空串返回空串。
 * @returns 8 位十六进制指纹。
 */
export function fingerprint(value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * 从 429 响应体里取原始 `error.code`（数字与字符串都归一成字符串）。
 * @param bodyText - 响应体原文。
 * @returns code 字符串；缺失或非 JSON 体返回空串。
 */
export function extractErrorCode(bodyText: string): string {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== 'object' || parsed === null) return '';
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return '';
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    if (typeof code === 'number' && Number.isFinite(code)) return String(code);
    return '';
  } catch {
    return '';
  }
}

/**
 * 压缩一段文本成单行摘要（折叠空白 + 截断）。
 * @param text - 原始文本。
 * @param maxChars - 长度上限，缺省 {@link ERROR_LOG_MESSAGE_MAX_CHARS}。
 * @returns 单行摘要。
 */
export function summarize(text: string, maxChars: number = ERROR_LOG_MESSAGE_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars)}…`;
}

/**
 * 解析 DSH home（`$DSH_HOME` 非空优先，否则 `~/.dsh`）。
 * @param env - 环境映射（测试可注入）。
 * @returns 绝对路径。
 */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME;
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh');
}

/**
 * 默认日志文件绝对路径：`$DSH_HOME/logs/sensenova-errors.jsonl`。
 * @param env - 环境映射（测试可注入）。
 * @returns 绝对路径。
 */
export function defaultErrorLogPath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(env), ...ERROR_LOG_SEGMENTS);
}

/** 滚动目标路径：`sensenova-errors.jsonl` → `sensenova-errors.1.jsonl`。 */
function rolledPath(filePath: string): string {
  const suffix = '.jsonl';
  return filePath.endsWith(suffix)
    ? `${filePath.slice(0, -suffix.length)}.1${suffix}`
    : `${filePath}.1`;
}

/** 文件当前字节数；不存在（或不可 stat）按 0 处理。 */
async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
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
export class SenseNovaErrorLog {
  private readonly filePath: string;
  private readonly maxBytes: number;
  /** 串行链：保证 append 顺序，并把失败挡在链外继续工作。 */
  private chain: Promise<void> = Promise.resolve();
  /** 已写入字节数；-1 = 尚未探测（首次写入时 stat 一次）。 */
  private bytes = -1;
  private failures = 0;

  constructor(options: { filePath?: string; maxBytes?: number } = {}) {
    this.filePath = options.filePath ?? defaultErrorLogPath();
    this.maxBytes = options.maxBytes ?? ERROR_LOG_MAX_BYTES;
  }

  /** 当前日志文件绝对路径（诊断用）。 */
  get path(): string {
    return this.filePath;
  }

  /**
   * 记录一条事件。**同步返回，从不抛出**；写失败静默（连续失败后停用）。
   * @param event - 事件体。
   */
  record(event: SenseNovaRateLimitEvent): void {
    if (this.failures >= ERROR_LOG_MAX_CONSECUTIVE_FAILURES) return;
    const line = `${JSON.stringify(event)}\n`;
    // 第二个 then 的 onRejected 把失败挡在链外（链始终保持 resolved），
    // 否则一次写失败会毒化后续所有写入。
    this.chain = this.chain
      .then(() => this.append(line))
      .then(
        () => { this.failures = 0; },
        () => { this.failures += 1; },
      );
  }

  /** 等待在途写入结束（测试与优雅退出用）。 */
  async flush(): Promise<void> {
    await this.chain;
  }

  private async append(line: string): Promise<void> {
    const size = Buffer.byteLength(line);
    if (this.bytes < 0) {
      // 首次写入：确保目录存在并探测既有体积（跨进程重启后仍能正确滚动）。
      await mkdir(dirname(this.filePath), { recursive: true });
      this.bytes = await fileSize(this.filePath);
    }
    if (this.bytes + size > this.maxBytes) {
      // 滚动失败不致命（如被占用）：继续往原文件追加，宁可超限也不丢事件。
      await rename(this.filePath, rolledPath(this.filePath)).catch(() => {});
      this.bytes = 0;
    }
    await appendFile(this.filePath, line, 'utf8');
    this.bytes += size;
  }
}
