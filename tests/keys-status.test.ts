import test from 'node:test';
import assert from 'node:assert/strict';
import { SensenovaKeyPool } from '../src/key-pool.ts';

const params = { kickThreshold: 2, probeInitialMs: 3000, probeBackoffFactor: 1, probeMaxMs: 3000, capacity: 100 };

test('snapshot: 未选 key 时 current/next 均 undefined', () => {
  const pool = new SensenovaKeyPool({ params: () => params });
  pool.seed(['k1', 'k2', 'k3']);
  const s = pool.snapshot();
  assert.equal(s.currentKey, undefined);
  assert.equal(s.nextKey, undefined);
  assert.equal(s.size, 3);
});

test('snapshot: pickStart 后 current=k1, next=k2', () => {
  const pool = new SensenovaKeyPool({ params: () => params });
  pool.seed(['k1', 'k2', 'k3']);
  assert.equal(pool.pickStart(), 'k1');
  const s = pool.snapshot();
  assert.equal(s.currentKey, 'k1');
  assert.equal(s.nextKey, 'k2');
});

test('snapshot: 单把 key 时 next 为 undefined', () => {
  const pool = new SensenovaKeyPool({ params: () => params });
  pool.seed(['only']);
  pool.pickStart();
  const s = pool.snapshot();
  assert.equal(s.currentKey, 'only');
  assert.equal(s.nextKey, undefined);
});

test('snapshot: 环回 k3 -> k1', () => {
  const pool = new SensenovaKeyPool({ params: () => params });
  pool.seed(['k1', 'k2', 'k3']);
  pool.pickStart();
  pool.pickNext(new Set(['k1']));
  pool.pickNext(new Set(['k1', 'k2']));
  const s = pool.snapshot();
  assert.equal(s.currentKey, 'k3');
  assert.equal(s.nextKey, 'k1');
});
