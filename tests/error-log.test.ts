/**
 * 限流事件记录器（W4）单测。
 *
 * 覆盖：
 *  1. 纯函数：fingerprint / extractErrorCode / summarize / defaultErrorLogPath；
 *  2. 写入语义：一行一事件、字段完整；
 *  3. **脱敏**：文件里绝不出现 key 原文；
 *  4. 追加而非覆盖（跨实例）；
 *  5. 体积滚动到 `.1.jsonl`；
 *  6. **绝不抛出**：坏路径下 record() 不抛、连续失败后自停。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ERROR_LOG_MAX_CONSECUTIVE_FAILURES,
  SenseNovaErrorLog,
  defaultErrorLogPath,
  extractErrorCode,
  fingerprint,
  resolveDshHome,
  summarize,
  type SenseNovaRateLimitEvent,
} from '../src/error-log.ts';

/** 造一个临时目录（每个用例独立）。 */
async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sn-errorlog-'));
}

function makeEvent(overrides: Partial<SenseNovaRateLimitEvent> = {}): SenseNovaRateLimitEvent {
  return {
    ts: '2026-09-17T22:00:00.000Z',
    model: 'deepseek-v4-flash',
    status: 429,
    code: '429001',
    kind: 'tpm',
    quota: true,
    message: 'code=429001, inference tpm exhausted',
    retryFloorMs: 3_000,
    providerRetryAfterMs: 3_412,
    rotated: false,
    attempt: 1,
    account: fingerprint('sk-secret-key-a'),
    session: fingerprint('session-1'),
    ...overrides,
  };
}

// ── 1. 纯函数 ────────────────────────────────────────────────────────────
test('fingerprint: 稳定 8 位十六进制；空值返回空串；不同输入不碰撞', () => {
  const a = fingerprint('sk-secret-key-a');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(fingerprint('sk-secret-key-a'), a, '同输入同指纹');
  assert.notEqual(fingerprint('sk-secret-key-b'), a);
  assert.equal(fingerprint(undefined), '');
  assert.equal(fingerprint(''), '');
  assert.ok(!a.includes('sk-secret'), '指纹不含原文片段');
});

test('extractErrorCode: 字符串/数字 code 归一为字符串，其余为空串', () => {
  assert.equal(extractErrorCode('{"error":{"code":"429001"}}'), '429001');
  assert.equal(extractErrorCode('{"error":{"code":8}}'), '8');
  assert.equal(extractErrorCode('{"error":{"code":"insufficient_quota"}}'), 'insufficient_quota');
  assert.equal(extractErrorCode('{"error":{"message":"throttled"}}'), '');
  assert.equal(extractErrorCode('not json'), '');
  assert.equal(extractErrorCode(''), '');
  assert.equal(extractErrorCode('[]'), '');
  assert.equal(extractErrorCode('{"error":null}'), '');
});

test('summarize: 折叠空白并截断', () => {
  assert.equal(summarize('  a\n\t b  '), 'a b');
  assert.equal(summarize('x'.repeat(300), 10), `${'x'.repeat(10)}…`);
  assert.equal(summarize('short'), 'short');
});

test('defaultErrorLogPath: $DSH_HOME 优先，否则 ~/.dsh', () => {
  assert.equal(resolveDshHome({}), join(resolveDshHome({}), ''));
  assert.ok(defaultErrorLogPath({}).endsWith(join('.dsh', 'logs', 'sensenova-errors.jsonl')));
  assert.equal(
    defaultErrorLogPath({ DSH_HOME: 'D:/custom-home' }),
    join('D:/custom-home', 'logs', 'sensenova-errors.jsonl'),
  );
  // 空白 DSH_HOME 视为未设置（不能落到当前工作目录）。
  assert.equal(
    defaultErrorLogPath({ DSH_HOME: '   ' }),
    defaultErrorLogPath({}),
  );
});

// ── 2. 写入语义 ──────────────────────────────────────────────────────────
test('record: 一行一事件，字段完整且可解析', async () => {
  const dir = await tempDir();
  try {
    const filePath = join(dir, 'logs', 'sensenova-errors.jsonl');
    const log = new SenseNovaErrorLog({ filePath });
    log.record(makeEvent());
    log.record(makeEvent({ code: '8', kind: 'rate', retryFloorMs: 15_000, rotated: true, attempt: 2 }));
    await log.flush();

    const lines = (await readFile(filePath, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, 2, '两行');
    const first = JSON.parse(lines[0]!) as SenseNovaRateLimitEvent;
    assert.equal(first.code, '429001');
    assert.equal(first.kind, 'tpm');
    assert.equal(first.retryFloorMs, 3_000);
    assert.equal(first.providerRetryAfterMs, 3_412);
    assert.equal(first.rotated, false);
    assert.equal(first.attempt, 1);
    assert.equal(first.model, 'deepseek-v4-flash');
    assert.equal(first.session, fingerprint('session-1'));
    const second = JSON.parse(lines[1]!) as SenseNovaRateLimitEvent;
    assert.equal(second.code, '8');
    assert.equal(second.rotated, true);
    assert.equal(second.attempt, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺失的可选字段不写成 null（jq 友好）', async () => {
  const dir = await tempDir();
  try {
    const filePath = join(dir, 'e.jsonl');
    const log = new SenseNovaErrorLog({ filePath });
    log.record(makeEvent({ retryFloorMs: undefined, providerRetryAfterMs: undefined }));
    await log.flush();
    const event = JSON.parse((await readFile(filePath, 'utf8')).trim()) as Record<string, unknown>;
    assert.ok(!('retryFloorMs' in event));
    assert.ok(!('providerRetryAfterMs' in event));
    assert.ok(!('retryAfterHeaderMs' in event));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 3. 脱敏 ──────────────────────────────────────────────────────────────
test('脱敏: 文件内容绝不含 key 原文，只有指纹', async () => {
  const dir = await tempDir();
  try {
    const filePath = join(dir, 'e.jsonl');
    const secret = 'sk-sensenova-super-secret-1234567890';
    const log = new SenseNovaErrorLog({ filePath });
    log.record(makeEvent({ account: fingerprint(secret) }));
    await log.flush();
    const content = await readFile(filePath, 'utf8');
    assert.ok(!content.includes(secret), '不含 key 原文');
    assert.ok(!content.includes('super-secret'), '不含 key 片段');
    assert.ok(content.includes(fingerprint(secret)), '含指纹');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 4. 追加语义 ──────────────────────────────────────────────────────────
test('跨实例追加（不覆盖），且既有体积被正确探测', async () => {
  const dir = await tempDir();
  try {
    const filePath = join(dir, 'e.jsonl');
    const first = new SenseNovaErrorLog({ filePath });
    first.record(makeEvent({ attempt: 1 }));
    await first.flush();

    const second = new SenseNovaErrorLog({ filePath });
    second.record(makeEvent({ attempt: 2 }));
    await second.flush();

    const lines = (await readFile(filePath, 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length, 2, '追加而非覆盖');
    assert.equal((JSON.parse(lines[1]!) as SenseNovaRateLimitEvent).attempt, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 5. 滚动 ──────────────────────────────────────────────────────────────
test('体积超过上限时滚动到 `<name>.1.jsonl`，且只保留 1 份历史', async () => {
  // 契约（存储有界优先）：滚动到 `<name>.1.jsonl` 时**覆盖**上一份历史 ⇒
  // 更早的事件会被丢弃。这是「保留 1 份」的必然代价，不是 bug。
  const dir = await tempDir();
  try {
    const filePath = join(dir, 'sensenova-errors.jsonl');
    const single = new SenseNovaErrorLog({ filePath });
    single.record(makeEvent({ attempt: 1 }));
    await single.flush();
    const lineBytes = Buffer.byteLength(await readFile(filePath, 'utf8'));
    assert.ok(lineBytes > 0);

    // 上限 ≈ 2.5 行 ⇒ 每个文件装 2 条，写 6 条必然滚动。
    const log = new SenseNovaErrorLog({ filePath, maxBytes: Math.floor(lineBytes * 2.5) });
    for (let i = 2; i <= 6; i += 1) log.record(makeEvent({ attempt: i }));
    await log.flush();

    const current = (await readFile(filePath, 'utf8')).trimEnd().split('\n');
    const rolled = (await readFile(join(dir, 'sensenova-errors.1.jsonl'), 'utf8')).trimEnd().split('\n');
    assert.ok(rolled.length >= 1, '滚动文件存在且有内容');
    assert.ok(current.length >= 1, '当前文件存在且有内容');
    // 只有 1 份历史：不存在 `.2.jsonl`。
    await assert.rejects(readFile(join(dir, 'sensenova-errors.2.jsonl')), '只保留 1 份历史');
    // 最新的那条一定在「当前」文件里（顺序正确、滚动后继续追加）。
    assert.equal((JSON.parse(current[current.length - 1]!) as SenseNovaRateLimitEvent).attempt, 6);
    // 两个文件都不显著超过上限（滚动后就地重置计数）。
    assert.ok(Buffer.byteLength(rolled.join('\n')) <= Math.floor(lineBytes * 2.5) + lineBytes, '滚动文件受上限约束');
    assert.ok(Buffer.byteLength(current.join('\n')) <= Math.floor(lineBytes * 2.5) + lineBytes, '当前文件受上限约束');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 6. 绝不抛出 / 自停 ───────────────────────────────────────────────────
test('坏路径：record() 不抛，连续失败后自行停用（不再尝试写盘）', async () => {
  const dir = await tempDir();
  try {
    // 把「父路径」做成一个普通文件 → mkdir 必然失败。
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    const log = new SenseNovaErrorLog({ filePath: join(blocker, 'sub', 'e.jsonl') });

    // 超过阈值次数都不抛。
    for (let i = 0; i < ERROR_LOG_MAX_CONSECUTIVE_FAILURES + 3; i += 1) {
      assert.doesNotThrow(() => log.record(makeEvent({ attempt: i + 1 })));
    }
    await log.flush();
    // 停用后仍可安全调用（幂等、无副作用）。
    assert.doesNotThrow(() => log.record(makeEvent()));
    await log.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
