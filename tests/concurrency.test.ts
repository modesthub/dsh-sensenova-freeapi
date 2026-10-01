import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUEUE_TIMEOUT_MS,
  KeyedConcurrencyGate,
  normalizeConcurrencyLimit,
} from '../src/concurrency.ts';
import { SensenovaAdapter, type SensenovaConnection } from '../src/adapter.ts';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';

const CONNECTION: SensenovaConnection = { apiBase: 'https://example.invalid', accountCount: 1 };

function sseResponse(sseText: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseText));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const FIXED_SSE = [
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const OPTIONS: GenerateOptions = { provider: 'sensenova', model: 'test-model', messages: [] };

async function collect(adapter: SensenovaAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

/** 构造一个行为可编程的异步释放钩子，用于断言排队时序。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** 轮询等待条件成立（最多约 2s），避免依赖微任务冲数。 */
async function waitFor(cond: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('normalizeConcurrencyLimit: 非法值回退 1', () => {
  assert.equal(normalizeConcurrencyLimit(1), 1);
  assert.equal(normalizeConcurrencyLimit(3), 3);
  assert.equal(normalizeConcurrencyLimit(0), 1);
  assert.equal(normalizeConcurrencyLimit(-2), 1);
  assert.equal(normalizeConcurrencyLimit(1.5), 1);
  assert.equal(normalizeConcurrencyLimit(undefined), 1);
  assert.equal(normalizeConcurrencyLimit('2'), 1);
});

test('KeyedConcurrencyGate: 未超限直接放行，release 后恢复', async () => {
  const gate = new KeyedConcurrencyGate();
  const release1 = await gate.acquire('k1', 2);
  const release2 = await gate.acquire('k1', 2);
  release1();
  // 释放后额度恢复，可再次获取。
  const release3 = await gate.acquire('k1', 2);
  release2();
  release3();
});

test('KeyedConcurrencyGate: 达到上限时排队，FIFO 按序唤醒', async () => {
  const gate = new KeyedConcurrencyGate();
  const order: string[] = [];
  const first = await gate.acquire('k1', 1);
  const second = gate.acquire('k1', 1);
  const third = gate.acquire('k1', 1);
  await Promise.resolve();
  assert.deepEqual(order, [], '未释放前排队者不得开始');
  first();
  first(); // release 幂等
  const releaseSecond = await second;
  order.push('second');
  assert.deepEqual(order, ['second'], '释放后队首开始，third 仍在排队');
  releaseSecond();
  const releaseThird = await third;
  order.push('third');
  releaseThird();
  assert.deepEqual(order, ['second', 'third'], 'FIFO 按序唤醒');
});

test('KeyedConcurrencyGate: 每 key 独立限额（key-1 排队不阻塞 key-2）', async () => {
  const gate = new KeyedConcurrencyGate();
  const first = await gate.acquire('key-1', 1);
  const queued = gate.acquire('key-1', 1).then(() => 'queued');
  const other = await gate.acquire('key-2', 1);
  other(); // key-2 不受 key-1 排队影响，立即可用并释放
  first();
  await queued;
});

test('KeyedConcurrencyGate: 排队等待期间中止 → 取消错误且不占额度', async () => {
  const gate = new KeyedConcurrencyGate();
  const controller = new AbortController();
  const first = await gate.acquire('k1', 1);
  const queued = gate.acquire('k1', 1, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(queued, (err: unknown) => {
    assert.ok(err instanceof DOMException);
    assert.equal(err.name, 'AbortError');
    return true;
  });
  // 中止的排队者被移除，释放后应由后续可用。
  const next = gate.acquire('k1', 1);
  first();
  const release = await next;
  release();
});

test('KeyedConcurrencyGate: 排队超时默认常量（design D4，2026-09-04 实测）', () => {
  assert.equal(DEFAULT_QUEUE_TIMEOUT_MS, 60_000);
});

test('KeyedConcurrencyGate: 空条目排空后惰性删除', async () => {
  const gate = new KeyedConcurrencyGate();
  const release = await gate.acquire('k1', 1);
  release();
  assert.equal((gate as unknown as { states: Map<string, unknown> }).states.size, 0, '排空后条目被删除');
});

test('KeyedConcurrencyGate: 排队超时 → TimeoutError reject 且不占额度、从队列移除', async () => {
  const gate = new KeyedConcurrencyGate();
  const first = await gate.acquire('k1', 1);
  const queued = gate.acquire('k1', 1, undefined, 30);
  await assert.rejects(queued, (err: unknown) => {
    assert.ok(err instanceof DOMException);
    assert.equal(err.name, 'TimeoutError', '排队超时以 TimeoutError reject（adapter 层映射为可重试 LlmError TIMEOUT）');
    return true;
  });
  // 超时者已从队列移除且不占额度：释放后下一个可立即获取。
  const next = gate.acquire('k1', 1);
  first();
  const release = await next;
  release();
  assert.equal((gate as unknown as { states: Map<string, unknown> }).states.size, 0, '排空后条目被删除');
});

test('KeyedConcurrencyGate: 排队超时清 abort listener，超时后中止不产生副作用', async () => {
  const gate = new KeyedConcurrencyGate();
  const controller = new AbortController();
  const first = await gate.acquire('k1', 1);
  const queued = gate.acquire('k1', 1, controller.signal, 30);
  await assert.rejects(queued, (err: unknown) => (err as Error).name === 'TimeoutError');
  // 超时路径已清 listener；此时 abort 不得把超时错误改写或产生未处理拒绝。
  controller.abort();
  // 队列已空，后续获取不受影响。
  const next = gate.acquire('k1', 1);
  first();
  const release = await next;
  release();
});

test('KeyedConcurrencyGate: 排队正常唤醒时超时定时器被清理（可继续使用）', async () => {
  const gate = new KeyedConcurrencyGate();
  const first = await gate.acquire('k1', 1);
  const queued = gate.acquire('k1', 1, undefined, 30);
  first();
  const release = await queued;
  release();
  // 等待超过原超时窗口：若定时器未被清理会在此触发错误/泄漏。
  await new Promise((r) => setTimeout(r, 50));
  const again = await gate.acquire('k1', 1);
  again();
});

test('stream: 缺省并发上限为 1，同一 key 串行', async () => {
  const started = deferred();
  const release = deferred();
  let inFlight = 0;
  let maxInFlight = 0;
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.resolve();
      await release.promise;
      inFlight -= 1;
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });

  const first = collect(adapter, OPTIONS);
  await started.promise;
  const second = collect(adapter, OPTIONS);
  await Promise.resolve();
  assert.equal(maxInFlight, 1, '缺省上限 1：同时至多一个在途请求');
  release.resolve();
  await first;
  await second;
  assert.equal(maxInFlight, 1, '全程串行');
});

test('stream: options().concurrency 上限生效（2 并发，第三个排队）', async () => {
  const started = deferred();
  const release = deferred();
  let inFlight = 0;
  let maxInFlight = 0;
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, concurrency: 2 }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.resolve();
      await release.promise;
      inFlight -= 1;
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });

  const first = collect(adapter, OPTIONS);
  await started.promise;
  const second = collect(adapter, OPTIONS);
  await waitFor(() => maxInFlight === 2, '第二个请求进入 fetch');
  // 同一 adapter 上第三个请求达到上限时排队不发起。
  const third = collect(adapter, OPTIONS);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(maxInFlight, 2, '第三个在同一 gate 上排队，不进入 fetch（maxInFlight 仍为 2）');
  release.resolve();
  await first;
  await second;
  await third;
});

test('stream: 流结束时释放额度（串行下第二个请求在前序完成后开始）', async () => {
  const order: string[] = [];
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => {
      order.push('fetch');
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });
  await collect(adapter, OPTIONS);
  await collect(adapter, OPTIONS);
  assert.deepEqual(order, ['fetch', 'fetch'], '串行执行，前序完成后第二个才发起');
});

test('stream: 取消不占额度（排队中 abort 后后续请求可立即开始）', async () => {
  const started = deferred();
  const release = deferred();
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => {
      started.resolve();
      await release.promise;
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const first = collect(adapter, { ...OPTIONS, signal: controller.signal });
  await started.promise;
  // 第二个排队。
  const second = adapter.stream({ ...OPTIONS, signal: controller.signal });
  await Promise.resolve();
  // 第三个也排队。
  const third = adapter.stream(OPTIONS);
  await Promise.resolve();
  // 取消排队中的 second。
  controller.abort();
  await assert.rejects(second.next(), (err: unknown) => (err as Error).name === 'AbortError');
  // 释放 first 后，third 应可开始（second 不占额度）。
  release.resolve();
  await first;
  const chunks: StreamChunk[] = [];
  for await (const chunk of third) chunks.push(chunk);
  assert.ok(chunks.some((c) => c.type === 'finish'), 'third 正常完成');
});

test('stream: 401 预流轮换先释放旧 key 额度再获取新 key（不泄漏额度）', async () => {
  const gate = new KeyedConcurrencyGate();
  let rotateCount = 0;
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2 }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => {
      rotateCount += 1;
      return rotateCount === 1 ? 'key-2' : undefined;
    },
    concurrencyGate: gate,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      if (u.endsWith('/chat/completions')) {
        if (init?.headers && (init.headers as Record<string, string>)['authorization'] === 'Bearer key-2') {
          return sseResponse(FIXED_SSE);
        }
        return new Response('unauthorized', { status: 401 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.ok(rotateCount >= 1, 'key-1 401 触发轮换');
  assert.ok(chunks.some((c) => c.type === 'finish'), '轮换到 key-2 完成流');
  assert.equal(
    (gate as unknown as { states: Map<string, unknown> }).states.size,
    0,
    '轮换后无残留额度（旧 key 释放、新 key 流结束释放）',
  );
});