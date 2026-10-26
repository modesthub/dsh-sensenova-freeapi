import test from 'node:test';
import assert from 'node:assert/strict';
import { SenseNovaSettingsController, type SettingsScope } from '../src/client/settings.ts';

/** 最小内存版设置域（与真实 SettingsScope 同形）。 */
function makeScope(value: Record<string, unknown>): SettingsScope<Record<string, unknown>> {
  let current = value;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ status: 'ready', value: current, base: current, user: current, writable: true, mode: 'host' }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: async (field: string, next: unknown) => {
      current = { ...current, [field]: next };
      for (const listener of listeners) listener();
      return true;
    },
    unset: async (field: string) => {
      const next = { ...current };
      delete next[field];
      current = next;
      for (const listener of listeners) listener();
      return true;
    },
  } as unknown as SettingsScope<Record<string, unknown>>;
}

/** 最小凭据面：内存 Map；counter 用于统计 describe 次数。 */
function makeCredentials(store: Map<string, string>, counter?: { describe: number }) {
  return {
    describe: async (refs: string[]) => {
      if (counter !== undefined) counter.describe += 1;
      return {
        ok: true,
        value: Object.fromEntries(refs.map((ref) => [ref, { configured: store.has(ref), writable: true }])),
      };
    },
    set: async (ref: string, value: string) => {
      store.set(ref, value);
      return { ok: true };
    },
    unset: async (ref: string) => {
      store.delete(ref);
      return { ok: true };
    },
  };
}

function makeController(store: Map<string, string>, value: Record<string, unknown>, counter?: { describe: number }) {
  const scope = makeScope(value);
  const controller = new SenseNovaSettingsController(
    scope as never,
    makeCredentials(store, counter) as never,
  );
  return { scope, controller };
}

test('导入：写草稿并置 dirty（不直接落库）', async () => {
  const store = new Map<string, string>();
  const { controller } = makeController(store, {
    apiKeyEnv: 'SENSENOVA_API_KEY',
    accounts: [{ id: 'account-2', label: '2-0', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
  });
  controller.editKeysIoText(['Default:sk-defaultdefault1', '账户2', '0:sk-222222222222'].join('\n'));
  await controller.importKeys();
  const state = controller.state();
  assert.equal(state.keysIo.error, '');
  assert.match(state.keysIo.message, /已导入 2 条草稿/);
  assert.equal(state.dirty, true, '导入后必须置 dirty，让保存按钮亮起');
  assert.equal(store.size, 0, '导入不应直接写凭据');
  controller.dispose();
});

test('导入 + 保存：写入默认账户与已有账户，并更新已配置状态', async () => {
  const store = new Map<string, string>();
  const { controller } = makeController(store, {
    apiKeyEnv: 'SENSENOVA_API_KEY',
    accounts: [{ id: 'account-2', label: '2-0', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
  });
  controller.editKeysIoText(['Default:sk-defaultdefault1', '账户2', '0:sk-222222222222'].join('\n'));
  await controller.importKeys();
  await controller.save();
  assert.equal(store.get('SENSENOVA_API_KEY'), 'sk-defaultdefault1');
  assert.equal(store.get('SENSENOVA_API_KEY_2'), 'sk-222222222222');
  const state = controller.state();
  assert.equal(state.dirty, false, '保存后 dirty 应清零');
  assert.equal(state.defaultConfigured, true);
  assert.equal(state.accounts.find((a) => a.label === '2-0')?.configured, true);
  controller.dispose();
});

test('导入 + 保存：新标签分配新 ref 并追加账户（回归：不得误报失败）', async () => {
  const store = new Map<string, string>();
  const { scope, controller } = makeController(store, {
    apiKeyEnv: 'SENSENOVA_API_KEY',
    accounts: [{ id: 'account-2', label: '2-0', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
  });
  controller.editKeysIoText(['账户3', '0:sk-333333333333'].join('\n'));
  await controller.importKeys();
  assert.equal(controller.state().dirty, true);
  await controller.save();
  const state = controller.state();
  assert.equal(state.keysIo.error, '');
  const accounts = (scope.getSnapshot().value as { accounts: Array<{ label: string; apiKeyEnv: string }> }).accounts;
  const added = accounts.find((a) => a.label === '3-0');
  assert.ok(added, '新账户应写入 accounts');
  assert.equal(store.get(added.apiKeyEnv), 'sk-333333333333');
  assert.equal(state.accounts.find((a) => a.label === '3-0')?.configured, true, '保存后应显示已配置');
  controller.dispose();
});

test('导入：空/非法文本给出提示且不置 dirty', async () => {
  const store = new Map<string, string>();
  const { controller } = makeController(store, { apiKeyEnv: 'SENSENOVA_API_KEY' });
  controller.editKeysIoText('这不是 key');
  await controller.importKeys();
  assert.match(controller.state().keysIo.error, /无法识别|没有可导入/);
  assert.equal(controller.state().dirty, false);
  assert.equal(store.size, 0);
  controller.dispose();
});

test('导入：重复密钥只草稿一次', async () => {
  const store = new Map<string, string>();
  const { controller } = makeController(store, { apiKeyEnv: 'SENSENOVA_API_KEY' });
  controller.editKeysIoText(['1-0:sk-samesamesame', '1-1:sk-samesamesame'].join('\n'));
  await controller.importKeys();
  assert.match(controller.state().keysIo.message, /已导入 1 条草稿/);
  controller.dispose();
});

test('describe：80 个 ref 会分批查询，不会整批失败（v0.2.4）', async () => {
  const store = new Map<string, string>();
  const accounts = Array.from({ length: 80 }, (_, index) => ({
    id: `account-${index}`,
    label: `x-${index}`,
    apiKeyEnv: `SENSENOVA_API_KEY_${index + 100}`,
  }));
  for (const account of accounts) store.set(account.apiKeyEnv, 'sk-x');
  const counter = { describe: 0 };
  const { controller } = makeController(store, { apiKeyEnv: 'SENSENOVA_API_KEY', accounts }, counter);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(counter.describe >= 4, `80 个 ref 应至少分 4 批查询，实际 ${counter.describe}`);
  const configured = controller.state().accounts.filter((a) => a.configured).length;
  assert.equal(configured, 80, '分批查询后所有账户都应为已配置');
  controller.dispose();
});

test('导入：不会因逐条 reference-updated 触发全量 describe（防抖）', async () => {
  const store = new Map<string, string>();
  const counter = { describe: 0 };
  const { controller } = makeController(store, { apiKeyEnv: 'SENSENOVA_API_KEY', accounts: [] }, counter);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = counter.describe;
  const lines: string[] = [];
  for (let account = 1; account <= 4; account += 1) {
    lines.push(`账户${account}`);
    for (let slot = 0; slot < 5; slot += 1) {
      lines.push(`${slot}:sk-${'a'.repeat(10)}${account}${slot}`);
    }
  }
  controller.editKeysIoText(lines.join('\n'));
  await controller.importKeys();
  assert.ok(counter.describe - before <= 5, `导入期间 describe 次数应很少，实际 ${counter.describe - before}`);
  controller.dispose();
});

test('清空全部账户：staged 移除，保存后清空 accounts 并删除对应凭据（v0.2.5）', async () => {
  const store = new Map<string, string>();
  store.set('SENSENOVA_API_KEY', 'sk-default');
  store.set('SENSENOVA_API_KEY_2', 'sk-two');
  store.set('SENSENOVA_API_KEY_3', 'sk-three');
  const { scope, controller } = makeController(store, {
    apiKeyEnv: 'SENSENOVA_API_KEY',
    accounts: [
      { id: 'account-2', label: '2-0', apiKeyEnv: 'SENSENOVA_API_KEY_2' },
      { id: 'account-3', label: '3-0', apiKeyEnv: 'SENSENOVA_API_KEY_3' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.state().accounts.length, 2);

  controller.clearAllAccounts();
  assert.equal(controller.state().dirty, true, '清空应置 dirty（保存按钮亮起）');
  assert.equal(controller.state().accounts.length, 0, '移除是 staged 的：行立即消失，但凭据/accounts 尚未落库');

  await controller.save();
  assert.equal(controller.state().dirty, false);
  assert.equal(controller.state().accounts.length, 0, '保存后账户清空');
  assert.equal(store.has('SENSENOVA_API_KEY_2'), false, '对应凭据应被删除');
  assert.equal(store.has('SENSENOVA_API_KEY_3'), false);
  assert.equal(store.get('SENSENOVA_API_KEY'), 'sk-default', '默认账户凭据保留');
  controller.dispose();
});
