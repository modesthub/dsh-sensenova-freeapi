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

/** 最小凭据面：内存 Map。 */
function makeCredentials(store: Map<string, string>) {
  return {
    describe: async (refs: string[]) => ({
      ok: true,
      value: Object.fromEntries(refs.map((ref) => [ref, { configured: store.has(ref), writable: true }])),
    }),
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

function makeController(store: Map<string, string>, value: Record<string, unknown>) {
  const scope = makeScope(value);
  const controller = new SenseNovaSettingsController(scope as never, makeCredentials(store) as never);
  return { scope, controller };
}

test('导入：复用已有账户 ref，并写入默认账户', async () => {
  const store = new Map<string, string>();
  const { scope, controller } = makeController(store, {
    apiKeyEnv: 'SENSENOVA_API_KEY',
    accounts: [{ id: 'account-2', label: '2-0', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
  });
  controller.editKeysIoText(['Default:sk-defaultdefault1', '账户2', '0:sk-222222222222'].join('\n'));
  await controller.importKeys();
  const state = controller.state();
  assert.equal(state.keysIo.error, '');
  assert.match(state.keysIo.message, /已导入 2 把/);
  assert.equal(store.get('SENSENOVA_API_KEY'), 'sk-defaultdefault1');
  assert.equal(store.get('SENSENOVA_API_KEY_2'), 'sk-222222222222');
  controller.dispose();
});

test('导入：新标签分配新 ref 并追加账户（回归：不得误报写入失败）', async () => {
  const store = new Map<string, string>();
  const { scope, controller } = makeController(store, {
    apiKeyEnv: 'SENSENOVA_API_KEY',
    accounts: [{ id: 'account-2', label: '2-0', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
  });
  controller.editKeysIoText(['账户3', '0:sk-333333333333'].join('\n'));
  await controller.importKeys();
  const state = controller.state();
  assert.equal(state.keysIo.error, '', '新账户的 key 不应被判失败');
  assert.match(state.keysIo.message, /已导入 1 把/);
  const accounts = (scope.getSnapshot().value as { accounts: Array<{ label: string; apiKeyEnv: string }> }).accounts;
  const added = accounts.find((a) => a.label === '3-0');
  assert.ok(added, '新账户应写入 accounts');
  assert.equal(store.get(added.apiKeyEnv), 'sk-333333333333');
  // 凭据状态应立即可见（describeAll 带上了新 ref）
  assert.equal(controller.state().accounts.find((a) => a.label === '3-0')?.configured, true);
  controller.dispose();
});

test('导入：空/非法文本给出提示且不写任何东西', async () => {
  const store = new Map<string, string>();
  const { controller } = makeController(store, { apiKeyEnv: 'SENSENOVA_API_KEY' });
  controller.editKeysIoText('这不是 key');
  await controller.importKeys();
  assert.match(controller.state().keysIo.error, /无法识别|没有可导入/);
  assert.equal(store.size, 0);
  controller.dispose();
});

test('导入：重复密钥只写一次', async () => {
  const store = new Map<string, string>();
  const { controller } = makeController(store, { apiKeyEnv: 'SENSENOVA_API_KEY' });
  controller.editKeysIoText(['1-0:sk-samesamesame', '1-1:sk-samesamesame'].join('\n'));
  await controller.importKeys();
  assert.match(controller.state().keysIo.message, /已导入 1 把/);
  controller.dispose();
});
