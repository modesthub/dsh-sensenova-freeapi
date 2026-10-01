// debug_quota_probe.mjs — D0 实测 SenseNova 配额形态（只读诊断，不改源码）。
// 阶段：P1 冒烟 / P2 并发探针 / P3 TPM 递增 / P4 跨 key 交叉 / P5 恢复曲线 / P6 key B 独立配额
// 约束：不打印任何密钥值；进度直出控制台；429 时转储响应头与完整错误体。
import { readFileSync } from 'node:fs';

const CREDS_PATH = process.env.HOME + '/.dsh/.credentials.yaml';
const API = 'https://token.sensenova.cn/v1/chat/completions';
const MODEL = 'sensenova-6.8-flash-lite';
const FALLBACK_MODEL = 'deepseek-v4-flash';
const UNIT = 'the quick brown fox jumps over the lazy dog while coding slowly '; // ≈17 tokens
const UNIT_TOKENS = 17;

// 从 refs: 嵌套段提取密钥（兼容平铺），只保留在内存中
function loadKeys() {
  const text = readFileSync(CREDS_PATH, 'utf8');
  const pick = (name) => text.match(new RegExp('^\\s*' + name + ':\\s*(\\S+)\\s*$', 'm'))?.[1];
  const a = pick('SENSENOVA_API_KEY'), b = pick('SENSENOVA_API_KEY_2');
  if (!a) throw new Error('SENSENOVA_API_KEY 未找到');
  return { A: a, B: b };
}

function fillerFor(tokens) {
  const repeats = Math.max(1, Math.ceil(tokens / UNIT_TOKENS));
  return UNIT.repeat(repeats);
}

const t0 = Date.now();
const log = (msg) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(keyLabel, key, { tokens = 60, maxTokens = 16, model = MODEL, label = '' } = {}) {
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream: false,
    messages: [{ role: 'user', content: fillerFor(tokens) + '\nReply with exactly: ok' }],
  });
  const started = Date.now();
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, error: `transport: ${e.message}` };
  }
  const ms = Date.now() - started;
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { ok: false, status: res.status, ms, error: text.slice(0, 300), headers };
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* ignore */ }
  return {
    ok: true, status: res.status, ms,
    promptTokens: parsed?.usage?.prompt_tokens,
    completionTokens: parsed?.usage?.completion_tokens,
    model: parsed?.model,
  };
}

const report = (label, r) => {
  if (r.ok) {
    log(`${label}: OK ${r.ms}ms prompt=${r.promptTokens} out=${r.completionTokens} model=${r.model}`);
  } else if (r.status === 0) {
    log(`${label}: TRANSPORT-FAIL ${r.ms}ms ${r.error}`);
  } else {
    log(`${label}: HTTP ${r.status} ${r.ms}ms err=${r.error}`);
    if (r.headers) log(`${label}   headers=${JSON.stringify(r.headers)}`);
  }
};

const keys = loadKeys();
log(`密钥加载：A=${keys.A ? '有' : '无'} B=${keys.B ? '有' : '无'}；模型=${MODEL}（回退 ${FALLBACK_MODEL}）`);

// ---------- P1 冒烟 ----------
log('===== P1 冒烟：每 key 一次小请求 =====');
report('P1 keyA', await call('A', keys.A, { tokens: 60, label: 'P1 keyA' }));
if (keys.B) report('P1 keyB', await call('B', keys.B, { tokens: 60, label: 'P1 keyB' }));

// ---------- P2 并发探针（小 payload，排除 TPM 干扰，看是否有独立的并发/RPM 类 429） ----------
log('===== P2 并发探针：key A 同时发 6 个小请求 =====');
const p2 = await Promise.all(Array.from({ length: 6 }, (_, i) =>
  call('A', keys.A, { tokens: 60, label: `P2 #${i}` })));
p2.forEach((r, i) => report(`P2 #${i}`, r));

log('等待 65s 让限流窗口翻转，避免污染 P3 ...');
await sleep(65_000);

// ---------- P3 TPM 递增（key A，同一分钟内尽量快速连发） ----------
log('===== P3 TPM 递增：key A 依次 5k/10k/20k/40k/80k input，直到 429 =====');
const ladder = [5_000, 10_000, 20_000, 40_000, 80_000];
let cumulative = 0, model = MODEL, saturated = null, lastError = null;
for (const size of ladder) {
  let r = await call('A', keys.A, { tokens: size, model, label: `P3 ${size}` });
  // 400/404 视为模型能力问题：换回退模型重试同档
  if (!r.ok && (r.status === 400 || r.status === 404) && model !== FALLBACK_MODEL) {
    log(`P3 ${size}: HTTP ${r.status}，切换回退模型 ${FALLBACK_MODEL} 重试`);
    model = FALLBACK_MODEL;
    r = await call('A', keys.A, { tokens: size, model, label: `P3 ${size}` });
  }
  report(`P3 ${size}`, r);
  if (r.ok) { cumulative += r.promptTokens ?? size; continue; }
  lastError = r;
  if (r.status === 429) { saturated = size; break; }
  log(`P3: 非 429 失败，停止递增（交人工判断）`);
  break;
}
log(`P3 结论：成功累计 input=${cumulative} tokens；首个 429 出现在 ${saturated ?? '未出现'} 档`);

// ---------- P4 跨 key 交叉：A 打满后立即用 B 小请求 ----------
if (keys.B) {
  log('===== P4 跨 key 交叉：key A 已饱和，立即用 key B 小请求 =====');
  report('P4 keyB', await call('B', keys.B, { tokens: 60, label: 'P4 keyB' }));
}

// ---------- P5 恢复曲线：key A 定时探测，找窗口排空点 ----------
log('===== P5 恢复曲线：key A 每 +10/+20/+40/+70/+100/+130/+160s 探测 =====');
const waits = [10, 20, 40, 70, 100, 130, 160];
let recoveredAt = null, elapsedWait = 0;
for (const w of waits) {
  await sleep((w - elapsedWait) * 1000);
  elapsedWait = w;
  const r = await call('A', keys.A, { tokens: 60, label: `P5 +${w}s` });
  report(`P5 +${w}s`, r);
  if (r.ok) { recoveredAt = w; break; }
}
log(`P5 结论：${recoveredAt ? `+${recoveredAt}s 恢复` : '160s 内未恢复'}`);

// ---------- P6 key B 独立配额（若 P4 成功，说明配额按 key 隔离，测 B 的额度） ----------
if (keys.B) {
  log('===== P6 key B 递增：验证 B 有独立配额池 =====');
  let cumB = 0, satB = null;
  for (const size of ladder) {
    const r = await call('B', keys.B, { tokens: size, model, label: `P6 ${size}` });
    report(`P6 ${size}`, r);
    if (r.ok) { cumB += r.promptTokens ?? size; continue; }
    if (r.status === 429) { satB = size; break; }
    break;
  }
  log(`P6 结论：B 成功累计 input=${cumB} tokens；首个 429 在 ${satB ?? '未出现'} 档`);
}

log('===== D0 实测结束 =====');
