// debug_quota_probe4.mjs — D0 第四轮：RPS/RPM 语义测量
// R1: key A 12 并发小请求突发 → 并发/RPS 拒绝率与错误码
// R2: 紧接着 key B 12 并发小请求 → RPS 配额是否 per-key 隔离
// R3: key A 固定 1 req/s 持续 100s → 每分钟请求数配额与窗口翻转行为
import { readFileSync } from 'node:fs';

const CREDS_PATH = process.env.HOME + '/.dsh/.credentials.yaml';
const API = 'https://token.sensenova.cn/v1/chat/completions';
const MODEL = 'deepseek-v4-pro';
const UNIT = 'the quick brown fox jumps over the lazy dog while coding slowly ';

function loadKeys() {
  const text = readFileSync(CREDS_PATH, 'utf8');
  const pick = (n) => text.match(new RegExp('^\\s*' + n + ':\\s*(\\S+)\\s*$', 'm'))?.[1];
  const a = pick('SENSENOVA_API_KEY'), b = pick('SENSENOVA_API_KEY_2');
  if (!a) throw new Error('SENSENOVA_API_KEY 未找到');
  return { A: a, B: b };
}
const content = UNIT.repeat(4) + '\nReply with exactly: ok';

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawCall(key) {
  const body = JSON.stringify({ model: MODEL, max_tokens: 64, stream: false,
    messages: [{ role: 'user', content }] });
  const started = Date.now();
  try {
    const res = await fetch(API, { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body, signal: AbortSignal.timeout(45_000) });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      let code = '', msg = '';
      try { const j = JSON.parse(text); code = j?.error?.code ?? ''; msg = j?.error?.message ?? ''; } catch { }
      return { ok: false, status: res.status, ms: Date.now() - started, code, msg };
    }
    return { ok: true, status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, code: 'transport', msg: e.message };
  }
}

const keys = loadKeys();
const classify = (r) => r.ok ? 'OK' : r.status === 0 ? 'HANG' : `${r.status}/code=${r.code}(${r.msg})`;

async function burst(label, key, n) {
  log(`--- ${label}: ${n} 并发小请求 ---`);
  const rs = await Promise.all(Array.from({ length: n }, () => rawCall(key)));
  const ok = rs.filter((r) => r.ok).length;
  const byErr = {};
  rs.filter((r) => !r.ok).forEach((r) => { const k = classify(r); byErr[k] = (byErr[k] ?? 0) + 1; });
  const lat = rs.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  log(`${label}: OK=${ok}/${n}；失败分布=${JSON.stringify(byErr)}；成功延迟 p50=${lat[Math.floor(lat.length / 2)] ?? '-'}ms max=${lat[lat.length - 1] ?? '-'}ms`);
  return rs;
}

// R1 / R2
await burst('R1 keyA', keys.A, 12);
if (keys.B) await burst('R2 keyB', keys.B, 12);

// R3 固定速率
log('--- R3: key A 固定 1 req/s × 100 次，时间线 ---');
let timeline = '';
for (let i = 1; i <= 100; i++) {
  const r = await rawCall(keys.A);
  timeline += r.ok ? '.' : (r.status === 0 ? 'H' : 'X');
  if (i % 20 === 0) log(`R3 进度 ${i}/100：${timeline.slice(-20)} （. = OK, X = 429, H = 挂起）`);
  await sleep(Math.max(0, 1000 * i - (Date.now() - t0)));
}
const okCount = (timeline.match(/\./g) ?? []).length;
log(`R3 总结：OK=${okCount}/100, 429=${(timeline.match(/X/g) ?? []).length}, 挂起=${(timeline.match(/H/g) ?? []).length}`);
log('完整时间线: ' + timeline);
log('===== D0 第四轮结束 =====');
