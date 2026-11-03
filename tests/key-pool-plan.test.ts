/**
 * 分组计划纯逻辑单测（2026-11-02）。
 *
 * 这些函数决定「拖一下之后每把 key 归哪一组」——算错了界面照样好看、只是轮转顺序
 * 悄悄不对，所以每条语义都用「展开成槽位序列」的方式钉死，而不是只比 sizes 数组。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptTailOrphans,
  buildPoolRows,
  defaultSizes,
  dropGroupAt,
  isolateKeyAt,
  mergeGroupAt,
  normalizePlan,
  orphanGroupAt,
  primeOf,
  resizeEdge,
  rotationSeq,
  rotationTicks,
  distinctAccountCount,
  minGroupGapMs,
  smartGroupGapMs,
  smartSizes,
  splitLast,
  withRowPlan,
  type PoolKeyRef,
  type SchedGroupPlan,
} from '../src/client/key-pool-plan.ts';

type Shape = { sizes: number[]; gaps: number[] };

/** 把形状展开成槽位序列：组号重复、空档记 '.'，用来直观断言「哪把 key 归哪组」。 */
function expand(shape: Shape): string[] {
  const out: string[] = [];
  for (let i = 0; i < shape.sizes.length; i += 1) {
    for (let g = 0; g < (shape.gaps[i] ?? 0); g += 1) out.push('.');
    for (let k = 0; k < shape.sizes[i]!; k += 1) out.push(String(i));
  }
  for (let g = 0; g < (shape.gaps[shape.sizes.length] ?? 0); g += 1) out.push('.');
  return out;
}

function total(shape: Shape): number {
  return shape.sizes.reduce((a, b) => a + b, 0) + shape.gaps.reduce((a, b) => a + b, 0);
}

/** 每次变形都必须守恒：槽位总数不变（孤立 key 只是从组里挪进空档）。 */
function expectConserved(before: Shape, after: Shape | undefined): Shape {
  assert.ok(after !== undefined);
  assert.equal(after.gaps.length, after.sizes.length + 1, 'gaps 长度必须 = sizes + 1');
  assert.equal(total(after), total(before), '槽位总数守恒');
  return after;
}

test('resizeEdge 右边缘：先吞右侧空档，再吃右邻组头（右邻保底 1 把）', () => {
  const before = { sizes: [2, 2], gaps: [0, 1, 0] };
  assert.deepEqual(expand(before), ['0', '0', '.', '1', '1']);
  const after = expectConserved(before, resizeEdge(before.sizes, before.gaps, 0, 'right', 1));
  assert.deepEqual(expand(after), ['0', '0', '0', '1', '1']);

  const noGap = { sizes: [2, 3], gaps: [0, 0, 0] };
  assert.deepEqual(expand(noGap), ['0', '0', '1', '1', '1']);
  assert.deepEqual(expand(expectConserved(noGap, resizeEdge(noGap.sizes, noGap.gaps, 0, 'right', 1))), ['0', '0', '0', '1', '1']);

  // 右邻只剩 1 把时不能吃空它
  assert.equal(resizeEdge([2, 1], [0, 0, 0], 0, 'right', 1), undefined);
  assert.equal(resizeEdge([2], [0, 0], 0, 'right', 1), undefined);
});

test('resizeEdge 右边缘向左缩：尾把脱出成空档，组保底 1 把', () => {
  const before = { sizes: [3, 2], gaps: [0, 0, 0] };
  assert.deepEqual(expand(expectConserved(before, resizeEdge(before.sizes, before.gaps, 0, 'right', -1))), ['0', '0', '.', '1', '1']);
  assert.equal(resizeEdge([1, 2], [0, 0, 0], 0, 'right', -1), undefined);
});

test('resizeEdge 左边缘向左扩：先吞左侧空档，再吃左邻组尾（左邻保底 1 把）', () => {
  const withGap = { sizes: [2, 2], gaps: [0, 1, 0] };
  assert.deepEqual(expand(expectConserved(withGap, resizeEdge(withGap.sizes, withGap.gaps, 1, 'left', -1))), ['0', '0', '1', '1', '1']);

  const noGap = { sizes: [3, 2], gaps: [0, 0, 0] };
  assert.deepEqual(expand(expectConserved(noGap, resizeEdge(noGap.sizes, noGap.gaps, 1, 'left', -1))), ['0', '0', '1', '1', '1']);

  assert.equal(resizeEdge([1, 2], [0, 0, 0], 1, 'left', -1), undefined);
});

test('resizeEdge 左边缘向右缩：头把脱出成空档，行首组没有左手柄', () => {
  const before = { sizes: [2, 3], gaps: [0, 0, 0] };
  assert.deepEqual(expand(expectConserved(before, resizeEdge(before.sizes, before.gaps, 1, 'left', 1))), ['0', '0', '.', '1', '1']);

  // 行首组：start = 0 ⇒ 无法再缩
  assert.equal(resizeEdge([3], [0, 0], 0, 'left', 1), undefined);
  // 组前面没有空档且是行首组也缩不动（即使 size > 1）
  assert.equal(resizeEdge([3, 2], [0, 0, 0], 0, 'left', 1), undefined);
  // size = 1 时同样缩不动
  assert.equal(resizeEdge([2, 1], [0, 0, 0], 1, 'left', 1), undefined);
});

test('mergeGroupAt：并入前组 / 后组都把中间空档一起带走', () => {
  const before = { sizes: [2, 3, 2], gaps: [0, 1, 2, 0] };
  assert.deepEqual(expand(before), ['0', '0', '.', '1', '1', '1', '.', '.', '2', '2']);

  const prev = expectConserved(before, mergeGroupAt(before.sizes, before.gaps, 1, 'prev'));
  // 组是位置性的：并掉第 1 组之后，原来的第 2 组改叫第 1 组
  assert.deepEqual(expand(prev), ['0', '0', '0', '0', '0', '0', '.', '.', '1', '1']);

  const next = expectConserved(before, mergeGroupAt(before.sizes, before.gaps, 1, 'next'));
  // 组是位置性的：并掉第 1 组之后，原来的第 2 组改叫第 1 组
  assert.deepEqual(expand(next), ['0', '0', '.', '1', '1', '1', '1', '1', '1', '1']);

  assert.equal(mergeGroupAt([3], [0, 0], 0, 'prev'), undefined);
  assert.equal(mergeGroupAt(before.sizes, before.gaps, 0, 'prev'), undefined);
  assert.equal(mergeGroupAt(before.sizes, before.gaps, 2, 'next'), undefined);
});

test('dropGroupAt：前后空档合并，槽位数减掉这一组的把数（key 随后才删）', () => {
  const before = { sizes: [2, 3, 2], gaps: [0, 1, 2, 0] };
  const after = dropGroupAt(before.sizes, before.gaps, 1);
  assert.ok(after !== undefined);
  assert.equal(after.gaps.length, after.sizes.length + 1);
  assert.equal(total(after), total(before) - 3);
  assert.deepEqual(expand(after), ['0', '0', '.', '.', '.', '1', '1']);
  assert.equal(dropGroupAt([3], [0, 0], 0), undefined);
});

test('orphanGroupAt：整组变孤立，组标签消失（至少留一组）', () => {
  const before = { sizes: [2, 3, 2], gaps: [0, 1, 2, 0] };
  const after = expectConserved(before, orphanGroupAt(before.sizes, before.gaps, 1));
  assert.deepEqual(after.sizes, [2, 2]);
  assert.deepEqual(expand(after), ['0', '0', '.', '.', '.', '.', '.', '.', '1', '1']);
  assert.equal(orphanGroupAt([3], [0, 0], 0), undefined);
});

test('isolateKeyAt：头把 / 尾把 / 中间那把（一分为二，中间夹空档）', () => {
  const base = { sizes: [4], gaps: [0, 0] };
  assert.deepEqual(expand(expectConserved(base, isolateKeyAt(base.sizes, base.gaps, 0, 0))), ['.', '0', '0', '0']);
  assert.deepEqual(expand(expectConserved(base, isolateKeyAt(base.sizes, base.gaps, 0, 3))), ['0', '0', '0', '.']);
  assert.deepEqual(expand(expectConserved({ sizes: [5], gaps: [0, 0] }, isolateKeyAt([5], [0, 0], 0, 2))), ['0', '0', '.', '1', '1']);
  assert.equal(isolateKeyAt([1], [0, 0], 0, 0), undefined);
  assert.equal(isolateKeyAt([3], [0, 0], 0, 3), undefined);
});

test('adoptTailOrphans / splitLast：行尾 + 的两种语义', () => {
  const adopt = expectConserved({ sizes: [2, 3], gaps: [0, 0, 2] }, adoptTailOrphans([2, 3], [0, 0, 2]));
  assert.deepEqual(expand(adopt), ['0', '0', '1', '1', '1', '2', '2']);
  assert.equal(adoptTailOrphans([2, 3], [0, 0, 0]), undefined);

  // 4 把 → cut = min(4, ⌊4/2⌋) = 2 ⇒ 2 + 2
  assert.deepEqual(expand(expectConserved({ sizes: [4], gaps: [0, 0] }, splitLast([4], [0, 0]))), ['0', '0', '1', '1']);
  // 6 把 → cut = min(4, 3) = 3 ⇒ 3 + 3
  assert.deepEqual(expand(expectConserved({ sizes: [6], gaps: [0, 0] }, splitLast([6], [0, 0]))), ['0', '0', '0', '1', '1', '1']);
  // 3 把 → cut = 1 ⇒ 2 + 1
  assert.deepEqual(expand(expectConserved({ sizes: [3], gaps: [0, 0] }, splitLast([3], [0, 0]))), ['0', '0', '1']);
  assert.equal(splitLast([1], [0, 0]), undefined);
  // 尾部空档随新组顺延
  const withTail = expectConserved({ sizes: [4], gaps: [0, 2] }, splitLast([4], [0, 2]));
  assert.deepEqual(withTail.gaps, [0, 0, 2]);
});

test('normalizePlan：非法项剔除、溢出截断、差额落尾部空档、空计划回落缺省', () => {
  const odd = normalizePlan([4, 0, -1, 3], [0, 1, 1, 0], 7, 'by-account');
  assert.deepEqual(odd.sizes, [4, 2]);
  assert.deepEqual(odd.gaps, [0, 1, 0]);

  // 组数比 key 多：后面的组被截断，不会凭空造 key
  assert.deepEqual(normalizePlan([5, 5], [0, 0, 0], 5, 'by-account').sizes, [5]);

  // 完全没计划 ⇒ 缺省形状
  assert.deepEqual(normalizePlan([], undefined, 3, 'by-account').sizes, [3]);
  assert.deepEqual(normalizePlan([0, 0], [0, 0, 0], 3, 'by-slot').sizes, [1, 1, 1]);
  assert.deepEqual(defaultSizes(3, 'by-slot'), [1, 1, 1]);

  // 计划比 key 少 ⇒ 尾部空档吃掉差额（孤立 key）
  const short = normalizePlan([2], [0], 4, 'by-account');
  assert.deepEqual(short.sizes, [2]);
  assert.deepEqual(short.gaps, [0, 2]);
});

test('withRowPlan：与缺省形状相同则移除计划项，否则按账户号有序插入', () => {
  const row = {
    account: 2,
    keys: [],
    sizes: [4],
    gaps: [0, 0],
    explicit: false,
    starts: [0],
    orphans: 0,
  };
  const plan: SchedGroupPlan[] = [{ account: 1, sizes: [2], gaps: [0, 2] }, { account: 3, sizes: [1, 1], gaps: [0, 0, 0] }];
  assert.deepEqual(withRowPlan(plan, { ...row, keys: Array.from({ length: 4 }, () => ({} as PoolKeyRef)) }, { sizes: [4], gaps: [0, 0] }, 'by-account'), plan);

  const next = withRowPlan(plan, { ...row, keys: Array.from({ length: 4 }, () => ({} as PoolKeyRef)) }, { sizes: [3], gaps: [0, 1] }, 'by-account');
  assert.deepEqual(next.map((entry) => entry.account), [1, 2, 3]);
  assert.deepEqual(next[1], { account: 2, sizes: [3], gaps: [0, 1] });
});

test('buildPoolRows：按账户/槽位排序，缺省计划与显式计划并存，孤立数来自空档', () => {
  const makeKey = (id: string, account: number, slot: number): PoolKeyRef => ({
    id,
    account,
    slot,
    label: `${account}-${slot}`,
    plainLabel: `${account}-${slot}`,
    labelDraft: '',
    keyDraft: '',
    configured: true,
    writable: true,
    clearStaged: false,
    isDefault: false,
  });
  const keys = [
    makeKey('a', 2, 1),
    makeKey('b', 1, 1),
    makeKey('c', 1, 0),
    makeKey('d', 2, 0),
    makeKey('e', 1, 2),
  ];
  const rows = buildPoolRows(keys, [{ account: 1, sizes: [2], gaps: [0, 1] }], 'by-account');
  assert.deepEqual(rows.map((entry) => entry.account), [1, 2]);
  assert.deepEqual(rows[0]!.keys.map((key) => key.id), ['c', 'b', 'e']);
  assert.deepEqual(rows[0]!.sizes, [2]);
  assert.deepEqual(rows[0]!.gaps, [0, 1]);
  assert.deepEqual(rows[0]!.starts, [0]);
  assert.equal(rows[0]!.orphans, 1);
  assert.equal(rows[0]!.explicit, true);
  assert.deepEqual(rows[1]!.sizes, [2]);
  assert.equal(rows[1]!.explicit, false);
});

test('rotationSeq：宏观按账户轮转，微观各组游标独立前进', () => {
  const rows = [
    { account: 1, keys: [], sizes: [2, 2], gaps: [0, 0, 0], explicit: true, starts: [0, 2], orphans: 0 },
    { account: 2, keys: [], sizes: [3], gaps: [0, 0], explicit: true, starts: [0], orphans: 0 },
  ];
  const seq = rotationSeq(rows, 6);
  assert.deepEqual(seq.map((step) => `${step.account}${primeOf(step.ordinal)}`), ['1', '2', "1′", '2', '1', '2']);
});

test('rotationTicks：两轮按账户宏观轮转，组内按 slot 顺序，每把每轮一次', () => {
  const makeKey = (id: string, account: number, slot: number): PoolKeyRef => ({
    id,
    account,
    slot,
    label: `${account}-${slot}`,
    plainLabel: `${account}-${slot}`,
    labelDraft: '',
    keyDraft: '',
    configured: true,
    writable: true,
    clearStaged: false,
    isDefault: false,
  });
  const rows = buildPoolRows(
    [
      makeKey('a0', 1, 0), makeKey('a1', 1, 1), makeKey('a2', 1, 2), makeKey('a3', 1, 3),
      makeKey('b0', 2, 0), makeKey('b1', 2, 1), makeKey('b2', 2, 2), makeKey('b3', 2, 3),
    ],
    [
      { account: 1, sizes: [2, 2], gaps: [0, 0, 0] },
      { account: 2, sizes: [2, 2], gaps: [0, 0, 0] },
    ],
    'by-account',
  );

  const ticks = rotationTicks(rows, 2);
  assert.equal(ticks.length, 16, '2 账户 × 2 组 × 2 把，共 2 轮');
  assert.deepEqual(
    ticks.slice(0, 8).map((tick) => `${tick.account}-g${tick.group}-k${tick.offset}`),
    ['1-g0-k0', '1-g0-k1', '2-g0-k0', '2-g0-k1', '1-g1-k0', '1-g1-k1', '2-g1-k0', '2-g1-k1'],
  );
  assert.deepEqual(ticks.slice(0, 8).map((tick) => tick.round), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(ticks[8]!.round, 2, '第二轮从账户 1 的第 1 组重来');
  assert.equal(ticks[8]!.account, 1);
  assert.equal(ticks[8]!.group, 0);
  assert.equal(ticks[8]!.offset, 0);

  const uses = new Map<string, number>();
  for (const tick of ticks) uses.set(tick.key.id, (uses.get(tick.key.id) ?? 0) + 1);
  assert.deepEqual([...uses.values()], [2, 2, 2, 2, 2, 2, 2, 2], '每把 key 恰好两轮各用一次');
  assert.deepEqual(rotationTicks(rows, 0), []);

  // 429 轮次预算可调：演示序列的轮数必须跟着走（3 轮 = 24 次尝试）。
  const three = rotationTicks(rows, 3);
  assert.equal(three.length, 24);
  assert.equal(three[0]!.rounds, 3);
  assert.equal(three[23]!.round, 3);
});

test('smartSizes：每段 4 把，余数单独成组', () => {
  assert.deepEqual(smartSizes(16), [4, 4, 4, 4]);
  assert.deepEqual(smartSizes(18), [4, 4, 4, 4, 2]);
  assert.deepEqual(smartSizes(5), [4, 1]);
  assert.deepEqual(smartSizes(4), [4]);
  assert.deepEqual(smartSizes(1), [1]);
  assert.deepEqual(smartSizes(0), []);
});

test('smartGroupGapMs：按账户数给推荐组间定时，且满足 (n−1)×gap ≥ 60s', () => {
  assert.equal(smartGroupGapMs(1), 60_000);
  assert.equal(smartGroupGapMs(2), 60_000);
  assert.equal(smartGroupGapMs(3), 30_000);
  assert.equal(smartGroupGapMs(4), 20_000);
  assert.equal(smartGroupGapMs(5), 20_000);
  assert.equal(smartGroupGapMs(8), 20_000);
  assert.equal(smartGroupGapMs(0), 0);
  for (const n of [1, 2, 3, 4, 5, 8, 12]) {
    const gap = smartGroupGapMs(n);
    assert.ok((n - 1) * gap >= (n > 1 ? 60_000 : 0), `${n} 账户: (n-1)*gap=${(n-1)*gap} 应 ≥ 60s`);
  }
});

test('minGroupGapMs：手动调低时保证 (n−1)×gap ≥ 60s 的下限', () => {
  assert.equal(minGroupGapMs(1), 0);
  assert.equal(minGroupGapMs(2), 60_000);
  assert.equal(minGroupGapMs(3), 30_000);
  assert.equal(minGroupGapMs(4), 20_000);
  assert.equal(minGroupGapMs(5), 15_000);
  assert.equal(minGroupGapMs(8), 8_572);
});

test('distinctAccountCount：按账户号去重（default 即账户 1）', () => {
  assert.equal(distinctAccountCount(['Default']), 1);
  assert.equal(distinctAccountCount(['Default', '1-1', '1-2']), 1);
  assert.equal(distinctAccountCount(['Default', '2-0', '2-1']), 2);
  assert.equal(distinctAccountCount(['1-0', '2-3', '3-0', '4-1']), 4);
  assert.equal(distinctAccountCount(['1-0', '2-3', '3-0', '4-1', '5-0', '6-1']), 6);
  assert.equal(distinctAccountCount([]), 0);
  assert.equal(distinctAccountCount(['自定义']), 0);
});


test('distinctAccountCount：按账户号去重（default 即账户 1）', () => {
  assert.equal(distinctAccountCount(['Default']), 1);
  assert.equal(distinctAccountCount(['Default', '1-1', '1-2']), 1);
  assert.equal(distinctAccountCount(['Default', '2-0', '2-1']), 2);
  assert.equal(distinctAccountCount(['1-0', '2-3', '3-0', '4-1']), 4);
  assert.equal(distinctAccountCount(['1-0', '2-3', '3-0', '4-1', '5-0', '6-1']), 6);
  assert.equal(distinctAccountCount([]), 0);
  assert.equal(distinctAccountCount(['自定义']), 0);
});




