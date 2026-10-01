/**
 * Config schema 的 volatile 护栏（2026-09-24）。
 *
 * 🔴 背景：本插件此前**一个字段都没标 `.volatile()`** ⇒
 * `packages/settings/settings/src/schema.ts` 的 `volatileForm(Config)` 返回 `undefined`
 * ⇒ `SettingsForms.describe()` **静默跳过整个 namespace** ⇒ 设置页
 * `ConfigForms.get('llm-sensenova')` 拿不到 view、`draft.value` 永不更新
 * ⇒ **卡片显示的一直是 schema 默认值**（accounts 默认 `[]` ⇒ 界面只剩一个默认账户）。
 *
 * 同时 `.volatile()` 会让字段在运行期变成 `{ get() }` 引用，必须经 `plainConfig()`
 * 解包后才能交给 `resolveAdapterOptions()`。两条护栏各锁一半，缺一个都会回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, plainConfig, resolveAdapterOptions, type SensenovaConfig } from '../src/index.ts';

test('🔴 Config: 每个顶层字段都标了 volatile（否则 describe() 跳过整个 namespace）', () => {
  const dict = (Config as unknown as { dict?: Record<string, { meta?: { volatile?: boolean } }> }).dict;
  assert.ok(dict, 'Config 应可读出 dict');
  const keys = Object.keys(dict);
  assert.ok(keys.length > 0);
  const missing = keys.filter((key) => dict[key]?.meta?.volatile !== true);
  assert.deepEqual(
    missing,
    [],
    `以下字段缺少 .volatile()，会让设置页读不到配置：${missing.join(', ')}`,
  );
});

test('🔴 Config: schema 输出是 volatile 引用，plainConfig 必须能解包回普通值', () => {
  const raw = Config({
    apiKeyEnv: 'SENSENOVA_API_KEY',
    accounts: [{ id: 'account-2', label: '账户 2', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
    concurrency: 3,
    quotaRotation: true,
    requestParams: { topP: 0.9, seed: 42 },
  }) as unknown as Record<string, unknown>;

  // 前提：带 volatile 的字段在运行期确实是 { get() } 引用。
  assert.equal(typeof (raw.concurrency as { get?: unknown })?.get, 'function', 'volatile 字段应包成引用');

  const plain = plainConfig(raw as unknown as SensenovaConfig);
  assert.equal(Array.isArray(plain.accounts), true, 'accounts 应解包成数组');
  assert.equal(plain.accounts?.length, 1);
  assert.equal(plain.concurrency, 3);
  assert.equal(plain.quotaRotation, true);
  assert.equal(plain.requestParams?.topP, 0.9);
  assert.equal(plain.requestParams?.seed, 42);
});

test('plainConfig 解包后可直接喂 resolveAdapterOptions（端到端不变量）', () => {
  const plain = plainConfig(Config({
    accounts: [{ id: 'account-2', label: '账户 2', apiKeyEnv: 'SENSENOVA_API_KEY_2' }],
    concurrency: 3,
    queueTimeoutMs: 180_000,
    quotaRotation: true,
  }) as unknown as SensenovaConfig);
  const resolved = resolveAdapterOptions(plain);
  assert.equal(resolved.accounts.length, 2, '默认账户 + 1 个附加');
  assert.deepEqual(resolved.accounts.map((a) => a.ref), ['SENSENOVA_API_KEY', 'SENSENOVA_API_KEY_2']);
  assert.equal(resolved.concurrency, 3);
  assert.equal(resolved.queueTimeoutMs, 180_000);
  assert.equal(resolved.quotaRotation, true);
});

test('plainConfig 对普通值（非引用）原样透传，不误伤', () => {
  const plain = { apiKeyEnv: 'SENSENOVA_API_KEY', concurrency: 5, accounts: [] };
  const out = plainConfig(plain);
  assert.equal(out.concurrency, 5);
  assert.equal(out.apiKeyEnv, 'SENSENOVA_API_KEY');
  assert.deepEqual(out.accounts, []);
});

test('未配置时 requestParams 归一化为空对象（不注入任何 L2 参数）', () => {
  const resolved = resolveAdapterOptions(plainConfig(Config({}) as unknown as SensenovaConfig));
  assert.deepEqual(resolved.requestParams, {});
});
