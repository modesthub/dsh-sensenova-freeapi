/**
 * Key 导出的 **host 只读路由**（2026-10-26，v0.2.1）。
 *
 * 为什么必须走 host：客户端凭据面（`remote.credentials`）只有
 * `describe / set / unset`，**读不到明文**（安全设计）。导出必须由上
 * 宿主用 `credentials.resolve()` 解析后再回传，因此单独开一条路由，
 * 与 error-log-api / model-info-api 同一范式（同源 + cookie 鉴权）。
 *
 * 三条约束：
 *  1. **只在用户点击「导出」时调用**，不做轮询、不缓存（响应带 `no-store`）。
 *  2. **绝不抛**：解析异常降级为 `{ ok: false, error }`，设置页显示提示即可。
 *  3. 回传的文本是**明文密钥**，由用户自行决定保存位置；本模块不落盘。
 *
 * @module dsh-sensenova-freeapi/keys-api
 */

import { KEYS_EXPORT_ROUTE, formatKeysText, type KeyIoEntry } from './keys-io.ts'

export { KEYS_EXPORT_ROUTE }

/** 一条可导出记录（label 用于分组，ref 仅诊断用途）。 */
export interface KeysExportEntry extends KeyIoEntry {
  ref: string
}

/** 导出依赖：由 index.ts 注入（解析全部账户，含默认账户）。 */
export interface KeysExportDeps {
  entries: () => Promise<KeysExportEntry[]>
}

/** 一次导出的完整答复。 */
export interface KeysExportSnapshot {
  ok: boolean
  /** 成功导出的条目数。 */
  exported: number
  /** 可直接展示/下载的文本（明文密钥）。 */
  text: string
  /** 失败原因（ok=false 时有值）。 */
  error?: string
}

function jsonResponse(snapshot: KeysExportSnapshot, status = 200): Response {
  return new Response(JSON.stringify(snapshot), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * 处理一次导出请求。
 *
 * @param deps - 注入的条目解析器。
 * @returns JSON 快照；任何异常都降级为 `ok: false`（绝不抛）。
 */
export async function handleKeysExportHttp(deps: KeysExportDeps): Promise<Response> {
  try {
    const entries = await deps.entries()
    const usable = entries.filter((entry) => entry.key !== '')
    const text = formatKeysText(
      usable.map((entry) => ({ label: entry.label, key: entry.key })),
      { when: new Date().toISOString() },
    )
    return jsonResponse({ ok: true, exported: usable.length, text })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse({ ok: false, exported: 0, text: '', error: message }, 500)
  }
}
