/**
 * 图片请求目标（`ImageRequestTarget`）契约回归护栏 —— 2026-09-20 读图全线失效的护栏。
 *
 * ## 背景（为什么单独一个文件）
 *
 * 0.1.6 把 `AttachmentStore.readImageRequest` 的第二参数从
 * `ImageRequestPolicy {maxPixels,maxBytes}` 改成 `ImageRequestTarget {width,height,maxBytes}`
 * （harness commit `ba30b73f7b`），存储层用 `checkedInteger(target.width)` 强校验。
 *
 * 插件当时仍在传旧形状 ⇒ 抛 `INVALID_ATTACHMENT_REF` ⇒ 被
 * `prepareImageDataUrls` 的空 `catch {}` 吞掉 ⇒ **图片静默全丢、请求退化成纯文本**，
 * 模型拿不到像素只能编内容（表现为"读图读不对"，其实是"根本没图"）。
 *
 * 当时 160 个单测全绿却没拦住，原因是**测试盲区**：
 * `tests/image-multimodal.test.ts` 里的 `resolveImage` 是**被 mock 掉的依赖**
 * （`resolveImage: async (ref) => ({...})`），完全不经过 `readImageRequest`。
 *
 * 所以本文件的铁律是：**绝不 mock `resolveImage` 本身**，只 mock 附件服务，
 * 并且让这个 mock **复刻真实存储层的参数校验**（`validateTarget`）。这样一旦
 * 调用方再传错形状，测试必然红 —— 在旧代码上本文件就是失败的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import {
  SensenovaAdapter,
  createResolveImage,
  requestImageTarget,
  type ImageAttachmentsLike,
  type SensenovaConnection,
} from '../src/adapter.ts';

const CONNECTION: SensenovaConnection = { apiBase: 'https://example.invalid', accountCount: 1 };

// ── 复刻 harness 存储层的校验（attachment-local/src/request-image.ts:43-54）───────
function checkedInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    const error = new Error(`${name} must be a positive integer.`) as Error & { code: string };
    error.code = 'INVALID_ATTACHMENT_REF';
    throw error;
  }
  return value;
}

function validateTarget(target: Record<string, unknown> | undefined): void {
  if (target === undefined) throw new Error('Image request target is required.');
  checkedInteger(target['width'], 'Image request width');   // ← 0.1.5 的 {maxPixels} 必在此抛
  checkedInteger(target['height'], 'Image request height');
  checkedInteger(target['maxBytes'], 'Image request maxBytes');
}

/** 复刻存储层 0.1.5 的校验（旧形状 {maxPixels,maxBytes}）。 */
function validateLegacyPolicy(policy: Record<string, unknown> | undefined): void {
  if (policy === undefined) throw new Error('Image request policy is required.');
  checkedInteger(policy['maxPixels'], 'Image request maxPixels');
  checkedInteger(policy['maxBytes'], 'Image request maxBytes');
}

/** 记录收到的第二参数、并按给定版本校验的假附件服务。 */
function fakeAttachments(mode: '0.1.6' | '0.1.5'): {
  attachments: ImageAttachmentsLike;
  targets: Array<Record<string, unknown>>;
} {
  const targets: Array<Record<string, unknown>> = [];
  const attachments = {
    async readImageRequest(ref: never, target: never) {
      const record = target as Record<string, unknown>;
      targets.push(record);
      if (mode === '0.1.6') validateTarget(record);
      else validateLegacyPolicy(record);
      return { mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) };
    },
  } as unknown as ImageAttachmentsLike;
  return { attachments, targets };
}

// ── 护栏 1：默认形状在 0.1.5 与 0.1.6 上都能过校验 ──────────────────────────────
test('requestImageTarget：同一份返回值同时满足 0.1.5 与 0.1.6 两种校验', () => {
  const target = requestImageTarget({ width: 683, height: 76 });
  assert.ok('width' in target && 'height' in target, '必须带 0.1.6 的 width/height');
  assert.equal(target.width, 683);
  assert.equal(target.height, 76);
  assert.equal(target.maxBytes, 1024 * 1024);
  assert.equal(target.maxPixels, 2048 * 2048, '必须同时带 0.1.5 的 maxPixels');
  assert.doesNotThrow(() => validateTarget(target as unknown as Record<string, unknown>));
  assert.doesNotThrow(() => validateLegacyPolicy(target as unknown as Record<string, unknown>));
});

// ── 护栏 2：超预算图按 maxPixels 等比投影，且投影后仍是正整数 ────────────────────
test('requestImageTarget：超出像素预算的图被等比投影且不超预算', () => {
  const target = requestImageTarget({ width: 4000, height: 3000 });
  assert.ok(target.width * target.height <= 2048 * 2048, `投影后像素 ${target.width * target.height} 超预算`);
  assert.ok(target.width < 4000 && target.height < 3000, '应被缩小');
  assert.ok(Number.isSafeInteger(target.width) && target.width > 0);
  assert.ok(Number.isSafeInteger(target.height) && target.height > 0);
  // 长宽比保持（允许四舍五入误差）
  assert.ok(Math.abs(target.width / target.height - 4000 / 3000) < 0.01);
  assert.doesNotThrow(() => validateTarget(target as unknown as Record<string, unknown>));
});

test('requestImageTarget：小图不放大', () => {
  const target = requestImageTarget({ width: 593, height: 143 });
  assert.deepEqual([target.width, target.height], [593, 143]);
});

test('requestImageTarget：尺寸异常时退回 1×1 而不抛错（丢模糊图 < 丢整张图）', () => {
  for (const bad of [{ width: 0, height: 10 }, { width: 10, height: -1 }]) {
    const target = requestImageTarget(bad);
    assert.deepEqual([target.width, target.height], [1, 1]);
    assert.doesNotThrow(() => validateTarget(target as unknown as Record<string, unknown>));
  }
});

// ── 护栏 3：端到端 —— 真图必须作为 image_url 发出去 ────────────────────────────
test('createResolveImage → 真图确实作为 image_url 进入请求体（0.1.6 契约）', async () => {
  const { attachments, targets } = fakeAttachments('0.1.6');
  const bodies: Array<Record<string, unknown>> = [];
  const adapter = new SensenovaAdapter({
    options: () => CONNECTION,
    resolveApiKey: async () => 'key-1',
    rotateApiKey: async () => undefined,
    // 🔴 关键：不 mock resolveImage，用真实的 createResolveImage 打穿到附件服务。
    resolveImage: createResolveImage(() => attachments),
    fetchImpl: (async (url: string, init: { body?: string }) => {
      if (String(url).includes('/models')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      bodies.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      const sse = [
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        '',
        'data: [DONE]',
        '',
      ].join('\n');
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch,
  });

  const options: GenerateOptions = {
    provider: 'sensenova',
    model: 'sensenova-6.8-flash-lite',
    messages: [{
      role: 'user',
      content: [
        // 尺寸取自 0920 会话里的真实附件
        { type: 'image', attachment: { attachmentId: 'sha256:ffea8e1d', mediaType: 'image/png', bytes: 35839, width: 593, height: 143 } },
        { type: 'text', text: '逐字读出图中文字' },
      ],
    } as never],
  };
  for await (const _chunk of adapter.stream(options) as AsyncIterable<StreamChunk>) {
    void _chunk;
  }

  assert.equal(targets.length, 1, '附件服务应被调用一次');
  assert.doesNotThrow(() => validateTarget(targets[0]), '第二参数必须是 0.1.6 的 ImageRequestTarget');
  assert.equal(targets[0]?.['width'], 593);
  assert.equal(targets[0]?.['height'], 143);

  const messages = bodies[0]?.['messages'] as Array<Record<string, unknown>>;
  const user = messages.find((message) => message['role'] === 'user');
  assert.ok(Array.isArray(user?.['content']), '有真图 ⇒ user content 必须是数组');
  const parts = user?.['content'] as Array<Record<string, unknown>>;
  const image = parts.find((part) => part['type'] === 'image_url') as { image_url?: { url?: string } } | undefined;
  assert.ok(image !== undefined, '必须发出 image_url 段（图片静默丢失会让此断言失败）');
  assert.match(String(image.image_url?.url), /^data:image\/png;base64,/);
});

// ── 护栏 4：降级兼容 —— 0.1.5 的存储层也必须能读同一份返回值 ────────────────────
test('createResolveImage → 同一份 target 在 0.1.5 的存储层上同样可用', async () => {
  const { attachments, targets } = fakeAttachments('0.1.5');
  const resolveImage = createResolveImage(() => attachments);
  const resolved = await resolveImage({
    attachmentId: 'sha256:cc95a955',
    mediaType: 'image/png',
    bytes: 97845,
    width: 1172,
    height: 181,
  });
  assert.notEqual(resolved, undefined);
  assert.doesNotThrow(() => validateLegacyPolicy(targets[0]), '降级回 0.1.5 不应因目标形状而失败');
});

// ── 护栏 5：附件服务未挂载时保持既有行为（跳过该图，不抛） ──────────────────────
test('createResolveImage → 附件服务缺失时返回 undefined（不抛）', async () => {
  const resolveImage = createResolveImage(() => undefined);
  assert.equal(await resolveImage({
    attachmentId: 'sha256:x',
    mediaType: 'image/png',
    bytes: 1,
    width: 8,
    height: 8,
  }), undefined);
});
