/**
 * SenseNova 设置页 React 组件（settings.section slot 内容）。
 * 所有文案经 `t`（settings.sensenova 命名空间）读取，不硬编码。
 */
import { useState } from 'react';
import * as React from 'react';
import { KeyPoolEditor } from './key-pool-editor';
import { accountNumberOf, distinctAccountCount, minGroupGapMs, slotOf, smartGroupGapMs } from './key-pool-plan';
import type { PoolKeyRef, SchedGroupPlan } from './key-pool-plan';
import {
  DEFAULT_API_BASE,
  DEFAULT_ERROR_LOG,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_POOL_DRAFT,
  DEFAULT_RETRY_DRAFT,
  QUEUE_TIMEOUT_MIN_MS,
  RETRY_MAX_DELAY_FLOOR_MS,
} from './settings';
import type {
  ErrorLogState,
  FieldName,
  KeysIoState,
  ModelInfoSnapshotView,
  ModelInfoState,
  ModelParamView,
  PoolNumberField,
  RetryNumberField,
  SchedulingDraft,
  SchedulingNumberField,
  SettingsState,
  TranslateFn,
  VisionBridgeMode,
  VisionDraft,
} from './settings';

interface ReactHooks {
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
  useRef<T>(initialValue: T): { current: T };
}

const { useEffect, useRef } = React as unknown as ReactHooks;

/** 输入框 change 事件的最小结构（宿主模块表提供真实 React 类型）。 */
interface ChangeEventLike {
  target: { value: string };
}

/** 复选框 change 事件的最小结构。 */
interface ToggleEventLike {
  target: { checked: boolean };
}

export interface SenseNovaSectionProps {
  t: TranslateFn;
  /** slots 框架注入的 uSES hook（由 injected.hooks.sensenovaSettings 派生）。 */
  useSensenovaSettings: <S>(selector: (snapshot: SettingsState) => S) => S;
  edit: (field: FieldName, text: string) => void;
  save: () => void;
  discard: () => void;
  addAccount: () => void;
  /** 在指定账户下新增一把 key（空位面板），返回新账户 id。 */
  addAccountKey: (account: number, key: string) => string | undefined;
  removeAccount: (id: string) => void;
  editAccountLabel: (id: string, text: string) => void;
  editAccountKey: (id: string, text: string) => void;
  toggleAccountKeyClear: (id: string) => void;
  editDefaultKey: (text: string) => void;
  toggleDefaultKeyClear: () => void;
  setActiveAccount: (id: string) => void;
  setQuotaRotation: (on: boolean) => void;
  /** 限流事件记录器开关（W5 2026-09-17）。 */
  setErrorLog: (on: boolean) => void;
  /** 错误记录诊断区块：拉取最近记录（只读，2026-09-18）。 */
  refreshErrorLog: () => void;
  /** 错误记录诊断区块：展开/收起某一行。 */
  toggleErrorLogRow: (index: number) => void;
  /** 运行日志展示模式切换（v0.5 P0）：`'limits'` = 只显示限流/异常，`'all'` = 全部。 */
  setErrorLogMode: (mode: 'limits' | 'vision' | 'all') => void;
  /** 「当前模型 + 全部参数」面板：拉取快照（只读，2026-09-23 Phase 5）。 */
  refreshModelInfo: () => void;
  /** Key 导入 / 导出：编辑文本框内容（v0.2.1）。 */
  editKeysIoText: (text: string) => void;
  /** Key 导入 / 导出：导出全部 key（host 只读路由返回明文）。 */
  exportKeys: () => void;
  /** Key 导入 / 导出：导入文本框里的 key（写草稿，需点保存）。 */
  importKeys: () => void;
  /** 顶部「刷新」：重查凭据状态（兜底手动刷新，v0.2.4）。 */
  refreshCredentials: () => void;
  /** 清空全部额外账户（staged，保存后生效；v0.2.5）。 */
  clearAllAccounts: () => void;
  /** 重试策略：模式单选（W1 2026-09-17）。 */
  setRetryMode: (mode: 'normal' | 'always') => void;
  /** 重试策略：数字字段编辑。 */
  editRetry: (field: RetryNumberField, text: string) => void;
  /** key 池策略：数字字段编辑（2026-09-27）。 */
  editPool: (field: PoolNumberField, text: string) => void;
  /** 调度策略：模式切换（2026-11-01）。 */
  setSchedMode: (mode: string) => void;
  /** 调度策略：分组形状切换（2026-11-02）。 */
  setSchedGrouping: (grouping: string) => void;
  /** 调度策略：分组计划（每账户切几组，2026-11-02）。 */
  setSchedGroups: (plan: SchedGroupPlan[]) => void;
  /** 智能分组：按 4 个一组重排（导入后自动执行一次，手动可重做）。 */
  smartGroupAll: () => void;
  /** 调度策略：数字字段编辑（2026-11-01）。 */
  editSched: (field: SchedulingNumberField, text: string) => void;
  /** 智能组间定时：按实际账户数推荐组间定时。 */
  smartGroupGap: () => void;
  /** 视觉辅助：总开关。 */
  setVisionEnabled: (on: boolean) => void;
  /** 视觉辅助：读图桥模式。 */
  setVisionBridgeMode: (mode: VisionBridgeMode) => void;
  /** 视觉辅助：模型链 / 超时 / 提示词编辑。 */
  editVisionField: (field: 'modelChain' | 'timeoutMs' | 'bridgePrompt', text: string) => void;
}

function useSavedFlash(savedCount: number): boolean {
  const [visible, setVisible] = useState(false);
  const previousCount = useRef(savedCount);

  useEffect(() => {
    if (savedCount === previousCount.current) return;
    previousCount.current = savedCount;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 2500);
    return () => clearTimeout(timer);
  }, [savedCount]);

  return visible;
}

/** 凭据状态徽标：已配置 / 未配置。 */
export function StatusBadge({ configured, t }: { configured: boolean; t: TranslateFn }): JSX.Element {
  return (
    <span className={configured ? 'sn-badge' : 'sn-badgeMuted'}>
      {configured ? t('apiKeySet') : t('apiKeyUnset')}
    </span>
  );
}

function addCredentialReference(refs: Set<string>, value: string): void {
  const normalized = value.trim();
  if (normalized !== '') refs.add(normalized);
}

export function credentialReferences(state: SettingsState): ReadonlySet<string> {
  const refs = new Set<string>();
  addCredentialReference(refs, state.apiKeyEnv);
  for (const account of state.accounts) addCredentialReference(refs, account.ref);
  return refs;
}

function isCredentialReference(label: string, refs: ReadonlySet<string>): boolean {
  const value = label.trim();
  if (value === '') return false;
  for (const ref of refs) {
    if (value.includes(ref)) return true;
  }
  return false;
}

export function accountDisplayLabel(
  account: { labelDraft: string },
  index: number,
  t: TranslateFn,
  refs: ReadonlySet<string>,
): string {
  const label = account.labelDraft.trim();
  return label !== '' && !isCredentialReference(label, refs)
    ? label
    : t('accountFallback', { index: index + 1 });
}

/** 分组标题：引导后续卡片的分区归属。 */
function SectionHeading(props: { text: string }): JSX.Element {
  return <h3 className="sn-groupTitle">{props.text}</h3>;
}

function AdvancedSettings(props: {
  t: TranslateFn;
  state: SettingsState;
  disabled: boolean;
  edit: (field: FieldName, text: string) => void;
  setQuotaRotation: (on: boolean) => void;
  setErrorLog: (on: boolean) => void;
  setRetryMode: (mode: 'normal' | 'always') => void;
  editRetry: (field: RetryNumberField, text: string) => void;
  editPool: (field: PoolNumberField, text: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const retry = props.state.retryPolicyDraft;
  const pool = props.state.poolPolicyDraft;
  const customizedCount =
    (props.state.apiBase !== DEFAULT_API_BASE ? 1 : 0) +
    (props.state.concurrency !== 1 ? 1 : 0) +
    (props.state.queueTimeoutMs !== DEFAULT_QUEUE_TIMEOUT_MS ? 1 : 0) +
    (props.state.quotaRotation !== false ? 1 : 0) +
    (props.state.errorLog !== DEFAULT_ERROR_LOG ? 1 : 0) +
    (retry.mode !== DEFAULT_RETRY_DRAFT.mode ? 1 : 0) +
    (retry.maxRetries !== DEFAULT_RETRY_DRAFT.maxRetries ? 1 : 0) +
    (retry.maxDelayMs !== DEFAULT_RETRY_DRAFT.maxDelayMs ? 1 : 0) +
    (retry.initialDelayMs !== DEFAULT_RETRY_DRAFT.initialDelayMs ? 1 : 0) +
    (retry.jitterRatio !== DEFAULT_RETRY_DRAFT.jitterRatio ? 1 : 0) +
    (pool.kickThreshold !== DEFAULT_POOL_DRAFT.kickThreshold ? 1 : 0) +
    (pool.probeInitialMs !== DEFAULT_POOL_DRAFT.probeInitialMs ? 1 : 0) +
    (pool.probeBackoffFactor !== DEFAULT_POOL_DRAFT.probeBackoffFactor ? 1 : 0) +
    (pool.probeMaxMs !== DEFAULT_POOL_DRAFT.probeMaxMs ? 1 : 0) +
    (pool.capacity !== DEFAULT_POOL_DRAFT.capacity ? 1 : 0);

  return (
    <div className="sn-card sn-advanced">
      <button
        type="button"
        className="sn-advancedHeader"
        aria-expanded={expanded}
        aria-controls="sn-advanced-settings"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="sn-label">{props.t('advancedSettings')}</span>
        <span className="sn-advancedMeta">
          {customizedCount > 0 ? (
            <span
              className="sn-badgeMuted"
              aria-label={props.t('advancedCustomizedCount', { count: customizedCount })}
            >
              {customizedCount}
            </span>
          ) : null}
          <span
            className={`sn-advancedChevron${expanded ? ' sn-advancedChevronExpanded' : ''}`}
            aria-hidden="true"
          />
        </span>
      </button>

      <div id="sn-advanced-settings" className="sn-advancedBody" hidden={!expanded}>
        <div className="sn-field">
          <label className="sn-label" htmlFor="sn-api-base">
            {props.t('apiBase')}
          </label>
          <input
            id="sn-api-base"
            className="sn-input"
            type="text"
            value={props.state.apiBaseDraft}
            disabled={props.disabled}
            spellCheck={false}
            onChange={(event: ChangeEventLike) => props.edit('apiBase', event.target.value)}
          />
          <p className="sn-hint">{props.t('apiBaseHint')}</p>
        </div>

        <div className="sn-models">
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-concurrency">
              {props.t('concurrency')}
            </label>
            <input
              id="sn-concurrency"
              className="sn-input"
              type="number"
              min={1}
              step={1}
              value={props.state.concurrencyDraft}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.edit('concurrency', event.target.value)}
            />
            <p className="sn-hint">{props.t('concurrencyHint')}</p>
          </div>
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-queue-timeout">
              {props.t('queueTimeoutMs')}
            </label>
            <input
              id="sn-queue-timeout"
              className="sn-input"
              type="number"
              min={QUEUE_TIMEOUT_MIN_MS}
              step={1000}
              value={props.state.queueTimeoutMsDraft}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.edit('queueTimeoutMs', event.target.value)}
            />
            <p className="sn-hint">{props.t('queueTimeoutMsHint')}</p>
          </div>
          <p className="sn-hint sn-modelsNote">{props.t('modelsAutoManaged')}</p>
        </div>

        <div className="sn-field">
          <label className="sn-fieldHead" htmlFor="sn-quota-rotation">
            <span className="sn-label">{props.t('quotaRotation')}</span>
            <input
              id="sn-quota-rotation"
              className="sn-toggle"
              type="checkbox"
              checked={props.state.quotaRotationDraft}
              disabled={props.disabled}
              onChange={(event: ToggleEventLike) => props.setQuotaRotation(event.target.checked)}
            />
          </label>
          <p className="sn-hint">{props.t('quotaRotationHint')}</p>
        </div>

        {/*
          限流事件记录器（W5 2026-09-17，host 侧 W4 已落地）——
          把每次 429 追加到 JSONL。host 侧是 thunk 取值 ⇒ 关掉即刻静默，
          不触发适配器重注册，因此与上面的 retryPolicy 不同：改它无需任何刷新。
        */}
        <div className="sn-field">
          <label className="sn-fieldHead" htmlFor="sn-error-log">
            <span className="sn-label">{props.t('errorLog')}</span>
            <input
              id="sn-error-log"
              className="sn-toggle"
              type="checkbox"
              checked={props.state.errorLogDraft}
              disabled={props.disabled}
              onChange={(event: ToggleEventLike) => props.setErrorLog(event.target.checked)}
            />
          </label>
          <p className="sn-hint">{props.t('errorLogHint')}</p>
        </div>

        {/*
          重试策略（W1 2026-09-17）——对「响应速度 / 等待时长 / 429 频率」影响最
          直接的一组旋钮，此前硬编码在 adapter.ts 里（改一次要重建 lib + 重启 web）。

          ⚠️ maxDelayMs 的输入下限刻意钉死为 RETRY_MAX_DELAY_FLOOR_MS（30 万毫秒）：
          低于它会重新引入「悬崖」——落入 (该值, 30 万] 的限流等待会被宿主**直接
          放弃重试**，回合立即失败。host 侧 `mergeRetryPolicy()` 还有第二道兜底。
        */}
        <div className="sn-field">
          <div className="sn-fieldHead">
            <span className="sn-label">{props.t('retryTitle')}</span>
          </div>
          <p className="sn-hint">{props.t('retryIntro')}</p>
        </div>

        <div className="sn-field">
          <label className="sn-label" htmlFor="sn-retry-mode">
            {props.t('retryMode')}
          </label>
          <select
            id="sn-retry-mode"
            className="sn-input"
            value={retry.mode}
            disabled={props.disabled}
            onChange={(event: ChangeEventLike) =>
              props.setRetryMode(event.target.value === 'always' ? 'always' : 'normal')
            }
          >
            <option value="normal">{props.t('retryModeNormal')}</option>
            <option value="always">{props.t('retryModeAlways')}</option>
          </select>
          <p className="sn-hint">
            {retry.mode === 'always' ? props.t('retryModeHintAlways') : props.t('retryModeHintNormal')}
          </p>
        </div>

        <div className="sn-models">
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-retry-max-retries">
              {props.t('retryMaxRetries')}
            </label>
            <input
              id="sn-retry-max-retries"
              className="sn-input"
              type="number"
              min={0}
              step={1}
              value={retry.maxRetries}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.editRetry('maxRetries', event.target.value)}
            />
            <p className="sn-hint">{props.t('retryMaxRetriesHint')}</p>
          </div>
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-retry-max-delay">
              {props.t('retryMaxDelayMs')}
            </label>
            <input
              id="sn-retry-max-delay"
              className="sn-input"
              type="number"
              min={RETRY_MAX_DELAY_FLOOR_MS}
              step={1000}
              value={retry.maxDelayMs}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.editRetry('maxDelayMs', event.target.value)}
            />
            <p className="sn-hint">{props.t('retryMaxDelayMsHint')}</p>
          </div>
        </div>

        <div className="sn-models">
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-retry-initial-delay">
              {props.t('retryInitialDelayMs')}
            </label>
            <input
              id="sn-retry-initial-delay"
              className="sn-input"
              type="number"
              min={1}
              step={100}
              value={retry.initialDelayMs}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.editRetry('initialDelayMs', event.target.value)}
            />
            <p className="sn-hint">{props.t('retryInitialDelayMsHint')}</p>
          </div>
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-retry-jitter">
              {props.t('retryJitterRatio')}
            </label>
            <input
              id="sn-retry-jitter"
              className="sn-input"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={retry.jitterRatio}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.editRetry('jitterRatio', event.target.value)}
            />
            <p className="sn-hint">{props.t('retryJitterRatioHint')}</p>
          </div>
        </div>

        {/*
          Key 池（2026-09-27）——「运行态 / 阻塞态」双列表的调参面。

          ⚠️ 它只在 `quotaRotation` 开启时才影响运行时行为：踢出与借用都发生在
          「配额类 429 换 key」这条路径上，开关关着时这些值不参与任何决策。
        */}
        <div className="sn-field">
          <div className="sn-fieldHead">
            <span className="sn-label">{props.t('poolTitle')}</span>
          </div>
          <p className="sn-hint">{props.t('poolIntro')}</p>
        </div>

        <div className="sn-models">
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-pool-kick">
              {props.t('poolKickThreshold')}
            </label>
            <input
              id="sn-pool-kick"
              className="sn-input"
              type="number"
              min={1}
              max={10}
              step={1}
              value={pool.kickThreshold}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.editPool('kickThreshold', event.target.value)}
            />
            <p className="sn-hint">{props.t('poolKickThresholdHint')}</p>
          </div>
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-pool-capacity">
              {props.t('poolCapacity')}
            </label>
            <input
              id="sn-pool-capacity"
              className="sn-input"
              type="number"
              min={1}
              max={10}
              step={1}
              value={pool.capacity}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.editPool('capacity', event.target.value)}
            />
            <p className="sn-hint">{props.t('poolCapacityHint')}</p>
          </div>
        </div>

        <div className="sn-models">
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-pool-probe-initial">
              {props.t('poolProbeInitialMs')}
            </label>
            <input
              id="sn-pool-probe-initial"
              className="sn-input"
              type="number"
              min={5000}
              max={300000}
              step={1000}
              value={pool.probeInitialMs}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.editPool('probeInitialMs', event.target.value)}
            />
            <p className="sn-hint">{props.t('poolProbeInitialMsHint')}</p>
          </div>
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-pool-probe-factor">
              {props.t('poolProbeBackoffFactor')}
            </label>
            <input
              id="sn-pool-probe-factor"
              className="sn-input"
              type="number"
              min={1}
              max={10}
              step={0.5}
              value={pool.probeBackoffFactor}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.editPool('probeBackoffFactor', event.target.value)}
            />
            <p className="sn-hint">{props.t('poolProbeBackoffFactorHint')}</p>
          </div>
        </div>

        <div className="sn-models">
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-pool-probe-max">
              {props.t('poolProbeMaxMs')}
            </label>
            <input
              id="sn-pool-probe-max"
              className="sn-input"
              type="number"
              min={5000}
              max={600000}
              step={1000}
              value={pool.probeMaxMs}
              disabled={props.disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.editPool('probeMaxMs', event.target.value)}
            />
            <p className="sn-hint">{props.t('poolProbeMaxMsHint')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 把 ISO 时间戳渲染成 `HH:MM:SS`；解析失败时退化为原串的时分秒片段。 */
function formatClock(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return ts.length >= 19 ? ts.slice(11, 19) : ts;
  const date = new Date(parsed);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}


function KeysIoPanel(props: {
  t: TranslateFn;
  state: KeysIoState;
  disabled: boolean;
  onEditText: (text: string) => void;
  onExport: () => void;
  onImport: () => void;
  onClearText: () => void;
}): JSX.Element {
  return (
    <div className="sn-card">
      <div className="sn-field">
        <span className="sn-label">{props.t('keysIoTitle')}</span>
        <p className="sn-hint">{props.t('keysIoHint')}</p>
      </div>
      <textarea
        className="sn-textarea sn-input"
        rows={8}
        value={props.state.text}
        placeholder={props.t('keysIoPlaceholder')}
        spellCheck={false}
        disabled={props.disabled || props.state.busy}
        onChange={(event: ChangeEventLike) => props.onEditText(event.target.value)}
      />
      <div className="sn-actions">
        <button
          type="button"
          className="sn-btnGhost"
          disabled={props.disabled || props.state.busy}
          onClick={props.onExport}
        >
          {props.t('keysExport')}
        </button>
        <button
          type="button"
          className="sn-btnPrimary"
          disabled={props.disabled || props.state.busy || props.state.text.trim() === ''}
          onClick={props.onImport}
        >
          {props.t('keysImport')}
        </button>
        <button
          type="button"
          className="sn-btnGhost"
          disabled={props.disabled || props.state.busy || props.state.text === ''}
          onClick={props.onClearText}
        >
          {props.t('keysIoClear')}
        </button>
      </div>
      {props.state.error !== '' ? <p className="sn-hint sn-error">{props.state.error}</p> : null}
      {props.state.message !== '' ? <p className="sn-hint">{props.state.message}</p> : null}
    </div>
  );
}

function ErrorLogPanel(props: {
  t: TranslateFn;
  state: ErrorLogState;
  onRefresh: () => void;
  onToggleRow: (index: number) => void;
  onSetMode: (mode: 'limits' | 'vision' | 'all') => void;
}): JSX.Element {
  const log = props.state;
  const busy = log.status === 'loading';
  // v0.5 P0：「限流」模式 = 只显示限流/异常行（result !== 'ok'，含旧日志无 result 的行）。
  // 过滤是纯显示层动作，不动 state.entries —— 展开下标仍按原始索引对齐。
  // 三档（2026-11-02 加 'vision'）：视觉行成功时 result='ok'，在「限流」档看不到，
  // 而视觉调用恰恰是最需要单独观察的一类 —— 单独成档，按 phase 过滤。
  const visible = log.mode === 'limits'
    ? log.entries.filter((entry) => entry.result !== 'ok')
    : log.mode === 'vision'
      ? log.entries.filter((entry) => entry.phase === 'vision')
      : log.entries;

  let body: JSX.Element;
  if (log.status === 'idle') {
    body = <p className="sn-hint">{props.t('diagnosticsIdle')}</p>;
  } else if (log.status === 'error') {
    body = <p className="sn-hint sn-diagnosticsWarn">{props.t('diagnosticsUnavailable')}</p>;
  } else if (!log.available || visible.length === 0) {
    body = <p className="sn-hint">{props.t('diagnosticsEmpty')}</p>;
  } else {
    body = (
      <div className="sn-diagnosticsBody">
        <div className="sn-diagnosticsStats">
          <div className="sn-diagnosticsStat">
            <span className="sn-hint">{props.t('diagnosticsStatTotal')}</span>
            <span className="sn-diagnosticsValue">{log.total}</span>
          </div>
          <div className="sn-diagnosticsStat">
            <span className="sn-hint">{props.t('diagnosticsStatCodes')}</span>
            <span className="sn-diagnosticsValue">{log.distinctCodes}</span>
          </div>
          <div className="sn-diagnosticsStat">
            <span className="sn-hint">{props.t('diagnosticsStatModels')}</span>
            <span className="sn-diagnosticsValue">{log.distinctModels}</span>
          </div>
        </div>

        <div className="sn-diagnosticsList">
          <div className="sn-diagnosticsRow">
            <span>{props.t('diagnosticsColumnTime')}</span>
            <span>{props.t('diagnosticsColumnType')}</span>
            {/* v0.5 P0：新增「组」列（单位请求组索引，组粒度落地前恒为 —） */}
            <span>{props.t('diagnosticsColumnGroup')}</span>
            <span className="sn-truncate">{props.t('diagnosticsColumnModel')}</span>
            {/* v0.5 P0：新增「耗时」列（单次上游往返毫秒）。 */}
            <span>{props.t('diagnosticsColumnLatency')}</span>
            {/* 🔴 2026-09-27 新增两列：可读账户名 + credential-ref 名 */}
            <span className="sn-truncate">{props.t('diagnosticsColumnAccount')}</span>
            <span className="sn-truncate">{props.t('diagnosticsColumnApi')}</span>
          </div>
          {visible.map((entry) => {
            const rawIndex = log.entries.indexOf(entry);
            return (
              <div key={`${entry.ts}-${rawIndex}`}>
                <button
                  type="button"
                  className="sn-diagnosticsRow sn-diagnosticsRowButton"
                  data-result={entry.result ?? ''}
                  aria-expanded={log.expandedRow === rawIndex}
                  onClick={() => props.onToggleRow(rawIndex)}
                >
                  <span className="sn-mono">{formatClock(entry.ts)}</span>
                  {/*
                    视觉行特判（2026-11-02）：视觉请求的 code 通常为空（成功）
                    ⇒ 旧渲染显示「—」，与主对话的成功行无法区分。这里把模式直接
                    印在 code 列（vision:bridge / vision:tool / vision:chat），
                    列表上就能看出这一行是视觉调用、且是哪种模式。
                  */}
                  <span className="sn-diagnosticsCode" data-kind={entry.kind} data-vision={entry.visionMode ?? ''}>
                    {entry.code !== ''
                      ? entry.code
                      : entry.visionMode !== undefined
                        ? `vision:${entry.visionMode}`
                        : '—'}
                  </span>
                  <span className="sn-mono" title={entry.groupIndex !== undefined ? `group ${entry.groupIndex}` : undefined}>
                    {entry.groupIndex !== undefined ? entry.groupIndex : '—'}
                  </span>
                  <span className="sn-mono sn-truncate" title={entry.model}>
                    {entry.model !== '' ? entry.model : '—'}
                  </span>
                  <span className="sn-mono" title={entry.latencyMs !== undefined ? `${entry.latencyMs}ms` : undefined}>
                    {entry.latencyMs !== undefined ? `${entry.latencyMs}ms` : '—'}
                  </span>
                  {/*
                    🔴 2026-09-27 新增两列。旧日志（本字段加入之前写下的行）没有它们
                    ⇒ 显示 '—'，属无害降级。
                    `accountLabel` 缺失时回落到指纹 `account`，这样至少还能区分是哪把 key。
                  */}
                  <span
                    className="sn-truncate"
                    title={entry.accountLabel !== undefined && entry.accountLabel !== ''
                      ? entry.accountLabel
                      : entry.account}
                  >
                    {entry.accountLabel !== undefined && entry.accountLabel !== ''
                      ? entry.accountLabel
                      : '—'}
                  </span>
                  <span className="sn-mono sn-truncate" title={entry.accountRef}>
                    {entry.accountRef !== undefined && entry.accountRef !== '' ? entry.accountRef : '—'}
                  </span>
                </button>
                {log.expandedRow === rawIndex ? (
                  <div className="sn-diagnosticsDetail">
                    <div className="sn-diagnosticsTags">
                      <span>{props.t('diagnosticsAttempt', { n: entry.attempt })}</span>
                      {entry.phase !== undefined && entry.phase !== '' ? (
                        <span>{props.t('diagnosticsPhase', { phase: entry.phase })}</span>
                      ) : null}
                      {entry.result !== undefined && entry.result !== '' ? (
                        <span>{props.t('diagnosticsResult', { result: entry.result })}</span>
                      ) : null}
                      {entry.visionMode !== undefined ? (
                        <span className="sn-diagnosticsVision">
                          {props.t('diagnosticsVisionMode', {
                            mode: entry.visionMode,
                            task: entry.visionTask ?? '',
                          })}
                        </span>
                      ) : null}
                      <span>
                        {entry.rotated
                          ? props.t('diagnosticsRotatedYes')
                          : props.t('diagnosticsRotatedNo')}
                      </span>
                      {entry.retryFloorMs !== undefined ? (
                      <span>{props.t('diagnosticsFloor', { ms: entry.retryFloorMs })}</span>
                    ) : null}
                    {entry.groupGapMs !== undefined ? (
                      <span>{props.t('diagnosticsGroupGap', { ms: entry.groupGapMs })}</span>
                    ) : null}
                    {/*
                      🔴 2026-11-01：调度诊断标签。与「调度」面板的两个旋钮对照读：
                      schedWaitMs 恒为 0 = 根本没走到等待分支；schedStep 长期停在 1 =
                      每次首把就成功（或没走到组内轮换）。
                    */}
                    {entry.schedMode !== undefined && entry.schedMode !== '' ? (
                      <span>{props.t('diagnosticsSchedMode', { mode: entry.schedMode })}</span>
                    ) : null}
                    {entry.schedStep !== undefined && entry.schedStep > 0 ? (
                      <span>{props.t('diagnosticsSchedStep', { n: entry.schedStep })}</span>
                    ) : null}
                    {entry.schedRound !== undefined && entry.schedRound > 1 ? (
                      <span className="sn-diagnosticsWarn">{props.t('diagnosticsSchedRound', { n: entry.schedRound })}</span>
                    ) : null}
                    {entry.schedWaitMs !== undefined && entry.schedWaitMs > 0 ? (
                      <span>{props.t('diagnosticsSchedWait', { ms: entry.schedWaitMs })}</span>
                    ) : null}
                    {entry.providerRetryAfterMs !== undefined ? (
                      <span>{props.t('diagnosticsPra', { ms: entry.providerRetryAfterMs })}</span>
                    ) : null}
                    {entry.probeHits !== undefined ? (
                      <span>{props.t('diagnosticsProbeHits', { n: entry.probeHits })}</span>
                    ) : null}
                    {entry.kicked === true ? (
                      <span className="sn-diagnosticsWarn">{props.t('diagnosticsKicked')}</span>
                    ) : null}
                    {entry.poolRunning !== undefined || entry.poolBlocked !== undefined ? (
                      <span>
                        {props.t('diagnosticsPool', {
                          running: entry.poolRunning ?? 0,
                          blocked: entry.poolBlocked ?? 0,
                        })}
                      </span>
                    ) : null}
                    {entry.accountLabel !== undefined && entry.accountLabel !== '' ? (
                      <span>
                        {props.t('diagnosticsAccountLabel')} {entry.accountLabel}
                      </span>
                    ) : null}
                    {entry.accountRef !== undefined && entry.accountRef !== '' ? (
                      <span>
                        {props.t('diagnosticsAccountRef')} {entry.accountRef}
                      </span>
                    ) : null}
                    {entry.account !== '' ? (
                      <span>
                        {props.t('diagnosticsAccount')} {entry.account}
                      </span>
                    ) : null}
                  </div>
                  {entry.message !== '' ? (
                    <p className="sn-hint sn-mono sn-diagnosticsMessage">{entry.message}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
          })}
        </div>

        <p className="sn-hint sn-truncate" title={log.path}>
          {props.t('diagnosticsPath', { path: log.path })}
          {log.truncated ? ` ${props.t('diagnosticsTruncated')}` : ''}
        </p>
      </div>
    );
  }

  return (
    <div className="sn-card sn-diagnostics">
      <div className="sn-fieldHead">
        <span className="sn-label">{props.t('diagnosticsTitle')}</span>
        {/* v0.5 P0：展示模式切换（限流/全部）。纯 UI 偏好，不刷新、不落盘。 */}
        <div className="sn-segmented" role="group" aria-label={props.t('diagnosticsModeLabel')}>
          <button
            type="button"
            className={log.mode === 'limits' ? 'sn-segmentedActive' : ''}
            disabled={busy}
            onClick={() => props.onSetMode('limits')}
          >
            {props.t('diagnosticsModeLimits')}
          </button>
          <button
            type="button"
            className={log.mode === 'vision' ? 'sn-segmentedActive' : ''}
            disabled={busy}
            onClick={() => props.onSetMode('vision')}
          >
            {props.t('diagnosticsModeVision')}
          </button>
          <button
            type="button"
            className={log.mode === 'all' ? 'sn-segmentedActive' : ''}
            disabled={busy}
            onClick={() => props.onSetMode('all')}
          >
            {props.t('diagnosticsModeAll')}
          </button>
        </div>
        <button
          type="button"
          className="sn-linkButton"
          disabled={busy}
          onClick={() => props.onRefresh()}
        >
          {busy ? props.t('diagnosticsLoading') : props.t('diagnosticsRefresh')}
        </button>
      </div>
      <p className="sn-hint">{props.t('diagnosticsIntro')}</p>
      {body}
    </div>
  );
}

/** 三态可改性的展示标记（✅可改 / ⚙️插件级默认 / ❌不可改）。 */
function mutabilityBadge(kind: ModelParamView['mutability'], t: TranslateFn): JSX.Element {
  const map = {
    host: { cls: 'sn-miBadge sn-miBadgeHost', key: 'miMutHost' },
    l2: { cls: 'sn-miBadge sn-miBadgeL2', key: 'miMutL2' },
    none: { cls: 'sn-miBadge sn-miBadgeNone', key: 'miMutNone' },
  } as const;
  const entry = map[kind];
  return <span className={entry.cls}>{t(entry.key)}</span>;
}

/** 数字加千分位（表格里展示 token 数用）。 */
function fmtInt(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US');
}

/**
 * 账户池区块（只读）。
 *
 * 🔴 2026-09-24 新增：直接回答「插件里到底接线了几个 sensenova 账户」，
 * 并把"账户数对不上"拆成**三路独立数据**逐级比对，定位断在哪一环：
 *
 * ```
 * ① 插件 fiber config      pool.slots          ← 插件实际生效
 * ② 设置传输层             probe.accountsInSettings + 1   ← settings.describe()
 * ③ 界面实际渲染           renderedExtra + 1
 * ```
 *
 * 三者应逐级相等。哪一级先断，就地给出病因（而不是笼统说"可能不是最新配置"）。
 */
function AccountPoolBlock(props: {
  t: TranslateFn;
  accounts: ModelInfoSnapshotView['accounts'];
  probe: ModelInfoSnapshotView['settingsProbe'];
  /** 上面「账户」区块实际渲染的附加账户条数。 */
  renderedExtra: number;
  /** 设置表单快照是否已就绪（未就绪时不能把界面数当异常）。 */
  settingsReady: boolean;
}): JSX.Element {
  const pool = props.accounts;
  if (pool === undefined) return <p className="sn-hint">{props.t('miAccountsUnknown')}</p>;

  const pluginSlots = pool.slots;
  const settingsSlots = props.probe !== undefined && props.probe.accountsInSettings >= 0
    ? props.probe.accountsInSettings + 1
    : undefined;
  const renderedSlots = props.renderedExtra + 1;

  // 逐级定位：先看传输层，再看界面层。
  let diagnosis: string | undefined;
  if (settingsSlots !== undefined && settingsSlots !== pluginSlots) {
    diagnosis = props.t('miAccountsGapTransport', { plugin: pluginSlots, transport: settingsSlots });
  } else if (settingsSlots !== undefined && renderedSlots !== pluginSlots) {
    diagnosis = props.settingsReady
      ? props.t('miAccountsGapClientDecode', { plugin: pluginSlots, ui: renderedSlots })
      : props.t('miAccountsGapClientLoading');
  } else if (settingsSlots === undefined && props.settingsReady && renderedSlots !== pluginSlots) {
    diagnosis = props.t('miAccountsGapTransportMissing', { plugin: pluginSlots, ui: renderedSlots });
  }

  return (
    <div className="sn-diagnosticsTags">
      <span>{props.t('miAccountsSlots', { n: pluginSlots })}</span>
      <span className="sn-mono sn-truncate" title={pool.refs.join(', ')}>
        {pool.refs.join(' · ') || '—'}
      </span>
      <span>{pool.quotaRotation ? props.t('miAccountsRotationOn') : props.t('miAccountsRotationOff')}</span>
      <span>{pool.activeAccount === '' ? props.t('miAccountsAuto') : props.t('miAccountsPinned', { id: pool.activeAccount })}</span>
      <span className="sn-mono">
        {props.t('miAccountsChain', {
          transport: settingsSlots === undefined ? '—' : settingsSlots,
          ui: props.settingsReady ? renderedSlots : '…',
        })}
      </span>
      {diagnosis !== undefined ? <span className="sn-diagnosticsWarn">{diagnosis}</span> : null}
    </div>
  );
}

/**
 * 「当前模型 + 全部参数」面板（只读，2026-09-23 Phase 5）。
 *
 * 回答一个问题：**当前在用哪个模型、它到底支持什么、哪些参数我能改**。
 * 数据来自 host 的 `GET /api/sensenova/modelInfo`（含宿主 `resolveModelInfo`
 * 的实际解析结果 + Phase 0 实测的静态参数表）。
 *
 * 与错误记录区块同一约定：**不自动拉取**，用户点「刷新」才请求一次。
 */
function ModelInfoPanel(props: {
  t: TranslateFn;
  state: ModelInfoState;
  onRefresh: () => void;
  /** 「账户」区块当前渲染的附加账户条数。 */
  renderedExtra?: number;
  /** 设置表单快照是否已就绪（用于区分"未加载"与"decode 失败"）。 */
  settingsReady?: boolean;
}): JSX.Element {
  const info = props.state;
  const busy = info.status === 'loading';
  const snapshot = info.snapshot;

  let body: JSX.Element;
  if (info.status === 'idle') {
    body = <p className="sn-hint">{props.t('miIdle')}</p>;
  } else if (info.status === 'error' || snapshot === undefined) {
    body = <p className="sn-hint sn-diagnosticsWarn">{props.t('miUnavailable')}</p>;
  } else if (!snapshot.available) {
    // 模型信息拿不到 ≠ 账户信息也拿不到：host 在「取不到默认模型」时仍会回账户池
    // （accountPool 不依赖 LLM/默认模型服务）。
    body = (
      <div className="sn-diagnosticsBody">
        <AccountPoolBlock
          t={props.t}
          accounts={snapshot.accounts}
          probe={snapshot.settingsProbe}
          renderedExtra={props.renderedExtra ?? 0}
          settingsReady={props.settingsReady ?? false}
        />
        <p className="sn-hint sn-diagnosticsWarn">{props.t('miNoDefaultModel')}</p>
      </div>
    );
  } else {
    const selection = snapshot.selection;
    const resolved = snapshot.resolved;
    const facts = snapshot.facts;
    const vision = facts !== undefined
      ? facts.vision
      : (resolved?.inputModalities?.includes('image') ?? false);
    const currentEffort = selection?.reasoningEffort ?? resolved?.defaultEffort;

    body = (
      <div className="sn-diagnosticsBody">
        <AccountPoolBlock
          t={props.t}
          accounts={snapshot.accounts}
          probe={snapshot.settingsProbe}
          renderedExtra={props.renderedExtra ?? 0}
          settingsReady={props.settingsReady ?? false}
        />

        <div className="sn-diagnosticsStats">
          <div className="sn-diagnosticsStat">
            <span className="sn-hint">{props.t('miStatModel')}</span>
            <span className="sn-diagnosticsValue sn-truncate" title={selection?.model}>
              {selection?.model ?? '—'}
            </span>
          </div>
          <div className="sn-diagnosticsStat">
            <span className="sn-hint">{props.t('miStatVision')}</span>
            <span className="sn-diagnosticsValue">{vision ? props.t('miVisionYes') : props.t('miVisionNo')}</span>
          </div>
          <div className="sn-diagnosticsStat">
            <span className="sn-hint">{props.t('miStatEffort')}</span>
            <span className="sn-diagnosticsValue sn-truncate">
              {currentEffort ?? props.t('miEffortServerDefault')}
            </span>
          </div>
        </div>

        <div className="sn-diagnosticsTags">
          <span>{props.t('miResolvedContext', { n: fmtInt(resolved?.contextWindow ?? facts?.contextWindow) })}</span>
          <span>{props.t('miResolvedMaxTokens', { n: fmtInt(resolved?.defaultMaxTokens ?? facts?.maxOutputTokens) })}</span>
          <span>
            {props.t('miResolvedModalities')}
            {' '}
            {(resolved?.inputModalities ?? []).join(' + ') || '—'}
          </span>
        </div>

        {facts !== undefined && !facts.vision && facts.textOnlyBehavior === 'hallucinates' ? (
          <p className="sn-hint sn-diagnosticsWarn">{props.t('miWarnHallucinates')}</p>
        ) : null}
        {facts !== undefined && !facts.vision && facts.textOnlyBehavior === 'refuses' ? (
          <p className="sn-hint">{props.t('miWarnRefuses')}</p>
        ) : null}
        {facts !== undefined && facts.visionNote !== undefined ? (
          <p className="sn-hint">{props.t('miVisionNote', { note: facts.visionNote })}</p>
        ) : null}
        {snapshot.l2Allowed.length > 0 ? (
          <p className="sn-hint">{props.t('miL2Allowed', { list: snapshot.l2Allowed.join(', ') })}</p>
        ) : null}

        <div className="sn-diagnosticsList sn-miList">
          <div className="sn-diagnosticsRow sn-miRow">
            <span className="sn-truncate">{props.t('miColumnParam')}</span>
            <span>{props.t('miColumnMutability')}</span>
            <span>{props.t('miColumnDefault')}</span>
          </div>
          {snapshot.params.map((row) => (
            <div key={row.key}>
              <button
                type="button"
                className="sn-diagnosticsRowButton sn-miRow"
                aria-expanded={false}
                title={row.note !== undefined ? `${row.key}: ${row.note}` : row.key}
              >
                <span className="sn-mono sn-truncate" title={row.key}>{row.label}</span>
                {mutabilityBadge(row.mutability, props.t)}
                <span className="sn-mono sn-truncate" title={`${row.key} · ${row.range}`}>
                  {row.serverDefault}
                </span>
              </button>
              {row.note !== undefined ? (
                <div className="sn-diagnosticsDetail">
                  <p className="sn-hint sn-mono sn-diagnosticsMessage">{row.note}</p>
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {facts !== undefined && facts.notes.length > 0 ? (
          <div className="sn-diagnosticsTags">
            {facts.notes.map((note) => (
              <span key={note}>{note}</span>
            ))}
          </div>
        ) : null}

        <p className="sn-hint">{props.t('miProbedAt', { at: snapshot.probedAt })}</p>
      </div>
    );
  }

  return (
    <div className="sn-card sn-diagnostics">
      <div className="sn-fieldHead">
        <span className="sn-label">{props.t('miTitle')}</span>
        <button
          type="button"
          className="sn-linkButton"
          disabled={busy}
          onClick={() => props.onRefresh()}
        >
          {busy ? props.t('miLoading') : props.t('miRefresh')}
        </button>
      </div>
      <p className="sn-hint">{props.t('miIntro')}</p>
      {body}
    </div>
  );
}

/**
 * 视觉辅助区块（融合自 dsh-sensenova-vision-aid）。
 *
 * 放在「高级选项」之后、「诊断」之前 —— 它是一组配置项，参与 dirty / 保存。
 * 卡片底部那句提示是这次融合的核心：视觉请求与主对话**共用**同一套 key 池、
 * 并发闸与组退避，所以不再出现两套轮换抢同一批 key 的情况。
 */
/**
 * 调度策略面板（2026-11-01）。
 *
 * 为什么单独成块而不是塞进「高级选项」：这两个数字是**边测边调**的主旋钮，
 * 需要一眼看到、改完立刻保存，不该藏在二级折叠里。同时下方给出实时推算，
 * 让「把 groupGapMs 从 20 秒调到 10 秒」的后果（每账户间隔从 60 秒降到 30 秒）
 * 在改之前就可见，而不是等撞了 429 才知道。
 */
function SchedulingPanel(props: {
  t: TranslateFn;
  draft: SchedulingDraft;
  disabled: boolean;
  accountCount: number;
  onMode: (mode: string) => void;
  onGrouping: (grouping: string) => void;
  onEditField: (field: SchedulingNumberField, text: string) => void;
  onSmartGroupGap?: (() => void) | undefined;
}): JSX.Element {
  const { t, draft, disabled } = props;
  const fixed = draft.mode === 'fixed';
  // 推算用值：非法输入按 0 处理，避免 NaN 冒到界面上。
  const keyGap = Number(draft.keyGapMs);
  const groupGap = Number(draft.groupGapMs);
  const keyGapSafe = Number.isFinite(keyGap) && keyGap >= 0 ? keyGap : 0;
  const groupGapSafe = Number.isFinite(groupGap) && groupGap >= 0 ? groupGap : 0;
  // 关键换算（与 adapter 的实际节奏一致）：
  //   一轮 = 一组 4 把，3 次 keyGap + 4 次往返（快拒按 0.2s 估）
  //   每组占用 = max(本轮耗时, groupGapMs)
  //   同账户两次使用间隔 ≥ groupGapMs × (组数 − 1)
  const roundMs = 3 * keyGapSafe + 800;
  const holdMs = Math.max(roundMs, groupGapSafe);
  const perAccountMs = groupGapSafe * Math.max(0, props.accountCount - 1);
  const fmt = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} 分钟` : `${(ms / 1000).toFixed(1)} 秒`);

  return (
    <div className="sn-card sn-scheduling">
      <div className="sn-field">
        <label className="sn-label" htmlFor="sn-sched-mode">
          {t('schedMode')}
        </label>
        <select
          id="sn-sched-mode"
          className="sn-input"
          value={fixed ? 'fixed' : 'adaptive'}
          disabled={disabled}
          onChange={(event: ChangeEventLike) => props.onMode(event.target.value)}
        >
          <option value="fixed">{t('schedModeFixed')}</option>
          <option value="adaptive">{t('schedModeAdaptive')}</option>
        </select>
        <p className="sn-hint">{t('schedModeHint')}</p>
      </div>

      <div className="sn-field">
        <label className="sn-label" htmlFor="sn-sched-grouping">
          {t('schedGrouping')}
        </label>
        <select
          id="sn-sched-grouping"
          className="sn-input"
          value={draft.grouping === 'by-slot' ? 'by-slot' : 'by-account'}
          disabled={disabled || !fixed}
          onChange={(event: ChangeEventLike) => props.onGrouping(event.target.value)}
        >
          <option value="by-account">{t('schedGroupingByAccount')}</option>
          <option value="by-slot">{t('schedGroupingBySlot')}</option>
        </select>
        <p className="sn-hint">{t('schedGroupingHint')}</p>
      </div>

      <div className="sn-models">
        <div className="sn-field">
          <label className="sn-label" htmlFor="sn-sched-key-gap">
            {t('schedKeyGap')}
          </label>
          <input
            id="sn-sched-key-gap"
            className="sn-input"
            type="number"
            min={0}
            max={60000}
            step={100}
            value={draft.keyGapMs}
            disabled={disabled || !fixed}
            spellCheck={false}
            onChange={(event: ChangeEventLike) => props.onEditField('keyGapMs', event.target.value)}
          />
          <p className="sn-hint">{t('schedKeyGapHint')}</p>
        </div>
        <div className="sn-field">
          <label className="sn-label" htmlFor="sn-sched-group-gap">
            {t('schedGroupGap')}
          </label>
          <input
            id="sn-sched-group-gap"
            className="sn-input"
            type="number"
            min={1000}
            max={600000}
            step={1000}
            value={draft.groupGapMs}
            disabled={disabled || !fixed}
            spellCheck={false}
            onChange={(event: ChangeEventLike) => props.onEditField('groupGapMs', event.target.value)}
          />
          <p className="sn-hint">{t('schedGroupGapHint')}</p>
        </div>
      </div>

      {fixed ? (
        <>
          <div className="sn-field">
            <label className="sn-label" htmlFor="sn-sched-round-budget">
              {t('schedRoundBudget')}
            </label>
            <input
              id="sn-sched-round-budget"
              className="sn-input"
              type="number"
              min={1}
              max={10}
              step={1}
              value={draft.roundBudget}
              disabled={disabled}
              spellCheck={false}
              onChange={(event: ChangeEventLike) => props.onEditField('roundBudget', event.target.value)}
            />
            <p className="sn-hint">{t('schedRoundBudgetHint')}</p>
          </div>
          <div className="sn-field">
            <p className="sn-hint sn-schedEstimate">
              {t('schedEstimate', {
                accounts: props.accountCount,
                round: fmt(roundMs),
                hold: fmt(holdMs),
                perAccount: fmt(perAccountMs),
              })}
            </p>
            <p className="sn-hint">{t('schedLogHint')}</p>
          </div>
          <button
            type="button"
            className="sn-btnGhost sn-kpSmartGap"
            disabled={disabled || props.onSmartGroupGap === undefined}
            title={t('schedSmartGapHint')}
            onClick={() => props.onSmartGroupGap?.()}
          >
            {t('schedSmartGap')}
          </button>
          <p className="sn-hint sn-schedGapNote">
            {t('schedSmartGapNote', {
              accounts: props.accountCount,
              recommended: fmt(smartGroupGapMs(props.accountCount)),
              minGap: props.accountCount > 1 ? fmt(minGroupGapMs(props.accountCount)) : '—',
            })}
          </p>
        </>
      ) : null}
    </div>
  );
}

function VisionAidPanel(props: {
  t: TranslateFn;
  draft: VisionDraft;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onBridgeMode: (mode: VisionBridgeMode) => void;
  onEditField: (field: 'modelChain' | 'timeoutMs' | 'bridgePrompt', text: string) => void;
}): JSX.Element {
  const { t, draft, disabled } = props;
  // 关闭总开关时，从属字段一起置灰：不仅逻辑停用，界面也要看得出「整块停了」。
  const off = disabled || !draft.enabled;
  return (
    <div className="sn-card sn-vision" data-enabled={draft.enabled ? '1' : '0'}>
      <div className="sn-field">
        <label className="sn-fieldHead" htmlFor="sn-vision-enabled">
          <span className="sn-label">{t('visionEnabled')}</span>
          <input
            id="sn-vision-enabled"
            className="sn-toggle"
            type="checkbox"
            checked={draft.enabled}
            disabled={disabled}
            onChange={(event: ToggleEventLike) => props.onToggle(event.target.checked)}
          />
        </label>
        <p className="sn-hint">{draft.enabled ? t('visionEnabledHint') : t('visionDisabledHint')}</p>
      </div>

      <div className="sn-field">
        <label className="sn-label" htmlFor="sn-vision-chain">{t('visionModelChain')}</label>
        <input
          id="sn-vision-chain"
          className="sn-input"
          type="text"
          value={draft.modelChain}
          disabled={off}
          onChange={(event: ChangeEventLike) => props.onEditField('modelChain', event.target.value)}
        />
        <p className="sn-hint">{t('visionModelChainHint')}</p>
      </div>

      <div className="sn-field">
        <label className="sn-label" htmlFor="sn-vision-timeout">{t('visionTimeout')}</label>
        <input
          id="sn-vision-timeout"
          className="sn-input"
          type="text"
          inputMode="numeric"
          value={draft.timeoutMs}
          disabled={off}
          onChange={(event: ChangeEventLike) => props.onEditField('timeoutMs', event.target.value)}
        />
        <p className="sn-hint">{t('visionTimeoutHint')}</p>
      </div>

      <div className="sn-field">
        <label className="sn-label" htmlFor="sn-vision-bridge">{t('visionBridgeMode')}</label>
        <select
          id="sn-vision-bridge"
          className="sn-input"
          value={draft.bridgeMode}
          disabled={off}
          onChange={(event: ChangeEventLike) => props.onBridgeMode(event.target.value as VisionBridgeMode)}
        >
          <option value="on">{t('visionBridgeOn')}</option>
          <option value="auto">{t('visionBridgeAuto')}</option>
          <option value="off">{t('visionBridgeOff')}</option>
        </select>
        <p className="sn-hint">{t('visionBridgeModeHint')}</p>
      </div>

      <div className="sn-field">
        <label className="sn-label" htmlFor="sn-vision-prompt">{t('visionPrompt')}</label>
        <textarea
          id="sn-vision-prompt"
          className="sn-input"
          rows={4}
          value={draft.bridgePrompt}
          disabled={off}
          onChange={(event: ChangeEventLike) => props.onEditField('bridgePrompt', event.target.value)}
        />
        <p className="sn-hint">{t('visionPromptHint')}</p>
      </div>

      <p className="sn-hint sn-visionNote">{t('visionSharedPoolNote')}</p>
    </div>
  );
}

export function SenseNovaSection(props: SenseNovaSectionProps): JSX.Element {
  const { t } = props;
  const state = props.useSensenovaSettings((s) => s);
  const disabled = !state.writable;
  const savedVisible = useSavedFlash(state.savedCount);


  // 「清空全部账户」二次确认（3 秒后自动复原，避免误点）。
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return undefined;
    const timer = setTimeout(() => setConfirmClear(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClear]);
  const onClearAll = (): void => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    props.clearAllAccounts();
  };

  const accounts = state.accounts;
  // 分组编辑器的数据源：默认密钥属于账户 1（slot −1 排最前），其余按 `N-M` 归并。
  // 默认密钥槽位**始终存在**（它是账户 1 行的固定首槽）：
  //   - 已配置/正在编辑 → data-configured=1（实心）；
  //   - 清除已存密钥（clearStaged）或尚未配置 → 与其他空位一样显示未配置虚线。
  // 旧条件 `defaultConfigured || draft !== ''` 会在「清除后保存」时让 default 槽从
  // 行内消失，账户 1 行 key 数与组计划（4×5=20）错位，拖框/演示全部乱套。
  const poolKeys: PoolKeyRef[] = [
    {
      id: 'default',
      account: 1,
      slot: -1,
      label: 'Default',
      plainLabel: 'Default',
      labelDraft: 'Default',
      keyDraft: state.defaultKeyDraft,
      configured: state.defaultConfigured,
      writable: state.defaultWritable,
      clearStaged: state.defaultClearStaged,
      isDefault: true,
    },
    ...accounts.flatMap((account) => {
      const number = accountNumberOf(account.label);
      const slot = slotOf(account.label);
      if (number === undefined || slot === undefined) return [];
      return [{
        id: account.id,
        account: number,
        slot,
        label: account.label,
        plainLabel: account.label,
        labelDraft: account.labelDraft,
        keyDraft: account.keyDraft,
        configured: account.configured,
        writable: account.writable,
        clearStaged: account.clearStaged,
        isDefault: false,
      }];
    }),
  ];
  const savedAccounts = accounts.filter((account) => !account.added);
  // 实际接入账户数 = 按账户号去重（default 即账户 1）。不是 key 把数：
  // 每组 4 把只是为了每账户多份凭据，不影响「有多少个账户在轮换」。
  const accountCount = distinctAccountCount([state.defaultConfigured ? 'Default' : '', ...accounts.map((a) => a.label)]);
  // 导入或智能分组后给编辑器换 key，强制重建内部选区/菜单状态，修「批量导入后
  // 方块界面错乱、切会话再回来才好的问题」——与右上角刷新联动。
  const editorKey = state.savedCount;

  return (
    <section className="sn-section" aria-label={t('title')}>
      <div className="sn-titleRow">
        <h2 className="sn-title">{t('title')}</h2>
        <div className="sn-titleActions">
          <button type="button" className="sn-btnGhost" disabled={!state.dirty || state.saving} onClick={props.discard}>
            {t('reset')}
          </button>
          <button type="button" className="sn-btnPrimary" disabled={!state.dirty || state.saving} onClick={props.save}>
            {state.saving ? t('saving') : t('save')}
          </button>
        </div>
        <button
          type="button"
          className="sn-btnGhost"
          disabled={state.saving}
          title={t('refreshTitle')}
          onClick={props.refreshCredentials}
        >
          {t('refresh')}
        </button>
      </div>
      {!state.writable ? (
        <p className="sn-readOnly" role="status">
          {t('readOnly')}
        </p>
      ) : null}

      {/* 凭据与账户 */}
      <SectionHeading text={t('groupCredentials')} />

      <div className="sn-card">
        <div className="sn-field">
          <div className="sn-fieldHead">
            <span className="sn-label">{t('accountsTitle')}</span>
            <span className="sn-fieldActions">
              <button type="button" className="sn-btnAdd" disabled={disabled} onClick={props.addAccount}>
                {t('accountAdd')}
              </button>
              <button
                type="button"
                className={confirmClear ? 'sn-btnDanger' : 'sn-btnAdd'}
                disabled={disabled || (savedAccounts.length === 0 && accounts.every((a) => !a.added))}
                onClick={onClearAll}
              >
                {confirmClear ? t('accountsClearConfirm') : t('accountsClear')}
              </button>
            </span>
          </div>
          {/* 轮换说明与「配额类 429 换 key」开关状态保持一致（默认仍表述 429 不切换）。 */}
          <p className="sn-hint">{state.quotaRotationDraft ? t('accountsHintQuotaRotation') : t('accountsHint')}</p>
        </div>

        {/* 账户与分组（2026-11-02）：key 方块 + 组框，直接编辑 scheduling.groups。
            默认密钥属于账户 1，所以 `Default` 与 `1-*` 合并成同一行。 */}
        {state.schedulingDraft.mode === 'fixed' ? (
          <KeyPoolEditor
            key={editorKey}
            t={t}
            disabled={disabled}
            keys={poolKeys}
            plan={state.schedulingDraft.groups ?? []}
            grouping={state.schedulingDraft.grouping}
            onHardRefresh={props.refreshCredentials}
            roundBudget={Number(state.schedulingDraft.roundBudget)}
            onChange={props.setSchedGroups}
            onEditLabel={(id, text) => {
              if (id !== 'default') props.editAccountLabel(id, text);
            }}
            onEditKey={(id, text) => {
              if (id === 'default') props.editDefaultKey(text);
              else props.editAccountKey(id, text);
            }}
            onClearKey={(id) => {
              if (id === 'default') props.toggleDefaultKeyClear();
              else props.toggleAccountKeyClear(id);
            }}
            onRemoveKey={(id) => {
              if (id !== 'default') props.removeAccount(id);
            }}
            onAddAccount={disabled ? undefined : props.addAccount}
            onAddKey={disabled ? undefined : props.addAccountKey}
            onSmartGroup={disabled ? undefined : props.smartGroupAll}
          />
        ) : null}

      </div>

      {/* 导入 / 导出 Key（v0.2.1）：只读区块，不参与 dirty / 保存流程 */}
      <KeysIoPanel
        t={t}
        state={state.keysIo}
        disabled={disabled}
        onEditText={props.editKeysIoText}
        onExport={props.exportKeys}
        onImport={props.importKeys}
        onClearText={() => props.editKeysIoText('')}
      />

      {/* 分组 3：高级选项 */}
      <SectionHeading text={t('groupAdvanced')} />
      <AdvancedSettings
        t={t}
        state={state}
        disabled={disabled}
        edit={props.edit}
        setQuotaRotation={props.setQuotaRotation}
        setErrorLog={props.setErrorLog}
        setRetryMode={props.setRetryMode}
        editRetry={props.editRetry}
        editPool={props.editPool}
      />

      {/* 分组 3a：调度（2026-11-01）—— 固定间隔模式的两个主旋钮，边测边调 */}
      <SectionHeading text={t('groupScheduling')} />
      <SchedulingPanel
        t={t}
        draft={state.schedulingDraft}
        disabled={disabled}
        accountCount={Math.max(accountCount, 1)}
        onMode={props.setSchedMode}
        onGrouping={props.setSchedGrouping}
        onEditField={props.editSched}
        onSmartGroupGap={disabled ? undefined : props.smartGroupGap}
      />

      {/* 分组 3b：视觉辅助（融合自 dsh-sensenova-vision-aid）—— 配置项，参与保存 */}
      <SectionHeading text={t('groupVision')} />
      <VisionAidPanel
        t={t}
        draft={state.visionDraft}
        disabled={disabled}
        onToggle={props.setVisionEnabled}
        onBridgeMode={props.setVisionBridgeMode}
        onEditField={props.editVisionField}
      />

      {/* 分组 4：诊断 —— 只读的运行数据，与上面的配置项无关（不参与保存/重置） */}
      <SectionHeading text={t('groupDiagnostics')} />
      <ErrorLogPanel
        t={t}
        state={state.diagnostics}
        onRefresh={props.refreshErrorLog}
        onToggleRow={props.toggleErrorLogRow}
        onSetMode={props.setErrorLogMode}
      />

      {/* 分组 4b：当前模型 + 全部参数 —— 只读（2026-09-23 Phase 5）。回答"我现在用的
          是哪个模型、它到底支持什么、哪些参数我能改"。同样不参与保存/重置。 */}
      <SectionHeading text={t('miGroup')} />
      <ModelInfoPanel
        t={t}
        state={state.modelInfo}
        onRefresh={props.refreshModelInfo}
        renderedExtra={savedAccounts.length}
        settingsReady={state.available}
      />

      {/* 保存 / 重置（按钮已上移到标题行，这里只保留状态提示）*/}
      <div className="sn-footer">
        <div className="sn-footerStatus">
          {state.failed ? (
            <p className="sn-failed" role="status">
              {t('saveFailed')}
            </p>
          ) : savedVisible && !state.dirty ? (
            <p className="sn-saved" role="status">
              {t('saved')}
            </p>
          ) : state.dirty ? (
            <span className="sn-unsaved">{t('unsaved')}</span>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function DefaultKeyField(props: {
  t: TranslateFn;
  draft: string;
  disabled: boolean;
  configured: boolean;
  clearStaged: boolean;
  onEdit: (text: string) => void;
  onToggleClear: () => void;
}): JSX.Element {
  const { t } = props;
  const [visible, setVisible] = useState(false);
  return (
    <div className="sn-field">
      <div className="sn-fieldHead">
        <label className="sn-label" htmlFor="sn-default-key">
          {t('defaultKey')}
        </label>
        <span className="sn-badges">
          <button type="button" className="sn-reset" disabled={props.disabled} onClick={() => setVisible((v) => !v)}>
            {visible ? t('hide') : t('show')}
          </button>
          {props.configured ? (
            <button type="button" className="sn-reset" disabled={props.disabled} onClick={props.onToggleClear}>
              {t('clearKey')}
            </button>
          ) : null}
        </span>
      </div>
      <input
        id="sn-default-key"
        className="sn-input"
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={props.draft}
        disabled={props.disabled}
        onChange={(event: ChangeEventLike) => props.onEdit(event.target.value)}
      />
      <p className="sn-hint">{t('defaultKeyHint')}</p>
    </div>
  );
}
