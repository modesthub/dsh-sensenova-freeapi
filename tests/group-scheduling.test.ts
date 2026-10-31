/**
 * 组粒度调度（v0.5 P1 方向 2）的适配器级集成测试。
 *
 * 覆盖：
 * 1. 429 ⇒ 本组整组退避 + 同账户账户级联动 + AIMD 组间隙 ×1.5，日志带 groupIndex/groupGapMs；
 * 2. 全组退避 ⇒ fail-fast 429 + Retry-After（不发起上游请求）；
 * 3. 成功 ⇒ 组侧以成功为恢复证据（清退避/清账户标记）+ AIMD 衰减；
 * 4. 配置归一化：调度缺省开、非法字段回落缺省。
 *
 * 组池模块自身的单测见 `tests/group-pool.test.ts`（轮换/冷却/退避公式/时钟可控）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SensenovaAdapter, type SensenovaConnection } from '../src/adapter.ts';
import { GroupGapController, SensenovaGroupPool } from '../src/group-pool.ts';
import type { SenseNovaErrorLog, SenseNovaRateLimitEvent } from '../src/error-log.ts';
import { resolveAdapterOptions } from '../src/index.ts';

const CONNECTION: SensenovaConnection = {
  apiBase: 'https://example.invalid',
  accountCount: 2,
  // 测试里关闭插件内的 429 原地等待重试（否则每个用例要多等 5s）。
  connectRetry: { maxRetries: 0 },
};

const OPTIONS: GenerateOptions = {
  provider: 'sensenova',
  model: 'test-model',
  messages: [],
};

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
  'data: {"id":"1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

async function collect(adapter: SensenovaAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

/** 收集运行日志事件的假记录器（与 adapter.test.ts 同约定）。 */
function collectingErrorLog(): { events: SenseNovaRateLimitEvent[]; thunk: () => SenseNovaErrorLog } {
  const events: SenseNovaRateLimitEvent[] = [];
  const fake = { record: (event: SenseNovaRateLimitEvent) => { events.push(event); } } as unknown as SenseNovaErrorLog;
  return { events, thunk: () => fake };
}

/**
 * 2 组 × 2 账户的时钟可控调度器：组 0 = {a1,b1}，组 1 = {a2,b2}；
 * a* 属 account-1，b* 属 account-2。
 */
function makeScheduler(now: () => number = () => 0): {
  pool: SensenovaGroupPool;
  gap: GroupGapController;
} {
  const pool = new SensenovaGroupPool({
    config: () => ({ cooldownJitter: 0, initialGroupGapMs: 2_000 }),
    now,
    random: () => 0,
  });
  pool.seed([['a1', 'b1'], ['a2', 'b2']], (key) => (key.startsWith('a') ? 'account-1' : 'account-2'));
  const gap = new GroupGapController({ config: () => ({ initialGroupGapMs: 2_000 }), now });
  return { pool, gap };
}

test('组调度：429 → 本组整组退避 + 账户级联动 + AIMD gap×1.5 + 日志 groupIndex/groupGapMs', async () => {
  const scheduler = makeScheduler();
  const collected = collectingErrorLog();
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'a1',
    rotateApiKey: async () => undefined,
    errorLog: collected.thunk,
    groupPool: () => scheduler.pool,
    groupGap: () => scheduler.gap,
    fetchImpl: (async () => new Response(
      JSON.stringify({ error: { code: '8', message: 'rate limit' } }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (error: unknown) => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, 'RATE_LIMIT');
    return true;
  });

  const snaps = scheduler.pool.groupsSnapshot();
  assert.equal(snaps[0]?.cooldownUntil, 90_000, '命中组整组退避（base 90s）');
  assert.equal(snaps[0]?.strikes, 1);
  assert.equal(snaps[1]?.cooldownUntil, 0, '未命中组不整组退避');
  assert.equal(snaps[1]?.accountCooldown.get('account-1'), 90_000, '同账户在兄弟组被账户级标记');
  assert.equal(scheduler.gap.gapMs(), 3_000, 'AIMD 组间隙 2000 × 1.5');

  const event = collected.events.at(-1);
  assert.ok(event !== undefined);
  assert.equal(event.result, 'error');
  assert.equal(event.groupIndex, 0, '日志带上命中组索引');
  assert.equal(event.groupGapMs, 3_000, '日志带上放大后的组间隙');
});

test('组调度：全组退避 → fail-fast 429 + Retry-After，不发起上游请求', async () => {
  const scheduler = makeScheduler();
  // 组 0（account-1）+ 组 1（account-2 的 a2 撞）全退避。
  scheduler.pool.reportRateLimit({ key: 'a1', kind: 'tpm' });
  scheduler.pool.reportRateLimit({ key: 'a2', kind: 'rate' });
  assert.equal(scheduler.pool.watchKey('a1')?.allCooled, true);

  let calls = 0;
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'a1',
    rotateApiKey: async () => undefined,
    groupPool: () => scheduler.pool,
    groupGap: () => scheduler.gap,
    fetchImpl: (async () => {
      calls += 1;
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (error: unknown) => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, 'RATE_LIMIT');
    assert.equal(error.failure.status, 429);
    assert.equal(error.failure.providerRetryAfterMs, 8_000, '快返按 failFastMs（acquire_fail_fast）');
    return true;
  });
  assert.equal(calls, 0, '全池冷却时不抢 gate、不发上游请求');
});

test('组调度：成功 → 清本组退避与账户联动标记 + AIMD 衰减；成功日志带 groupIndex', async () => {
  let now = 0;
  const scheduler = makeScheduler(() => now);
  const collected = collectingErrorLog();
  // 先在 t=0 撞一次（组 0 退避 90s、gap=3000、账户 1 在组 1 打标记）。
  scheduler.pool.reportRateLimit({ key: 'a1', kind: 'tpm' });
  scheduler.gap.recordHit();
  assert.equal(scheduler.gap.gapMs(), 3_000);
  // 8s 后成功：账户已恢复 ⇒ 成功是「池已恢复」的最强证据（对称清除）。
  now = 9_000;

  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'a1',
    rotateApiKey: async () => undefined,
    errorLog: collected.thunk,
    groupPool: () => scheduler.pool,
    groupGap: () => scheduler.gap,
    fetchImpl: (async () => sseResponse(FIXED_SSE)) as typeof fetch,
  });

  await collect(adapter, OPTIONS);

  const snaps = scheduler.pool.groupsSnapshot();
  assert.equal(snaps[0]?.cooldownUntil, 0, '成功清本组退避');
  assert.equal(snaps[0]?.strikes, 0);
  assert.equal(snaps[1]?.accountCooldown.has('account-1'), false, '成功清账户级联动标记');
  assert.equal(scheduler.gap.gapMs(), 2_850, '连续 8s 无 429 ⇒ 3000 × 0.95');

  const event = collected.events.at(-1);
  assert.ok(event !== undefined);
  assert.equal(event.result, 'ok');
  assert.equal(event.groupIndex, 0);
});

test('resolveAdapterOptions: scheduling 缺省开、显式关闭生效、非法字段回落缺省', () => {
  const defaults = resolveAdapterOptions({}).scheduling;
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.cooldownBaseMs, 90_000);
  assert.equal(defaults.groupGapMultiplier, 1.5);
  assert.equal(defaults.failFastMs, 8_000);

  assert.equal(resolveAdapterOptions({ scheduling: { enabled: false } }).scheduling.enabled, false);
  // 越界/非法字段被丢弃（回落缺省），enabled 仍保留缺省 true。
  const invalid = resolveAdapterOptions({ scheduling: { cooldownJitter: 7, enabled: true } }).scheduling;
  assert.equal(invalid.cooldownJitter, undefined, '越界字段回落缺省');
  assert.equal(invalid.enabled, true);
});
