/**
 * key-pool 双列表状态机的纯单测（2026-09-27 重构）。
 *
 * 重点覆盖三处**此前完全无测试约束**的行为：
 *   1. 「只有 tpm 类才踢」—— 旧实现把 rpm 也计入顶档判据，导致纯 RPM 限流第 5 轮就
 *      永久停止轮换（2026-09-27 实测 `[3,3,3,3,1,1,1,1,3,1,1,1]`）。
 *   2. **保底**：运行态永不被踢空。
 *   3. **探测退避序列** 与「探测成功挂回末尾」。
 *
 * rpm / rate 不踢的端到端行为由 `tests/key-pool-adapter.test.ts` 覆盖（需要适配器）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_KEY_POOL_PARAMS,
  SensenovaKeyPool,
  type KeyPoolParams,
} from '../src/key-pool.ts'

/** 造池 + 可控时钟。`now` 从 1_000_000 起，避免与 0 语义混淆。 */
function makePool(overrides: Partial<KeyPoolParams> = {}, startAt = 1_000_000) {
  let clock = startAt
  const pool = new SensenovaKeyPool({
    params: () => ({ ...DEFAULT_KEY_POOL_PARAMS, ...overrides }),
    now: () => clock,
  })
  return {
    pool,
    advance: (ms: number): void => { clock += ms },
    at: (): number => clock,
  }
}

test('连续 2 次 tpm 才踢出运行态（第 1 次不踢）', () => {
  const { pool } = makePool()
  pool.seed(['k1', 'k2', 'k3'])

  const first = pool.recordTpmStrike('k1')
  assert.equal(first.kicked, false, '第 1 次命中不踢')
  assert.equal(first.strikes, 1)
  assert.equal(pool.isRunning('k1'), true, 'k1 仍在运行态')
  assert.deepEqual(pool.snapshot().blocked, [], '阻塞态仍为空')

  const second = pool.recordTpmStrike('k1')
  assert.equal(second.kicked, true, '第 2 次命中踢出')
  assert.equal(pool.isRunning('k1'), false, 'k1 已离开运行态')
  assert.deepEqual(pool.snapshot().blocked.map(entry => entry.key), ['k1'])
})

test('成功清零计数：命中一次后成功，不会累积到阈值', () => {
  const { pool } = makePool()
  pool.seed(['k1', 'k2', 'k3'])

  pool.recordTpmStrike('k1')
  pool.onSuccess('k1')
  const again = pool.recordTpmStrike('k1')
  assert.equal(again.kicked, false, '成功已清零 ⇒ 本次只算第 1 次')
  assert.equal(again.strikes, 1)
  assert.equal(pool.isRunning('k1'), true)
})

test('探测成功 ⇒ 挂回运行态末尾且计数清零', () => {
  const { pool, advance } = makePool()
  pool.seed(['k1', 'k2', 'k3'])
  pool.recordTpmStrike('k1')
  pool.recordTpmStrike('k1')

  const entry = pool.blockedEntries()[0]
  assert.ok(entry !== undefined, 'k1 应已进入阻塞态')
  advance(15_000)
  pool.recordProbe(entry, true)

  const snap = pool.snapshot()
  assert.deepEqual(snap.running, ['k2', 'k3', 'k1'], '挂回运行态末尾')
  assert.deepEqual(snap.blocked, [], '阻塞态已空')
  assert.equal(entry.tpmStrikes, 0, '计数清零')
  assert.equal(entry.probeAttempts, 0, '探测失败计数清零')
})

test('阻塞态的 key 被 agent 借用后成功 ⇒ 立即挂回运行态末尾', () => {
  const { pool } = makePool()
  pool.seed(['k1', 'k2', 'k3'])
  pool.recordTpmStrike('k1')
  pool.recordTpmStrike('k1')
  assert.equal(pool.isRunning('k1'), false)

  pool.onSuccess('k1')
  assert.equal(pool.isRunning('k1'), true, '成功是池已恢复的最强证据')
  assert.deepEqual(pool.snapshot().running, ['k2', 'k3', 'k1'])
})

test('运行态候选被排除 ⇒ 借用阻塞最久的一把，且不改变其相位', () => {
  const { pool, advance } = makePool()
  pool.seed(['k1', 'k2', 'k3'])

  pool.recordTpmStrike('k1')
  pool.recordTpmStrike('k1')
  advance(1_000)
  pool.recordTpmStrike('k2')
  pool.recordTpmStrike('k2')

  const before = pool.snapshot()
  assert.deepEqual(before.running, ['k3'], '运行态只剩 k3')
  assert.deepEqual(before.blocked.map(entry => entry.key), ['k1', 'k2'], 'k1 先阻塞')

  pool.pickStart()
  assert.equal(pool.pickNext(new Set(['k3'])), 'k1', '借用 blockedSince 最小的 k1')
  assert.equal(pool.isRunning('k1'), false, '借用不改变相位')
  assert.deepEqual(
    pool.snapshot().blocked.map(entry => entry.key),
    ['k1', 'k2'],
    '仍在阻塞态，等待探测决定去留',
  )
})

test('保底：2 把 key 都连续命中 ⇒ 只踢 1 把，最后一把永不被踢', () => {
  const { pool } = makePool()
  pool.seed(['k1', 'k2'])

  pool.recordTpmStrike('k1')
  pool.recordTpmStrike('k1')
  pool.recordTpmStrike('k2')
  pool.recordTpmStrike('k2')

  const snap = pool.snapshot()
  assert.equal(snap.running.length, 1, '运行态保底 1 把')
  assert.equal(snap.blocked.length, 1, '另一把进了阻塞态')

  const last = snap.running[0]
  assert.ok(last !== undefined)
  for (let i = 0; i < 5; i += 1) pool.recordTpmStrike(last)
  assert.deepEqual(pool.snapshot().running, [last], '最后一把无论命中多少次都不踢')
  assert.equal(pool.isRunning(last), true, 'agent 请求永远发得出去')
})

test('探测退避序列 = 15000 / 30000 / 60000 / 60000（封顶）', () => {
  const { pool, advance } = makePool()
  pool.seed(['k1', 'k2'])
  pool.recordTpmStrike('k1')
  pool.recordTpmStrike('k1')

  const entry = pool.blockedEntries()[0]
  assert.ok(entry !== undefined)

  const observed: number[] = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    observed.push(pool.probeIntervalMs(entry))
    advance(1_000)
    pool.recordProbe(entry, false)
  }
  assert.deepEqual(observed, [15_000, 30_000, 60_000, 60_000])
})

test('nextProbeAt：踢出后首次探测在 probeInitialMs 之后，失败则递进', () => {
  const { pool, advance, at } = makePool()
  pool.seed(['k1', 'k2'])
  pool.recordTpmStrike('k1')
  pool.recordTpmStrike('k1')

  const entry = pool.blockedEntries()[0]
  assert.ok(entry !== undefined)
  const kickedAt = at()
  assert.equal(pool.nextProbeAt(entry), kickedAt + 15_000, '首次探测 15s 后')

  advance(15_000)
  pool.recordProbe(entry, false)
  assert.equal(pool.nextProbeAt(entry), kickedAt + 15_000 + 30_000, '失败后 30s')
})

test('seed 幂等（不重置相位）且按 capacity 截断', () => {
  const { pool } = makePool({ capacity: 2 })

  assert.equal(pool.seed(['k1', 'k2', 'k3']), 1, 'k3 因容量被截断')
  assert.equal(pool.size, 2)

  pool.recordTpmStrike('k1')
  pool.recordTpmStrike('k1')
  assert.equal(pool.isRunning('k1'), false)

  assert.equal(pool.seed(['k1', 'k2']), 0, '重复 seed 不新增也不截断')
  assert.equal(pool.size, 2, '池大小不变')
  assert.equal(pool.isRunning('k1'), false, '重复 seed 不得重置相位')
  assert.deepEqual(pool.snapshot().blocked.map(entry => entry.key), ['k1'], '仍是阻塞态')
})

test('remove（401 永久禁用）把 key 从池中彻底移除', () => {
  const { pool } = makePool()
  pool.seed(['k1', 'k2', 'k3'])
  pool.recordTpmStrike('k1')
  pool.recordTpmStrike('k1')

  pool.remove('k1')
  assert.equal(pool.size, 2)
  assert.equal(pool.isRunning('k1'), false)
  assert.deepEqual(pool.snapshot().blocked, [], '阻塞态也移除')
  assert.equal(pool.recordTpmStrike('k1').kicked, false, '不在池内 ⇒ 忽略')
})

test('kickThreshold 可配：设为 1 时首次命中即踢', () => {
  const { pool } = makePool({ kickThreshold: 1 })
  pool.seed(['k1', 'k2'])
  const result = pool.recordTpmStrike('k1')
  assert.equal(result.kicked, true)
  assert.equal(pool.isRunning('k1'), false)
  assert.deepEqual(pool.snapshot().running, ['k2'], '保底仍生效')
})
