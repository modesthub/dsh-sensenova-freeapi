/**
 * 实时 key 事件（2026-11-03）的测试。
 *
 * 覆盖三块：环形缓冲的游标语义 / 容量上限 / HTTP 取值的降级与增量行为。
 * 这块 UI 是「真实请求闪灯」的唯一数据源，坏掉不能影响设置页本身 ——
 * 所以异常路径必须降级为 available:false 而不是抛。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_EVENTS_ROUTE,
  KEY_EVENT_BUFFER,
  KeyEventBuffer,
  handleKeyEventsHttp,
} from '../src/key-events-api.ts';

interface Payload {
  available: boolean;
  seq: number;
  events: { seq: number; kind: string; label: string; ref: string }[];
}

function readJson(response: Response): Promise<Payload> {
  return response.json() as Promise<Payload>;
}

test('路由与缓冲上限：client 侧硬编码同值、缓冲有界', () => {
  assert.equal(KEY_EVENTS_ROUTE, '/api/sensenova/keyEvents');
  assert.equal(KEY_EVENT_BUFFER, 512);
});

test('KeyEventBuffer: seq 单调递增、since 只返回新事件、head 跟随', () => {
  const buffer = new KeyEventBuffer();
  assert.equal(buffer.head(), 0);
  buffer.record({ kind: 'start', label: '1-0', ref: 'SENSENOVA_API_KEY' });
  buffer.record({ kind: 'rate-limit', label: '2-3', ref: 'SENSENOVA_API_KEY_7' });
  assert.equal(buffer.head(), 2);

  const first = buffer.since(0);
  assert.deepEqual(first.events.map((event) => event.seq), [1, 2]);
  assert.equal(first.seq, 2);

  // 游标推进后不再重复返回旧事件。
  assert.deepEqual(buffer.since(1).events.map((event) => event.seq), [2]);
  assert.deepEqual(buffer.since(2).events, []);

  // 越界游标（比 head 大）也安全：回空。
  assert.deepEqual(buffer.since(99).events, []);
});

test('KeyEventBuffer: 超过上限时裁掉最旧事件，head 不回收', () => {
  const buffer = new KeyEventBuffer();
  for (let index = 0; index < KEY_EVENT_BUFFER + 5; index += 1) {
    buffer.record({ kind: 'start', label: `1-${index}`, ref: 'ref' });
  }
  assert.equal(buffer.head(), KEY_EVENT_BUFFER + 5);
  const payload = buffer.since(0, KEY_EVENT_BUFFER + 10);
  assert.equal(payload.events.length, KEY_EVENT_BUFFER);
  assert.equal(payload.events[0]?.seq, 6, '最旧的 5 条被裁掉');
});

test('handleKeyEventsHttp: since 缺省/负数只回 head（面板刚打开不回放历史）', async () => {
  const buffer = new KeyEventBuffer();
  buffer.record({ kind: 'start', label: '1-0', ref: 'r1' });
  buffer.record({ kind: 'rate-limit', label: '1-0', ref: 'r1' });

  for (const url of ['http://host/api/sensenova/keyEvents', 'http://host/api/sensenova/keyEvents?since=-1', 'http://host/api/sensenova/keyEvents?since=abc']) {
    const response = await handleKeyEventsHttp({ buffer }, new Request(url));
    assert.equal(response.status, 200);
    const payload = await readJson(response);
    assert.equal(payload.available, true);
    assert.equal(payload.seq, 2);
    assert.deepEqual(payload.events, []);
  }
});

test('handleKeyEventsHttp: since=0 回放全部并按新 head 推进游标', async () => {
  const buffer = new KeyEventBuffer();
  buffer.record({ kind: 'start', label: '1-0', ref: 'r1' });
  const first = await readJson(await handleKeyEventsHttp({ buffer }, new Request('http://host/api/sensenova/keyEvents?since=0')));
  assert.equal(first.seq, 1);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0]?.kind, 'start');
  assert.equal(first.events[0]?.label, '1-0');

  // 无新事件：回空但 head 保持不变。
  const second = await readJson(await handleKeyEventsHttp({ buffer }, new Request('http://host/api/sensenova/keyEvents?since=1')));
  assert.equal(second.seq, 1);
  assert.deepEqual(second.events, []);

  buffer.record({ kind: 'rate-limit', label: '1-0', ref: 'r1' });
  const third = await readJson(await handleKeyEventsHttp({ buffer }, new Request('http://host/api/sensenova/keyEvents?since=1')));
  assert.equal(third.seq, 2);
  assert.deepEqual(third.events.map((event) => event.kind), ['rate-limit']);
});

test('handleKeyEventsHttp: 异常降级为 available:false（绝不抛）', async () => {
  const broken = {
    head: () => { throw new Error('boom'); },
    since: () => { throw new Error('boom'); },
  } as unknown as KeyEventBuffer;
  const response = await handleKeyEventsHttp({ buffer: broken }, new Request('http://host/api/sensenova/keyEvents?since=-1'));
  assert.equal(response.status, 500);
  const payload = await readJson(response);
  assert.equal(payload.available, false);
  assert.deepEqual(payload.events, []);
});
