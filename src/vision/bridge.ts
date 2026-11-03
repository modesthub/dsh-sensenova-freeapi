/**
 * 全局静默读图桥：让纯文本主模型（如 deepseek-v4-flash）在拖入/粘贴图片时
 * 不被「模型不支持图片输入」阻断 —— 由视觉链先看图，把事实性观察以**仅模型
 * 可见**的方式交给主模型续接回答，界面始终保留原图。
 *
 * 移植自 dsh-sensenova-vision-aid 的 vision-bridge.ts，保留全部机制：
 *   1. 包装 `ctx.llm.resolveModelInfo`，给启用的模型注入 `image` 模态，
 *      使发送前的图片能力校验通过；
 *   2. `agent/pre-step` 钩子：把即将进入本步的消息里的 image 块替换成观察文本；
 *   3. `ReplacementCoordinator`：同时改 `session.deriveMessages`，让历史消息里
 *      的图片在模型视图中同样被替换，UI 不变。
 *
 * **融合带来的唯一变化**：观察请求改走 `runVisionChain` —— 与主对话共享 key 池、
 * 并发闸、组退避与运行日志。这正是「视觉不再另起一套轮换」的落点。
 *
 * 只读安全：视觉模型只拿到图片 + 提示词，没有工具、没有执行权限；观察文本以
 * model-only surface replacement 交付，原图永不被改写。
 *
 * @module dsh-sensenova-freeapi/vision/bridge
 */

import type { Context } from '@deepseek-ai/cordis';
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { ImageAttachmentRef, StoredImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { ResolvedVisionOptions } from './config.ts';
import { runVisionChain, type VisionRuntime } from './request.ts';

/** 最小附件服务面（读取已入库的聊天图片）。 */
interface AttachmentsLike {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>;
}

/** 最小 llm 服务面（能力覆盖目标 + 真实能力查询）。 */
interface LlmLike {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    inputModalities?: readonly string[];
  }>;
}

/** 内容块的最小结构面（与 dsh-llm 的 ContentBlock 同形，可读写）。 */
interface ContentBlockLike {
  type?: string;
  text?: string;
  attachment?: ImageAttachmentRef;
  content?: ContentBlockLike[];
}
interface MessageLike {
  id?: string;
  content?: ContentBlockLike[];
}

/** 桥依赖：每次调用取最新配置与运行能力。 */
export interface VisionBridgeDeps {
  ctx: Context;
  runtime: () => VisionRuntime;
  options: () => ResolvedVisionOptions;
}

/** 是否包含 image 块（顶层或 tool-result 内）。 */
export function contentHasImage(content: readonly ContentBlockLike[] | undefined): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(block => block?.type === 'image'
    || (block?.type === 'tool-result' && contentHasImage(block.content)));
}

/** 统计消息中的图片总数。 */
function countImages(content: readonly ContentBlockLike[] | undefined): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) {
    if (block?.type === 'image') count += 1;
    else if (block?.type === 'tool-result') count += countImages(block.content);
  }
  return count;
}

/** 错误摘要（安全：不吐凭据/URL 细节）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 用视觉链识别一张已入库图片。
 * 与工具路径完全同一套依赖（池 + 闸 + 429 归因），只是入口换成附件引用。
 */
async function describeStoredImage(
  deps: VisionBridgeDeps,
  ref: ImageAttachmentRef,
  prompt: string,
  signal: AbortSignal | undefined,
  meta: { imageIndex: number; imageTotal: number },
): Promise<{ text: string; model: string }> {
  const attachments = deps.ctx.get('attachments' as never) as AttachmentsLike | undefined;
  if (attachments === undefined || typeof attachments.readImage !== 'function') {
    throw new Error('attachments 服务不可用，无法读取聊天图片');
  }
  const stored = await attachments.readImage(ref, signal);
  const bytes = stored?.data;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new Error('图片附件为空或不可读');
  }
  const base64 = Buffer.from(bytes).toString('base64');
  const mediaType = stored.ref?.mediaType ?? 'image/png';
  const content = [
    { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
    { type: 'text', text: prompt },
  ];
  const options = deps.options();
  const chain = await runVisionChain({
    runtime: deps.runtime(),
    content,
    models: options.modelChain,
    timeoutMs: options.timeoutMs,
    taskType: 'bridge',
    ...(signal === undefined ? {} : { signal }),
  });
  const tag = `【视觉观察：${chain.model}${meta.imageTotal > 1 ? ` · 第 ${meta.imageIndex}/${meta.imageTotal} 张` : ''}】`;
  return { text: `${tag}\n${chain.text.trim()}`, model: chain.model };
}

/**
 * 能力覆盖：包装 `ctx.llm.resolveModelInfo`，bridge 开启时给模型信息注入
 * `image` 模态，使发送前图片能力校验通过。返回恢复函数。
 */
export function installCapabilityOverride(
  ctx: Context,
  isEnabled: () => boolean,
): () => void {
  const llm = ctx.get('llm' as never) as LlmLike | undefined;
  if (llm === undefined || typeof (llm as { resolveModelInfo?: unknown }).resolveModelInfo !== 'function') {
    return () => undefined;
  }
  const previous = llm.resolveModelInfo.bind(llm);
  const overridden = async (
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ inputModalities?: readonly string[] }> => {
    const info = await previous(provider, model, signal);
    if (!isEnabled()) return info;
    const modalities = Array.isArray(info?.inputModalities) ? [...info.inputModalities] : ['text'];
    if (!modalities.includes('image')) modalities.push('image');
    return { ...info, inputModalities: modalities };
  };
  llm.resolveModelInfo = overridden;
  return () => {
    if (llm.resolveModelInfo === overridden) llm.resolveModelInfo = previous;
  };
}

/** 替换协调器：改 session 消息投影，让模型看观察文本、UI 留原图。 */
class ReplacementCoordinator {
  private readonly pending = new WeakMap<object, Map<string, MessageLike>>();
  private readonly patched = new Map<object, unknown>();

  ensureSessionProjection(session: object & { deriveMessages?: () => unknown[] }): void {
    if (this.patched.has(session)) return;
    const previous = session.deriveMessages;
    if (typeof previous !== 'function') return;
    const coordinator = this;
    session.deriveMessages = function (this: object): unknown[] {
      const messages = previous.call(this) as MessageLike[];
      const replacements = coordinator.pending.get(this);
      if (replacements === undefined || replacements.size === 0) return messages;
      return messages.map(message => replacements.get(message.id ?? '') ?? message);
    };
    this.patched.set(session, previous);
  }

  stage(session: object & { deriveMessages?: () => unknown[] }, original: MessageLike[], rewritten: MessageLike[]): void {
    this.ensureSessionProjection(session);
    let replacements = this.pending.get(session);
    if (replacements === undefined) {
      replacements = new Map();
      this.pending.set(session, replacements);
    }
    const activeIds = new Set(original.map(message => message.id).filter((id): id is string => typeof id === 'string'));
    for (const id of [...replacements.keys()]) {
      if (!activeIds.has(id)) replacements.delete(id);
    }
    for (let index = 0; index < original.length; index += 1) {
      const originalMessage = original[index];
      const rewrittenMessage = rewritten[index];
      if (originalMessage === undefined || rewrittenMessage === undefined) continue;
      const id = originalMessage.id;
      if (typeof id !== 'string') continue;
      if (originalMessage === rewrittenMessage || !contentHasImage(originalMessage.content)) continue;
      replacements.set(id, rewrittenMessage);
    }
  }

  dispose(): void {
    for (const [session, previous] of this.patched) {
      const target = session as { deriveMessages?: unknown };
      if (target.deriveMessages !== undefined) target.deriveMessages = previous;
    }
    this.patched.clear();
  }
}

/** 递归把消息里的 image 块替换为观察文本（保持顺序，含 tool-result 内）。 */
async function rewriteBridgeMessages(
  messages: MessageLike[],
  describe: (ref: ImageAttachmentRef) => Promise<string>,
): Promise<MessageLike[]> {
  const rewritten: MessageLike[] = [];
  for (const message of messages) {
    if (!contentHasImage(message.content)) {
      rewritten.push(message);
      continue;
    }
    rewritten.push({ ...message, content: await rewriteBridgeContent(message.content ?? [], describe) });
  }
  return rewritten;
}

/** 递归替换单个消息的内容块（image → text 观察，tool-result 内同样处理）。 */
async function rewriteBridgeContent(
  content: readonly ContentBlockLike[],
  describe: (ref: ImageAttachmentRef) => Promise<string>,
): Promise<ContentBlockLike[]> {
  const next: ContentBlockLike[] = [];
  for (const block of content) {
    if (block?.type === 'image' && block.attachment !== undefined) {
      next.push({ type: 'text', text: await describe(block.attachment) });
      continue;
    }
    if (block?.type === 'tool-result' && contentHasImage(block.content)) {
      next.push({ ...block, content: await rewriteBridgeContent(block.content ?? [], describe) });
      continue;
    }
    next.push(block);
  }
  return next;
}

/** 构造视觉识别提示：多图时标注第几张。 */
function buildBridgePrompt(options: ResolvedVisionOptions, imageIndex: number, imageTotal: number): string {
  return imageTotal > 1
    ? `（第 ${imageIndex}/${imageTotal} 张）\n${options.bridgePrompt}`
    : options.bridgePrompt;
}

/** 一次视觉识别批：把 messages 里的所有图片转成观察文本（失败图 → 失败占位）。 */
async function preprocessBridgeMessages(
  deps: VisionBridgeDeps,
  messages: MessageLike[],
  signal: AbortSignal | undefined,
): Promise<MessageLike[]> {
  const imageTotal = messages.reduce((total, message) => total + countImages(message.content), 0);
  if (imageTotal === 0) return messages;
  const options = deps.options();
  let imageIndex = 0;
  return rewriteBridgeMessages(messages, async (ref) => {
    imageIndex += 1;
    const prompt = buildBridgePrompt(options, imageIndex, imageTotal);
    try {
      const result = await describeStoredImage(deps, ref, prompt, signal, { imageIndex, imageTotal });
      return result.text;
    } catch (error: unknown) {
      return `【图片转换失败：${errorText(error)}】`;
    }
  });
}

/** 桥装配（apply 调用）：装能力覆盖 + pre-step 钩子，返回清理函数。 */
export function installVisionBridge(deps: VisionBridgeDeps): () => void {
  const { ctx } = deps;
  const coordinator = new ReplacementCoordinator();

  // `enabled` 是总开关，`bridgeMode` 是桥的模式：两者都满足才接管。
  const enabled = (): boolean => {
    const options = deps.options();
    return options.enabled && options.bridgeMode !== 'off';
  };

  // 记录未覆盖前的 resolveModelInfo（闭包内，避免模块级可变状态在热重载时串味）。
  const llm = ctx.get('llm' as never) as LlmLike | undefined;
  const rawResolveModelInfo = llm !== undefined
    && typeof (llm as { resolveModelInfo?: unknown }).resolveModelInfo === 'function'
    ? llm.resolveModelInfo.bind(llm)
    : undefined;

  const restoreCapability = installCapabilityOverride(ctx, enabled);
  const disposers: Array<() => void> = [restoreCapability];

  const preStepDisposer = ctx.on('agent/pre-step', async (
    payload: { agent: Agent; messages: unknown[]; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> => {
    const decision = await next();
    if (decision.kind === 'reject' || payload.signal.aborted) return decision;
    const options = deps.options();
    if (!options.enabled || options.bridgeMode === 'off') return decision;

    // auto：主模型真支持视觉时让它直接看原图，不接管。
    if (options.bridgeMode === 'auto' && rawResolveModelInfo !== undefined) {
      const header = typeof payload.agent.session?.requestHeader === 'function'
        ? payload.agent.session.requestHeader()
        : undefined;
      const headerConfig = header?.config as { provider?: string; model?: string } | undefined;
      const provider = headerConfig?.provider ?? payload.agent.options?.provider;
      const model = headerConfig?.model ?? payload.agent.options?.model;
      if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
        try {
          const info = await rawResolveModelInfo(provider, model, payload.signal);
          if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) return decision;
        } catch {
          // 查不到真实能力 ⇒ 保守接管（至少不让请求挂掉）。
        }
      }
    }

    // 合并派生历史 + 本步消息，统一检测/替换图片；本步消息替换进 decision 返回。
    const session = payload.agent.session as unknown as object & { deriveMessages?: () => unknown[] };
    const derived = typeof session.deriveMessages === 'function'
      ? session.deriveMessages() as unknown as MessageLike[]
      : [];
    const decisionMessages = decision.messages as unknown as MessageLike[];
    const modelMessages = [...derived, ...decisionMessages];
    if (!modelMessages.some(message => contentHasImage(message.content))) return decision;
    const rewritten = await preprocessBridgeMessages(deps, modelMessages, payload.signal);
    const rewrittenDecision = [...rewritten.slice(derived.length)];
    coordinator.stage(session, modelMessages, rewritten);
    return {
      kind: 'enter',
      messages: rewrittenDecision as unknown as PreStepDecision extends { kind: 'enter' } ? PreStepDecision['messages'] : never,
      ...(decision.kind === 'enter' && decision.startsRequestSeries === true ? { startsRequestSeries: true } : {}),
    };
  });
  disposers.push(() => void preStepDisposer());

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 清理失败静默：桥已卸载，资源尽力释放。
      }
    }
    coordinator.dispose();
  };
}
