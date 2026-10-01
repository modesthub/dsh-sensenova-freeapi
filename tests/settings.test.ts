import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_RETRY_DRAFT,
  QUEUE_TIMEOUT_MIN_MS,
  SenseNovaSettingsController,
  normalizeErrorLogState,
  type CredentialsFace,
  type SettingsScope,
  type SenseNovaConfig,
  type ScopeSnapshot,
} from '../src/client/settings.ts';

test('SenseNovaSettingsController: quotaRotation 缺省关、staged 保存热生效与 discard', async () => {
  let value: SenseNovaConfig = {};
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  };
  const credentials: CredentialsFace = {
    describe: async () => ({ ok: true, value: {} }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controller = new SenseNovaSettingsController(scope, credentials);
  assert.equal(controller.state().quotaRotation, false, '缺省关闭');
  assert.equal(controller.state().quotaRotationDraft, false);
  assert.equal(controller.state().dirty, false);

  // staged 开启：展示值立即变化，生效值在保存前不变。
  controller.setQuotaRotation(true);
  assert.equal(controller.state().dirty, true);
  assert.equal(controller.state().quotaRotationDraft, true, 'staged 立即反映到展示值');
  assert.equal(controller.state().quotaRotation, false, '保存前生效值不变');

  await controller.save();
  assert.equal(value.quotaRotation, true, '经 settings 命名空间持久化');
  assert.equal(controller.state().quotaRotation, true, '保存即热生效');
  assert.equal(controller.state().dirty, false);

  // 可再次关闭（保存 false，而非 unset——默认即 false）。
  controller.setQuotaRotation(false);
  await controller.save();
  assert.equal(value.quotaRotation, false, '再次关闭并持久化');

  // discard 丢弃 staged 编辑，不影响已保存值。
  controller.setQuotaRotation(true);
  controller.discard();
  assert.equal(controller.state().quotaRotationDraft, false, '丢弃 staged');
  assert.equal(controller.state().dirty, false);
  assert.equal(value.quotaRotation, false);

  // 存储值为非法类型时归一化为默认关闭。
  value = { quotaRotation: 'yes' as unknown as boolean };
  for (const listener of listeners) listener();
  assert.equal(controller.state().quotaRotation, false, '非布尔存储值回退默认关');
  controller.dispose();
});

test('SenseNovaSettingsController: 删除当前活动账户会同步 staged activeAccount 并保存 unset', async () => {
  let value: SenseNovaConfig = {
    accounts: [{ id: 'account-2', label: 'Secondary', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
    activeAccount: 'account-2',
  };
  const unsetFields: string[] = [];
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      unsetFields.push(field);
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  };
  const credentials: CredentialsFace = {
    describe: async () => ({ ok: true, value: {} }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controller = new SenseNovaSettingsController(scope, credentials);
  controller.removeAccount('account-2');
  assert.equal(controller.state().activeAccountDraft, '');
  await controller.save();
  assert.ok(unsetFields.includes('activeAccount'));
  assert.equal(value.activeAccount, undefined);
  assert.deepEqual(value.accounts, []);
  controller.dispose();
});

test('SenseNovaSettingsController: credential-ref trim/校验阻止非法引用进入 credentials 或配置', async () => {
  let value: SenseNovaConfig = {
    apiKeyEnv: ' VALID_REF ',
    accounts: [{ id: 'bad', label: 'Bad', apiKeyEnv: ' invalid ref ' }],
  };
  const calls = { describe: 0, set: 0, unset: 0 };
  const describedRefs: string[][] = [];
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  };
  const credentials: CredentialsFace = {
    describe: async (refs) => { calls.describe += 1; describedRefs.push([...refs]); return { ok: true, value: {} }; },
    set: async () => { calls.set += 1; return { ok: true }; },
    unset: async () => { calls.unset += 1; return { ok: true }; },
  };
  const controller = new SenseNovaSettingsController(scope, credentials);
  await Promise.resolve();
  const initialDescribe = calls.describe;
  assert.deepEqual(describedRefs[describedRefs.length - 1], ['VALID_REF']);
  assert.deepEqual(controller.storedAccounts(), []);

  controller.edit('apiKeyEnv', ' invalid ref ');
  await controller.refreshCredentials();
  assert.equal(calls.describe, initialDescribe);
  await controller.save();
  assert.equal(value.apiKeyEnv, ' VALID_REF ');
  assert.equal(calls.set, 0);
  assert.equal(calls.unset, 0);
  assert.equal(controller.state().failed, true);

  controller.discard();
  controller.edit('apiKeyEnv', '  VALID_REF  ');
  await controller.save();
  assert.equal(value.apiKeyEnv, 'VALID_REF');
  assert.equal(calls.set, 0);
  assert.equal(calls.unset, 0);
  controller.dispose();
});

test('SenseNovaSettingsController: 并发上限 staged 保存与非法值回退 1', async () => {
  let value: SenseNovaConfig = {};
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  };
  const credentials: CredentialsFace = {
    describe: async () => ({ ok: true, value: {} }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controller = new SenseNovaSettingsController(scope, credentials);
  assert.equal(controller.state().concurrency, 1, '缺省并发上限 1');
  assert.equal(controller.state().concurrencyDraft, '1');

  controller.edit('concurrency', '4');
  assert.equal(controller.state().dirty, true);
  assert.equal(controller.state().concurrencyDraft, '4');
  await controller.save();
  assert.equal(value.concurrency, 4, '合法正整数保存');

  controller.edit('concurrency', '0');
  await controller.save();
  assert.equal(value.concurrency, 1, '非法值（0）保存时回退 1');
  controller.dispose();
});

test('SenseNovaSettingsController: effectiveActiveAccountId 派生', async () => {
  let value: SenseNovaConfig = {};
  // 默认账户（SENSENOVA_API_KEY）的配置状态按场景切换；额外账户恒为已配置。
  let defaultConfigured = true;
  const listeners = new Set<() => void>();
  const scope = (): SettingsScope<SenseNovaConfig> => ({
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  });
  const credentials: CredentialsFace = {
    describe: async (refs) => ({
      ok: true,
      value: Object.fromEntries(refs.map((ref) => [
        ref,
        { configured: ref === 'SENSENOVA_API_KEY' ? defaultConfigured : true, writable: true },
      ])),
    }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controller = new SenseNovaSettingsController(scope(), credentials);
  await controller.refreshCredentials();
  // 默认账户已配置、无额外账户 → 'default'
  assert.equal(controller.state().effectiveActiveAccountId, 'default', '默认账户已配置时自动取 default');

  // 默认未配置、第一个账户已配置 → 该账户 id
  defaultConfigured = false;
  value = { accounts: [{ id: 'account-2', label: 'Secondary', apiKeyEnv: 'SENSENOVA_API_KEY_2' }] };
  await controller.refreshCredentials();
  assert.equal(controller.state().effectiveActiveAccountId, 'account-2', '默认未配置时取第一个已配置账户');

  // 钉选账户：activeAccount 指向已配置账户 → 该 id
  value = {
    accounts: [{ id: 'account-2', label: 'Secondary', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
    activeAccount: 'account-2',
  };
  await controller.refreshCredentials();
  assert.equal(controller.state().effectiveActiveAccountId, 'account-2', '钉选账户生效');

  // 全未配置 → ''
  defaultConfigured = false;
  value = { accounts: [{ id: 'account-2', label: 'Secondary', apiKeyEnv: 'SENSENOVA_API_KEY_2' }] };
  const credentialsNone: CredentialsFace = {
    describe: async (refs) => ({
      ok: true,
      value: Object.fromEntries(refs.map((ref) => [ref, { configured: false, writable: true }])),
    }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const controllerNone = new SenseNovaSettingsController(scope(), credentialsNone);
  await controllerNone.refreshCredentials();
  assert.equal(controllerNone.state().effectiveActiveAccountId, '', '无已配置账户时为空');
  controller.dispose();
  controllerNone.dispose();
});

test('SenseNovaSettingsController: 快照延迟就绪后重查凭据，额外账户徽标反映真实配置', async () => {
  const describeCalls: string[][] = [];
  let value: SenseNovaConfig | undefined = undefined;
  let status: ScopeSnapshot<SenseNovaConfig>['status'] = 'loading';
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status, value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set() {},
    async unset() {},
  };
  const credentials: CredentialsFace = {
    describe: async (refs) => {
      describeCalls.push(refs);
      const configured: Record<string, boolean> = {
        SENSENOVA_API_KEY: true,
        SENSENOVA_API_KEY_2: true,
      };
      return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: configured[ref] ?? false, writable: true }])) };
    },
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };

  // 构造时快照仍为 loading：accounts 不可见，首轮 describe 只含默认 ref。
  const controller = new SenseNovaSettingsController(scope, credentials);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.state().available, false);
  assert.deepEqual(describeCalls.at(-1), ['SENSENOVA_API_KEY']);

  // 宿主快照就绪：accounts 可见，订阅回调触发 refs 集合对比并重查。
  status = 'ready';
  value = { accounts: [{ id: 'account-2', label: '账户 2', apiKeyEnv: 'SENSENOVA_API_KEY_2' }] };
  for (const listener of listeners) listener();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const account = controller.state().accounts.find((a) => a.id === 'account-2');
  assert.ok(account, '账户 2 行存在');
  assert.equal(account.configured, true, '快照就绪后徽标为已配置');
  assert.deepEqual([...(describeCalls.at(-1) ?? [])].sort(), ['SENSENOVA_API_KEY', 'SENSENOVA_API_KEY_2']);
  controller.dispose();
});

/** 构造一个最小可用的 scope + credentials（与上文各用例同构）。 */
function makeRetryScope(initial: SenseNovaConfig = {}) {
  let value: SenseNovaConfig = initial;
  const listeners = new Set<() => void>();
  const scope: SettingsScope<SenseNovaConfig> = {
    getSnapshot: () => ({ status: 'ready', value, base: undefined, user: value, writable: true, mode: 'host' }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async set(field, next) {
      value = { ...value, [field]: next } as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
    async unset(field) {
      const next = { ...value } as Record<string, unknown>;
      delete next[field];
      value = next as SenseNovaConfig;
      for (const listener of listeners) listener();
    },
  };
  const credentials: CredentialsFace = {
    describe: async () => ({ ok: true, value: {} }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  return {
    scope,
    credentials,
    read: () => value,
    write: (next: SenseNovaConfig) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

test('SenseNovaSettingsController: 重试策略 staged 编辑 + 全量写入 + maxDelayMs 防悬崖下限', async () => {
  const h = makeRetryScope();
  const controller = new SenseNovaSettingsController(h.scope, h.credentials);

  // 缺省草稿（快照里还没有 retryPolicy）。
  assert.deepEqual(controller.state().retryPolicy, DEFAULT_RETRY_DRAFT);
  assert.deepEqual(controller.state().retryPolicyDraft, DEFAULT_RETRY_DRAFT);
  assert.equal(controller.state().dirty, false);

  // staged：只改 maxRetries —— 展示值立即变，生效值保存前不变。
  controller.editRetry('maxRetries', '40');
  assert.equal(controller.state().dirty, true);
  assert.equal(controller.state().retryPolicyDraft.maxRetries, '40');
  assert.equal(controller.state().retryPolicy.maxRetries, DEFAULT_RETRY_DRAFT.maxRetries, '保存前生效值不变');

  // 模式单选（always 会展示警告文案的分支）。
  controller.setRetryMode('always');
  assert.equal(controller.state().retryPolicyDraft.mode, 'always');

  await controller.save();
  const saved = h.read().retryPolicy as {
    mode: string; maxRetries: number;
    backoff: { initialDelayMs: number; maxDelayMs: number; jitterRatio: number };
  };
  assert.equal(saved.mode, 'always');
  assert.equal(saved.maxRetries, 40);
  // 🔴 全量写入：只改一项不能把其余项打回 host 的字段级缺省
  //    （否则 backoff.maxDelayMs 会被填成 10000 = 悬崖重现）。
  assert.deepEqual(Object.keys(saved).sort(), ['backoff', 'maxRetries', 'mode']);
  assert.deepEqual(Object.keys(saved.backoff).sort(), ['initialDelayMs', 'jitterRatio', 'maxDelayMs']);
  assert.equal(saved.backoff.maxDelayMs, 300_000);
  assert.equal(saved.backoff.initialDelayMs, 500);
  assert.equal(saved.backoff.jitterRatio, 0.1);
  assert.equal(controller.state().dirty, false);

  // 🛡️ 防悬崖：低于下限的输入被抬到 30 万。
  controller.editRetry('maxDelayMs', '60000');
  await controller.save();
  assert.equal((h.read().retryPolicy as typeof saved).backoff.maxDelayMs, 300_000, '低于下限被抬回');

  // 允许调大（方向安全）。
  controller.editRetry('maxDelayMs', '600000');
  await controller.save();
  assert.equal((h.read().retryPolicy as typeof saved).backoff.maxDelayMs, 600_000);

  // 快照里是手改的 yaml 值时，草稿如实反映（用户能看到实际生效值）。
  h.write({
    retryPolicy: {
      mode: 'normal',
      maxRetries: 9,
      backoff: { initialDelayMs: 250, maxDelayMs: 420_000, jitterRatio: 0.25 },
    },
  });
  const draft = controller.state().retryPolicyDraft;
  assert.deepEqual(draft, {
    mode: 'normal',
    maxRetries: '9',
    maxDelayMs: '420000',
    initialDelayMs: '250',
    jitterRatio: '0.25',
  });

  // discard 丢弃 staged，回到快照值。
  controller.editRetry('maxRetries', '1');
  controller.discard();
  assert.equal(controller.state().retryPolicyDraft.maxRetries, '9');
  assert.equal(controller.state().dirty, false);

  controller.dispose();
});

test('SenseNovaSettingsController: 空/非法数字草稿回退缺省（不写入 0 或 NaN）', async () => {
  const h = makeRetryScope();
  const controller = new SenseNovaSettingsController(h.scope, h.credentials);

  controller.editRetry('maxRetries', '');       // 清空输入框
  controller.editRetry('jitterRatio', '');      // ⚠️ Number('') === 0，必须被挡
  controller.editRetry('initialDelayMs', 'abc'); // 无法解析
  await controller.save();

  const saved = h.read().retryPolicy as {
    maxRetries: number;
    backoff: { initialDelayMs: number; maxDelayMs: number; jitterRatio: number };
  };
  assert.equal(saved.maxRetries, 24, '空串回退缺省而非 0');
  assert.equal(saved.backoff.jitterRatio, 0.1, '空串回退缺省而非 0');
  assert.equal(saved.backoff.initialDelayMs, 500, '非法串回退缺省');
  assert.equal(saved.backoff.maxDelayMs, 300_000);

  // 越界值被夹到区间内。
  controller.editRetry('jitterRatio', '5');
  await controller.save();
  assert.equal((h.read().retryPolicy as typeof saved).backoff.jitterRatio, 1, '>1 被夹到 1');

  controller.dispose();
});

test('SenseNovaSettingsController: errorLog 缺省开、仅显式 false 关闭（语义与 quotaRotation 相反）', async () => {
  const h = makeRetryScope();
  const controller = new SenseNovaSettingsController(h.scope, h.credentials);

  // 未配置 → 缺省开（host schema 是 .default(true)）。
  assert.equal(controller.state().errorLog, true, '未配置时视为开');
  assert.equal(controller.state().errorLogDraft, true);

  // 显式关闭 → staged 立即反映，生效值等保存。
  controller.setErrorLog(false);
  assert.equal(controller.state().errorLogDraft, false, 'staged 立即反映到展示值');
  assert.equal(controller.state().errorLog, true, '保存前生效值不变');
  await controller.save();
  assert.equal(h.read().errorLog, false, '经 settings 命名空间持久化');
  assert.equal(controller.state().errorLog, false, '保存即热生效');

  // 再打开。
  controller.setErrorLog(true);
  await controller.save();
  assert.equal(h.read().errorLog, true);

  // 存储值非法（非布尔）→ 回退缺省**开**（不是关）。
  h.write({ errorLog: 'yes' as unknown as boolean });
  assert.equal(controller.state().errorLog, true, '非布尔存储值回退默认开');

  // discard 丢弃 staged。
  controller.setErrorLog(false);
  controller.discard();
  assert.equal(controller.state().errorLogDraft, true, '丢弃 staged 后回到生效值');

  controller.dispose();
});

test('SenseNovaSettingsController: queueTimeoutMs 缺省 60s、归一化与 discard', async () => {
  const h = makeRetryScope();
  const controller = new SenseNovaSettingsController(h.scope, h.credentials);

  assert.equal(controller.state().queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS, '缺省 60000');
  assert.equal(controller.state().queueTimeoutMsDraft, '60000');

  // 合法值透传（字符串草稿 → 数字落盘）。
  controller.edit('queueTimeoutMs', '90000');
  assert.equal(controller.state().queueTimeoutMsDraft, '90000', 'staged 立即反映');
  assert.equal(controller.state().queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS, '保存前生效值不变');
  await controller.save();
  assert.equal(h.read().queueTimeoutMs, 90_000, '经 settings 命名空间持久化');
  assert.equal(controller.state().queueTimeoutMs, 90_000, '保存即热生效');

  // 空串 / 非法串 / 低于下限 → 一律回退缺省 60s（而不是 fallback 到 1000，
  // 因为 1s 的排队上限会让 p90 > 1s 的排队必然超时 = 白白丢失重试机会）。
  controller.edit('queueTimeoutMs', '');
  await controller.save();
  assert.equal(h.read().queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS, '空串回退缺省 60000');

  controller.edit('queueTimeoutMs', 'abc');
  await controller.save();
  assert.equal(h.read().queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS, '非法串回退缺省');

  controller.edit('queueTimeoutMs', '500');
  await controller.save();
  assert.equal(h.read().queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS, '低于下限回退缺省（不是钳到 1000）');

  // 恰好等于下限 → 接受。
  controller.edit('queueTimeoutMs', String(QUEUE_TIMEOUT_MIN_MS));
  await controller.save();
  assert.equal(h.read().queueTimeoutMs, QUEUE_TIMEOUT_MIN_MS, '等于下限被接受');

  // 存储值非法 → 回退缺省。
  h.write({ queueTimeoutMs: 0 });
  assert.equal(controller.state().queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS, '存储值 0 回退缺省');

  // discard 丢弃 staged。
  controller.edit('queueTimeoutMs', '12345');
  controller.discard();
  assert.equal(controller.state().queueTimeoutMsDraft, '60000', '丢弃 staged 后回到生效值/缺省');

  controller.dispose();
});

test('SenseNovaSettingsController: 三个开关互不干扰（一个 staged 不影响另两个的生效值）', async () => {
  const h = makeRetryScope({ quotaRotation: true, errorLog: true, queueTimeoutMs: 30_000 });
  const controller = new SenseNovaSettingsController(h.scope, h.credentials);

  assert.equal(controller.state().quotaRotation, true);
  assert.equal(controller.state().errorLog, true);
  assert.equal(controller.state().queueTimeoutMs, 30_000);

  controller.setErrorLog(false);
  assert.equal(controller.state().quotaRotationDraft, true, 'errorLog staged 不动 quotaRotation');
  assert.equal(controller.state().queueTimeoutMsDraft, '30000', 'errorLog staged 不动 queueTimeoutMs');

  await controller.save();
  const after = h.read();
  assert.equal(after.errorLog, false, '只写了被改的那一项');
  assert.equal(after.quotaRotation, true, '未改项保持原值');
  assert.equal(after.queueTimeoutMs, 30_000, '未改项保持原值');

  controller.dispose();
});

// ── 错误记录诊断区块（2026-09-18）────────────────────────────────────────

test('normalizeErrorLogState: 坏数据一律降级为 error 态（不抛）', () => {
  for (const bad of [null, undefined, 42, 'text', []]) {
    const state = normalizeErrorLogState(bad);
    assert.equal(state.status, 'error', '非对象输入 ⇒ error 态');
    assert.deepEqual(state.entries, []);
  }
});

test('normalizeErrorLogState: 正常 payload 归一化、坏条目跳过、越界展开下标收回', () => {
  const payload = {
    available: true,
    path: '/home/u/.dsh/logs/sensenova-errors.jsonl',
    windowMs: 86_400_000,
    total: 37,
    distinctCodes: 3,
    distinctModels: 2,
    truncated: false,
    entries: [
      {
        ts: '2026-09-18T10:12:33.000Z',
        model: 'deepseek-v4-flash',
        code: '429001',
        kind: 'tpm',
        rotated: true,
        attempt: 2,
        message: 'code=429001',
        account: 'a3f9c1d2',
        retryFloorMs: 3_000,
        providerRetryAfterMs: 4_200,
      },
      null,
      { ts: '2026-09-18T10:11:07.000Z', model: 'glm-5.2', code: '8', kind: 'rate' },
    ],
  };

  const state = normalizeErrorLogState(payload);
  assert.equal(state.status, 'ready');
  assert.equal(state.available, true);
  assert.equal(state.total, 37);
  assert.equal(state.distinctCodes, 3);
  assert.equal(state.path, '/home/u/.dsh/logs/sensenova-errors.jsonl');
  assert.equal(state.truncated, false);
  assert.equal(state.entries.length, 2, '坏条目被跳过而不是整批丢弃');
  assert.equal(state.entries[0]?.rotated, true);
  assert.equal(state.entries[0]?.retryFloorMs, 3_000);
  assert.equal(state.entries[1]?.rotated, false, '缺 rotated ⇒ false');
  assert.equal(state.entries[1]?.attempt, 0, '缺 attempt ⇒ 0');
  assert.equal(state.entries[1]?.providerRetryAfterMs, undefined, '缺字段不臆造');
  assert.equal(state.entries[1]?.message, '');

  assert.equal(normalizeErrorLogState(payload).expandedRow, null);
  assert.equal(normalizeErrorLogState(payload, 1).expandedRow, 1, '合法下标保留');
  assert.equal(normalizeErrorLogState(payload, 5).expandedRow, null, '越界下标收回');
});

/** 造一个假 fetch（记录请求 URL；返回给定响应）。 */
function stubFetch(
  calls: string[],
  respond: (url: string) => Promise<Response>,
): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return respond(url);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function logPayload(entryCount: number): Record<string, unknown> {
  return {
    available: true,
    path: '/tmp/logs/sensenova-errors.jsonl',
    windowMs: 86_400_000,
    total: entryCount,
    distinctCodes: 1,
    distinctModels: 1,
    truncated: false,
    entries: Array.from({ length: entryCount }, (_, index) => ({
      ts: `2026-09-18T10:0${index}:00.000Z`,
      model: 'deepseek-v4-flash',
      code: '429001',
      kind: 'tpm',
      rotated: false,
      attempt: 1,
      message: 'm',
      account: 'a3f9c1d2',
    })),
  };
}

test('controller.refreshErrorLog: 默认 idle 不自动拉取；成功/非 200/抛异常三种走向', async () => {
  const h = makeRetryScope();
  const controller = new SenseNovaSettingsController(h.scope, h.credentials);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];

  try {
    assert.equal(controller.state().diagnostics.status, 'idle', '构造后是 idle，不自动请求');
    assert.equal(calls.length, 0);

    globalThis.fetch = stubFetch(calls, () => Promise.resolve(jsonResponse(logPayload(2))));
    await controller.refreshErrorLog();
    assert.equal(controller.state().diagnostics.status, 'ready');
    assert.equal(controller.state().diagnostics.total, 2);
    assert.equal(controller.state().diagnostics.entries.length, 2);
    assert.equal(calls[0], '/api/sensenova/errorLog?limit=20', '请求路径与 limit 固定');

    globalThis.fetch = stubFetch(calls, () => Promise.resolve(jsonResponse({}, 500)));
    await controller.refreshErrorLog();
    assert.equal(controller.state().diagnostics.status, 'error', 'HTTP 非 200 ⇒ error 态');
    assert.deepEqual(controller.state().diagnostics.entries, []);

    globalThis.fetch = stubFetch(calls, () => Promise.reject(new Error('network down')));
    await controller.refreshErrorLog();
    assert.equal(controller.state().diagnostics.status, 'error', '网络异常被吞掉，不冒泡');
  } finally {
    globalThis.fetch = originalFetch;
    controller.dispose();
  }
});

test('controller.toggleErrorLogRow: 展开/再点收起/越界忽略', async () => {
  const h = makeRetryScope();
  const controller = new SenseNovaSettingsController(h.scope, h.credentials);
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = stubFetch([], () => Promise.resolve(jsonResponse(logPayload(2))));
    await controller.refreshErrorLog();

    assert.equal(controller.state().diagnostics.expandedRow, null, '默认全收起');
    controller.toggleErrorLogRow(0);
    assert.equal(controller.state().diagnostics.expandedRow, 0);
    controller.toggleErrorLogRow(0);
    assert.equal(controller.state().diagnostics.expandedRow, null, '再点同一条 ⇒ 收起');
    controller.toggleErrorLogRow(1);
    assert.equal(controller.state().diagnostics.expandedRow, 1);
    controller.toggleErrorLogRow(99);
    assert.equal(controller.state().diagnostics.expandedRow, 1, '越界下标被忽略，不改变现状');
    controller.toggleErrorLogRow(-1);
    assert.equal(controller.state().diagnostics.expandedRow, 1);
  } finally {
    globalThis.fetch = originalFetch;
    controller.dispose();
  }
});

test('controller: 诊断区块不参与 dirty / 保存（只读运行数据）', async () => {
  const h = makeRetryScope();
  const controller = new SenseNovaSettingsController(h.scope, h.credentials);
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = stubFetch([], () => Promise.resolve(jsonResponse(logPayload(1))));
    await controller.refreshErrorLog();
    controller.toggleErrorLogRow(0);

    assert.equal(controller.state().dirty, false, '拉取/展开都不该让页面变"未保存"');
    const before = { ...h.read() };
    await controller.save();
    assert.deepEqual(h.read(), before, '保存不会把诊断数据写进配置');
  } finally {
    globalThis.fetch = originalFetch;
    controller.dispose();
  }
});
