import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import {
  PROVIDER_RETRY_AFTER_CAP_MS,
  SensenovaAccountPool,
  accountUsable,
  markRejected,
  parseRetryAfterMs,
  selectActiveAccount,
  type AccountSlot,
  type RotationState,
} from '../src/accounts.ts';

function slot(id: string, key: string): AccountSlot {
  return { id, label: id, resolveKey: async () => key };
}

function poolOf(entries: Array<[string, string]>, preferredId?: string) {
  return new SensenovaAccountPool({
    slots: () => entries.map(([id, key]) => slot(id, key)),
    preferredId: preferredId === undefined ? undefined : () => preferredId,
  });
}

function states(pool: SensenovaAccountPool): Map<string, RotationState> {
  return pool.states;
}

test('parseRetryAfterMs 解析延迟秒数', () => {
  assert.equal(parseRetryAfterMs('30'), 30_000);
  assert.equal(parseRetryAfterMs('  5  '), 5_000);
});

test('parseRetryAfterMs 解析 HTTP-date', () => {
  const now = Date.parse('2024-01-01T00:00:00Z');
  const value = parseRetryAfterMs('Wed, 01 Jan 2024 00:00:30 GMT', now);
  assert.equal(value, 30_000);
  // 过去的 HTTP-date 返回 0
  assert.equal(parseRetryAfterMs('Mon, 01 Jan 2024 00:00:00 GMT', now), 0);
});

test('parseRetryAfterMs 缺失/不可解析返回 undefined', () => {
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(''), undefined);
  assert.equal(parseRetryAfterMs('not-a-date'), undefined);
});

test('markRejected: 429 不写任何状态（账号不做限流冷却）', () => {
  const map = new Map<string, RotationState>();
  markRejected(map, 'k', 'rate-limit');
  markRejected(map, 'k', 'rate-limit', 30_000);
  assert.equal(map.has('k'), false, 'rate-limit 不产生冷却/禁用状态');
  assert.equal(accountUsable(map.get('k')), true);
});

test('markRejected: quota-exhausted（配额类 429 粘性换 key）不写任何状态', () => {
  const map = new Map<string, RotationState>();
  markRejected(map, 'k', 'quota-exhausted');
  assert.equal(map.has('k'), false, 'quota-exhausted 只用于换 key，不产生冷却/禁用状态（design D5）');
  assert.equal(accountUsable(map.get('k')), true, '被配额拒绝的 key 保持可用');
});

test('PROVIDER_RETRY_AFTER_CAP_MS 与配额窗口量级对齐（60000ms）', () => {
  // fix-sensenova-429-quota-retry（2026-09-04 实测）：TPM 为 60 秒窗口，上限从 3000ms 提升。
  assert.equal(PROVIDER_RETRY_AFTER_CAP_MS, 60_000);
});

test('markRejected: 401 永久禁用', () => {
  const map = new Map<string, RotationState>();
  markRejected(map, 'k', 'invalid-credential');
  const state = map.get('k');
  assert.ok(state);
  assert.equal(state.kind, 'disabled');
  assert.equal(state.until, 0);
  assert.equal(accountUsable(state), false);
});

test('accountUsable: 未标记可用，disabled 不可用', () => {
  assert.equal(accountUsable(undefined), true);
  assert.equal(accountUsable({ kind: 'disabled', until: 0 }), false);
});

test('selectActiveAccount: 优先 preferredId，否则首个可用', async () => {
  const pool = poolOf([['a', 'ka'], ['b', 'kb']], 'a');
  let accounts = await pool.resolvedAccounts();
  let chosen = selectActiveAccount(accounts, 'a');
  assert.equal(chosen?.slot.id, 'a');

  states(pool).set('ka', { kind: 'disabled', until: 0 });
  accounts = await pool.resolvedAccounts();
  chosen = selectActiveAccount(accounts, 'a');
  assert.equal(chosen?.slot.id, 'b');

  chosen = selectActiveAccount(accounts, undefined);
  assert.equal(chosen?.slot.id, 'b');
});

test('resolveKey: activeAccount 优先，不可用回退首个可用', async () => {
  const pool = poolOf([['a', 'ka'], ['b', 'kb']], 'a');
  let resolved = await pool.resolveKey();
  assert.equal(resolved?.key, 'ka');

  states(pool).set('ka', { kind: 'disabled', until: 0 });
  resolved = await pool.resolveKey();
  assert.equal(resolved?.key, 'kb');
});

test('resolveKey: 全 disabled 抛 INVALID_CREDENTIAL', async () => {
  const pool = poolOf([['a', 'ka'], ['b', 'kb']]);
  states(pool).set('ka', { kind: 'disabled', until: 0 });
  states(pool).set('kb', { kind: 'disabled', until: 0 });
  await assert.rejects(pool.resolveKey(), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    return (err as LlmError).code === 'INVALID_CREDENTIAL';
  });
});

test('resolveKey: 429 标记后账号仍可用（不冷却、不换 key）', async () => {
  const pool = poolOf([['a', 'ka'], ['b', 'kb']]);
  pool.markRejected('ka', 'rate-limit', 900_000);
  const resolved = await pool.resolveKey();
  assert.equal(resolved?.key, 'ka', '429 后同 key 继续服务，保护 prompt 缓存');
});

test('resolveKey: 没有任何 key 返回 undefined', async () => {
  const pool = new SensenovaAccountPool({
    slots: () => [],
    preferredId: undefined,
  });
  assert.equal(await pool.resolveKey(), undefined);
});

test('状态以 key 为键去重：同 key 多槽位共享状态', async () => {
  const pool = poolOf([['a', 'shared'], ['b', 'shared']]);
  const accounts = await pool.resolvedAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.slot.id, 'a');

  pool.markRejected('shared', 'invalid-credential');
  await assert.rejects(pool.resolveKey(), (err: unknown) => {
    assert.ok(err instanceof LlmError);
    return (err as LlmError).code === 'INVALID_CREDENTIAL';
  });
});
