import test from 'node:test';
import assert from 'node:assert/strict';
import { accountRotationKey, interleavedAccounts } from '../src/index.ts';

test('accountRotationKey：解析「账户-序号」，Default 视为 1-0', () => {
  assert.deepEqual(accountRotationKey('Default'), { slot: 0, account: 1 });
  assert.deepEqual(accountRotationKey('2-3'), { slot: 3, account: 2 });
  assert.equal(accountRotationKey('自定义账户'), undefined);
});

test('interleavedAccounts：顺序排布 → 交替排布（对照实测关键）', () => {
  const seq = [
    { label: '1-0' }, { label: '1-1' }, { label: '1-2' },
    { label: '2-0' }, { label: '2-1' }, { label: '2-2' },
  ];
  const out = interleavedAccounts(seq).map((a) => a.label);
  assert.deepEqual(out, ['1-0', '2-0', '1-1', '2-1', '1-2', '2-2']);
  // 前 2 把覆盖 2 个账户（顺序排布前 2 把都在账户 1）
  assert.deepEqual(out.slice(0, 2), ['1-0', '2-0']);
});

test('interleavedAccounts：4 账户 × 2 序号', () => {
  const seq = [
    { label: '1-0' }, { label: '1-1' },
    { label: '2-0' }, { label: '2-1' },
    { label: '3-0' }, { label: '3-1' },
    { label: '4-0' }, { label: '4-1' },
  ];
  const out = interleavedAccounts(seq).map((a) => a.label);
  assert.deepEqual(out, ['1-0', '2-0', '3-0', '4-0', '1-1', '2-1', '3-1', '4-1']);
});

test('interleavedAccounts：含无法解析的 label 时保持原顺序', () => {
  const seq = [{ label: '1-0' }, { label: '自定义' }, { label: '2-0' }];
  assert.deepEqual(interleavedAccounts(seq).map((a) => a.label), ['1-0', '自定义', '2-0']);
});

test('interleavedAccounts：空数组与单账户', () => {
  assert.deepEqual(interleavedAccounts([]), []);
  assert.deepEqual(interleavedAccounts([{ label: '1-0' }]).map((a) => a.label), ['1-0']);
});
