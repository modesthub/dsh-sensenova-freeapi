/**
 * 实时 key 请求事件（2026-11-03）。
 *
 * 用途：设置页的 key 网格在**真实请求**时按实际节奏闪灯 —— 请求发到哪一把 key，
 * 哪一格就亮绿；该 key 撞 429 就红闪三次。演示（演示红/绿）仍是加速回放，这里走
 * 的是主对话/视觉请求的真实事件。
 *
 * 传输：host 侧内存环形缓冲 + `GET /api/sensenova/keyEvents?since=<seq>` 轮询
 * （300ms）。为什么不用 SSE/WebSocket：宿主 `connection` 的 fetch 路由契约是
 * 「一次请求一次 Response」，没有长连接抽象；轮询在本地同源、每次几百字节，代价
 * 可忽略，300ms 的延迟对「看哪把 key 在忙」完全够用。
 *
 * 隐私：只回 label（账户可读名）与 credential-ref 名，**绝不回 key 原文**。
 *
 * @module dsh-sensenova-freeapi/key-events-api
 */

/** 路由路径（client 侧硬编码同值）。 */
export const KEY_EVENTS_ROUTE = '/api/sensenova/keyEvents';

/** 缓冲上限：覆盖面板打开前的最近一小段，且绝不无界增长。 */
export const KEY_EVENT_BUFFER = 512;

/** 事件类型：start = 请求已发出（绿）；rate-limit = 该 key 撞 429（红）。 */
export type KeyEventKind = 'start' | 'rate-limit';

/** 一条可安全下发的 key 事件（不含密钥原文）。 */
export interface KeyEventRecord {
  /** 单调递增游标。 */
  seq: number;
  /** epoch 毫秒。 */
  ts: number;
  kind: KeyEventKind;
  /** 账户可读名（如 `1-3` / `Default`），client 用它定位格子。 */
  label: string;
  /** credential-ref 名（如 `SENSENOVA_API_KEY_4`）。 */
  ref: string;
}

/** 一次拉取的响应体。 */
export interface KeyEventsPayload {
  available: boolean;
  /** 当前 head（下一次轮询的 since）。 */
  seq: number;
  events: KeyEventRecord[];
}

/** 环形缓冲：host 侧唯一写入点，路由只读。 */
export class KeyEventBuffer {
  private nextSeq = 0;
  private readonly records: KeyEventRecord[] = [];

  /** 记一条事件；返回写入后的记录（测试可直接断言）。 */
  record(event: { kind: KeyEventKind; label: string; ref: string; now?: number }): KeyEventRecord {
    this.nextSeq += 1;
    const record: KeyEventRecord = {
      seq: this.nextSeq,
      ts: event.now ?? Date.now(),
      kind: event.kind,
      label: event.label,
      ref: event.ref,
    };
    this.records.push(record);
    if (this.records.length > KEY_EVENT_BUFFER) {
      this.records.splice(0, this.records.length - KEY_EVENT_BUFFER);
    }
    return record;
  }

  /** 当前游标（不开面板时事件仍在积累，打开后从 head 起算）。 */
  head(): number {
    return this.nextSeq;
  }

  /** 取 `seq > cursor` 的事件（最多 `limit` 条）。 */
  since(cursor: number, limit = 200): KeyEventsPayload {
    const events = this.records.filter((record) => record.seq > cursor).slice(0, limit);
    return { available: true, seq: this.nextSeq, events };
  }

  /** 清空（测试/诊断用；正常路径不调用）。 */
  clear(): void {
    this.records.length = 0;
    this.nextSeq = 0;
  }
}

function json(payload: KeyEventsPayload, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 处理一次事件拉取；任何异常降级为 available:false（绝不抛）。
 *
 * `since` 缺省或为负数 ⇒ **只回 head、不回放历史**。客户端刚挂载时先这样对齐
 * 游标，避免把面板打开前的旧事件重新闪一遍。
 */
export async function handleKeyEventsHttp(
  deps: { buffer: KeyEventBuffer },
  request?: Request,
): Promise<Response> {
  try {
    const raw = request === undefined ? '' : new URL(request.url).searchParams.get('since') ?? '';
    const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return json({ available: true, seq: deps.buffer.head(), events: [] });
    }
    return json(deps.buffer.since(Math.floor(parsed)));
  } catch {
    return json({ available: false, seq: 0, events: [] }, 500);
  }
}
