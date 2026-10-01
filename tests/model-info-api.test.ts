/**
 * model-info-api 的护栏测试（2026-09-23/24）。
 *
 * 重点锁两件事：
 *  1. **账户池在任何分支都要回传** —— 即使"当前模型"取不到，"接线了几个账户"也是
 *     用户要看的核心信息（2026-09-24 为排查"界面只显示一个默认账户"而加）。
 *  2. 各降级分支（服务缺失 / resolveModelInfo 抛错 / 表外模型）都不抛、形状稳定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModelInfoSnapshot,
  handleModelInfoHttp,
  MODEL_PARAM_SPECS,
  PHASE0_PROBED_AT,
  type ModelInfoDeps,
} from '../src/model-info-api.ts';

const POOL = {
  slots: 3,
  refs: ['SENSENOVA_API_KEY', 'SENSENOVA_API_KEY_2', 'SENSENOVA_API_KEY_3'],
  activeAccount: '',
  quotaRotation: true,
};

function deps(overrides: Partial<ModelInfoDeps> = {}): ModelInfoDeps {
  return {
    currentSelection: () => ({ provider: 'sensenova', model: 'deepseek-flash' }),
    resolveModelInfo: async () => ({
      id: 'deepseek-flash',
      name: 'DeepSeek V4.1 Flash',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 131_072,
      reasoning: {
        efforts: [{ id: 'none', name: 'Off' }, { id: 'high', name: 'High' }],
      },
    }),
    requestParams: {},
    accountPool: () => POOL,
    settingsProbe: () => ({ serviceAvailable: true, accountsInSettings: 2, namespacesSeen: 1, writable: true }),
    ...overrides,
  };
}

test('正常路径：账户池 + 解析能力 + 参数全集都在', async () => {
  const snapshot = await buildModelInfoSnapshot(deps());
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.accounts, POOL);
  assert.equal(snapshot.selection?.model, 'deepseek-flash');
  assert.equal(snapshot.resolved?.defaultMaxTokens, 131_072);
  assert.deepEqual(snapshot.resolved?.efforts?.map((e) => e.id), ['none', 'high']);
  assert.equal(snapshot.params.length, MODEL_PARAM_SPECS.length);
  assert.equal(snapshot.probedAt, PHASE0_PROBED_AT);
  assert.ok(snapshot.facts, '已知模型应带事实表');
  assert.equal(snapshot.facts?.vision, true);
  assert.deepEqual(snapshot.l2Allowed, ['top_p', 'frequency_penalty', 'presence_penalty', 'seed']);
});

test('默认模型服务缺失：available=false 但**账户池仍要回传**', async () => {
  const snapshot = await buildModelInfoSnapshot(deps({ currentSelection: () => undefined }));
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.error, 'default-model-unavailable');
  assert.deepEqual(snapshot.accounts, POOL, '账户池不能因为模型信息缺失就一起丢');
  assert.equal(snapshot.params.length, MODEL_PARAM_SPECS.length);
});

test('resolveModelInfo 抛错：降级为 available=false，账户池仍在，且不回显敏感堆栈', async () => {
  const snapshot = await buildModelInfoSnapshot(deps({
    resolveModelInfo: async () => { throw new Error('boom at C:\\secret\\path.ts'); },
  }));
  assert.equal(snapshot.available, false);
  assert.ok(snapshot.error?.startsWith('resolve-model-failed:'));
  assert.deepEqual(snapshot.accounts, POOL);
});

test('resolveModelInfo 返回 undefined：available=false，账户池仍在', async () => {
  const snapshot = await buildModelInfoSnapshot(deps({ resolveModelInfo: async () => undefined }));
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.error, 'model-info-unavailable');
  assert.deepEqual(snapshot.accounts, POOL);
});

test('accountPool 自身抛错时不拖垮接口（回退 0 个账户）', async () => {
  const snapshot = await buildModelInfoSnapshot(deps({
    accountPool: () => { throw new Error('config exploded'); },
  }));
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.accounts, { slots: 0, refs: [], activeAccount: '', quotaRotation: false });
});

test('表外模型：不带 facts，但 l2Allowed 为空（不注入未知模型）', async () => {
  const snapshot = await buildModelInfoSnapshot(deps({
    currentSelection: () => ({ provider: 'sensenova', model: 'some-future-model' }),
  }));
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.facts, undefined);
  assert.deepEqual(snapshot.l2Allowed, []);
});

test('HTTP：GET 返回 200 + JSON；非 GET 返回 405 + allow 头', async () => {
  const get = await handleModelInfoHttp(
    new Request('http://localhost/api/sensenova/modelInfo', { method: 'GET' }),
    deps(),
  );
  assert.equal(get.status, 200);
  assert.match(get.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  const body = await get.json() as { accounts?: unknown; available?: unknown; settingsProbe?: unknown };
  assert.equal(body.available, true);
  assert.deepEqual(body.accounts, POOL);
  assert.deepEqual(body.settingsProbe, { serviceAvailable: true, accountsInSettings: 2, namespacesSeen: 1, writable: true });

  const post = await handleModelInfoHttp(
    new Request('http://localhost/api/sensenova/modelInfo', { method: 'POST' }),
    deps(),
  );
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET');
});

// ── 三路比对探针（2026-09-24「账户数对不上」排查）──────────────────────────

test('settingsProbe：设置传输层报出账户条数，用于与插件配置逐级比对', async () => {
  const snapshot = await buildModelInfoSnapshot(deps());
  assert.equal(snapshot.accounts?.slots, 3, '插件侧 3 个');
  assert.equal(snapshot.settingsProbe?.accountsInSettings, 2, '传输层 2 个附加（+默认 = 3）');
  assert.equal(snapshot.settingsProbe?.namespacesSeen, 1, 'ns 注册上了');
});

test('settingsProbe：设置服务缺失时 serviceAvailable=false，不抛', async () => {
  const snapshot = await buildModelInfoSnapshot(deps({
    settingsProbe: () => ({ serviceAvailable: false, accountsInSettings: -1, namespacesSeen: 0 }),
  }));
  assert.equal(snapshot.available, true, '设置探针不可用不影响模型信息');
  assert.equal(snapshot.settingsProbe?.serviceAvailable, false);
  assert.equal(snapshot.settingsProbe?.accountsInSettings, -1);
});

test('settingsProbe：自身抛错时降级，接口仍 200', async () => {
  const snapshot = await buildModelInfoSnapshot(deps({
    settingsProbe: () => { throw new Error('describe boom'); },
  }));
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.settingsProbe?.serviceAvailable, false);
  assert.match(snapshot.settingsProbe?.error ?? '', /describe boom/);
});

test('降级分支同样携带 settingsProbe（否则排查时看不到传输层数字）', async () => {
  const snapshot = await buildModelInfoSnapshot(deps({ currentSelection: () => undefined }));
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.settingsProbe?.accountsInSettings, 2);
  assert.equal(snapshot.accounts?.slots, 3);
});
