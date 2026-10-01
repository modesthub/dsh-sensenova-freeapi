// 验证 kimi-k3 的 Base64 图片调用（带退避重试，等待限流窗口恢复）。
// 只读诊断：打印 key 名称与脱敏前缀，不打印完整 key。
import { readFileSync } from 'node:fs'
import { deflateSync, crc32 } from 'node:zlib'

const CREDS = process.env.USERPROFILE + '\\.dsh\\.credentials.yaml'
const txt = readFileSync(CREDS, 'utf8')

function getKey(name) {
  const m = txt.match(new RegExp('^\\s*' + name + ':\\s*(\\S+)\\s*$', 'm'))
  return m ? m[1] : undefined
}

/** 生成 w×h 纯色 PNG（无第三方依赖）。 */
function png(w, h, rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const b64 = png(8, 8, [255, 0, 0]).toString('base64')
const body = JSON.stringify({
  model: 'kimi-k3',
  messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
    { type: 'text', text: 'What color is this image? Answer in one word.' },
  ] }],
  max_tokens: 30,
})

const names = ['SENSENOVA_API_KEY', 'SENSENOVA_API_KEY_2', 'SENSENOVA_API_KEY_3', 'SENSENOVA_API_KEY_4']
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

for (let round = 1; round <= 8; round++) {
  for (const name of names) {
    const key = getKey(name)
    if (!key) continue
    try {
      const res = await fetch('https://token.sensenova.cn/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body,
      })
      if (res.ok) {
        const data = await res.json()
        const reply = data?.choices?.[0]?.message?.content ?? ''
        console.log(`[round ${round}] ${name}: OK  reply=${JSON.stringify(reply).slice(0, 120)}`)
        console.log('usage:', JSON.stringify(data?.usage))
        process.exit(0)
      }
      const err = (await res.text()).slice(0, 140)
      console.log(`[round ${round}] ${name}: HTTP ${res.status} ${err}`)
    } catch (e) {
      console.log(`[round ${round}] ${name}: ERR ${e.name} ${String(e.message).slice(0, 100)}`)
    }
  }
  if (round < 8) await sleep(25000)
}
console.log('所有轮次结束：仍在限流窗口内（未能完成图片验证）')
