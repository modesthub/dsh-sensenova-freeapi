/**
 * Key 池状态只读路由（v0.2.7）。
 *
 * 设置页「当前 key / 下一把 key」指示器 + 轮换动画的数据来源。
 * 客户端凭据面读不到明文，但可以读 host 拿到的「label + 池把数 + 位置」。
 * 本路由**只回 label / 把数 / 位置，绝不回 key 原文**（与 error-log、keysExport
 * 同范式：同源 + cookie 鉴权 + 绝不抛）。
 *
 * ⚠️ 客户端不能 import 本模块（用了 Node 的 `Response`）—— client 侧硬编码
 * 同值路由常量与精简接口，改动时两边一起改。
 *
 * @module dsh-sensenova-freeapi/keys-status-api
 */

import type { KeyPoolSnapshot } from './key-pool.ts'

/** 路由路径（client 侧硬编码同值）。 */
export const KEYS_STATUS_ROUTE = '/api/sensenova/keysStatus'

/** Key 状态快照（**不含 key 原文**，可安全跨 Remote wire）。 */
export interface KeysStatusSnapshot {
  available: boolean
  running: number
  blocked: number
  size: number
  currentLabel: string | undefined
  currentRef: string | undefined
  nextLabel: string | undefined
  nextRef: string | undefined
}

/** 依赖：由 index.ts 注入。 */
export interface KeysStatusDeps {
  snapshot: () => KeyPoolSnapshot | undefined
  describe: (key: string) => { label: string; ref: string } | undefined
}

function json(snapshot: KeysStatusSnapshot, status = 200): Response {
  return new Response(JSON.stringify(snapshot), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

const EMPTY: KeysStatusSnapshot = {
  available: false,
  running: 0,
  blocked: 0,
  size: 0,
  currentLabel: undefined,
  currentRef: undefined,
  nextLabel: undefined,
  nextRef: undefined,
}

/**
 * 处理一次状态查询；任何异常降级为 available:false（绝不抛）。
 */
export async function handleKeysStatusHttp(deps: KeysStatusDeps): Promise<Response> {
  try {
    const snapshot = deps.snapshot()
    if (snapshot === undefined) return json(EMPTY)
    const current = snapshot.currentKey !== undefined ? deps.describe(snapshot.currentKey) : undefined
    const next = snapshot.nextKey !== undefined ? deps.describe(snapshot.nextKey) : undefined
    return json({
      available: true,
      running: snapshot.running.length,
      blocked: snapshot.blocked.length,
      size: snapshot.size,
      currentLabel: current?.label,
      currentRef: current?.ref,
      nextLabel: next?.label,
      nextRef: next?.ref,
    })
  } catch {
    return json(EMPTY, 500)
  }
}
