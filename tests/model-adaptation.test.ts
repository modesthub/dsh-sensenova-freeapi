/**
 * 2026-09-23 Phase 0–4 模型适配新增行为的回归测试。
 *
 * 覆盖三块（全部对应 Phase 0 的 131 用例实测结论）：
 *  1. `l2ParamsFor` 的**按模型白名单**过滤 —— 绝不能把文档里所有参数一次性注入
 *     （kimi-k3 传非 0 惩罚项会 400；`n` 在多数模型上被静默降到 1 且参与 v4 的组合 400）。
 *  2. `buildOpenAiBody` 显式写死 `stream_options.include_usage` ——
 *     依赖服务端默认值会在上游翻默认时让 usage **静默消失**，TPM 记账跟着失效。
 *  3. `MODEL_MAX_OUTPUT_OVERRIDES` / 视觉白名单 / 不可路由清单的静态事实。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_CONTEXT_OVERRIDES,
  MODEL_L2_PARAM_SUPPORT,
  MODEL_MAX_OUTPUT_OVERRIDES,
  DOCUMENTED_VISION_MODELS,
  DOCUMENTED_TEXT_ONLY_MODELS,
  KNOWN_UNROUTABLE_MODELS,
  buildOpenAiBody,
  l2ParamsFor,
  type SensenovaRequestParams,
} from '../src/adapter.ts';

const ALL_FIVE = [
  'sensenova-6.8-flash-lite',
  'deepseek-v4-flash',
  'deepseek-flash',
  'glm-5.2',
  'kimi-k3',
];

// ── L2 白名单 ───────────────────────────────────────────────────────────────

test('L2: 四个模型的 top_p/惩罚项/seed 默认值会被注入', () => {
  const params: SensenovaRequestParams = {
    topP: 0.9,
    frequencyPenalty: 0.5,
    presencePenalty: 0.5,
    seed: 42,
  };
  for (const model of ['sensenova-6.8-flash-lite', 'deepseek-v4-flash', 'deepseek-flash', 'glm-5.2']) {
    const body = l2ParamsFor(model, params);
    assert.equal(body.top_p, 0.9, model);
    assert.equal(body.frequency_penalty, 0.5, model);
    assert.equal(body.presence_penalty, 0.5, model);
    assert.equal(body.seed, 42, model);
  }
});

test('L2: kimi-k3 全部排除（实测传非 0 惩罚项 → 400 "only 0 is allowed"）', () => {
  const params: SensenovaRequestParams = { topP: 0.9, frequencyPenalty: 0.5, presencePenalty: 0.5, seed: 42, doSample: true };
  assert.deepEqual(l2ParamsFor('kimi-k3', params), {}, 'kimi 的 L2 参数必须全空');
  assert.equal(MODEL_L2_PARAM_SUPPORT.get('kimi-k3')?.size, 0);
});

test('L2: do_sample 只对 glm-5.2 开放（文档独有字段）', () => {
  const params: SensenovaRequestParams = { doSample: false };
  assert.deepEqual(l2ParamsFor('glm-5.2', params), { do_sample: false });
  for (const model of ['sensenova-6.8-flash-lite', 'deepseek-v4-flash', 'deepseek-flash']) {
    assert.deepEqual(l2ParamsFor(model, params), {}, model);
  }
});

test('L2: 表外模型一律不注入（宁可少发，不要因未知能力吃 400）', () => {
  const params: SensenovaRequestParams = { topP: 0.9, seed: 1 };
  for (const model of ['deepseek-v4-pro', 'sensenova-u1-fast', 'some-future-model']) {
    assert.deepEqual(l2ParamsFor(model, params), {}, model);
  }
});

test('L2: 未配置任何参数 ⇒ 不产出任何字段', () => {
  for (const model of ALL_FIVE) {
    assert.deepEqual(l2ParamsFor(model, {}), {});
  }
});

// ── 请求体：stream_options 显式契约 ─────────────────────────────────────────

test('请求体恒写 stream_options.include_usage = true（不依赖服务端默认值）', () => {
  const body = buildOpenAiBody({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as never, new Map());
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test('请求体：L2 参数并入且不覆盖宿主显式字段（reasoning_effort 正常透传）', () => {
  const body = buildOpenAiBody({
    model: 'glm-5.2',
    reasoningEffort: 'high',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  } as never, new Map(), { top_p: 0.9, do_sample: false });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.top_p, 0.9);
  assert.equal(body.do_sample, false);
  assert.equal('thinking' in body, false, '绝不发送 thinking（glm-5.2 会 400）');
  assert.equal('n' in body, false, '绝不发送 n（多模型静默降 1，且是 v4 组合 400 的参与者）');
});

// ── 静态事实表的一致性护栏 ─────────────────────────────────────────────────

test('视觉白名单：三个视觉模型在列，两个纯文本模型不在列', () => {
  for (const id of ['sensenova-6.8-flash-lite', 'deepseek-flash', 'kimi-k3']) {
    assert.ok(DOCUMENTED_VISION_MODELS.has(id), id);
  }
  for (const id of ['deepseek-v4-flash', 'glm-5.2']) {
    assert.equal(DOCUMENTED_VISION_MODELS.has(id), false, id);
    assert.ok(DOCUMENTED_TEXT_ONLY_MODELS.has(id), `${id} 应在纯文本清单里（供面板警示）`);
  }
});

test('输出预算表：min(服务端上限, 131072)，5 个模型全覆盖', () => {
  assert.equal(MODEL_MAX_OUTPUT_OVERRIDES.get('sensenova-6.8-flash-lite'), 65_536);
  for (const id of ['deepseek-v4-flash', 'deepseek-flash', 'glm-5.2', 'kimi-k3']) {
    assert.equal(MODEL_MAX_OUTPUT_OVERRIDES.get(id), 131_072, id);
  }
  assert.equal(MODEL_CONTEXT_OVERRIDES.get('sensenova-6.8-flash-lite'), 262_144, 'lite 上下文不是 1M');
});

test('不可路由清单包含 403 诱饵 id deepseek-v4.1-flash', () => {
  assert.equal(KNOWN_UNROUTABLE_MODELS.has('deepseek-v4.1-flash'), true);
  assert.equal(KNOWN_UNROUTABLE_MODELS.has('deepseek-flash'), false, '真实 id 必须可路由');
});
