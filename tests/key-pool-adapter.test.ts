/**
 * key 池 × 适配器的**集成**测试（2026-09-27 重构）。
 *
 * 与 `tests/key-pool.test.ts` 的分工：那边测池本身的纯逻辑，这里测「适配器把分类结果
 * 正确上报给池、池的相位变化又正确影响下一把 key 的选择」这条**闭环**。
 *
 * 全部零网络、零真实定时器：`fetchImpl` 与时钟都注入，探测直接调 `scheduler.tick()`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SensenovaAdapter, type SensenovaConnection } from '../src/adapter.ts';
import { KeyedConcurrencyGate } from '../src/concurrency.ts';
import { DEFAULT_KEY_POOL_PARAMS, SensenovaKeyPool, type KeyPoolParams } from '../src/key-pool.ts';
import type { SenseNovaErrorLog, SenseNovaRateLimitEvent } from '../src/error-log.ts';
import { createProbeScheduler } from '../src/index.ts';

const CONNECTION: SensenovaConnection = { apiBase: 'https://example.invalid', accountCount: 3 };
const OPTIONS: GenerateOptions = { provider: 'sensenova', model: 'deepseek-flash', messages: [] };

/** 商汤 429 的统一样式：message 同时含 tpm 与 rpm，正则无法区分（这正是分类必须看 code 的原因）。 */
function response429(code: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message: 'inference exceeds tpm/rpm limit' } }),
    { status: 429 },
  );
}
const tpm429 = (): Response => response429('RateLimitExceeded.EndpointTPMExceeded');
const rpm429 = (): Response => response429('RateLimitExceeded.EndpointRPMExceeded');

/** 最小可用 SSE 响应（成功路径只需要一个 finish 与 `[DONE]`）。 */
function sseOk(): Response {
  const body = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect(adapter: SensenovaAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

interface WireOptions {
  keys?: readonly string[];
  params?: Partial<KeyPoolParams>;
  /** 按 key 决定响应。 */
  respond: (key: string) => Response;
  now?: () => number;
  /** 注入限流事件记录器（用于断言事件字段）。 */
  errorLog?: () => SenseNovaErrorLog | undefined;
  /** 注入 key 描述反查（用于断言 accountLabel / accountRef）。 */
  describeKey?: (key: string) => { label: string; ref: string } | undefined;
}

/**
 * 按 `index.ts` 的方式把适配器接到池上（顺序与注入点保持一致），返回可断言的三件套。
 * 这是本文件的核心辅助：它让「分类上报 → 池相位 → 下次选 key」形成真实闭环，
 * 而不是把两端各自 mock 掉。
 */
function wire(options: WireOptions) {
  const keys = options.keys ?? ['k1', 'k2', 'k3'];
  const used: string[] = [];

  const keyPool = new SensenovaKeyPool({
    params: () => ({ ...DEFAULT_KEY_POOL_PARAMS, ...options.params }),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const gate = new KeyedConcurrencyGate();

  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: keys.length, quotaRotation: true }),
    resolveApiKey: async (_connection, hint) => {
      keyPool.seed(keys);
      return keyPool.pickStart(hint?.preferredKey) ?? keys[0] ?? '';
    },
    rotateApiKey: async (rejected, rejection, exclude) => {
      if (rejection === 'invalid-credential') keyPool.remove(rejected);
      return keyPool.pickNext(exclude ?? new Set<string>());
    },
    reportRateLimit: (key, kind) => {
      if (kind !== 'tpm') {
        const state = keyPool.snapshot();
        return { kicked: false, running: state.running.length, blocked: state.blocked.length };
      }
      const { kicked } = keyPool.recordTpmStrike(key);
      const state = keyPool.snapshot();
      return { kicked, running: state.running.length, blocked: state.blocked.length };
    },
    reportSuccess: (key) => keyPool.onSuccess(key),
    ...(options.errorLog !== undefined ? { errorLog: options.errorLog } : {}),
    ...(options.describeKey !== undefined ? { describeKey: options.describeKey } : {}),
    concurrencyGate: gate,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      used.push(key);
      return options.respond(key);
    }) as typeof fetch,
  });

  /** 跑一轮，断言它以 RATE_LIMIT 收尾（全 429 场景）。 */
  const round = async (): Promise<void> => {
    await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
      assert.equal((err as LlmError).code, 'RATE_LIMIT');
      return true;
    });
  };

  return { adapter, keyPool, gate, used, keys, round };
}

test('连续 2 次 tpm ⇒ 踢出运行态，且踢出发生在达阈值的那一轮内', async () => {
  const { keyPool, used, round } = wire({ respond: () => tpm429() });

  // 第 1 轮：每把各命中 1 次，均未达阈值。
  await round();
  assert.deepEqual(used, ['k1', 'k2', 'k3'], '第 1 轮完整轮换 3 把');
  assert.equal(keyPool.snapshot().running.length, 3, '第 1 轮无人被踢');
  assert.deepEqual(keyPool.snapshot().blocked, [], '阻塞态仍为空');

  // 第 2 轮：每把都达阈值 2 ⇒ 踢 2 把；保底留 1 把。本轮仍把 3 把都试了一遍。
  used.length = 0;
  await round();
  assert.deepEqual(used, ['k1', 'k2', 'k3'], '踢出不改变本轮的尝试序列');
  const snap = keyPool.snapshot();
  assert.equal(snap.running.length, 1, '踢掉 2 把，保底留 1 把');
  assert.equal(snap.blocked.length, 2, '2 把进阻塞态');
});

test('rpm 连打 5 轮不踢任何 key（只记不踢）—— 覆盖旧实现误判的那个分支', async () => {
  // 阈值设成 1（最敏感）仍然不该踢：rpm 类根本不进入踢出判定。
  const { keyPool, round } = wire({ respond: () => rpm429(), params: { kickThreshold: 1 } });
  for (let i = 0; i < 5; i += 1) await round();

  assert.deepEqual(keyPool.snapshot().blocked, [], 'rpm 类永远不踢');
  assert.equal(keyPool.snapshot().running.length, 3, '运行态完好无损');
});

test('rate（code 8）连打 5 轮同样不踢', async () => {
  const { keyPool, round } = wire({ respond: () => response429('8'), params: { kickThreshold: 1 } });
  for (let i = 0; i < 5; i += 1) await round();
  assert.deepEqual(keyPool.snapshot().blocked, [], 'rate 类永远不踢');
});

test('运行态候选被 exclude 排空 ⇒ 借用阻塞最久的一把，且不改其相位', async () => {
  const { keyPool, used, round } = wire({ respond: () => tpm429(), params: { kickThreshold: 1 } });

  // 第 1 轮：阈值 1 ⇒ k1、k2 命中即踢，k3 因保底留下。
  await round();
  assert.deepEqual(keyPool.snapshot().running, ['k3'], '运行态只剩保底那把');
  assert.deepEqual(keyPool.snapshot().blocked.map(entry => entry.key), ['k1', 'k2'], 'k1 先阻塞');

  // 第 2 轮：起始 k3（运行态唯一）被 exclude ⇒ 借用阻塞最久的 k1 ⇒ 再借用 k2。
  used.length = 0;
  await round();
  assert.deepEqual(used, ['k3', 'k1', 'k2'], '按「阻塞最久」顺序借用');
  assert.deepEqual(
    keyPool.snapshot().blocked.map(entry => entry.key),
    ['k1', 'k2'],
    '借用不改变相位：两把仍在阻塞态，去留由探测决定',
  );
});

test('保底：只剩 1 把 key 时无论命中多少次都不踢（请求永远发得出去）', async () => {
  const { keyPool, used, round } = wire({ keys: ['only'], respond: () => tpm429() });
  for (let i = 0; i < 4; i += 1) await round();

  assert.deepEqual(keyPool.snapshot().running, ['only'], '最后一把永不被踢');
  assert.deepEqual(keyPool.snapshot().blocked, [], '它不会进阻塞态');
  assert.deepEqual(used, ['only', 'only', 'only', 'only'], '每轮都把请求发了出去');
});

test('agent 请求 2xx ⇒ 池收到成功上报，该 key 的连续命中计数被清零', async () => {
  const { adapter, keyPool } = wire({ respond: () => sseOk() });

  // 制造「k1 已命中 1 次」的前置状态（阈值 2 ⇒ 尚未被踢）。
  keyPool.seed(['k1', 'k2', 'k3']);
  keyPool.recordTpmStrike('k1');
  assert.equal(keyPool.isRunning('k1'), true, '命中 1 次不足以踢出');

  const chunks = await collect(adapter, OPTIONS);
  assert.ok(chunks.length > 0, '成功路径应产出 chunk');

  // 成功把计数清零 ⇒ 再命中一次只算「第 1 次」，不该被踢。
  const again = keyPool.recordTpmStrike('k1');
  assert.equal(again.kicked, false, '计数已清零 ⇒ 本次只是第 1 次命中');
  assert.equal(keyPool.isRunning('k1'), true);
});

test('探测成功 ⇒ 该 key 挂回运行态末尾', async () => {
  let clock = 1_000_000;
  const now = (): number => clock;
  const { keyPool, gate, round } = wire({
    respond: () => tpm429(),
    params: { kickThreshold: 1 },
    now,
  });

  await round(); // k1、k2 进阻塞态（k3 保底）
  assert.deepEqual(keyPool.snapshot().blocked.map(entry => entry.key), ['k1', 'k2']);

  const scheduler = createProbeScheduler({
    keyPool,
    gate,
    apiBase: () => CONNECTION.apiBase,
    concurrency: () => 3,
    now,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      return key === 'k1' ? sseOk() : tpm429();
    }) as typeof fetch,
    model: 'deepseek-flash',
    timeoutMs: 100,
  });

  clock += 15_000; // 让 k1 的首次探测到期
  assert.equal(await scheduler.tick(), true, '到期的 k1 应被探测');
  assert.equal(keyPool.isRunning('k1'), true, '探测成功 ⇒ 挂回运行态');
  assert.deepEqual(keyPool.snapshot().running, ['k3', 'k1'], '挂回**末尾**');
  assert.deepEqual(keyPool.snapshot().blocked.map(entry => entry.key), ['k2'], 'k2 仍在阻塞态');
});

test('探测未到期不探测；失败一次后退避到 30s', async () => {
  let clock = 2_000_000;
  const now = (): number => clock;
  // ⚠️ 只用 2 把 key：阈值 1 ⇒ k1 进阻塞态、k2 保底留下。
  // 必须让阻塞态**只有一把**，否则「每 tick 至多探测一把」的语义会让后续断言
  // 分不清「退避生效」与「这一轮换成了探测下一把」。
  const { keyPool, gate, round } = wire({
    keys: ['k1', 'k2'],
    respond: () => tpm429(),
    params: { kickThreshold: 1, probeInitialMs: 15_000 },
    now,
  });
  await round();
  assert.deepEqual(keyPool.snapshot().blocked.map(entry => entry.key), ['k1'], '阻塞态只有 k1');

  let probes = 0;
  const scheduler = createProbeScheduler({
    keyPool,
    gate,
    apiBase: () => CONNECTION.apiBase,
    concurrency: () => 3,
    now,
    fetchImpl: (async () => {
      probes += 1;
      return tpm429(); // 一直未恢复
    }) as typeof fetch,
    model: 'deepseek-flash',
    timeoutMs: 100,
  });

  assert.equal(await scheduler.tick(), false, '未到期 ⇒ 不发探测');
  assert.equal(probes, 0);

  clock += 15_000;
  assert.equal(await scheduler.tick(), true, '到期 ⇒ 探测一次');
  assert.equal(probes, 1);

  const entry = keyPool.blockedEntries()[0];
  assert.ok(entry !== undefined);
  assert.equal(keyPool.probeIntervalMs(entry), 30_000, '失败一次 ⇒ 退避到 30s');

  clock += 10_000;
  assert.equal(await scheduler.tick(), false, '退避期内不探测');
  assert.equal(probes, 1, '没有多余请求');
});

test('探测时该 key 上有 agent 请求在飞 ⇒ 跳过本次（避免结论被污染）', async () => {
  let clock = 3_000_000;
  const now = (): number => clock;
  // 同样让阻塞态只有一把，断言才不会被「另一把到期」干扰。
  const { keyPool, gate, round } = wire({
    keys: ['k1', 'k2'],
    respond: () => tpm429(),
    params: { kickThreshold: 1, probeInitialMs: 15_000 },
    now,
  });
  await round();

  const blocked = keyPool.blockedEntries();
  assert.equal(blocked.length, 1, '阻塞态只有一把 key');
  const target = blocked[0];
  assert.ok(target !== undefined);
  // 占满该 key 的并发额度（`concurrency` 传 1 ⇒ 一个在飞请求就够）。
  const release = gate.tryAcquire(target.key, 1);
  assert.ok(release !== undefined, '应能拿到额度');

  let probes = 0;
  const scheduler = createProbeScheduler({
    keyPool,
    gate,
    apiBase: () => CONNECTION.apiBase,
    concurrency: () => 1,
    now,
    fetchImpl: (async () => {
      probes += 1;
      return sseOk();
    }) as typeof fetch,
    model: 'deepseek-flash',
    timeoutMs: 100,
  });

  clock += 15_000;
  assert.equal(await scheduler.tick(), false, '该 key 被占用 ⇒ 跳过');
  assert.equal(probes, 0, '没有发出探测请求');

  release();
  assert.equal(await scheduler.tick(), true, '释放后即可探测');
  assert.equal(probes, 1);
});

test('池级共享：一个会话踢掉的 key，对另一个会话同样不可选', async () => {
  const { adapter, keyPool } = wire({ respond: () => tpm429(), params: { kickThreshold: 1 } });

  const sessionA: GenerateOptions = { ...OPTIONS, sessionId: 'session-a' as never };
  await assert.rejects(collect(adapter, sessionA));

  assert.equal(keyPool.isRunning('k1'), false, '会话 A 把 k1 踢进了阻塞态');
  assert.deepEqual(keyPool.snapshot().running, ['k3'], '阈值 1 ⇒ k1、k2 都被踢，k3 保底留下');

  // 关键：池是**池级共享**的 —— 会话 B 即便从未发过请求，也看不到 k1 / k2。
  assert.equal(keyPool.pickStart(), 'k3', '会话 B 的起始落在运行态里剩下的那把');
});

test('限流事件带 kicked 与池两态把数（取代已移除的 saturated）', async () => {
  const events: SenseNovaRateLimitEvent[] = [];
  const { round } = wire({
    respond: () => tpm429(),
    params: { kickThreshold: 1 },
    errorLog: () => ({
      record: (event: SenseNovaRateLimitEvent) => { events.push(event); },
    }) as unknown as SenseNovaErrorLog,
  });

  await round();

  assert.ok(events.length >= 1, '应产生限流事件');
  const first = events[0];
  assert.ok(first !== undefined);
  assert.equal(first.kicked, true, '阈值 1 且运行态 >1 ⇒ 首个事件即被踢');
  assert.equal(typeof first.poolRunning, 'number', '带运行态把数');
  assert.equal(typeof first.poolBlocked, 'number', '带阻塞态把数');
  assert.equal('saturated' in first, false, '已移除的 saturated 不再写入');
});

test('rpm / rate 事件写了 kicked:false 且池两态不变（只记不踢）', async () => {
  const events: SenseNovaRateLimitEvent[] = [];
  const { round } = wire({
    respond: () => rpm429(),
    params: { kickThreshold: 1 },
    errorLog: () => ({
      record: (event: SenseNovaRateLimitEvent) => { events.push(event); },
    }) as unknown as SenseNovaErrorLog,
  });

  await round();

  assert.ok(events.length >= 1);
  for (const event of events) {
    assert.equal(event.kicked, false, 'rpm 类永不踢');
    assert.equal(event.poolBlocked, 0, '阻塞态始终为空');
  }
});

test('限流事件带可读的 accountLabel 与 accountRef（面板新增的两列）', async () => {
  const events: SenseNovaRateLimitEvent[] = [];
  const { round } = wire({
    keys: ['k1', 'k2'],
    respond: () => tpm429(),
    errorLog: () => ({
      record: (event: SenseNovaRateLimitEvent) => { events.push(event); },
    }) as unknown as SenseNovaErrorLog,
    describeKey: (key) => (key === 'k1' ? { label: '账户 2', ref: 'SENSENOVA_API_KEY_2' } : undefined),
  });

  await round();

  const described = events.find(event => event.accountLabel !== undefined);
  assert.ok(described !== undefined, 'k1 的事件应带可读账户名');
  assert.equal(described.accountLabel, '账户 2');
  assert.equal(described.accountRef, 'SENSENOVA_API_KEY_2');
  // 指纹仍在：与可读名互补（去重/关联 vs 人读）。
  assert.equal(typeof described.account, 'string');
  assert.notEqual(described.account, '');
  // 🔴 脱敏不变量：事件里绝不含 key 原文。
  assert.equal(JSON.stringify(events).includes('k1'), false, '事件里不得出现 key 原文');
});
