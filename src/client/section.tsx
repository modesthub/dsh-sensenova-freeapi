/**
 * SenseNova 设置页 React 组件（settings.section slot 内容）。
 * 所有文案经 `t`（settings.sensenova 命名空间）读取，不硬编码。
 */
import { useState } from 'react';
import * as React from 'react';
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
  ModelInfoSnapshotView,
  ModelInfoState,
  ModelParamView,
  PoolNumberField,
  RetryNumberField,
  SettingsState,
  TranslateFn,
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
  /** 「当前模型 + 全部参数」面板：拉取快照（只读，2026-09-23 Phase 5）。 */
  refreshModelInfo: () => void;
  /** 重试策略：模式单选（W1 2026-09-17）。 */
  setRetryMode: (mode: 'normal' | 'always') => void;
  /** 重试策略：数字字段编辑。 */
  editRetry: (field: RetryNumberField, text: string) => void;
  /** key 池策略：数字字段编辑（2026-09-27）。 */
  editPool: (field: PoolNumberField, text: string) => void;
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
function StatusBadge({ configured, t }: { configured: boolean; t: TranslateFn }): JSX.Element {
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

function credentialReferences(state: SettingsState): ReadonlySet<string> {
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

function accountDisplayLabel(
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

/**
 * 错误记录诊断区块（只读，2026-09-18）。
 *
 * 刻意**不自动拉取**：打开设置页本身不该产生 I/O，而多数人进来是为了改配置。
 * 用户点「刷新」才请求一次，之后可反复点。
 */
function ErrorLogPanel(props: {
  t: TranslateFn;
  state: ErrorLogState;
  onRefresh: () => void;
  onToggleRow: (index: number) => void;
}): JSX.Element {
  const log = props.state;
  const busy = log.status === 'loading';

  let body: JSX.Element;
  if (log.status === 'idle') {
    body = <p className="sn-hint">{props.t('diagnosticsIdle')}</p>;
  } else if (log.status === 'error') {
    body = <p className="sn-hint sn-diagnosticsWarn">{props.t('diagnosticsUnavailable')}</p>;
  } else if (!log.available || log.entries.length === 0) {
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
            <span className="sn-truncate">{props.t('diagnosticsColumnModel')}</span>
            {/* 🔴 2026-09-27 新增两列：可读账户名 + credential-ref 名 */}
            <span className="sn-truncate">{props.t('diagnosticsColumnAccount')}</span>
            <span className="sn-truncate">{props.t('diagnosticsColumnApi')}</span>
          </div>
          {log.entries.map((entry, index) => (
            <div key={`${entry.ts}-${index}`}>
              <button
                type="button"
                className="sn-diagnosticsRow sn-diagnosticsRowButton"
                aria-expanded={log.expandedRow === index}
                onClick={() => props.onToggleRow(index)}
              >
                <span className="sn-mono">{formatClock(entry.ts)}</span>
                <span className="sn-diagnosticsCode" data-kind={entry.kind}>
                  {entry.code !== '' ? entry.code : '—'}
                </span>
                <span className="sn-mono sn-truncate" title={entry.model}>
                  {entry.model !== '' ? entry.model : '—'}
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
              {log.expandedRow === index ? (
                <div className="sn-diagnosticsDetail">
                  <div className="sn-diagnosticsTags">
                    <span>{props.t('diagnosticsAttempt', { n: entry.attempt })}</span>
                    <span>
                      {entry.rotated
                        ? props.t('diagnosticsRotatedYes')
                        : props.t('diagnosticsRotatedNo')}
                    </span>
                    {entry.retryFloorMs !== undefined ? (
                      <span>{props.t('diagnosticsFloor', { ms: entry.retryFloorMs })}</span>
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
          ))}
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

export function SenseNovaSection(props: SenseNovaSectionProps): JSX.Element {
  const { t } = props;
  const state = props.useSensenovaSettings((s) => s);
  const disabled = !state.writable;
  const savedVisible = useSavedFlash(state.savedCount);

  const accounts = state.accounts;
  const credentialRefs = credentialReferences(state);
  const savedAccounts = accounts.filter((account) => !account.added);

  return (
    <section className="sn-section" aria-label={t('title')}>
      <h2 className="sn-title">{t('title')}</h2>
      <p className="sn-intro">{t('intro')}</p>
      {!state.writable ? (
        <p className="sn-readOnly" role="status">
          {t('readOnly')}
        </p>
      ) : null}

      {/* 分组 1：接入信息 */}
      <SectionHeading text={t('groupConnection')} />
      <div className="sn-card sn-cardCompact">
        <div className="sn-field">
          <div className="sn-fieldHead">
            <span className="sn-label">{t('routeLabel')}</span>
            <span className="sn-badges">
              <span className="sn-badge">{state.route}</span>
            </span>
          </div>
          <p className="sn-hint">{state.displayName}</p>
        </div>
      </div>

      {/* 分组 2：凭据与账户 */}
      <SectionHeading text={t('groupCredentials')} />
      <div className="sn-card">
        <div className="sn-field">
          <div className="sn-fieldHead">
            <span className="sn-label">{t('defaultAccount')}</span>
            <span className="sn-badges">
              {state.effectiveActiveAccountId === 'default' ? (
                <span className="sn-badge sn-badgeActive">{t('activeBadgeEffectiveFull')}</span>
              ) : null}
              <StatusBadge configured={state.defaultConfigured} t={t} />
            </span>
          </div>
        </div>
        <DefaultKeyField
          t={t}
          draft={state.defaultKeyDraft}
          disabled={disabled || !state.defaultWritable}
          configured={state.defaultConfigured}
          clearStaged={state.defaultClearStaged}
          onEdit={props.editDefaultKey}
          onToggleClear={props.toggleDefaultKeyClear}
        />
      </div>

      <div className="sn-card">
        <div className="sn-field">
          <div className="sn-fieldHead">
            <span className="sn-label">{t('accountsTitle')}</span>
            <button type="button" className="sn-btnAdd" disabled={disabled} onClick={props.addAccount}>
              {t('accountAdd')}
            </button>
          </div>
          {/* 轮换说明与「配额类 429 换 key」开关状态保持一致（默认仍表述 429 不切换）。 */}
          <p className="sn-hint">{state.quotaRotationDraft ? t('accountsHintQuotaRotation') : t('accountsHint')}</p>
        </div>

        {/* 账户总览条：一目了然显示总数、已配置数、当前生效账户 */}
        <div className="sn-accountSummary">
          <span className="sn-accountSummaryStats">
            {t('accountSummary', { total: state.totalCount, configured: state.configuredCount })}
          </span>
          {state.effectiveActiveAccountLabel !== '' ? (
            <span className="sn-accountSummaryActive">
              <span className="sn-dotPulse" aria-hidden="true" />
              {t('accountSummaryActive', { label: state.effectiveActiveAccountLabel })}
            </span>
          ) : (
            <span className="sn-accountSummaryNone">{t('accountSummaryNone')}</span>
          )}
        </div>

        {/* 活动账户下拉：自动 + 已保存账户，未保存新增行不参与选择。 */}
        <div className="sn-field">
          <label className="sn-label" htmlFor="sn-active-account">
            {t('activeAccount')}
          </label>
          <div className="sn-activeAccountControl">
            <div className="sn-activeAccountSelect">
               <select
              id="sn-active-account"
              className="sn-input"
              value={state.activeAccountDraft}
              disabled={disabled}
              onChange={(event: ChangeEventLike) => props.setActiveAccount(event.target.value)}
            >
              <option value="">
                {state.effectiveActiveAccountLabel !== ''
                  ? `${t('activeAccountAuto')} → ${state.effectiveActiveAccountLabel}`
                  : t('activeAccountAuto')}
              </option>
              {savedAccounts.map((account, index) => (
                <option key={account.id} value={account.id}>
                  {accountDisplayLabel(account, index, t, credentialRefs)}
                </option>
              ))}
            </select>
               <span className="sn-selectChevron" aria-hidden="true" />
             </div>
            <button
              type="button"
              className="sn-reset"
              disabled={disabled}
              onClick={() => props.setActiveAccount('')}
            >
              {t('activeAccountReset')}
            </button>
          </div>
        </div>

        {accounts.length > 0 ? (
          <div className="sn-accountList">
            {accounts.map((account, index) => (
              <AccountRow
                key={account.id}
                t={t}
                account={account}
                refs={credentialRefs}
                index={index}
                disabled={disabled}
                isActive={state.effectiveActiveAccountId === account.id}
                isPinned={state.activeAccountDraft === account.id}
                onRemove={() => props.removeAccount(account.id)}
                onLabel={(text) => props.editAccountLabel(account.id, text)}
                onKey={(text) => props.editAccountKey(account.id, text)}
                onToggleClear={() => props.toggleAccountKeyClear(account.id)}
              />
            ))}
          </div>
        ) : null}
      </div>

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

      {/* 分组 4：诊断 —— 只读的运行数据，与上面的配置项无关（不参与保存/重置） */}
      <SectionHeading text={t('groupDiagnostics')} />
      <ErrorLogPanel
        t={t}
        state={state.diagnostics}
        onRefresh={props.refreshErrorLog}
        onToggleRow={props.toggleErrorLogRow}
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

      {/* 保存 / 重置 */}
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
        <div className="sn-footerActions">
          <button type="button" className="sn-btnGhost" disabled={!state.dirty || state.saving} onClick={props.discard}>
            {t('reset')}
          </button>
          <button type="button" className="sn-btnPrimary" disabled={!state.dirty || state.saving} onClick={props.save}>
            {state.saving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    </section>
  );
}

function DefaultKeyField(props: {
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

function AccountRow(props: {
  t: TranslateFn;
  account: {
    id: string;
    ref: string;
    labelDraft: string;
    keyDraft: string;
    configured: boolean;
    writable: boolean;
    added: boolean;
    clearStaged: boolean;
  };
  index: number;
  refs: ReadonlySet<string>;
  disabled: boolean;
  isActive: boolean;
  isPinned: boolean;
  onRemove: () => void;
  onLabel: (text: string) => void;
  onKey: (text: string) => void;
  onToggleClear: () => void;
}): JSX.Element {
  const { t, account } = props;
  const [visible, setVisible] = useState(false);
  const displayLabel = accountDisplayLabel(account, props.index, t, props.refs);
  const labelDraft = isCredentialReference(account.labelDraft, props.refs) ? '' : account.labelDraft;
  const labelId = `sn-account-label-${account.id}`;
  const keyId = `sn-account-key-${account.id}`;

  return (
    <div className="sn-accountRow" data-sn-active={props.isActive ? 'true' : undefined}>
      <div className="sn-accountHead">
        <span className="sn-label" title={displayLabel}>{displayLabel}</span>
        <span className="sn-accountActions">
          <span className="sn-badges">
            <StatusBadge configured={account.configured} t={t} />
            {props.isActive ? (
              <span className="sn-badge sn-badgeActive">
                {props.isPinned ? t('activeBadge') : t('activeBadgeEffectiveFull')}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="sn-iconBtn"
            disabled={props.disabled || !account.writable}
            title={visible ? t('hide') : t('show')}
            aria-label={visible ? t('hide') : t('show')}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <IconEyeOff /> : <IconEye />}
          </button>
          {account.configured ? (
            <button
              type="button"
              className="sn-iconBtn"
              disabled={props.disabled || !account.writable}
              title={t('clearKey')}
              aria-label={t('clearKey')}
              onClick={props.onToggleClear}
            >
              <IconEraser />
            </button>
          ) : null}
          <button
            type="button"
            className="sn-iconBtn sn-iconBtnDanger"
            disabled={props.disabled}
            title={t('accountRemove')}
            aria-label={t('accountRemove')}
            onClick={props.onRemove}
          >
            <IconTrash />
          </button>
        </span>
      </div>
      <div className="sn-accountFields">
        <div className="sn-accountField">
          <label className="sn-labelSmall" htmlFor={labelId}>
            {t('accountLabel')}
          </label>
          <input
            id={labelId}
            className="sn-input"
            type="text"
            placeholder={t('accountLabel')}
            value={labelDraft}
            disabled={props.disabled}
            spellCheck={false}
            onChange={(event: ChangeEventLike) => props.onLabel(event.target.value)}
          />
        </div>
        <div className="sn-accountField">
          <label className="sn-labelSmall" htmlFor={keyId}>
            {t('accountKey')}
          </label>
          <input
            id={keyId}
            className="sn-input"
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            placeholder={t('accountKey')}
            spellCheck={false}
            value={account.keyDraft}
            disabled={props.disabled || !account.writable}
            onChange={(event: ChangeEventLike) => props.onKey(event.target.value)}
          />
          <p className="sn-hint">{t('accountKeyHint')}</p>
        </div>
      </div>
    </div>
  );
}

/** 行内 SVG 图标（currentColor，随主题变色）。 */
function IconEye(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M1.5 8s2.2-3.6 6.5-3.6S14.5 8 14.5 8 12.3 11.6 8 11.6 1.5 8 1.5 8Z" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function IconEyeOff(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M1.5 8s2.2-3.6 6.5-3.6c1.5 0 2.8.5 3.8 1.2M14.5 8s-.8 1.3-2.4 2.5M6.6 11.3c.5.1.9.2 1.4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M3 13 13 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconEraser(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M9.5 3.5 13.5 7.5 8 13H4.5L2.5 11c-.6-.6-.6-1.5 0-2.1l4.4-4.4c.6-.6 1.5-.6 2.1 0l.5.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 13h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconTrash(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M2.5 4h11M6.5 2.5h3M5 4l.5 8.5c0 .6.4 1 1 1h3c.6 0 1-.4 1-1L11 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
