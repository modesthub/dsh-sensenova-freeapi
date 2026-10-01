/**
 * 429 分类与账户轮换的确定性测试（2026-09-14 修复）。
 *
 * 背景：商汤 429 存在多种 error.code 形态，历史实现只识别 8 / 429001，
 * 导致 `insufficient_quota` / `ModelAccountTpmRateLimitExceeded` 等形态
 * 被判为「非配额类」→ 即使开启 quotaRotation 也不换 key（死锁在单 key）。
 *
 * 覆盖：
 *  1. classify429Body 四类形态 + 兜底；
 *  2. 开启 quotaRotation 时，insufficient_quota 也触发换 key；
 *  3. 未开启 quotaRotation 时不换 key；
 *  4. 错误消息保留原始 error.code（诊断可见性）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SensenovaAdapter, classify429Body, type SensenovaConnection } from '../src/adapter.ts';

const CONNECTION: SensenovaConnection = { apiBase: 'https://example.invalid', accountCount: 2 };

const SSE_OK = [
  'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

function sseOk(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(SSE_OK));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const OPTIONS: GenerateOptions = { provider: 'sensenova', model: 'deepseek-v4-flash', messages: [] };

/** 第 1 次请求返回 429（给定 code），其后成功；记录每次请求的 authorization。 */
function rotationAdapter(code: string, quotaRotation: boolean): {
  adapter: SensenovaAdapter;
  auths: string[];
} {
  const auths: string[] = [];
  let calls = 0;
  const adapter = new SensenovaAdapter({
    options: () => ({ ...CONNECTION, quotaRotation }),
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => 'key-2',
    fetchImpl: (async (url: string, init: { headers: Record<string, string> }) => {
      if (String(url).includes('/models')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      calls += 1;
      auths.push(init.headers.authorization);
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'inference exceeds tpm/rpm limit', type: 'rate_limit_error', code } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      }
      return sseOk();
    }) as unknown as typeof fetch,
  });
  return { adapter, auths };
}

async function drain(adapter: SensenovaAdapter): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of adapter.stream(OPTIONS)) out.push(chunk);
  return out;
}

// ── 1. classify429Body 形态覆盖 ───────────────────────────────────────────
test('classify429Body：code 8 → rate 桶', () => {
  const c = classify429Body('{"error":{"code":8,"message":"rpm exhausted"}}');
  assert.equal(c.quota, true);
  assert.equal(c.kind, 'rate');
});

test('classify429Body：429001 → tpm 档', () => {
  const c = classify429Body('{"error":{"code":"429001","message":"inference exceeds tpm/rpm limit"}}');
  assert.equal(c.quota, true);
  assert.equal(c.kind, 'tpm');
});

test('classify429Body：insufficient_quota → 可轮换（修复点，此前不识别）', () => {
  const c = classify429Body('{"error":{"code":"insufficient_quota","message":"inference exceeds tpm/rpm limit"}}');
  assert.equal(c.quota, true);
  assert.equal(c.kind, 'tpm');
});

test('classify429Body：ModelAccountTpmRateLimitExceeded → 可轮换', () => {
  const c = classify429Body('{"error":{"code":"ModelAccountTpmRateLimitExceeded","type":"rate_limit_error"}}');
  assert.equal(c.quota, true);
});

test('classify429Body：未知 code/非法 JSON → 保底可轮换（不再静默失效）', () => {
  assert.equal(classify429Body('{"error":{"code":"brand_new_code"}}').quota, true);
  assert.equal(classify429Body('not json').quota, true);
  assert.equal(classify429Body('').quota, true);
});

// ── 2. 轮换行为 ──────────────────────────────────────────────────────────
test('轮换：开启 quotaRotation + insufficient_quota → 换到第二个 key', async () => {
  const { adapter, auths } = rotationAdapter('insufficient_quota', true);
  await drain(adapter);
  assert.deepEqual(auths, ['Bearer key-1', 'Bearer key-2']);
});

test('轮换：开启 quotaRotation + 429001 → 换到第二个 key', async () => {
  const { adapter, auths } = rotationAdapter('429001', true);
  await drain(adapter);
  assert.deepEqual(auths, ['Bearer key-1', 'Bearer key-2']);
});

test('轮换：未开启 quotaRotation → 不换 key，直接抛错', async () => {
  const { adapter, auths } = rotationAdapter('429001', false);
  await assert.rejects(() => drain(adapter));
  assert.deepEqual(auths, ['Bearer key-1']);
});

// ── 3. 诊断可见性 ────────────────────────────────────────────────────────
test('错误消息保留原始 error.code（此前被统一文案丢弃）', async () => {
  const { adapter } = rotationAdapter('insufficient_quota', false);
  await assert.rejects(
    () => drain(adapter),
    (error: Error) => {
      assert.match(error.message, /insufficient_quota/);
      return true;
    },
  );
});
