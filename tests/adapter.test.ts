import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SensenovaAdapter, QUOTA_RETRY_AFTER_CEILING_MS, TPM_PROBE_BACKOFF_STEPS_MS, type SensenovaConnection } from '../src/adapter.ts';
import { KeyedConcurrencyGate } from '../src/concurrency.ts';
import { fingerprint, type SenseNovaErrorLog, type SenseNovaRateLimitEvent } from '../src/error-log.ts';
import { resolveAdapterOptions } from '../src/index.ts';

const CONNECTION: SensenovaConnection = { apiBase: 'https://example.invalid', accountCount: 2 };

function sseResponse(sseText: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseText));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * 断言 providerRetryAfterMs 落在「档位下限 + 单向上抖（0~30%）」区间内。
 *
 * 2026-09-16 修订（缺陷 F）：宿主 llm-retry 会**原样采信** providerRetryAfterMs
 * （`packages/llm/llm-retry/src/index.ts:234`），把 localDelay 的指数退避与 jitterRatio
 * 全部旁路——多会话同时被限流时会以完全相同的间隔重试（惊群）。因此 provider 侧对
 * 「档位下限主导」的退避加 0~30% 单向上抖：只增不减，保证不早于服务端窗口。
 * 网关显式给出的 Retry-After（≥ 档位下限时）属服务端指令，不抖动、按原值透传。
 */
function assertRetryFloor(actual: number | undefined, floorMs: number, label?: string): void {
  const name = label ?? 'providerRetryAfterMs';
  assert.ok(actual !== undefined, `${name} 应存在`);
  const value = actual as number;
  const upper = Math.ceil(floorMs * 1.3);
  assert.ok(
    value >= floorMs && value <= upper,
    `${name}: 期望落在 [${floorMs}, ${upper}]（档位下限 + ≤30% 单向上抖），实际 ${value}`,
  );
}

/** 用固定目录响应构造适配器；models 端点返回给定 data 数组。 */
function catalogAdapter(data: unknown[], modelSelection?: SensenovaConnection['modelSelection']): SensenovaAdapter {
  const body = JSON.stringify({ data });
  const connection: SensenovaConnection = { ...CONNECTION, ...(modelSelection !== undefined ? { modelSelection } : {}) };
  return new SensenovaAdapter({
    options: () => connection,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch,
  });
}

/** 用可编程 chat 端点构造适配器（用于 404/429 断言）。 */
function chatAdapter(handler: (call: number) => Response | Promise<Response>): {
  adapter: SensenovaAdapter;
  calls: () => number;
  rotateCalls: Array<{ rejected: string; rejection: string; retryAfterMs?: number }>;
} {
  let calls = 0;
  const rotateCalls: Array<{ rejected: string; rejection: string; retryAfterMs?: number }> = [];
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection, retryAfterMs) => {
      rotateCalls.push({ rejected, rejection, retryAfterMs });
      return 'key-2';
    },
    fetchImpl: (async () => {
      calls += 1;
      return handler(calls);
    }) as typeof fetch,
  });
  return { adapter, calls: () => calls, rotateCalls };
}

const FIXED_SSE = [
  'data: {"id":"1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const OPTIONS: GenerateOptions = {
  provider: 'sensenova',
  model: 'test-model',
  messages: [],
};

async function collect(adapter: SensenovaAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}

test('stream: 把 OpenAI SSE 翻译为 block-start/text-delta/block-end/usage/finish', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => sseResponse(FIXED_SSE)) as typeof fetch,
  });

  const chunks = await collect(adapter, OPTIONS);

  assert.deepEqual(chunks.map((c) => c.type), [
    'block-start',
    'text-delta',
    'text-delta',
    'block-end',
    'usage',
    'finish',
  ]);

  const start = chunks[0];
  assert.ok(start && start.type === 'block-start');
  assert.equal(start.blockType, 'text');

  const delta1 = chunks[1];
  const delta2 = chunks[2];
  assert.ok(delta1 && delta1.type === 'text-delta');
  assert.ok(delta2 && delta2.type === 'text-delta');
  assert.equal(delta1.text + delta2.text, 'Hello world');

  const end = chunks[3];
  assert.ok(end && end.type === 'block-end');
  assert.ok(end.block.type === 'text');
  assert.equal(end.block.text, 'Hello world');

  const usage = chunks[4];
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.usage.inputTokens, 10);
  assert.equal(usage.usage.outputTokens, 5);
  assert.equal(usage.usage.totalTokens, 15);

  const finish = chunks[5];
  assert.ok(finish && finish.type === 'finish');
  assert.deepEqual(finish.reason, { kind: 'stop' });
});

test('stream: finish 后 trailing usage-only SSE 不丢 usage 且不重复 finish', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null]}]',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: {"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  const usage = chunks.find((chunk) => chunk.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.usage.totalTokens, 6);
});

test('stream: usage-before-finish 在 finish 时发出且仅发出一次', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.equal(chunks.filter((chunk) => chunk.type === 'usage').length, 1);
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  const usage = chunks.find((chunk) => chunk.type === 'usage');
  assert.ok(usage && usage.type === 'usage');
  assert.equal(usage.usage.totalTokens, 4);
});

test('stream: 同一 SSE 事件多个 choices finish 只输出一个 finish', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"},{"delta":{"content":"ignored"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'))) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1);
  const text = chunks.find((chunk) => chunk.type === 'text-delta');
  assert.ok(text && text.type === 'text-delta');
  assert.equal(text.text, 'ok');
});

test('stream: 429 不轮换 key，直接抛 RATE_LIMIT 交宿主退避重试', async () => {
  let calls = 0;
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      return 'key-2';
    },
    fetchImpl: (async () => {
      calls += 1;
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
    }) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    // 非配额类（非 JSON 体）：30s 在 60000ms 透传上限内，原样透传 providerRetryAfterMs
    // （fix-sensenova-429-quota-retry：上限从 3000ms 提升到 60000ms，对齐 TPM 窗口量级）。
    assert.equal(e.failure.providerRetryAfterMs, 30_000);
    return true;
  });
  assert.equal(calls, 1, '只请求一次，不换 key 重试（保护 prompt 缓存）');
  assert.equal(rotateCalls.length, 0, '429 不触发账号轮换/冷却');
});

test('stream: 401 全部失败抛 INVALID_CREDENTIAL', async () => {
  let rotateCount = 0;
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => {
      rotateCount += 1;
      return rotateCount === 1 ? 'key-2' : undefined;
    },
    fetchImpl: (async () => new Response('unauthorized', { status: 401 })) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    return (err as LlmError).code === 'INVALID_CREDENTIAL';
  });
});

test('listModels: 过滤文生图模型与已知 stale 模型，保留文本模型', async () => {
  const adapter = catalogAdapter([
    { id: 'sensenova-6.8-flash-lite', output_modalities: ['text'], input_modalities: ['text'] },
    { id: 'sensenova-u1-fast', output_modalities: ['image'], input_modalities: ['text'] },
    { id: 'sensenova-u1.5-lite', output_modalities: ['image'] },
    { id: 'sensenova-6.7-flash-lite', output_modalities: ['text'], input_modalities: ['text'] },
    { id: 'sensenova-6.8-pro', output_modalities: ['text', 'image'], input_modalities: ['text', 'image'] },
  ]);

  const models = await adapter.listModels('sensenova');
  const ids = models.map((m) => m.id).sort();

  assert.deepEqual(ids, ['sensenova-6.8-flash-lite', 'sensenova-6.8-pro']);
});

test('listModels: 手动 include 可恢复 stale，但 exclude 优先且 image-only 永远排除', async () => {
  const adapter = catalogAdapter([
    { id: 'sensenova-6.7-flash-lite', output_modalities: ['text'], input_modalities: ['text'], context_length: 65536 },
    { id: 'sensenova-u1-fast', output_modalities: ['image'], input_modalities: ['text'] },
    { id: 'sensenova-ok', output_modalities: ['text'], input_modalities: ['text'] },
  ], {
    include: [' sensenova-6.7-flash-lite ', 'sensenova-u1-fast', 'unknown-id'],
    exclude: ['sensenova-ok', 'sensenova-6.7-flash-lite'],
  });
  const models = await adapter.listModels('sensenova');
  assert.deepEqual(models.map((model) => model.id), []);

  const restored = catalogAdapter([
    { id: 'sensenova-6.7-flash-lite', output_modalities: ['text'], input_modalities: ['text'], context_length: 65536 },
    { id: 'sensenova-u1-fast', output_modalities: ['image'] },
  ], { include: ['sensenova-6.7-flash-lite', 'sensenova-u1-fast'] });
  const restoredModels = await restored.listModels('sensenova');
  assert.deepEqual(restoredModels.map((model) => model.id), ['sensenova-6.7-flash-lite']);
  const resolved = await restored.resolveModel('sensenova', 'sensenova-6.7-flash-lite');
  assert.equal(resolved.context?.contextWindow, 65536);
});

test('listModels: 未出现在最新目录中的手动 include 不合成条目，刷新继续应用配置', async () => {
  let phase = 0;
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, modelSelection: { include: ['sensenova-stale'], exclude: [] } }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => {
      phase += 1;
      const data = phase === 1
        ? [{ id: 'sensenova-stale', output_modalities: ['text'], context_length: 123 }]
        : [{ id: 'sensenova-ok', output_modalities: ['text'], context_length: 456 }];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as typeof fetch,
  });
  assert.deepEqual((await adapter.listModels('sensenova')).map((model) => model.id), ['sensenova-stale']);
  assert.deepEqual((await adapter.listModels('sensenova')).map((model) => model.id), ['sensenova-ok']);
});

test('resolveAdapterOptions: 非法 credential-ref 不保留原文且不作为字面 key', () => {
  const resolved = resolveAdapterOptions({
    apiKeyEnv: 'invalid credential input',
    accounts: [{ id: 'extra', label: 'Extra', apiKeyEnv: 'not-a-credential-ref' }],
  });
  assert.equal(resolved.accounts[0]?.isLiteral, false);
  assert.equal(resolved.accounts[0]?.ref, '');
  assert.equal(resolved.accounts[1]?.isLiteral, false);
  assert.equal(resolved.accounts[1]?.ref, '');

  const valid = resolveAdapterOptions({ apiKeyEnv: 'SENSENOVA_API_KEY' });
  assert.equal(valid.accounts[0]?.isLiteral, false);
  assert.equal(valid.accounts[0]?.ref, 'SENSENOVA_API_KEY');
});

test('resolveAdapterOptions: concurrency 缺省 1，非正整数回退 1', () => {
  assert.equal(resolveAdapterOptions({}).concurrency, 1);
  assert.equal(resolveAdapterOptions({ concurrency: 3 }).concurrency, 3);
  assert.equal(resolveAdapterOptions({ concurrency: 0 }).concurrency, 1);
  assert.equal(resolveAdapterOptions({ concurrency: -1 }).concurrency, 1);
  assert.equal(resolveAdapterOptions({ concurrency: 2.5 }).concurrency, 1);
});

test('listModels: 无 key 时返回空目录不阻塞', async () => { 
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => {
      throw new LlmError('no key', 'MISSING_CREDENTIAL');
    },
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch,
  });
  assert.deepEqual(await adapter.listModels('sensenova'), []);
});

test('listModels/resolveModel: 多模态 input_modalities 与上下文/最大输出', async () => {
  const adapter = catalogAdapter([
    {
      id: 'sensenova-6.8-pro',
      output_modalities: ['text'],
      input_modalities: ['text', 'image'],
      context_length: 262144,
      max_output_tokens: 8192,
    },
  ]);
  await adapter.listModels('sensenova');

  const info = await adapter.resolveModel('sensenova', 'sensenova-6.8-pro');
  assert.deepEqual(info.inputModalities, ['text', 'image']);
  assert.equal(info.context?.contextWindow, 262144);
  assert.equal(info.defaultMaxTokens, 8192);
});

test('listModels/resolveModel: 静态覆盖表压过目录的 max_output_length 占位值', async () => {
  const adapter = catalogAdapter([
    {
      id: 'deepseek-v4-flash',
      output_modalities: ['text'],
      input_modalities: ['text'],
      context_length: 1048576,
      // ⚠️ 2026-09-23 Phase 0 实测：目录的 65536 是**占位值**（9 个模型里 8 个都是它），
      // 会把 v4-flash 的思考预算压掉一半 ⇒ 必须被 MODEL_MAX_OUTPUT_OVERRIDES 覆盖。
      max_output_length: 65536,
    },
  ]);
  await adapter.listModels('sensenova');

  const info = await adapter.resolveModel('sensenova', 'deepseek-v4-flash');
  assert.equal(info.context?.contextWindow, 1048576);
  // 决策规则 min(服务端上限 384000, 131072) = 131072（服务端区间来自 400 报错原文）。
  assert.equal(info.defaultMaxTokens, 131072);
});

test('resolveModel: reasoning 词表映射为 ReasoningEffortId 与默认级别', async () => {
  const adapter = catalogAdapter([
    {
      id: 'sensenova-6.8-pro',
      output_modalities: ['text'],
      input_modalities: ['text'],
      reasoning_efforts: ['low', 'medium', 'high'],
      default_reasoning_effort: 'medium',
    },
  ]);
  await adapter.listModels('sensenova');

  const info = await adapter.resolveModel('sensenova', 'sensenova-6.8-pro');
  const reasoning = info.reasoning;
  assert.ok(reasoning);
  assert.deepEqual(reasoning.efforts.map((e) => e.id), ['low', 'medium', 'high']);
  assert.equal(reasoning.defaultEffort, 'medium');
  // 2026-09-23：name 改为友好文案（不再用裸 wire 值）。id 仍是 wire 原值（透传）。
  assert.equal(reasoning.efforts[0]?.name, 'Low');
});

test('resolveModel: 仅支持标记不虚构 reasoning 级别', async () => {
  const adapter = catalogAdapter([
    {
      id: 'sensenova-6.8-pro',
      output_modalities: ['text'],
      input_modalities: ['text'],
      supported_parameters: ['reasoning_effort'],
      thinking: true,
    },
  ]);
  await adapter.listModels('sensenova');

  const info = await adapter.resolveModel('sensenova', 'sensenova-6.8-pro');
  assert.equal(info.reasoning, undefined);
});

test('resolveModel: 嵌套 reasoning.efforts 词表与目录刷新后能力同步', async () => {
  const adapter = catalogAdapter([
    {
      id: 'sensenova-6.8-pro',
      output_modalities: ['text'],
      input_modalities: ['text'],
      context_window: 65536,
      reasoning: { efforts: ['low', 'high'], default_effort: 'high' },
    },
  ]);
  await adapter.listModels('sensenova');
  let info = await adapter.resolveModel('sensenova', 'sensenova-6.8-pro');
  assert.equal(info.context?.contextWindow, 65536);
  assert.deepEqual(info.reasoning?.efforts.map((e) => e.id), ['low', 'high']);
  assert.equal(info.reasoning?.defaultEffort, 'high');

  // 目录刷新后 context 变化，resolveModel 使用最新值。
  const refreshed = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => new Response(JSON.stringify({
      data: [{
        id: 'sensenova-6.8-pro',
        output_modalities: ['text'],
        input_modalities: ['text'],
        context_length: 131072,
        reasoning: { efforts: ['low'] },
      }],
    }), { status: 200 })) as typeof fetch,
  });
  await refreshed.listModels('sensenova');
  info = await refreshed.resolveModel('sensenova', 'sensenova-6.8-pro');
  assert.equal(info.context?.contextWindow, 131072);
  assert.deepEqual(info.reasoning?.efforts.map((e) => e.id), ['low']);
  assert.equal(info.reasoning?.defaultEffort, undefined);
});

test('listModels: 显示名标准化（flash-lite 显式映射 + 回退规则）', async () => {
  const adapter = catalogAdapter([
    { id: 'sensenova-6.7-flash-lite', output_modalities: ['text'], input_modalities: ['text'] },
    { id: 'sensenova-6.8-flash-lite', output_modalities: ['text'], input_modalities: ['text'] },
  ]);
  // 已知 stale 模型会被过滤，单独断言显式映射通过 resolveModel 兜底路径。
  const known = await adapter.resolveModel('sensenova', 'sensenova-6.7-flash-lite');
  assert.equal(known.name, 'Sensenova 6.7 Flash Lite');

  const models = await adapter.listModels('sensenova');
  const byId = new Map(models.map((m) => [m.id, m.name]));
  // 2026-09-23：DISPLAY_NAME_OVERRIDES 补齐 5 模型，品牌大小写统一为 SenseNova。
  assert.equal(byId.get('sensenova-6.8-flash-lite'), 'SenseNova 6.8 Flash Lite');
});

test('providerRetryPolicy: normal / maxRetries=24 / maxDelayMs=300000（防悬崖不变量）', () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
  });
  const policy = adapter.providerRetryPolicy('sensenova');
  assert.ok(policy);
  assert.equal(policy.mode, 'normal');
  if (policy.mode === 'normal') {
    // fix-sensenova-429-quota-retry：重试预算有限化（1000→10）。
    // 2026-09-16 修订：探测档位加长到 3/5/10/15/30/60/120s（累计约 4 分钟）后，
    // 10 次预算撑不过一个分钟级窗口 → 放宽到 24。
    assert.equal(policy.maxRetries, 24);
    // 🛡️ 防悬崖不变量（2026-09-17）：宿主 llm-retry 的 `pra > maxDelayMs` 分支在
    // normal 模式下是 **return next()（彻底放弃重试）**，不是夹到上限。因此重试
    // 策略的退避上限必须 ≥ 本适配器能吐出的 pra 上限，否则 (maxDelayMs, ceiling]
    // 区间就是死亡区。0917 实测：原值 60000 而 ceiling 300000，
    // `pra=149344` / `pra=61696` 两次恰好落在死亡区，2/2 回合失败。
    // 这条断言是那次回归的护栏 —— 改 maxDelayMs 时必须同时看 ceiling。
    assert.equal(policy.maxDelayMs, 300_000);
    assert.ok(
      policy.maxDelayMs >= QUOTA_RETRY_AFTER_CEILING_MS,
      `maxDelayMs(${policy.maxDelayMs}) 必须 ≥ QUOTA_RETRY_AFTER_CEILING_MS(${QUOTA_RETRY_AFTER_CEILING_MS})，否则会重新引入悬崖死亡区`,
    );
    assert.equal(policy.initialDelayMs, 500);
    // 保留默认 jitterRatio；宿主 localDelay 用 Math.min(..., maxDelayMs) 封顶，
    // 故初始延迟（含最大 jitter 1.1 倍）仍在 maxDelayMs 上限内。
    assert.ok(policy.jitterRatio >= 0 && policy.jitterRatio <= 1);
    assert.ok(policy.initialDelayMs <= policy.maxDelayMs);
    assert.ok(policy.initialDelayMs * (1 + policy.jitterRatio) <= policy.maxDelayMs);
    assert.ok(policy.retryableCodes.includes('RATE_LIMIT'));
  }
});

test('stream: 404 model route not found → MODEL_NOT_FOUND 且不轮换', async () => {
  const { adapter, calls, rotateCalls } = chatAdapter(() =>
    new Response(JSON.stringify({ error: { message: 'model route not found' } }), { status: 404 }),
  );
  const options: GenerateOptions = { provider: 'sensenova', model: 'sensenova-6.7-flash-lite', messages: [] };

  await assert.rejects(collect(adapter, options), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'MODEL_NOT_FOUND');
    assert.equal(e.failure.status, 404);
    return true;
  });
  assert.equal(calls(), 1);
  assert.equal(rotateCalls.length, 0);
});

test('stream: 404 model is not found → MODEL_NOT_FOUND', async () => {
  const { adapter } = chatAdapter(() =>
    new Response(JSON.stringify({ error: { message: 'model is not found' } }), { status: 404 }),
  );
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    return (err as LlmError).code === 'MODEL_NOT_FOUND';
  });
});

test('stream: 非模型 404 保持通用 PROVIDER_HTTP_ERROR', async () => {
  const { adapter } = chatAdapter(() => new Response('not found', { status: 404 }));
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    return (err as LlmError).code === 'PROVIDER_HTTP_ERROR';
  });
});

test('stream: 运行时 404 失败模型写入失败缓存，后续 listModels 剔除', async () => {
  const data = [
    { id: 'sensenova-stale', output_modalities: ['text'], input_modalities: ['text'] },
    { id: 'sensenova-ok', output_modalities: ['text'], input_modalities: ['text'] },
  ];
  let phase = 0;
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/models')) {
        return new Response(JSON.stringify({ data }), { status: 200 });
      }
      // chat 端点：sensenova-stale 返回 404 模型不可路由。
      if (u.endsWith('/chat/completions')) {
        phase += 1;
        return new Response(JSON.stringify({ error: { message: 'model route not found' } }), { status: 404 });
      }
      return new Response('', { status: 500 });
    }) as typeof fetch,
  });

  const before = await adapter.listModels('sensenova');
  assert.ok(before.some((m) => m.id === 'sensenova-stale'));

  const options: GenerateOptions = { provider: 'sensenova', model: 'sensenova-stale', messages: [] };
  await assert.rejects(collect(adapter, options), (err: unknown) => (err as LlmError).code === 'MODEL_NOT_FOUND');

  const after = await adapter.listModels('sensenova');
  assert.ok(!after.some((m) => m.id === 'sensenova-stale'));
  assert.ok(after.some((m) => m.id === 'sensenova-ok'));
});

test('stream: 未知形态 429 按 TPM 类处理，超长 Retry-After 被配额上限封顶', async () => {
  const { adapter, calls, rotateCalls } = chatAdapter(() =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': '900' } }),
  );

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    // 非 JSON body 走保底分支：一律按 TPM 类（floor 3000ms）；Retry-After 900s 被
    // 配额类上限 QUOTA_RETRY_AFTER_CEILING_MS（300s）封顶。
    assert.equal(e.failure.providerRetryAfterMs, 300_000);
    return true;
  });
  // 未开启 quotaRotation：不轮换，账号状态不变。
  assert.equal(calls(), 1);
  assert.equal(rotateCalls.length, 0);
});

test('stream: 429 Retry-After 小于档位下限时取档位下限（3000ms）', async () => {
  const { adapter } = chatAdapter(() =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }),
  );
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    // 未知形态按 TPM 类：退避下限 3000ms 与 Retry-After 2000ms 取较大者，
    // 再叠加 ≤30% 单向上抖（档位下限主导时抖动；服务端指令主导时不抖动）。
    assertRetryFloor(e.failure.providerRetryAfterMs, 3_000, '未知形态退避下限');
    return true;
  });
});

test('stream: 历史中的空 tool_call（name/arguments/id 为空）被清洗，不再回放坏结构', async () => {
  let requestBody: unknown;
  // 用捕获 body 的适配器重放坏历史
  const captureAdapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async (_init: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });
  const options: GenerateOptions = {
    provider: 'sensenova',
    model: 'test-model',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          // 1) name 为空的失败 tool_call（本轮 400 根因）
          { type: 'tool-call', id: '', name: '', arguments: '' },
          // 2) 合法调用但 arguments 为空串、id 为空
          { type: 'tool-call', id: '', name: 'bash', arguments: '' },
        ],
      },
      {
        // 🆕 0.1.7：工具结果是一等消息（`role: 'tool'`），不再嵌在 user content 的
        // `tool-result` 块里。这里同步改用新形状（外层已 `as unknown as` 放宽）。
        role: 'tool',
        toolCallId: '',
        content: [{ type: 'text', text: 'Error: invalid arguments' }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] as unknown as GenerateOptions['messages'],
  };
  await collect(captureAdapter, options);

  const body = requestBody as { messages: Array<Record<string, unknown>> };
  const assistant = body.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)) as Record<string, unknown>;
  assert.ok(assistant, '应保留含合法 tool_call 的 assistant 消息');
  const calls = assistant.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
  assert.equal(calls.length, 1, '空 name 的 tool_call 被丢弃');
  assert.equal(calls[0]?.function.name, 'bash');
  assert.equal(calls[0]?.function.arguments, '{}', '空 arguments 补为 {}');
  assert.match(calls[0]?.id ?? '', /^sensenova-sanitized-/, '空 id 合成稳定 id');
  const toolMsgs = body.messages.filter((m) => m.role === 'tool');
  // 空 toolCallId 的 result 映射到合成 id（两个空 id call 共享 ''，最后一个合法调用占据映射）
  assert.equal(toolMsgs.length, 1);
  assert.equal((toolMsgs[0] as { tool_call_id: string }).tool_call_id, calls[0]?.id);
});

test('stream: SSE 中 name 始终未到达的残缺 tool_call 不产出 block-end', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"tc1","function":{"arguments":"{\\"a\\":1}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const { adapter } = chatAdapter(() => sseResponse(sse));
  const chunks = await collect(adapter, OPTIONS);
  assert.equal(chunks.filter((c) => c.type === 'block-end').length, 0, '无 name 的工具调用不产出 tool-call block');
  assert.equal(chunks.at(-1)?.type, 'finish');
});

// ---- fix-sensenova-reasoning-ui-toolcalls 新增用例 ----

import { BlockAssembler } from '@deepseek-ai/dsh-llm';

/** 把 adapter 输出的 chunk 流经宿主 BlockAssembler 组装，返回最终块列表。 */
async function assembleBlocks(adapter: SensenovaAdapter, options: GenerateOptions): Promise<import('@deepseek-ai/dsh-llm').ContentBlock[]> {
  const assembler = new BlockAssembler();
  for await (const chunk of adapter.stream(options)) assembler.push(chunk);
  return assembler.blocks();
}

test('resolveModel: supported_features 含 reasoning + 静态表命中 → 暴露档位且无 defaultEffort', async () => {
  const adapter = catalogAdapter([
    { id: 'deepseek-v4-flash', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['tools', 'json_mode', 'reasoning'] },
  ]);
  await adapter.listModels('sensenova');
  const info = await adapter.resolveModel('sensenova', 'deepseek-v4-flash');
  const reasoning = info.reasoning;
  assert.ok(reasoning, '静态表命中的 reasoning 模型应暴露档位');
  // 2026-09-23 Phase 0：服务端权威词表 = low/medium/high/xhigh/none（文档写的 max 是错的）。
  // `none` 排首位（对齐官方 Off/Low/High/Max 范式）。
  assert.deepEqual(reasoning.efforts.map((e) => e.id), ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(reasoning.efforts[0]?.name, 'Off');
  assert.ok(
    typeof reasoning.efforts[0]?.description === 'string' && (reasoning.efforts[0]?.description?.length ?? 0) > 0,
    '档位应带说明文案（解决"裸 wire 值 + 末位导致感觉没有开关"）',
  );
  assert.equal(reasoning.defaultEffort, undefined, '静态表不设 defaultEffort，保持网关默认');
});

test('resolveModel: 目录明确排除 reasoning 才隐藏档位（沉默 ≠ 否定）', async () => {
  // 目录条目**没给** supported_features：Phase 0 实测目录 9/9 模型都不给 effort 词表，
  // 部分条目甚至没有 supported_features ⇒ 沉默不能当作「不支持」，
  // 否则冷目录/部分条目下档位选择器会消失。
  const silent = catalogAdapter([
    { id: 'deepseek-v4-flash', output_modalities: ['text'], input_modalities: ['text'] },
  ]);
  await silent.listModels('sensenova');
  const silentInfo = await silent.resolveModel('sensenova', 'deepseek-v4-flash');
  assert.ok(silentInfo.reasoning, '目录沉默时应由静态表兜底出档位');

  // 目录**明确**列出 supported_features 且不含 reasoning ⇒ 尊重目录，隐藏档位。
  const excluded = catalogAdapter([
    {
      id: 'deepseek-v4-flash',
      output_modalities: ['text'],
      input_modalities: ['text'],
      supported_features: ['tools', 'json_mode'],
    },
  ]);
  await excluded.listModels('sensenova');
  const excludedInfo = await excluded.resolveModel('sensenova', 'deepseek-v4-flash');
  assert.equal(excludedInfo.reasoning, undefined, '目录明确排除时应隐藏档位');
});

test('resolveModel: 冷目录（entry 缺失）下静态表仍给出档位/预算/上下文/视觉', async () => {
  const adapter = catalogAdapter([
    { id: 'sensenova-u1.5-lite', output_modalities: ['text'], input_modalities: ['text'] },
  ]);
  await adapter.listModels('sensenova');
  // deepseek-flash 不在目录里 ⇒ entry undefined ⇒ 走静态表兜底。
  // 这条护栏对应「冷目录下贴图被拒 / UNSUPPORTED_REASONING_EFFORT」两类线上事故。
  const info = await adapter.resolveModel('sensenova', 'deepseek-flash');
  assert.ok(info.reasoning, '冷目录下必须有档位');
  assert.deepEqual(
    info.reasoning.efforts.map((e) => e.id),
    ['none', 'low', 'medium', 'high', 'xhigh', 'minimal', 'max'],
  );
  assert.equal(info.defaultMaxTokens, 131072);
  assert.equal(info.context?.contextWindow, 1048576);
  assert.equal(info.name, 'DeepSeek V4.1 Flash');
  assert.equal(info.inputModalities?.includes('image'), true, '视觉白名单在冷目录下也生效');
});

test('resolveModel: 目录词表优先于静态表', async () => {
  const adapter = catalogAdapter([
    {
      id: 'deepseek-v4-flash',
      output_modalities: ['text'],
      input_modalities: ['text'],
      supported_features: ['reasoning'],
      reasoning_efforts: ['low', 'medium', 'high'],
      default_reasoning_effort: 'high',
    },
  ]);
  await adapter.listModels('sensenova');
  const info = await adapter.resolveModel('sensenova', 'deepseek-v4-flash');
  const reasoning = info.reasoning;
  assert.ok(reasoning);
  assert.deepEqual(reasoning.efforts.map((e) => e.id), ['low', 'medium', 'high'], '目录词表优先');
  assert.equal(reasoning.defaultEffort, 'high');
});

test('resolveModel: 静态表覆盖多个模型族（Phase 0 实测值域）', async () => {
  const data = [
    { id: 'deepseek-v4-pro', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['reasoning'] },
    { id: 'kimi-k3', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['reasoning'] },
    { id: 'sensenova-6.8-flash-lite', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['reasoning'] },
    { id: 'glm-5.2', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['reasoning'] },
    { id: 'deepseek-flash', output_modalities: ['text'], input_modalities: ['text'], supported_features: ['reasoning'] },
  ];
  const adapter = catalogAdapter(data);
  await adapter.listModels('sensenova');
  // v4-pro 未在 Phase 0 复测，**保留原值不动**（不引入未经实测的档位）。
  const pro = await adapter.resolveModel('sensenova', 'deepseek-v4-pro');
  assert.deepEqual(pro.reasoning?.efforts.map((e) => e.id), ['low', 'high', 'max']);
  // kimi-k3：Phase 0 实测全 7 档都接受（文档漏了 minimal/xhigh/none）。
  const kimi = await adapter.resolveModel('sensenova', 'kimi-k3');
  assert.deepEqual(kimi.reasoning?.efforts.map((e) => e.id), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  // 6.8-flash-lite：服务端权威词表只有 5 档，**文档写的 max 实测 400**，绝不能加。
  const sn68 = await adapter.resolveModel('sensenova', 'sensenova-6.8-flash-lite');
  assert.deepEqual(sn68.reasoning?.efforts.map((e) => e.id), ['none', 'low', 'medium', 'high', 'xhigh']);
  const glm = await adapter.resolveModel('sensenova', 'glm-5.2');
  assert.deepEqual(glm.reasoning?.efforts.map((e) => e.id), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  // v4.1（deepseek-flash）：Phase 0 唯一新增条目，全 7 档实测通过。
  const v41 = await adapter.resolveModel('sensenova', 'deepseek-flash');
  assert.deepEqual(v41.reasoning?.efforts.map((e) => e.id), ['none', 'low', 'medium', 'high', 'xhigh', 'minimal', 'max']);
});

test('stream: delta.reasoning_content 与 delta.reasoning 都被映射为 reasoning 增量', async () => {
  // reasoning_content（DeepSeek/Kimi 系）
  const rcSse = [
    'data: {"choices":[{"delta":{"reasoning_content":"思考中"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"content":"答案"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const rcAdapter = chatAdapter(() => sseResponse(rcSse));
  const rcChunks = await collect(rcAdapter.adapter, OPTIONS);
  const rcDeltas = rcChunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c.type === 'reasoning-delta' ? c.text : ''));
  assert.equal(rcDeltas.join(''), '思考中', 'reasoning_content 增量应被发射');

  // reasoning（SenseNova 6.8 系）
  const rSse = [
    'data: {"choices":[{"delta":{"reasoning":"thinking 6.8"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const rAdapter = chatAdapter(() => sseResponse(rSse));
  const rChunks = await collect(rAdapter.adapter, OPTIONS);
  const rDeltas = rChunks.filter((c) => c.type === 'reasoning-delta').map((c) => (c.type === 'reasoning-delta' ? c.text : ''));
  assert.equal(rDeltas.join(''), 'thinking 6.8', 'reasoning 增量应被发射');
});

test('stream: 同一事件 reasoning_content 与 reasoning 共存时以 reasoning_content 优先且不双发', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"优先内容","reasoning":"兜底内容"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const { adapter } = chatAdapter(() => sseResponse(sse));
  const chunks = await collect(adapter, OPTIONS);
  const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta');
  const text = reasoningDeltas.map((c) => (c.type === 'reasoning-delta' ? c.text : '')).join('');
  assert.equal(text, '优先内容', 'reasoning_content 优先');
  assert.equal(reasoningDeltas.length, 1, '同一事件只发一次 reasoning-delta');
});

test('stream: 规范 index 并行工具分片经 BlockAssembler 组装为完整 tool-call 块', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_0","type":"function","function":{"name":"skill","arguments":"{\\"name\\":\\"demo\\""}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"echo "}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"input\\":\\"hi\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"hi\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const { adapter } = chatAdapter(() => sseResponse(sse));
  const blocks = await assembleBlocks(adapter, OPTIONS);
  const toolBlocks = blocks.filter((b) => b.type === 'tool-call');
  assert.equal(toolBlocks.length, 2, '两个并行工具各成一个块');
  const skill = toolBlocks.find((b) => b.type === 'tool-call' && b.name === 'skill');
  const bash = toolBlocks.find((b) => b.type === 'tool-call' && b.name === 'bash');
  assert.ok(skill && skill.type === 'tool-call');
  assert.equal(skill.arguments, '{"name":"demo","input":"hi"}', 'skill arguments 完整拼接');
  assert.ok(bash && bash.type === 'tool-call');
  assert.equal(bash.arguments, '{"command":"echo hi"}', 'bash arguments 按分片拼接');
});

test('stream: 无键并行工具分片经 BlockAssembler 组装为独立完整 tool-call 块', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"skill","arguments":"{\\"name\\":\\"a\\""}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const { adapter } = chatAdapter(() => sseResponse(sse));
  const blocks = await assembleBlocks(adapter, OPTIONS);
  const toolBlocks = blocks.filter((b) => b.type === 'tool-call');
  assert.equal(toolBlocks.length, 2, '无键并行两个工具各成独立块，不并入单槽');
  const skill = toolBlocks.find((b) => b.type === 'tool-call' && b.name === 'skill');
  const bash = toolBlocks.find((b) => b.type === 'tool-call' && b.name === 'bash');
  assert.ok(skill && skill.type === 'tool-call');
  assert.equal(skill.arguments, '{"name":"a"}', 'skill arguments 完整');
  assert.ok(bash && bash.type === 'tool-call');
  assert.equal(bash.arguments, '{"command":"ls"}', 'bash arguments 完整');
});

// ---- fix-sensenova-429-quota-retry 新增用例 ----

import { classify429Body, TPM_PROBE_BACKOFF_STEPS_MS } from '../src/adapter.ts';

test('classify429Body: 已知形态精确分类（含别名 code），其余一律可轮换', () => {
  // code 8 数字（2026-09-04 实测现场；message 措辞随版本漂移，不参与分类）
  assert.deepEqual(
    classify429Body('{"error":{"message":"rpm exhausted","type":"quota_exceeded_error","code":8}}'),
    { quota: true, retryFloorMs: 15_000, kind: 'rate' },
  );
  // spec 场景样本：code 为字符串 "8"
  assert.deepEqual(
    classify429Body('{"error":{"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}}'),
    { quota: true, retryFloorMs: 15_000, kind: 'rate' },
  );
  // 429001 现场样本（type 实测为 invalid_request_error，字符串 code）
  assert.deepEqual(
    classify429Body('{"error":{"message":"inference tpm exhausted","type":"invalid_request_error","code":"429001"}}'),
    { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' },
  );
  assert.deepEqual(
    classify429Body('{"error":{"message":"inference tpm exhausted","code":429001}}'),
    { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' },
  );
  // 别名 code（2026-09-14 修复）：命名像"配额耗尽"，message 实为 tpm/rpm 限流 → 按 TPM 档
  assert.deepEqual(
    classify429Body('{"error":{"message":"inference exceeds tpm/rpm limit","code":"insufficient_quota"}}'),
    { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' },
  );
  assert.deepEqual(
    classify429Body('{"error":{"message":"inference exceeds tpm/rpm limit","code":"ModelAccountTpmRateLimitExceeded"}}'),
    { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' },
  );
  // 兜底：无 code / 其他 code / 非 JSON 体 / 空体 → 一律可轮换（HTTP 429 本身即限流）
  const fallback = { quota: true, retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0], kind: 'tpm' };
  assert.deepEqual(classify429Body('{"error":{"message":"throttled"}}'), fallback);
  assert.deepEqual(classify429Body('{"error":{"message":"bad request","code":"400"}}'), fallback);
  assert.deepEqual(classify429Body('rate limited'), fallback);
  assert.deepEqual(classify429Body(''), fallback);
});

test('stream: 配额类 429（code 8）→ RATE_LIMIT 携带 15000ms 退避下限且不轮换', async () => {
  const { adapter, calls, rotateCalls } = chatAdapter(() =>
    new Response(
      JSON.stringify({ error: { message: 'rpm exhausted', type: 'quota_exceeded_error', code: 8 } }),
      { status: 429 },
    ),
  );

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    // 2026-09-04 实测：速率桶补充 ≈1 个/14s，15s 覆盖一个完整补充周期。
    // 2026-09-16：下限之上叠加 ≤30% 单向上抖（只增不减，仍覆盖补充周期）。
    assertRetryFloor(e.failure.providerRetryAfterMs, 15_000, 'code 8 速率桶下限');
    return true;
  });
  assert.equal(calls(), 1);
  assert.equal(rotateCalls.length, 0, '默认（开关关）不轮换');
});

test('stream: 429001 分级探测退避——3/5/10/15/30/60/120s 递增封顶', async () => {
  // 2026-09-04 定稿：429001 不做长固定下限，改分级探测（不继承、按会话计数）。
  // 2026-09-16 修订：原档位 3/5/10/15s 封顶（累计仅 ~33s）撑不过分钟级 TPM 窗口，
  // 加长为 3/5/10/15/30/60/120s（累计约 4 分钟），任一成功即归零回到 3s。
  const tpm = chatAdapter(() =>
    new Response(
      JSON.stringify({ error: { message: 'inference tpm exhausted', type: 'invalid_request_error', code: '429001' } }),
      { status: 429 },
    ),
  );
  const floorOf = async () => {
    let captured = 0;
    await assert.rejects(collect(tpm.adapter, OPTIONS), (err: unknown) => {
      captured = (err as LlmError).failure.providerRetryAfterMs ?? 0;
      return true;
    });
    return captured;
  };
  assert.deepEqual([...TPM_PROBE_BACKOFF_STEPS_MS], [3_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000], '档位表（0916 加长）');
  // 连续 8 次命中：走完 7 档后封顶保持在第 7 档（120s），每次叠加 ≤30% 单向上抖。
  const seq = [
    await floorOf(), await floorOf(), await floorOf(), await floorOf(),
    await floorOf(), await floorOf(), await floorOf(), await floorOf(),
  ];
  seq.forEach((value, index) => {
    const floor = TPM_PROBE_BACKOFF_STEPS_MS[Math.min(index, TPM_PROBE_BACKOFF_STEPS_MS.length - 1)]!;
    assertRetryFloor(value, floor, `第 ${index + 1} 次命中（档位 ${floor}ms）`);
  });
  // 抖动上限（floor×1.3）之间互不重叠，因此前 7 次必须严格递增——档位确在升级。
  for (let i = 1; i < TPM_PROBE_BACKOFF_STEPS_MS.length; i += 1) {
    assert.ok(seq[i]! > seq[i - 1]!, `第 ${i}→${i + 1} 档严格递增（${TPM_PROBE_BACKOFF_STEPS_MS[i - 1]}→${TPM_PROBE_BACKOFF_STEPS_MS[i]}ms）`);
  }
  assertRetryFloor(seq[7], 120_000, '第 8 次命中封顶保持在末档 120s');
});

test('stream: 429001 成功后探测档位归零，Retry-After 更大时优先、更小时取当前档', async () => {
  // 成功归零：先连续 2 次命中（档位到 5s），再成功，再命中应回到 3s。
  const tpm = chatAdapter(() =>
    new Response(
      JSON.stringify({ error: { message: 'inference tpm exhausted', type: 'invalid_request_error', code: '429001' } }),
      { status: 429 },
    ),
  );
  const floorOf = async (adapter: { adapter: SensenovaAdapter }) => {
    let captured = 0;
    await assert.rejects(collect(adapter.adapter, OPTIONS), (err: unknown) => {
      captured = (err as LlmError).failure.providerRetryAfterMs ?? 0;
      return true;
    });
    return captured;
  };
  assertRetryFloor(await floorOf(tpm), 3_000, '命中#1（档位 3s）');
  assertRetryFloor(await floorOf(tpm), 5_000, '命中#2（档位 5s）');

  // Retry-After（5s）小于当前档（5s）时取下限（5s）；Retry-After 更大时优先。
  const larger = chatAdapter(() =>
    new Response(JSON.stringify({ error: { message: 'rpm exhausted', code: 8 } }), {
      status: 429,
      headers: { 'retry-after': '90' },
    }),
  );
  let capturedLarger = 0;
  await assert.rejects(collect(larger.adapter, OPTIONS), (err: unknown) => {
    capturedLarger = (err as LlmError).failure.providerRetryAfterMs ?? 0;
    return true;
  });
  assert.equal(capturedLarger, 90_000, 'Retry-After 更大时优先');

  // 成功一次（切到 200 OK 的 fetch）后，429001 档位归零回到 3s。
  let mode: 'ok' | '429' = '429';
  const mixed = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => {
      if (mode === 'ok') return sseResponse(FIXED_SSE);
      return new Response(
        JSON.stringify({ error: { message: 'inference tpm exhausted', code: '429001' } }),
        { status: 429 },
      );
    }) as typeof fetch,
  });
  assertRetryFloor(await floorOf({ adapter: mixed }), 3_000, '命中#1 → 档位 3s'); // 命中#1 → 3s
  assertRetryFloor(await floorOf({ adapter: mixed }), 5_000, '命中#2 → 档位 5s'); // 命中#2 → 5s
  mode = 'ok';
  await collect(mixed, OPTIONS); // 成功 → 清零
  mode = '429';
  assertRetryFloor(await floorOf({ adapter: mixed }), 3_000, '成功后档位归零回到 3s');
});

/** 429001 响应体（TPM 类，触发分级探测档位）。 */
function tpm429(): Response {
  return new Response(
    JSON.stringify({ error: { message: 'inference tpm exhausted', type: 'rate_limit_error', code: '429001' } }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * 构造 accountCount 把 key、全部返回 429001 的适配器（用于断言档位的**推进粒度**）。
 *
 * rotateApiKey 用无状态实现（按被拒 key 的下标推进），使每轮 stream() 都能走满
 * key-1→key-2→key-3 再耗尽，从而量化「一次调用内部有几个 internal attempt」。
 */
function tpmRotationAdapter(accountCount: number): { adapter: SensenovaAdapter; stats: { attempts: number } } {
  const state = { attempts: 0 };
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount, quotaRotation: true }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected: string) => {
      const index = Number(rejected.slice('key-'.length));
      return index >= accountCount ? undefined : `key-${index + 1}`;
    },
    fetchImpl: (async () => {
      state.attempts += 1;
      return tpm429();
    }) as typeof fetch,
  });
  return { adapter, stats: state };
}

test('W3：档位推进粒度 = 一次宿主重试（3 账号全 429001 → 每次调用只 +1 档）', async () => {
  // 修复前：tpmHitCounts 的读/递增在内层 attempt 循环里，一次调用 3 个 attempt
  // 会连吃 3 档 → 第一次调用的报错档位就是 10s，序列为 10/60/120/120s，
  // 7 档只够约 2.3 次宿主重试。修复后：档位快照在入口取一次，本轮内 3 个
  // attempt（含轮换出的新 key）共用同一档，整轮结束才 +1 ⇒ 3/5/10/15s。
  const probe = tpmRotationAdapter(3);
  const adapter = probe.adapter;
  const floorOf = async () => {
    let captured = 0;
    await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
      captured = (err as LlmError).failure.providerRetryAfterMs ?? 0;
      return true;
    });
    return captured;
  };

  assertRetryFloor(await floorOf(), 3_000, '第 1 次宿主重试 → 档位 1（3s）');
  assert.equal(probe.stats.attempts, 3, '一次调用内轮换 3 把 key（3 个 internal attempt）');
  assertRetryFloor(await floorOf(), 5_000, '第 2 次 → 档位 2（5s）');
  assertRetryFloor(await floorOf(), 10_000, '第 3 次 → 档位 3（10s）');
  assertRetryFloor(await floorOf(), 15_000, '第 4 次 → 档位 4（15s）');
  assertRetryFloor(await floorOf(), 30_000, '第 5 次 → 档位 5（30s）');
  assert.equal(probe.stats.attempts, 15, '每次调用固定 3 个 attempt');
});

test('W3：轮换后成功同样清零档位（下一轮回到最短档 3s）', async () => {
  // 第 1 次调用：3 个 attempt 全 429（档位 → 1）。
  // 第 2 次调用：第 1 个 attempt（key-1）仍 429，轮换到 key-2 后成功 → 必须清零。
  // 第 3 次调用：应回到最短档 3s（若未清零则会是 5s 或更高）。
  let calls = 0;
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 3, quotaRotation: true }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected: string) => {
      const index = Number(rejected.slice('key-'.length));
      return index >= 3 ? undefined : `key-${index + 1}`;
    },
    fetchImpl: (async () => {
      calls += 1;
      // 前 4 次（= 第 1 次调用的 3 个 + 第 2 次调用的第 1 个）全 429，仅第 5 次成功。
      return calls === 5 ? sseResponse(FIXED_SSE) : tpm429();
    }) as typeof fetch,
  });

  const floorOf = async () => {
    let captured = 0;
    await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
      captured = (err as LlmError).failure.providerRetryAfterMs ?? 0;
      return true;
    });
    return captured;
  };

  assertRetryFloor(await floorOf(), 3_000, '第 1 次调用（3 个 attempt 全 429）→ 档位 1（3s）');
  const chunks = await collect(adapter, OPTIONS); // 第 2 次：key-1 429 → key-2 成功
  assert.ok(chunks.length > 0, '第 2 次调用成功');
  assert.equal(calls, 5, '第 2 次调用用了 2 个 attempt（key-1 429 → key-2 200）');
  assertRetryFloor(await floorOf(), 3_000, '成功后档位归零：第 3 次调用回到 3s');
});

// ---- W4：限流事件记录 ----

/** 收集限流事件的假记录器（真实 `SenseNovaErrorLog` 的落盘语义另有 tests/error-log.test.ts）。 */
function collectingErrorLog(): { events: SenseNovaRateLimitEvent[]; thunk: () => SenseNovaErrorLog } {
  const events: SenseNovaRateLimitEvent[] = [];
  // adapter 只要求 `record()` 存在，因此这里不必是真正的 SenseNovaErrorLog 实例。
  const fake = { record: (event: SenseNovaRateLimitEvent) => { events.push(event); } } as unknown as SenseNovaErrorLog;
  return { events, thunk: () => fake };
}

test('W4：429 抛出路径记录事件（code/kind/档位/退避/账户指纹/attempt）', async () => {
  const collected = collectingErrorLog();
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2 }),
    resolveApiKey: async () => 'sk-secret-key-a',
    rotateApiKey: async () => undefined,
    errorLog: collected.thunk,
    fetchImpl: (async () => new Response(
      JSON.stringify({ error: { message: 'inference tpm exhausted', type: 'rate_limit_error', code: '429001' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
    )) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS));

  assert.equal(collected.events.length, 1, '一条 429 落一条事件');
  const event = collected.events[0]!;
  assert.equal(event.status, 429);
  assert.equal(event.code, '429001');
  assert.equal(event.kind, 'tpm');
  assert.equal(event.quota, true);
  assert.equal(event.model, 'test-model');
  assert.equal(event.rotated, false);
  assert.equal(event.attempt, 1, '第 1 个 internal attempt');
  assert.equal(event.retryFloorMs, 3_000, '入口档位快照（第 1 档）');
  assert.equal(event.retryAfterHeaderMs, 1_000, 'Retry-After 头被解析');
  assert.ok(event.providerRetryAfterMs !== undefined && event.providerRetryAfterMs >= 3_000, '与真正抛给宿主的值一致');
  assert.equal(event.account, fingerprint('sk-secret-key-a'), '只写 key 指纹');
  assert.ok(!JSON.stringify(event).includes('sk-secret-key-a'), '事件体不含 key 原文');
  assert.ok(Number.isFinite(Date.parse(event.ts)), 'ts 是合法 ISO 时间戳');
});

test('W4：轮换路径逐次记录，且 account 指纹指向**被拒**的那把 key', async () => {
  const collected = collectingErrorLog();
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 3, quotaRotation: true }),
    resolveApiKey: async () => 'sk-key-1',
    rotateApiKey: async (rejected: string) => {
      const index = Number(rejected.slice('sk-key-'.length));
      return index >= 3 ? undefined : `sk-key-${index + 1}`;
    },
    errorLog: collected.thunk,
    fetchImpl: (async () => new Response(
      JSON.stringify({ error: { message: 'inference tpm exhausted', code: '429001' } }),
      { status: 429 },
    )) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS));

  // key-1 429（轮换）→ key-2 429（轮换）→ key-3 429（无新 key，抛出）。
  assert.equal(collected.events.length, 3, '三个 internal attempt 各一条');
  assert.deepEqual(collected.events.map((e) => e.rotated), [true, true, false], '前两次轮换、最后一次抛出');
  assert.deepEqual(collected.events.map((e) => e.attempt), [1, 2, 3]);
  assert.deepEqual(
    collected.events.map((e) => e.account),
    ['sk-key-1', 'sk-key-2', 'sk-key-3'].map((key) => fingerprint(key)),
    'account 指纹指向被拒的 key（轮换前记录）',
  );
  // W3 与 W4 交叉校验：同一次调用内三条事件的档位一致，且都是入口快照。
  assert.deepEqual(collected.events.map((e) => e.retryFloorMs), [3_000, 3_000, 3_000], '档位快照在本轮内共用（W3）');
});

test('W4：非 429 失败（404 模型不可路由）不产生限流事件', async () => {
  const collected = collectingErrorLog();
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'sk-key-1',
    rotateApiKey: async () => undefined,
    errorLog: collected.thunk,
    fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })) as typeof fetch,
  });
  await assert.rejects(collect(adapter, OPTIONS));
  assert.equal(collected.events.length, 0, '限流记录器只记限流');
});

test('W4：未注入 errorLog 时一切照旧（不抛、不影响请求路径）', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'sk-key-1',
    rotateApiKey: async () => undefined,
    fetchImpl: (async () => new Response(JSON.stringify({ error: { code: '429001' } }), { status: 429 })) as typeof fetch,
  });
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => (err as LlmError).code === 'RATE_LIMIT');
});

/** 构造一个收到 abort 信号才 settle 的挂起 fetch（模拟传输挂起，无响应字节）。 */
function hangingFetch(): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
    return sseResponse(FIXED_SSE); // 不可达
  }) as typeof fetch;
}

test('stream: 连接/首字节超时以可重试 TIMEOUT 结束并释放并发额度', async () => {
  const gate = new KeyedConcurrencyGate();
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    concurrencyGate: gate,
    timeouts: { connectMs: 50 },
    fetchImpl: hangingFetch(),
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    assert.equal((err as LlmError).code, 'TIMEOUT', '连接超时映射可重试 TIMEOUT');
    return true;
  });
  assert.equal((gate as unknown as { states: Map<string, unknown> }).states.size, 0, '超时后并发额度已释放');
});

test('stream: 宿主 signal abort 保持原样透传（不被连接超时改写为 TIMEOUT）', async () => {
  const controller = new AbortController();
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    timeouts: { connectMs: 5_000 },
    fetchImpl: hangingFetch(),
  });

  const pending = collect(adapter, { ...OPTIONS, signal: controller.signal });
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await assert.rejects(pending, (err: unknown) => (err as Error).name === 'AbortError', '宿主取消以 AbortError 原样抛出');
});

test('stream: 流空闲看门狗回收停摆流（TIMEOUT）并释放并发额度', async () => {
  const gate = new KeyedConcurrencyGate();
  const encoder = new TextEncoder();
  // 只发一个 chunk 后静默且不 close 的流。
  const stalledStream = () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n'));
        // 故意不 close：模拟流中途停摆
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    concurrencyGate: gate,
    timeouts: { streamIdleMs: 50 },
    fetchImpl: (async () => stalledStream()) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    assert.equal((err as LlmError).code, 'TIMEOUT', '流停摆按可重试 TIMEOUT 结束');
    return true;
  });
  assert.equal((gate as unknown as { states: Map<string, unknown> }).states.size, 0, '看门狗触发后并发额度已释放');
});

test('stream: 流空闲看门狗收到事件即重置，持续输出的流不受影响', async () => {
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    timeouts: { streamIdleMs: 50 },
    fetchImpl: (async () => sseResponse(FIXED_SSE)) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.ok(chunks.some((c) => c.type === 'finish'), '持续有事件的流正常完成');
});

test('stream: 健康长流（总时长超过 connectMs）不被连接超时中断', async () => {
  // 回归：连接超时只约束建连/首包；响应头到达后计时器必须清除，body 阶段不得被误杀。
  const encoder = new TextEncoder();
  const slowHealthyStream = () => new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 8; i += 1) {
          await new Promise((r) => setTimeout(r, 20)); // 每 20ms 一个 chunk，总时长 ~160ms > connectMs 50ms
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n`));
        }
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    timeouts: { connectMs: 50, streamIdleMs: 5_000 },
    fetchImpl: (async () => slowHealthyStream()) as typeof fetch,
  });
  const chunks = await collect(adapter, OPTIONS);
  assert.ok(chunks.some((c) => c.type === 'finish'), '总时长超过连接超时的健康流正常完成');
});

test('stream: 单次请求内 k1→k2 环回；候选耗尽解除粘性，宿主重试从池首选重新探测', async () => {
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  const usedKeys: string[] = [];
  let key2Mode: '429' | 'ok' = '429';
  const rateBody = JSON.stringify({ error: { message: 'rpm exhausted', type: 'quota_exceeded_error', code: 8 } });
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2, quotaRotation: true }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      return rejected === 'key-1' ? 'key-2' : 'key-1';
    },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      usedKeys.push(key);
      if (key === 'key-2' && key2Mode === 'ok') return sseResponse(FIXED_SSE);
      return new Response(rateBody, { status: 429 });
    }) as typeof fetch,
  });

  // 第一轮：k1→k2 均饱和，单次请求内环回抛 RATE_LIMIT（k2 已被 tried 记过，不再切回 k1）。
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.equal((err as LlmError).code, 'RATE_LIMIT');
    return true;
  });
  assert.deepEqual(usedKeys, ['key-1', 'key-2'], '单次请求内 k1→k2 环回');

  // 第二轮（宿主退避后重试同一会话）：第一轮候选耗尽时已解除粘性（避免死锁），
  // 因此从账户池首选（key-1）重新起步；此时 k2 已恢复 → k1 429 后切到 k2 成功。
  key2Mode = 'ok';
  const ok = await collect(adapter, OPTIONS);
  assert.ok(ok.some((c) => c.type === 'finish'), '宿主重试时重新探测各 key，发现 k2 已恢复');
  assert.deepEqual(usedKeys, ['key-1', 'key-2', 'key-1', 'key-2'], '第二轮解粘后从池首选重新探测并切到恢复的 k2');
});

test('stream: 并发闸排队超时以可重试 TIMEOUT 结束且不占额度', async () => {
  const gate = new KeyedConcurrencyGate();
  let releaseFirst!: () => void;
  const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    concurrencyGate: gate,
    timeouts: { queueMs: 40 },
    fetchImpl: (async () => {
      await firstHolds;
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });
  // 第一个请求占住唯一额度（缺省并发 1）。
  const first = collect(adapter, OPTIONS);
  await new Promise((r) => setTimeout(r, 10));
  // 第二个请求排队，40ms 后超时。
  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    assert.equal((err as LlmError).code, 'TIMEOUT', '排队超时映射可重试 TIMEOUT');
    return true;
  });
  assert.equal((gate as unknown as { states: Map<string, unknown> }).states.size, 1, '排队超时不占额度（仅 first 在途）');
  releaseFirst();
  await first;
});

test('stream: 连接事实 queueMs 决定排队上限，测试注入的 timeouts.queueMs 优先', async () => {
  // ① 只有连接事实给出 queueMs=40（settings 的 queueTimeoutMs 路径）：排队 40ms 后超时。
  {
    const gate = new KeyedConcurrencyGate();
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const adapter = new SensenovaAdapter({
      options: () => ({ ...CONNECTION, queueMs: 40 }),
      resolveApiKey: async () => 'key-1',
      rotateApiKey: async () => undefined,
      concurrencyGate: gate,
      fetchImpl: (async () => {
        await firstHolds;
        return sseResponse(FIXED_SSE);
      }) as typeof fetch,
    });
    const first = collect(adapter, OPTIONS);
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      assert.equal((err as LlmError).code, 'TIMEOUT', '连接事实 queueMs 生效（未被忽略）');
      return true;
    });
    releaseFirst();
    await first;
  }

  // ② 同时注入 timeouts.queueMs=5000 时，注入值覆盖连接事实的 5ms：排队不会立即失败。
  {
    const gate = new KeyedConcurrencyGate();
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const adapter = new SensenovaAdapter({
      options: () => ({ ...CONNECTION, queueMs: 5 }),
      resolveApiKey: async () => 'key-1',
      rotateApiKey: async () => undefined,
      concurrencyGate: gate,
      timeouts: { queueMs: 5_000 },
      fetchImpl: (async () => {
        await firstHolds;
        return sseResponse(FIXED_SSE);
      }) as typeof fetch,
    });
    const first = collect(adapter, OPTIONS);
    await new Promise((r) => setTimeout(r, 10));
    const second = collect(adapter, OPTIONS);
    let settled = false;
    void second.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(settled, false, '注入的 timeouts.queueMs 优先于连接事实 queueMs');
    releaseFirst();
    const chunks = await second;
    assert.ok(chunks.some((c) => c.type === 'finish'), '释放额度后排队请求正常完成');
    await first;
  }
});

test('stream: quotaRotation 开启时配额类 429 切 key 重试并粘住新 key', async () => {
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  const usedKeys: string[] = [];
  const rateBody = JSON.stringify({ error: { message: 'rpm exhausted', type: 'quota_exceeded_error', code: 8 } });
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2, quotaRotation: true }),
    // 🔴 2026-09-27：`resolveApiKey` 新增 `hint.preferredKey`（会话粘性偏好）。真实实现
    // （`index.ts`）会把它交给 key 池校验后再采纳；测试的 mock 至少要尊重它，否则
    // 「粘住新 key」这条语义就测不出来了（旧 mock 恒返回 key-1，导致每轮都重新轮换）。
    resolveApiKey: async (_connection, hint) => hint?.preferredKey ?? 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      return rejected === 'key-1' ? 'key-2' : 'key-1';
    },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      usedKeys.push(key);
      if (key === 'key-1') return new Response(rateBody, { status: 429 });
      return sseResponse(FIXED_SSE);
    }) as typeof fetch,
  });

  const chunks = await collect(adapter, OPTIONS);
  assert.ok(chunks.some((c) => c.type === 'finish'), '切换到 key-2 后本次请求重试成功');
  assert.deepEqual(rotateCalls, [{ rejected: 'key-1', rejection: 'quota-exhausted' }], '配额类 429 以 quota-exhausted 轮换（不写账号状态）');
  assert.deepEqual(usedKeys, ['key-1', 'key-2'], '同一请求内切到 key-2 重试');

  // 后续请求：resolveApiKey 仍返回 key-1，但粘性指针让请求直接从 key-2 起步。
  const second = await collect(adapter, OPTIONS);
  assert.ok(second.some((c) => c.type === 'finish'));
  assert.equal(rotateCalls.length, 1, '粘住 key-2，未再次轮换');
  assert.deepEqual(usedKeys, ['key-1', 'key-2', 'key-2'], '后续请求直接使用粘住的 key-2');
});

test('stream: quotaRotation 关闭时配额类 429 不轮换（行为与现状一致）', async () => {
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  let calls = 0;
  const rateBody = JSON.stringify({ error: { message: 'rpm exhausted', type: 'quota_exceeded_error', code: 8 } });
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2 }), // quotaRotation 缺省 = 关
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      return 'key-2';
    },
    fetchImpl: (async () => {
      calls += 1;
      return new Response(rateBody, { status: 429 });
    }) as typeof fetch,
  });

  await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    const e = err as LlmError;
    assert.equal(e.code, 'RATE_LIMIT');
    assertRetryFloor(e.failure.providerRetryAfterMs, 15_000, '配额类退避下限仍生效');
    return true;
  });
  assert.equal(calls, 1, '不换 key 重试');
  assert.equal(rotateCalls.length, 0, '不触发账号轮换');
});

test('stream: quotaRotation 环回无新 key 时档位跨 key 递增（退避不被轮换清零，缺陷 A）', async () => {
  const rotateCalls: Array<{ rejected: string; rejection: string }> = [];
  const usedKeys: string[] = [];
  const rateBody = JSON.stringify({ error: { message: 'inference tpm exhausted', type: 'invalid_request_error', code: 429001 } });
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, accountCount: 2, quotaRotation: true }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async (rejected, rejection) => {
      rotateCalls.push({ rejected, rejection });
      // 模拟 pool.resolveKey({ exclude: rejectedKey })：两把 key 中排除被拒者返回另一把。
      return rejected === 'key-1' ? 'key-2' : 'key-1';
    },
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const key = String((init?.headers as Record<string, string>).authorization).replace('Bearer ', '');
      usedKeys.push(key);
      return new Response(rateBody, { status: 429 });
    }) as typeof fetch,
  });

  const floorOf = async (): Promise<number> => {
    let captured = 0;
    await assert.rejects(collect(adapter, OPTIONS), (err: unknown) => {
      assert.ok(err instanceof LlmError);
      const e = err as LlmError;
      assert.equal(e.code, 'RATE_LIMIT');
      captured = e.failure.providerRetryAfterMs ?? 0;
      return true;
    });
    return captured;
  };

  // 第 1 次调用（= 第 1 次宿主重试）：key-1 被拒 → 环回 key-2 仍被拒 → 抛 RATE_LIMIT。
  // 2026-09-16 修订（缺陷 A）：轮换分支原为 `tpmHitCounts.delete(sessionId)`，把探测
  // 档位清零 → 每次换 key 都退回 3s 档，配合当时 10 次的预算只有约 33s 重试窗口，
  // 撑不过分钟级 TPM 窗口 → 13/16 个回合被丢弃。**轮换不得清零档位。**
  // 2026-09-17 修订（W3）：档位推进单位改为「一次宿主重试」⇒ 本轮内两个 internal
  // attempt 共用入口快照，报错档位是 3s（W3 前是 5s，因为内层 attempt 也在递增）。
  // 缺陷 A 的原意图由「跨调用递增」断言守住（见下）。
  assertRetryFloor(await floorOf(), 3_000, '第 1 次调用（环回 2 个 attempt）→ 档位 1（3s）');
  assert.deepEqual(rotateCalls.map((c) => c.rejection), ['quota-exhausted', 'quota-exhausted'], '两次均为配额类轮换（不禁用）');
  assert.deepEqual(usedKeys, ['key-1', 'key-2'], '切到 key-2 仍被拒后环回');
  assert.equal(usedKeys.filter((k) => k === 'key-1').length, 1, '环回 key-1 已试过 → 停留在 key-2，不重复切换');

  // 第 2 次调用（= 第 2 次宿主重试）：档位必须比上一轮高 ⇒ 轮换没有清零档位（缺陷 A 的判别式）。
  assertRetryFloor(await floorOf(), 5_000, '第 2 次调用升到 5s（轮换未清零档位）');
});

test('resolveAdapterOptions: quotaRotation 缺省 false，显式 true 透传', () => {
  assert.equal(resolveAdapterOptions({}).quotaRotation, false);
  assert.equal(resolveAdapterOptions({ quotaRotation: true }).quotaRotation, true);
  assert.equal(resolveAdapterOptions({ quotaRotation: false }).quotaRotation, false);
});

test('resolveAdapterOptions: errorLog 缺省开，仅显式 false 关闭（W4）', () => {
  assert.equal(resolveAdapterOptions({}).errorLog, true);
  assert.equal(resolveAdapterOptions({ errorLog: true }).errorLog, true);
  assert.equal(resolveAdapterOptions({ errorLog: false }).errorLog, false);
  // 程序化构造可能绕过 Schemastery 归一化：非布尔/缺失一律视为开。
  assert.equal(resolveAdapterOptions({ errorLog: undefined }).errorLog, true);
  assert.equal(resolveAdapterOptions({ errorLog: 0 as unknown as boolean }).errorLog, true);
});

test('resolveAdapterOptions: queueTimeoutMs 缺省 60000，正值透传，非法值回退', () => {
  assert.equal(resolveAdapterOptions({}).queueTimeoutMs, 60_000);
  assert.equal(resolveAdapterOptions({ queueTimeoutMs: 180_000 }).queueTimeoutMs, 180_000);
  assert.equal(resolveAdapterOptions({ queueTimeoutMs: 0 }).queueTimeoutMs, 60_000);
  assert.equal(resolveAdapterOptions({ queueTimeoutMs: -1 }).queueTimeoutMs, 60_000);
  assert.equal(resolveAdapterOptions({ queueTimeoutMs: Number.NaN }).queueTimeoutMs, 60_000);
  assert.equal(resolveAdapterOptions({ queueTimeoutMs: 2_500.7 }).queueTimeoutMs, 2_500);
});
