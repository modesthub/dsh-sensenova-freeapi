/**
 * 「当前模型 + 全部参数」的**只读 HTTP 接口**（2026-09-23，Phase 5）。
 *
 * 与 `error-log-api.ts` 完全同一套范式与约束：走 `ctx.connection.fetch.register`
 * 而不是 typert RPC（一行注册、同源自带鉴权、client 直接 `fetch`）。
 *
 * 三条硬约束（与错误记录区块一致）：
 *  1. **懒拉取、缺失即正常**：默认模型服务（`agentDefaultModel`）或 LLM 服务不可用时
 *     返回 `available: false`，UI 显示"不可用"，**不报错、不白屏**。
 *  2. **绝不抛**：面板是辅助信息，坏掉不能影响设置页本身。
 *  3. **不做轮询**：插件有「禁放 `setInterval`」的运行时卸载约束 ⇒ 打开拉一次 + 手动刷新。
 *
 * 为什么需要一个专门接口：设置页**没有会话上下文**，而"当前模型"的权威来源是
 * `agentDefaultModel`（宿主 `packages/api/session-controller/src/agent.ts:498` 同款用法）；
 * "该模型的真实能力"的权威来源是 `ctx.llm.resolveModelInfo()` ——
 * 它返回的是宿主**实际持有**的能力（含 `defaultMaxTokens` 被物化成请求 `max_tokens`
 * 的结果），比自己再算一遍可信。两者都只有 host 拿得到 ⇒ 必须由 host 出接口。
 */

import {
  DOCUMENTED_TEXT_ONLY_MODELS,
  DOCUMENTED_VISION_MODELS,
  EFFORT_LABELS,
  MODEL_CONTEXT_OVERRIDES,
  MODEL_L2_PARAM_SUPPORT,
  MODEL_MAX_OUTPUT_OVERRIDES,
  type SensenovaRequestParams,
} from './adapter.ts';

/** 路由路径（client 侧硬编码同值；约定挂在 `/api/` 下）。 */
export const MODEL_INFO_ROUTE = '/api/sensenova/modelInfo';

// ───────────────────────── 文档口径参数全集（静态表） ─────────────────────────

/** 宿主 `GenerateOptions` 是否有对应字段（决定「能不能改」）。 */
export type HostSupport = 'yes' | 'no';

/** 一个请求参数的完整事实（文档口径 + 实测 + 宿主可改性）。 */
export interface ModelParamSpec {
  /** 服务端 wire 参数名。 */
  key: string;
  /** 展示名。 */
  label: string;
  /** 取值范围 / 枚举说明（文档口径）。 */
  range: string;
  /** 服务端默认值（文档口径；'—' = 未指定）。 */
  serverDefault: string;
  /** 宿主 `GenerateOptions` 是否有对应字段。 */
  hostSupport: HostSupport;
  /** 是否属于 L2 可注入项（连接级默认值）。 */
  l2: boolean;
  /** 附加说明（多为 Phase 0 实测结论）。 */
  note?: string;
}

/**
 * 请求参数全集。
 *
 * 🔴 **来源是「文档 + Phase 0 实测」，不是网关目录** —— 实测 9/9 模型的
 * `supported_sampling_parameters` 都只报 `["temperature","stop"]`，与文档严重不符，
 * 目录的参数字段**不可信**。
 *
 * 三态「可改性」的判定：
 *  - `hostSupport: 'yes'` → ✅ 可改（若 UI 暴露 / preset 可设）
 *  - `hostSupport: 'no'` + `l2: true` → ⚙️ 插件级默认（连接级，非 per-session）
 *  - `hostSupport: 'no'` + `l2: false` → ❌ 不可改（除非改上游 `GenerateOptions`）
 */
export const MODEL_PARAM_SPECS: readonly ModelParamSpec[] = [
  { key: 'model', label: '模型 id', range: '目录里声明的 id', serverDefault: '—', hostSupport: 'yes', l2: false },
  { key: 'messages', label: '对话消息', range: 'system / user / assistant / tool', serverDefault: '—', hostSupport: 'yes', l2: false },
  { key: 'stream', label: '流式输出', range: 'boolean', serverDefault: 'false', hostSupport: 'yes', l2: false, note: '本适配器恒发 true（SSE 解析路径是唯一实现）。文档建议长文本/思考模式必开，避免超时。' },
  { key: 'stream_options', label: '流式 usage 开关', range: '{include_usage: boolean}', serverDefault: 'true', hostSupport: 'no', l2: false, note: '【实测】显式 false 会让 usage 帧**整个消失** ⇒ 插件已显式写死 true，把默认值依赖变成契约。' },
  { key: 'temperature', label: '采样温度', range: '[0, 2)', serverDefault: '1', hostSupport: 'yes', l2: false, note: '思考模式下不生效（服务端不报错）。' },
  { key: 'top_p', label: '核采样阈值', range: '(0, 1]', serverDefault: '1（glm/kimi 为 0.95）', hostSupport: 'no', l2: true, note: '【实测】kimi-k3 固定 0.95；思考模式下 <0.95 会被自动抬到 0.95，非思考模式固定 1.0 并被忽略。' },
  { key: 'max_tokens', label: '输出上限', range: '逐模型不同，见模型表', serverDefault: '逐模型', hostSupport: 'yes', l2: false, note: '【实测】思考 token 与输出共享此预算，超出会截断思考（finish_reason=length）。宿主会把适配器上报的 defaultMaxTokens 物化成这个字段。' },
  { key: 'stop', label: '停止序列', range: 'string | string[]', serverDefault: '—', hostSupport: 'yes', l2: false },
  { key: 'reasoning_effort', label: '思考档位', range: '见模型表', serverDefault: 'v4=high；v4.1/kimi=high；glm=max', hostSupport: 'yes', l2: false, note: '【实测】唯一 UI 可调项。`none` 是 5/5 模型通用的关思考方式。' },
  { key: 'thinking', label: '思考开关（显式）', range: '{"type":"enabled"/"disabled"}', serverDefault: 'enabled', hostSupport: 'no', l2: false, note: '🔴【实测】glm-5.2 传它直接 400；字符串形态 5/5 全拒。⇒ 插件**永不发送**本参数，一律用 reasoning_effort。' },
  { key: 'tools', label: '工具定义', range: 'function 数组', serverDefault: '—', hostSupport: 'yes', l2: false, note: '【实测】5/5 模型的 17 项工具调用契约全部通过。' },
  { key: 'tool_choice', label: '工具选择策略', range: 'none / auto / required', serverDefault: 'auto', hostSupport: 'no', l2: false, note: '【实测】`required` 5/5 模型均可用且真返回 tool_calls。' },
  { key: 'frequency_penalty', label: '频率惩罚', range: '[-2, 2]', serverDefault: '0', hostSupport: 'no', l2: true, note: '🔴【实测】kimi-k3 传非 0 直接 400（"only 0 is allowed"）。思考模式下不生效。' },
  { key: 'presence_penalty', label: '存在惩罚', range: '[-2, 2]', serverDefault: '0', hostSupport: 'no', l2: true, note: '🔴【实测】kimi-k3 传非 0 直接 400。思考模式下不生效。' },
  { key: 'seed', label: '随机种子', range: '[0, 9999999)', serverDefault: '—', hostSupport: 'no', l2: true, note: 'Beta；接受性 5/5 通过（kimi-k3 已整体排除，见模型表）。' },
  { key: 'do_sample', label: '是否采样（glm 独有）', range: 'boolean', serverDefault: 'true', hostSupport: 'no', l2: true, note: '仅 glm-5.2。false 时忽略 temperature/top_p，输出更稳定（适合代码/翻译）。' },
  { key: 'response_format', label: '结构化输出', range: '{type: text/json_object}', serverDefault: 'text', hostSupport: 'no', l2: false, note: '【实测】json_object 5/5 可用。⚠️ 未纳入 L2：对 DSH 的 agent 对话没有意义，且是 v4「三方组合 400」的参与者。lite 的 JSON 输出会包在 ```json 围栏里。' },
  { key: 'n', label: '生成候选数', range: '[1, 5]', serverDefault: '1', hostSupport: 'no', l2: false, note: '🔴【实测】v4/v4.1/kimi 上 n>1 被**静默降到 1**，只在 lite 真生效；且是 v4「三方组合 400」的参与者。⇒ 不提供。' },
  { key: 'parallel_tool_calls', label: '并行工具调用', range: 'boolean', serverDefault: 'true', hostSupport: 'no', l2: false, note: '【实测】v4 上与 n/response_format 同传会 400。未纳入 L2。' },
  { key: 'logprobs', label: '返回对数概率', range: 'boolean', serverDefault: '—', hostSupport: 'no', l2: false, note: '仅 v4.1 文档提及；未实测，DSH 不消费。' },
];

/** 单个模型的事实表（模型级差异都在这里）。 */
export interface ModelFactSheet {
  id: string;
  displayName: string;
  /** 上下文窗口（token）。 */
  contextWindow: number;
  /** 输出预算（token）——即插件上报的 defaultMaxTokens。 */
  maxOutputTokens: number;
  /** 是否支持图片输入（文档 + 实测双重确认）。 */
  vision: boolean;
  /** 视觉备注（格式 / 大小 / 传输方式）。 */
  visionNote?: string;
  /** 无视觉模型收图后的行为（决定危险程度）。 */
  textOnlyBehavior?: 'hallucinates' | 'refuses';
  /** 思考档位（Phase 0 实测词表，UI 展示顺序）。 */
  efforts: readonly string[];
  /** 该模型**不允许**注入的 L2 参数（白名单的反面，便于一眼看清）。 */
  blockedL2Params: readonly string[];
  /** 其它实测要点。 */
  notes: readonly string[];
}

const NOTES_LITE = [
  '上下文 262,144（≠ 1M，其余模型都是 1M）。',
  '【实测】`max` 与 `minimal` 都被拒：服务端词表就是 low/medium/high/xhigh/none。',
  '【实测】JSON 模式输出会被包在 ```json 围栏里，解析侧需剥围栏。',
  '【实测】`n:2` 是 5 个模型里唯一真生效的。',
];

const NOTES_V4 = [
  '【实测】无视觉能力：贴图后模型会**幻觉**（编造"心形图案、数字9"），且图片被网关接受并计费（ptok 109 vs 纯文本 14）⇒ 最危险，切勿给它发图。',
  '【实测】文档写的 `max` 档是错的（400）；服务端词表 low/medium/high/xhigh/none。',
  '【实测】`n` + `parallel_tool_calls` + `response_format` 三者同时传会 400。',
  '【实测】思考模式会把推理写进可见正文（`none` 只是关掉思考通道，不是关掉推理能力）。',
];

const NOTES_V41 = [
  '视觉实测通过：准确读出测试图中的红方块 / 蓝圆 / 数字 42。',
  '【实测】图片 token 在 ~1003 封顶（服务端自行缩放，与文件大小解耦）⇒ 图片预算可相对放宽。',
  '【实测】全 7 档都接受（含 minimal/xhigh/max）；文档声称 medium/xhigh 会被映射到 high（未实测确认）。',
  '目录 `input_modalities` 长期只报 ["text"] ⇒ 视觉能力由白名单硬补。',
  '【实测】`deepseek-v4.1-flash` 是 403 诱饵 id，唯一可调的是本 id。',
];

const NOTES_GLM = [
  '【实测】无视觉能力但**诚实拒答**（明确说"我无法直接看到图片"），不产生幻觉 ⇒ 比 v4-flash 安全。',
  '🔴【实测】`thinking` 参数**硬拒**（400）：必须用 `reasoning_effort`，本插件永不发送 thinking。',
  '默认思考档位是 `max`（不是 high）⇒ 输出预算必须给到 131072。',
  '独有 `do_sample` 参数（false 时输出更稳定，适合代码/翻译）。',
];

const NOTES_KIMI = [
  '视觉实测通过：准确读出测试图中的红方块 / 蓝圆 / 数字 42。',
  '🔴 图片输入**只吃 Base64**（不吃公网 URL），且 `content` 必须是对象数组 —— 插件已统一发 data URL，天然兼容。',
  '🔴【实测】图片 token **线性增长**（7MB 图 = 3168 prompt tokens，是 v4.1 的 3 倍）⇒ 大图对 TPM 的冲击远超其它模型。',
  '🔴【实测】传非 0 的频率惩罚/存在惩罚直接 400（"only 0 is allowed"）⇒ L2 参数全部排除。',
  '文档写 `max_completion_tokens`，实测 `max_tokens` 是同一字段别名且被遵守（max_tokens=8 真被截断到 8）。',
  'temperature 固定 1、top_p 固定 0.95（文档口径，未实测偏离值）。',
];

/** 模型事实表（Phase 0 实测 + 文档）。 */
export const MODEL_FACT_SHEETS: readonly ModelFactSheet[] = [
  {
    id: 'sensenova-6.8-flash-lite',
    displayName: 'SenseNova 6.8 Flash Lite',
    contextWindow: MODEL_CONTEXT_OVERRIDES.get('sensenova-6.8-flash-lite') ?? 262_144,
    maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get('sensenova-6.8-flash-lite') ?? 65_536,
    vision: true,
    visionNote: '支持 JPG/JPEG/PNG/WebP；公网 URL 与 Base64 均可。',
    efforts: [...(MODEL_L2_PARAM_SUPPORT.get('sensenova-6.8-flash-lite') ?? [])].length > 0 ? ['none', 'low', 'medium', 'high', 'xhigh'] : [],
    blockedL2Params: [],
    notes: NOTES_LITE,
  },
  {
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    contextWindow: MODEL_CONTEXT_OVERRIDES.get('deepseek-v4-flash') ?? 1_048_576,
    maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get('deepseek-v4-flash') ?? 131_072,
    vision: false,
    textOnlyBehavior: 'hallucinates',
    efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    blockedL2Params: [],
    notes: NOTES_V4,
  },
  {
    id: 'deepseek-flash',
    displayName: 'DeepSeek V4.1 Flash',
    contextWindow: MODEL_CONTEXT_OVERRIDES.get('deepseek-flash') ?? 1_048_576,
    maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get('deepseek-flash') ?? 131_072,
    vision: true,
    visionNote: '支持 JPEG/PNG/GIF/WebP；单图 ≤50MB（实测 8MB 即 413，文档口径不可信）；URL 与 Base64 均可。',
    efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'minimal', 'max'],
    blockedL2Params: [],
    notes: NOTES_V41,
  },
  {
    id: 'glm-5.2',
    displayName: 'GLM-5.2',
    contextWindow: MODEL_CONTEXT_OVERRIDES.get('glm-5.2') ?? 1_048_576,
    maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get('glm-5.2') ?? 131_072,
    vision: false,
    textOnlyBehavior: 'refuses',
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    blockedL2Params: [],
    notes: NOTES_GLM,
  },
  {
    id: 'kimi-k3',
    displayName: 'Kimi K3',
    contextWindow: MODEL_CONTEXT_OVERRIDES.get('kimi-k3') ?? 1_048_576,
    maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get('kimi-k3') ?? 131_072,
    vision: true,
    visionNote: '支持 JPEG/PNG/WebP/GIF/BMP/HEIC/HEIF；**仅 Base64**（不吃公网 URL）；`content` 必须是数组。',
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    blockedL2Params: ['top_p', 'frequency_penalty', 'presence_penalty', 'seed', 'do_sample'],
    notes: NOTES_KIMI,
  },
];

// ───────────────────────── 快照组装 ─────────────────────────

/** 宿主解析出的模型能力（`ctx.llm.resolveModelInfo()` 的形状子集）。 */
export interface ResolvedModelInfoLike {
  id?: string;
  name?: string;
  inputModalities?: readonly string[];
  context?: { contextWindow?: number };
  defaultMaxTokens?: number;
  reasoning?: {
    efforts?: readonly { id?: string; name?: string; description?: string }[];
    defaultEffort?: string;
  };
}

/** 账户池摘要（面板显示"当前接线了几把 key"）。 */
export interface AccountPoolSummary {
  /** 已接线的账户槽位数（**含**默认账户）。 */
  slots: number;
  /** 各槽位的 credential-ref 名（**只有引用名，绝不含密钥值**）。 */
  refs: readonly string[];
  /** 当前钉选的活动账户 id；空串 = 自动模式。 */
  activeAccount: string;
  /** 配额类 429 粘性换 key 是否开启。 */
  quotaRotation: boolean;
}

/**
 * 设置服务侧探针（2026-09-24）。
 *
 * 目的：把"账户数对不上"这件事拆成**三路独立数据**，直接定位断在哪一环。
 *
 * | 数据 | 来源 | 含义 |
 * |---|---|---|
 * | `accounts.slots` | 插件 fiber config（`options().accounts`） | 插件**实际生效**了几个账户 |
 * | `settingsProbe.accountsInSettings` | `settings.describe()` 里该 ns 的 `value.accounts` | **设置传输层**给出的账户数 |
 * | 客户端渲染数 | client 的 `state.accounts` | 界面**实际渲染**了几个 |
 *
 * 三者应当逐级相等。第 1≠2 说明配置没进设置传输层；第 2≠界面 说明客户端
 * decode 失败或快照未就绪（`ConfigForms.decode` 失败是**静默**的，只会让
 * `draft.value` 不更新、界面回落 schema 默认值）。
 */
export interface SettingsValueProbe {
  /** `settings` 服务是否可用（不可用时后面字段无意义）。 */
  serviceAvailable: boolean;
  /** 设置段里 `accounts` 的条数；-1 = 该字段缺失或该 namespace 不在 describe 结果里。 */
  accountsInSettings: number;
  /** 该 namespace 在 describe 结果里出现过几次（0 说明根本没注册上）。 */
  namespacesSeen: number;
  /** 设置段是否可写。 */
  writable?: boolean;
  /** 探针自身失败时的说明（不抛）。 */
  error?: string;
}

export interface ModelInfoSnapshot {
  /** LLM 服务与默认模型服务是否都可用。false ⇒ UI 显示"不可用"，不是错误。 */
  available: boolean;
  error?: string;
  /** 当前默认模型（`agentDefaultModel.currentSelection()`）。 */
  selection?: { provider?: string; model?: string; reasoningEffort?: string };
  /**
   * 账户池摘要。
   *
   * 🔴 2026-09-24 新增：直接回答"插件里到底接线了几个 sensenova 账户"。
   * 来源是**插件 fiber 当前生效的 config**（`options().accounts`），
   * 与设置页读的是同一份事实 ⇒ 可用于判定"界面显示的账户数是否正确"。
   */
  accounts?: AccountPoolSummary;
  /** 设置传输层探针（与 `accounts` 逐级比对，定位断点）。 */
  settingsProbe?: SettingsValueProbe;
  /** 宿主实际解析出的能力。 */
  resolved?: {
    name?: string;
    inputModalities?: readonly string[];
    contextWindow?: number;
    defaultMaxTokens?: number;
    efforts?: readonly { id?: string; name?: string; description?: string }[];
    defaultEffort?: string;
  };
  /** 静态事实表命中项（表外模型为 undefined）。 */
  facts?: ModelFactSheet;
  /** 静态参数全集（所有模型共用，模型差异在 facts.notes 里）。 */
  params: readonly ModelParamSpec[];
  /** 当前模型允许注入的 L2 参数（白名单命中项）。 */
  l2Allowed: readonly string[];
  /** Phase 0 实测时间戳（用于标注数据新鲜度）。 */
  probedAt: string;
}

/** Phase 0 实测完成时间（数据新鲜度标注）。 */
export const PHASE0_PROBED_AT = '2026-09-23 19:45 GMT+8';

export interface ModelInfoDeps {
  /** 解析当前默认模型（`agentDefaultModel.currentSelection()`）；不可用时返回 undefined。 */
  currentSelection: () => { provider?: string; model?: string; reasoningEffort?: string } | undefined;
  /** 宿主能力解析（`ctx.llm.resolveModelInfo`）；不可用时返回 undefined。 */
  resolveModelInfo: (provider: string, model: string) => Promise<ResolvedModelInfoLike | undefined>;
  /** 已归一化的 L2 参数（连接级配置）。 */
  requestParams: SensenovaRequestParams;
  /** 账户池摘要（读插件当前生效的 config）。 */
  accountPool: () => AccountPoolSummary;
  /** 设置传输层探针（读 `settings.describe()`；不可用时返回 serviceAvailable:false）。 */
  settingsProbe: () => SettingsValueProbe;
}

/**
 * 组装快照。**绝不抛**：任何一步失败都降级为 `available: false` + error 说明。
 */
export async function buildModelInfoSnapshot(deps: ModelInfoDeps): Promise<ModelInfoSnapshot> {
  // 账户池在这里就取（**不依赖** LLM/默认模型服务是否可用）—— 即使模型信息拿不到，
  // 用户也应该能看到"接线了几个账户"。accountPool() 由调用方保证不抛。
  let accounts: AccountPoolSummary;
  try {
    accounts = deps.accountPool();
  } catch {
    accounts = { slots: 0, refs: [], activeAccount: '', quotaRotation: false };
  }
  let settingsProbe: SettingsValueProbe;
  try {
    settingsProbe = deps.settingsProbe();
  } catch (err) {
    settingsProbe = {
      serviceAvailable: false,
      accountsInSettings: -1,
      namespacesSeen: 0,
      error: String((err as Error)?.message ?? err).slice(0, 200),
    };
  }
  const base: ModelInfoSnapshot = {
    available: false,
    accounts,
    settingsProbe,
    params: MODEL_PARAM_SPECS,
    l2Allowed: [],
    probedAt: PHASE0_PROBED_AT,
  };
  const selection = deps.currentSelection();
  if (selection === undefined || typeof selection.model !== 'string' || selection.model === '') {
    return { ...base, error: 'default-model-unavailable' };
  }
  const provider = typeof selection.provider === 'string' && selection.provider !== '' ? selection.provider : 'sensenova';
  const model = selection.model;
  let resolved: ResolvedModelInfoLike | undefined;
  try {
    resolved = await deps.resolveModelInfo(provider, model);
  } catch (err) {
    return {
      ...base,
      selection: { provider, model, ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}) },
      error: `resolve-model-failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
    };
  }
  if (resolved === undefined) {
    return {
      ...base,
      selection: { provider, model, ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}) },
      error: 'model-info-unavailable',
    };
  }
  const allowed = MODEL_L2_PARAM_SUPPORT.get(model);
  // 只有「已知模型」才带事实表；表外模型不给 facts（面板会显示"未收录该模型"）。
  const known = DOCUMENTED_VISION_MODELS.has(model) || DOCUMENTED_TEXT_ONLY_MODELS.has(model);
  const factSheet = known ? MODEL_FACT_SHEETS.find((sheet) => sheet.id === model) : undefined;
  return {
    available: true,
    // ⚠️ 成功路径是**新建对象字面量**（不是展开 base），新增字段必须在这里也带上，
    // 否则只有降级分支能看到它 —— 单测「正常路径」正是抓的这个漏项。
    accounts,
    settingsProbe,
    selection: { provider, model, ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}) },
    resolved: {
      ...(resolved.name !== undefined ? { name: resolved.name } : {}),
      ...(resolved.inputModalities !== undefined ? { inputModalities: resolved.inputModalities } : {}),
      ...(resolved.context !== undefined ? { contextWindow: resolved.context.contextWindow } : {}),
      ...(resolved.defaultMaxTokens !== undefined ? { defaultMaxTokens: resolved.defaultMaxTokens } : {}),
      ...(resolved.reasoning?.efforts !== undefined ? { efforts: resolved.reasoning.efforts } : {}),
      ...(resolved.reasoning?.defaultEffort !== undefined ? { defaultEffort: resolved.reasoning.defaultEffort } : {}),
    },
    ...(factSheet !== undefined ? { facts: factSheet } : {}),
    params: MODEL_PARAM_SPECS,
    l2Allowed: allowed !== undefined ? [...allowed] : [],
    probedAt: PHASE0_PROBED_AT,
  };
}

/**
 * HTTP 处理函数：`GET /api/sensenova/modelInfo`。
 *
 * 与错误记录路由同一条实测结论：框架层按 `methods` 过滤，非 GET 根本不会进这里
 * （表现是 404），下面的 405 分支只是防御性兜底。
 */
export function handleModelInfoHttp(
  request: Request,
  deps: ModelInfoDeps,
): Promise<Response> {
  if (request.method !== 'GET') {
    return Promise.resolve(new Response(null, { status: 405, headers: { allow: 'GET' } }));
  }
  return buildModelInfoSnapshot(deps).then((snapshot) => new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })).catch((err) => new Response(JSON.stringify({
    available: false,
    error: `handler-failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`,
    params: MODEL_PARAM_SPECS,
    l2Allowed: [],
    probedAt: PHASE0_PROBED_AT,
  }), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } }));
}

/** 供设置页展示用的档位文案（与适配器上报的 `name` 一致）。 */
export function effortDisplayName(effort: string): string {
  return EFFORT_LABELS.get(effort)?.name ?? effort;
}
