// debug_quota_probe2.mjs — D0 第二轮：TPM 精确测量（带传输超时重试）+ 饱和后跨 key + 恢复曲线
// 与第一轮的差异：45s 超时；传输失败自动重试 2 次（5s 间隔）；递增直到真 429。
import { readFileSync } from 'node:fs';

const CREDS_PATH = process.env.HOME + '/.dsh/.credentials.yaml';
const API = 'https://token.sensenova.cn/v1/chat/completions';
const MODEL = 'deepseek-v4-pro';
const FALLBACK_MODEL = 'deepseek-v4-flash';
const UNIT = 'the quick brown fox jumps over the lazy dog while coding slowly ';
const UNIT_TOKENS = 17;

function loadKeys() {
  const text = readFileSync(CREDS_PATH, 'utf8');
  const pick = (name) => text.match(new RegExp('^\\s*' + name + ':\\s*(\\S+)\\s*$', 'm'))?.[1];
  const a = pick('SENSENOVA_API_KEY'), b = pick('SENSENOVA_API_KEY_2');
  if (!a) throw new Error('SENSENOVA_API_KEY 未找到');
  return { A: a, B: b };
}
const fillerFor = (tokens) => UNIT.repeat(Math.max(1, Math.ceil(tokens / UNIT_TOKENS)));

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawCall(key, { tokens, model }) {
  const body = JSON.stringify({
    model, max_tokens: 64, stream: false,
    messages: [{ role: 'user', content: fillerFor(tokens) + '\nReply with exactly: ok' }],
  });
  const started = Date.now();
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body, signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { ok: false, status: res.status, ms: Date.now() - started, error: text.slice(0, 300), headers };
    }
    let parsed = null; try { parsed = JSON.parse(text); } catch { }
    return { ok: true, status: res.status, ms: Date.now() - started,
      promptTokens: parsed?.usage?.prompt_tokens, completionTokens: parsed?.usage?.completion_tokens, model: parsed?.model };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, error: `transport: ${e.message}` };
  }
}

async function robustCall(keyLabel, key, opts) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await rawCall(key, opts);
    if (r.ok) { log(`${keyLabel} ${opts.label}: OK ${r.ms}ms prompt=${r.promptTokens} out=${r.completionTokens}`); return r; }
    const kind = r.status === 0 ? 'TRANSPORT' : `HTTP ${r.status}`;
    log(`${keyLabel} ${opts.label}: ${kind} ${r.ms}ms ${r.status ? 'err=' + r.error : r.error}`);
    if (r.status !== 0) { // 服务器有响应（429/400/404...）不重试，直接返回
      if (r.headers) log(`${keyLabel} ${opts.label}   headers=${JSON.stringify(r.headers)}`);
      return r;
    }
    if (attempt < 3) { log(`${keyLabel} ${opts.label}: 传输失败，5s 后重试 ${attempt}/2 ...`); await sleep(5_000); }
  }
  return { ok: false, status: 0, error: 'transport x3' };
}

const keys = loadKeys();
log(`密钥：A=有 B=有；模型=${MODEL}`);

// ---------- Q1 TPM 递增（key A，传输失败自动重试，直到真 429） ----------
log('===== Q1 key A TPM 递增：10k/20k/40k/80k/120k/160k/200k =====');
const ladder = [5_000, 10_000, 20_000, 40_000, 80_000, 120_000];
let cumulative = 0, model = MODEL, satSize = null, satTime = null;
for (const size of ladder) {
  let r = await robustCall('A', keys.A, { tokens: size, model, label: `${size}` });
  if (!r.ok && (r.status === 400 || r.status === 404) && model !== FALLBACK_MODEL) {
    log(`A ${size}: HTTP ${r.status} 切回退模型 ${FALLBACK_MODEL}`);
    model = FALLBACK_MODEL;
    r = await robustCall('A', keys.A, { tokens: size, model, label: `${size}` });
  }
  if (r.ok) { cumulative += r.promptTokens ?? size; continue; }
  if (r.status === 429) { satSize = size; satTime = Date.now(); break; }
  log(`A: 非 429 失败，停止递增`);
  break;
}
log(`Q1 结论：饱和前累计 input=${cumulative} tokens；${satSize ? `首个 429 在 ${satSize} 档` : '未触发 429'}`);

if (!satSize) {
  log('未饱和，跳过 Q2/Q3');
  process.exit(0);
}

// ---------- Q2 跨 key 交叉：A 饱和后立即 B 小请求 + B 中等请求 ----------
if (keys.B) {
  log('===== Q2 跨 key 交叉：A 饱和，立即 B 60token / B 20k =====');
  await robustCall('B', keys.B, { tokens: 60, model, label: 'small' });
  await robustCall('B', keys.B, { tokens: 20_000, model, label: '20k' });
}

// ---------- Q3 恢复曲线：A 每 +15s 探测（最多 +150s） ----------
log('===== Q3 key A 恢复曲线 =====');
let elapsed = 0, recovered = null;
for (const w of [15, 30, 45, 60, 75, 90, 105, 120, 135, 150]) {
  await sleep((w - elapsed) * 1000); elapsed = w;
  const r = await robustCall('A', keys.A, { tokens: 60, model, label: `probe +${w}s` });
  if (r.ok) { recovered = w; break; }
  // 429 之外的失败（传输等）不算恢复判定，继续等下一档
}
log(`Q3 结论：${recovered ? `饱和后约 +${recovered}s 恢复（429 距探测起点 ${(recovered).toFixed(0)}s）` : '150s 内未恢复'}`);
log('===== D0 第二轮结束 =====');
