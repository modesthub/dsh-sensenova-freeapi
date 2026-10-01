/**
 * 图片多模态（kimi-k3）改造的确定性测试。
 *
 * 覆盖：
 *  1. 能力修正——/v1/models 元数据 text-only 的自研视觉模型被补上 image；
 *  2. 目录未加载时 resolveModel 兜底同样补 image；
 *  3. 普通模型不受影响（仍为 text）；
 *  4. 带图 user 消息序列化为 OpenAI content 数组（image_url + Base64 Data-URL）；
 *  5. 无图消息不回归（content 仍为字符串）；
 *  6. 图片解析失败静默跳过（仍发送文本）；
 *  7. **0.1.6 offload 契约**——`offloaded: true` 的图片不发字节、改发占位文本，
 *     且不去解析（真图/offloaded 混合、tool 结果内嵌三档）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import { SensenovaAdapter, type SensenovaConnection } from '../src/adapter.ts';

const CONNECTION: SensenovaConnection = { apiBase: 'https://example.invalid', accountCount: 1 };

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

/** 捕获 chat 请求体的适配器；models 端点返回给定目录数据。 */
function capturingAdapter(opts: {
  data?: unknown[];
  resolveImage?: (
    ref: { attachmentId: string; mediaType: string },
  ) => Promise<{ mediaType: string; data: Uint8Array } | undefined>;
} = {}): { adapter: SensenovaAdapter; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    ...(opts.resolveImage !== undefined ? { resolveImage: opts.resolveImage } : {}),
    fetchImpl: (async (url: string, init: { body?: string }) => {
      if (String(url).includes('/models')) {
        return new Response(JSON.stringify({ data: opts.data ?? [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      bodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      return sseOk();
    }) as unknown as typeof fetch,
  });
  return { adapter, bodies };
}

async function drain(adapter: SensenovaAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) out.push(chunk);
  return out;
}

/** 取请求体里第一条 user 消息。 */
function firstUser(bodies: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const messages = bodies[0]?.messages as Array<Record<string, unknown>> | undefined;
  return messages?.find((m) => m.role === 'user');
}

test('能力修正：元数据 text-only 的 kimi-k3 补上 image', async () => {
  const { adapter } = capturingAdapter({
    data: [{ id: 'kimi-k3', output_modalities: ['text'], input_modalities: ['text'] }],
  });
  await adapter.listModels('sensenova');
  const info = await adapter.resolveModel('sensenova', 'kimi-k3');
  assert.deepEqual([...info.inputModalities], ['text', 'image']);
});

test('能力修正：目录未加载时 resolveModel 兜底也含 image', async () => {
  const { adapter } = capturingAdapter();
  const info = await adapter.resolveModel('sensenova', 'kimi-k3');
  assert.deepEqual([...info.inputModalities], ['text', 'image']);
});

test('能力修正：目录未加载时 sensenova-6.8-flash-lite 兜底仍含 image', async () => {
  // 2026-09-20 端到端实测发现的独立问题：网关元数据明确声明该模型
  // `input_modalities:["text","image"]`，但**目录未拉到时**的兜底若返回 ['text']，
  // 宿主 session-controller 的入站闸门会直接拒收图片
  // （`session/attachment-invalid / MODEL_DOES_NOT_SUPPORT_IMAGES`），
  // 表现为「刚启动 web、模型选择器还没打开过时贴图被拒：当前模型不支持图片」。
  // 本用例锁死该模型必须登记在 DOCUMENTED_VISION_MODELS 里。
  const { adapter } = capturingAdapter();
  const info = await adapter.resolveModel('sensenova', 'sensenova-6.8-flash-lite');
  assert.ok(
    info.inputModalities.includes('image'),
    `目录未加载也必须报含 image，实际 ${JSON.stringify([...info.inputModalities])}`,
  );
});

test('能力修正：目录声明含 image 时不会重复添加', async () => {
  const { adapter } = capturingAdapter({
    data: [{ id: 'sensenova-6.8-flash-lite', output_modalities: ['text'], input_modalities: ['text', 'image'] }],
  });
  await adapter.listModels('sensenova');
  const info = await adapter.resolveModel('sensenova', 'sensenova-6.8-flash-lite');
  assert.deepEqual([...info.inputModalities], ['text', 'image']);
});

test('能力修正：普通模型不受影响（仍为 text）', async () => {
  const { adapter } = capturingAdapter({
    data: [{ id: 'deepseek-v4-pro', output_modalities: ['text'], input_modalities: ['text'] }],
  });
  await adapter.listModels('sensenova');
  const info = await adapter.resolveModel('sensenova', 'deepseek-v4-pro');
  assert.deepEqual([...info.inputModalities], ['text']);
});

test('图片序列化：带图 user 消息 → content 数组 + image_url Data-URL', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const { adapter, bodies } = capturingAdapter({
    resolveImage: async (ref) => (ref.attachmentId === 'att-1' ? { mediaType: 'image/png', data: bytes } : undefined),
  });
  const options: GenerateOptions = {
    provider: 'sensenova',
    model: 'kimi-k3',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 8, width: 8, height: 8 } },
        { type: 'text', text: 'What color?' },
      ],
    } as never],
  };
  await drain(adapter, options);

  const user = firstUser(bodies);
  assert.ok(Array.isArray(user?.content), 'user content 应为数组');
  const content = user?.content as Array<Record<string, never>>;
  const first = content[0] as unknown as { type: string; image_url: { url: string } };
  assert.equal(first.type, 'image_url');
  assert.equal(first.image_url.url, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
  const second = content[1] as unknown as { type: string; text: string };
  assert.equal(second.type, 'text');
  assert.equal(second.text, 'What color?');
});

test('无图消息不回归：content 仍为字符串', async () => {
  const { adapter, bodies } = capturingAdapter();
  await drain(adapter, {
    provider: 'sensenova',
    model: 'kimi-k3',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] } as never],
  });
  const user = firstUser(bodies);
  assert.equal(typeof user?.content, 'string');
  assert.equal(user?.content, 'hello');
});

test('图片解析失败静默跳过：仍发送文本', async () => {
  const { adapter, bodies } = capturingAdapter({ resolveImage: async () => undefined });
  await drain(adapter, {
    provider: 'sensenova',
    model: 'kimi-k3',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'att-x', mediaType: 'image/png', bytes: 8, width: 8, height: 8 } },
        { type: 'text', text: 'hi' },
      ],
    } as never],
  });
  const user = firstUser(bodies);
  assert.equal(user?.content, 'hi');
});

// ─────────────────────────────────────────────────────────────────────────────
// 0.1.6 新增：offload 契约（ImageBlock.offloaded === true）
//
// 宿主的 `compaction-image-offload` 在官方路由触发 IMAGE_OFFLOAD_REQUIRED 后，会写下
// `image/offload` 事件，把最老的若干张图标记为 `offloaded: true`。0.1.6 的契约是
// **每条路由**都为这些出现位置发送占位文本、而不是图片字节（见 dsh-llm 的
// `ImageBlock.offloaded` 注释）。本路由历史上会照常解析并发送字节 ⇒ 既违背决定，
// 又会把宿主刻意省掉的图片塞回请求体。
// ─────────────────────────────────────────────────────────────────────────────

test('offload 契约：offloaded 图片不发字节、改发占位文本，且不再解析', async () => {
  let resolveCalls = 0;
  const { adapter, bodies } = capturingAdapter({
    resolveImage: async () => {
      resolveCalls += 1;
      return { mediaType: 'image/png', data: new Uint8Array([1]) };
    },
  });
  await drain(adapter, {
    provider: 'sensenova',
    model: 'kimi-k3',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', offloaded: true, attachment: { attachmentId: 'att-off', mediaType: 'image/png', bytes: 8, width: 8, height: 8 } },
        { type: 'text', text: '看图' },
      ],
    } as never],
  });

  assert.equal(resolveCalls, 0, 'offloaded 图片不应再去解析字节');
  const user = firstUser(bodies);
  assert.equal(typeof user?.content, 'string', '没有真图 ⇒ content 退回字符串');
  const text = String(user?.content);
  assert.ok(text.includes('看图'), '原有文本保留');
  assert.match(text, /image omitted to fit request image limits/, '应为宿主的占位措辞');
  assert.match(text, /att-off/, '占位文本需点出被省略的附件身份');
});

test('offload 契约：真图与 offloaded 图混合时各自走对路径', async () => {
  const { adapter, bodies } = capturingAdapter({
    resolveImage: async (ref) => (ref.attachmentId === 'att-real'
      ? { mediaType: 'image/png', data: new Uint8Array([1, 2]) }
      : undefined),
  });
  await drain(adapter, {
    provider: 'sensenova',
    model: 'kimi-k3',
    messages: [{
      role: 'user',
      content: [
        { type: 'image', attachment: { attachmentId: 'att-real', mediaType: 'image/png', bytes: 8, width: 8, height: 8 } },
        { type: 'image', offloaded: true, attachment: { attachmentId: 'att-off', mediaType: 'image/png', bytes: 8, width: 8, height: 8 } },
        { type: 'text', text: '两图' },
      ],
    } as never],
  });

  const user = firstUser(bodies);
  assert.ok(Array.isArray(user?.content), '有真图 ⇒ content 为数组');
  const content = user?.content as Array<Record<string, unknown>>;
  const imageParts = content.filter((part) => part['type'] === 'image_url');
  assert.equal(imageParts.length, 1, '只有真图作为 image_url 发送');
  assert.match(JSON.stringify(imageParts[0]), /data:image\/png;base64,/, '真图仍发 Data-URL');
  const textPart = content.find((part) => part['type'] === 'text') as { text: string } | undefined;
  assert.ok(textPart !== undefined, '文本段仍存在');
  assert.ok(textPart.text.includes('两图'));
  assert.match(textPart.text, /image omitted to fit request image limits/, 'offloaded 图以占位文本并入正文');
  assert.doesNotMatch(JSON.stringify(imageParts), /att-off/, 'offloaded 图不得作为 image_url 出现');
});

test('offload 契约：tool 消息里的 offloaded 图片留下占位文本', async () => {
  const { adapter, bodies } = capturingAdapter();
  await drain(adapter, {
    provider: 'sensenova',
    model: 'kimi-k3',
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'tc-1', name: 'grab', arguments: '{}' }] } as never,
      {
        // 🆕 0.1.7：工具结果是一等消息（`role: 'tool'`），不再是 user content 里的
        // `tool-result` 块 ⇒ 这里的 offloaded 图直接挂在该消息的 content 上。
        role: 'tool',
        toolCallId: 'tc-1',
        content: [
          { type: 'image', offloaded: true, attachment: { attachmentId: 'att-tool', mediaType: 'image/png', bytes: 8, width: 8, height: 8 } },
        ],
      } as never,
    ],
  });

  const messages = bodies[0]?.['messages'] as Array<Record<string, unknown>>;
  const tool = messages.find((message) => message['role'] === 'tool');
  assert.ok(tool !== undefined, '应产出 role:"tool" 消息');
  const content = String(tool['content']);
  assert.match(content, /image omitted to fit request image limits/, 'tool 结果内的 offloaded 图也要留占位');
  assert.match(content, /att-tool/);
});
