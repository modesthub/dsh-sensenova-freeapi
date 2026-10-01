/**
 * 错误记录只读接口的测试（2026-09-18）。
 *
 * 覆盖三块：解析（纯函数）/ 汇总（纯函数，含窗口口径）/ 端到端读取与 HTTP 形状。
 * 重点是**降级行为**：文件不存在、坏行、超长 limit、非 GET —— 这些都不该抛错，
 * 因为这块 UI 是设置页里的辅助信息，坏掉不能影响设置页本身。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ERROR_LOG_DEFAULT_LIMIT,
  ERROR_LOG_DEFAULT_WINDOW_MS,
  ERROR_LOG_MAX_LIMIT,
  ERROR_LOG_ROUTE,
  handleErrorLogHttp,
  parseErrorLogText,
  readErrorLogSnapshot,
  summarizeErrorLog,
} from '../src/error-log-api.ts';
import type { SenseNovaRateLimitEvent } from '../src/error-log.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function event(partial: Partial<SenseNovaRateLimitEvent> = {}): SenseNovaRateLimitEvent {
  return {
    ts: '2026-09-18T09:00:00.000Z',
    model: 'deepseek-v4-flash',
    status: 429,
    code: '429001',
    kind: 'tpm',
    quota: true,
    message: 'code=429001, inference exceeds tpm limit',
    rotated: false,
    attempt: 1,
    account: 'a3f9c1d2',
    session: 'b7e2a1c3',
    ...partial,
  };
}

test('路由路径与官方约定一致（挂在 /api 下，且是 client 侧硬编码的同值）', () => {
  assert.equal(ERROR_LOG_ROUTE, '/api/sensenova/errorLog');
  assert.equal(ERROR_LOG_DEFAULT_LIMIT, 50);
  assert.equal(ERROR_LOG_MAX_LIMIT, 200);
  assert.equal(ERROR_LOG_DEFAULT_WINDOW_MS, DAY_MS);
});

test('parseErrorLogText: 坏行/空行跳过，dropFirst 丢半截首行', () => {
  const text = [
    JSON.stringify(event({ code: '1' })),
    JSON.stringify(event({ code: '2' })),
    'not-json{',
    '',
    JSON.stringify(event({ code: '3' })),
  ].join('\n');

  assert.deepEqual(parseErrorLogText(text).map((e) => e.code), ['1', '2', '3'], '坏行与空行被跳过');

  // 按字节截取尾部时首行大概率是半截 JSON ⇒ dropFirst 直接不解析它，
  // 避免"看起来解析成功但少了一条"的静默误差。
  assert.deepEqual(parseErrorLogText(text, true).map((e) => e.code), ['2', '3']);

  // 尾随换行不产生幽灵条目
  assert.equal(parseErrorLogText(text + '\n').length, 3);
  assert.equal(parseErrorLogText('').length, 0);
});

test('summarizeErrorLog: 窗口按时间戳切、去重统计、列表新的在前', () => {
  const now = Date.parse('2026-09-18T10:00:00.000Z');
  // ⚠️ 顺序按真实形态给：JSONL 是**追加写**的，文件内事件天然按时间递增；
  // "取尾部 N 条再倒序"正依赖这个前提（同 ts 的相对顺序也因此是稳定的）。
  const events = [
    event({ ts: '2026-09-17T09:00:00.000Z', code: '8', model: 'glm-5.2' }), // 25h 前 ⇒ 窗口外
    event({ ts: '2026-09-18T09:00:00.000Z', code: '429001', model: 'flash' }),
    event({ ts: '2026-09-18T09:30:00.000Z', code: '429001', model: 'flash' }),
    event({ ts: '2026-09-18T09:40:00.000Z', code: 'quota_exceeded_error', model: 'glm-5.2' }),
  ];

  const snapshot = summarizeErrorLog(events, {
    filePath: '/tmp/x.jsonl',
    windowMs: DAY_MS,
    limit: 10,
    now,
  });

  assert.equal(snapshot.available, true);
  assert.equal(snapshot.total, 3, '窗口外的那条不计入统计');
  assert.equal(snapshot.distinctCodes, 2, '429001 去重后是 1 种，加上 quota_exceeded_error');
  assert.equal(snapshot.distinctModels, 2);
  assert.equal(snapshot.entries.length, 4, '列表取全部事件的尾部（不受窗口约束）');
  assert.equal(snapshot.entries[0]?.code, 'quota_exceeded_error', '最新的一条在最前');
  // 整体按时间倒序（比逐条比对 code 更能抓住"顺序反了"这类回归）
  const stamps = snapshot.entries.map((entry) => Date.parse(entry.ts));
  for (let index = 1; index < stamps.length; index += 1) {
    assert.ok(stamps[index]! <= stamps[index - 1]!, '列表按时间倒序');
  }
  assert.equal(
    snapshot.entries.at(-1)?.code,
    '8',
    '最早的一条（窗口外那条）落在末尾 ⇒ 列表不受窗口约束',
  );
});

test('summarizeErrorLog: limit 截断 + 字段裁剪（缺字段不炸）', () => {
  const now = Date.parse('2026-09-18T10:00:00.000Z');
  const many = Array.from({ length: 5 }, (_, index) =>
    event({ code: `c${index}`, ts: `2026-09-18T0${index}:00:00.000Z` }));

  const limited = summarizeErrorLog(many, { filePath: '/x', windowMs: DAY_MS, limit: 2, now });
  assert.equal(limited.entries.length, 2, 'limit 生效');
  assert.deepEqual(limited.entries.map((e) => e.code), ['c4', 'c3'], '取尾部并倒序');

  // 手工构造一条字段残缺的记录（例如未来版本改了字段名）：只应体现为缺省值，不应抛。
  const broken = [{ ts: '2026-09-18T09:00:00.000Z' } as unknown as SenseNovaRateLimitEvent];
  const snapshot = summarizeErrorLog(broken, { filePath: '/x', windowMs: DAY_MS, limit: 5, now });
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.distinctCodes, 0, '缺 code ⇒ 不计入去重统计');
  assert.equal(snapshot.entries[0]?.model, '');
  assert.equal(snapshot.entries[0]?.rotated, false);
  assert.equal(snapshot.entries[0]?.attempt, 0);
  assert.equal(snapshot.entries[0]?.retryFloorMs, undefined);

  // 时间戳无法解析的那条不进统计
  const undated = [{ ...event(), ts: 'not-a-date' }];
  assert.equal(
    summarizeErrorLog(undated, { filePath: '/x', windowMs: DAY_MS, limit: 5, now }).total,
    0,
  );
});

test('readErrorLogSnapshot: 文件不存在时降级为 available:false（懒创建，属正常）', async () => {
  const snapshot = await readErrorLogSnapshot({
    filePath: join(tmpdir(), 'sensenova-errors-definitely-missing-9f3a.jsonl'),
  });
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.total, 0);
  assert.equal(snapshot.distinctCodes, 0);
  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.truncated, false);
});

test('readErrorLogSnapshot: 端到端读取 + limit 钳制（下界 1 / 上界 200）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sn-errlog-'));
  try {
    const filePath = join(dir, 'sensenova-errors.jsonl');
    const events = ['a', 'b', 'c'].map((code) => event({ code }));
    await writeFile(filePath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');

    // ⚠️ 必须显式传 `now`：`event()` 的时间戳是固定的 `2026-09-18T09:00:00.000Z`，
    // 而 `readErrorLogSnapshot` 省略 `now` 时会用真实时钟 + 24h 窗口 ⇒ 跑测试的
    // 日期一旦晚于 09-19，三条样本全部落在窗口外，total 变成 0（2026-09-20 实测）。
    const now = Date.parse('2026-09-18T12:00:00.000Z');

    const snapshot = await readErrorLogSnapshot({ filePath, limit: 999, now });
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.total, 3);
    assert.equal(snapshot.entries.length, 3, '999 被钳到 200 后仍多于 3 条 ⇒ 全给');
    assert.equal(snapshot.path, filePath);
    assert.equal(snapshot.truncated, false, '远小于读取上限 ⇒ 不标截断');

    assert.equal((await readErrorLogSnapshot({ filePath, limit: 1, now })).entries.length, 1);
    assert.equal(
      (await readErrorLogSnapshot({ filePath, limit: 0, now })).entries.length,
      1,
      'limit 下界为 1（0 或负数不返回空列表）',
    );
    assert.equal(
      (await readErrorLogSnapshot({ filePath, limit: Number.NaN, now })).entries.length,
      3,
      'limit=NaN ⇒ 回退默认 50（若不显式挡，slice(NaN) 会退化成 slice(0) 返回全部）',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('handleErrorLogHttp: 只接受 GET，其余 405；GET 返回 JSON 且不可缓存', async () => {
  const rejected = await handleErrorLogHttp(
    new Request('http://dsh.internal/api/sensenova/errorLog', { method: 'POST' }),
  );
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get('allow'), 'GET');

  const response = await handleErrorLogHttp(
    new Request('http://dsh.internal/api/sensenova/errorLog?limit=5&windowMs=3600000'),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = (await response.json()) as Record<string, unknown>;
  for (const key of ['available', 'path', 'windowMs', 'total', 'distinctCodes', 'distinctModels', 'entries', 'truncated']) {
    assert.ok(key in body, `响应应包含 ${key}`);
  }
  assert.equal(body.windowMs, 3_600_000, 'windowMs 由 query 透传');
});
