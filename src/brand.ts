/**
 * 本地自足的 ToolCallId 构造器（brand 语义与宿主完全一致）。
 *
 * - 类型层：直接以宿主 @deepseek-ai/dsh-llm 的 ToolCallId 为别名，保证与宿主
 *   StreamChunk/ToolCallBlock 等消费类型编译期互通（宿主 brand 的底层
 *   unique symbol 来自 @deepseek-ai/dsh-brand，重定义会产生 distinct symbol，
 *   类型互不兼容，故必须复用宿主类型而非本地重造）。
 * - 运行时：`import type` 会被 TypeScript 编译期整体擦除，产物不含任何对
 *   @deepseek-ai/dsh-llm 的运行时导入；本地恒等构造函数与宿主 brandString
 *   （恒等返回、无校验、无隐藏身份）行为等价，跨宿主版本值不变。
 * - 强依赖消除：@deepseek-ai/dsh-llm 0.1.1-rc.2 不导出 ToolCallId 值
 *   （0.1.2-alpha.3+ 才有）。本模块把「仅部分宿主存在的漂移值符号」本地化，
 *   杜绝 ESM 静态值导入导致的整树 SyntaxError（2026-09-07 事故）。
 *
 * @module dsh-sensenova-freeapi/brand
 */
import type { ToolCallId as HostToolCallId } from '@deepseek-ai/dsh-llm';

/** 宿主 ToolCallId 类型别名：与宿主 StreamChunk/ToolCallBlock 消费类型编译期互通。 */
export type ToolCallId = HostToolCallId;

/**
 * Brand a string as a {@link ToolCallId}.
 * @param id - the provider-issued or synthesized call id.
 * @returns the same string with the compile-time tool-call-id brand.
 */
export function ToolCallId(id: string): ToolCallId {
  return id as ToolCallId;
}