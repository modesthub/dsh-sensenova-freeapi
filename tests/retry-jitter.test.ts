/**
 * W9（2026-09-17）专属测试：429 退避的两个纯函数。
 *
 * 背景：原先「基础值计算」与「抖动应用」耦合在 `httpError` 内，且用
 * `Math.min(base * (1 + random*0.3), CEILING)` 一步完成 —— base 贴近天花板时
 * 上抖会被 `Math.min` 吃掉，返回值塌到同一个常量，并发会话同时醒来（惊魂回归）。
 * 抽出为纯函数后，两条不变量可以逐条断言：
 *   ① 只向后推迟（>= min(base, ceiling)）；
 *   ② 绝不越过天花板（<= ceiling；越过它 = 宿主 `pra > maxDelayMs` 直接放弃重试）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  QUOTA_RETRY_AFTER_CEILING_MS,
  TPM_PROBE_BACKOFF_STEPS_MS,
  applyUpwardJitter,
  classify429Body,
  plan429RetryAfterMs,
} from '../src/adapter.ts';

const CEIL = QUOTA_RETRY_AFTER_CEILING_MS;

test('W9: applyUpwardJitter 的两条不变量（只向后推迟、绝不越过天花板）', () => {
  // 抖动空间充足：random=0 → 等于 base（绝不提前）；random=1 → base×1.3
  assert.equal(applyUpwardJitter(10_000, CEIL, () => 0), 10_000, 'random=0 返回 base');
  assert.equal(applyUpwardJitter(10_000, CEIL, () => 1), 13_000, 'random=1 返回 base×1.3');

  // 抖动空间不足（base 贴近天花板）：退让方向是「往小抖」，而不是被截断成常量
  assert.equal(applyUpwardJitter(290_000, CEIL, () => 0), 290_000);
  assert.equal(applyUpwardJitter(290_000, CEIL, () => 1), CEIL, '刚好到顶但不越界');

  // 已经等于 / 超过天花板
  assert.equal(applyUpwardJitter(CEIL, CEIL, () => 0.5), CEIL);
  assert.equal(applyUpwardJitter(CEIL + 1, CEIL, () => 0.5), CEIL, '越界输入被夹回天花板');

  // 批量不变量（含 > 天花板的越界输入）
  for (let i = 0; i < 3_000; i += 1) {
    const base = Math.round(Math.random() * 420_000);
    const value = applyUpwardJitter(base, CEIL, Math.random);
    assert.ok(value <= CEIL, `不变量②：${value} 越过了天花板 ${CEIL}`);
    assert.ok(value >= Math.min(base, CEIL), `不变量①：${value} 早于 min(base, ceiling)`);
  }
});

test('W9: 贴近天花板时仍保持有效抖动（旧写法的惊群回归点）', () => {
  const BASE = 290_000;
  const N = 2_000;

  // 旧写法 Math.min(base*(1+random*0.3), CEIL)：base×(1+0.3r) ≥ 300000 需要 r ≥ 0.115，
  // 即只有 ~11.5% 的样本够不到天花板，其余 **~88.5% 全部塌到同一个 CEIL**
  // ⇒ 并发会话同时醒来（0916 惊群的复现点）。
  let collapsedLegacy = 0;
  for (let i = 0; i < N; i += 1) {
    if (Math.min(Math.round(BASE * (1 + Math.random() * 0.3)), CEIL) === CEIL) collapsedLegacy += 1;
  }
  const legacyRatio = collapsedLegacy / N;
  assert.ok(
    legacyRatio > 0.85,
    '旧写法应有 ~88.5% 样本塌到天花板（理论 r ≥ (CEIL/base−1)/0.3 = 0.1149 ⇒ 塌陷 88.5%），实测 '
      + (legacyRatio * 100).toFixed(1) + '%',
  );

  // 新写法：在 (base, CEIL] 上铺开 ⇒ 塌陷率应远低于旧写法，均值落在区间中部
  let collapsedNew = 0;
  let sumNew = 0;
  for (let i = 0; i < N; i += 1) {
    const value = applyUpwardJitter(BASE, CEIL, Math.random);
    sumNew += value;
    if (value === CEIL) collapsedNew += 1;
  }
  const newRatio = collapsedNew / N;
  const avgNew = sumNew / N;
  assert.ok(newRatio < 0.05, '新写法塌陷率应 <5%，实测 ' + (newRatio * 100).toFixed(1) + '%');
  assert.ok(
    avgNew < CEIL - 3_000,
    '新写法均值应落在区间中部附近，实测 ' + Math.round(avgNew) + '（天花板 ' + CEIL + '）',
  );
});

test('W9: plan429RetryAfterMs 的基础值决策', () => {
  const cls = classify429Body(JSON.stringify({ error: { code: 429001, message: 'tpm exhausted' } }));
  type Cls = Parameters<typeof plan429RetryAfterMs>[0];

  // 动态探测档优先于静态 floor
  assert.deepEqual(plan429RetryAfterMs(cls, 30_000, undefined), {
    baseMs: 30_000,
    respectHeader: false,
  });
  // 无动态档 → 用静态 floor（429001 起档 3s）
  assert.deepEqual(plan429RetryAfterMs(cls, undefined, undefined), {
    baseMs: TPM_PROBE_BACKOFF_STEPS_MS[0],
    respectHeader: false,
  });
  // 网关头 ≥ 下限 → 采信网关（服务端指令，不抖动）
  assert.deepEqual(plan429RetryAfterMs(cls, 30_000, 45_000), { baseMs: 45_000, respectHeader: true });
  assert.deepEqual(plan429RetryAfterMs(cls, 30_000, 30_000), { baseMs: 30_000, respectHeader: true });
  // 网关头 < 下限 → 用下限（下限是"最早可重试时刻"，不能被压低）
  assert.deepEqual(plan429RetryAfterMs(cls, 30_000, 10_000), {
    baseMs: 30_000,
    respectHeader: false,
  });
  // 无效头（0 / 负数）一律丢弃
  assert.deepEqual(plan429RetryAfterMs(cls, 30_000, 0), { baseMs: 30_000, respectHeader: false });
  assert.deepEqual(plan429RetryAfterMs(cls, 30_000, -5), { baseMs: 30_000, respectHeader: false });

  // 防御性分支：无分类下限时，裸头只在 ≤ CAP 时才被采信
  const noFloor = { quota: true, retryFloorMs: undefined, kind: 'tpm' } as unknown as Cls;
  assert.deepEqual(plan429RetryAfterMs(noFloor, undefined, 30_000), {
    baseMs: 30_000,
    respectHeader: true,
  });
  assert.equal(plan429RetryAfterMs(noFloor, undefined, 90_000), undefined, '超过 CAP 的裸头不采信');
  assert.equal(plan429RetryAfterMs(noFloor, undefined, undefined), undefined, '无任何依据 → undefined');
});
