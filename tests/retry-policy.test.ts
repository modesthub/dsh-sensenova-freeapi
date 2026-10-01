/**
 * W1（2026-09-17）专项测试：`llm-sensenova.retryPolicy` 配置化 + 生效路径。
 *
 * 覆盖三件事：
 *  1. `mergeRetryPolicy` 的**防悬崖不变量**——`maxDelayMs` 永远 ≥ pra 上限；
 *  2. `Config` schema 的**字段级深合并**——部分配置不会把其他字段打回官方缺省
 *     （官方 `RetryPolicySchema` 的 backoff 缺省 10_000 正是本路由的悬崖陷阱）；
 *  3. `apply()` 的**配置生效路径**——0.1.7 起改为「配置变更 ⇒ 宿主重新 apply」，
 *     原先的 `ensureRegistrationFacts` + `registration.replace()` 刷新机制已成死代码，
 *     本文件随之重写为断言「每次 apply 都用当时配置注册适配器」+「自带页面策略」。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Config, apply, mergeRetryPolicy, plainConfig, resolveAdapterOptions } from '../src/index.ts';
import { QUOTA_RETRY_AFTER_CEILING_MS } from '../src/adapter.ts';

const CEILING = QUOTA_RETRY_AFTER_CEILING_MS;

/** 取已解析策略的 maxRetries（窄化到 normal 分支，非 normal 时返回 undefined）。 */
function maxRetriesOf(policy: { mode: string } & Record<string, unknown>): number | undefined {
  return policy.mode === 'normal' ? (policy['maxRetries'] as number) : undefined;
}

// ── 1. 防悬崖不变量 ───────────────────────────────────────────────────

test('mergeRetryPolicy: undefined 回落到缺省（maxDelayMs = pra 上限）', () => {
  const merged = mergeRetryPolicy(undefined);
  assert.equal(merged.mode, 'normal');
  assert.equal(merged.maxRetries, 24);
  assert.equal(merged.backoff?.maxDelayMs, CEILING);
});

test('mergeRetryPolicy: 只改 maxRetries 不会丢 maxDelayMs（不变量守住）', () => {
  const merged = mergeRetryPolicy({ mode: 'normal', maxRetries: 40 });
  assert.equal(merged.maxRetries, 40);
  assert.equal(merged.backoff?.maxDelayMs, CEILING);
});

test('🛡️ mergeRetryPolicy: 显式调小 maxDelayMs 会被硬下限抬回 pra 上限', () => {
  // 低于上限 = 落入死亡区 = 宿主对 pra > maxDelayMs 直接放弃重试（悬崖）。
  // 这是纯负收益配置，插件兜住它（UI 侧同样把输入下限钉在该值）。
  for (const requested of [1_000, 10_000, 60_000, 299_999]) {
    const merged = mergeRetryPolicy({ mode: 'normal', backoff: { maxDelayMs: requested } });
    assert.equal(merged.backoff?.maxDelayMs, CEILING, `请求 ${requested} 应被抬到 ${CEILING}`);
  }
});

test('mergeRetryPolicy: 允许把 maxDelayMs 调**大**（方向安全）', () => {
  const merged = mergeRetryPolicy({ mode: 'normal', backoff: { maxDelayMs: 600_000 } });
  assert.equal(merged.backoff?.maxDelayMs, 600_000);
});

test('mergeRetryPolicy: always 模式保留 mode，其余字段仍被兜底', () => {
  const merged = mergeRetryPolicy({ mode: 'always' });
  assert.equal(merged.mode, 'always');
  assert.equal(merged.backoff?.maxDelayMs, CEILING);
});

// ── 2. schema 字段级深合并（vs 官方 RetryPolicySchema 的陷阱）────────────

test('Config: 未配置 retryPolicy 时取本插件的缺省（不是官方的 10000）', () => {
  const parsed = plainConfig(Config({}));
  assert.ok(parsed.retryPolicy !== undefined);
  assert.equal(parsed.retryPolicy?.mode, 'normal');
  assert.equal(parsed.retryPolicy?.maxRetries, 24);
  assert.equal(parsed.retryPolicy?.backoff?.maxDelayMs, CEILING);
});

test('🔴 Config: 只给 maxRetries 时 backoff 仍是 300000（官方 schema 会填成 10000）', () => {
  const parsed = plainConfig(Config({ retryPolicy: { mode: 'normal', maxRetries: 30 } }));
  assert.equal(parsed.retryPolicy?.maxRetries, 30);
  assert.equal(
    parsed.retryPolicy?.backoff?.maxDelayMs,
    CEILING,
    'backoff 被官方缺省污染 = 悬崖重现',
  );
});

test('🔴 Config: 只给 backoff 时 maxRetries 仍是 24（不被官方缺省 5 覆盖）', () => {
  const parsed = plainConfig(Config({ retryPolicy: { mode: 'normal', backoff: { maxDelayMs: 400_000 } } }));
  assert.equal(parsed.retryPolicy?.maxRetries, 24);
  assert.equal(parsed.retryPolicy?.backoff?.maxDelayMs, 400_000);
});

test('Config: 非法 retryPolicy 被拒（拼错的 mode / 负数）', () => {
  assert.throws(() => Config({ retryPolicy: { mode: 'bogus' } as never }), /expected "normal" \| "always"/);
  assert.throws(() => Config({ retryPolicy: { mode: 'normal', maxRetries: -1 } }), /number >= 0/);
});

test('🔎 未知键由 resolveRetryPolicy 拒绝（schemastery 的 object 默认忽略未知键）', () => {
  // 关键差别：schema 层不报错，严格性来自 resolveRetryPolicy 的 validateKeys。
  // ⇒ 手工编辑 settings.yaml 写错键名时，错误会在**插件加载/配置解析**阶段暴露
  //   （apply() 里的首次 options() 调用），而不是静默吞掉。
  const parsed = plainConfig(Config({ retryPolicy: { mode: 'normal', foo: 1 } as never }));
  assert.doesNotThrow(() => Config({ retryPolicy: { mode: 'normal', foo: 1 } as never }));
  assert.throws(() => resolveAdapterOptions(parsed as never), /unknown key "foo"/);
});

test('resolveAdapterOptions: 端到端产出已解析策略，且不变量成立', () => {
  const opts = resolveAdapterOptions(
    // `.volatile()` 后必须先解包（与 apply() 入口同一处理）。
    plainConfig(Config({ retryPolicy: { mode: 'normal', maxRetries: 7 } })),
  );
  assert.equal(opts.retryPolicy.mode, 'normal');
  assert.equal(maxRetriesOf(opts.retryPolicy as never), 7);
  assert.ok(
    opts.retryPolicy.maxDelayMs >= CEILING,
    `maxDelayMs(${opts.retryPolicy.maxDelayMs}) 必须 ≥ ${CEILING}`,
  );
});

test('resolveAdapterOptions: 程序化构造绕过 schema 时仍兜底（config.retryPolicy 缺失）', () => {
  const opts = resolveAdapterOptions({ apiBase: 'https://example.invalid/v1' } as never);
  assert.equal(opts.retryPolicy.mode, 'normal');
  assert.equal(maxRetriesOf(opts.retryPolicy as never), 24);
  assert.equal(opts.retryPolicy.maxDelayMs, CEILING);
});

// ── 3. 配置变更的生效路径（0.1.7 重写）────────────────────────────────

interface Harness {
  ctx: unknown;
  /** 每次 apply 注册进 llm 的适配器（用来读它在注册时捕获的策略）。 */
  adapters: { providerRetryPolicy?: (provider: string) => unknown }[];
  /** `settings.configure` 收到的页面策略调用。 */
  configureCalls: unknown[];
}

/**
 * 最小 ctx 替身：只实现 apply() 真正会走到的面。
 *
 * ⚠️ **0.1.7 起这个替身换了形状**：插件不再调用 `settings.installSection`，改为
 * `settings.configure({ auto: false }, ctx.fiber)`（且包在 `effect` 里）。替身必须
 * **真的执行 effect 回调**，否则 `configure` 永远不会被调到、断言会静默假通过。
 */
function makeHarness(): Harness {
  const adapters: Harness['adapters'] = [];
  const configureCalls: unknown[] = [];
  const ctx = {
    fiber: {},
    llm: {
      registerAdapter: (_providers: string[], adapter: Harness['adapters'][number]) => {
        adapters.push(adapter);
        return { replace: () => {}, dispose: () => {} };
      },
      registerConfigurableProviders: () => {},
    },
    inject: (deps: string[], cb: (c: unknown) => void) => {
      // 宿主在 apply 期间同步进入该回调（与真实 cordis 一致）。
      // ⚠️ 必须**按 deps 分派**：不同服务注入的是不同的 ctx 面（settings / connection）。
      // 早前所有 deps 共用一个只带 settings 的替身，新增 connection 注入点后直接报
      // `connectionCtx.effect is not a function` —— 替身得跟着注入面一起长。
      const effect = (fn: () => unknown) => { fn(); };
      if (deps.includes('connection')) {
        cb({ effect, connection: { fetch: { register: () => () => Promise.resolve() } } });
        return;
      }
      cb({
        effect,
        settings: {
          // 0.1.7：`installSection` 已随 `SettingsProvider → SettingsForms` 一起移除。
          // 插件现在只用 `configure` 声明「本插件自带页面」。
          configure: (presentation: unknown) => {
            configureCalls.push(presentation);
            return () => {};
          },
        },
      });
    },
    get: () => undefined,
    effect: (fn: () => unknown) => { fn(); },
  };
  return { ctx, adapters, configureCalls };
}

test('apply: 自带页面策略 = auto:false，且策略经「重新 apply」生效（0.1.7 无 replace）', () => {
  const policy24 = { mode: 'normal' as const, maxRetries: 24, backoff: { maxDelayMs: CEILING } };
  const policy40 = { mode: 'normal' as const, maxRetries: 40, backoff: { maxDelayMs: CEILING } };
  const base = { apiBase: 'https://example.invalid/v1' };

  // ① 首次 apply：注册进来的适配器带着当时的策略，并声明自带页面。
  const h1 = makeHarness();
  apply(h1.ctx as never, { ...base, retryPolicy: policy24 } as never);
  assert.equal(h1.adapters.length, 1, 'apply 应注册一次适配器');
  const policyOf = (h: Harness): unknown => h.adapters[0]?.providerRetryPolicy?.('sensenova');
  assert.equal(maxRetriesOf(policyOf(h1) as never), 24, '注册时捕获 policy24');
  assert.deepEqual(h1.configureCalls, [{ auto: false }], '应声明自带页面（auto:false）');

  // ② 配置变更 ⇒ 宿主**重新 apply**（上游 settings/tests/live-config.ts 的驱动方式：
  //    `entry.update({config})` + `fiber.await()` ⇒ fiber 重建，apply 重跑）。
  //    因此这里用全新 harness 模拟一次重放，断言新策略被捕获。
  const h2 = makeHarness();
  apply(h2.ctx as never, { ...base, retryPolicy: policy40 } as never);
  assert.equal(maxRetriesOf(policyOf(h2) as never), 40, '重放后捕获 policy40');

  // ③ 回归提示：这条路径**不再**依赖 registration.replace —— 插件已经不持有该句柄。
  //    若将来有人把 replace 机制加回来，这里会因适配器数量/调用面变化而失配。
  assert.equal(h2.adapters.length, 1, '重放只注册一次，不需要 replace 刷新');
});
