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

export type Release = () => void;

/** 排队超时默认值（毫秒）。2026-09-04 实测：与 TPM 60s 窗口对齐（design D4/D6）。 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;

/** 把配置的并发上限归一化为正整数：非整数、负数或无法解析一律回退 1。 */
export function normalizeConcurrencyLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

/** 排队/等待期间中止时抛出的取消错误（不占额度）。 */
export function concurrencyAbortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** 排队超时抛出的超时错误（不占额度；adapter 层映射为可重试 LlmError 'TIMEOUT'）。 */
export function concurrencyQueueTimeoutError(): Error {
  return new DOMException('The operation was timed out.', 'TimeoutError');
}

interface QueueEntry {
  signal: AbortSignal | undefined;
  resolve: () => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

interface KeyState {
  inFlight: number;
  queue: QueueEntry[];
}

/**
 * 按 key 隔离的并发闸：`acquire(key, limit, signal?, queueTimeoutMs?)` 在额度
 * 允许时立即返回 `release()`；达到上限时按 FIFO 排队，前序释放后唤起队首。
 * 排队期间 signal 中止则 reject 取消错误且不占额度；排队超过 `queueTimeoutMs`
 * （非法值回退默认 60s）则以可重试 TimeoutError reject，同样不占额度、从队列
 * 移除并清 abort listener。release 幂等，排空后惰性删除 key 条目。
 */
export class KeyedConcurrencyGate {
  private readonly states = new Map<string, KeyState>();

  acquire(key: string, limit: unknown, signal?: AbortSignal, queueTimeoutMs?: number): Promise<Release> {
    const capacity = normalizeConcurrencyLimit(limit);
    const timeoutMs = typeof queueTimeoutMs === 'number' && Number.isFinite(queueTimeoutMs) && queueTimeoutMs > 0
      ? queueTimeoutMs
      : DEFAULT_QUEUE_TIMEOUT_MS;
    if (signal?.aborted) return Promise.reject(concurrencyAbortError());
    let state = this.states.get(key);
    if (state === undefined) {
      state = { inFlight: 0, queue: [] };
      this.states.set(key, state);
    }
    if (state.inFlight < capacity) {
      state.inFlight += 1;
      return Promise.resolve(this.releaseOf(key, state));
    }
    return new Promise<Release>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: QueueEntry = {
        signal,
        resolve: () => {
          if (timer !== undefined) clearTimeout(timer);
          if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
          state.inFlight += 1;
          resolve(this.releaseOf(key, state));
        },
        reject: (error) => {
          if (timer !== undefined) clearTimeout(timer);
          if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
          reject(error);
        },
        onAbort: () => {
          if (timer !== undefined) clearTimeout(timer);
          const index = state.queue.indexOf(entry);
          if (index >= 0) state.queue.splice(index, 1);
          reject(concurrencyAbortError());
        },
      };
      // 排队超时（不占额度）：从队列移除、清 abort listener 后以 TimeoutError reject；
      // 消息在 adapter 层包装为可重试 LlmError 'TIMEOUT'（design D4 三段超时统一该码）。
      const onTimeout = () => {
        const index = state.queue.indexOf(entry);
        if (index >= 0) state.queue.splice(index, 1);
        if (entry.signal !== undefined) entry.signal.removeEventListener('abort', entry.onAbort);
        reject(concurrencyQueueTimeoutError());
      };
      state.queue.push(entry);
      timer = setTimeout(onTimeout, timeoutMs);
      if (signal !== undefined) {
        if (signal.aborted) entry.onAbort();
        else signal.addEventListener('abort', entry.onAbort, { once: true });
      }
    });
  }

  /**
   * **非阻塞**获取额度：有额度立即返回 `release`，否则返回 `undefined`（**不排队**）。
   *
   * 2026-09-27 新增，专供「阻塞态 key 的恢复探测」使用：
   *   - 探测必须避开该 key 上正在飞行的 agent 请求 —— 否则探测拿到的 429 可能来自
   *     agent 请求造成的瞬时压力，而非该 key 的真实配额状态，结论不可信；
   *   - 排队等待又毫无意义 —— 拿不到额度就跳过这一轮，等下次 tick 再来。
   * 复用同一份 `inFlight` 计数即天然满足该约束，比另建一套探测专用计数更可靠。
   */
  tryAcquire(key: string, limit: unknown): Release | undefined {
    const capacity = normalizeConcurrencyLimit(limit);
    let state = this.states.get(key);
    if (state === undefined) {
      state = { inFlight: 0, queue: [] };
      this.states.set(key, state);
    }
    if (state.inFlight >= capacity) return undefined;
    state.inFlight += 1;
    return this.releaseOf(key, state);
  }

  private releaseOf(key: string, state: KeyState): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.inFlight -= 1;
      const next = state.queue.shift();
      if (next !== undefined) {
        next.resolve();
      } else if (state.inFlight === 0) {
        this.states.delete(key);
      }
    };
  }
}