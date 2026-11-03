/**
 * 账户与分组编辑器（设置页「多账户轮换」区块的主体，2026-11-02）。
 *
 * 对齐原型 `output/key-pool-ui-v7.html`：
 *   - 一行一个账户：行首是账户方块（点击开账户菜单），行内 20 个预留位；
 *   - 每组用带序号的框圈住自己那几把（`1`、`1′`、`1″`），框之间可以留空档；
 *   - **框的左右两条边都能拖**：往右先吞右侧孤立 key，再吃右邻组头一把；往左反之。
 *     行首组没有左手柄（v7 同款）。拖动按 22px 一格吸附，跟手连续生效；
 *   - 点组标签开组菜单：并入前/后组、整组移出轮换（key 保留变孤立）、删组（两步确认）；
 *   - 行尾 + 分派两种语义：末尾有孤立 key → 收编成新组；否则从最后一组切分；
 *   - 点格子 → 下方编辑面板（API 密钥 / 显示 / 清除已存密钥 / 移出本组 / 删除）；
 *     点空位 → 面板里填 API 密钥「添加密钥」，新 key 追加到本账户行。
 *
 * 孤立 key 是**一等公民**：黄色虚线格子，属于账户但不参与轮换。它与 v7 一致 ——
 * 「缩小组 → 那几把先歇着 → 想用再拖回来」。
 *
 * 动画（v7 §flash429）：同一格连续触发 429 时要能重放 —— 先清掉 `data-flash`，
 * 下一帧再加回来，浏览器才会重新跑 keyframes；只改时间戳没用。
 *
 * @module dsh-sensenova-freeapi/client/key-pool-editor
 */
import * as React from 'react';
import { KEY_EVENTS_ROUTE, type KeyLivePayload, type TranslateFn } from './settings';
import {
  GROUP_SOFT_LIMIT,
  SLOTS_PER_ACCOUNT,
  adoptTailOrphans,
  buildPoolRows,
  dropGroupAt,
  isolateKeyAt,
  mergeGroupAt,
  orphanGroupAt,
  primeOf,
  resizeEdge,
  rotationSeq,
  rotationTicks,
  splitLast,
  withRowPlan,
  type GripSide,
  type PoolKeyRef,
  type PoolRow,
  type SchedGroupPlan,
} from './key-pool-plan';

const SLOT = 16;
// 键间距 6 + 框内缩 1 ⇒ 相邻组框之间留 4px 真实间隙（GAP − 2×EDGE）。
const GAP = 6;
const PITCH = SLOT + GAP;
const EDGE = 1;
/**
 * 演示节奏：每把之间 110ms（160 把 ≈ 17.6s），先绿 60ms 再转红 429。
 * 真实 keyGap 是 500ms、groupGap 是 22500ms；这里只是加速播放。
 */
const DEMO_STEP = 110;
const DEMO_LIVE_MS = 60;
const DEMO_429_MS = 900;
/** 最后一把转红后，留一点时间让红色播放完再显示「抛宿主」。 */
const DEMO_TAIL_MS = 520;
/**
 * 真实请求闪灯：轮询间隔与绿灯驻留时长。
 *
 * 主对话/视觉请求实际用哪把 key 由 host 产生事件，client 轮询后点亮同一格：
 * start ⇒ 绿灯（1.4s），rate-limit ⇒ 红闪三次（0.9s）。429 通常 100-300ms 内
 * 就返回，绿灯会被红灯覆盖 —— 与演示的「先绿后红」观感一致。
 */
const LIVE_POLL_MS = 300;
const LIVE_GREEN_MS = 1_400;
const MENU_WIDTH = 232;

interface ReactHooks {
  useRef<T>(initialValue: T): { current: T };
  useState<S>(initialState: S): [S, (value: S | ((prev: S) => S)) => void];
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
const { useRef, useState, useEffect, useLayoutEffect } = React as unknown as ReactHooks;

/** 拖动过程中就地重算 starts / orphans（不必等 React 回灌）。 */
function reflow(row: PoolRow, shape: { sizes: number[]; gaps: number[] }): PoolRow {
  const starts: number[] = [];
  let cursor = 0;
  for (let i = 0; i < shape.sizes.length; i += 1) {
    cursor += shape.gaps[i] ?? 0;
    starts.push(cursor);
    cursor += shape.sizes[i] ?? 0;
  }
  return { ...row, sizes: shape.sizes, gaps: shape.gaps, starts, orphans: shape.gaps.reduce((a, b) => a + b, 0) };
}

/** 一把 key 落在第几组、组内第几把；孤立 key 返回 null。 */
function locate(row: PoolRow, keyIndex: number): { group: number; offset: number } | null {
  for (let i = 0; i < row.sizes.length; i += 1) {
    const start = row.starts[i] ?? 0;
    const size = row.sizes[i] ?? 0;
    if (keyIndex >= start && keyIndex < start + size) return { group: i, offset: keyIndex - start };
  }
  return null;
}

/** 某账户行下一个可用的 slot（`N-M` 的 M）；默认密钥的 −1 不算。 */
function nextSlotOfRow(row: PoolRow): number {
  let max = 0;
  for (const key of row.keys) max = Math.max(max, key.slot);
  return max + 1;
}

type Selection =
  | { kind: 'key'; id: string }
  | { kind: 'empty'; account: number; index: number };

/**
 * 演示状态：按真实请求顺序播放两轮。`done` 只用于进度显示，
 * `account/group` 为 null 表示没有正在高亮的行/组（抛宿主后）。
 */
interface DemoState {
  running: boolean;
  thrown: boolean;
  done: number;
  total: number;
  round: number;
  rounds: number;
  account: number | null;
  group: number | null;
}

interface MenuState {
  kind: 'group' | 'account';
  account: number;
  index: number;
  x: number;
  y: number;
  /** 触发元素底边（视口坐标）；菜单放不下时据此翻到上方。 */
  anchor: number;
  /** 删除类菜单项的两步确认（第一次点击变文案并加 .armed，2.6s 后复位）。 */
  armed: boolean;
}

export interface KeyPoolEditorProps {
  t: TranslateFn;
  disabled: boolean;
  keys: readonly PoolKeyRef[];
  plan: readonly SchedGroupPlan[];
  grouping: string;
  onChange: (plan: SchedGroupPlan[]) => void;
  onEditLabel: (id: string, text: string) => void;
  onEditKey: (id: string, text: string) => void;
  onClearKey: (id: string) => void;
  onRemoveKey: (id: string) => void;
  onAddAccount?: (() => void) | undefined;
  /** 在指定账户下新增一把 key；返回新 id（成功后编辑器自动选中它）。 */
  onAddKey?: ((account: number, key: string) => string | undefined) | undefined;
  /** 手动「智能分组」：按 4 个一组重排（导入后自动执行一次，这里提供手动兜底）。 */
  onSmartGroup?: (() => void) | undefined;
  /** 强制重读凭据（右上角刷新按钮的具体动作；导入后渲染卡住时点它恢复）。 */
  onHardRefresh?: (() => void) | undefined;
  /** 429 轮次预算（scheduling.roundBudget）：演示按同样的轮数播放，默认 2。 */
  roundBudget?: number | undefined;
}

export function KeyPoolEditor(props: KeyPoolEditorProps): JSX.Element {
  const { t, disabled } = props;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [showKey, setShowKey] = useState(false);
  // 空位面板里待添加的 API 密钥（切选择时清空，避免把上一格的草稿带过去）。
  const [emptyKey, setEmptyKey] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState<{ account: number; index: number } | null>(null);
  // 动效状态：key → 'live'(绿) / '429'(红闪三次)。纯 UI，不落盘。
  // nonce 参与渲染 key：每次触发都换一个 DOM 节点，CSS 动画必定从头播。
  const [flash, setFlash] = useState<Record<string, { kind: string; nonce: number }>>({});
  // 演示进度（纯 UI）。为 null = 还没演示过；thrown = 两轮全败，已「抛宿主」。
  const [demo, setDemo] = useState<DemoState | null>(null);
  // 每个 key 的清除定时器各自持有：同一格连点 429 时先撤掉旧 timer，
  // 否则上一轮的清除会把新一轮动画从中间截断。
  const flashTimers = useRef(new Map<string, number>());
  const demoTimers = useRef<number[]>([]);
  // 演示的「运行令牌」：连点/卸载时自增，旧定时器即使已经排队也不会再写状态。
  const demoRun = useRef(0);
  // 实时事件游标：null = 尚未对齐（首次拉取只取 head，不回放面板打开前的旧事件）。
  const liveCursor = useRef<number | null>(null);
  // 最新一次渲染的 flashKey（轮询回调里调用，避免闭包捕获旧的 setState 链）。
  const flashRef = useRef<((id: string, kind: 'live' | '429', ms?: number) => void) | null>(null);
  const menuRef = useRef<{ offsetHeight: number } | null>(null);
  const nonce = useRef(0);

  const rows = buildPoolRows(props.keys, props.plan, props.grouping);
  useEffect(() => { setEmptyKey(''); }, [selection]);
  const latest = useRef({ rows, plan: props.plan });
  latest.current = { rows, plan: props.plan };

  useEffect(() => () => {
    demoRun.current += 1;
    for (const timer of flashTimers.current.values()) window.clearTimeout(timer);
    flashTimers.current.clear();
    for (const timer of demoTimers.current) window.clearTimeout(timer);
    demoTimers.current = [];
    document.body.classList.remove('sn-kpDragging');
  }, []);

  useEffect(() => {
    if (menu === null) return undefined;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setMenu(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu]);

  // 菜单高度要等挂载后才知道：贴底时翻到触发元素上方，避免被视口裁掉。
  useLayoutEffect(() => {
    if (menu === null) return undefined;
    const height = menuRef.current?.offsetHeight ?? 0;
    if (height <= 0) return undefined;
    const below = menu.anchor + 6;
    const desired = below + height <= window.innerHeight - 10
      ? below
      : Math.max(8, menu.anchor - 6 - height);
    if (desired !== menu.y) setMenu({ ...menu, y: desired });
    return undefined;
  }, [menu]);

  const commit = (account: number, shape: { sizes: number[]; gaps: number[] } | undefined): void => {
    const row = latest.current.rows.find((candidate) => candidate.account === account);
    if (row === undefined) return;
    const plan = withRowPlan(latest.current.plan, row, shape, props.grouping);
    props.onChange(plan);
    if (shape !== undefined) {
      // 拖动一次可能连走好几格：plan 也要就地更新，否则下一步会从旧数组重算。
      latest.current = {
        plan,
        rows: latest.current.rows.map((candidate) =>
          candidate.account === account ? reflow(candidate, shape) : candidate),
      };
    }
  };

  /**
   * 点亮一把 key：`live` 绿灯常亮 ms 毫秒；`429` 红闪三次（动画自带 0.9s）。
   *
   * 重放：每次触发递增 nonce，渲染时把它拼进 React key ⇒ 该格子换新节点，
   * CSS 动画从第一帧重跑。纯 CSS 属性复位在 React 批处理下不可靠（两次
   * setState 可能合成同一次提交，浏览器根本不认为值变化过）。
   */
  const flashKey = (id: string, kind: 'live' | '429', ms = 900): void => {
    const pending = flashTimers.current.get(id);
    if (pending !== undefined) window.clearTimeout(pending);
    nonce.current += 1;
    setFlash((prev) => ({ ...prev, [id]: { kind, nonce: nonce.current } }));
    const timer = window.setTimeout(() => {
      flashTimers.current.delete(id);
      setFlash((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, ms);
    flashTimers.current.set(id, timer);
  };
  flashRef.current = flashKey;

  /**
   * 真实请求闪灯（2026-11-03）：轮询 host 的 key 事件，按**实际时间**点亮对应格子。
   *
   * 事件只在 host 真正用某把 key 发请求 / 撞 429 时产生；这里 300ms 拉一次增量，
   * 首次拉取只对齐游标（不回放打开面板前的历史）。组件卸载即停轮询。
   */
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let busy = false;
    const poll = async (): Promise<void> => {
      if (stopped || busy) return;
      busy = true;
      try {
        const cursor = liveCursor.current;
        const query = cursor === null ? '?since=-1' : `?since=${cursor}`;
        const response = await fetch(`${KEY_EVENTS_ROUTE}${query}`, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`key events HTTP ${response.status}`);
        const payload = (await response.json()) as KeyLivePayload;
        if (!stopped && payload !== null && typeof payload === 'object' && payload.available === true) {
          const events = Array.isArray(payload.events) ? payload.events : [];
          const head = typeof payload.seq === 'number' ? payload.seq : cursor ?? 0;
          if (cursor === null) {
            liveCursor.current = head;
          } else {
            if (events.length > 0) {
              const byLabel = new Map<string, string>();
              for (const row of latest.current.rows) {
                for (const key of row.keys) byLabel.set(key.label, key.id);
              }
              for (const event of events) {
                const id = byLabel.get(event.label);
                if (id === undefined) continue;
                if (event.kind === 'rate-limit') flashRef.current?.(id, '429', DEMO_429_MS);
                else flashRef.current?.(id, 'live', LIVE_GREEN_MS);
              }
            }
            liveCursor.current = head;
          }
        }
      } catch {
        // 轮询失败静默：下一拍再试（无 web 服务的 profile 里也不该报错刷屏）。
      } finally {
        busy = false;
      }
      if (!stopped) timer = window.setTimeout(() => { void poll(); }, LIVE_POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  /** 智能分组（手动兜底）：按每行 4 个一组重排。导入后会自动执行一次，这里再留按钮。 */
  const runSmartGroup = (): void => {
    props.onSmartGroup?.();
    setFlash({});
    setDemo(null);
  };

  /**
   * 演示：按**真实请求顺序**加速播放。
   *
   * 序列由 `rotationTicks(rows, roundBudget)` 展开，与 host fixed 调度同一套语义：
   * 账户宏观轮转（永不跳过）、各账户组游标独立前进、组内按 slot 顺序；
   * 一轮 = max(各组数) 个宏观周期，走满预算轮数后抛宿主。
   *
   * 每把 key：绿（请求在飞）→ 60ms 后转红（429）。连点 = 重跑：先自增令牌
   * 并清掉上一轮所有定时器，旧回调即使已经排队也会被令牌挡掉。
   */
  const runDemo = (): void => {
    demoRun.current += 1;
    const run = demoRun.current;
    for (const timer of demoTimers.current) window.clearTimeout(timer);
    demoTimers.current = [];
    for (const timer of flashTimers.current.values()) window.clearTimeout(timer);
    flashTimers.current.clear();
    setFlash({});
    setMenu(null);

    // 轮数与设置页的「429 轮次预算」一致：改预算后演示同步改轮数（非法/空输入回落 2）。
    // 注意 `Number('')` 是 0 而不是 NaN ⇒ 必须显式按「≥1 才有效」判定。
    const rawBudget = props.roundBudget ?? 2;
    const budget = typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget >= 1
      ? Math.min(10, Math.round(rawBudget))
      : 2;
    const ticks = rotationTicks(rows, budget);
    if (ticks.length === 0) {
      setDemo(null);
      return;
    }
    const total = ticks.length;
    const rounds = ticks[0]?.rounds ?? budget;
    setDemo({ running: true, thrown: false, done: 0, total, round: 1, rounds, account: null, group: null });

    const schedule = (fn: () => void, at: number): void => {
      demoTimers.current.push(window.setTimeout(() => {
        if (demoRun.current !== run) return;
        fn();
      }, at));
    };

    for (let i = 0; i < ticks.length; i += 1) {
      const tick = ticks[i];
      if (tick === undefined) continue;
      const at = i * DEMO_STEP;
      schedule(() => {
        setDemo({
          running: true,
          thrown: false,
          done: i + 1,
          total,
          round: tick.round,
          rounds: tick.rounds,
          account: tick.account,
          group: tick.group,
        });
        flashKey(tick.key.id, 'live', DEMO_LIVE_MS);
      }, at);
      schedule(() => flashKey(tick.key.id, '429', DEMO_429_MS), at + 50);
    }

    schedule(() => {
      setDemo({
        running: false,
        thrown: true,
        done: total,
        total,
        round: rounds,
        rounds,
        account: null,
        group: null,
      });
    }, total * DEMO_STEP + DEMO_TAIL_MS);
  };

  const openMenu = (kind: 'group' | 'account') => (account: number, index: number) =>
    (event: Record<string, unknown>): void => {
      if (disabled) return;
      const ev = event as unknown as {
        preventDefault: () => void;
        stopPropagation: () => void;
        currentTarget: { getBoundingClientRect: () => { left: number; bottom: number } };
      };
      ev.preventDefault();
      ev.stopPropagation();
      const rect = ev.currentTarget.getBoundingClientRect();
      const x = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 12));
      const y = Math.min(rect.bottom + 6, window.innerHeight - 12);
      setMenu({ kind, account, index, x, y, anchor: rect.bottom, armed: false });
    };

  const startDrag = (account: number, index: number, side: GripSide) =>
    (event: Record<string, unknown>): void => {
      if (disabled) return;
      const down = event as unknown as {
        preventDefault: () => void;
        stopPropagation: () => void;
        clientX: number;
      };
      down.preventDefault();
      down.stopPropagation();
      const startX = down.clientX;
      // 左把手往左拖是「扩大」，所以向外的符号要反过来。
      const outward = side === 'right' ? 1 : -1;
      let moved = 0;
      setDrag({ account, index });
      setMenu(null);
      document.body.classList.add('sn-kpDragging');

      const step = (sign: 1 | -1): boolean => {
        const row = latest.current.rows.find((candidate) => candidate.account === account);
        if (row === undefined) return false;
        const dir = (sign * outward) as 1 | -1;
        const shape = resizeEdge(row.sizes, row.gaps, index, side, dir);
        if (shape === undefined) return false;
        commit(account, shape);
        return true;
      };

      const onMove = (moveEvent: Record<string, unknown>): void => {
        const nowX = (moveEvent as unknown as { clientX: number }).clientX;
        const delta = Math.round((nowX - startX) / PITCH);
        const want = side === 'right' ? delta : -delta;
        // 越界就停在已生效的步数上（不要假装走满）：指针往回拖时，
        // moved 与真实形状仍然对齐，不会多缩。
        while (moved < want) {
          if (!step(1)) break;
          moved += 1;
        }
        while (moved > want) {
          if (!step(-1)) break;
          moved -= 1;
        }
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove as unknown as EventListener);
        document.removeEventListener('mouseup', onUp as unknown as EventListener);
        document.body.classList.remove('sn-kpDragging');
        setDrag(null);
      };
      document.addEventListener('mousemove', onMove as unknown as EventListener);
      document.addEventListener('mouseup', onUp as unknown as EventListener);
    };

  const selectedKey = selection !== null && selection.kind === 'key'
    ? props.keys.find((key) => key.id === selection.id)
    : undefined;
  const selectedRow = selectedKey === undefined
    ? undefined
    : rows.find((row) => row.account === selectedKey.account);
  const selectedIndex = selectedRow === undefined || selectedKey === undefined
    ? -1
    : selectedRow.keys.findIndex((key) => key.id === selectedKey.id);
  const located = selectedRow === undefined || selectedIndex < 0 ? null : locate(selectedRow, selectedIndex);

  // 空位面板：预估新 key 的 `账户-slot`（与 settings.addAccountKey 用同一规则）。
  const emptyRow = selection !== null && selection.kind === 'empty'
    ? rows.find((row) => row.account === selection.account)
    : undefined;
  const emptySlot = emptyRow === undefined ? 0 : nextSlotOfRow(emptyRow);

  const menuRow = menu === null ? undefined : rows.find((row) => row.account === menu.account);
  const menuGroup = menu !== null && menu.kind === 'group' && menuRow !== undefined
    ? { start: menuRow.starts[menu.index] ?? 0, size: menuRow.sizes[menu.index] ?? 0 }
    : undefined;
  const menuKeys = menuRow === undefined || menuGroup === undefined
    ? []
    : menuRow.keys.slice(menuGroup.start, menuGroup.start + menuGroup.size);
  const canDropGroup = menuKeys.length > 0 && menuKeys.every((key) => !key.isDefault);
  const canRemoveAccount = menuRow !== undefined && menuRow.keys.length > 0
    && menuRow.keys.every((key) => !key.isDefault);

  const preview = rotationSeq(rows, 10).map((item) => `${item.account}${primeOf(item.ordinal)}`).join(' → ');
  const totalOrphans = rows.reduce((sum, row) => sum + row.orphans, 0);

  if (rows.length === 0) {
    return (
      <div className="sn-kp">
        <p className="sn-hint">{t('schedGroupsEmpty')}</p>
      </div>
    );
  }

  const menuItem = (
    label: string,
    onClick: () => void,
    danger = false,
    blocked = false,
  ): JSX.Element => (
    <button
      type="button"
      className={`sn-kpMenuItem${danger ? ' sn-kpMenuDanger' : ''}${menu?.armed && danger ? ' sn-kpMenuItemArmed' : ''}`}
      disabled={disabled || blocked}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div className="sn-kp" data-dragging={drag !== null ? '1' : undefined}>
      <div className="sn-kpHead">
        <span className="sn-label">{t('schedGroupsTitle')}</span>
        <span className="sn-hint sn-kpHeadHint">{t('schedGroupsHint')}</span>
        <button
          type="button"
          className="sn-btnGhost sn-kpDemo"
          title={t('schedKeyDemoHint')}
          onClick={runDemo}
        >
          {t('schedKeyDemo')}
        </button>
        <button
          type="button"
          className="sn-btnGhost sn-kpSmart"
          disabled={disabled || props.onSmartGroup === undefined}
          title={t('schedSmartGroupHint')}
          onClick={runSmartGroup}
        >
          {t('schedSmartGroup')}
        </button>
      </div>

      {demo !== null ? (
        <div
          className="sn-kpDemoHud"
          data-state={demo.thrown ? 'thrown' : demo.running ? 'running' : 'idle'}
        >
          <span className="sn-kpDemoDot" aria-hidden="true" />
          <span className="sn-kpDemoText">
            {demo.thrown
              ? t('schedDemoThrown', { attempts: demo.total, rounds: demo.rounds })
              : t('schedDemoProgress', {
                  round: demo.round,
                  rounds: demo.rounds,
                  account: demo.account ?? '—',
                  group: demo.group === null ? '—' : demo.group + 1,
                  done: demo.done,
                  total: demo.total,
                })}
          </span>
          <span className="sn-kpDemoBar" aria-hidden="true">
            <span style={{ width: `${Math.round((demo.done / demo.total) * 100)}%` }} />
          </span>
        </div>
      ) : null}

      {rows.map((row) => {
        // 轨道必须容纳全部 key（default + 已配置槽），否则 21 把时会截断错位；
        // 预留位 = 20 与 max(keys) 取大，空位自动补齐到 20 个预留位之后。
        const slotCount = Math.max(SLOTS_PER_ACCOUNT, row.keys.length);
        // 孤立位：落在任何一段 gaps 里的下标。
        const orphanAt = new Set<number>();
        let cursor = 0;
        for (let i = 0; i < row.sizes.length; i += 1) {
          const gap = row.gaps[i] ?? 0;
          for (let k = 0; k < gap; k += 1) orphanAt.add(cursor + k);
          cursor += gap + (row.sizes[i] ?? 0);
        }
        for (let k = cursor; k < row.keys.length; k += 1) orphanAt.add(k);

        const slots = Array.from({ length: slotCount }, (_, index) => {
          const key = row.keys[index];
          if (key === undefined) {
            const picked = selection !== null && selection.kind === 'empty'
              && selection.account === row.account && selection.index === index;
            // 空位 = 还没配置的预留槽：点它先选中、在下方面板里决定要不要开新账户。
            return (
              <span
                className="sn-kpSlot"
                key={`e${index}`}
                data-empty="1"
                data-selected={picked ? '1' : undefined}
                title={t('schedSlotEmpty')}
                onClick={() => { setShowKey(false); setSelection({ kind: 'empty', account: row.account, index }); }}
              />
            );
          }
          const picked = selection !== null && selection.kind === 'key' && selection.id === key.id;
          return (
            <span
              className="sn-kpSlot"
              key={`${key.id}:${flash[key.id]?.nonce ?? 0}`}
              data-configured={key.configured ? '1' : undefined}
              data-unset={key.configured ? undefined : '1'}
              data-orphan={orphanAt.has(index) ? '1' : undefined}
              data-staged={key.clearStaged ? '1' : undefined}
              data-selected={picked ? '1' : undefined}
              data-flash={flash[key.id]?.kind}
              title={`${key.label}${key.configured ? '' : t('schedKeyUnset')}${
                orphanAt.has(index) ? t('schedKeyOrphan') : ''}`}
              aria-label={`${key.label}${key.configured ? '' : ' · 未配置'}`}
              onClick={() => {
                setShowKey(false);
                setMenu(null);
                setSelection(picked ? null : { kind: 'key', id: key.id });
              }}
              onContextMenu={(event: Record<string, unknown>) => {
                (event as unknown as { preventDefault: () => void }).preventDefault();
                flashKey(key.id, '429');
              }}
            />
          );
        });

        const boxes = row.sizes.map((size, index) => {
          const start = row.starts[index] ?? 0;
          const left = start * PITCH - EDGE;
          const width = size * SLOT + (size - 1) * GAP + EDGE * 2;
          const over = size > GROUP_SOFT_LIMIT;
          const active = drag !== null && drag.account === row.account && drag.index === index;
          const inDemo = demo !== null && demo.running && demo.account === row.account;
          return (
            <span
              className="sn-kpBox"
              key={`${row.account}-${index}`}
              data-over={over ? '1' : undefined}
              data-active={active ? '1' : undefined}
              data-demo={inDemo && demo.group === index ? '1' : undefined}
              style={{ left: `${left}px`, width: `${width}px` }}
            >
              <span
                className={`sn-kpTag${over ? ' sn-kpTagOver' : ''}`}
                title={t('schedGroupMenuHint')}
                onClick={openMenu('group')(row.account, index)}
                onContextMenu={openMenu('group')(row.account, index)}
              >
                <span className="sn-kpTagText">{`${row.account}${primeOf(index)} · ${size}`}</span>
                {over ? <span className="sn-kpWarn">≤{GROUP_SOFT_LIMIT}</span> : null}
              </span>
              {start > 0 ? (
                <span
                  className="sn-kpGrip sn-kpGripL"
                  title={t('schedGroupDrag')}
                  onMouseDown={startDrag(row.account, index, 'left')}
                />
              ) : null}
              <span
                className="sn-kpGrip sn-kpGripR"
                title={t('schedGroupDrag')}
                onMouseDown={startDrag(row.account, index, 'right')}
              />
            </span>
          );
        });

        const tailSize = row.sizes[row.sizes.length - 1] ?? 0;
        const tailOrphans = row.gaps[row.sizes.length] ?? 0;
        const canAdopt = tailOrphans > 0;
        const canSplit = tailSize >= 2;

        return (
          <div className="sn-kpRow" key={row.account} data-account={row.account}>
            <button
              type="button"
              className="sn-kpAcct"
              data-demo={demo !== null && demo.running && demo.account === row.account ? '1' : undefined}
              title={t('schedAccountMenuHint', { n: row.account })}
              onClick={openMenu('account')(row.account, 0)}
              onContextMenu={openMenu('account')(row.account, 0)}
            >
              <span className="sn-kpAcctNum">{row.account}</span>
              <span className="sn-kpAcctCnt">{row.sizes.length}</span>
            </button>
            <div className="sn-kpTrack" style={{ width: `${slotCount * PITCH - GAP + EDGE * 2}px` }}>
              {slots}
              {boxes}
            </div>
            <span className="sn-kpHint">
              {t('schedGroupCount', { keys: row.keys.length, groups: row.sizes.length })}
              {row.orphans > 0 ? t('schedGroupOrphans', { n: row.orphans }) : ''}
            </span>
            <button
              type="button"
              className="sn-kpBtn"
              disabled={disabled || (!canAdopt && !canSplit)}
              title={canAdopt ? t('schedGroupRecover') : t('schedGroupSplit')}
              onClick={() => commit(
                row.account,
                canAdopt ? adoptTailOrphans(row.sizes, row.gaps) : splitLast(row.sizes, row.gaps),
              )}
            >
              +
            </button>
          </div>
        );
      })}

      {props.onAddAccount !== undefined ? (
        <div className="sn-kpRow">
          <span className="sn-kpAcct" />
          <button
            type="button"
            className="sn-kpBtn sn-kpAdd"
            disabled={disabled}
            title={t('schedAccountAdd')}
            onClick={props.onAddAccount}
          >
            +
          </button>
          <span className="sn-kpHint">{t('schedAccountAdd')}</span>
        </div>
      ) : null}

      {selectedKey !== undefined ? (
        <div className="sn-kpEditor">
          <div className="sn-kpEditorHead">
            <span className="sn-kpEditorTitle">{selectedKey.label}</span>
            <span className={`sn-kpBadge${selectedKey.configured && !selectedKey.clearStaged ? ' sn-kpBadgeOk' : ''}`}>
              {selectedKey.clearStaged
                ? t('schedKeyWillClear')
                : selectedKey.configured ? t('apiKeySet') : t('apiKeyUnset')}
            </span>
          </div>

          <p className="sn-hint sn-kpEditorNote">
            {located === null
              ? t('schedKeyIsolateNote')
              : t('schedKeyInGroup', { n: located.group + 1, size: selectedRow?.sizes[located.group] ?? 0 })}
          </p>

          {selectedKey.isDefault ? null : (
            <div className="sn-kpField">
              <span className="sn-kpLabel">{t('accountLabel')}</span>
              {/* label 是分组身份（`账户-序号`），改名会让这把 key 从编辑器消失，
                  并让 host seedGroups 放弃整池建组——所以只读展示，不提供改名。 */}
              <span className="sn-kpHint">{selectedKey.label}</span>
            </div>
          )}
          {selectedKey.isDefault ? null : (
            <p className="sn-hint sn-kpEditorNote">{t('schedKeyLabelFixed')}</p>
          )}

          <label className="sn-kpField">
            <span className="sn-kpLabel">{t('accountApiKey')}</span>
            <input
              className="sn-input"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={selectedKey.keyDraft}
              disabled={disabled || !selectedKey.writable}
              placeholder={selectedKey.configured ? t('accountKeyKeep') : t('accountKeyPlaceholder')}
              onChange={(event: Record<string, unknown>) =>
                props.onEditKey(selectedKey.id, String((event.target as { value: string }).value))}
            />
          </label>

          <div className="sn-kpEditorActions">
            <button type="button" className="sn-btnGhost" onClick={() => setShowKey(!showKey)}>
              {showKey ? t('accountHideKey') : t('accountShowKey')}
            </button>
            <button
              type="button"
              className="sn-btnGhost"
              disabled={disabled || !selectedKey.configured || selectedKey.clearStaged}
              onClick={() => props.onClearKey(selectedKey.id)}
            >
              {t('accountClearKey')}
            </button>
            {selectedKey.isDefault || located === null || (selectedRow?.sizes[located.group] ?? 0) <= 1
              ? null
              : (
                <button
                  type="button"
                  className="sn-btnGhost"
                  title={t('schedKeyIsolateNote')}
                  disabled={disabled}
                  onClick={() => {
                    if (selectedRow === undefined || located === null) return;
                    commit(selectedRow.account, isolateKeyAt(selectedRow.sizes, selectedRow.gaps, located.group, located.offset));
                  }}
                >
                  {t('schedKeyIsolate')}
                </button>
              )}
            {selectedKey.isDefault ? null : (
              <button
                type="button"
                className="sn-btnGhost sn-btnDanger"
                disabled={disabled}
                onClick={() => { props.onRemoveKey(selectedKey.id); setSelection(null); }}
              >
                {t('accountRemove')}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {selection !== null && selection.kind === 'empty' ? (
        <div className="sn-kpEditor">
          <div className="sn-kpEditorHead">
            <span className="sn-kpEditorTitle">{selection.account + '-' + emptySlot}</span>
            <span className="sn-kpBadge">{t('schedSlotEmpty')}</span>
          </div>
          <p className="sn-hint sn-kpEditorNote">{t('schedEmptyHint')}</p>
          <label className="sn-kpField">
            <span className="sn-kpLabel">{t('accountApiKey')}</span>
            <input
              className="sn-input"
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              value={emptyKey}
              disabled={disabled}
              placeholder={t('schedEmptyKeyPlaceholder')}
              onChange={(event: Record<string, unknown>) =>
                setEmptyKey(String((event.target as { value: string }).value))}
            />
          </label>
          <div className="sn-kpEditorActions">
            <button type="button" className="sn-btnGhost" onClick={() => setShowKey(!showKey)}>
              {showKey ? t('accountHideKey') : t('accountShowKey')}
            </button>
            <button
              type="button"
              className="sn-btnGhost"
              disabled={disabled || props.onAddKey === undefined || emptyKey.trim() === ''}
              onClick={() => {
                const id = props.onAddKey?.(selection.account, emptyKey);
                if (id === undefined) return;
                setEmptyKey('');
                setSelection({ kind: 'key', id });
              }}
            >
              {t('schedEmptyAddKey')}
            </button>
            <button type="button" className="sn-btnGhost" onClick={() => setSelection(null)}>
              {t('schedEmptyClose')}
            </button>
          </div>
        </div>
      ) : null}

      <p className="sn-hint sn-kpPreview">
        {t('schedGroupsPreview', { seq: preview })}
        {totalOrphans > 0 ? t('schedGroupsOrphanTotal', { n: totalOrphans }) : ''}
      </p>

      {menu !== null ? (
        <>
          <div className="sn-kpMenuBackdrop" onMouseDown={() => setMenu(null)} />
          <div
            className="sn-kpMenu"
            ref={menuRef}
            style={{ left: `${menu.x}px`, top: `${menu.y}px`, width: `${MENU_WIDTH}px` }}
            onMouseDown={(event: Record<string, unknown>) => {
              (event as unknown as { stopPropagation: () => void }).stopPropagation();
            }}
          >
            {menu.kind === 'group' && menuRow !== undefined ? (
              <>
                <div className="sn-kpMenuTitle">
                  {`${menuRow.account}${primeOf(menu.index)} · ${menuGroup?.size ?? 0}`}
                </div>
                {menuItem(
                  t('schedGroupMergePrev'),
                  () => { commit(menuRow.account, mergeGroupAt(menuRow.sizes, menuRow.gaps, menu.index, 'prev')); setMenu(null); },
                  false,
                  menu.index === 0,
                )}
                {menuItem(
                  t('schedGroupMergeNext'),
                  () => { commit(menuRow.account, mergeGroupAt(menuRow.sizes, menuRow.gaps, menu.index, 'next')); setMenu(null); },
                  false,
                  menu.index >= menuRow.sizes.length - 1,
                )}
                {menuItem(
                  t('schedGroupOrphanize'),
                  () => { commit(menuRow.account, orphanGroupAt(menuRow.sizes, menuRow.gaps, menu.index)); setMenu(null); },
                  false,
                  menuRow.sizes.length <= 1,
                )}
                {menuItem(
                  menu.armed
                    ? t('schedGroupDropConfirm', { n: menuGroup?.size ?? 0 })
                    : t('schedGroupDrop', { n: menuGroup?.size ?? 0 }),
                  () => {
                    if (!menu.armed) { setMenu({ ...menu, armed: true }); return; }
                    commit(menuRow.account, dropGroupAt(menuRow.sizes, menuRow.gaps, menu.index));
                    for (const key of menuKeys) props.onRemoveKey(key.id);
                    setMenu(null);
                    setSelection(null);
                  },
                  true,
                  !canDropGroup,
                )}
              </>
            ) : null}
            {menu.kind === 'account' && menuRow !== undefined ? (
              <>
                <div className="sn-kpMenuTitle">
                  {t('schedAccountMenuTitle', { n: menuRow.account, keys: menuRow.keys.length, groups: menuRow.sizes.length })}
                </div>
                {menuItem(
                  menu.armed
                    ? t('schedAccountRemoveConfirm', { n: menuRow.account })
                    : t('schedAccountMenuDelete', { n: menuRow.account, keys: menuRow.keys.length }),
                  () => {
                    if (!menu.armed) { setMenu({ ...menu, armed: true }); return; }
                    for (const key of menuRow.keys) props.onRemoveKey(key.id);
                    props.onChange(props.plan.filter((entry) => entry.account !== menuRow.account));
                    setMenu(null);
                    setSelection(null);
                  },
                  true,
                  !canRemoveAccount,
                )}
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
