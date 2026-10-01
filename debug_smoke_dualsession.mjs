// debug_smoke_dualsession.mjs — 6.3 双会话并发冒烟（真实 API，src 与已发布 lib 同提交构建）
// S0 单会话成功冒烟 / S1 双会话同 key 并发 3 分钟（宿主重试语义：尊重 providerRetryAfterMs）
// S2 配额轮换开关冒烟（粘性切换 + 环回停留）
// 约束：不打印密钥值；进度直出控制台。
import { readFileSync } from 'node:fs';
import { SensenovaAdapter } from './src/adapter.ts';

const CREDS_PATH = process.env.HOME + '/.dsh/.credentials.yaml';
const text = readFileSync(CREDS_PATH, 'utf8');
const pick = (n) => text.match(new RegExp('^\\s*' + n + ':\\s*(\\S+)\\s*$', 'm'))?.[1];
const KEY_A = pick('SENSENOVA_API_KEY'), KEY_B = pick('SENSENOVA_API_KEY_2');

const t0 = Date.now();
const log = (m) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 观测用 fetch 包装：记录 key 归属（A/B/未知）与状态码，不打印密钥。 */
const attemptLog = [];
function observedFetch(keyA, keyB) {
  return async (input, init) => {
    const auth = String(init?.headers?.authorization ?? '');
    const keyTag = auth.endsWith(keyA) ? 'A' : auth.endsWith(keyB ?? '\u0000') ? 'B' : '?';
    const res = await fetch(input, init);
    attemptLog.push({ t: Date.now() - t0, key: keyTag, status: res.status });
    return res;
  };
}

function makeAdapter({ quotaRotation, accountCount, rotateTo }) {
  return new SensenovaAdapter({
    options: () => ({
      apiBase: 'https://token.sensenova.cn/v1',
      concurrency: 1,
      accountCount,
      ...(quotaRotation !== undefined ? { quotaRotation } : {}),
    }),
    resolveApiKey: async () => KEY_A,
    rotateApiKey: async (rejected) => {
      if (!rotateTo || !KEY_B) return undefined;
      return rejected === KEY_A ? KEY_B : KEY_A;
    },
    fetchImpl: observedFetch(KEY_A, KEY_B),
  });
}

function genOptions(sessionId, content) {
  return {
    provider: 'sensenova',
    model: 'deepseek-v4-flash',
    maxTokens: 16,
    sessionId,
    // 宿主消息 content 为分块数组（block.type 'text'），不是纯字符串
    messages: [{ role: 'user', content: [{ type: 'text', text: content }] }],
  };
}

async function runStream(adapter, opts) {
  const chunks = [];
  for await (const c of adapter.stream(opts)) chunks.push(c);
  return chunks;
}

/** 模拟宿主重试语义：RATE_LIMIT 尊重 providerRetryAfterMs，TIMEOUT 退避 5s，最多 10 次。 */
async function runSession(label, sessionId, adapter, durationMs, content) {
  const deadline = Date.now() + durationMs;
  let successes = 0, retries429 = 0, timeouts = 0, others = 0;
  let consecutive = 0, maxConsecutive = 0;
  const floors = new Set(), gaps = [];
  let lastSuccessAt = 0;
  while (Date.now() < deadline) {
    try {
      const chunks = await runStream(adapter, genOptions(sessionId, content));
      if (!chunks.some((c) => c.type === 'finish')) throw new Error('no finish chunk');
      successes += 1; consecutive = 0;
      const now = Date.now();
      if (lastSuccessAt) gaps.push(now - lastSuccessAt);
      lastSuccessAt = now;
      log(`${label}: ✔ 成功#${successes}`);
      await sleep(1_500);
    } catch (error) {
      consecutive += 1; maxConsecutive = Math.max(maxConsecutive, consecutive);
      const code = error?.code ?? error?.failure?.code ?? 'UNKNOWN';
      if (code === 'RATE_LIMIT') {
        retries429 += 1;
        const floor = error?.failure?.providerRetryAfterMs;
        if (floor !== undefined) floors.add(floor);
        const wait = floor ?? 1_000;
        log(`${label}: 429 限流（floor=${floor ?? '无'}ms）退避 ${wait}ms（连续失败 ${consecutive}）`);
        await sleep(wait);
      } else if (code === 'TIMEOUT') {
        timeouts += 1;
        log(`${label}: TIMEOUT 退避 5s（连续失败 ${consecutive}）`);
        await sleep(5_000);
      } else {
        others += 1;
        log(`${label}: 其他错误 code=${code} msg=${String(error?.message ?? '').slice(0, 120)}（连续失败 ${consecutive}）`);
        await sleep(3_000);
      }
      if (consecutive > 10) log(`${label}: ✗✗ 验收告警：连续失败超过 10 次！`);
    }
  }
  return { label, successes, retries429, timeouts, others, maxConsecutive, floors: [...floors].sort((a, b) => a - b), gaps };
}

// ---------- S0 单会话成功冒烟 ----------
log('===== S0 单会话冒烟（10s）=====');
{
  const adapter = makeAdapter({ accountCount: 1 });
  const r = await runSession('S0', 'smoke-s0', adapter, 10_000, '只回复两个字符: ok');
  log(`S0 结果: 成功=${r.successes} 429=${r.retries429} TIMEOUT=${r.timeouts} 其他=${r.others}`);
  if (r.successes === 0) { log('S0 失败：插件链路不可用，终止冒烟'); process.exit(1); }
}

// ---------- S1 双会话同 key 并发（quotaRotation 关，180s） ----------
log('===== S1 双会话同 key 并发 180s（开关关，宿主语义：尊重 providerRetryAfterMs）=====');
{
  const adapter = makeAdapter({ accountCount: 1 }); // 两会话共享同一 adapter/gate（同 DSH 进程内单例）
  const [a, b] = await Promise.all([
    runSession('S1会话1', 'smoke-s1a', adapter, 180_000, '会话1：只回复: ok1'),
    runSession('S1会话2', 'smoke-s1b', adapter, 180_000, '会话2：只回复: ok2'),
  ]);
  for (const r of [a, b]) {
    const gapsStr = r.gaps.length ? r.gaps.map((g) => Math.round(g / 1000) + 's').join(',') : '-';
    log(`S1 ${r.label}: 成功=${r.successes} 429=${r.retries429}(floors=${r.floors.join('/') || '-'}) TIMEOUT=${r.timeouts} 其他=${r.others} 最大连续失败=${r.maxConsecutive} 成功间隔=[${gapsStr}]`);
  }
  const pass = a.maxConsecutive <= 10 && b.maxConsecutive <= 10 && (a.successes + b.successes) >= 4;
  log(`S1 验收: ${pass ? '✔ 通过（无连续>10失败，两会话均有产出）' : '✗ 未达预期'}`);
}

// ---------- S2 配额轮换开关冒烟（90s） ----------
if (KEY_B) {
  log('===== S2 quotaRotation 开启冒烟（90s，观察粘性切换与环回停留）=====');
  const s2Baseline = attemptLog.length;
  const adapter = makeAdapter({ quotaRotation: true, accountCount: 2, rotateTo: true });
  const r = await runSession('S2会话', 'smoke-s2', adapter, 90_000, '轮换测试：只回复: ok');
  log(`S2 结果: 成功=${r.successes} 429=${r.retries429} 最大连续失败=${r.maxConsecutive}`);
  const s2Log = attemptLog.slice(s2Baseline);
  const tail = s2Log.slice(-14).map((e) => `${(e.t / 1000).toFixed(0)}s:${e.key}${e.status === 200 ? '' : '/' + e.status}`);
  log(`S2 尾部请求轨迹（时间:key[状态]）: ${tail.join(' ')}`);
  const keyCounts = s2Log.reduce((acc, e) => { const k = e.key + (e.status === 200 ? '✓' : '✗'); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  log(`S2 key 使用统计: ${JSON.stringify(keyCounts)}`);
} else {
  log('S2 跳过（仅一把 key）');
}

log('===== 冒烟结束 =====');
