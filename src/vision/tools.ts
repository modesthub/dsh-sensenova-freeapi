/**
 * 视觉辅助的三个全局工具：`describe_image` / `describe_images` / `chat`。
 *
 * 参数与返回信封与 dsh-sensenova-vision-aid（及更早的 MCP 版）逐字兼容，便于
 * 已有用法无感迁移。**唯一的行为差异**：请求现在走 `runVisionChain` —— 与主对话
 * 共享 key 池、并发闸、组退避与运行日志，而不是自己拿一把固定 key 打。
 *
 * @module dsh-sensenova-freeapi/vision/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { normalizeImageInput, toDataUrl, type NormalizedImage } from './image-input.ts';
import { runVisionChain, type VisionRuntime } from './request.ts';
import type { ResolvedVisionOptions } from './config.ts';

/** 工具依赖：每次执行时取最新配置与运行能力。 */
export interface VisionToolDeps {
  runtime: () => VisionRuntime;
  options: () => ResolvedVisionOptions;
}

/** 信封对象 schema（成功/失败共用一个宽松对象根）。 */
const envelopeSchema = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' as const },
    task_type: { type: 'string' as const },
    tool_used: { type: 'string' as const },
    confidence: { type: 'string' as const },
    result: { type: 'string' as const },
    error: { type: 'string' as const },
    image_count: { type: 'integer' as const },
    question_count: { type: 'integer' as const },
    metadata: { type: 'object' as const, additionalProperties: true },
  },
};

/** render：把信封对象序列化为文本块（与 MCP 版返回的 JSON 文本一致）。 */
function renderEnvelope(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/** 失败信封。 */
function fail(taskType: string, error: string): Record<string, unknown> {
  return { ok: false, task_type: taskType, error };
}

/** 归一化工具入参里的图片列表（describe_image 单图包装成数组）。 */
async function normalizeImages(raws: readonly string[]): Promise<NormalizedImage[]> {
  if (raws.length === 0) throw new Error('at least one image is required');
  const out: NormalizedImage[] = [];
  for (const raw of raws) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`each image must be a non-empty string, got ${JSON.stringify(raw)}`);
    }
    out.push(await normalizeImageInput(raw));
  }
  return out;
}

/** 把模型覆盖参数（逗号分隔）解析成链；空则用配置链。 */
function chainOf(override: unknown, fallback: string[]): string[] {
  if (typeof override !== 'string' || override.trim() === '') return fallback;
  const seen: string[] = [];
  for (const piece of override.split(',')) {
    const id = piece.trim();
    if (id !== '' && !seen.includes(id)) seen.push(id);
  }
  return seen.length > 0 ? seen : fallback;
}

/**
 * 组装最终视觉提示（2026-11-02，方案 1+2）。
 *
 * 三个来源按优先级拼：
 *   1. `prompt`：调用方显式指定的观察角度（主模型可自由改，这就是「大模型自己改提示词」）
 *   2. `fallback`：设置页的 `vision.bridgePrompt` —— 之前只有拖图桥用它，工具用的是
 *      硬编码的 'Describe this image in detail.'，于是主模型拿到的观察粒度极粗，
 *      这正是「答不出细节」的第一原因。
 *   3. `questions`：批量追问列表，一次请求问多个细节（图片 token 只算一次）。
 *
 * 三者都不给时退回英文兜底，保证不会发出空 text。
 *
 * @param prompt - 调用方提示，可空。
 * @param questions - 批量追问，逐项编号追加在提示之后。
 * @param fallback - 设置页观察提示词。
 * @param multi - 多图请求（文案从「这张图片」换成「这些图片」）。
 * @returns 可直接作为 text content 的字符串。
 */
export function buildVisionPrompt(
  prompt: string | undefined,
  questions: readonly string[] | undefined,
  fallback: string,
  multi = false,
): string {
  const explicit = typeof prompt === 'string' ? prompt.trim() : '';
  const configured = typeof fallback === 'string' ? fallback.trim() : '';
  const head = explicit !== ''
    ? explicit
    : configured !== ''
      ? configured
      : multi ? 'Describe these images in detail.' : 'Describe this image in detail.';
  const list = (questions ?? []).map(q => (typeof q === 'string' ? q.trim() : '')).filter(q => q !== '');
  if (list.length === 0) return head;
  const numbered = list.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const subject = multi ? '这些图片' : '这张图片';
  return `${head}\n\n请针对${subject}逐一回答下面的问题；只给答案，不要复述问题，也不要用「问题1：」这种前缀：\n${numbered}`;
}

/** describe_image / describe_images 的共用实现。 */
async function describe(
  deps: VisionToolDeps,
  args: { image?: string; images?: string[]; prompt?: string; questions?: string[]; model?: string },
  taskType: 'image_reasoning' | 'image_reasoning_multi',
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const options = deps.options();
  if (!options.enabled) return fail(taskType, '视觉辅助已在设置中关闭（llm-sensenova.vision.enabled = false）');

  const raws = args.images ?? (args.image !== undefined ? [args.image] : []);
  const multi = taskType === 'image_reasoning_multi';
  const askedQuestions = Array.isArray(args.questions)
    ? args.questions.filter(q => typeof q === 'string' && q.trim() !== '')
    : [];
  const prompt = buildVisionPrompt(args.prompt, askedQuestions, options.bridgePrompt, multi);

  let images: NormalizedImage[];
  try {
    images = await normalizeImages(raws);
  } catch (error) {
    return fail(taskType, error instanceof Error ? error.message : String(error));
  }

  const content: Array<Record<string, unknown>> = [];
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const raw = raws[index];
    if (image === undefined || raw === undefined) continue;
    content.push({ type: 'image_url', image_url: { url: toDataUrl(image, raw) } });
  }
  if (prompt !== '') content.push({ type: 'text', text: prompt });

  try {
    const chain = await runVisionChain({
      runtime: deps.runtime(),
      content,
      models: chainOf(args.model, options.modelChain),
      timeoutMs: options.timeoutMs,
      taskType,
    });
    return {
      ok: true,
      task_type: taskType,
      tool_used: `sensenova:${chain.model}`,
      confidence: 'high',
      ...(taskType === 'image_reasoning_multi' ? { image_count: images.length } : {}),
      ...(askedQuestions.length > 0 ? { question_count: askedQuestions.length } : {}),
      result: chain.text,
      metadata: {
        model: chain.model,
        image_mode: 'image_url',
        total_ms: Date.now() - started,
        ...(chain.accountRef !== undefined ? { account_ref: chain.accountRef } : {}),
        attempts: chain.attempts,
      },
    };
  } catch (error) {
    return fail(taskType, error instanceof Error ? error.message : String(error));
  }
}

/** describe_image：单图识别。 */
export function describeImageTool(deps: VisionToolDeps) {
  return defineTool({
    name: 'describe_image',
    description:
      '描述/理解一张图片(调用商汤 SenseNova 视觉模型,与主对话共用同一套账户池与限流闸;'
      + '按模型链故障转移,首个成功即返回)。image 为本地图片绝对路径、http(s) URL 或 base64。'
      + '看细节的三种用法:① prompt 换成针对性指令(如"只转录图中所有文字与数字");'
      + '② questions 一次问清多个细节(图片只算一次 token,推荐);'
      + '③ 都不给则用设置页配置的观察提示词做通读。'
      + '返回 JSON 文本(ok/task_type/tool_used/confidence/result/metadata.attempts);多图用 describe_images。',
    parameters: {
      image: {
        type: 'string',
        required: true,
        description: '本地图片绝对路径 / http(s) URL / data: URL / 裸 base64 字符串。',
      },
      prompt: {
        type: 'string',
        description:
          '观察指令,可自由指定重点(如"只关注报错堆栈"、"逐字转录界面文字")。'
          + '不传则用设置页的视觉观察提示词。',
      },
      questions: {
        type: 'array',
        items: { type: 'string' },
        description:
          '要一次问清的细节问题列表,模型会逐条回答。用于向视觉模型追问具体细节'
          + '(某个按钮上的文字、某个数值、某处状态),比多次调用 describe_image 省图片 token。',
      },
      model: {
        type: 'string',
        description: '模型链(逗号分隔),默认用设置页配置;可传 "kimi-k3" 强制单模型。',
      },
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    isConcurrencySafe: () => false,
    async execute(args) {
      return describe(deps, args as { image?: string; images?: string[]; prompt?: string; questions?: string[]; model?: string }, 'image_reasoning');
    },
  });
}

/** describe_images：同一请求内多图识别。 */
export function describeImagesTool(deps: VisionToolDeps) {
  return defineTool({
    name: 'describe_images',
    description:
      '同一请求内理解多张图片(调用商汤 SenseNova 视觉模型,与主对话共用同一套账户池与限流闸;'
      + '按模型链故障转移,首个成功即返回)。images 为图片列表,每项可为本地绝对路径、http(s) URL 或 base64;'
      + '返回 JSON 文本(ok/task_type/tool_used/confidence/result/metadata.attempts)。',
    parameters: {
      images: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '图片列表,每项为本地图片绝对路径 / http(s) URL / data: URL / 裸 base64。',
      },
      prompt: {
        type: 'string',
        description: '观察指令,可自由指定重点;不传则用设置页的视觉观察提示词。',
      },
      questions: {
        type: 'array',
        items: { type: 'string' },
        description: '要一次问清的细节问题列表,模型会逐条回答(图片 token 只算一次)。',
      },
      model: {
        type: 'string',
        description: '模型链(逗号分隔),默认用设置页配置。',
      },
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    isConcurrencySafe: () => false,
    async execute(args) {
      return describe(deps, args as { image?: string; images?: string[]; prompt?: string; questions?: string[]; model?: string }, 'image_reasoning_multi');
    },
  });
}

/** chat：纯文本连通性验证（也走同一套池，因此能真实反映当前配额状态）。 */
export function visionChatTool(deps: VisionToolDeps) {
  return defineTool({
    name: 'chat',
    description:
      '纯文本对话(调用商汤 SenseNova 视觉链的首模型;用于验证 key/端点连通性,以及视觉失败时的兜底)。'
      + '与主对话共用账户池,返回 JSON 文本(ok/task_type/tool_used/result/metadata.attempts)。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '要发送给模型的纯文本。',
      },
      model: {
        type: 'string',
        description: '模型链(逗号分隔),默认用设置页配置。',
      },
    },
    output: { schema: envelopeSchema, render: renderEnvelope },
    isConcurrencySafe: () => true,
    async execute(args) {
      const started = Date.now();
      const options = deps.options();
      if (!options.enabled) return { ok: false, task_type: 'chat', error: '视觉辅助已在设置中关闭' };
      const text = typeof (args as { text?: unknown }).text === 'string' ? (args as { text: string }).text : '';
      if (text.trim() === '') return fail('chat', 'text must be a non-empty string');
      try {
        const chain = await runVisionChain({
          runtime: deps.runtime(),
          content: [{ type: 'text', text }],
          models: chainOf((args as { model?: unknown }).model, options.modelChain),
          timeoutMs: options.timeoutMs,
          taskType: 'chat',
        });
        return {
          ok: true,
          task_type: 'chat',
          tool_used: `sensenova:${chain.model}`,
          result: chain.text,
          metadata: {
            model: chain.model,
            total_ms: Date.now() - started,
            ...(chain.accountRef !== undefined ? { account_ref: chain.accountRef } : {}),
            attempts: chain.attempts,
          },
        };
      } catch (error) {
        return fail('chat', error instanceof Error ? error.message : String(error));
      }
    },
  });
}
