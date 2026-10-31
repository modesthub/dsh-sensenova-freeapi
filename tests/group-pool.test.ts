/**
 * v0.5 P1 组池单测：组轮换 / 联动冷却 / 全池快返 / pending 在途 / AIMD gap。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GROUP_SCHEDULING,
  GroupGapController,
  SensenovaGroupPool,
  groupCooldownMs,
  groupGateKey,
  normalizeGroupScheduling,
  resolvedGroupScheduling,
  type GroupSchedulingConfig,
} from '../src/group-pool.ts';

/** 造一个 2 账户 × 3 组 的池（与 v0.5 单位请求组同构：组 i = {账户1-kᵢ, 账户2-kᵢ}）。 */
function makePool(
  overrides: { config?: GroupSchedulingConfig; now?: () => number; random?: () => number } = {},
): SensenovaGroupPool {
  const config = overrides.config ?? {};
  const pool = new SensenovaGroupPool({
    config: () => config,
    now: overrides.now ?? (() => 0),
    random: overrides.random ?? (() => 0), // jitter 恒 0 ⇒ 退避时长确定可断言
  });
  // 2 账户 × 3 组：账户1 → k1a/k2a/k3a，账户2 → k1b/k2b/k3b
  const dropped = pool.seed(
    [
      ['k1a', 'k1b'],
      ['k2a', 'k2b'],
      ['k3a', 'k3b'],
    ],
    (key) => (key.endsWith('a') ? 'account-1' : 'account-2'),
  );
  assert.equal(dropped.length, 0);
  return pool;
}

test('normalizeGroupScheduling: 非法输入回落全默认（绝不抛）', () => {
  assert.deepEqual(normalizeGroupScheduling(undefined), { ...DEFAULT_GROUP_SCHEDULING });
  assert.deepEqual(normalizeGroupScheduling(null), { ...DEFAULT_GROUP_SCHEDULING });
  assert.deepEqual(normalizeGroupScheduling('junk'), { ...DEFAULT_GROUP_SCHEDULING });
  const partial = normalizeGroupScheduling({ cooldownBaseMs: 120_000, enabled: false });
  assert.equal(partial.cooldownBaseMs, 120_000);
  assert.equal(partial.enabled, false);
  // 未覆盖字段被 normalize 省略（下游 resolvedGroupScheduling 补默认）
  assert.equal(partial.cooldownFactor, undefined);
  // 非法数值回落
  const bad = normalizeGroupScheduling({ cooldownJitter: 7, groupGapMinMs: -5 });
  assert.equal(bad.cooldownJitter, undefined);
  assert.equal(bad.groupGapMinMs, undefined);
});

test('resolvedGroupScheduling: 缺失字段补默认', () => {
  const resolved = resolvedGroupScheduling({ cooldownBaseMs: 60_000 });
  assert.equal(resolved.cooldownBaseMs, 60_000);
  assert.equal(resolved.cooldownFactor, DEFAULT_GROUP_SCHEDULING.cooldownFactor);
  assert.equal(resolved.enabled, true);
});

test('groupCooldownMs: 公式 min(base×factor^(n-1), max)×(1+U(0,jitter))', () => {
  const cfg = resolvedGroupScheduling({ cooldownBaseMs: 90_000, cooldownFactor: 2, cooldownMaxMs: 300_000, cooldownJitter: 0.5 });
  const noJitter = () => 0;
  // 第 1 次：base=90s；第 2 次：180s；第 3 次：300s（封顶 300）
  assert.equal(groupCooldownMs(1, cfg, noJitter), 90_000);
  assert.equal(groupCooldownMs(2, cfg, noJitter), 180_000);
  assert.equal(groupCooldownMs(3, cfg, noJitter), 300_000);
  assert.equal(groupCooldownMs(4, cfg, noJitter), 300_000);
  // jitter=0.5 恒满 ⇒ ×1.5
  assert.equal(groupCooldownMs(1, cfg, () => 1), 135_000);
});

test('seed: 建组 + 空组跳过 + 重复 key 丢弃 + 幂等保留状态', () => {
  const pool = makePool();
  assert.equal(pool.size, 3);
  const snap = pool.groupsSnapshot();
  assert.deepEqual(snap.map((g) => g.keys), [['k1a', 'k1b'], ['k2a', 'k2b'], ['k3a', 'k3b']]);
  assert.equal(pool.groupIndexOf('k2a'), 1);
  assert.equal(pool.groupIndexOf('nope'), undefined);

  // 重复 seed：相同组集合 ⇒ 状态保留（做一次冷却后重 seed 仍冷却）
  let now = 0;
  const pool2 = new SensenovaGroupPool({ config: () => ({}), now: () => now, random: () => 0 });
  pool2.seed([['x1', 'x2'], ['y1', 'y2']], () => 'acc');
  pool2.reportRateLimit({ key: 'x1', kind: 'tpm' });
  assert.equal(pool2.groupsSnapshot()[0].cooldownUntil, 90_000);
  const dropped = pool2.seed([['x1', 'x2'], ['y1', 'y2']], () => 'acc');
  assert.equal(dropped.length, 0);
  assert.equal(pool2.groupsSnapshot()[0].cooldownUntil, 90_000); // 状态延续
});

test('pickStart: 普通环回 + preferred 优先', () => {
  const pool = makePool();
  assert.equal(pool.pickStart(), 'k1a'); // 组0 第一把（账户1）
  assert.equal(pool.pickStart(), 'k1b'); // 组内交错：第二把（账户2）
  assert.equal(pool.pickStart(), 'k1a'); // 组内环回（第三把回到第一把）
  assert.equal(pool.pickStart(new Set(['k1a'])), 'k1b'); // exclude 跳过
  assert.equal(pool.pickStart(), 'k1a');
});

test('pickStart: 冷却中的组被跳过，pending>0 的冷却组仍可取', () => {
  let now = 1000;
  const pool = new SensenovaGroupPool({ config: () => ({}), now: () => now, random: () => 0 });
  pool.seed([['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3']], (key) => key.startsWith('a') ? 'acc-a' : 'acc-b');
  // 冷却组 0（a1 撞 429 → 组0 整冷 + acc-a 在组1/组2 被账户级标记）
  pool.reportRateLimit({ key: 'a1', kind: 'tpm' });
  assert.equal(pool.watchKey('a1')?.allCooled, false);
  // 组 0 冷却跳过；组 1 中 acc-a 的 a2 被标记 ⇒ 只取 b2
  assert.equal(pool.pickStart(), 'b2');
  // 时间推进到组 0 冷却结束 ⇒ 组 0 恢复
  now = 1000 + 90_000 + 1;
  assert.equal(pool.pickStart(), 'a1');
  // pending>0 的冷却组仍算可用（在途请求可能成功，不应被排斥）
  now = 0;
  pool.reportRateLimit({ key: 'a1', kind: 'tpm' });
  pool.markPending('a1', 1);
  const pickedPending = pool.pickStart();
  assert.notEqual(pickedPending, undefined);
  assert.equal(pool.groupIndexOf(pickedPending!), 0); // 冷却但有在途 ⇒ 组0 仍被选中
  pool.markPending('a1', -1);
  // pending 清零后冷却组被跳过：组0 冷却中（无在途）→ 组1 的 a2 被 acc-a 标记 → b2
  assert.equal(pool.pickStart(), 'b2');
});

test('全池冷却: pickStart 返回 undefined + watchKey.allCooled', () => {
  const pool = makePool(); // makePool 的 accountOf: key.endsWith('a') → account-1 / account-2
  // 全池冷却：k1a+k1b（组0）撞、k2a/k2b（组1）撞、k3a/k3b（组2）撞，加上账户级联动把所有账户都标记。
  pool.reportRateLimit({ key: 'k1a', kind: 'tpm' }); // 组0 整冷；账户1 标记组1/组2
  pool.reportRateLimit({ key: 'k1b', kind: 'tpm' }); // 组0 strikes=2；账户2 标记组1/组2
  pool.reportRateLimit({ key: 'k2a', kind: 'tpm' }); // 组1 整冷
  pool.reportRateLimit({ key: 'k2b', kind: 'tpm' }); // 组1 strikes=2  
  // 组2 未整冷，但 k3a（账户1）和 k3b（账户2）都被账户级标记 ⇒ 无可用
  assert.equal(pool.pickStart(), undefined);
  assert.equal(pool.watchKey('k1a')?.allCooled, true);
  assert.equal(pool.watchKey('k1a')?.groupIndex, 0);
  assert.equal(pool.watchKey('zzz'), undefined);
});

test('reportRateLimit: 账号级联动 — 同账户 key 在其他组被标记，本组整组退避', () => {
  // 账户1={k1a,k2a,k3a}(组0/1/2)，账户2={k1b,k2b,k3b}。
  // k1a 撞 429 ⇒ 组0 整组退避（k1a+k1b 都不可用）+ 账户1 在组1/组2 被账户级标记。
  const pool = makePool();
  pool.reportRateLimit({ key: 'k1a', kind: 'tpm' });
  const snap = pool.groupsSnapshot();
  assert.equal(snap[0].cooldownUntil, 90_000); // 组0 整组冷却
  assert.equal(snap[0].strikes, 1);
  // 组1/组2 不被整组冷却，仅账户1 的 key 不可用：
  assert.equal(snap[1].cooldownUntil, 0);
  assert.equal(snap[2].cooldownUntil, 0);
  // pickStart：组0 冷却跳过 → 组1 只取账户2 的 k2b（账户1 的 k2a 被账户级冷却排除）
  assert.equal(pool.pickStart(), 'k2b');
  // 组2 同理：k3b 可用
  pool.pickNext(); // 游标到组1
  assert.equal(pool.pickNext(), 'k3b'); // 组2 只剩 k3b
  // 账户2 也能撞：k1b 撞 429 ⇒ 组0 已冷却再加 strikes=2 → 180s；账户2 在组1/组2 被标记
  pool.reportRateLimit({ key: 'k1b', kind: 'rpm' });
  const snap2 = pool.groupsSnapshot();
  assert.equal(snap2[0].cooldownUntil, 90_000 + 90_000); // strikes 2 → 180s（相对 now=0）
  assert.equal(snap2[0].strikes, 2);
  // onSuccess 清账户级联动（组1/组2 的账户1 标记撤销）：
  pool.onSuccess('k2a'); // 账户1 成功
  const snap3 = pool.groupsSnapshot();
  assert.equal(snap3[1].accountCooldown.has('account-1'), false);
  assert.equal(snap3[2].accountCooldown.has('account-1'), false);
  // 但组0 的整组冷却仍在（那是组级状态，不由账户成功清除）
  assert.equal(snap3[0].cooldownUntil > 0, true);
});

test('onSuccess: 清冷却与 strikes（成功是组已恢复的最强证据）', () => {
  let now = 0;
  const pool = new SensenovaGroupPool({ config: () => ({}), now: () => now, random: () => 0 });
  pool.seed([['a1', 'a2'], ['b1', 'b2']], (key) => key.endsWith('1') ? 'account-1' : 'account-2');
  pool.reportRateLimit({ key: 'a1', kind: 'tpm' });
  assert.equal(pool.groupsSnapshot()[0].strikes, 1);
  // 账户1 的 b1 在组1 也被标记
  assert.equal(pool.groupsSnapshot()[1].accountCooldown.get('account-1'), 90_000);
  pool.onSuccess('a1');
  assert.equal(pool.groupsSnapshot()[0].cooldownUntil, 0);
  assert.equal(pool.groupsSnapshot()[0].strikes, 0);
  assert.equal(pool.groupsSnapshot()[1].accountCooldown.has('account-1'), false); // 联动标记撤销
});

test('remove: 401 永久摘除 key（组保留其余）', () => {
  const pool = makePool();
  pool.remove('k1a');
  assert.equal(pool.groupIndexOf('k1a'), undefined);
  assert.deepEqual(pool.groupsSnapshot()[0].keys, ['k1b']);
  assert.equal(pool.pickStart(), 'k1b');
});

test('pickNext: 推进组游标（轮换语义）', () => {
  const pool = makePool(); // 组0={k1a,k1b} 组1={k2a,k2b} 组2={k3a,k3b}；账户1=endsWith('a')
  assert.equal(pool.pickNext(), 'k2a'); // 游标 0 → 下一组 1（账户1 的 k2a）
  assert.equal(pool.pickNext(), 'k3a'); // 游标 1 → 下一组 2
  assert.equal(pool.pickNext(), 'k1a'); // 游标 2 → 环回组 0
  assert.equal(pool.pickNext(), 'k2a'); // 游标 0 → 组 1
  // 冷却组 0（k1a 撞 429）→ 组0 整冷、账户1 在组1/组2 被标记
  pool.reportRateLimit({ key: 'k1a', kind: 'tpm' });
  assert.equal(pool.pickNext(), 'k3b'); // 跳过组0 → 组2：k3a 账户冷却 → k3b，落位组2
  assert.equal(pool.pickNext(), 'k2b'); // 环回组1：k2a 账户冷却 → k2b，落位组1
  assert.equal(pool.pickNext(), 'k3b'); // 跳过组0 → 组2 只剩 k3b
  // exclude：组2 全排除时跳过组2，落位组1 的 k2b（k2a 账户冷却）
  assert.equal(pool.pickNext(new Set(['k3b'])), 'k2b');
  // 全池 429 打到无可用 → undefined（fail-fast 快返路径）
  pool.reportRateLimit({ key: 'k2b', kind: 'tpm' }); // 组1 整冷，账户2 标记组0/组2
  pool.reportRateLimit({ key: 'k3b', kind: 'tpm' }); // 组2 整冷
  assert.equal(pool.pickNext(), undefined);
});

test('groupGateKey: `group:` 前缀键', () => {
  assert.equal(groupGateKey(0), 'group:0');
  assert.equal(groupGateKey(3), 'group:3');
});

// ── AIMD 组间隙 ──────────────────────────────────────────────────────────────

test('GroupGapController: 初始 gap + recordHit 放大封顶', () => {
  let now = 0;
  const gap = new GroupGapController({ config: () => ({}), now: () => now });
  assert.equal(gap.gapMs(), DEFAULT_GROUP_SCHEDULING.initialGroupGapMs); // 2000
  gap.recordHit();
  assert.equal(gap.gapMs(), 3_000); // 2000 × 1.5
  gap.recordHit();
  assert.equal(gap.gapMs(), 4_500);
  // 封顶 30000
  for (let i = 0; i < 20; i += 1) gap.recordHit();
  assert.equal(gap.gapMs(), 30_000);
});

test('GroupGapController: recordSuccess 衰减（下限 500）且按恢复窗口防抖', () => {
  let now = 0;
  const gap = new GroupGapController({ config: () => ({}), now: () => now });
  gap.recordHit(); // gap=3000, lastHitAt=0
  // 成功但未过 8s 窗口 ⇒ 不衰减
  now = 5_000;
  gap.recordSuccess();
  assert.equal(gap.gapMs(), 3_000);
  // 8s 窗口到达（距上次 429 已 ≥8s）⇒ ×0.95 衰减一次
  now = 8_000;
  const atWindow = gap.recordSuccess();
  assert.equal(atWindow, 2_850);
  // 同一窗口内再成功 ⇒ 防抖不叠乘（每 8s 至多衰减一次）
  now = 8_100;
  gap.recordSuccess();
  assert.equal(gap.gapMs(), 2_850);
  // 新窗口 ⇒ 再衰减一次
  now = 17_000;
  const second = gap.recordSuccess();
  assert.equal(second, 2_708); // 2850×0.95=2707.5 → round 2708
  // 下限 500：持续无 429 反复衰减直至触底
  for (let i = 0; i < 200; i += 1) {
    now += 8_000;
    gap.recordSuccess();
  }
  assert.equal(gap.gapMs(), 500);
});

test('GroupGapController: 撞击重置恢复窗口（429 打断衰减）', () => {
  let now = 0;
  const gap = new GroupGapController({ config: () => ({}), now: () => now });
  gap.recordHit(); // 3000
  now = 10_000;
  gap.recordSuccess(); // 衰减 → 2850
  gap.recordHit(); // 429 打断 ⇒ 2850×1.5=4275
  assert.equal(gap.gapMs(), 4_275);
  now = 12_000;
  gap.recordSuccess(); // 距上次 429 仅 2s ⇒ 不衰减
  assert.equal(gap.gapMs(), 4_275);
});

test('GroupGapController: reset 回初始', () => {
  const gap = new GroupGapController({ config: () => ({}), now: () => 0 });
  gap.recordHit();
  gap.recordHit();
  assert.notEqual(gap.gapMs(), DEFAULT_GROUP_SCHEDULING.initialGroupGapMs);
  gap.reset();
  assert.equal(gap.gapMs(), DEFAULT_GROUP_SCHEDULING.initialGroupGapMs);
});