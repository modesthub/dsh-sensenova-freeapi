window.__ModuleLoader__.load({
	id: "dsh-sensenova-freeapi",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/settings.ts
		/**
		* SenseNova 设置页的领域层（无 JSX）：把 `llm-sensenova` 设置命名空间与
		* credentials 域桥接到页面状态。宿主是唯一事实来源，保存即热生效。
		*
		* 与 @mars-sea/dsh-commandcode-provider 的 SettingsController 同构，但只保留
		* 多账户配置所需的最小面：apiBase、默认凭据引用 apiKeyEnv、accounts 增删与
		* activeAccount 单选；API key 一律经 credentials 域写入（credential-ref），
		* 页面不回显明文。
		*/
		/** 设置命名空间与 provider 路由（与冻结契约一致）。 */
		const SENSENOVA_NS = "llm-sensenova";
		const SENSENOVA_ROUTE = "sensenova";
		const SENSENOVA_DISPLAY_NAME = "SenseNova";
		/** 默认 apiBase 与默认凭据环境变量。 */
		const DEFAULT_API_BASE = "https://token.sensenova.cn/v1";
		const DEFAULT_API_KEY_ENV = "SENSENOVA_API_KEY";
		/**
		* 并发闸排队等待上限的缺省值（毫秒）＝ host 侧 `DEFAULT_QUEUE_TIMEOUT_MS`。
		* ⚠️ client bundle 无法 import host 模块，改动 `concurrency.ts` 时须同步这里。
		*/
		const DEFAULT_QUEUE_TIMEOUT_MS = 6e4;
		/** `queueTimeoutMs` 的界面下限，与 host schema 的 `z.natural().min(1_000)` 对齐。 */
		const QUEUE_TIMEOUT_MIN_MS = 1e3;
		/** 把并发上限输入归一化为正整数（非法/无法解析回退默认 1）。 */
		function normalizeConcurrency(value) {
			if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
			if (typeof value === "string") {
				const parsed = Number.parseInt(value.trim(), 10);
				if (Number.isInteger(parsed) && parsed >= 1) return parsed;
			}
			return 1;
		}
		/** 把 quotaRotation 存储值归一化为布尔（仅严格 true 视为开，其余回退默认关）。 */
		function normalizeQuotaRotation(value) {
			return value === true ? true : false;
		}
		/**
		* 把 errorLog 存储值归一化为布尔。语义与 {@link normalizeQuotaRotation} 相反：
		* 缺省为**开**，因此仅显式 `false` 才关闭；未配置（undefined）视为开。
		*/
		function normalizeErrorLog(value) {
			return value === false ? false : true;
		}
		/** 把排队超时输入归一化为 ≥ 1s 的整数毫秒（非法/过小回退缺省 60s）。 */
		function normalizeQueueTimeoutMs(value) {
			if (typeof value === "number" && Number.isFinite(value) && value >= 1e3) return Math.round(value);
			if (typeof value === "string") {
				const parsed = Number.parseInt(value.trim(), 10);
				if (Number.isFinite(parsed) && parsed >= 1e3) return parsed;
			}
			return DEFAULT_QUEUE_TIMEOUT_MS;
		}
		/**
		* 错误记录只读路由。⚠️ 与 host 侧 `error-log-api.ts` 的 `ERROR_LOG_ROUTE`
		* **必须同值** —— client bundle 无法 import host 模块，改动时两边一起改。
		*/
		const ERROR_LOG_ROUTE = "/api/sensenova/errorLog";
		/**
		* 模型信息只读路由。⚠️ 与 host 侧 `model-info-api.ts` 的 `MODEL_INFO_ROUTE`
		* **必须同值** —— client bundle 无法 import host 模块。
		*/
		const MODEL_INFO_ROUTE = "/api/sensenova/modelInfo";
		const IDLE_MODEL_INFO_STATE = { status: "idle" };
		/** 把宿主侧「可改性」收敛成三态。host 侧已算好，这里只做形状防御。 */
		function mutabilityOf(row) {
			if (row.hostSupport === "yes") return "host";
			return row.l2 === true ? "l2" : "none";
		}
		/**
		* 归一化宿主返回的快照。**绝不抛**：字段缺失/类型不符一律取兜底值，
		* 保证面板在旧 host / 数据不完整时只显示"信息不全"而不是崩掉。
		*/
		function normalizeModelInfoState(raw) {
			if (typeof raw !== "object" || raw === null) return { status: "error" };
			const source = raw;
			const rawParams = Array.isArray(source.params) ? source.params : [];
			const params = [];
			for (const item of rawParams) {
				if (typeof item !== "object" || item === null) continue;
				const row = item;
				if (typeof row.key !== "string" || row.key === "") continue;
				params.push({
					key: row.key,
					label: typeof row.label === "string" ? row.label : row.key,
					range: typeof row.range === "string" ? row.range : "",
					serverDefault: typeof row.serverDefault === "string" ? row.serverDefault : "",
					hostSupport: row.hostSupport === "yes" ? "yes" : "no",
					l2: row.l2 === true,
					...typeof row.note === "string" && row.note !== "" ? { note: row.note } : {},
					mutability: mutabilityOf(row)
				});
			}
			const rawAccounts = typeof source.accounts === "object" && source.accounts !== null ? source.accounts : void 0;
			const accounts = rawAccounts === void 0 ? void 0 : {
				slots: typeof rawAccounts.slots === "number" ? rawAccounts.slots : 0,
				refs: Array.isArray(rawAccounts.refs) ? rawAccounts.refs : [],
				activeAccount: typeof rawAccounts.activeAccount === "string" ? rawAccounts.activeAccount : "",
				quotaRotation: rawAccounts.quotaRotation === true
			};
			const resolved = typeof source.resolved === "object" && source.resolved !== null ? source.resolved : void 0;
			const selection = typeof source.selection === "object" && source.selection !== null ? source.selection : void 0;
			const rawFacts = typeof source.facts === "object" && source.facts !== null ? source.facts : void 0;
			const rawProbe = typeof source.settingsProbe === "object" && source.settingsProbe !== null ? source.settingsProbe : void 0;
			const settingsProbe = rawProbe === void 0 ? void 0 : {
				serviceAvailable: rawProbe.serviceAvailable === true,
				accountsInSettings: typeof rawProbe.accountsInSettings === "number" ? rawProbe.accountsInSettings : -1,
				namespacesSeen: typeof rawProbe.namespacesSeen === "number" ? rawProbe.namespacesSeen : 0,
				...typeof rawProbe.writable === "boolean" ? { writable: rawProbe.writable } : {},
				...typeof rawProbe.error === "string" ? { error: rawProbe.error } : {}
			};
			return {
				status: "ready",
				snapshot: {
					available: source.available === true,
					...typeof source.error === "string" ? { error: source.error } : {},
					...accounts !== void 0 ? { accounts } : {},
					...settingsProbe !== void 0 ? { settingsProbe } : {},
					...selection !== void 0 && typeof selection.model === "string" ? { selection: {
						...typeof selection.provider === "string" ? { provider: selection.provider } : {},
						model: selection.model,
						...typeof selection.reasoningEffort === "string" ? { reasoningEffort: selection.reasoningEffort } : {}
					} } : {},
					...resolved !== void 0 ? { resolved: {
						...typeof resolved.name === "string" ? { name: resolved.name } : {},
						...Array.isArray(resolved.inputModalities) ? { inputModalities: resolved.inputModalities } : {},
						...typeof resolved.contextWindow === "number" ? { contextWindow: resolved.contextWindow } : {},
						...typeof resolved.defaultMaxTokens === "number" ? { defaultMaxTokens: resolved.defaultMaxTokens } : {},
						...Array.isArray(resolved.efforts) ? { efforts: resolved.efforts.map((row) => ({
							...typeof row.id === "string" ? { id: row.id } : {},
							...typeof row.name === "string" ? { name: row.name } : {},
							...typeof row.description === "string" ? { description: row.description } : {}
						})) } : {},
						...typeof resolved.defaultEffort === "string" ? { defaultEffort: resolved.defaultEffort } : {}
					} } : {},
					...rawFacts !== void 0 ? { facts: {
						id: typeof rawFacts.id === "string" ? rawFacts.id : "",
						displayName: typeof rawFacts.displayName === "string" ? rawFacts.displayName : "",
						contextWindow: typeof rawFacts.contextWindow === "number" ? rawFacts.contextWindow : 0,
						maxOutputTokens: typeof rawFacts.maxOutputTokens === "number" ? rawFacts.maxOutputTokens : 0,
						vision: rawFacts.vision === true,
						...typeof rawFacts.visionNote === "string" ? { visionNote: rawFacts.visionNote } : {},
						...rawFacts.textOnlyBehavior === "hallucinates" || rawFacts.textOnlyBehavior === "refuses" ? { textOnlyBehavior: rawFacts.textOnlyBehavior } : {},
						efforts: Array.isArray(rawFacts.efforts) ? rawFacts.efforts : [],
						blockedL2Params: Array.isArray(rawFacts.blockedL2Params) ? rawFacts.blockedL2Params : [],
						notes: Array.isArray(rawFacts.notes) ? rawFacts.notes : []
					} } : {},
					params,
					l2Allowed: Array.isArray(source.l2Allowed) ? source.l2Allowed : [],
					probedAt: typeof source.probedAt === "string" ? source.probedAt : ""
				}
			};
		}
		const IDLE_ERROR_LOG_STATE = {
			status: "idle",
			available: false,
			path: "",
			windowMs: 1440 * 60 * 1e3,
			total: 0,
			distinctCodes: 0,
			distinctModels: 0,
			entries: [],
			truncated: false,
			expandedRow: null
		};
		function textOf(value) {
			return typeof value === "string" ? value : "";
		}
		function numberOf(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		}
		/**
		* 把路由返回的 JSON 归一化为区块状态（纯函数）。
		*
		* 与 host 侧同一原则：**坏数据只降级、绝不抛** —— 这块是辅助信息，不能让设置页崩。
		* 服务端已经做过一次字段裁剪，这里再兜一次是为了防止"host 升级了、client 还是旧包"
		* 这种版本错配（插件以 `link:` 挂载，两侧产物可能不同步）。
		*/
		function normalizeErrorLogState(raw, expandedRow = null) {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {
				...IDLE_ERROR_LOG_STATE,
				status: "error",
				expandedRow
			};
			const record = raw;
			const rawEntries = Array.isArray(record.entries) ? record.entries : [];
			const entries = [];
			for (const item of rawEntries) {
				if (typeof item !== "object" || item === null) continue;
				const entry = item;
				entries.push({
					ts: textOf(entry.ts),
					model: textOf(entry.model),
					code: textOf(entry.code),
					kind: textOf(entry.kind),
					rotated: entry.rotated === true,
					attempt: numberOf(entry.attempt),
					message: textOf(entry.message),
					...typeof entry.retryFloorMs === "number" ? { retryFloorMs: entry.retryFloorMs } : {},
					...typeof entry.providerRetryAfterMs === "number" ? { providerRetryAfterMs: entry.providerRetryAfterMs } : {},
					...typeof entry.probeHits === "number" ? { probeHits: entry.probeHits } : {},
					...typeof entry.kicked === "boolean" ? { kicked: entry.kicked } : {},
					...typeof entry.poolRunning === "number" ? { poolRunning: entry.poolRunning } : {},
					...typeof entry.poolBlocked === "number" ? { poolBlocked: entry.poolBlocked } : {},
					...typeof entry.accountLabel === "string" && entry.accountLabel !== "" ? { accountLabel: entry.accountLabel } : {},
					...typeof entry.accountRef === "string" && entry.accountRef !== "" ? { accountRef: entry.accountRef } : {},
					account: textOf(entry.account)
				});
			}
			return {
				status: "ready",
				available: record.available === true,
				path: textOf(record.path),
				windowMs: numberOf(record.windowMs) || IDLE_ERROR_LOG_STATE.windowMs,
				total: numberOf(record.total),
				distinctCodes: numberOf(record.distinctCodes),
				distinctModels: numberOf(record.distinctModels),
				entries,
				truncated: record.truncated === true,
				expandedRow: expandedRow !== null && expandedRow < entries.length ? expandedRow : null
			};
		}
		/**
		* `maxDelayMs` 的界面硬下限（毫秒）＝ host 侧 `QUOTA_RETRY_AFTER_CEILING_MS`。
		*
		* ⚠️ 这是本页最不"可调"的参数，原因：宿主 `dsh-llm-retry` 对
		* `providerRetryAfterMs > policy.maxDelayMs` 的处理是**直接放弃重试**
		* （`return next()`，不是夹到上限）⇒ 把上限调到低于适配器能吐出的 pra 上限
		* 会制造"死亡区"：落入其中的限流请求不会等待，而是让**整个回合立即失败**。
		* 这是纯负收益配置，因此界面上不接受更小的值（host 侧 `mergeRetryPolicy`
		* 还有第二道兜底）。允许**调大**。
		*
		* 与 host 常量的同步关系：改动 `adapter.ts` 的 `QUOTA_RETRY_AFTER_CEILING_MS`
		* 时必须同步这里（client bundle 无法 import host 模块）。
		*/
		const RETRY_MAX_DELAY_FLOOR_MS = 3e5;
		/** 缺省草稿：与 host 侧 `DEFAULT_RETRY_POLICY_CONFIG` 的数值保持一致。 */
		const DEFAULT_RETRY_DRAFT = {
			mode: "normal",
			maxRetries: "24",
			maxDelayMs: String(RETRY_MAX_DELAY_FLOOR_MS),
			initialDelayMs: "500",
			jitterRatio: "0.1"
		};
		function numberText(value, fallback) {
			return typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
		}
		/** 从设置快照的 `retryPolicy` 读出草稿；缺失或非法时回退缺省。 */
		function normalizeRetryPolicyDraft(raw) {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_RETRY_DRAFT;
			const record = raw;
			const rawBackoff = record.backoff;
			const backoff = typeof rawBackoff === "object" && rawBackoff !== null && !Array.isArray(rawBackoff) ? rawBackoff : {};
			return {
				mode: record.mode === "always" ? "always" : "normal",
				maxRetries: numberText(record.maxRetries, DEFAULT_RETRY_DRAFT.maxRetries),
				maxDelayMs: numberText(backoff.maxDelayMs, DEFAULT_RETRY_DRAFT.maxDelayMs),
				initialDelayMs: numberText(backoff.initialDelayMs, DEFAULT_RETRY_DRAFT.initialDelayMs),
				jitterRatio: numberText(backoff.jitterRatio, DEFAULT_RETRY_DRAFT.jitterRatio)
			};
		}
		function clampNumber(text, fallback, min, max) {
			const trimmed = text.trim();
			if (trimmed === "") return fallback;
			const parsed = Number(trimmed);
			if (!Number.isFinite(parsed)) return fallback;
			return Math.min(Math.max(parsed, min), max);
		}
		/** `MAX_TIMER_DELAY_MS`（host 侧 `dsh-llm` 的上限）。 */
		const MAX_TIMER_DELAY_MS = 2147483647;
		/**
		* 把页面草稿组装成 host schema 接受的 `retryPolicy` 载荷（全量字段）。
		*
		* 全量写入是刻意的：host schema 对每个字段有独立缺省，但**部分写入**会让
		* 未写的字段取 host 缺省（而不是保留用户此前的值）。这里总是带上全部字段，
		* 让"改一项"不会意外重置其他项。
		*/
		function buildRetryPolicyPayload(draft) {
			return {
				mode: draft.mode === "always" ? "always" : "normal",
				maxRetries: Math.round(clampNumber(draft.maxRetries, 24, 0, 1e6)),
				backoff: {
					initialDelayMs: Math.round(clampNumber(draft.initialDelayMs, 500, 1, MAX_TIMER_DELAY_MS)),
					maxDelayMs: Math.max(Math.round(clampNumber(draft.maxDelayMs, RETRY_MAX_DELAY_FLOOR_MS, 1, MAX_TIMER_DELAY_MS)), RETRY_MAX_DELAY_FLOOR_MS),
					jitterRatio: clampNumber(draft.jitterRatio, .1, 0, 1)
				}
			};
		}
		/** 缺省草稿：与 host 侧 `DEFAULT_KEY_POOL_PARAMS` 数值一致。 */
		const DEFAULT_POOL_DRAFT = {
			kickThreshold: "2",
			probeInitialMs: "15000",
			probeBackoffFactor: "2",
			probeMaxMs: "60000",
			capacity: "10"
		};
		/** 从设置快照的 `poolPolicy` 读出草稿；缺失或非法时回退缺省。 */
		function normalizePoolPolicyDraft(raw) {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_POOL_DRAFT;
			const record = raw;
			return {
				kickThreshold: numberText(record.kickThreshold, DEFAULT_POOL_DRAFT.kickThreshold),
				probeInitialMs: numberText(record.probeInitialMs, DEFAULT_POOL_DRAFT.probeInitialMs),
				probeBackoffFactor: numberText(record.probeBackoffFactor, DEFAULT_POOL_DRAFT.probeBackoffFactor),
				probeMaxMs: numberText(record.probeMaxMs, DEFAULT_POOL_DRAFT.probeMaxMs),
				capacity: numberText(record.capacity, DEFAULT_POOL_DRAFT.capacity)
			};
		}
		/**
		* 把页面草稿组装成 host schema 接受的 `poolPolicy` 载荷（**全量字段**）。
		*
		* 与 `buildRetryPolicyPayload` 同一理由：全量写入是刻意的，部分写入会让未写的字段取
		* host 缺省（而不是保留用户此前的值），"改一项"就会意外重置其他项。
		*/
		function buildPoolPolicyPayload(draft) {
			const probeInitialMs = Math.round(clampNumber(draft.probeInitialMs, 15e3, 5e3, 3e5));
			return {
				kickThreshold: Math.round(clampNumber(draft.kickThreshold, 2, 1, 10)),
				probeInitialMs,
				probeBackoffFactor: clampNumber(draft.probeBackoffFactor, 2, 1, 10),
				probeMaxMs: Math.max(Math.round(clampNumber(draft.probeMaxMs, 6e4, 5e3, 6e5)), probeInitialMs),
				capacity: Math.round(clampNumber(draft.capacity, 10, 1, 10))
			};
		}
		/** 创建一个小型可观察快照 store（参考实现的 createSnapshotStore 精简版）。 */
		function createSnapshotStore(initial) {
			let snapshot = initial;
			const listeners = /* @__PURE__ */ new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set(value) {
					if (Object.is(value, snapshot)) return;
					snapshot = value;
					for (const listener of [...listeners]) try {
						listener();
					} catch (error) {
						console.error("[dsh-sensenova-freeapi] snapshot subscriber failed:", error);
					}
				}
			};
		}
		/** 与宿主 credentials 的 canonical credential-ref 规则一致（POSIX shell 标识符）。 */
		const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
		function canonicalCredentialRef(value) {
			if (typeof value !== "string") return void 0;
			const trimmed = value.trim();
			return trimmed !== "" && CREDENTIAL_REF_PATTERN.test(trimmed) ? trimmed : void 0;
		}
		/** 从 section 值中读取凭据引用；未配置时回退默认，非法值则视为无凭据。 */
		function credentialRefOf(apiKeyEnv) {
			if (apiKeyEnv === void 0) return DEFAULT_API_KEY_ENV;
			return canonicalCredentialRef(apiKeyEnv);
		}
		/** 从 section 值中读取 apiBase（空则回退默认）。 */
		function apiBaseOf(apiBase) {
			return typeof apiBase === "string" && apiBase.length > 0 ? apiBase : DEFAULT_API_BASE;
		}
		/** 从 section 值中解析 stored accounts（过滤非法条目）。 */
		function storedAccountsOf(raw) {
			if (!Array.isArray(raw)) return [];
			const out = [];
			for (const entry of raw) {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
				const record = entry;
				const id = record.id;
				const label = record.label;
				const apiKeyEnv = canonicalCredentialRef(record.apiKeyEnv);
				if (apiKeyEnv === void 0) continue;
				out.push({
					id: typeof id === "string" && id.trim() !== "" ? id.trim() : apiKeyEnv,
					label: typeof label === "string" && label.trim() !== "" ? label.trim() : apiKeyEnv,
					apiKeyEnv
				});
			}
			return out;
		}
		var SenseNovaSettingsController = class {
			scope;
			credentials;
			stagedApiBase;
			stagedApiKeyEnv;
			stagedActiveAccount;
			stagedConcurrency;
			/** 排队超时的 staged 编辑（字符串草稿，保存时归一化为毫秒数）。 */
			stagedQueueTimeoutMs;
			stagedQuotaRotation;
			/** 限流事件记录器开关的 staged 编辑。 */
			stagedErrorLog;
			/**
			* 错误记录诊断区块的状态。**独立于配置流程**：不参与 `dirty`、没有 staged ——
			* 它是一次性拉取的运行数据（只读）。放进同一个 controller 只为复用已有的快照
			* 订阅与 publish 链路，免得为一个区块另建一套 store。
			*/
			diagnostics = { ...IDLE_ERROR_LOG_STATE };
			modelInfoState = { ...IDLE_MODEL_INFO_STATE };
			/** 重试策略的 staged 编辑（只存被改动的键，保存时与快照值合并成全量载荷）。 */
			stagedRetry;
			/** key 池策略的未保存编辑（与 `stagedRetry` 同一机制）。 */
			stagedPool;
			defaultKeyDraft = "";
			defaultClearStaged = false;
			addedAccounts = [];
			removedIds = /* @__PURE__ */ new Set();
			labelDrafts = /* @__PURE__ */ new Map();
			keyDrafts = /* @__PURE__ */ new Map();
			keyClears = /* @__PURE__ */ new Set();
			credentialStates = /* @__PURE__ */ new Map();
			/** 上一次成功 describeAll 查询过的 refs 集合键（去重排序拼接）；用于检测快照替换引入的新 ref。 */
			describedRefsKey = "";
			saving = false;
			failed = false;
			savedCount = 0;
			listeners = /* @__PURE__ */ new Set();
			disposers = [];
			disposed = false;
			constructor(scope, credentials) {
				this.scope = scope;
				this.credentials = credentials;
				this.disposers.push(scope.subscribe(() => {
					this.publish();
					this.describeIfRefsChanged();
				}));
				this.describeAll();
			}
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				for (const dispose of this.disposers) dispose();
				this.disposers.length = 0;
				this.listeners.clear();
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			/** 默认账户的凭据引用：优先 staged 草稿，其次 section 值，最后回退默认。 */
			credentialRef() {
				return credentialRefOf(this.stagedApiKeyEnv ?? this.sectionValue("apiKeyEnv"));
			}
			storedAccounts() {
				return storedAccountsOf(this.sectionValue("accounts"));
			}
			/** 当前 section 值（快照未就绪时 undefined）。 */
			sectionValue(field) {
				return this.scope.getSnapshot().value?.[field];
			}
			/** 页面状态面。 */
			state() {
				const snapshot = this.scope.getSnapshot();
				const ref = this.credentialRef();
				const defaultView = ref === void 0 ? void 0 : this.credentialStates.get(ref);
				const accounts = this.effectiveAccounts();
				const apiBase = apiBaseOf(this.sectionValue("apiBase"));
				const apiKeyEnv = credentialRefOf(this.sectionValue("apiKeyEnv")) ?? "";
				const activeAccount = typeof this.sectionValue("activeAccount") === "string" ? this.sectionValue("activeAccount") : "";
				const concurrency = normalizeConcurrency(this.sectionValue("concurrency"));
				const queueTimeoutMs = normalizeQueueTimeoutMs(this.sectionValue("queueTimeoutMs"));
				const quotaRotation = normalizeQuotaRotation(this.sectionValue("quotaRotation"));
				const errorLog = normalizeErrorLog(this.sectionValue("errorLog"));
				const retryPolicy = normalizeRetryPolicyDraft(this.sectionValue("retryPolicy"));
				const poolPolicy = normalizePoolPolicyDraft(this.sectionValue("poolPolicy"));
				const effectiveActiveAccountId = this.effectiveActiveAccountId(activeAccount, defaultView?.configured ?? false);
				const effectiveActiveAccountLabel = this.effectiveActiveAccountLabel(effectiveActiveAccountId, accounts);
				const configuredCount = (defaultView?.configured ? 1 : 0) + accounts.filter((a) => a.configured).length;
				const totalCount = 1 + accounts.filter((a) => !a.added).length;
				const dirty = this.stagedApiBase !== void 0 || this.stagedApiKeyEnv !== void 0 || this.stagedActiveAccount !== void 0 || this.stagedConcurrency !== void 0 || this.stagedQueueTimeoutMs !== void 0 || this.stagedQuotaRotation !== void 0 || this.stagedErrorLog !== void 0 || this.stagedRetry !== void 0 || this.stagedPool !== void 0 || this.defaultKeyDraft !== "" || this.defaultClearStaged || this.addedAccounts.length > 0 || this.removedIds.size > 0 || this.labelDrafts.size > 0 || this.keyDrafts.size > 0 || this.keyClears.size > 0;
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					route: SENSENOVA_ROUTE,
					displayName: SENSENOVA_DISPLAY_NAME,
					apiBase,
					apiBaseDraft: this.stagedApiBase ?? apiBase,
					apiKeyEnv,
					apiKeyEnvDraft: this.stagedApiKeyEnv ?? apiKeyEnv,
					defaultConfigured: defaultView?.configured ?? false,
					defaultWritable: defaultView?.writable ?? true,
					defaultKeyDraft: this.defaultKeyDraft,
					defaultClearStaged: this.defaultClearStaged,
					accounts,
					activeAccount,
					activeAccountDraft: this.stagedActiveAccount ?? activeAccount,
					effectiveActiveAccountId,
					effectiveActiveAccountLabel,
					configuredCount,
					totalCount,
					concurrency,
					concurrencyDraft: this.stagedConcurrency ?? String(concurrency),
					queueTimeoutMs,
					queueTimeoutMsDraft: this.stagedQueueTimeoutMs ?? String(queueTimeoutMs),
					quotaRotation,
					quotaRotationDraft: this.stagedQuotaRotation ?? quotaRotation,
					errorLog,
					errorLogDraft: this.stagedErrorLog ?? errorLog,
					diagnostics: this.diagnostics,
					modelInfo: this.modelInfoState,
					retryPolicy,
					retryPolicyDraft: {
						...retryPolicy,
						...this.stagedRetry
					},
					poolPolicy,
					poolPolicyDraft: {
						...poolPolicy,
						...this.stagedPool
					},
					dirty,
					saving: this.saving,
					failed: this.failed,
					savedCount: this.savedCount
				};
			}
			/**
			* 计算当前实际生效账户 id：
			* - 显式钉选（activeAccount 非空且指向已保存账户）→ 该 id；
			* - 自动模式 → 默认账户已配置取 'default'，否则第一个已配置账户行 id，均无则 ''。
			* UI 据此展示「活动/当前」标记（运行时 401 禁用后的顺延以实际可用账号为准）。
			*/
			effectiveActiveAccountId(activeAccount, defaultConfigured) {
				if (activeAccount !== "") {
					const pinned = this.effectiveAccounts().find((a) => a.id === activeAccount);
					if (pinned !== void 0 && pinned.configured) return pinned.id;
				}
				if (defaultConfigured) return "default";
				const firstConfigured = this.effectiveAccounts().find((a) => a.configured);
				return firstConfigured !== void 0 ? firstConfigured.id : "";
			}
			/**
			* 当前实际生效账户的可读标签：'default' → 「默认账户」，
			* 其余取账户行 labelDraft（空则回退「账户 N」），无生效则 ''。
			* 用于自动模式下下拉选项与总览条展示「当前: xxx」。
			*/
			effectiveActiveAccountLabel(id, accounts) {
				if (id === "") return "";
				if (id === "default") return "默认账户";
				const account = accounts.find((a) => a.id === id);
				if (account === void 0) return id;
				const label = account.labelDraft.trim();
				return label !== "" ? label : `账户 ${accounts.indexOf(account) + 1}`;
			}
			/** 合并 stored（减 staged 删除）与 staged 新增，得到展示用账户行。 */
			effectiveAccounts() {
				const stored = this.storedAccounts().filter((a) => !this.removedIds.has(a.id)).map((a) => ({
					...a,
					added: false
				}));
				const added = this.addedAccounts.map((a) => ({
					...a,
					added: true
				}));
				return [...stored, ...added].map((a) => {
					const view = this.credentialStates.get(a.apiKeyEnv);
					return {
						id: a.id,
						ref: a.apiKeyEnv,
						label: a.label,
						labelDraft: this.labelDrafts.get(a.id) ?? a.label,
						keyDraft: this.keyDrafts.get(a.id) ?? "",
						configured: view?.configured ?? false,
						writable: view?.writable ?? true,
						added: a.added,
						clearStaged: this.keyClears.has(a.id)
					};
				});
			}
			edit(field, text) {
				if (field === "apiBase") this.stagedApiBase = text;
				else if (field === "apiKeyEnv") this.stagedApiKeyEnv = text;
				else if (field === "activeAccount") this.stagedActiveAccount = text;
				else if (field === "concurrency") this.stagedConcurrency = text;
				else if (field === "queueTimeoutMs") this.stagedQueueTimeoutMs = text;
				this.failed = false;
				this.publish();
			}
			editDefaultKey(text) {
				this.defaultKeyDraft = text;
				this.defaultClearStaged = false;
				this.failed = false;
				this.publish();
			}
			toggleDefaultKeyClear() {
				this.defaultClearStaged = !this.defaultClearStaged;
				if (this.defaultClearStaged) this.defaultKeyDraft = "";
				this.failed = false;
				this.publish();
			}
			addAccount() {
				const usedRefs = new Set([
					...this.credentialRef() !== void 0 ? [this.credentialRef()] : [],
					...this.storedAccounts().map((a) => a.apiKeyEnv),
					...this.addedAccounts.map((a) => a.apiKeyEnv)
				]);
				let n = 2;
				while (usedRefs.has(`${DEFAULT_API_KEY_ENV}_${n}`)) n += 1;
				const apiKeyEnv = `${DEFAULT_API_KEY_ENV}_${n}`;
				const usedIds = new Set([...this.storedAccounts().map((a) => a.id), ...this.addedAccounts.map((a) => a.id)]);
				let k = this.storedAccounts().length + this.addedAccounts.length + 2;
				let id = `account-${k}`;
				while (usedIds.has(id)) {
					k += 1;
					id = `account-${k}`;
				}
				this.addedAccounts.push({
					id,
					label: `账户 ${k}`,
					apiKeyEnv
				});
				this.failed = false;
				this.describeAll();
				this.publish();
			}
			removeAccount(id) {
				const addedIndex = this.addedAccounts.findIndex((a) => a.id === id);
				if (addedIndex >= 0) this.addedAccounts.splice(addedIndex, 1);
				else this.removedIds.add(id);
				this.labelDrafts.delete(id);
				this.keyDrafts.delete(id);
				this.keyClears.delete(id);
				const currentActive = this.sectionValue("activeAccount");
				if (this.stagedActiveAccount === id || this.stagedActiveAccount === void 0 && currentActive === id) this.stagedActiveAccount = "";
				this.failed = false;
				this.publish();
			}
			editAccountLabel(id, text) {
				this.labelDrafts.set(id, text);
				this.failed = false;
				this.publish();
			}
			editAccountKey(id, text) {
				this.keyDrafts.set(id, text);
				this.keyClears.delete(id);
				this.failed = false;
				this.publish();
			}
			toggleAccountKeyClear(id) {
				if (this.keyClears.has(id)) this.keyClears.delete(id);
				else {
					this.keyDrafts.delete(id);
					this.keyClears.add(id);
				}
				this.failed = false;
				this.publish();
			}
			/** activeAccount 单选：'' 表示自动（默认账户优先）。 */
			setActiveAccount(id) {
				this.stagedActiveAccount = id;
				this.failed = false;
				this.publish();
			}
			/** 配额类 429 换 key 开关（staged，保存后经 settings 命名空间持久化并热生效）。 */
			setQuotaRotation(on) {
				this.stagedQuotaRotation = on;
				this.failed = false;
				this.publish();
			}
			/**
			* 限流事件记录器开关（staged）。
			*
			* host 侧该配置**故意做成 thunk**（`deps.errorLog: () => SenseNovaErrorLog | undefined`），
			* 因此保存后立刻生效、无需重注册适配器；关掉即静默，不影响请求路径。
			*/
			setErrorLog(on) {
				this.stagedErrorLog = on;
				this.failed = false;
				this.publish();
			}
			/**
			* 拉取错误记录（只读，2026-09-18）。
			*
			* 走 HTTP 路由而不是 settings 通道：诊断数据不是配置 —— 塞进 settings 会污染
			* `settings.yaml`，且每次刷新都产生 revision 变化、误触 `onChange`。同源请求
			* 自带 cookie 鉴权，所以这里无需处理凭据。**不自动调用**（保持 idle，避免打开
			* 设置页就产生 I/O），由用户点「刷新」触发。
			*/
			async refreshErrorLog() {
				if (this.diagnostics.status === "loading") return;
				this.diagnostics = {
					...this.diagnostics,
					status: "loading"
				};
				this.publish();
				try {
					const response = await fetch(`${ERROR_LOG_ROUTE}?limit=20`, { credentials: "same-origin" });
					if (!response.ok) throw new Error(`llm-sensenova: error log HTTP ${response.status}`);
					this.diagnostics = normalizeErrorLogState(await response.json(), this.diagnostics.expandedRow);
				} catch {
					this.diagnostics = {
						...IDLE_ERROR_LOG_STATE,
						status: "error"
					};
				}
				this.publish();
			}
			/** 展开/收起一条错误记录（再点同一条即收起，一次只开一条）。 */
			toggleErrorLogRow(index) {
				if (!Number.isInteger(index) || index < 0 || index >= this.diagnostics.entries.length) return;
				this.diagnostics = {
					...this.diagnostics,
					expandedRow: this.diagnostics.expandedRow === index ? null : index
				};
				this.publish();
			}
			/**
			* 拉取「当前模型 + 全部参数」快照（只读，2026-09-23 Phase 5）。
			*
			* 与 `refreshErrorLog()` 完全同一约定：不自动调用（打开设置页不产生 I/O）、
			* 走 HTTP 路由而非 settings 通道、异常一律降级为 error 态**绝不抛**。
			*/
			async refreshModelInfo() {
				if (this.modelInfoState.status === "loading") return;
				this.modelInfoState = { status: "loading" };
				this.publish();
				try {
					const response = await fetch(MODEL_INFO_ROUTE, { credentials: "same-origin" });
					if (!response.ok) throw new Error(`llm-sensenova: model info HTTP ${response.status}`);
					this.modelInfoState = normalizeModelInfoState(await response.json());
				} catch {
					this.modelInfoState = { status: "error" };
				}
				this.publish();
			}
			/** 重试策略：模式单选（staged）。 */
			setRetryMode(mode) {
				this.stagedRetry = {
					...this.stagedRetry,
					mode
				};
				this.failed = false;
				this.publish();
			}
			/** 重试策略：数字字段编辑（staged，保存时才归一化为数字）。 */
			editRetry(field, text) {
				this.stagedRetry = {
					...this.stagedRetry,
					[field]: text
				};
				this.failed = false;
				this.publish();
			}
			/** key 池策略：数字字段编辑（staged，与 `editRetry` 同一机制）。 */
			editPool(field, text) {
				this.stagedPool = {
					...this.stagedPool,
					[field]: text
				};
				this.failed = false;
				this.publish();
			}
			/** 丢弃所有 staged 编辑。 */
			discard() {
				this.stagedApiBase = void 0;
				this.stagedApiKeyEnv = void 0;
				this.stagedActiveAccount = void 0;
				this.stagedConcurrency = void 0;
				this.stagedQueueTimeoutMs = void 0;
				this.stagedQuotaRotation = void 0;
				this.stagedErrorLog = void 0;
				this.stagedRetry = void 0;
				this.stagedPool = void 0;
				this.defaultKeyDraft = "";
				this.defaultClearStaged = false;
				this.addedAccounts = [];
				this.removedIds.clear();
				this.labelDrafts.clear();
				this.keyDrafts.clear();
				this.keyClears.clear();
				this.failed = false;
				this.publish();
			}
			/** 凭据域状态重读（外部写入 key 后刷新已配置/可写徽标）。 */
			async refreshCredentials() {
				await this.describeAll();
			}
			/** 当前页面涉及的 credential-ref 集合键（默认 ref + stored/added 账户 ref）。 */
			currentRefsKey() {
				const ref = this.credentialRef();
				return [...new Set([
					...ref !== void 0 ? [ref] : [],
					...this.storedAccounts().map((a) => a.apiKeyEnv),
					...this.addedAccounts.map((a) => a.apiKeyEnv)
				])].sort().join(",");
			}
			/** refs 集合与上次成功查询不同则重查；查询失败保留旧键，下次快照变更自然重试。 */
			describeIfRefsChanged() {
				if (this.currentRefsKey() === this.describedRefsKey) return;
				this.describeAll();
			}
			/** 查询所有本页涉及的凭据引用的配置状态。 */
			async describeAll() {
				const refs = [
					...this.credentialRef() !== void 0 ? [this.credentialRef()] : [],
					...this.storedAccounts().map((a) => a.apiKeyEnv),
					...this.addedAccounts.map((a) => a.apiKeyEnv)
				];
				if (refs.length === 0) {
					this.describedRefsKey = "";
					return;
				}
				let response;
				try {
					response = await this.credentials.describe(refs);
				} catch {
					return;
				}
				if (!response.ok) return;
				this.describedRefsKey = this.currentRefsKey();
				let changed = false;
				for (const ref of refs) {
					const view = response.value?.[ref];
					const next = {
						configured: view?.configured ?? false,
						writable: view?.writable ?? true
					};
					const prev = this.credentialStates.get(ref);
					if (prev === void 0 || prev.configured !== next.configured || prev.writable !== next.writable) {
						this.credentialStates.set(ref, next);
						changed = true;
					}
				}
				if (changed) this.publish();
			}
			/** 写入某个凭据引用，然后重读配置状态。 */
			async writeKeyTo(ref, value) {
				const canonicalRef = canonicalCredentialRef(ref);
				if (canonicalRef === void 0) return false;
				try {
					if (!(await this.credentials.set(canonicalRef, value)).ok) return false;
				} catch {
					return false;
				}
				await this.describeAll();
				return this.credentialStates.get(canonicalRef)?.configured ?? false;
			}
			async unsetKey(ref) {
				const canonicalRef = canonicalCredentialRef(ref);
				if (canonicalRef === void 0) return false;
				try {
					if (!(await this.credentials.unset(canonicalRef)).ok) return false;
				} catch {
					return false;
				}
				await this.describeAll();
				return this.credentialStates.get(canonicalRef)?.configured !== true;
			}
			/** 持久化 accounts 列表。 */
			async writeAccounts() {
				const base = [...this.storedAccounts().filter((a) => !this.removedIds.has(a.id)), ...this.addedAccounts];
				const seen = /* @__PURE__ */ new Set();
				const list = [];
				for (const a of base) {
					if (seen.has(a.id)) continue;
					seen.add(a.id);
					const label = this.labelDrafts.get(a.id)?.trim();
					list.push({
						id: a.id,
						label: label !== void 0 && label !== "" ? label : a.label,
						apiKeyEnv: a.apiKeyEnv
					});
				}
				await this.scope.set("accounts", list);
				return true;
			}
			/** 保存所有 staged 编辑。 */
			async save() {
				if (this.saving) return;
				if (!this.state().dirty) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				let landed = true;
				try {
					const defaultRef = this.credentialRef();
					if (this.defaultClearStaged) {
						if (defaultRef === void 0 || !await this.unsetKey(defaultRef)) landed = false;
					} else if (this.defaultKeyDraft.trim() !== "") {
						if (defaultRef === void 0 || !await this.writeKeyTo(defaultRef, this.defaultKeyDraft.trim())) landed = false;
					}
					for (const id of this.keyClears) {
						const account = this.effectiveAccounts().find((a) => a.id === id);
						if (account !== void 0 && !await this.unsetKey(account.ref)) landed = false;
					}
					for (const [id, text] of this.keyDrafts) {
						const value = text.trim();
						if (value === "" || this.keyClears.has(id)) continue;
						const account = this.effectiveAccounts().find((a) => a.id === id);
						if (account !== void 0 && !await this.writeKeyTo(account.ref, value)) landed = false;
					}
					if (this.stagedApiBase !== void 0) {
						const value = this.stagedApiBase.trim();
						if (value === "") await this.scope.unset("apiBase");
						else await this.scope.set("apiBase", value);
					}
					if (this.stagedApiKeyEnv !== void 0) {
						const canonicalRef = canonicalCredentialRef(this.stagedApiKeyEnv);
						if (this.stagedApiKeyEnv.trim() === "") await this.scope.unset("apiKeyEnv");
						else if (canonicalRef === void 0) landed = false;
						else await this.scope.set("apiKeyEnv", canonicalRef);
					}
					if (this.stagedActiveAccount !== void 0) if (this.stagedActiveAccount === "") await this.scope.unset("activeAccount");
					else await this.scope.set("activeAccount", this.stagedActiveAccount);
					if (this.stagedConcurrency !== void 0) {
						const value = normalizeConcurrency(this.stagedConcurrency);
						await this.scope.set("concurrency", value);
					}
					if (this.stagedQueueTimeoutMs !== void 0) await this.scope.set("queueTimeoutMs", normalizeQueueTimeoutMs(this.stagedQueueTimeoutMs));
					if (this.stagedQuotaRotation !== void 0) await this.scope.set("quotaRotation", this.stagedQuotaRotation);
					if (this.stagedErrorLog !== void 0) await this.scope.set("errorLog", this.stagedErrorLog);
					if (this.stagedRetry !== void 0) {
						const merged = {
							...normalizeRetryPolicyDraft(this.sectionValue("retryPolicy")),
							...this.stagedRetry
						};
						await this.scope.set("retryPolicy", buildRetryPolicyPayload(merged));
					}
					if (this.stagedPool !== void 0) {
						const mergedPool = {
							...normalizePoolPolicyDraft(this.sectionValue("poolPolicy")),
							...this.stagedPool
						};
						await this.scope.set("poolPolicy", buildPoolPolicyPayload(mergedPool));
					}
					if (this.addedAccounts.length > 0 || this.removedIds.size > 0 || this.labelDrafts.size > 0) await this.writeAccounts();
				} catch {
					landed = false;
				}
				this.saving = false;
				this.failed = !landed;
				if (landed) {
					this.savedCount += 1;
					this.discard();
				}
				this.publish();
			}
			publish() {
				if (this.disposed) return;
				for (const listener of [...this.listeners]) try {
					listener();
				} catch (error) {
					console.error("[dsh-sensenova-freeapi] state subscriber failed:", error);
				}
			}
		};
		//#endregion
		//#region src/client/section.tsx
		/**
		* SenseNova 设置页 React 组件（settings.section slot 内容）。
		* 所有文案经 `t`（settings.sensenova 命名空间）读取，不硬编码。
		*/
		const { useEffect, useRef } = react;
		function useSavedFlash(savedCount) {
			const [visible, setVisible] = (0, react.useState)(false);
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
		function StatusBadge({ configured, t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: configured ? "sn-badge" : "sn-badgeMuted",
				children: configured ? t("apiKeySet") : t("apiKeyUnset")
			});
		}
		function addCredentialReference(refs, value) {
			const normalized = value.trim();
			if (normalized !== "") refs.add(normalized);
		}
		function credentialReferences(state) {
			const refs = /* @__PURE__ */ new Set();
			addCredentialReference(refs, state.apiKeyEnv);
			for (const account of state.accounts) addCredentialReference(refs, account.ref);
			return refs;
		}
		function isCredentialReference(label, refs) {
			const value = label.trim();
			if (value === "") return false;
			for (const ref of refs) if (value.includes(ref)) return true;
			return false;
		}
		function accountDisplayLabel(account, index, t, refs) {
			const label = account.labelDraft.trim();
			return label !== "" && !isCredentialReference(label, refs) ? label : t("accountFallback", { index: index + 1 });
		}
		/** 分组标题：引导后续卡片的分区归属。 */
		function SectionHeading(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
				className: "sn-groupTitle",
				children: props.text
			});
		}
		function AdvancedSettings(props) {
			const [expanded, setExpanded] = (0, react.useState)(false);
			const retry = props.state.retryPolicyDraft;
			const pool = props.state.poolPolicyDraft;
			const customizedCount = (props.state.apiBase !== "https://token.sensenova.cn/v1" ? 1 : 0) + (props.state.concurrency !== 1 ? 1 : 0) + (props.state.queueTimeoutMs !== 6e4 ? 1 : 0) + (props.state.quotaRotation !== false ? 1 : 0) + (props.state.errorLog !== true ? 1 : 0) + (retry.mode !== DEFAULT_RETRY_DRAFT.mode ? 1 : 0) + (retry.maxRetries !== DEFAULT_RETRY_DRAFT.maxRetries ? 1 : 0) + (retry.maxDelayMs !== DEFAULT_RETRY_DRAFT.maxDelayMs ? 1 : 0) + (retry.initialDelayMs !== DEFAULT_RETRY_DRAFT.initialDelayMs ? 1 : 0) + (retry.jitterRatio !== DEFAULT_RETRY_DRAFT.jitterRatio ? 1 : 0) + (pool.kickThreshold !== DEFAULT_POOL_DRAFT.kickThreshold ? 1 : 0) + (pool.probeInitialMs !== DEFAULT_POOL_DRAFT.probeInitialMs ? 1 : 0) + (pool.probeBackoffFactor !== DEFAULT_POOL_DRAFT.probeBackoffFactor ? 1 : 0) + (pool.probeMaxMs !== DEFAULT_POOL_DRAFT.probeMaxMs ? 1 : 0) + (pool.capacity !== DEFAULT_POOL_DRAFT.capacity ? 1 : 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-card sn-advanced",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "sn-advancedHeader",
					"aria-expanded": expanded,
					"aria-controls": "sn-advanced-settings",
					onClick: () => setExpanded((value) => !value),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "sn-label",
						children: props.t("advancedSettings")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "sn-advancedMeta",
						children: [customizedCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "sn-badgeMuted",
							"aria-label": props.t("advancedCustomizedCount", { count: customizedCount }),
							children: customizedCount
						}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: `sn-advancedChevron${expanded ? " sn-advancedChevronExpanded" : ""}`,
							"aria-hidden": "true"
						})]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					id: "sn-advanced-settings",
					className: "sn-advancedBody",
					hidden: !expanded,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "sn-label",
									htmlFor: "sn-api-base",
									children: props.t("apiBase")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: "sn-api-base",
									className: "sn-input",
									type: "text",
									value: props.state.apiBaseDraft,
									disabled: props.disabled,
									spellCheck: false,
									onChange: (event) => props.edit("apiBase", event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "sn-hint",
									children: props.t("apiBaseHint")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-models",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sn-field",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
											className: "sn-label",
											htmlFor: "sn-concurrency",
											children: props.t("concurrency")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											id: "sn-concurrency",
											className: "sn-input",
											type: "number",
											min: 1,
											step: 1,
											value: props.state.concurrencyDraft,
											disabled: props.disabled,
											spellCheck: false,
											onChange: (event) => props.edit("concurrency", event.target.value)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "sn-hint",
											children: props.t("concurrencyHint")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sn-field",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
											className: "sn-label",
											htmlFor: "sn-queue-timeout",
											children: props.t("queueTimeoutMs")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											id: "sn-queue-timeout",
											className: "sn-input",
											type: "number",
											min: QUEUE_TIMEOUT_MIN_MS,
											step: 1e3,
											value: props.state.queueTimeoutMsDraft,
											disabled: props.disabled,
											spellCheck: false,
											onChange: (event) => props.edit("queueTimeoutMs", event.target.value)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											className: "sn-hint",
											children: props.t("queueTimeoutMsHint")
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "sn-hint sn-modelsNote",
									children: props.t("modelsAutoManaged")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "sn-fieldHead",
								htmlFor: "sn-quota-rotation",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-label",
									children: props.t("quotaRotation")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: "sn-quota-rotation",
									className: "sn-toggle",
									type: "checkbox",
									checked: props.state.quotaRotationDraft,
									disabled: props.disabled,
									onChange: (event) => props.setQuotaRotation(event.target.checked)
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint",
								children: props.t("quotaRotationHint")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "sn-fieldHead",
								htmlFor: "sn-error-log",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-label",
									children: props.t("errorLog")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									id: "sn-error-log",
									className: "sn-toggle",
									type: "checkbox",
									checked: props.state.errorLogDraft,
									disabled: props.disabled,
									onChange: (event) => props.setErrorLog(event.target.checked)
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint",
								children: props.t("errorLogHint")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "sn-fieldHead",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-label",
									children: props.t("retryTitle")
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint",
								children: props.t("retryIntro")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "sn-label",
									htmlFor: "sn-retry-mode",
									children: props.t("retryMode")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									id: "sn-retry-mode",
									className: "sn-input",
									value: retry.mode,
									disabled: props.disabled,
									onChange: (event) => props.setRetryMode(event.target.value === "always" ? "always" : "normal"),
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "normal",
										children: props.t("retryModeNormal")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "always",
										children: props.t("retryModeAlways")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "sn-hint",
									children: retry.mode === "always" ? props.t("retryModeHintAlways") : props.t("retryModeHintNormal")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-models",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-retry-max-retries",
										children: props.t("retryMaxRetries")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-retry-max-retries",
										className: "sn-input",
										type: "number",
										min: 0,
										step: 1,
										value: retry.maxRetries,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.editRetry("maxRetries", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("retryMaxRetriesHint")
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-retry-max-delay",
										children: props.t("retryMaxDelayMs")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-retry-max-delay",
										className: "sn-input",
										type: "number",
										min: RETRY_MAX_DELAY_FLOOR_MS,
										step: 1e3,
										value: retry.maxDelayMs,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.editRetry("maxDelayMs", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("retryMaxDelayMsHint")
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-models",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-retry-initial-delay",
										children: props.t("retryInitialDelayMs")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-retry-initial-delay",
										className: "sn-input",
										type: "number",
										min: 1,
										step: 100,
										value: retry.initialDelayMs,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.editRetry("initialDelayMs", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("retryInitialDelayMsHint")
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-retry-jitter",
										children: props.t("retryJitterRatio")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-retry-jitter",
										className: "sn-input",
										type: "number",
										min: 0,
										max: 1,
										step: .05,
										value: retry.jitterRatio,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.editRetry("jitterRatio", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("retryJitterRatioHint")
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "sn-fieldHead",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-label",
									children: props.t("poolTitle")
								})
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint",
								children: props.t("poolIntro")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-models",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-pool-kick",
										children: props.t("poolKickThreshold")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-pool-kick",
										className: "sn-input",
										type: "number",
										min: 1,
										max: 10,
										step: 1,
										value: pool.kickThreshold,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.editPool("kickThreshold", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("poolKickThresholdHint")
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-pool-capacity",
										children: props.t("poolCapacity")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-pool-capacity",
										className: "sn-input",
										type: "number",
										min: 1,
										max: 10,
										step: 1,
										value: pool.capacity,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.editPool("capacity", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("poolCapacityHint")
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-models",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-pool-probe-initial",
										children: props.t("poolProbeInitialMs")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-pool-probe-initial",
										className: "sn-input",
										type: "number",
										min: 5e3,
										max: 3e5,
										step: 1e3,
										value: pool.probeInitialMs,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.editPool("probeInitialMs", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("poolProbeInitialMsHint")
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-pool-probe-factor",
										children: props.t("poolProbeBackoffFactor")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-pool-probe-factor",
										className: "sn-input",
										type: "number",
										min: 1,
										max: 10,
										step: .5,
										value: pool.probeBackoffFactor,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.editPool("probeBackoffFactor", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("poolProbeBackoffFactorHint")
									})
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "sn-models",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "sn-label",
										htmlFor: "sn-pool-probe-max",
										children: props.t("poolProbeMaxMs")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "sn-pool-probe-max",
										className: "sn-input",
										type: "number",
										min: 5e3,
										max: 6e5,
										step: 1e3,
										value: pool.probeMaxMs,
										disabled: props.disabled,
										spellCheck: false,
										onChange: (event) => props.editPool("probeMaxMs", event.target.value)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "sn-hint",
										children: props.t("poolProbeMaxMsHint")
									})
								]
							})
						})
					]
				})]
			});
		}
		/** 把 ISO 时间戳渲染成 `HH:MM:SS`；解析失败时退化为原串的时分秒片段。 */
		function formatClock(ts) {
			const parsed = Date.parse(ts);
			if (!Number.isFinite(parsed)) return ts.length >= 19 ? ts.slice(11, 19) : ts;
			const date = new Date(parsed);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}
		/**
		* 错误记录诊断区块（只读，2026-09-18）。
		*
		* 刻意**不自动拉取**：打开设置页本身不该产生 I/O，而多数人进来是为了改配置。
		* 用户点「刷新」才请求一次，之后可反复点。
		*/
		function ErrorLogPanel(props) {
			const log = props.state;
			const busy = log.status === "loading";
			let body;
			if (log.status === "idle") body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "sn-hint",
				children: props.t("diagnosticsIdle")
			});
			else if (log.status === "error") body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "sn-hint sn-diagnosticsWarn",
				children: props.t("diagnosticsUnavailable")
			});
			else if (!log.available || log.entries.length === 0) body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "sn-hint",
				children: props.t("diagnosticsEmpty")
			});
			else body = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-diagnosticsBody",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-diagnosticsStats",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-diagnosticsStat",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-hint",
									children: props.t("diagnosticsStatTotal")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-diagnosticsValue",
									children: log.total
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-diagnosticsStat",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-hint",
									children: props.t("diagnosticsStatCodes")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-diagnosticsValue",
									children: log.distinctCodes
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-diagnosticsStat",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-hint",
									children: props.t("diagnosticsStatModels")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-diagnosticsValue",
									children: log.distinctModels
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-diagnosticsList",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-diagnosticsRow",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("diagnosticsColumnTime") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("diagnosticsColumnType") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-truncate",
									children: props.t("diagnosticsColumnModel")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-truncate",
									children: props.t("diagnosticsColumnAccount")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-truncate",
									children: props.t("diagnosticsColumnApi")
								})
							]
						}), log.entries.map((entry, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: "sn-diagnosticsRow sn-diagnosticsRowButton",
							"aria-expanded": log.expandedRow === index,
							onClick: () => props.onToggleRow(index),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-mono",
									children: formatClock(entry.ts)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-diagnosticsCode",
									"data-kind": entry.kind,
									children: entry.code !== "" ? entry.code : "—"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-mono sn-truncate",
									title: entry.model,
									children: entry.model !== "" ? entry.model : "—"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-truncate",
									title: entry.accountLabel !== void 0 && entry.accountLabel !== "" ? entry.accountLabel : entry.account,
									children: entry.accountLabel !== void 0 && entry.accountLabel !== "" ? entry.accountLabel : "—"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-mono sn-truncate",
									title: entry.accountRef,
									children: entry.accountRef !== void 0 && entry.accountRef !== "" ? entry.accountRef : "—"
								})
							]
						}), log.expandedRow === index ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-diagnosticsDetail",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-diagnosticsTags",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("diagnosticsAttempt", { n: entry.attempt }) }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: entry.rotated ? props.t("diagnosticsRotatedYes") : props.t("diagnosticsRotatedNo") }),
									entry.retryFloorMs !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("diagnosticsFloor", { ms: entry.retryFloorMs }) }) : null,
									entry.providerRetryAfterMs !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("diagnosticsPra", { ms: entry.providerRetryAfterMs }) }) : null,
									entry.probeHits !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("diagnosticsProbeHits", { n: entry.probeHits }) }) : null,
									entry.kicked === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-diagnosticsWarn",
										children: props.t("diagnosticsKicked")
									}) : null,
									entry.poolRunning !== void 0 || entry.poolBlocked !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("diagnosticsPool", {
										running: entry.poolRunning ?? 0,
										blocked: entry.poolBlocked ?? 0
									}) }) : null,
									entry.accountLabel !== void 0 && entry.accountLabel !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										props.t("diagnosticsAccountLabel"),
										" ",
										entry.accountLabel
									] }) : null,
									entry.accountRef !== void 0 && entry.accountRef !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										props.t("diagnosticsAccountRef"),
										" ",
										entry.accountRef
									] }) : null,
									entry.account !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
										props.t("diagnosticsAccount"),
										" ",
										entry.account
									] }) : null
								]
							}), entry.message !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint sn-mono sn-diagnosticsMessage",
								children: entry.message
							}) : null]
						}) : null] }, `${entry.ts}-${index}`))]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: "sn-hint sn-truncate",
						title: log.path,
						children: [props.t("diagnosticsPath", { path: log.path }), log.truncated ? ` ${props.t("diagnosticsTruncated")}` : ""]
					})
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-card sn-diagnostics",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "sn-label",
							children: props.t("diagnosticsTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "sn-linkButton",
							disabled: busy,
							onClick: () => props.onRefresh(),
							children: busy ? props.t("diagnosticsLoading") : props.t("diagnosticsRefresh")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: props.t("diagnosticsIntro")
					}),
					body
				]
			});
		}
		/** 三态可改性的展示标记（✅可改 / ⚙️插件级默认 / ❌不可改）。 */
		function mutabilityBadge(kind, t) {
			const entry = {
				host: {
					cls: "sn-miBadge sn-miBadgeHost",
					key: "miMutHost"
				},
				l2: {
					cls: "sn-miBadge sn-miBadgeL2",
					key: "miMutL2"
				},
				none: {
					cls: "sn-miBadge sn-miBadgeNone",
					key: "miMutNone"
				}
			}[kind];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: entry.cls,
				children: t(entry.key)
			});
		}
		/** 数字加千分位（表格里展示 token 数用）。 */
		function fmtInt(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return value.toLocaleString("en-US");
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
		function AccountPoolBlock(props) {
			const pool = props.accounts;
			if (pool === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "sn-hint",
				children: props.t("miAccountsUnknown")
			});
			const pluginSlots = pool.slots;
			const settingsSlots = props.probe !== void 0 && props.probe.accountsInSettings >= 0 ? props.probe.accountsInSettings + 1 : void 0;
			const renderedSlots = props.renderedExtra + 1;
			let diagnosis;
			if (settingsSlots !== void 0 && settingsSlots !== pluginSlots) diagnosis = props.t("miAccountsGapTransport", {
				plugin: pluginSlots,
				transport: settingsSlots
			});
			else if (settingsSlots !== void 0 && renderedSlots !== pluginSlots) diagnosis = props.settingsReady ? props.t("miAccountsGapClientDecode", {
				plugin: pluginSlots,
				ui: renderedSlots
			}) : props.t("miAccountsGapClientLoading");
			else if (settingsSlots === void 0 && props.settingsReady && renderedSlots !== pluginSlots) diagnosis = props.t("miAccountsGapTransportMissing", {
				plugin: pluginSlots,
				ui: renderedSlots
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-diagnosticsTags",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("miAccountsSlots", { n: pluginSlots }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "sn-mono sn-truncate",
						title: pool.refs.join(", "),
						children: pool.refs.join(" · ") || "—"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: pool.quotaRotation ? props.t("miAccountsRotationOn") : props.t("miAccountsRotationOff") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: pool.activeAccount === "" ? props.t("miAccountsAuto") : props.t("miAccountsPinned", { id: pool.activeAccount }) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "sn-mono",
						children: props.t("miAccountsChain", {
							transport: settingsSlots === void 0 ? "—" : settingsSlots,
							ui: props.settingsReady ? renderedSlots : "…"
						})
					}),
					diagnosis !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "sn-diagnosticsWarn",
						children: diagnosis
					}) : null
				]
			});
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
		function ModelInfoPanel(props) {
			const info = props.state;
			const busy = info.status === "loading";
			const snapshot = info.snapshot;
			let body;
			if (info.status === "idle") body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "sn-hint",
				children: props.t("miIdle")
			});
			else if (info.status === "error" || snapshot === void 0) body = /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "sn-hint sn-diagnosticsWarn",
				children: props.t("miUnavailable")
			});
			else if (!snapshot.available) body = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-diagnosticsBody",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountPoolBlock, {
					t: props.t,
					accounts: snapshot.accounts,
					probe: snapshot.settingsProbe,
					renderedExtra: props.renderedExtra ?? 0,
					settingsReady: props.settingsReady ?? false
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "sn-hint sn-diagnosticsWarn",
					children: props.t("miNoDefaultModel")
				})]
			});
			else {
				const selection = snapshot.selection;
				const resolved = snapshot.resolved;
				const facts = snapshot.facts;
				const vision = facts !== void 0 ? facts.vision : resolved?.inputModalities?.includes("image") ?? false;
				const currentEffort = selection?.reasoningEffort ?? resolved?.defaultEffort;
				body = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "sn-diagnosticsBody",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountPoolBlock, {
							t: props.t,
							accounts: snapshot.accounts,
							probe: snapshot.settingsProbe,
							renderedExtra: props.renderedExtra ?? 0,
							settingsReady: props.settingsReady ?? false
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-diagnosticsStats",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sn-diagnosticsStat",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-hint",
										children: props.t("miStatModel")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-diagnosticsValue sn-truncate",
										title: selection?.model,
										children: selection?.model ?? "—"
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sn-diagnosticsStat",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-hint",
										children: props.t("miStatVision")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-diagnosticsValue",
										children: vision ? props.t("miVisionYes") : props.t("miVisionNo")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sn-diagnosticsStat",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-hint",
										children: props.t("miStatEffort")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-diagnosticsValue sn-truncate",
										children: currentEffort ?? props.t("miEffortServerDefault")
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-diagnosticsTags",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("miResolvedContext", { n: fmtInt(resolved?.contextWindow ?? facts?.contextWindow) }) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("miResolvedMaxTokens", { n: fmtInt(resolved?.defaultMaxTokens ?? facts?.maxOutputTokens) }) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									props.t("miResolvedModalities"),
									" ",
									(resolved?.inputModalities ?? []).join(" + ") || "—"
								] })
							]
						}),
						facts !== void 0 && !facts.vision && facts.textOnlyBehavior === "hallucinates" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "sn-hint sn-diagnosticsWarn",
							children: props.t("miWarnHallucinates")
						}) : null,
						facts !== void 0 && !facts.vision && facts.textOnlyBehavior === "refuses" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "sn-hint",
							children: props.t("miWarnRefuses")
						}) : null,
						facts !== void 0 && facts.visionNote !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "sn-hint",
							children: props.t("miVisionNote", { note: facts.visionNote })
						}) : null,
						snapshot.l2Allowed.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "sn-hint",
							children: props.t("miL2Allowed", { list: snapshot.l2Allowed.join(", ") })
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-diagnosticsList sn-miList",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-diagnosticsRow sn-miRow",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-truncate",
										children: props.t("miColumnParam")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("miColumnMutability") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: props.t("miColumnDefault") })
								]
							}), snapshot.params.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "sn-diagnosticsRowButton sn-miRow",
								"aria-expanded": false,
								title: row.note !== void 0 ? `${row.key}: ${row.note}` : row.key,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-mono sn-truncate",
										title: row.key,
										children: row.label
									}),
									mutabilityBadge(row.mutability, props.t),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-mono sn-truncate",
										title: `${row.key} · ${row.range}`,
										children: row.serverDefault
									})
								]
							}), row.note !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "sn-diagnosticsDetail",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "sn-hint sn-mono sn-diagnosticsMessage",
									children: row.note
								})
							}) : null] }, row.key))]
						}),
						facts !== void 0 && facts.notes.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "sn-diagnosticsTags",
							children: facts.notes.map((note) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: note }, note))
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "sn-hint",
							children: props.t("miProbedAt", { at: snapshot.probedAt })
						})
					]
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-card sn-diagnostics",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "sn-label",
							children: props.t("miTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "sn-linkButton",
							disabled: busy,
							onClick: () => props.onRefresh(),
							children: busy ? props.t("miLoading") : props.t("miRefresh")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: props.t("miIntro")
					}),
					body
				]
			});
		}
		function SenseNovaSection(props) {
			const { t } = props;
			const state = props.useSensenovaSettings((s) => s);
			const disabled = !state.writable;
			const savedVisible = useSavedFlash(state.savedCount);
			const accounts = state.accounts;
			const credentialRefs = credentialReferences(state);
			const savedAccounts = accounts.filter((account) => !account.added);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "sn-section",
				"aria-label": t("title"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						className: "sn-title",
						children: t("title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-intro",
						children: t("intro")
					}),
					!state.writable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-readOnly",
						role: "status",
						children: t("readOnly")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionHeading, { text: t("groupConnection") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "sn-card sn-cardCompact",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-field",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-fieldHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-label",
									children: t("routeLabel")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-badges",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-badge",
										children: state.route
									})
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint",
								children: state.displayName
							})]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionHeading, { text: t("groupCredentials") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-card",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "sn-field",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-fieldHead",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-label",
									children: t("defaultAccount")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "sn-badges",
									children: [state.effectiveActiveAccountId === "default" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-badge sn-badgeActive",
										children: t("activeBadgeEffectiveFull")
									}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
										configured: state.defaultConfigured,
										t
									})]
								})]
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DefaultKeyField, {
							t,
							draft: state.defaultKeyDraft,
							disabled: disabled || !state.defaultWritable,
							configured: state.defaultConfigured,
							clearStaged: state.defaultClearStaged,
							onEdit: props.editDefaultKey,
							onToggleClear: props.toggleDefaultKeyClear
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-card",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sn-fieldHead",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-label",
										children: t("accountsTitle")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "sn-btnAdd",
										disabled,
										onClick: props.addAccount,
										children: t("accountAdd")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									className: "sn-hint",
									children: state.quotaRotationDraft ? t("accountsHintQuotaRotation") : t("accountsHint")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-accountSummary",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-accountSummaryStats",
									children: t("accountSummary", {
										total: state.totalCount,
										configured: state.configuredCount
									})
								}), state.effectiveActiveAccountLabel !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "sn-accountSummaryActive",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "sn-dotPulse",
										"aria-hidden": "true"
									}), t("accountSummaryActive", { label: state.effectiveActiveAccountLabel })]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-accountSummaryNone",
									children: t("accountSummaryNone")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "sn-field",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "sn-label",
									htmlFor: "sn-active-account",
									children: t("activeAccount")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "sn-activeAccountControl",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "sn-activeAccountSelect",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											id: "sn-active-account",
											className: "sn-input",
											value: state.activeAccountDraft,
											disabled,
											onChange: (event) => props.setActiveAccount(event.target.value),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: state.effectiveActiveAccountLabel !== "" ? `${t("activeAccountAuto")} → ${state.effectiveActiveAccountLabel}` : t("activeAccountAuto")
											}), savedAccounts.map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: account.id,
												children: accountDisplayLabel(account, index, t, credentialRefs)
											}, account.id))]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "sn-selectChevron",
											"aria-hidden": "true"
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "sn-reset",
										disabled,
										onClick: () => props.setActiveAccount(""),
										children: t("activeAccountReset")
									})]
								})]
							}),
							accounts.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "sn-accountList",
								children: accounts.map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AccountRow, {
									t,
									account,
									refs: credentialRefs,
									index,
									disabled,
									isActive: state.effectiveActiveAccountId === account.id,
									isPinned: state.activeAccountDraft === account.id,
									onRemove: () => props.removeAccount(account.id),
									onLabel: (text) => props.editAccountLabel(account.id, text),
									onKey: (text) => props.editAccountKey(account.id, text),
									onToggleClear: () => props.toggleAccountKeyClear(account.id)
								}, account.id))
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionHeading, { text: t("groupAdvanced") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AdvancedSettings, {
						t,
						state,
						disabled,
						edit: props.edit,
						setQuotaRotation: props.setQuotaRotation,
						setErrorLog: props.setErrorLog,
						setRetryMode: props.setRetryMode,
						editRetry: props.editRetry,
						editPool: props.editPool
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionHeading, { text: t("groupDiagnostics") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorLogPanel, {
						t,
						state: state.diagnostics,
						onRefresh: props.refreshErrorLog,
						onToggleRow: props.toggleErrorLogRow
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SectionHeading, { text: t("miGroup") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelInfoPanel, {
						t,
						state: state.modelInfo,
						onRefresh: props.refreshModelInfo,
						renderedExtra: savedAccounts.length,
						settingsReady: state.available
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-footer",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "sn-footerStatus",
							children: state.failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-failed",
								role: "status",
								children: t("saveFailed")
							}) : savedVisible && !state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-saved",
								role: "status",
								children: t("saved")
							}) : state.dirty ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "sn-unsaved",
								children: t("unsaved")
							}) : null
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "sn-footerActions",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-btnGhost",
								disabled: !state.dirty || state.saving,
								onClick: props.discard,
								children: t("reset")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-btnPrimary",
								disabled: !state.dirty || state.saving,
								onClick: props.save,
								children: state.saving ? t("saving") : t("save")
							})]
						})]
					})
				]
			});
		}
		function DefaultKeyField(props) {
			const { t } = props;
			const [visible, setVisible] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-field",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "sn-label",
							htmlFor: "sn-default-key",
							children: t("defaultKey")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "sn-badges",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-reset",
								disabled: props.disabled,
								onClick: () => setVisible((v) => !v),
								children: visible ? t("hide") : t("show")
							}), props.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-reset",
								disabled: props.disabled,
								onClick: props.onToggleClear,
								children: t("clearKey")
							}) : null]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "sn-default-key",
						className: "sn-input",
						type: visible ? "text" : "password",
						autoComplete: "off",
						spellCheck: false,
						value: props.draft,
						disabled: props.disabled,
						onChange: (event) => props.onEdit(event.target.value)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: t("defaultKeyHint")
					})
				]
			});
		}
		function AccountRow(props) {
			const { t, account } = props;
			const [visible, setVisible] = (0, react.useState)(false);
			const displayLabel = accountDisplayLabel(account, props.index, t, props.refs);
			const labelDraft = isCredentialReference(account.labelDraft, props.refs) ? "" : account.labelDraft;
			const labelId = `sn-account-label-${account.id}`;
			const keyId = `sn-account-key-${account.id}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-accountRow",
				"data-sn-active": props.isActive ? "true" : void 0,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "sn-accountHead",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "sn-label",
						title: displayLabel,
						children: displayLabel
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "sn-accountActions",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "sn-badges",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusBadge, {
									configured: account.configured,
									t
								}), props.isActive ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "sn-badge sn-badgeActive",
									children: props.isPinned ? t("activeBadge") : t("activeBadgeEffectiveFull")
								}) : null]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-iconBtn",
								disabled: props.disabled || !account.writable,
								title: visible ? t("hide") : t("show"),
								"aria-label": visible ? t("hide") : t("show"),
								onClick: () => setVisible((v) => !v),
								children: visible ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconEyeOff, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconEye, {})
							}),
							account.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-iconBtn",
								disabled: props.disabled || !account.writable,
								title: t("clearKey"),
								"aria-label": t("clearKey"),
								onClick: props.onToggleClear,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconEraser, {})
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "sn-iconBtn sn-iconBtnDanger",
								disabled: props.disabled,
								title: t("accountRemove"),
								"aria-label": t("accountRemove"),
								onClick: props.onRemove,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTrash, {})
							})
						]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "sn-accountFields",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-accountField",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
							className: "sn-labelSmall",
							htmlFor: labelId,
							children: t("accountLabel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: labelId,
							className: "sn-input",
							type: "text",
							placeholder: t("accountLabel"),
							value: labelDraft,
							disabled: props.disabled,
							spellCheck: false,
							onChange: (event) => props.onLabel(event.target.value)
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-accountField",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
								className: "sn-labelSmall",
								htmlFor: keyId,
								children: t("accountKey")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: keyId,
								className: "sn-input",
								type: visible ? "text" : "password",
								autoComplete: "off",
								placeholder: t("accountKey"),
								spellCheck: false,
								value: account.keyDraft,
								disabled: props.disabled || !account.writable,
								onChange: (event) => props.onKey(event.target.value)
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "sn-hint",
								children: t("accountKeyHint")
							})
						]
					})]
				})]
			});
		}
		/** 行内 SVG 图标（currentColor，随主题变色）。 */
		function IconEye() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M1.5 8s2.2-3.6 6.5-3.6S14.5 8 14.5 8 12.3 11.6 8 11.6 1.5 8 1.5 8Z",
					stroke: "currentColor",
					strokeWidth: "1.3"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "8",
					r: "1.8",
					stroke: "currentColor",
					strokeWidth: "1.3"
				})]
			});
		}
		function IconEyeOff() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M1.5 8s2.2-3.6 6.5-3.6c1.5 0 2.8.5 3.8 1.2M14.5 8s-.8 1.3-2.4 2.5M6.6 11.3c.5.1.9.2 1.4.2",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M3 13 13 3",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				})]
			});
		}
		function IconEraser() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M9.5 3.5 13.5 7.5 8 13H4.5L2.5 11c-.6-.6-.6-1.5 0-2.1l4.4-4.4c.6-.6 1.5-.6 2.1 0l.5.5Z",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinejoin: "round"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M6 13h8",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round"
				})]
			});
		}
		function IconTrash() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				viewBox: "0 0 16 16",
				width: "14",
				height: "14",
				fill: "none",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M2.5 4h11M6.5 2.5h3M5 4l.5 8.5c0 .6.4 1 1 1h3c.6 0 1-.4 1-1L11 4",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});
		}
		//#endregion
		//#region src/client/card.tsx
		function SenseNovaProviderCard(props) {
			const { t } = props;
			const state = props.useSensenovaSettings !== void 0 ? props.useSensenovaSettings((snapshot) => snapshot) : void 0;
			const configuredAccounts = state?.accounts.filter((a) => a.configured).length ?? 0;
			const configured = state !== void 0 && state.available ? state.defaultConfigured || configuredAccounts > 0 : props.keyConfigured ?? false;
			const active = props.provider?.active ?? false;
			const showBody = state !== void 0 && state.available;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "sn-providerCard",
				"data-sn-models-card": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "sn-field",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "sn-fieldHead",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "sn-label",
							children: t("cardTitle")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "sn-badges",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: configured ? "sn-badge" : "sn-badgeMuted",
								children: configured ? t("apiKeySet") : t("apiKeyUnset")
							}), active ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "sn-badge",
								children: t("cardRouteActive")
							}) : null]
						})]
					}), !showBody ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: state === void 0 ? t("cardRegistrationHint") : t("cardLoadingHint")
					}) : configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: t("cardConfiguredHint")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "sn-hint",
						children: t("cardUnconfiguredHint")
					})]
				}), showBody ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: "sn-hint",
					children: [
						t("cardAccounts"),
						": ",
						state.accounts.length,
						state.activeAccount !== "" ? ` · ${t("cardActiveAccount")}: ${state.activeAccount}` : ""
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* SenseNova 设置页与 Models 页卡片的文案（zh/en 双语）。
		* 注册命名空间：`settings.sensenova`（与 settings.section / provider-card 的
		* locale 选项一致，参考 @mars-sea/dsh-commandcode-provider 的 `settings.commandcode`）。
		*/
		const zh = {
			nav: "SenseNova",
			title: "SenseNova",
			intro: "配置 SenseNova Provider 连接。API 密钥仅写入本机凭据服务、不会回显；其余字段写入用户设置，保存后立即生效。",
			routeLabel: "Provider 路由",
			apiBase: "API 地址",
			apiBaseHint: "默认 https://token.sensenova.cn/v1，一般无需修改。",
			defaultKey: "默认账户 API 密钥",
			defaultKeyHint: "在 SenseNova 控制台创建。留空保存不会覆盖已存储的密钥。",
			apiKeySet: "已配置",
			apiKeyUnset: "未配置",
			defaultAccount: "默认账户",
			accountsTitle: "多账户轮换",
			accountsHint: "仅在密钥失效（401）时自动切换到下一个可用账户；429 限流不切换账户，由宿主重试层退避后使用原 key 重试。",
			accountsHintQuotaRotation: "密钥失效（401）时自动切换账户；已开启「配额类 429 换 key」，配额类 429 限流时也会切换到下一把 key 并粘住；任何 429 都不会冷却或禁用账户，由宿主退避后重试。",
			accountAdd: "添加账户",
			accountRemove: "删除",
			accountLabel: "账户备注名",
			accountKey: "API 密钥",
			accountKeyHint: "该账户的 API 密钥。留空保存不会覆盖已存储的密钥。",
			accountFallback: "账户 {index}",
			activeAccount: "活动账户",
			activeAccountReset: "重置为自动",
			activeAccountAuto: "自动（第一个可用账户）",
			activeBadge: "活动",
			activeBadgeEffective: "当前",
			activeBadgeEffectiveFull: "当前生效",
			accountSummary: "共 {total} 个账户 · {configured} 个已配置",
			accountSummaryActive: "当前生效：{label}",
			accountSummaryNone: "尚无已配置账户",
			advancedSettings: "高级设置",
			advancedCustomizedCount: "已自定义 {count} 项",
			concurrency: "并发上限",
			concurrencyHint: "同一 API key 同时进行的生成请求数（默认 1）。超出上限的请求排队等待，避免触发渠道并发限流。",
			queueTimeoutMs: "排队等待上限（毫秒）",
			queueTimeoutMsHint: "并发已满时，请求最多排队多久（默认 60000）。超时即放弃该次尝试；调得过小会让正常排队也白白丢掉重试机会，一般无需改动。",
			quotaRotation: "配额类 429 换 key",
			quotaRotationHint: "仅限流耗尽时切换到下一把 key 并粘住；密钥失效（401）行为不变。",
			errorLog: "记录限流事件",
			errorLogHint: "把每次限流（错误码 / 模型 / 账号 / 退避值）追加到 $DSH_HOME/logs/sensenova-errors.jsonl（通常即 ~/.dsh/logs/），供事后排查；超过体积上限自动滚动，只保留一份历史。",
			groupDiagnostics: "诊断",
			diagnosticsTitle: "错误记录",
			diagnosticsIntro: "只读展示最近一次拉取的结果，数据来自上面开关落盘的限流事件日志（不写入配置、不影响运行）。",
			diagnosticsRefresh: "刷新",
			diagnosticsLoading: "加载中…",
			diagnosticsIdle: "点「刷新」加载最近的限流记录。",
			diagnosticsEmpty: "暂无记录 —— 还没有发生过限流。",
			diagnosticsUnavailable: "错误记录暂不可用（这次没取到数据，可稍后重试）。",
			diagnosticsStatTotal: "近 24 小时",
			diagnosticsStatCodes: "错误类型",
			diagnosticsStatModels: "受影响模型",
			diagnosticsColumnTime: "时间",
			diagnosticsColumnType: "类型",
			diagnosticsColumnModel: "模型",
			diagnosticsRotatedYes: "已换 key",
			diagnosticsRotatedNo: "未换 key",
			diagnosticsAccount: "账号",
			diagnosticsAttempt: "第 {n} 次尝试",
			diagnosticsPath: "日志文件：{path}",
			diagnosticsTruncated: "（文件过大，统计只覆盖尾部）",
			diagnosticsFloor: "退避下限 {ms} ms",
			diagnosticsPra: "实际退避 {ms} ms",
			diagnosticsProbeHits: "探测档位 #{n}",
			diagnosticsSaturated: "全池饱和（本轮未轮换 key，直接退避）",
			diagnosticsColumnAccount: "账户",
			diagnosticsColumnApi: "API",
			diagnosticsKicked: "key 已被踢出运行态",
			diagnosticsPool: "池：运行 {running} / 阻塞 {blocked}",
			diagnosticsAccountLabel: "账户名",
			diagnosticsAccountRef: "API 引用",
			miGroup: "当前模型",
			miTitle: "当前模型 + 全部参数",
			miIntro: "回答「我现在用的是哪个模型、它到底支持什么、哪些参数我能改」。数据来自宿主的实际解析结果 + 2026-09-23 的 131 项实测，只读、不影响运行。",
			miRefresh: "刷新",
			miLoading: "加载中…",
			miIdle: "点「刷新」查看当前模型与全部参数。",
			miUnavailable: "暂不可用（host 未提供该接口，或本次取数失败，可稍后重试）。",
			miNoDefaultModel: "取不到当前默认模型 —— 请确认已选择模型，或 host 端 agent-default-model 服务正常。",
			miStatModel: "当前模型",
			miStatVision: "图片输入",
			miStatEffort: "思考档位",
			miVisionYes: "支持",
			miVisionNo: "不支持",
			miEffortServerDefault: "未指定（用服务端默认）",
			miResolvedContext: "上下文 {n} tokens",
			miResolvedMaxTokens: "输出预算 {n} tokens",
			miResolvedModalities: "输入模态：",
			miWarnHallucinates: "⚠️ 该模型不支持图片，但网关会接受并计费图片字节，模型会**凭空编造图片内容**（实测会编出不存在的形状与数字）。请勿向它发图。",
			miWarnRefuses: "该模型不支持图片，但会明确告知\"无法看到图片\"，不会编造内容。请改用支持图片的模型。",
			miVisionNote: "图片支持：{note}",
			miL2Allowed: "本模型允许注入的连接级参数：{list}（其余参数会被白名单过滤掉，避免触发 400）。",
			miColumnParam: "参数",
			miColumnMutability: "可改性",
			miColumnDefault: "服务端默认",
			miMutHost: "✅ 可改",
			miMutL2: "⚙️ 连接级",
			miMutNone: "❌ 不可改",
			miProbedAt: "实测数据时间：{at}",
			miAccountsSlots: "已接线账户 {n} 个（含默认）",
			miAccountsUnknown: "账户池信息不可用。",
			miAccountsRotationOn: "配额 429 粘性换 key：开",
			miAccountsRotationOff: "配额 429 粘性换 key：关",
			miAccountsAuto: "活动账户：自动",
			miAccountsPinned: "活动账户：钉选 {id}",
			miAccountsMismatch: "⚠️ 与上方「账户」区块渲染的条数不一致 —— 界面拿到的可能不是最新配置（典型成因：实例在配置被改动前启动、未热重载）。重启 dsh web 后复查。",
			miAccountsChain: "逐级比对 插件 {plugin} → 传输 {transport} → 界面 {ui}",
			miAccountsGapTransport: "🔴 断在「配置 → 设置传输层」：插件生效 {plugin} 个，但设置段里是 {transport} 个 ⇒ 配置没进设置段（如迁移丢段 / 手改文件未触发重载）。",
			miAccountsGapTransportMissing: "⚠️ 设置段未报告本插件的账户字段：插件生效 {plugin} 个，界面渲染 {ui} 个。可能是设置服务不可用或该 namespace 未注册。",
			miAccountsGapClientDecode: "🔴 断在「设置传输层 → 界面」：传输层是 {plugin} 个，界面只渲染了 {ui} 个 ⇒ 前端 decode 失败（静默回落 schema 默认值）或快照陈旧。刷新页面/重启 dsh web 后复查。",
			miAccountsGapClientLoading: "⏳ 设置表单尚未加载完成，界面条数暂时不可比。稍后点「刷新」再看。",
			retryTitle: "重试策略",
			retryIntro: "控制宿主的自动重试：等多久、试几次、会不会彻底放弃。改动保存后立即生效，无需重启。",
			retryMode: "重试模式",
			retryModeNormal: "normal — 有限次重试",
			retryModeAlways: "always — 永不放弃",
			retryModeHintNormal: "按可重试错误码过滤，在次数预算内退避重试；预算耗尽即放弃（回合失败）。",
			retryModeHintAlways: "⚠️ 跳过错误码过滤：认证失败、请求非法等永久错误也会无限重试，可能长时间挂住（只能手动中断）。仅在明确需要「绝不放弃」时使用。",
			retryMaxRetries: "最大重试次数",
			retryMaxRetriesHint: "首次请求之外的额外重试预算（仅 normal 模式生效）。429 的恢复窗口是分钟级，次数过少会让整个回合作废。",
			retryMaxDelayMs: "单次退避上限（毫秒）",
			retryMaxDelayMsHint: "不得低于 300000（约 5 分钟）：低于它时，等待时间落在「该值 ~ 30 万」区间的限流请求会被宿主**直接放弃重试**（回合立即失败，即「悬崖」）。可以调大。",
			retryInitialDelayMs: "初始退避（毫秒）",
			retryInitialDelayMsHint: "本地指数退避的起点，每次重试翻倍，封顶见上一项。",
			retryJitterRatio: "退避抖动比例",
			retryJitterRatioHint: "0–1。在计算出的退避上下做 ±该比例 的随机浮动，避免多个请求同时重试造成惊群。",
			poolTitle: "Key 池",
			poolIntro: "「运行态 / 阻塞态」双列表：连续吃到 token 类限流的 key 会被请出运行态、进阻塞态等探测恢复。仅在「配额类 429 换 key」开启时生效。",
			poolKickThreshold: "踢出阈值（连续次数）",
			poolKickThresholdHint: "连续命中几次 **token 类**限流后把该 key 移出运行态。请求数类（rpm）与通用速率类不参与计数 —— 它们是秒级桶、十几秒自愈，踢掉只会白白损失该 key 的 prompt cache 命中率。",
			poolProbeInitialMs: "探测起手间隔（毫秒）",
			poolProbeInitialMsHint: "阻塞态 key 每隔多久用一次最小请求试探是否恢复。默认 15000（15 秒）—— 请求数桶的恢复周期就是 15 秒量级，比它更密只是白打网关。",
			poolProbeBackoffFactor: "探测退避倍率",
			poolProbeBackoffFactorHint: "连续探测失败时，间隔按此倍率放大（默认 2 ⇒ 15s → 30s → 60s）。",
			poolProbeMaxMs: "探测间隔上限（毫秒）",
			poolProbeMaxMsHint: "退避放大的封顶值。不得低于起手间隔（保存时会自动抬高）。",
			poolCapacity: "槽位上限",
			poolCapacityHint: "池内最多追踪几把 key（1–10）。超出的 key 会被忽略并记一条 warning。",
			added: "未保存",
			readOnly: "当前配置为只读。",
			show: "显示",
			hide: "隐藏",
			clearKey: "清除已存密钥",
			reset: "重置",
			save: "保存",
			saving: "保存中…",
			saved: "已保存 ✓",
			saveFailed: "保存失败，请重试。",
			unsaved: "未保存",
			cardTitle: "SenseNova 连接",
			cardRouteActive: "已启用",
			cardLoadingHint: "正在读取 SenseNova 配置…",
			cardRegistrationHint: "此卡片随 SenseNova 插件注册，需要较新版本的 DeepSeek Harness 才会显示完整内容。",
			cardConfiguredHint: "API 密钥已就绪。如需更换密钥、添加多账户或修改 API 地址，请前往「设置 → SenseNova」。",
			cardUnconfiguredHint: "尚未配置 API 密钥，请前往「设置 → SenseNova」完成配置。",
			cardAccounts: "已配置账户",
			cardActiveAccount: "活动账户",
			modelInclude: "手动加入模型",
			modelIncludeHint: "仅接受最新目录中的文本模型；可用换行或逗号分隔。可重新加入 stale 文本模型，但 image-only 模型始终排除。",
			modelExclude: "隐藏模型",
			modelExcludeHint: "可用换行或逗号分隔；与手动加入冲突时隐藏优先。",
			groupConnection: "接入信息",
			groupCredentials: "凭据与账户",
			groupAdvanced: "高级选项"
		};
		const en = {
			nav: "SenseNova",
			title: "SenseNova",
			intro: "Configure the SenseNova provider connection. The API key is written only to the local credential service and never echoed; other fields are written to user settings and take effect immediately after saving.",
			routeLabel: "Provider route",
			apiBase: "API base URL",
			apiBaseHint: "Defaults to https://token.sensenova.cn/v1; usually leave as-is.",
			defaultKey: "Default account API key",
			defaultKeyHint: "Create one in the SenseNova console. Saving with this field blank keeps the stored key.",
			apiKeySet: "Configured",
			apiKeyUnset: "Not configured",
			defaultAccount: "Default account",
			accountsTitle: "Account rotation",
			accountsHint: "Requests switch to the next usable account only when a key fails (401); 429 rate limits do not switch accounts, and the host retry layer backs off before retrying with the original key.",
			accountsHintQuotaRotation: "Requests switch accounts when a key fails (401); with “Rotate key on quota 429” enabled, quota-type 429 rate limits also switch to the next key and stick with it. Accounts are never disabled by 429s; the host retry layer backs off before retrying.",
			accountAdd: "Add account",
			accountRemove: "Remove",
			accountLabel: "Account label",
			accountKey: "API key",
			accountKeyHint: "This account’s API key. Saving with the field blank keeps the stored key.",
			accountFallback: "Account {index}",
			activeAccount: "Active account",
			activeAccountReset: "Reset to auto",
			activeAccountAuto: "Auto (first usable account)",
			activeBadge: "Active",
			activeBadgeEffective: "Current",
			activeBadgeEffectiveFull: "Active",
			accountSummary: "{total} accounts · {configured} configured",
			accountSummaryActive: "Active: {label}",
			accountSummaryNone: "No configured account",
			advancedSettings: "Advanced settings",
			advancedCustomizedCount: "{count} customized",
			concurrency: "Concurrency limit",
			concurrencyHint: "Maximum concurrent generation requests per API key (default 1). Requests beyond the limit queue instead of failing, avoiding channel rate limits.",
			queueTimeoutMs: "Queue wait limit (ms)",
			queueTimeoutMsHint: "How long a request may wait while concurrency is saturated (default 60000). Exceeding it drops that attempt; too small a value throws away retries that would otherwise have succeeded.",
			quotaRotation: "Rotate key on quota 429",
			quotaRotationHint: "Switch to the next key only when rate limits are exhausted, then stick with it; key invalidation (401) behavior is unchanged.",
			errorLog: "Log rate-limit events",
			errorLogHint: "Append every rate limit (code, model, account, backoff) to $DSH_HOME/logs/sensenova-errors.jsonl (usually ~/.dsh/logs/) for later triage; the file rolls over and keeps one previous copy.",
			groupDiagnostics: "Diagnostics",
			diagnosticsTitle: "Error log",
			diagnosticsIntro: "Read-only view of the last fetch, sourced from the rate-limit event log written by the toggle above (never touches configuration).",
			diagnosticsRefresh: "Refresh",
			diagnosticsLoading: "Loading…",
			diagnosticsIdle: "Select “Refresh” to load recent rate-limit records.",
			diagnosticsEmpty: "No records yet — no rate limiting has occurred.",
			diagnosticsUnavailable: "Error log unavailable right now; try again later.",
			diagnosticsStatTotal: "Last 24 hours",
			diagnosticsStatCodes: "Error types",
			diagnosticsStatModels: "Affected models",
			diagnosticsColumnTime: "Time",
			diagnosticsColumnType: "Type",
			diagnosticsColumnModel: "Model",
			diagnosticsRotatedYes: "Rotated key",
			diagnosticsRotatedNo: "Same key",
			diagnosticsAccount: "Account",
			diagnosticsAttempt: "Attempt {n}",
			diagnosticsPath: "Log file: {path}",
			diagnosticsTruncated: "(File too large — statistics cover the tail only)",
			diagnosticsFloor: "Floor {ms} ms",
			diagnosticsPra: "Applied {ms} ms",
			diagnosticsProbeHits: "Probe step #{n}",
			diagnosticsSaturated: "Whole pool saturated (keys skipped this round)",
			diagnosticsColumnAccount: "Account",
			diagnosticsColumnApi: "API",
			diagnosticsKicked: "key kicked out of the running list",
			diagnosticsPool: "Pool: {running} running / {blocked} blocked",
			diagnosticsAccountLabel: "Account name",
			diagnosticsAccountRef: "API ref",
			miGroup: "Current model",
			miTitle: "Current model + all parameters",
			miIntro: "Answers \"which model am I on, what does it actually support, and which parameters can I change\". Data comes from the host's resolved model info plus 131 live probes taken 2026-09-23. Read-only.",
			miRefresh: "Refresh",
			miLoading: "Loading…",
			miIdle: "Press \"Refresh\" to load the current model and its parameters.",
			miUnavailable: "Unavailable right now (the host did not provide this route, or the request failed).",
			miNoDefaultModel: "Could not read the default model — pick a model, or check the host-side agent-default-model service.",
			miStatModel: "Model",
			miStatVision: "Image input",
			miStatEffort: "Thinking level",
			miVisionYes: "Supported",
			miVisionNo: "Not supported",
			miEffortServerDefault: "Unset (provider default)",
			miResolvedContext: "Context {n} tokens",
			miResolvedMaxTokens: "Output budget {n} tokens",
			miResolvedModalities: "Input modalities: ",
			miWarnHallucinates: "Warning: this model does not support images, but the gateway still accepts and bills them, and the model **invents image content** (observed fabricating shapes and digits). Do not send it images.",
			miWarnRefuses: "This model does not support images, but it clearly says so instead of inventing content. Switch to a vision model when you need images.",
			miVisionNote: "Image support: {note}",
			miL2Allowed: "Connection-level parameters allowed for this model: {list}. Anything else is filtered out to avoid 400s.",
			miColumnParam: "Parameter",
			miColumnMutability: "Mutability",
			miColumnDefault: "Server default",
			miMutHost: "✅ Changeable",
			miMutL2: "⚙️ Connection",
			miMutNone: "❌ Not changeable",
			miProbedAt: "Probe data from: {at}",
			miAccountsSlots: "{n} account(s) wired (including default)",
			miAccountsUnknown: "Account pool information unavailable.",
			miAccountsRotationOn: "Quota 429 key rotation: on",
			miAccountsRotationOff: "Quota 429 key rotation: off",
			miAccountsAuto: "Active account: auto",
			miAccountsPinned: "Active account: pinned {id}",
			miAccountsMismatch: "Warning: count differs from the Accounts section above — the UI may be showing a stale configuration (typically because the instance started before the config changed and did not hot-reload). Restart dsh web and re-check.",
			miAccountsChain: "Chain  plugin {plugin} → transport {transport} → UI {ui}",
			miAccountsGapTransport: "Error at \"config → settings transport\": the plugin has {plugin} account(s) but the settings section carries {transport} — the config never reached the settings section (migration loss, or a hand edit that did not trigger a reload).",
			miAccountsGapTransportMissing: "Warning: the settings section reports no account field for this plugin. Plugin has {plugin}, UI rendered {ui}. The settings service may be unavailable or the namespace unregistered.",
			miAccountsGapClientDecode: "Error at \"settings transport → UI\": transport has {plugin} but the UI rendered only {ui} — a client-side decode failure (silently falling back to schema defaults) or a stale snapshot. Reload the page or restart dsh web.",
			miAccountsGapClientLoading: "Loading: the settings form has not settled yet, so the UI count is not comparable. Press Refresh shortly.",
			retryTitle: "Retry policy",
			retryIntro: "Controls the host retry layer: how long to wait, how many attempts, and whether to ever give up. Saving takes effect immediately — no restart needed.",
			retryMode: "Retry mode",
			retryModeNormal: "normal — bounded retries",
			retryModeAlways: "always — never give up",
			retryModeHintNormal: "Retries only listed transient codes, within the attempt budget; once the budget is exhausted the turn fails.",
			retryModeHintAlways: "⚠️ Skips the retryable-code filter: permanent failures (auth errors, bad requests) are retried forever and may hang the turn until you interrupt it. Use only when “never give up” is truly required.",
			retryMaxRetries: "Max retries",
			retryMaxRetriesHint: "Extra attempts beyond the first request (normal mode only). Rate-limit recovery windows are minutes long; too few attempts discard the whole turn.",
			retryMaxDelayMs: "Max backoff per attempt (ms)",
			retryMaxDelayMsHint: "Must be at least 300000 (~5 min). Below it, rate-limited requests whose wait falls in “this value ~ 300000” are abandoned outright by the host (the turn fails immediately) — the “cliff”. Larger values are fine.",
			retryInitialDelayMs: "Initial backoff (ms)",
			retryInitialDelayMsHint: "Starting point of the local exponential backoff; doubles per attempt, capped by the value above.",
			retryJitterRatio: "Backoff jitter ratio",
			retryJitterRatioHint: "0–1. Random ±ratio spread around the computed backoff so parallel retries do not stampede.",
			poolTitle: "Key pool",
			poolIntro: "Two-list “running / blocked” state machine: a key that keeps hitting token-class rate limits is moved out of the running list and probed until it recovers. Effective only when “rotate on quota-class 429” is on.",
			poolKickThreshold: "Kick-out threshold (consecutive)",
			poolKickThresholdHint: "How many consecutive **token-class** rate limits move a key out of the running list. Request-count (rpm) and generic rate classes do not count — they are second-scale buckets that self-heal, and kicking them only loses that key’s prompt-cache hits.",
			poolProbeInitialMs: "Probe interval (ms)",
			poolProbeInitialMsHint: "How often a blocked key is probed with one minimal request. Default 15000 — the request-count bucket recovers on that order, so probing more often just wastes calls.",
			poolProbeBackoffFactor: "Probe backoff factor",
			poolProbeBackoffFactorHint: "On consecutive probe failures the interval is multiplied by this (default 2 ⇒ 15s → 30s → 60s).",
			poolProbeMaxMs: "Probe interval cap (ms)",
			poolProbeMaxMsHint: "Upper bound for the grown interval. Cannot be lower than the initial interval (raised automatically on save).",
			poolCapacity: "Slot capacity",
			poolCapacityHint: "How many keys the pool tracks (1–10). Extra keys are ignored and logged as one warning.",
			added: "Unsaved",
			readOnly: "Settings are read-only.",
			show: "Show",
			hide: "Hide",
			clearKey: "Clear stored key",
			reset: "Reset",
			save: "Save",
			saving: "Saving…",
			saved: "Saved ✓",
			saveFailed: "Save failed, please retry.",
			unsaved: "Unsaved",
			cardTitle: "SenseNova connection",
			cardRouteActive: "Active",
			cardLoadingHint: "Loading the SenseNova configuration…",
			cardRegistrationHint: "This card is contributed by the SenseNova plugin; a newer DeepSeek Harness is needed to show the full controls.",
			cardConfiguredHint: "The API key is ready. To replace it, add account rotation, or change the API base, open “Settings → SenseNova”.",
			cardUnconfiguredHint: "No API key configured yet; open “Settings → SenseNova” to finish setup.",
			cardAccounts: "Configured accounts",
			cardActiveAccount: "Active account",
			modelInclude: "Manually include models",
			modelIncludeHint: "Only models in the latest catalog are accepted; separate IDs with newlines or commas. Stale text models may be restored, but image-only models are always excluded.",
			modelExclude: "Hide models",
			modelExcludeHint: "Separate IDs with newlines or commas; exclusions take priority over includes.",
			groupConnection: "Connection",
			groupCredentials: "Credentials & accounts",
			groupAdvanced: "Advanced"
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* SenseNova 客户端插件入口（browser half）。
		*
		* 只做多账户连接配置所必需的事：
		*   1. 注册 `settings.sensenova` 文案命名空间（zh/en）；
		*   2. 桥接凭据面：优先宿主 `remote.credentials`，旧版退化为
		*      `connection.api.credentials`（与 @mars-sea/dsh-commandcode-provider 同构）；
		*   3. 用 `configForms.get('llm-sensenova')` 生成设置域，
		*      交给 SenseNovaSettingsController（领域层，无 JSX）；
		*   4. 注入 `settings.section`（设置页）与 `settings.models.provider-card`
		*      （Models 页卡片）两个槽。
		*
		* API key 一律经凭据域写入（credential-ref），页面不回显明文；host 是唯一事实
		* 来源，保存后立即热生效。
		*/
		/** 把旧版 ApiProxy 凭据面适配为 CredentialsFace。 */
		function adaptLegacyCredentials(legacy) {
			if (legacy === void 0) return void 0;
			return {
				describe: async (refs) => {
					const response = await legacy.describe({ refs });
					if (!response.result.ok) return { ok: false };
					const value = response.result.value?.credentials;
					return value === void 0 ? { ok: true } : {
						ok: true,
						value
					};
				},
				set: async (ref, value) => {
					const response = await legacy.set({
						ref,
						value
					});
					return response.result.ok ? { ok: true } : {
						ok: false,
						error: response.result.error
					};
				},
				unset: async (ref) => {
					const response = await legacy.unset({ ref });
					return response.result.ok ? { ok: true } : {
						ok: false,
						error: response.result.error
					};
				}
			};
		}
		function injectPageCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-sensenova-freeapi-css")) return;
			const tag = document.createElement("style");
			tag.id = "dsh-sensenova-freeapi-css";
			tag.textContent = [
				".sn-section{display:flex;flex-direction:column;gap:14px}",
				".sn-title{font-size:16px;font-weight:600;margin:0;color:var(--dsw-alias-label-primary,#222)}",
				".sn-intro,.sn-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin:2px 0 0;line-height:1.5}",
				".sn-readOnly,.sn-failed{font-size:12px;color:var(--dsw-alias-label-error,#d9534f);margin:0}",
				".sn-saved{font-size:12px;color:var(--dsw-alias-label-success,#2e8b57);margin:0}",
				".sn-unsaved{font-size:12px;color:var(--dsw-alias-label-warning,#b58900);margin:0}",
				".sn-groupTitle{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a);margin:10px 0 -4px;padding:0 2px}",
				".sn-groupTitle:first-of-type{margin-top:2px}",
				".sn-card{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}",
				".sn-cardCompact{padding:10px 14px}",
				".sn-field{display:flex;flex-direction:column;gap:4px;min-width:0}",
				".sn-fieldHead{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}",
				".sn-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#222);min-width:0}",
				".sn-labelSmall{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#5c5c5c)}",
				".sn-badges{display:inline-flex;gap:6px;align-items:center;flex:0 0 auto;min-width:0;white-space:nowrap}",
				".sn-badge,.sn-badgeMuted,.sn-badgeActive{font-size:11px;padding:1px 8px;border-radius:999px;white-space:nowrap;line-height:17px}",
				".sn-badge{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,#5c5c5c);font-weight:500}",
				".sn-badgeMuted{background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
				".sn-badgeActive{background:var(--dsw-alias-button-primary-fill,#0f1115);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}",
				".sn-input{box-sizing:border-box;width:100%;font-size:13px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#222);min-width:0}",
				".sn-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:1px}",
				"select.sn-input{appearance:none;cursor:pointer;padding-right:30px}",
				".sn-activeAccountSelect{position:relative;flex:1 1 auto;min-width:0}",
				".sn-activeAccountSelect>.sn-input{width:100%}",
				".sn-selectChevron{position:absolute;right:8px;top:50%;width:14px;height:14px;transform:translateY(-50%);background-color:var(--dsw-alias-label-tertiary,#888f98);pointer-events:none;-webkit-mask:url(\"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 14 14%27 fill=%27none%27%3E%3Cpath d=%27M3 5.5 7 9l4-3.5%27 stroke=%27white%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E\") center / 14px 14px no-repeat;mask:url(\"data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2714%27 height=%2714%27 viewBox=%270 0 14 14%27 fill=%27none%27%3E%3Cpath d=%27M3 5.5 7 9l4-3.5%27 stroke=%27white%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E\") center / 14px 14px no-repeat}",
				".sn-textarea{display:block;line-height:1.45;min-height:88px;resize:vertical}",
				".sn-accountList{display:flex;flex-direction:column;gap:0;min-width:0}",
				".sn-accountRow{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 0}",
				".sn-accountRow:first-child{padding-top:2px}",
				".sn-accountRow+.sn-accountRow{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}",
				".sn-accountHead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:nowrap}",
				".sn-accountHead>.sn-label{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".sn-accountActions{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-width:0;white-space:nowrap}",
				".sn-accountActions>.sn-badges{margin-right:4px}",
				".sn-accountFields{display:flex;flex-wrap:wrap;gap:8px 12px;min-width:0}",
				".sn-accountField{display:flex;flex-direction:column;gap:4px;flex:1 1 200px;min-width:0}",
				".sn-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:pointer}",
				".sn-iconBtn:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#3b82f6);background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.1))}",
				".sn-iconBtn:disabled{opacity:.5;cursor:not-allowed}",
				".sn-iconBtnDanger:hover:not(:disabled){color:var(--dsw-alias-label-error,#d9534f)}",
				".sn-activeAccountControl{display:flex;align-items:center;gap:8px;min-width:0}",
				".sn-reset{font-size:12px;line-height:1.4;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#8a8a8a);cursor:pointer;white-space:nowrap}",
				".sn-reset:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#3b82f6)}",
				".sn-reset:disabled{opacity:.5;cursor:not-allowed}",
				".sn-btnAdd{font-size:12px;line-height:1.4;padding:3px 10px;border-radius:6px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);cursor:pointer;white-space:nowrap}",
				".sn-btnAdd:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6)}",
				".sn-btnAdd:disabled{opacity:.5;cursor:not-allowed}",
				".sn-btnPrimary{font-size:13px;line-height:1.4;padding:6px 14px;border-radius:6px;border:1px solid transparent;background:var(--dsw-alias-button-primary-fill,#3b82f6);color:var(--dsw-alias-label-primary-foreground,#fff);cursor:pointer}",
				".sn-btnPrimary:hover:not(:disabled){filter:brightness(.94)}",
				".sn-btnPrimary:disabled{opacity:.5;cursor:not-allowed}",
				".sn-btnGhost{font-size:13px;line-height:1.4;padding:6px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:transparent;color:var(--dsw-alias-label-secondary,#5c5c5c);cursor:pointer}",
				".sn-btnGhost:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-primary,#3b82f6)}",
				".sn-btnGhost:disabled{opacity:.5;cursor:not-allowed}",
				".sn-footer{display:flex;flex-direction:column;align-items:stretch;gap:8px;margin-top:2px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}",
				".sn-footerStatus{display:flex;flex-direction:column;gap:2px;min-height:16px}",
				".sn-footerActions{display:flex;align-items:center;justify-content:flex-end;gap:8px}",
				".sn-advanced{gap:0;padding:0;overflow:hidden}",
				".sn-advancedHeader{display:flex;align-items:center;width:100%;gap:8px;padding:12px 14px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#222);font:inherit;text-align:left;cursor:pointer}",
				".sn-advancedHeader:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.08))}",
				".sn-advancedHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3b82f6);outline-offset:-2px}",
				".sn-advancedMeta{display:inline-flex;align-items:center;gap:8px;margin-left:auto;white-space:nowrap}",
				".sn-advancedChevron{width:7px;height:7px;border-right:1.5px solid var(--dsw-alias-label-tertiary,#888f98);border-bottom:1.5px solid var(--dsw-alias-label-tertiary,#888f98);transform:rotate(45deg);transition:transform .15s ease}",
				".sn-advancedChevronExpanded{transform:rotate(225deg)}",
				".sn-advancedBody{display:flex;flex-direction:column;gap:10px;padding:0 14px 14px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));min-width:0}",
				".sn-advancedBody[hidden]{display:none}",
				".sn-models{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}",
				".sn-toggle{width:16px;height:16px;margin:0;flex:0 0 auto;accent-color:var(--dsw-alias-brand-primary,#3b82f6);cursor:pointer}",
				".sn-toggle:disabled{opacity:.5;cursor:not-allowed}",
				".sn-providerCard{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:10px;padding:12px;background:var(--dsw-alias-bg-layer-1,transparent);min-width:0}",
				".sn-accountSummary{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}",
				".sn-accountSummaryStats{font-size:12px;color:var(--dsw-alias-label-secondary,#5c5c5c);font-weight:500}",
				".sn-accountSummaryActive{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary,#222);font-weight:600}",
				".sn-accountSummaryNone{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
				".sn-dotPulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#3b82f6);animation:sn-pulse 1.8s ease-in-out infinite}",
				"@keyframes sn-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.7)}}",
				".sn-accountRow[data-sn-active=\"true\"]{border-left:3px solid var(--dsw-alias-brand-primary,#3b82f6);padding-left:10px;margin-left:-3px;background:var(--dsw-alias-bg-layer-2,rgba(59,130,246,.06));border-radius:4px}",
				".sn-linkButton{font-size:12px;color:var(--dsw-alias-brand-primary,#3b82f6);background:none;border:none;padding:2px 4px;cursor:pointer;border-radius:4px;font-family:inherit}",
				".sn-linkButton:disabled{color:var(--dsw-alias-label-tertiary,#8a8a8a);cursor:default}",
				".sn-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}",
				".sn-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
				".sn-diagnosticsBody{display:flex;flex-direction:column;gap:10px;min-width:0}",
				".sn-diagnosticsStats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}",
				".sn-diagnosticsStat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07));min-width:0}",
				".sn-diagnosticsValue{font-size:20px;font-weight:600;line-height:1.2;color:var(--dsw-alias-label-primary,#222)}",
				".sn-diagnosticsList{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:8px;overflow:hidden}",
				".sn-diagnosticsRow{display:grid;grid-template-columns:58px 1fr 1fr 72px 1.1fr;gap:10px;align-items:center;padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a);min-width:0}",
				".sn-diagnosticsList>div+div>.sn-diagnosticsRowButton{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16))}",
				".sn-diagnosticsRowButton{width:100%;border:none;background:none;text-align:left;cursor:pointer;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#222)}",
				".sn-diagnosticsRowButton:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.07))}",
				".sn-diagnosticsCode{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".sn-diagnosticsCode[data-kind=\"rate\"]{color:var(--dsw-alias-label-warning,#b58900)}",
				".sn-diagnosticsCode[data-kind=\"rpm\"]{color:var(--dsw-alias-label-warning,#b58900)}",
				".sn-diagnosticsDetail{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05))}",
				".sn-diagnosticsTags{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}",
				".sn-diagnosticsMessage{margin:0;word-break:break-all}",
				".sn-diagnosticsWarn{color:var(--dsw-alias-label-warning,#b58900)}",
				".sn-miRow{display:grid;grid-template-columns:1.4fr auto 1fr;gap:10px;align-items:center;padding:6px 10px;font-size:12px;min-width:0}",
				".sn-miList>div+div>.sn-miRow{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16))}",
				".sn-miBadge{justify-self:start;display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;line-height:1.6;white-space:nowrap}",
				".sn-miBadgeHost{background:var(--dsw-alias-bg-success,rgba(60,160,90,.16));color:var(--dsw-alias-label-success,#2f7d4f)}",
				".sn-miBadgeL2{background:var(--dsw-alias-bg-info,rgba(60,110,200,.14));color:var(--dsw-alias-label-info,#2c5fa8)}",
				".sn-miBadgeNone{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-tertiary,#8a8a8a)}"
			].join("\n");
			document.head.appendChild(tag);
		}
		/** 在给定的 ctx 上挂载两个槽，共享同一个设置控制器与快照 store。 */
		function applyClientSurfaces(ctx, credentials) {
			const controller = new SenseNovaSettingsController(ctx.configForms.get(SENSENOVA_NS), credentials);
			ctx.effect(() => () => controller.dispose(), "dsh-sensenova-freeapi: settings controller");
			const store = createSnapshotStore(controller.state());
			controller.subscribe(() => store.set(controller.state()));
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", () => {
				controller.refreshCredentials();
			}), "dsh-sensenova-freeapi: credential invalidations");
			const injected = () => ({
				hooks: { sensenovaSettings: store },
				edit: (field, text) => controller.edit(field, text),
				save: () => void controller.save(),
				discard: () => controller.discard(),
				addAccount: () => controller.addAccount(),
				removeAccount: (id) => controller.removeAccount(id),
				editAccountLabel: (id, text) => controller.editAccountLabel(id, text),
				editAccountKey: (id, text) => controller.editAccountKey(id, text),
				toggleAccountKeyClear: (id) => controller.toggleAccountKeyClear(id),
				editDefaultKey: (text) => controller.editDefaultKey(text),
				toggleDefaultKeyClear: () => controller.toggleDefaultKeyClear(),
				setActiveAccount: (id) => controller.setActiveAccount(id),
				setQuotaRotation: (on) => controller.setQuotaRotation(on),
				setErrorLog: (on) => controller.setErrorLog(on),
				refreshErrorLog: () => void controller.refreshErrorLog(),
				toggleErrorLogRow: (index) => controller.toggleErrorLogRow(index),
				refreshModelInfo: () => void controller.refreshModelInfo(),
				setRetryMode: (mode) => controller.setRetryMode(mode),
				editRetry: (field, text) => controller.editRetry(field, text),
				editPool: (field, text) => controller.editPool(field, text)
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "sensenova",
				order: 13,
				label: () => ctx.locale.bind("settings.sensenova")("nav"),
				locale: "settings.sensenova",
				inject: injected
			}, SenseNovaSection));
			ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({
				name: "settings.models.provider-card",
				key: "llm-sensenova",
				locale: "settings.sensenova",
				inject: () => ({
					hooks: { sensenovaSettings: store },
					edit: (field, text) => controller.edit(field, text),
					save: () => void controller.save()
				})
			}, SenseNovaProviderCard));
		}
		const inject = [
			"slots",
			"locale",
			"connection",
			"remote",
			"configForms"
		];
		function apply(ctx) {
			injectPageCss();
			ctx.effect(() => ctx.locale.register("settings.sensenova", {
				zh,
				en
			}), "dsh-sensenova-freeapi: page copy");
			const legacy = adaptLegacyCredentials(ctx.connection?.api?.credentials);
			if (legacy !== void 0) {
				applyClientSurfaces(ctx, legacy);
				return;
			}
			ctx.inject(["remote.credentials"], (remoteCtx) => {
				applyClientSurfaces(remoteCtx, remoteCtx.remote.credentials);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map