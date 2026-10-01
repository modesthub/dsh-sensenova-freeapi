/**
 * 429 退避治理的回归测试（2026-09-24）。
 *
 * 背景：2026-09-24 单会话实测 112 分钟 / 259 条 429，其中 `120000`（2 分钟）档占 60%
 * （9-18 同期仅 0.6%），且从 10:31 起锁死在顶档直到结束、期间零成功。三个修复点：
 *
 *   A. `RateLimitExceeded.EndpointRPMExceeded` 被 message 兜底误判成 TPM 类
 *      ⇒ 请求数限流（秒级窗口）吃到了 token 限流的 120s 档（实测 37 条）；
 *   B. 全池饱和时仍每轮把所有 key 试一遍 ⇒ 177/259 条 429 是注定失败的轮换请求；
 *   C. 限流事件缺 `probeHits` / `saturated`，无法分辨"高档等待"与"档位锁死"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  RPM_PROBE_BACKOFF_STEPS_MS,
  SensenovaAdapter,
  TPM_PROBE_BACKOFF_STEPS_MS,
  classify429Body,
  type SensenovaConnection,
} from '../src/adapter.ts';
import type { SenseNovaErrorLog, SenseNovaRateLimitEvent } from '../src/error-log.ts';

const CONNECTION: SensenovaConnection = { apiBase: 'https://example.invalid', accountCount: 3 };

const OPTIONS: GenerateOptions = { provider: 'sensenova', model: 'deepseek-flash', messages: [] };

/** 商汤 429 的统一 message —— 关键点：它**同时**含 "tpm" 与 "rpm"，正则无法区分。 */
const RATE_MESSAGE = 'inference exceeds tpm/rpm limit';

function response429(code: string | number): Response {
  return new Response(JSON.stringify({ error: { code, message: RATE_MESSAGE } }), { status: 429 });
}

/** v4.1 (deepseek-flash) 实测出现的请求数限流 code。 */
const rpm429 = (): Response => response429('RateLimitExceeded.EndpointRPMExceeded');
/** v4.1 实测出现的 token 限流 code。 */
const tpm429 = (): Response => response429('RateLimitExceeded.EndpointTPMExceeded');

async function collect(adapter: SensenovaAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

/** 断言 providerRetryAfterMs 落在「档位下限 + ≤30% 单向上抖」区间内。 */
function assertFloor(actual: number | undefined, floorMs: number, label: string): void {
  assert.ok(actual !== undefined, `${label}: providerRetryAfterMs 应存在`);
  const value = actual as number;
  assert.ok(
    value >= floorMs && value <= Math.ceil(floorMs * 1.3),
    `${label}: 期望 [${floorMs}, ${Math.ceil(floorMs * 1.3)}]，实际 ${value}`,
  );
}

/** 收集限流事件的假记录器。 */
function collectingErrorLog(): { events: SenseNovaRateLimitEvent[]; thunk: () => SenseNovaErrorLog } {
  const events: SenseNovaRateLimitEvent[] = [];
  const fake = { record: (event: SenseNovaRateLimitEvent) => { events.push(event); } };
  return { events, thunk: () => fake as unknown as SenseNovaErrorLog };
}

// ── 修复 A：分类 ────────────────────────────────────────────────────────────

test('A: EndpointRPMExceeded 归为 rpm 类，不再被同一句 message 兜底成 tpm', () => {
  const body = JSON.stringify({ error: { code: 'RateLimitExceeded.EndpointRPMExceeded', message: RATE_MESSAGE } });
  const result = classify429Body(body);
  assert.equal(result.kind, 'rpm');
  assert.equal(result.quota, true);
  assert.equal(result.retryFloorMs, RPM_PROBE_BACKOFF_STEPS_MS[0]);
});

test('A: EndpointTPMExceeded 仍归 tpm 类（rpm 匹配不能误伤 "Tpm"）', () => {
  const body = JSON.stringify({ error: { code: 'RateLimitExceeded.EndpointTPMExceeded', message: RATE_MESSAGE } });
  assert.equal(classify429Body(body).kind, 'tpm');
});

test('A: ModelAccount{Rpm,Tpm}RateLimitExceeded 按语义分别归类', () => {
  const rpm = JSON.stringify({ error: { code: 'ModelAccountRpmRateLimitExceeded', message: RATE_MESSAGE } });
  const tpm = JSON.stringify({ error: { code: 'ModelAccountTpmRateLimitExceeded', message: RATE_MESSAGE } });
  assert.equal(classify429Body(rpm).kind, 'rpm');
  assert.equal(classify429Body(tpm).kind, 'tpm');
});

test('A: 既有分类不被破坏（code 8 仍是 rate + 15s；未知 code 仍保底 tpm）', () => {
  assert.equal(classify429Body(JSON.stringify({ error: { code: 8, message: 'rpm exhausted' } })).kind, 'rate');
  assert.equal(classify429Body(JSON.stringify({ error: { code: 429003, message: RATE_MESSAGE } })).kind, 'tpm');
  // 无 code、message 含限流措辞 ⇒ 保底 tpm（保守长退避）。
  assert.equal(classify429Body(JSON.stringify({ error: { message: 'some rate limit hit' } })).kind, 'tpm');
  // 非 JSON 体 ⇒ 保底 tpm。
  assert.equal(classify429Body('<html>429</html>').kind, 'tpm');
});

test('A: RPM 独立档位推进，且不污染 TPM 档位', async () => {
  let mode: 'rpm' | 'tpm' = 'rpm';
  const adapter = new SensenovaAdapter({
    // accountCount 1 + 不轮换：每轮只发一个请求，便于把「轮」与「档位」一一对应。
    options: () => ({ ...CONNECTION, accountCount: 1 }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => (mode === 'rpm' ? rpm429() : tpm429())) as typeof fetch,
  });

  const floorOf = async (): Promise<number> => {
    let captured = 0;
    await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
      captured = (err as LlmError).failure.providerRetryAfterMs ?? 0;
      return true;
    });
    return captured;
  };

  assertFloor(await floorOf(), RPM_PROBE_BACKOFF_STEPS_MS[0], 'rpm 第 1 轮');
  assertFloor(await floorOf(), RPM_PROBE_BACKOFF_STEPS_MS[1], 'rpm 第 2 轮');
  assertFloor(await floorOf(), RPM_PROBE_BACKOFF_STEPS_MS[2], 'rpm 第 3 轮');

  // 切到 TPM：若两类计数混用，这里会是第 4 档（15000）而不是首档。
  mode = 'tpm';
  assertFloor(await floorOf(), TPM_PROBE_BACKOFF_STEPS_MS[0], 'TPM 首次（未被 RPM 计数污染）');
});

test('A: RPM 档位封顶 30s —— 秒级窗口不该吃到 TPM 的 120s', async () => {
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 1 }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => rpm429()) as typeof fetch,
  });
  const top = RPM_PROBE_BACKOFF_STEPS_MS[RPM_PROBE_BACKOFF_STEPS_MS.length - 1];
  assert.equal(top, 30_000, 'RPM 档位上限（回归护栏：若有人改成 120s 会在这里失败）');

  const floorOf = async (): Promise<number> => {
    let captured = 0;
    await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
      captured = (err as LlmError).failure.providerRetryAfterMs ?? 0;
      return true;
    });
    return captured;
  };

  // 前 length 轮逐档爬升，之后全部封顶在 top（不会再往上走到 TPM 的 60/120s）。
  for (let i = 0; i < RPM_PROBE_BACKOFF_STEPS_MS.length; i += 1) {
    assertFloor(await floorOf(), RPM_PROBE_BACKOFF_STEPS_MS[i], `rpm 第 ${i + 1} 轮`);
  }
  for (let i = 0; i < 3; i += 1) {
    assertFloor(await floorOf(), top, `rpm 封顶后第 ${i + 1} 轮`);
  }
});

// ── 修复 B：key 轮换不再被短路抑制（2026-09-27 重写）────────────────────────
//
// 原「全池饱和短路」已整体移除（判据 `atTopFloor` 把 RPM 顶档与 TPM 顶档等价，导致纯
// RPM 限流第 5 轮就永久停止轮换，并因「计数只在 2xx 清零」构成不可自解的死锁）。
// 其职能改由 `key-pool.ts` 的运行态/阻塞态双列表接管 —— 相关行为在
// `tests/key-pool.test.ts` 与 `tests/key-pool-adapter.test.ts` 覆盖。
//
// 这里保留的是**回归护栏**：确认「轮换不再被任何全局标志抑制」。

test('B: 短路已移除 —— 档位爬到顶后仍每轮完整轮换（不再有 1 请求的短路段）', async () => {
  let callsInRound = 0;
  const perRound: number[] = [];
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 3, quotaRotation: true }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected: string) => {
      if (rejected === 'key-1') return 'key-2';
      if (rejected === 'key-2') return 'key-3';
      return undefined;
    },
    fetchImpl: (async () => {
      callsInRound += 1;
      return tpm429();
    }) as typeof fetch,
  });

  const runRound = async (): Promise<void> => {
    callsInRound = 0;
    await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
      assert.equal((err as LlmError).code, 'RATE_LIMIT');
      return true;
    });
    perRound.push(callsInRound);
  };

  // 跑过「档位爬升到顶」所需轮数再多跑几轮 —— 旧实现在这个区间会切成每轮 1 个请求
  // （实测轨迹 `[3,3,3,3,1,1,1,1,3,1,1,1]`）。
  const roundsToTop = TPM_PROBE_BACKOFF_STEPS_MS.length - 1;
  const total = roundsToTop + 6;
  for (let i = 0; i < total; i += 1) await runRound();

  assert.deepEqual(
    perRound,
    Array.from({ length: total }, () => 3),
    '每一轮都完整试 3 把：没有任何「每轮 1 个请求」的短路段',
  );
});

test('B: 401 永远走完整轮换（凭证问题与配额无关，不受任何池状态影响）', async () => {
  let round = 0;
  const used: string[] = [];
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2, quotaRotation: true }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected: string) => (rejected === 'key-1' ? 'key-2' : undefined),
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      used.push(key);
      round += 1;
      // 先连续 TPM 429 把档位推到顶（旧实现在此会进入饱和并短路轮换）。
      if (round <= 10) return tpm429();
      // 之后改成 401：凭证问题与配额无关，必须继续完整轮换 key。
      return new Response(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad key' } }), { status: 401 });
    }) as typeof fetch,
  });

  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(collect(adapter, OPTIONS));
  }
  used.length = 0;
  await assert.rejects(collect(adapter, OPTIONS));
  assert.deepEqual(used, ['key-1', 'key-2'], '档位顶档后 401 仍走完整轮换');
});

// ── 修复 C：事件字段 ─────────────────────────────────────────────────────────

test('C: 限流事件带 probeHits 与 saturated，可分辨"高档等待"与"档位锁死"', async () => {
  const log = collectingErrorLog();
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 1 }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    errorLog: log.thunk,
    fetchImpl: (async () => tpm429()) as typeof fetch,
  });

  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(collect(adapter, OPTIONS));
  }

  assert.ok(log.events.length >= 3, '应有 3 条限流事件');
  const first = log.events[0] as SenseNovaRateLimitEvent;
  assert.equal(first.kind, 'tpm');
  assert.equal(first.probeHits, 0, '第 1 轮档位索引 0');
  assert.equal(log.events[1]?.probeHits, 1, '第 2 轮档位索引 1');
  assert.equal(log.events[2]?.probeHits, 2, '第 3 轮档位索引 2');
  // 🔴 2026-09-27：`saturated` 字段已随饱和机制移除。池侧诊断改为
  // `kicked` / `poolRunning` / `poolBlocked`，它们需要注入池才会产出 ⇒ 由
  // `tests/key-pool-adapter.test.ts` 覆盖。这里只护栏「旧字段不再写入」。
  assert.equal('saturated' in first, false, '已移除的 saturated 不再写入事件');
});

test('C: rpm 事件的 probeHits 取 RPM 序列（不与 TPM 混算）', async () => {
  const log = collectingErrorLog();
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 1 }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    errorLog: log.thunk,
    fetchImpl: (async () => rpm429()) as typeof fetch,
  });
  await assert.rejects(collect(adapter, OPTIONS));
  const event = log.events[0] as SenseNovaRateLimitEvent;
  assert.equal(event.kind, 'rpm');
  assert.equal(event.probeHits, 0);
  assert.equal(event.retryFloorMs, RPM_PROBE_BACKOFF_STEPS_MS[0]);
});
