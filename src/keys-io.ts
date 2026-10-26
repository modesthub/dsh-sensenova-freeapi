/**
 * Key 导入 / 导出的**纯文本编解码**（2026-10-26，v0.2.1）。
 *
 * 设计约束：
 *  1. **纯函数、无 IO**：host 导出路由与 client 导入面板共用同一套规则，
 *     单测直接覆盖（`tests/keys-io.test.ts`），不需要起服务。
 *  2. **兼容用户既有文件格式**（`账户N` 分节 + `序号:密钥`），同时接受
 *     `label:密钥` 单行与裸密钥行，避免用户手工整理。
 *  3. **密钥原文只出现在函数入参/出参**，本模块不写日志、不落盘。
 *
 * @module dsh-sensenova-freeapi/keys-io
 */

/**
 * Key 导出只读路由（host 注册 / client 请求共用同一常量，避免两边漂移）。
 * 约定与官方路由一致，挂在 `/api/` 下。
 */
export const KEYS_EXPORT_ROUTE = '/api/sensenova/keysExport'

/** 一条 key 记录：可读标签 + 密钥原文。 */
export interface KeyIoEntry {
  label: string
  key: string
}

/** 解析结果：成功的条目 + 逐行错误说明（错误不阻断其它行）。 */
export interface KeysParseResult {
  entries: KeyIoEntry[]
  errors: string[]
}

/** 密钥形状：`sk-` + ≥8 位 [A-Za-z0-9_-]（官方 35 位，留余量）。 */
const KEY_PATTERN = /^sk-[A-Za-z0-9_-]{8,}$/

/** 分节标题：`账户3` / `account 3`（标题单独成行）。 */
const SECTION_PATTERN = /^(?:账户|account)\s*(\d+)$/i

/**
 * 解析导入文本。
 *
 * 支持的写法（可混用）：
 * - 分节：`账户2` → 后续 `序号:密钥` 的标签为 `2-序号`
 * - 显式标签：`2-3:sk-...` 或 `Default:sk-...`
 * - 裸密钥：`sk-...`（无分节时标签为 `key-N`）
 * - 注释：`#` 开头的行忽略
 *
 * 重复密钥（同值）只保留第一条并记一条错误说明。
 */
export function parseKeysText(text: string): KeysParseResult {
  const entries: KeyIoEntry[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  let account: string | undefined
  let bareIndex = 0
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const raw = (lines[index] ?? '').trim()
    if (raw === '' || raw.startsWith('#')) continue

    const section = SECTION_PATTERN.exec(raw)
    if (section !== null) {
      account = section[1]
      continue
    }

    const pair = /^([^\s:：]{1,40})\s*[:：]\s*(.+)$/.exec(raw)
    if (pair !== null) {
      const labelRaw = (pair[1] ?? '').trim()
      const key = (pair[2] ?? '').trim()
      if (!KEY_PATTERN.test(key)) {
        errors.push(`第 ${index + 1} 行：密钥格式不合法（应以 sk- 开头）`)
        continue
      }
      if (seen.has(key)) {
        errors.push(`第 ${index + 1} 行：重复密钥已跳过`)
        continue
      }
      seen.add(key)
      const label = /^\d+$/.test(labelRaw) && account !== undefined ? `${account}-${labelRaw}` : labelRaw
      entries.push({ label, key })
      continue
    }

    if (KEY_PATTERN.test(raw)) {
      if (seen.has(raw)) {
        errors.push(`第 ${index + 1} 行：重复密钥已跳过`)
        continue
      }
      seen.add(raw)
      bareIndex += 1
      entries.push({ label: account !== undefined ? `${account}-${bareIndex - 1}` : `key-${bareIndex}`, key: raw })
      continue
    }

    errors.push(`第 ${index + 1} 行：无法识别（既不是 账户N、label:密钥，也不是裸密钥）`)
  }

  return { entries, errors }
}

/**
 * 生成导出文本。
 *
 * 输出为用户熟悉的 `账户N` 分节格式（label 形如 `2-3` 的按键分组），
 * 其余标签（如 `Default`）以 `标签:密钥` 单行放在最前 —— 与
 * {@link parseKeysText} 完全对称，可无损往返。
 */
export function formatKeysText(entries: readonly KeyIoEntry[], meta?: { when?: string }): string {
  const groups = new Map<string, Array<{ slot: number; key: string }>>()
  const loose: KeyIoEntry[] = []
  for (const entry of entries) {
    const matched = /^(\d+)-(\d+)$/.exec(entry.label)
    if (matched === null) {
      loose.push(entry)
      continue
    }
    const account = matched[1] ?? ''
    if (!groups.has(account)) groups.set(account, [])
    groups.get(account)?.push({ slot: Number(matched[2]), key: entry.key })
  }

  const out: string[] = []
  out.push(`# dsh-sensenova-freeapi key export${meta?.when !== undefined ? ` — ${meta.when}` : ''}`)
  out.push('# 格式：账户N 分节 + 「序号:密钥」；也接受「标签:密钥」单行。可直接用于「导入 Key」。')
  for (const entry of loose) out.push(`${entry.label}:${entry.key}`)
  if (loose.length > 0) out.push('')

  const accounts = [...groups.keys()].sort((a, b) => Number(a) - Number(b))
  for (const account of accounts) {
    out.push(`账户${account}`)
    const rows = groups.get(account) ?? []
    for (const row of rows.sort((a, b) => a.slot - b.slot)) out.push(`${row.slot}:${row.key}`)
    out.push('')
  }
  return `${out.join('\n').trimEnd()}\n`
}
