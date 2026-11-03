/**
 * 分组计划（每账户切几组、每组几把、组之间留几个空档）的纯逻辑（2026-11-02）。
 *
 * 与 host 侧 `group-pool.ts` 的账户轮转语义一一对应，但这里只管「配置形状」。
 * 拆成纯模块的理由：设置页的拖拽交互无法在 node 里跑，但**形状换算**可以 ——
 * 轮转序列算错是静默故障（界面好看、实际顺序不对），必须有单测兜住。
 *
 * 2026-11-02 第三版：引入 **孤立 key**。
 * `gaps` 与 `sizes` 等长 +1：`gaps[i]` 是第 i 组**前面**的空档数，`gaps[sizes.length]`
 * 是最后一组后面的空档数。空档里的 key 属于该账户、仍留在配置里，只是**不参与轮换**。
 * 这就是原型里「往小拖 → 尾部变孤立 → 往右拖再吞回」的数据形态。
 *
 * @module dsh-sensenova-freeapi/client/key-pool-plan
 */

/** 一个账户的组切分。 */
export interface SchedGroupPlan {
  /** 账户号（label `3-2` ⇒ 3；`Default` ⇒ 1）。 */
  account: number;
  /** 每组的把数。 */
  sizes: number[];
  /** 空档数（长度 = sizes.length + 1）；`gaps[i]` 在第 i 组之前，最后一项在最后。 */
  gaps?: number[];
}

/**
 * 行内的一把 key（渲染 + 编辑面板用）。
 *
 * `id` 是稳定标识：默认密钥固定为 `'default'`，其余用 `AccountView.id`；
 * 设置页据此把编辑动作路由到 `editDefaultKey` / `editAccountKey`。
 */
export interface PoolKeyRef {
  id: string;
  /** 账户号（同一个 id 只属于一个账户）。 */
  account: number;
  /** 组内顺序：越小越靠前（`Default` = −1，`N-M` = M）。 */
  slot: number;
  label: string;
  plainLabel: string;
  labelDraft: string;
  keyDraft: string;
  configured: boolean;
  writable: boolean;
  clearStaged: boolean;
  isDefault: boolean;
}

/** 渲染用的一行。 */
export interface PoolRow {
  account: number;
  keys: PoolKeyRef[];
  /** 每组的把数。 */
  sizes: number[];
  /** 空档数（长度 = sizes.length + 1）。 */
  gaps: number[];
  /** 是否来自显式计划。 */
  explicit: boolean;
  /** 每组的起始下标（由 sizes / gaps 推出，渲染直接用）。 */
  starts: number[];
  /** 未参与轮换的 key 数（各段 gaps 之和）。 */
  orphans: number;
}

/** 组内软上限：超过只提示，不拦。 */
export const GROUP_SOFT_LIMIT = 4;
/** 每账户的预留位置数（纯 UI 预留）。 */
export const SLOTS_PER_ACCOUNT = 20;

/** 从 label 解析账户号。与 host 的 `accountRotationKey` 同规则。 */
export function accountNumberOf(label: string): number | undefined {
  if (label === 'Default') return 1;
  const matched = /^(\d+)-(\d+)$/.exec(label);
  if (matched === null) return undefined;
  return Number(matched[1]);
}

/** 实际接入的账户数：把每个 label 按账户号去重（default 即账户 1）。 */
export function distinctAccountCount(labels: readonly string[]): number {
  const seen = new Set<number>();
  for (const label of labels) {
    const number = accountNumberOf(label);
    if (number !== undefined) seen.add(number);
  }
  return seen.size;
}

/** 从 label 解析槽位号：`N-M` ⇒ M；`Default` ⇒ −1（永远排最前）。 */
export function slotOf(label: string): number | undefined {
  if (label === 'Default') return -1;
  const matched = /^(\d+)-(\d+)$/.exec(label);
  if (matched === null) return undefined;
  return Number(matched[2]);
}

/** 缺省切分：by-account = 全部 key 一组；by-slot = 每把自成一组。 */
export function defaultSizes(keys: number, grouping: string): number[] {
  if (keys <= 0) return [];
  if (grouping === 'by-slot') return Array.from({ length: keys }, () => 1);
  return [keys];
}

/** 缺省空档：全 0（长度 = sizes.length + 1）。 */
export function defaultGaps(sizeCount: number): number[] {
  return Array.from({ length: Math.max(0, sizeCount) + 1 }, () => 0);
}

/**
 * 归一化切分 + 空档：去掉非法项、保证 `Σsizes + Σgaps ≤ keys`、每组 ≥ 1。
 *
 * 不做「补足到 keys」—— 差额就是尾部空档（孤立 key）。只有完全没计划时才走缺省形状。
 */
export function normalizePlan(
  sizes: readonly number[],
  gaps: readonly number[] | undefined,
  keys: number,
  grouping: string,
): { sizes: number[]; gaps: number[] } {
  if (keys <= 0) return { sizes: [], gaps: [0] };
  const clean: number[] = [];
  for (const raw of sizes) {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 1) clean.push(n);
  }
  if (clean.length === 0) {
    const fallback = defaultSizes(keys, grouping);
    return { sizes: fallback, gaps: defaultGaps(fallback.length) };
  }
  const outSizes: number[] = [];
  const outGaps: number[] = [];
  let used = 0;
  for (let i = 0; i < clean.length; i += 1) {
    if (used >= keys) break;
    const gap = Math.max(0, Math.floor(Number(gaps?.[i] ?? 0)) || 0);
    const takeGap = Math.min(gap, keys - used);
    used += takeGap;
    const take = Math.min(clean[i] ?? 1, keys - used);
    if (take < 1) { used -= takeGap; break }
    outGaps.push(takeGap);
    outSizes.push(take);
    used += take;
  }
  if (outSizes.length === 0) {
    const fallback = defaultSizes(keys, grouping);
    return { sizes: fallback, gaps: defaultGaps(fallback.length) };
  }
  outGaps.push(Math.max(0, keys - used));
  return { sizes: outSizes, gaps: outGaps };
}

/** 由 key 列表 + 计划算出渲染行（账户升序、组内按 slot 升序）。 */
export function buildPoolRows(
  keys: readonly PoolKeyRef[],
  plan: readonly SchedGroupPlan[],
  grouping: string,
): PoolRow[] {
  const byAccount = new Map<number, PoolKeyRef[]>();
  for (const key of keys) {
    const list = byAccount.get(key.account) ?? [];
    list.push(key);
    byAccount.set(key.account, list);
  }
  const planned = new Map<number, SchedGroupPlan>();
  for (const entry of plan) {
    if (typeof entry?.account === 'number' && Array.isArray(entry.sizes)) planned.set(entry.account, entry);
  }
  return [...byAccount.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([account, list]) => {
      const sorted = [...list].sort((a, b) => a.slot - b.slot || a.label.localeCompare(b.label));
      const explicit = planned.get(account);
      const fallback = defaultSizes(sorted.length, grouping);
      const shape = explicit !== undefined
        ? normalizePlan(explicit.sizes, explicit.gaps, sorted.length, grouping)
        : { sizes: fallback, gaps: defaultGaps(fallback.length) };
      const starts: number[] = [];
      let cursor = 0;
      for (let i = 0; i < shape.sizes.length; i += 1) {
        cursor += shape.gaps[i] ?? 0;
        starts.push(cursor);
        cursor += shape.sizes[i] ?? 0;
      }
      return {
        account,
        keys: sorted,
        sizes: shape.sizes,
        gaps: shape.gaps,
        explicit: explicit !== undefined,
        starts,
        orphans: shape.gaps.reduce((sum, n) => sum + n, 0),
      };
    });
}

/** 拖动的是组的哪一条边。 */
export type GripSide = 'left' | 'right';

/**
 * 拖一条边挪一把 key（v7 语义，2026-11-02 补齐左右两侧）。
 *
 * - `side='right'`：`dir=+1` 向右扩 —— 先吞右侧空档一把；没有空档再吃右邻组头一把
 *   （右邻组保底 1 把）；`dir=−1` 向左缩 —— 本组尾把脱出成空档。
 * - `side='left'`：`dir=−1` 向左扩 —— 先吞左侧空档一把；没有空档再吃左邻组尾一把
 *   （左邻组保底 1 把）；`dir=+1` 向右缩 —— 本组头把脱出成空档。
 *
 * 行首组（组前既没空档也没别的组）没有左手柄，向右缩直接返回 `undefined`。
 */
export function resizeEdge(
  sizes: readonly number[],
  gaps: readonly number[],
  index: number,
  side: GripSide,
  dir: 1 | -1,
): { sizes: number[]; gaps: number[] } | undefined {
  const nextSizes = [...sizes];
  const nextGaps = [...gaps];
  while (nextGaps.length < sizes.length + 1) nextGaps.push(0);
  const size = nextSizes[index];
  if (size === undefined) return undefined;

  if (side === 'right') {
    if (dir === 1) {
      const gapAfter = nextGaps[index + 1] ?? 0;
      if (gapAfter > 0) {
        nextGaps[index + 1] = gapAfter - 1;
        nextSizes[index] = size + 1;
        return { sizes: nextSizes, gaps: nextGaps };
      }
      const right = nextSizes[index + 1];
      if (right === undefined || right <= 1) return undefined;
      nextSizes[index] = size + 1;
      nextSizes[index + 1] = right - 1;
      return { sizes: nextSizes, gaps: nextGaps };
    }
    if (size <= 1) return undefined;
    nextSizes[index] = size - 1;
    nextGaps[index + 1] = (nextGaps[index + 1] ?? 0) + 1;
    return { sizes: nextSizes, gaps: nextGaps };
  }

  if (dir === -1) {
    const gapBefore = nextGaps[index] ?? 0;
    if (gapBefore > 0) {
      nextGaps[index] = gapBefore - 1;
      nextSizes[index] = size + 1;
      return { sizes: nextSizes, gaps: nextGaps };
    }
    const left = nextSizes[index - 1];
    if (left === undefined || left <= 1) return undefined;
    nextSizes[index - 1] = left - 1;
    nextSizes[index] = size + 1;
    return { sizes: nextSizes, gaps: nextGaps };
  }

  // 向右缩（头把脱出）：行首组没有左手柄，v7 里也拖不动。
  let start = nextGaps[index] ?? 0;
  for (let i = 0; i < index; i += 1) start += (nextGaps[i] ?? 0) + (nextSizes[i] ?? 0);
  if (start <= 0 || size <= 1) return undefined;
  nextSizes[index] = size - 1;
  nextGaps[index] = (nextGaps[index] ?? 0) + 1;
  return { sizes: nextSizes, gaps: nextGaps };
}

/**
 * 把第 index 组并进相邻组（连同两者之间的空档一起）。
 *
 * - `dir='prev'`：前一组吃下「空档 + 本组」，本组消失；行首组没有前一组，返回 undefined。
 * - `dir='next'`：后一组吃下「本组 + 空档」，本组消失；行尾组没有后一组，返回 undefined。
 */
export function mergeGroupAt(
  sizes: readonly number[],
  gaps: readonly number[],
  index: number,
  dir: 'prev' | 'next',
): { sizes: number[]; gaps: number[] } | undefined {
  if (sizes.length <= 1) return undefined;
  const size = sizes[index];
  if (size === undefined) return undefined;
  const nextSizes = [...sizes];
  const nextGaps = [...gaps];
  while (nextGaps.length < sizes.length + 1) nextGaps.push(0);
  if (dir === 'prev') {
    if (index === 0) return undefined;
    nextSizes[index - 1] = (nextSizes[index - 1] ?? 0) + (nextGaps[index] ?? 0) + size;
    nextGaps.splice(index, 1);
  } else {
    if (index >= sizes.length - 1) return undefined;
    nextSizes[index + 1] = size + (nextGaps[index + 1] ?? 0) + (nextSizes[index + 1] ?? 0);
    nextGaps.splice(index + 1, 1);
  }
  nextSizes.splice(index, 1);
  return { sizes: nextSizes, gaps: nextGaps };
}

/**
 * 删掉第 index 组（**连同组里那几把 key**）：前后空档合并，组消失。
 *
 * 注意：返回的形状已经扣掉这一组的把数（等价于「key 已删除」）。调用方先写回形状、
 * 再删 key 时，`normalizePlan` 会临时把差额记进尾部空档，等 key 真变少后自动收敛
 * （line 136 的 `keys - used`）；反过来先删 key 也一样。只剩一组时返回 undefined。
 */
export function dropGroupAt(
  sizes: readonly number[],
  gaps: readonly number[],
  index: number,
): { sizes: number[]; gaps: number[] } | undefined {
  if (sizes.length <= 1) return undefined;
  const size = sizes[index];
  if (size === undefined) return undefined;
  const nextSizes = [...sizes];
  const nextGaps = [...gaps];
  while (nextGaps.length < sizes.length + 1) nextGaps.push(0);
  nextGaps[index] = (nextGaps[index] ?? 0) + (nextGaps[index + 1] ?? 0);
  nextGaps.splice(index + 1, 1);
  nextSizes.splice(index, 1);
  return { sizes: nextSizes, gaps: nextGaps };
}

/** 从最后一组切出新组：切 min(软上限, ⌊size/2⌋) 把。最后一组 < 2 把时返回 undefined。 */
export function splitLast(
  sizes: readonly number[],
  gaps: readonly number[],
  limit: number = GROUP_SOFT_LIMIT,
): { sizes: number[]; gaps: number[] } | undefined {
  const last = sizes[sizes.length - 1];
  if (last === undefined || last < 2) return undefined;
  const cut = Math.min(Math.max(1, limit), Math.floor(last / 2));
  if (cut < 1) return undefined;
  const nextSizes = [...sizes];
  nextSizes[nextSizes.length - 1] = last - cut;
  nextSizes.push(cut);
  const nextGaps = [...gaps];
  while (nextGaps.length < sizes.length + 1) nextGaps.push(0);
  const tail = nextGaps[sizes.length] ?? 0;
  nextGaps[sizes.length] = 0;   // 新组紧挨着前一组
  nextGaps.push(tail);
  return { sizes: nextSizes, gaps: nextGaps };
}

/**
 * 整组移出轮换：这一组的所有 key 变成孤立（落进组前空档），组本身消失。
 * 账户至少保留一组，所以只剩一组时返回 undefined。
 */
export function orphanGroupAt(
  sizes: readonly number[],
  gaps: readonly number[],
  index: number,
): { sizes: number[]; gaps: number[] } | undefined {
  if (sizes.length <= 1) return undefined;
  const size = sizes[index];
  if (size === undefined) return undefined;
  const nextGaps = [...gaps];
  while (nextGaps.length < sizes.length + 1) nextGaps.push(0);
  nextGaps[index] = (nextGaps[index] ?? 0) + size + (nextGaps[index + 1] ?? 0);
  nextGaps.splice(index + 1, 1);
  const nextSizes = [...sizes];
  nextSizes.splice(index, 1);
  return { sizes: nextSizes, gaps: nextGaps };
}

/**
 * 把组内第 offset 把 key 单独移出成孤立（key 保留，只是不参与轮换）。
 * - 头把 / 尾把：组少一把，空档 +1；
 * - 中间那把：组被一分为二，两段之间夹一个空档（v7 的 isolate 行为）。
 */
export function isolateKeyAt(
  sizes: readonly number[],
  gaps: readonly number[],
  index: number,
  offset: number,
): { sizes: number[]; gaps: number[] } | undefined {
  const size = sizes[index];
  if (size === undefined || size <= 1) return undefined;
  if (offset < 0 || offset >= size) return undefined;
  const nextSizes = [...sizes];
  const nextGaps = [...gaps];
  while (nextGaps.length < sizes.length + 1) nextGaps.push(0);
  if (offset === 0) {
    nextSizes[index] = size - 1;
    nextGaps[index] = (nextGaps[index] ?? 0) + 1;
    return { sizes: nextSizes, gaps: nextGaps };
  }
  if (offset === size - 1) {
    nextSizes[index] = size - 1;
    nextGaps[index + 1] = (nextGaps[index + 1] ?? 0) + 1;
    return { sizes: nextSizes, gaps: nextGaps };
  }
  nextSizes[index] = offset;
  nextSizes.splice(index + 1, 0, size - offset - 1);
  nextGaps.splice(index + 1, 0, 1);
  return { sizes: nextSizes, gaps: nextGaps };
}

/** 行尾「+」的一半语义：把末尾空档里的孤立 key 收编成一个新组。没有尾部孤立则返回 undefined。 */
export function adoptTailOrphans(
  sizes: readonly number[],
  gaps: readonly number[],
): { sizes: number[]; gaps: number[] } | undefined {
  const nextGaps = [...gaps];
  while (nextGaps.length < sizes.length + 1) nextGaps.push(0);
  const tail = nextGaps[sizes.length] ?? 0;
  if (tail <= 0) return undefined;
  nextGaps[sizes.length] = 0;
  nextGaps.push(0);   // 新组在行尾，后面没有空档
  return { sizes: [...sizes, tail], gaps: nextGaps };
}

/** 把某账户的新形状写回计划；与缺省形状相同则移除计划项。 */
export function withRowPlan(
  plan: readonly SchedGroupPlan[],
  row: PoolRow,
  next: { sizes: number[]; gaps: number[] } | undefined,
  grouping: string,
): SchedGroupPlan[] {
  if (next === undefined) return [...plan];
  const normalized = normalizePlan(next.sizes, next.gaps, row.keys.length, grouping);
  const isDefault = normalized.sizes.length === 1
    && normalized.sizes[0] === row.keys.length
    && (normalized.gaps[0] ?? 0) === 0
    && grouping !== 'by-slot';
  const rest = plan.filter((entry) => entry.account !== row.account);
  if (isDefault) return rest;
  const entry: SchedGroupPlan = { account: row.account, sizes: normalized.sizes, gaps: normalized.gaps };
  const at = plan.findIndex((candidate) => candidate.account > row.account);
  const ordered = [...plan];
  if (at < 0) ordered.push(entry);
  else ordered.splice(at, 0, entry);
  return ordered.filter((candidate) => candidate.account !== row.account || candidate === entry);
}

/** 轮转预览：宏观按账户轮转、微观各账户组游标各自前进（孤立 key 不参与）。 */
export function rotationSeq(
  rows: readonly PoolRow[],
  steps: number,
): { account: number; ordinal: number }[] {
  const out: { account: number; ordinal: number }[] = [];
  if (rows.length === 0) return out;
  for (let cycle = 0; out.length < steps && cycle < steps * 4; cycle += 1) {
    for (const row of rows) {
      if (out.length >= steps) break;
      if (row.sizes.length === 0) continue;
      out.push({ account: row.account, ordinal: cycle % row.sizes.length });
    }
  }
  return out;
}

/** 一次真实尝试：哪个账户、哪一组、组内第几把。 */
export interface RotationTick {
  account: number;
  group: number;
  /** 组内下标（0 起）。 */
  offset: number;
  /** 本组把数。 */
  size: number;
  /** 第几轮（1 起）。 */
  round: number;
  /** 总轮数。 */
  rounds: number;
  key: PoolKeyRef;
}

/**
 * 展开「预算轮数」的完整尝试序列（演示与 host fixed 调度共用同一套宏观语义）。
 *
 * 一轮 = max(各账户组数) 个宏观周期；每个周期按账户顺序各走一步，账户内组游标
 * 独立前进（cycle % 该账户组数）；每把 key 每轮恰好用一次。走满 `rounds` 轮
 * 全败 = rounds × max组数 个周期，与 adapter 的 `scheduling.roundBudget` 对应。
 */
export function rotationTicks(
  rows: readonly PoolRow[],
  rounds = 2,
): RotationTick[] {
  const out: RotationTick[] = [];
  const maxGroups = rows.reduce((max, row) => Math.max(max, row.sizes.length), 0);
  if (maxGroups === 0 || rounds <= 0) return out;
  for (let cycle = 0; cycle < rounds * maxGroups; cycle += 1) {
    for (const row of rows) {
      const groups = row.sizes.length;
      if (groups === 0) continue;
      const group = cycle % groups;
      const start = row.starts[group] ?? 0;
      const size = row.sizes[group] ?? 0;
      for (let offset = 0; offset < size; offset += 1) {
        const key = row.keys[start + offset];
        if (key === undefined) continue;
        out.push({
          account: row.account,
          group,
          offset,
          size,
          round: Math.floor(cycle / maxGroups) + 1,
          rounds,
          key,
        });
      }
    }
  }
  return out;
}

/**
 * 智能分组：把一个账户的 key 切成「每段 4 把、余数单独成一段」的组。
 * 16 把 → [4,4,4,4]；18 把 → [4,4,4,4,2]；5 把 → [4,1]。
 * 只在导入后自动执行一次，另有手动「智能分组」按钮可随时重做。
 */
export function smartSizes(keys: number, chunk = GROUP_SOFT_LIMIT): number[] {
  if (keys <= 0) return [];
  const sizes: number[] = [];
  let rest = keys;
  while (rest >= chunk) { sizes.push(chunk); rest -= chunk; }
  if (rest > 0) sizes.push(rest);
  return sizes;
}

/** 把一个账户的组计划更新为 4 个一组；返回新的计划数组（保持账户顺序）。 */
export function smartGroupPlan(
  plan: readonly SchedGroupPlan[],
  row: PoolRow,
  grouping: string,
): SchedGroupPlan[] {
  const sizes = smartSizes(row.keys.length);
  const gaps = defaultGaps(sizes.length);
  return withRowPlan(plan, row, { sizes, gaps }, grouping);
}

/**
 * 智能组间定时（2026-11-03）：按「实际接入账户数」推荐组间定时。
 *
 * 规则（用户拍板）：4 账户 → 20s；3 账户 → 30s；2 / 1 账户 → 60s；
 * 账户数 ≥ 4 一律 20s（更多账户时 20s 也满足休息，允许手动调低）。
 *
 * 约束：`(账户数 − 1) × 组间定时 ≥ 60s`，保证同一账户两次使用之间至少休息一分钟。
 * 规则表本身满足该式（4×20=3×30=2×60=60s），`minGroupGapMs` 给出手动调低时的下限。
 */
export function smartGroupGapMs(accounts: number): number {
  if (accounts <= 0) return 0;
  if (accounts >= 4) return 20_000;
  if (accounts === 3) return 30_000;
  return 60_000; // 2 / 1 账户
}

/** 让 `(账户数 − 1) × gap ≥ 60s` 的最小组间定时；单账户无间隔需求返回 0。 */
export function minGroupGapMs(accounts: number): number {
  if (accounts <= 1) return 0;
  return Math.ceil(60_000 / (accounts - 1));
}

/** 组序号转上标撇号：0 ⇒ ''、1 ⇒ '′'、2 ⇒ '″'。 */
export function primeOf(index: number): string {
  return index === 0 ? '' : '′'.repeat(index);
}
