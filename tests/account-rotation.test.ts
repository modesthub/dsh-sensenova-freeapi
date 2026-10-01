/**
 * 账号轮换的覆盖性测试（2026-09-18）。
 *
 * 背景：`resolveKey({ exclude })` 旧写法是 `all.filter(k => k.key !== exclude)` 后取首选，
 * 而首选是"列表第一个可用项" ⇒ 排除 default 会选 account-2，再排除 account-2 又绕回
 * default（它仍是过滤后列表的首项）⇒ **前两把乒乓，第 3 把永远轮不到**。
 *
 * 实测证据：用户配了 3 把 key（三者哈希互异、均可用），但 9265 条 429 日志里只出现
 * 2 个账号指纹，且各占约一半。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SensenovaAccountPool, type AccountSlot } from '../src/accounts.ts';

function makeSlots(entries: ReadonlyArray<readonly [string, string]>): AccountSlot[] {
  return entries.map(([id, key]) => ({ id, label: id, resolveKey: async () => key }));
}

test('resolveKey: 轮换必须覆盖全部槽位（3 把 key 都要轮到）', async () => {
  const slots = makeSlots([
    ['default', 'key-default'],
    ['account-2', 'key-acc2'],
    ['account-3', 'key-acc3'],
  ]);
  const pool = new SensenovaAccountPool({ slots: () => slots, preferredId: () => undefined });

  const seen: string[] = [];
  let current: string | undefined;
  for (let step = 0; step < 6; step += 1) {
    const next = await pool.resolveKey(current === undefined ? undefined : { exclude: current });
    assert.ok(next !== undefined, `第 ${step} 步应有可选账户`);
    seen.push(next.key);
    current = next.key;
  }

  assert.deepEqual(
    seen,
    ['key-default', 'key-acc2', 'key-acc3', 'key-default', 'key-acc2', 'key-acc3'],
    '必须三把依次环回，而不是前两把乒乓',
  );
  assert.equal(new Set(seen).size, 3, '三把都要被用到');
});

test('resolveKey: 无 exclude 时仍取列表首项（不改变首次选择）', async () => {
  const slots = makeSlots([
    ['s0', 'key-a'],
    ['s1', 'key-b'],
    ['s2', 'key-c'],
  ]);
  const pool = new SensenovaAccountPool({ slots: () => slots, preferredId: () => undefined });
  assert.equal((await pool.resolveKey())?.key, 'key-a');
});

test('resolveKey: preferredId 优先于环回起点（修复不破坏钉选语义）', async () => {
  const slots = makeSlots([
    ['default', 'key-a'],
    ['account-2', 'key-b'],
    ['account-3', 'key-c'],
  ]);
  const pool = new SensenovaAccountPool({
    slots: () => slots,
    preferredId: () => 'account-3',
  });
  // 排除 key-a 后候选为 [key-b, key-c]，preferredId 指 account-3 ⇒ 应选 key-c
  // （若不修环回，旧实现也会选到 key-b，但那是"没得选"而非"优先"）。
  assert.equal((await pool.resolveKey({ exclude: 'key-a' }))?.key, 'key-c');
});

test('resolveKey: 唯一一把被排除 ⇒ undefined；exclude 不在列表 ⇒ 退回取首项', async () => {
  const single = makeSlots([['default', 'only-key']]);
  const pool = new SensenovaAccountPool({ slots: () => single, preferredId: () => undefined });
  assert.equal(await pool.resolveKey({ exclude: 'only-key' }), undefined);

  const three = makeSlots([
    ['s0', 'a'],
    ['s1', 'b'],
    ['s2', 'c'],
  ]);
  const pool2 = new SensenovaAccountPool({ slots: () => three, preferredId: () => undefined });
  assert.equal(
    (await pool2.resolveKey({ exclude: 'not-in-list' }))?.key,
    'a',
    'findIndex 为 -1 ⇒ 起点回退 0',
  );
});

test('resolveKey: 被标记 disabled 的槽位被跳过（401 后不重选它）', async () => {
  const slots = makeSlots([
    ['default', 'key-a'],
    ['account-2', 'key-b'],
  ]);
  const pool = new SensenovaAccountPool({ slots: () => slots, preferredId: () => undefined });
  pool.markRejected('key-a', 'invalid-credential');
  // 首次选择：key-a 已 disabled ⇒ 跳到 key-b
  assert.equal((await pool.resolveKey())?.key, 'key-b');
  // 排除 key-b 后只剩 disabled 的 key-a ⇒ 抛 INVALID_CREDENTIAL
  await assert.rejects(
    () => pool.resolveKey({ exclude: 'key-b' }),
    (error: unknown) => String((error as { code?: string }).code) === 'INVALID_CREDENTIAL',
  );
});
