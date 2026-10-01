// debug_cache_probe.mjs — D1 实测：服务端 prompt 缓存是否存在、是否按 key 隔离
// 三元组：A#1(冷) → A#2(暖,同 prompt) → B#1(跨 key 首打,同 prompt)
// 判定：若 B#1 ≈ A#1(慢) 且 A#2 明显更快 → 缓存存在且 per-key 隔离（轮换付一次冷启代价）
//       若 B#1 ≈ A#2(快) → 缓存跨 key 共享或无 per-key 缓存（轮换无损）
import { readFileSync } from 'node:fs';

const CREDS_PATH = process.env.HOME + '/.dsh/.credentials.yaml';
const API = 'https://token.sensenova.cn/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const UNIT = 'the quick brown fox jumps over the lazy dog while coding slowly ';
const FILLER = UNIT.repeat(Math.ceil(20_000 / 17)); // ≈20k tokens
const CONTENT = FILLER + '\nReply with exactly: ok';

function loadKeys() {
  const text = readFileSync(CREDS_PATH, 'utf8');
  const pick = (n) => text.match(new RegExp('^\\s*' + n + ':\\s*(\\S+)\\s*$', 'm'))?.[1];
  const a = pick('SENSENOVA_API_KEY'), b = pick('SENSENOVA_API_KEY_2');
  if (!a || !b) throw new Error('需要两个 key');
  return { A: a, B: b };
}
const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(key) {
  const body = JSON.stringify({ model: MODEL, max_tokens: 16, stream: false,
    messages: [{ role: 'user', content: CONTENT }] });
  const started = Date.now();
  try {
    const res = await fetch(API, { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body, signal: AbortSignal.timeout(45_000) });
    const text = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, status: res.status, ms: Date.now() - started, err: text.slice(0, 160) };
    const j = JSON.parse(text);
    return { ok: true, status: res.status, ms: Date.now() - started,
      prompt: j?.usage?.prompt_tokens, out: j?.usage?.completion_tokens };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, err: 'transport: ' + e.message };
  }
}

// 带一次重试（仅传输挂起/429 时；重试样本单独标注，不计入延迟对比）
async function probe(key) {
  let r = await once(key);
  if (!r.ok) {
    log(`  首次失败(HTTP ${r.status})，15s 后重试一次`);
    await sleep(15_000);
    r = await once(key);
  }
  return r;
}

const keys = loadKeys();
const rows = [];
for (let round = 1; round <= 2; round++) {
  log(`--- 第 ${round} 轮 ---`);
  for (const [name, key] of [['A#cold', keys.A], ['A#warm', keys.A], ['B#cross', keys.B]]) {
    const r = await probe(key);
    const tag = `${name}(${round})`;
    if (r.ok) log(`${tag}: OK ${r.ms}ms prompt=${r.prompt} out=${r.out}`); else log(`${tag}: FAIL HTTP ${r.status} ${r.err}`);
    rows.push({ tag, ok: r.ok, ms: r.ms, prompt: r.prompt, status: r.status });
    await sleep(2_000);
  }
  if (round === 1) await sleep(3_000);
}

log('=== 汇总（延迟 ms / prompt_tokens）===');
for (const r of rows) log(`${r.tag}: ${r.ok ? r.ms + 'ms / ' + r.prompt : 'FAIL ' + r.status}`);
const avg = (k) => {
  const v = rows.filter((r) => r.tag.startsWith(k) && r.ok).map((r) => r.ms);
  return v.length ? Math.round(v.reduce((a, b) => a + b) / v.length) : null;
};
log(`均值：A冷=${avg('A#cold')}ms  A暖=${avg('A#warm')}ms  B跨key=${avg('B#cross')}ms`);
log('判定：若 A暖 明显小于 A冷 且 B跨key ≈ A冷 → per-key 缓存；若 B跨key ≈ A暖 → 缓存跨 key 或不存在');
