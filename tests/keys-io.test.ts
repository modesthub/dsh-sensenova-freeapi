import test from 'node:test';
import assert from 'node:assert/strict';
import { formatKeysText, parseKeysText } from '../src/keys-io.ts';

test('导入：账户N 分节 + 序号:密钥', () => {
  const text = ['账户2', '0:sk-aaaaaaaaaaaa', '1:sk-bbbbbbbbbbbb', '', '账户3', '0:sk-cccccccccccc'].join('\n');
  const { entries, errors } = parseKeysText(text);
  assert.equal(errors.length, 0);
  assert.deepEqual(entries.map((e) => e.label), ['2-0', '2-1', '3-0']);
});

test('导入：显式标签与 Default', () => {
  const text = ['Default:sk-defaultdefault', '2-3:sk-dddddddddddd'].join('\n');
  const { entries } = parseKeysText(text);
  assert.deepEqual(entries.map((e) => e.label), ['Default', '2-3']);
});

test('导入：裸密钥按出现顺序编号', () => {
  const text = ['sk-111111111111', 'sk-222222222222'].join('\n');
  const { entries } = parseKeysText(text);
  assert.deepEqual(entries.map((e) => e.label), ['key-1', 'key-2']);
});

test('导入：重复密钥只保留一条并记错误', () => {
  const text = ['1-0:sk-samesamesame', '1-1:sk-samesamesame'].join('\n');
  const { entries, errors } = parseKeysText(text);
  assert.equal(entries.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /重复/);
});

test('导入：非法行被跳过并报行号', () => {
  const text = ['这是一行废话', '1-0:not-a-key'].join('\n');
  const { entries, errors } = parseKeysText(text);
  assert.equal(entries.length, 0);
  assert.equal(errors.length, 2);
  assert.match(errors[0] ?? '', /第 1 行/);
  assert.match(errors[1] ?? '', /格式不合法/);
});

test('导入：注释与空行忽略', () => {
  const text = ['# 这是注释', '', '账户1', '0:sk-commentignore'].join('\n');
  const { entries, errors } = parseKeysText(text);
  assert.equal(errors.length, 0);
  assert.deepEqual(entries, [{ label: '1-0', key: 'sk-commentignore' }]);
});

test('导出：分组格式且可无损回读', () => {
  const entries = [
    { label: '2-1', key: 'sk-222222222222' },
    { label: '2-0', key: 'sk-111111111111' },
    { label: 'Default', key: 'sk-defaultdefault' },
  ];
  const text = formatKeysText(entries, { when: '2026-10-26T00:00:00.000Z' });
  assert.match(text, /账户2/);
  assert.match(text, /Default:sk-defaultdefault/);
  // 分组内按序号升序
  assert.ok(text.indexOf('0:sk-111111111111') < text.indexOf('1:sk-222222222222'));
  const back = parseKeysText(text);
  assert.equal(back.errors.length, 0);
  assert.deepEqual(
    back.entries.map((e) => e.label).sort(),
    ['2-0', '2-1', 'Default'],
  );
});

test('导出：空列表只输出表头', () => {
  const text = formatKeysText([]);
  assert.match(text, /^#/);
  assert.equal(parseKeysText(text).entries.length, 0);
});
