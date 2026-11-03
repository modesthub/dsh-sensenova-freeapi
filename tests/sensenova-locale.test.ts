/**
 * 词条覆盖守卫（2026-11-02）。
 *
 * `t(key)` 的 key 是普通字符串，拼错了不会编译报错、只会在界面上显示原始 key ——
 * 这里静态扫一遍源码里用到的 key，保证中英文都有；顺带钉住「key 池状态不可用」区块
 * 已经删干净（用户明确要求去掉）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { en, zh } from '../src/client/locales.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

function usedKeys(file: string): string[] {
  const source = readFileSync(root + file, 'utf8');
  const keys = new Set<string>();
  for (const matched of source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'/g)) keys.add(matched[1]!);
  return [...keys];
}

test('分组编辑器用到的词条中英文都在', () => {
  const keys = usedKeys('src/client/key-pool-editor.tsx');
  assert.ok(keys.length > 20, `扫描到的词条太少（${keys.length}），正则可能失效`);
  assert.deepEqual(keys.filter((key) => !(key in zh)), []);
  assert.deepEqual(keys.filter((key) => !(key in en)), []);
});

test('调度区块的词条齐备（新增的菜单/空位文案缺一不可）', () => {
  const required = [
    'schedGroupsTitle',
    'schedGroupsHint',
    'schedGroupMenuHint',
    'schedGroupMergePrev',
    'schedGroupMergeNext',
    'schedGroupOrphanize',
    'schedGroupDrop',
    'schedGroupDropConfirm',
    'schedGroupRecover',
    'schedAccountMenuHint',
    'schedAccountMenuTitle',
    'schedAccountMenuDelete',
    'schedKeyIsolate',
    'schedKeyIsolateNote',
    'schedKeyInGroup',
    'schedEmptyHint',
    'schedEmptyKeyPlaceholder',
    'schedEmptyAddKey',
    'schedEmptyClose',
    'schedKeyLabelFixed',
  ];
  assert.deepEqual(required.filter((key) => !(key in zh)), []);
  assert.deepEqual(required.filter((key) => !(key in en)), []);
});

test('「key 池状态不可用」区块的文案已删除，中英文词条键集合对齐', () => {
  for (const key of Object.keys({ ...zh, ...en })) {
    assert.equal(/^keyStatus/.test(key), false, `残留词条：${key}`);
  }
  const zhOnly = Object.keys(zh).filter((key) => !(key in en));
  const enOnly = Object.keys(en).filter((key) => !(key in zh));
  assert.deepEqual(zhOnly, [], '中文有、英文缺');
  assert.deepEqual(enOnly, [], '英文有、中文缺');
});
