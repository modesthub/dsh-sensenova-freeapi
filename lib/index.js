import z from "@deepseek-ai/schemastery";
import { LlmAdapter, LlmError, ReasoningEffortId, assertUsableApiKey, attributionHeaders, errorChain, offloadedImageText, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
//#region src/accounts.ts
/**
* SenseNova provider 的多账号池（host 侧，精简版）。
*
* 与参考插件 @mars-sea/dsh-commandcode-provider 的账号池相比，本实现只保留
* 「401 禁用轮换」这一项能力：429 不做冷却（渠道常态性 RPM 瞬时超限，由宿主
* 重试层退避后原 key 重试），没有 probeWindow、FiveHourWindowProbe、plan、
* login 等任何无关功能。
*
* 轮换状态以 API key 字符串为键（key 原文永不写日志、不发往任何第三方）。
* 同一个 key 被多个槽位引用时共享一条状态；key 在凭据服务中被改值后是
* 新键、状态自然清零。状态只存内存，不持久化，重启后全部恢复可用。
*
* 本模块刻意不依赖 cordis：宿主事实一律通过注入 thunk 进入，node 测试可
* 直接驱动。
*
* @module dsh-sensenova-freeapi/accounts
*/
/** 该状态此刻能否服务请求。undefined（从未被拒绝）或非 disabled 视为可用。 */
function accountUsable(state) {
	return state === void 0 || state.kind !== "disabled";
}
/** 选择此刻应服务的账户：优先 preferredId（可用时），否则首个可用；全部不可用返回 undefined。 */
function selectActiveAccount(accounts, preferredId) {
	const usable = accounts.filter((account) => accountUsable(account.state));
	if (preferredId !== void 0 && preferredId !== "") {
		const preferred = usable.find((account) => account.slot.id === preferredId);
		if (preferred !== void 0) return preferred;
	}
	return usable[0];
}
/**
* 解析 HTTP Retry-After（延迟秒数或 HTTP-date）为毫秒；缺失/不可解析返回 undefined。
* HTTP-date 早于 now 时返回 0（调用方自行丢弃）。
*/
function parseRetryAfterMs(value, now = Date.now()) {
	if (value === void 0 || value === null) return void 0;
	const trimmed = value.trim();
	if (trimmed === "") return void 0;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) {
		const ms = Math.round(seconds * 1e3);
		return Number.isFinite(ms) ? ms : void 0;
	}
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) return Math.max(0, date - now);
}
/**
* 记录一次拒绝。`invalid-credential`（401）永久禁用。
* `rate-limit` 与 `quota-exhausted`（429，含 quotaRotation 开启时的配额类粘性换 key）
* 不写任何状态：SenseNova 渠道常态性限流不代表账号异常，任何 429 都不冷却、
* 不禁用账号（design D1/D5，2026-09-04 实测）；配额类粘性换 key 只选取下一把
* 可用 key，被拒 key 保持可用。状态写入 `states`（以 key 为键），便于测试直接驱动。
*/
function markRejected(states, key, rejection, _retryAfterMs) {
	if (rejection === "invalid-credential") states.set(key, {
		kind: "disabled",
		until: 0
	});
}
/** SenseNova 多账号池：以 key 为键的轮换状态 + 解析/选择/拒绝。 */
var SensenovaAccountPool = class {
	deps;
	/** 以 API key 为键的轮换状态（key 原文不落日志）。 */
	states = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	/** 解析每个槽位的 key 并按 key 去重（首个槽位胜出）；无 key 的槽位被忽略。 */
	async resolvedAccounts() {
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		for (const slot of this.deps.slots()) {
			const key = await slot.resolveKey();
			if (key === void 0 || key === "") continue;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				slot,
				key,
				state: this.states.get(key)
			});
		}
		return out;
	}
	/**
	* 发放一个可用 key：优先 preferredId（可用时）否则首个可用。
	* 没有任何 key 解析出来 → 返回 undefined（调用方报 MISSING_CREDENTIAL）。
	* 全部不可用（全 disabled，仅 401 产生）→ INVALID_CREDENTIAL。
	* `options.exclude` 跳过某个 key（401 / 配额轮换时排除刚被拒绝的 key）。
	*
	* 🔴 **轮换必须从被排除项的下一个位置开始环回**（2026-09-18 修复）。
	* 旧写法是 `all.filter(k => k.key !== exclude)` 后取首选 —— 排除 default 会选中
	* `account-2`，再排除 `account-2` 又绕回 default（它仍是过滤后列表的首项），
	* 于是**列表首项与第二项之间乒乓，第 3 个及之后的槽位永远轮不到**。
	* 实测证据：用户配了 3 把 key（default / account-2 / account-3，三把哈希互异且
	* 均可用），而 9265 条 429 日志里只出现 **2 个账号指纹**（`f9145012` 4868 次、
	* `8cfe88e5` 4397 次，各占约一半），`account-3` 的指纹 `543bfdaf` **一次都没有**。
	*/
	async resolveKey(options) {
		const all = await this.resolvedAccounts();
		if (all.length === 0) return void 0;
		const start = ((options?.exclude !== void 0 ? all.findIndex((account) => account.key === options.exclude) + 1 : 0) % all.length + all.length) % all.length;
		const ordered = start === 0 ? all : [...all.slice(start), ...all.slice(0, start)];
		const candidates = options?.exclude !== void 0 ? ordered.filter((account) => account.key !== options.exclude) : ordered;
		if (candidates.length === 0) return void 0;
		const chosen = selectActiveAccount(candidates, this.deps.preferredId?.());
		if (chosen !== void 0) return {
			key: chosen.key,
			slot: chosen.slot
		};
		throw new LlmError(`llm-sensenova: every configured SenseNova account (${all.length}) was rejected with 401 — check the stored API keys；已配置的 ${all.length} 个 SenseNova 账户密钥均被拒绝（401）——请在设置页检查存储的 API 密钥`, "INVALID_CREDENTIAL");
	}
	/** 记录一次拒绝（委托给模块级 markRejected，共享同一状态 Map）。 */
	markRejected(key, rejection, retryAfterMs) {
		markRejected(this.states, key, rejection, retryAfterMs);
	}
};
//#endregion
//#region src/brand.ts
/**
* Brand a string as a {@link ToolCallId}.
* @param id - the provider-issued or synthesized call id.
* @returns the same string with the compile-time tool-call-id brand.
*/
function ToolCallId(id) {
	return id;
}
//#endregion
//#region src/concurrency.ts
/** 排队超时默认值（毫秒）。2026-09-04 实测：与 TPM 60s 窗口对齐（design D4/D6）。 */
const DEFAULT_QUEUE_TIMEOUT_MS = 6e4;
/** 把配置的并发上限归一化为正整数：非整数、负数或无法解析一律回退 1。 */
function normalizeConcurrencyLimit(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}
/** 排队/等待期间中止时抛出的取消错误（不占额度）。 */
function concurrencyAbortError() {
	return new DOMException("The operation was aborted.", "AbortError");
}
/** 排队超时抛出的超时错误（不占额度；adapter 层映射为可重试 LlmError 'TIMEOUT'）。 */
function concurrencyQueueTimeoutError() {
	return new DOMException("The operation was timed out.", "TimeoutError");
}
/**
* 按 key 隔离的并发闸：`acquire(key, limit, signal?, queueTimeoutMs?)` 在额度
* 允许时立即返回 `release()`；达到上限时按 FIFO 排队，前序释放后唤起队首。
* 排队期间 signal 中止则 reject 取消错误且不占额度；排队超过 `queueTimeoutMs`
* （非法值回退默认 60s）则以可重试 TimeoutError reject，同样不占额度、从队列
* 移除并清 abort listener。release 幂等，排空后惰性删除 key 条目。
*/
var KeyedConcurrencyGate = class {
	states = /* @__PURE__ */ new Map();
	acquire(key, limit, signal, queueTimeoutMs) {
		const capacity = normalizeConcurrencyLimit(limit);
		const timeoutMs = typeof queueTimeoutMs === "number" && Number.isFinite(queueTimeoutMs) && queueTimeoutMs > 0 ? queueTimeoutMs : DEFAULT_QUEUE_TIMEOUT_MS;
		if (signal?.aborted) return Promise.reject(concurrencyAbortError());
		let state = this.states.get(key);
		if (state === void 0) {
			state = {
				inFlight: 0,
				queue: []
			};
			this.states.set(key, state);
		}
		if (state.inFlight < capacity) {
			state.inFlight += 1;
			return Promise.resolve(this.releaseOf(key, state));
		}
		return new Promise((resolve, reject) => {
			let timer;
			const entry = {
				signal,
				resolve: () => {
					if (timer !== void 0) clearTimeout(timer);
					if (entry.signal !== void 0) entry.signal.removeEventListener("abort", entry.onAbort);
					state.inFlight += 1;
					resolve(this.releaseOf(key, state));
				},
				reject: (error) => {
					if (timer !== void 0) clearTimeout(timer);
					if (entry.signal !== void 0) entry.signal.removeEventListener("abort", entry.onAbort);
					reject(error);
				},
				onAbort: () => {
					if (timer !== void 0) clearTimeout(timer);
					const index = state.queue.indexOf(entry);
					if (index >= 0) state.queue.splice(index, 1);
					reject(concurrencyAbortError());
				}
			};
			const onTimeout = () => {
				const index = state.queue.indexOf(entry);
				if (index >= 0) state.queue.splice(index, 1);
				if (entry.signal !== void 0) entry.signal.removeEventListener("abort", entry.onAbort);
				reject(concurrencyQueueTimeoutError());
			};
			state.queue.push(entry);
			timer = setTimeout(onTimeout, timeoutMs);
			if (signal !== void 0) if (signal.aborted) entry.onAbort();
			else signal.addEventListener("abort", entry.onAbort, { once: true });
		});
	}
	/**
	* **非阻塞**获取额度：有额度立即返回 `release`，否则返回 `undefined`（**不排队**）。
	*
	* 2026-09-27 新增，专供「阻塞态 key 的恢复探测」使用：
	*   - 探测必须避开该 key 上正在飞行的 agent 请求 —— 否则探测拿到的 429 可能来自
	*     agent 请求造成的瞬时压力，而非该 key 的真实配额状态，结论不可信；
	*   - 排队等待又毫无意义 —— 拿不到额度就跳过这一轮，等下次 tick 再来。
	* 复用同一份 `inFlight` 计数即天然满足该约束，比另建一套探测专用计数更可靠。
	*/
	tryAcquire(key, limit) {
		const capacity = normalizeConcurrencyLimit(limit);
		let state = this.states.get(key);
		if (state === void 0) {
			state = {
				inFlight: 0,
				queue: []
			};
			this.states.set(key, state);
		}
		if (state.inFlight >= capacity) return void 0;
		state.inFlight += 1;
		return this.releaseOf(key, state);
	}
	releaseOf(key, state) {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			state.inFlight -= 1;
			const next = state.queue.shift();
			if (next !== void 0) next.resolve();
			else if (state.inFlight === 0) this.states.delete(key);
		};
	}
};
/** 日志文件相对 DSH home 的路径段。 */
const ERROR_LOG_SEGMENTS = ["logs", "sensenova-errors.jsonl"];
/**
* 把敏感值折叠成稳定短指纹（sha256 前 8 位十六进制）。
* @param value - 原始值；undefined/空串返回空串。
* @returns 8 位十六进制指纹。
*/
function fingerprint(value) {
	if (value === void 0 || value === "") return "";
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
/**
* 从 429 响应体里取原始 `error.code`（数字与字符串都归一成字符串）。
* @param bodyText - 响应体原文。
* @returns code 字符串；缺失或非 JSON 体返回空串。
*/
function extractErrorCode(bodyText) {
	try {
		const parsed = JSON.parse(bodyText);
		if (typeof parsed !== "object" || parsed === null) return "";
		const error = parsed.error;
		if (typeof error !== "object" || error === null) return "";
		const code = error.code;
		if (typeof code === "string") return code;
		if (typeof code === "number" && Number.isFinite(code)) return String(code);
		return "";
	} catch {
		return "";
	}
}
/**
* 压缩一段文本成单行摘要（折叠空白 + 截断）。
* @param text - 原始文本。
* @param maxChars - 长度上限，缺省 {@link ERROR_LOG_MESSAGE_MAX_CHARS}。
* @returns 单行摘要。
*/
function summarize(text, maxChars = 200) {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars)}…`;
}
/**
* 解析 DSH home（`$DSH_HOME` 非空优先，否则 `~/.dsh`）。
* @param env - 环境映射（测试可注入）。
* @returns 绝对路径。
*/
function resolveDshHome(env = process.env) {
	const fromEnv = env.DSH_HOME;
	return fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : join(homedir(), ".dsh");
}
/**
* 默认日志文件绝对路径：`$DSH_HOME/logs/sensenova-errors.jsonl`。
* @param env - 环境映射（测试可注入）。
* @returns 绝对路径。
*/
function defaultErrorLogPath(env = process.env) {
	return join(resolveDshHome(env), ...ERROR_LOG_SEGMENTS);
}
/** 滚动目标路径：`sensenova-errors.jsonl` → `sensenova-errors.1.jsonl`。 */
function rolledPath(filePath) {
	const suffix = ".jsonl";
	return filePath.endsWith(suffix) ? `${filePath.slice(0, -6)}.1${suffix}` : `${filePath}.1`;
}
/** 文件当前字节数；不存在（或不可 stat）按 0 处理。 */
async function fileSize(filePath) {
	try {
		return (await stat(filePath)).size;
	} catch {
		return 0;
	}
}
/**
* 限流事件记录器。
*
* 写入是**串行异步**的：`record()` 同步返回、内部排队落盘，调用方永远不 await
* ⇒ 请求热路径不受磁盘影响。任何写失败都被吞掉，连续失败
* {@link ERROR_LOG_MAX_CONSECUTIVE_FAILURES} 次后自动停用。
*
* ```ts
* const log = new SenseNovaErrorLog();
* log.record({ ... });        // 立即返回
* await log.flush();          // 仅测试/优雅退出需要
* ```
*/
var SenseNovaErrorLog = class {
	filePath;
	maxBytes;
	/** 串行链：保证 append 顺序，并把失败挡在链外继续工作。 */
	chain = Promise.resolve();
	/** 已写入字节数；-1 = 尚未探测（首次写入时 stat 一次）。 */
	bytes = -1;
	failures = 0;
	constructor(options = {}) {
		this.filePath = options.filePath ?? defaultErrorLogPath();
		this.maxBytes = options.maxBytes ?? 5242880;
	}
	/** 当前日志文件绝对路径（诊断用）。 */
	get path() {
		return this.filePath;
	}
	/**
	* 记录一条事件。**同步返回，从不抛出**；写失败静默（连续失败后停用）。
	* @param event - 事件体。
	*/
	record(event) {
		if (this.failures >= 3) return;
		const line = `${JSON.stringify(event)}\n`;
		this.chain = this.chain.then(() => this.append(line)).then(() => {
			this.failures = 0;
		}, () => {
			this.failures += 1;
		});
	}
	/** 等待在途写入结束（测试与优雅退出用）。 */
	async flush() {
		await this.chain;
	}
	async append(line) {
		const size = Buffer.byteLength(line);
		if (this.bytes < 0) {
			await mkdir(dirname(this.filePath), { recursive: true });
			this.bytes = await fileSize(this.filePath);
		}
		if (this.bytes + size > this.maxBytes) {
			await rename(this.filePath, rolledPath(this.filePath)).catch(() => {});
			this.bytes = 0;
		}
		await appendFile(this.filePath, line, "utf8");
		this.bytes += size;
	}
};
//#endregion
//#region src/adapter.ts
/**
* SenseNova（OpenAI 兼容）provider 适配器（host 侧）。
*
* 复用参考插件 @mars-sea/dsh-commandcode-provider 的适配器结构，但只保留
* OpenAI 兼容的目录拉取与 SSE 流式翻译，外加「流开始前的 401 账号轮换」
* （429 不轮换：一个会话固定一个 key，保护服务端按 key 命中的 prompt 缓存，
* 429 交由宿主重试层退避后原 key 重试）。
* 与 pi-ai 的 `toStreamChunks` 不同，这里直接消费 OpenAI SSE（`data:` 行、
* `[DONE]`、`choices[].delta`、`finish_reason`、`usage`），不引入第三方流库。
*
* 适配器刻意不依赖 cordis/schemastery：每请求的连接事实与 key 解析/轮换
* 全部通过构造注入，node 测试可直接驱动。
*
* @module dsh-sensenova-freeapi/adapter
*/
/**
* SenseNova 目录通常不披露上下文字段，这里用 131072 作为合理默认
* （DeepSeek 系列与 SenseNova 常见模型窗口）；目录有字段时优先采用。
*/
const DEFAULT_CONTEXT_WINDOW = 131072;
const MODELS_TIMEOUT_MS = 1e4;
/**
* 非配额 429 的 Retry-After 采信上限（毫秒）：网关头部值超过它就不采信，
* 回落到本地退避。**不再兼任重试策略的退避上限**——那个已拆到
* `RETRY_POLICY_MAX_DELAY_MS`（见下，2026-09-17 拆开以消除悬崖）。
* fix-sensenova-429-quota-retry（2026-09-04 实测）：原 3000ms 与配额窗口量级
* 不符——TPM 为 60 秒窗口，提升到 60000ms（spec 允许区间 60–120s 的下沿）。
*/
const PROVIDER_RETRY_AFTER_CAP_MS = 6e4;
/**
* 本适配器可能吐出的 `providerRetryAfterMs` 绝对上限（毫秒）：宽松上限，
* 防止网关异常 Retry-After 把退避拖到分钟级以外；不影响 TPM 分级档（3–15s）与
* code 8 固定档（15s）的正常取值。
*
* ⚠️ **这个值同时是"悬崖"不变量的一半**：`RETRY_POLICY_MAX_DELAY_MS` 必须 ≥ 它，
* 否则宿主会对落入 (maxDelayMs, ceiling] 区间的 `pra` 直接放弃重试。
* `tests/adapter.test.ts` 有一条断言守住这个不变量。
*/
const QUOTA_RETRY_AFTER_CEILING_MS = 3e5;
/**
* 提交给宿主重试策略的退避单次上限（毫秒），即 `ResolvedRetryPolicy.backoff.maxDelayMs`。
*
* fix-sensenova-429-cliff（2026-09-17 实测）：必须 **≥** 本文件能吐出的
* `providerRetryAfterMs` 上限。宿主 llm-retry 的判断是
* `if (pra > policy.maxDelayMs) { if (mode === 'normal') return next() }`
* —— 超过就**彻底放弃重试**（不是夹到上限），回合立即 error。
*
* 原取值沿用 `PROVIDER_RETRY_AFTER_CAP_MS`（60_000），而上游封顶是
* `QUOTA_RETRY_AFTER_CEILING_MS`（300_000）→ 60~300s 成为"死亡区"：
* 0917 会话里 `pra > 60000` 恰好出现 2 次（turn 25 = 149344、turn 27 = 61696），
* **2/2 都未被重试，正是当天唯二回合失败**。
*
* 现在两者取同一上限 ⇒ `pra > maxDelayMs` **结构性恒为假**，悬崖无法被构造。
* 副作用：`maxDelayMs` 同时是 `localDelay()`（无 pra 时的本地指数退避）的封顶，
* 因此 TIMEOUT 这类无指导的失败，本地退避也会放宽到 300s 上限；仅在连续
* 多次重试后才会接近该值（500ms 起、×2），可接受。
*/
const RETRY_POLICY_MAX_DELAY_MS = QUOTA_RETRY_AFTER_CEILING_MS;
/** 缺省抖动比例＝官方的 `DEFAULT_JITTER_RATIO`。 */
const DEFAULT_RETRY_JITTER_RATIO = .1;
/**
* 缺省重试策略配置：`llm-sensenova.retryPolicy` 未配置时的回落值。
* `index.ts` 的 `RetryPolicyFieldsSchema` 用上面三个标量常量做字段级缺省，
* 避免两处硬编码漂移。
*
* 数值沿革（均为实测驱动，勿凭直觉调小）：
* - `maxRetries: 24`（2026-09-16）：原 10 次 × 短退避累计窗口仅约 33 秒，对分钟级
*   TPM 窗口严重不足，直接导致 **13/16 个回合作废**（`turn/end` reason=error）、
*   8/10 个 subagent 被 429 杀死。429 的代价是"整个回合作废"，比多等几分钟昂贵
*   得多。若仍不足，应走"429 熔断降级到备用模型"而不是继续加次数。
* - `backoff.maxDelayMs: 300_000`（2026-09-17）：与 `QUOTA_RETRY_AFTER_CEILING_MS`
*   对齐以**结构性消除悬崖**（宿主对 `pra > maxDelayMs` 是直接放弃重试，不是夹到
*   上限），详见 `RETRY_POLICY_MAX_DELAY_MS` 的说明。
*/
const DEFAULT_RETRY_POLICY_CONFIG = {
	mode: "normal",
	maxRetries: 24,
	backoff: { maxDelayMs: RETRY_POLICY_MAX_DELAY_MS }
};
/**
* `DEFAULT_RETRY_POLICY_CONFIG` 的解析结果（模块级缓存）。
* `resolveRetryPolicy()` 每次调用都新建 frozen 对象，而 `providerRetryPolicy()`
* 既可能被宿主在注册时调用、也可能被测试反复调用，缓存一份即可。
*/
const FALLBACK_RETRY_POLICY = resolveRetryPolicy(DEFAULT_RETRY_POLICY_CONFIG, "llm-sensenova.retryPolicy");
/** 配额类 429（code 8，rps/rpm exhausted）退避下限（毫秒）。2026-09-04 实测：速率桶补充 ≈1 个/14s，15s 覆盖一个完整补充周期。 */
const QUOTA_RATE_RETRY_FLOOR_MS = 15e3;
/** 已知不可路由的模型 id 清单（已下线路由，调用返回 404/403）。 */
const KNOWN_UNROUTABLE_MODELS = new Set(["sensenova-6.7-flash-lite", "deepseek-v4.1-flash"]);
/** 明确的模型不可用错误码（不在默认可重试集合内，故不触发 provider 重试）。 */
const MODEL_NOT_FOUND_CODE = "MODEL_NOT_FOUND";
/**
* 模型 id → 标准显示名的显式品牌映射。
*
* 🔴 2026-09-23 补齐：此前只有 6.7-flash-lite 一条，其余模型在选择器里显示裸 id
* （`deepseek-flash` / `kimi-k3`），用户无法判断「deepseek-flash」其实是 V4.1。
*/
const DISPLAY_NAME_OVERRIDES = new Map([
	["sensenova-6.7-flash-lite", "Sensenova 6.7 Flash Lite"],
	["sensenova-6.8-flash-lite", "SenseNova 6.8 Flash Lite"],
	["deepseek-v4-flash", "DeepSeek V4 Flash"],
	["deepseek-flash", "DeepSeek V4.1 Flash"],
	["deepseek-v4-pro", "DeepSeek V4 Pro"],
	["glm-5.2", "GLM-5.2"],
	["kimi-k3", "Kimi K3"]
]);
/**
* 模型族推理档位（**值为 API wire 原值，直接透传**）。
*
* 🔴 **2026-09-23 Phase 0 按服务端实测重新标定（131 用例）—— 以 400 报错原文为准，不照文档**：
*
* | 模型 | 服务端权威词表 | 文档口径 | 差异 |
* |---|---|---|---|
* | `sensenova-6.8-flash-lite` | `low medium high xhigh none` | `low medium max high` + none | **文档的 `max` 是错的（实测 400）**；`xhigh` 文档没提但可用 |
* | `deepseek-v4-flash` | `low medium high xhigh none` | `low medium high max` + none | 同上 |
* | `deepseek-flash`(v4.1) | 全 7 档均通过 | `none low high max` | 文档漏了 `medium`/`xhigh`/`minimal` |
* | `glm-5.2` | 全 7 档均通过 | 全 7 档 | ✅ 一致 |
* | `kimi-k3` | 全 7 档均通过 | `low medium high max` | 文档漏了 `minimal`/`xhigh`/`none` |
*
* ⚠️ **`max` 绝不能加给 lite / v4**：服务端原文
* `field ReasoningEffort invalid, should be one of: low, medium, high, xhigh, none`。
* 照文档加上去 ⇒ 用户一选到它就吃 400。
*
* ⚠️ **`deepseek-v4-pro` 未在 Phase 0 复测**（不在本次 5 模型范围），**原值保留不动** ——
* 不引入未经实测的值。
*
* 数组顺序 = UI 展示顺序。`none` 一律排首位，对齐官方 `llm-deepseek` 的
* `Off / Low / High / Max` 范式（`packages/llm/llm-deepseek/src/model-info.ts:9-40`）。
*/
const KNOWN_EFFORTS = new Map([
	["sensenova-6.8-flash-lite", [
		"none",
		"low",
		"medium",
		"high",
		"xhigh"
	]],
	["deepseek-v4-flash", [
		"none",
		"low",
		"medium",
		"high",
		"xhigh"
	]],
	["deepseek-flash", [
		"none",
		"low",
		"medium",
		"high",
		"xhigh",
		"minimal",
		"max"
	]],
	["deepseek-v4-pro", [
		"low",
		"high",
		"max"
	]],
	["glm-5.2", [
		"none",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	]],
	["kimi-k3", [
		"none",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max"
	]]
]);
const EMPTY_MODEL_SELECTION = {
	include: [],
	exclude: []
};
/**
* 官方文档确认支持视觉的模型表。**两种情形都要登记**：
*
* 1. **元数据滞后**：`/v1/models` 未标 `image`（如 kimi-k3，实测其
*    `input_modalities` 只有 `["text"]`，但原生多模态、只吃 Base64 Data-URL）。
* 2. **目录未加载**（2026-09-20 端到端实测新增）：`resolveModel` 在目录还没拉到时
*    走 `inputModalitiesFrom({}, model)` 兜底。**兜底若返回 `['text']`，宿主会把
*    该模型当成纯文本模型**，后果有二 ——
*    ① `session-controller` 的入站闸门（`commands.ts:338`）直接拒收图片，
*       报 `session/attachment-invalid / MODEL_DOES_NOT_SUPPORT_IMAGES`，
*       UI 文案是"当前模型不支持图片，请切换支持图片的模型"；
*    ② 就算绕过入站，`llm` 服务的 gate 也会把图片投影成文本占位。
*    ⇒ **刚启动 `dsh web`、模型选择器还没打开过时贴图会被误拒**，
*    而这与模型的真实能力无关（网关 `input_modalities` 明确含 image）。
*
* 登记在此的模型：目录拉到后仍按目录声明走（含 image 时去重不重复加）；
* 目录未加载时由本表保证能力不退化。
*/
const DOCUMENTED_VISION_MODELS = new Set([
	"kimi-k3",
	"sensenova-6.8-flash-lite",
	"deepseek-flash"
]);
/**
* 文档确认**没有**视觉能力的模型（**不得**进入 `DOCUMENTED_VISION_MODELS`）。
*
* 2026-09-23 Phase 0 实测，两个「无视觉」模型收图后的行为**完全不同**，必须区分对待：
*
* | 模型 | 行为 | 证据 |
* |---|---|---|
* | `deepseek-v4-flash` | 🔴 **静默丢弃 + 会幻觉** | 同图两次：一次答「有一个由小点组成的**心形**图案，数字是**"9"**」（完整编造） |
* | `glm-5.2` | ✅ **诚实拒答** | 两次均明确「我无法直接看到您提到的图片…不具备处理或识别图像的能力」 |
*
* 量化铁证：v4-flash 带图 `prompt_tokens = 109` vs **纯文本对照 `14`** ⇒
* **图片被网关接受并计费了，但模型不使用它** ⇒ 模型按语义自锚定编内容。
*
* 本表**不参与能力上报**（不改变 `inputModalities`，那些模型仍是 `['text']`），
* 仅供设置页「当前模型」面板显示警示文案，避免用户贴图后拿到幻觉答案却毫无报错。
*/
const DOCUMENTED_TEXT_ONLY_MODELS = new Set(["deepseek-v4-flash", "glm-5.2"]);
/**
* 模型级输出预算覆盖（token）。
*
* 规则：**`min(服务端实测上限, 131072)`**，2026-09-23 Phase 0 用「超限值触发 400
* 读报错原文」拿到服务端权威区间：
*
* | 模型 | 服务端区间（400 原文） | 文档口径 | 决策 |
* |---|---|---|---|
* | `sensenova-6.8-flash-lite` | `[1, 65536]` | 默认 65535，范围一致 | **65536** |
* | `deepseek-v4-flash` | `[1, 384000]` | 未给范围 | **131072** |
* | `deepseek-flash`(v4.1) | `[1, 393216]` | 范围一致 | **131072** |
* | `glm-5.2` | `[1, 131072]` | 范围一致 | **131072** |
* | `kimi-k3` | `[1, 1048576]` | 默认 128K | **131072** |
*
* **为什么取 `min(上限, 131072)` 而不是服务端最大值**：
* 上报的 `defaultMaxTokens` 会被宿主**物化成真发出去的 `max_tokens`**
* （`@deepseek-ai/dsh-llm/src/index.ts:881`）。它是**上限**不是**目标** ——
* 调大不会强制生成长文本；但它是「失控生成」的天花板，而**思考 token 与输出共享
* 这份预算** ⇒ 上限越高，最坏情况的 TPM 冲击越大。
* 131072 恰好等于各模型文档给出的「思考模式默认预算」，既不截断思考，也不留
* 384K / 1M 的尾部风险。规则只有一条，不必逐模型论证。
*
* ⚠️ 兜底语义：用户在 agent preset 里设了 `maxTokens` 时会**覆盖**本表
* （`AgentOptions.maxTokens`，`packages/core/agent/src/runtime-types.ts:26-35`）。
* 本表只是「没人指定时」的默认值。
*/
const MODEL_MAX_OUTPUT_OVERRIDES = new Map([
	["sensenova-6.8-flash-lite", 65536],
	["deepseek-v4-flash", 131072],
	["deepseek-flash", 131072],
	["glm-5.2", 131072],
	["kimi-k3", 131072]
]);
/**
* 模型级上下文窗口覆盖（token）。
*
* 目的与 `MODEL_MAX_OUTPUT_OVERRIDES` 相同：**冷目录下能力不退化**。
* `resolveModel` 不会主动拉目录（只有 `listModels` 会），因此首次打开模型选择器时
* 只能拿到 `DEFAULT_CONTEXT_WINDOW`（131072）—— 对全部 5 个模型都是错的
* （4 个是 1M、lite 是 262144）。目录热时以目录为准（本表不覆盖目录已给的更小值，
* 见 `resolveModel` 的取值顺序）。
*
* 数据来源：2026-09-23 目录实测 + 文档示例，两处一致。
*/
const MODEL_CONTEXT_OVERRIDES = new Map([
	["sensenova-6.8-flash-lite", 262144],
	["deepseek-v4-flash", 1048576],
	["deepseek-flash", 1048576],
	["glm-5.2", 1048576],
	["kimi-k3", 1048576]
]);
/**
* 每模型允许注入的 L2 参数白名单。
*
* 🔴 **2026-09-23 Phase 0 实测得出 —— 绝不能"把文档里所有参数一次性注入"**：
*
* - **`kimi-k3` 全部排除**：传 `frequency_penalty: 0.5` → 400
*   `field FrequencyPenalty invalid, only 0 is allowed for this model`；
*   其文档还写明 `temperature` 固定 1、`top_p` 固定 0.95 ⇒ 注入只会制造失败。
* - **`n` 不在候选集里**：实测 v4 / v4.1 / kimi 上 `n:2` 被**静默降到 1**
*   （`choices.length === 1`），只在 lite 真生效；而且它是 v4
*   「`n` + `parallel_tool_calls` + `response_format` 三者同时 → 400」的参与者。
*   DSH 不需要多候选 ⇒ **不提供该参数**。
* - **`do_sample` 只有 glm-5.2 有**（其文档独有字段）。
* - `8.9-flash-lite` / `deepseek-v4-flash` / `deepseek-flash` / `glm-5.2`
*   的 `top_p` + 频率惩罚 + 存在惩罚 + `seed` 组合实测 **200 通过**。
* - 表外模型（未来新增）**一律不注入**：宁可少发，不要因未知能力吃 400。
*/
const MODEL_L2_PARAM_SUPPORT = new Map([
	["sensenova-6.8-flash-lite", new Set([
		"top_p",
		"frequency_penalty",
		"presence_penalty",
		"seed"
	])],
	["deepseek-v4-flash", new Set([
		"top_p",
		"frequency_penalty",
		"presence_penalty",
		"seed"
	])],
	["deepseek-flash", new Set([
		"top_p",
		"frequency_penalty",
		"presence_penalty",
		"seed"
	])],
	["glm-5.2", new Set([
		"top_p",
		"frequency_penalty",
		"presence_penalty",
		"seed",
		"do_sample"
	])],
	["kimi-k3", /* @__PURE__ */ new Set()]
]);
/**
* 按模型白名单过滤 L2 参数，产出可直接并入请求体的字段。
*
* @param model - wire 模型 id。
* @param params - 连接级配置取值。
* @returns 仅含该模型允许且确实配置了的字段；表外模型返回空对象。
*/
function l2ParamsFor(model, params) {
	const allowed = MODEL_L2_PARAM_SUPPORT.get(model);
	if (allowed === void 0) return {};
	const out = {};
	if (allowed.has("top_p") && params.topP !== void 0) out.top_p = params.topP;
	if (allowed.has("frequency_penalty") && params.frequencyPenalty !== void 0) out.frequency_penalty = params.frequencyPenalty;
	if (allowed.has("presence_penalty") && params.presencePenalty !== void 0) out.presence_penalty = params.presencePenalty;
	if (allowed.has("seed") && params.seed !== void 0) out.seed = params.seed;
	if (allowed.has("do_sample") && params.doSample !== void 0) out.do_sample = params.doSample;
	return out;
}
/**
* 默认图片预算（对齐 DSH llm-pi-ai 默认：2048² 像素 / 1MB 编码目标）。
*
* 2026-09-17：此前 adapter.ts 与 index.ts 各写了一份字面量（值相同），
* `tsc --noEmit` 的 `noUnusedLocals` 把 adapter 这份判为死代码。改为导出后由
* index.ts 引用，既消除重复又保留单一事实来源。
*/
const DEFAULT_IMAGE_POLICY = {
	maxPixels: 2048 * 2048,
	maxBytes: 1024 * 1024
};
/**
* 由图片自身尺寸求出请求目标，并**同时带上 0.1.5 的 `maxPixels`** ⇒ 同一份返回值
* 在 0.1.5（读 `maxPixels`/`maxBytes`）与 0.1.6（读 `width`/`height`/`maxBytes`）上
* 都能通过校验，降级回 0.1.5 不必回滚本文件。
*
* 尺寸投影刻意复刻 harness `@deepseek-ai/dsh-attachment` 的 `requestImageDimensions()`
* （`packages/attachment/attachment/src/request-projection.ts`）：按 `maxPixels` 等比
* 缩放、长边取地板/短边取四舍五入、再逐像素回退直到不超预算。**不 import 那个包**是
* 为了不新增外部依赖（tsdown 的 external 约定）；代价是这段数学必须与上游保持一致。
*
* @param ref - 持久化图片引用（至少含 `width`/`height`）。
* @param maxPixels - 像素总量预算；缺省 `DEFAULT_IMAGE_POLICY.maxPixels`。
* @param maxBytes - 编码字节目标；缺省 `DEFAULT_IMAGE_POLICY.maxBytes`。
* @returns 0.1.6 形状 + `maxPixels` 兼容字段。
*/
function requestImageTarget(ref, maxPixels = DEFAULT_IMAGE_POLICY.maxPixels, maxBytes = DEFAULT_IMAGE_POLICY.maxBytes) {
	const { width, height } = ref;
	if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return {
		width: 1,
		height: 1,
		maxBytes,
		maxPixels
	};
	const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
	if (scale === 1) return {
		width,
		height,
		maxBytes,
		maxPixels
	};
	if (width >= height) {
		let projectedWidth = Math.max(1, Math.floor(width * scale));
		let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
		while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
			projectedWidth -= 1;
			projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
		}
		return {
			width: projectedWidth,
			height: projectedHeight,
			maxBytes,
			maxPixels
		};
	}
	let projectedHeight = Math.max(1, Math.floor(height * scale));
	let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
	while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
		projectedHeight -= 1;
		projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
	}
	return {
		width: projectedWidth,
		height: projectedHeight,
		maxBytes,
		maxPixels
	};
}
/**
* 造出 adapter 的 `resolveImage` 依赖：把宿主持久化附件读成请求字节。
*
* 抽成独立函数（而不是写成 `index.ts` 里 deps 字面量中的内联箭头函数）是为了**可测**：
* 回归护栏必须贴着真实的 `readImageRequest` 调用点断言第二参数形状；若改成 mock
* `resolveImage` 自身，就永远测不到「契约漂移」这一类失效（本插件 160 个单测当年
* 全绿却线上全丢图，正是这个盲区）。
*
* @param getAttachments - 取当前附件服务；未挂载时返回 undefined。
* @returns 单图解析函数；附件服务缺失时返回 undefined（该图被跳过，正文仍发出）。
*/
function createResolveImage(getAttachments) {
	return async (ref, signal) => {
		const attachments = getAttachments();
		if (attachments === void 0) return void 0;
		const image = await attachments.readImageRequest(ref, requestImageTarget(ref), signal);
		return {
			mediaType: image.mediaType,
			data: image.data
		};
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toString(value) {
	return typeof value === "string" ? value : void 0;
}
function toNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/** 把模型 id 标准化为可读显示名：显式映射优先，否则按品牌前缀回退。 */
function displayNameFor(id) {
	const override = DISPLAY_NAME_OVERRIDES.get(id);
	if (override !== void 0) return override;
	const normalized = id.trim();
	const words = normalized.split(/[-_]+/).filter((part) => part !== "").flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/));
	if (words.length === 0) return normalized;
	return words.map((word) => word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word).join(" ").replace(/\s+/g, " ").trim();
}
/**
* 展平一条 tool 消息的内容为纯文本（OpenAI `role:"tool"` 的 content 是字符串）。
*
* ⚠️ **0.1.7 起不再需要递归**：`ToolResultBlock`（`type: 'tool-result'`）已从
* `ContentBlockMap` 中移除，工具结果改为**一等消息** `ToolResultMessage`
* （`role: 'tool'`）。也就是说内容块不再嵌套工具结果，没有可递归的层级。
*/
function toolResultText(blocks) {
	return blocks.map((block) => {
		if (block.type === "text") return block.text;
		if (block.type === "image" && isOffloadedImage(block)) return offloadedImageText(block.attachment);
		return "";
	}).join("");
}
/** 拼出某条消息的可见文本（`RequestMessage` 含无身份的 `RequestUserInput`，两者都有 `content`）。 */
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/**
* 该图片块是否被宿主标记为「本条请求不要发送」。
*
* 刻意不写成 `block.offloaded === true`：`ImageBlock.offloaded` 是 **0.1.6 新增**的
* 字段（0.1.5 的 `ImageBlock` 只有 `type` + `attachment`）。经这个结构化参数读取，
* 本文件在 0.1.5 与 0.1.6 的类型下都能通过 `tsc`；运行时在 0.1.5 上恒为 `false`，
* 行为退化为改动前的样子 ⇒ **降级回 0.1.5 不需要回滚本插件的源码**。
*/
function isOffloadedImage(block) {
	return block.offloaded === true;
}
/**
* 收集一条消息内容里的图片引用。
*
* ⚠️ **0.1.7 起不再递归**：`ToolResultBlock` 已从 `ContentBlockMap` 移除，工具结果
* 成了一等消息（`role: 'tool'`）⇒ 图片只出现在各消息内容的**顶层**，没有嵌套层级。
* 上层按消息逐条调用本函数，因此工具消息里的图片同样会被收到。
*
* ⚠️ **跳过被 offload 的图片**：那是宿主持久化的「本条请求不要再发图」决定（由
* `compaction-image-offload` 在官方路由触发 `IMAGE_OFFLOAD_REQUIRED` 后写下的
* `image/offload` 事件投影而来）。0.1.6 的契约是**每条路由**都为这些出现位置发送
* 占位文本（见 `ImageBlock.offloaded` 的注释）。若这里照样去解析并发送字节，就会
* 把宿主刻意省掉的图片重新塞回请求里 —— 既违背决定，又可能直接撑爆请求体
* （本路由没有任何总字节预算）。
*/
function collectImageRefs(blocks, refs) {
	for (const block of blocks) if (block.type === "image" && !isOffloadedImage(block)) refs.set(block.attachment.attachmentId, block.attachment);
}
/**
* 把消息历史里的图片预解析为 Base64 Data-URL。
* kimi-k3 只接受 `data:image/...;base64,...`（不支持公网 URL），6.8-flash-lite
* 同样接受 Base64，故统一按 data URL 发送；单图解析失败只跳过该图，不打断请求。
*/
async function prepareImageDataUrls(messages, resolveImage, signal) {
	const refs = /* @__PURE__ */ new Map();
	for (const message of messages) collectImageRefs(message.content, refs);
	const out = /* @__PURE__ */ new Map();
	if (refs.size === 0 || resolveImage === void 0) return out;
	for (const ref of refs.values()) try {
		const resolved = await resolveImage(ref, signal);
		if (resolved !== void 0) out.set(ref.attachmentId, `data:${resolved.mediaType};base64,${Buffer.from(resolved.data).toString("base64")}`);
	} catch {}
	return out;
}
/** 从目录条目读取一个正数能力字段（按优先级），缺失/非法返回 undefined。 */
function firstPositiveNumber(raw, keys) {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
}
function firstContextField(raw) {
	return firstPositiveNumber(raw, [
		"context_length",
		"context_window",
		"max_context_length",
		"contextLength"
	]);
}
function firstMaxOutputField(raw) {
	return firstPositiveNumber(raw, [
		"max_output_length",
		"max_tokens",
		"max_output_tokens",
		"max_completion_tokens",
		"maxTokens",
		"maxOutputTokens",
		"maxCompletionTokens"
	]);
}
/**
* 解析一个模型的输出预算：**静态覆盖表优先，目录字段兜底**。
*
* ⚠️ 目录的 `max_output_length` 被证实不可信（2026-09-23 实测：8/9 模型都是
* `65536` 占位值，把 v4.1 的 131072 与 kimi 的 128K 都压成一半）。
* 因此**已知模型一律走 `MODEL_MAX_OUTPUT_OVERRIDES`**，只有表外的新模型才回落目录值。
*/
function maxOutputFor(raw, modelId) {
	return MODEL_MAX_OUTPUT_OVERRIDES.get(modelId) ?? firstMaxOutputField(raw);
}
/**
* 把目录声明的输入模态映射为宿主 ModelModality 列表；未声明时回退 ['text']。
* 另按 DOCUMENTED_VISION_MODELS 修正滞后的元数据（补 image）。
*/
function inputModalitiesFrom(raw, modelId) {
	const declared = raw.input_modalities;
	const modalities = [];
	if (Array.isArray(declared)) for (const item of declared) {
		const modality = toString(item);
		if (modality === "text" || modality === "image") {
			if (!modalities.includes(modality)) modalities.push(modality);
		}
	}
	if (modelId !== void 0 && DOCUMENTED_VISION_MODELS.has(modelId) && !modalities.includes("image")) modalities.push("image");
	if (!modalities.includes("text")) modalities.unshift("text");
	return modalities;
}
/** 读取目录中的 effort 词表字段；返回字符串数组或 undefined（无明确词表）。 */
function effortListField(raw) {
	for (const key of ["reasoning_efforts", "reasoning_levels"]) {
		const value = raw[key];
		if (Array.isArray(value)) {
			const efforts = value.filter((item) => typeof item === "string" && item !== "");
			if (efforts.length > 0) return efforts;
		}
	}
}
/** 读取嵌套 reasoning.efforts / thinking.efforts 词表；返回字符串数组或 undefined。 */
function nestedEffortListField(raw) {
	for (const key of ["reasoning", "thinking"]) {
		const holder = raw[key];
		if (!isRecord(holder)) continue;
		const efforts = holder.efforts;
		if (Array.isArray(efforts)) {
			const list = efforts.filter((item) => typeof item === "string" && item !== "");
			if (list.length > 0) return list;
		}
	}
}
/** 读取目录中的默认 effort 字段；返回字符串或 undefined。 */
function defaultEffortField(raw) {
	const direct = raw.default_reasoning_effort;
	if (typeof direct === "string" && direct !== "") return direct;
	for (const key of ["reasoning", "thinking"]) {
		const holder = raw[key];
		if (isRecord(holder)) {
			const value = holder.defaultEffort ?? holder.default_effort;
			if (typeof value === "string" && value !== "") return value;
		}
	}
}
/**
* 目录是否**明确排除** reasoning。
*
* 🔴 2026-09-23 语义修正（取代原 `hasReasoningSupport`）：旧逻辑要求「目录必须
* **声明**支持 reasoning」才允许静态表生效。但 Phase 0 实测目录 9/9 模型**都不给
* effort 词表**，而部分目录条目压根没有 `supported_features` 字段 —— 旧逻辑会把
* 「沉默」误判成「不支持」，冷目录下档位选择器因此消失。
*
* 新语义：**只有目录明确列出 `supported_features` 且其中不含 `reasoning`** 才拦下
* 静态表；其余情形（没条目、条目里没这个字段、条目声明了 reasoning）都放行。
* 也就是说：目录的「沉默」不等于「否定」。
*
* @returns true = 目录明确说不支持 reasoning，应隐藏档位。
*/
function catalogExcludesReasoning(raw) {
	const features = raw.supported_features;
	return Array.isArray(features) && !features.includes("reasoning");
}
/**
* 档位展示元数据：wire 原值 → 用户可读文案。
*
* 🔴 2026-09-23 新增。此前 `name` 直接取 wire 原值 ⇒ 选择器里显示小写 `none`，
* 排在 `low/medium/high` **之后**、且无任何说明。实测这正是用户「感觉插件没提供
* 思考开关」的真实原因 —— **开关一直存在，只是长成了裸标识符 + 末位**。
* 对齐官方 `llm-deepseek` 的 `Off / Low / High / Max` 范式
* （`packages/llm/llm-deepseek/src/model-info.ts:9-40`）。
*
* ⚠️ **只有 `name`/`description` 可以改，`id` 必须是 wire 原值** ——
* 本适配器把 `reasoningEffort` 原样透传进请求体（`buildOpenAiBody`），
* 所以 id 写错（例如照抄官方的 `off`）会被服务端 400 拒掉。
*
* 文案语言：`name` 用英文（选择器里空间紧、且与官方 UI 一致），
* `description` 用中文（说明槽位给母语收益最大）。适配器层拿不到客户端 locale，
* 这两处**无法**走插件的 zh/en 本地化。
*/
const EFFORT_LABELS = new Map([
	["none", {
		name: "Off",
		description: "关闭思考通道，直接作答。适合简单问答、内容提取、格式转换，延迟最低。"
	}],
	["minimal", {
		name: "Minimal",
		description: "最轻量思考。仅 glm-5.2 / kimi-k3 / v4.1 接受。"
	}],
	["low", {
		name: "Low",
		description: "轻度推理，延迟与 token 消耗较低。适合简单任务与延迟敏感场景。"
	}],
	["medium", {
		name: "Medium",
		description: "中等推理，在速度与效果之间平衡。适合一般分析与内容生成。"
	}],
	["high", {
		name: "High",
		description: "增强推理，多数模型的服务端默认档。适合常规推理、代码生成。"
	}],
	["xhigh", {
		name: "Extra High",
		description: "更高强度推理。是 6.8-flash-lite 与 v4-flash 的服务端上限档。"
	}],
	["max", {
		name: "Max",
		description: "深度推理，消耗最多 token 与时间。适合复杂推理、长程任务。"
	}]
]);
/**
* 解析一个模型的可选档位。
*
* 优先级：**目录词表 > 静态表**。目录词表实测从未出现过（9/9 模型都不给
* `reasoning_efforts`/`reasoning_levels`），所以实际全部走静态表。
*
* ⚠️ 冷目录必须也能给出档位：`resolveModel` 不会主动拉目录（只有 `listModels` 会），
* 因此首次打开模型选择器时 `raw` 是空记录。空记录 ⇒ 信任静态表；
* 有记录但未声明 reasoning ⇒ 尊重目录（不放档位）。
*/
function reasoningInfoFrom(raw, modelId) {
	const efforts = effortListField(raw) ?? nestedEffortListField(raw);
	const knownEfforts = KNOWN_EFFORTS.get(modelId);
	const selectedEfforts = efforts ?? (knownEfforts !== void 0 && !catalogExcludesReasoning(raw) ? knownEfforts : void 0);
	if (selectedEfforts === void 0 || selectedEfforts.length === 0) return void 0;
	const infos = selectedEfforts.map((effort) => {
		const label = EFFORT_LABELS.get(effort);
		return {
			id: ReasoningEffortId(effort),
			name: label?.name ?? effort,
			...label !== void 0 ? { description: label.description } : {}
		};
	});
	const defaultEffort = efforts !== void 0 ? defaultEffortField(raw) : void 0;
	const defaultId = defaultEffort !== void 0 && selectedEfforts.includes(defaultEffort) ? ReasoningEffortId(defaultEffort) : void 0;
	return {
		efforts: infos,
		...defaultId !== void 0 ? { defaultEffort: defaultId } : {}
	};
}
/** 解析 OpenAI 模型目录为目录条目；应用自动过滤与手动 include/exclude 覆盖。 */
function parseCatalog(value, failedModels, selection) {
	if (!isRecord(value) || !Array.isArray(value.data)) throw new LlmError("llm-sensenova: unexpected models response shape", "PROVIDER_PROTOCOL_ERROR");
	const include = new Set(selection.include);
	const exclude = new Set(selection.exclude);
	const out = [];
	for (const raw of value.data) {
		if (!isRecord(raw)) continue;
		const id = toString(raw.id);
		if (id === void 0 || id === "") continue;
		const output = raw.output_modalities;
		if (!(Array.isArray(output) ? output.some((item) => toString(item) === "text") : false)) continue;
		if (exclude.has(id)) continue;
		if (!include.has(id)) {
			if (KNOWN_UNROUTABLE_MODELS.has(id)) continue;
			if (failedModels.has(id)) continue;
		}
		const contextWindow = firstContextField(raw);
		const maxOutputTokens = maxOutputFor(raw, id);
		const reasoning = reasoningInfoFrom(raw, id);
		out.push({
			id,
			name: displayNameFor(id),
			inputModalities: inputModalitiesFrom(raw, id),
			...contextWindow !== void 0 ? { contextWindow } : {},
			...maxOutputTokens !== void 0 ? { maxOutputTokens } : {},
			...reasoning !== void 0 ? { reasoning } : {}
		});
	}
	return out;
}
/** 把 OpenAI 消息历史翻译为 OpenAI 请求体消息数组（imageData：附件 id → Base64 Data-URL）。 */
function toOpenAiMessages(options, imageData) {
	const systemParts = [];
	if (options.system !== void 0 && options.system !== "") systemParts.push(options.system);
	for (const message of options.messages) if (message.role === "system" || message.role === "developer") systemParts.push(flattenText(message));
	const systemText = systemParts.filter(Boolean).join("\n\n");
	const messages = [];
	if (systemText !== "") messages.push({
		role: "system",
		content: systemText
	});
	const toolCallIdRemap = /* @__PURE__ */ new Map();
	let syntheticToolCallSeq = 0;
	for (const message of options.messages) {
		if (message.role === "system" || message.role === "developer") continue;
		if (message.role === "tool") {
			const remappedId = toolCallIdRemap.get(message.toolCallId);
			if (remappedId === void 0) continue;
			messages.push({
				role: "tool",
				tool_call_id: remappedId,
				content: toolResultText(message.content) || "(no output)"
			});
			continue;
		}
		if (message.role === "assistant") {
			const text = flattenText(message);
			const toolCalls = message.content.filter((block) => block.type === "tool-call");
			const sanitizedCalls = [];
			for (const call of toolCalls) {
				if (call.name === "" || call.name === void 0) continue;
				syntheticToolCallSeq += 1;
				const keptId = call.id !== "" && call.id !== void 0 ? call.id : `sensenova-sanitized-${syntheticToolCallSeq}`;
				toolCallIdRemap.set(call.id, keptId);
				sanitizedCalls.push({
					id: keptId,
					type: "function",
					function: {
						name: call.name,
						arguments: call.arguments !== "" && call.arguments !== void 0 ? call.arguments : "{}"
					}
				});
			}
			if (text === "" && sanitizedCalls.length === 0) continue;
			const entry = {
				role: "assistant",
				content: text !== "" ? text : null
			};
			if (sanitizedCalls.length > 0) entry.tool_calls = sanitizedCalls;
			messages.push(entry);
			continue;
		}
		const text = flattenText(message);
		const images = [];
		const omitted = [];
		for (const block of message.content) {
			if (block.type !== "image") continue;
			if (isOffloadedImage(block)) {
				omitted.push(offloadedImageText(block.attachment));
				continue;
			}
			const url = imageData.get(block.attachment.attachmentId);
			if (url !== void 0) images.push(url);
		}
		const bodyText = [text, ...omitted].filter((part) => part !== "").join("\n");
		if (images.length > 0) messages.push({
			role: "user",
			content: [...images.map((url) => ({
				type: "image_url",
				image_url: { url }
			})), ...bodyText !== "" ? [{
				type: "text",
				text: bodyText
			}] : []]
		});
		else if (bodyText !== "") messages.push({
			role: "user",
			content: bodyText
		});
	}
	return messages;
}
/** 组装 OpenAI /chat/completions 请求体。 */
function buildOpenAiBody(options, imageData, l2Params) {
	const tools = (options.tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	return {
		model: options.model,
		messages: toOpenAiMessages(options, imageData),
		stream: true,
		stream_options: { include_usage: true },
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.maxTokens !== void 0 ? { max_tokens: options.maxTokens } : {},
		...options.stop !== void 0 && options.stop.length > 0 ? { stop: options.stop } : {},
		...tools.length > 0 ? { tools } : {},
		...options.reasoningEffort !== void 0 ? { reasoning_effort: options.reasoningEffort } : {},
		...l2Params
	};
}
/** OpenAI usage → 宿主 TokenUsage（inputTokens 为未缓存输入，缓存读单独计）。 */
function mapUsage(usage) {
	const prompt = toNumber(usage.prompt_tokens);
	const completion = toNumber(usage.completion_tokens);
	const total = toNumber(usage.total_tokens);
	const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : void 0;
	const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : void 0;
	const cacheRead = promptDetails !== void 0 ? toNumber(promptDetails.cached_tokens) : 0;
	const reasoning = completionDetails !== void 0 ? toNumber(completionDetails.reasoning_tokens) : 0;
	return {
		inputTokens: Math.max(0, prompt - cacheRead),
		outputTokens: completion,
		totalTokens: total > 0 ? total : prompt + completion,
		...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning > 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** OpenAI finish_reason → 宿主 FinishReason。 */
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls":
		case "function_call": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: "SenseNova stream aborted",
				code: "ABORTED"
			}
		};
		default: return { kind: "stop" };
	}
}
/** 解析一行 SSE；返回解析后的数据对象，`[DONE]` 或空行/注释行返回 undefined。 */
function parseSseDataLine(line) {
	let trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":")) return void 0;
	if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
	if (!trimmed || trimmed === "[DONE]") return void 0;
	try {
		return JSON.parse(trimmed);
	} catch {
		return;
	}
}
function createSseState() {
	return {
		nextIndex: 0,
		textIndex: -1,
		textContent: "",
		reasoningIndex: -1,
		reasoningContent: "",
		toolIndexById: /* @__PURE__ */ new Map(),
		toolIndexByProtocolIndex: /* @__PURE__ */ new Map(),
		toolIndexByAnonymousName: /* @__PURE__ */ new Map(),
		lastAnonymousIndex: -1,
		toolIdByIndex: /* @__PURE__ */ new Map(),
		toolNameByIndex: /* @__PURE__ */ new Map(),
		toolArgsByIndex: /* @__PURE__ */ new Map(),
		sawContent: false,
		pendingUsage: void 0,
		usageEmitted: false,
		finished: false
	};
}
function closeText(state) {
	if (state.textIndex < 0) return [];
	const chunk = {
		type: "block-end",
		index: state.textIndex,
		block: {
			type: "text",
			text: state.textContent
		}
	};
	state.textIndex = -1;
	state.textContent = "";
	return [chunk];
}
function closeReasoning(state) {
	if (state.reasoningIndex < 0) return [];
	const chunk = {
		type: "block-end",
		index: state.reasoningIndex,
		block: {
			type: "reasoning",
			text: state.reasoningContent
		}
	};
	state.reasoningIndex = -1;
	state.reasoningContent = "";
	return [chunk];
}
function closeToolCalls(state) {
	const chunks = [];
	for (const [index, args] of [...state.toolArgsByIndex.entries()]) {
		const name = state.toolNameByIndex.get(index) ?? "";
		if (name === "") continue;
		const id = state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`;
		chunks.push({
			type: "block-end",
			index,
			block: {
				type: "tool-call",
				id: ToolCallId(id),
				name,
				arguments: args !== "" ? args : "{}"
			}
		});
	}
	state.toolArgsByIndex.clear();
	state.toolIdByIndex.clear();
	state.toolNameByIndex.clear();
	state.toolIndexById.clear();
	state.toolIndexByProtocolIndex.clear();
	state.toolIndexByAnonymousName.clear();
	state.lastAnonymousIndex = -1;
	return chunks;
}
/** 将事件中的 usage 转成单次 usage chunk，避免 finish/trailing 重复发出。 */
function usageChunksFrom(event, state) {
	if (state.usageEmitted || !isRecord(event)) return [];
	const usageRec = isRecord(event.usage) ? event.usage : void 0;
	if (state.pendingUsage === void 0 && usageRec === void 0) return [];
	const usage = state.pendingUsage ?? mapUsage(usageRec);
	state.pendingUsage = void 0;
	state.usageEmitted = true;
	return [{
		type: "usage",
		usage
	}];
}
/** 处理一个 OpenAI SSE 数据对象，返回对应的宿主 StreamChunk 序列。 */
function processChunkEvent(event, state) {
	if (!isRecord(event)) return [];
	const choices = event.choices;
	if (!Array.isArray(choices)) return usageChunksFrom(event, state);
	const chunks = [];
	for (const rawChoice of choices) {
		if (state.finished) break;
		if (!isRecord(rawChoice)) continue;
		const delta = isRecord(rawChoice.delta) ? rawChoice.delta : void 0;
		const finishReasonRaw = rawChoice.finish_reason;
		const finishReason = typeof finishReasonRaw === "string" && finishReasonRaw !== "" && finishReasonRaw !== "null" ? finishReasonRaw : void 0;
		if (delta !== void 0) {
			const content = toString(delta.content) ?? "";
			const reasoning = toString(delta.reasoning_content) ?? toString(delta.reasoning) ?? "";
			const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : [];
			if (reasoning !== "") {
				chunks.push(...closeText(state));
				if (state.reasoningIndex < 0) {
					state.reasoningIndex = state.nextIndex;
					state.nextIndex += 1;
					chunks.push({
						type: "block-start",
						index: state.reasoningIndex,
						blockType: "reasoning"
					});
				}
				state.reasoningContent += reasoning;
				chunks.push({
					type: "reasoning-delta",
					index: state.reasoningIndex,
					text: reasoning
				});
			}
			if (content !== "") {
				chunks.push(...closeReasoning(state));
				if (state.textIndex < 0) {
					state.textIndex = state.nextIndex;
					state.nextIndex += 1;
					chunks.push({
						type: "block-start",
						index: state.textIndex,
						blockType: "text"
					});
				}
				state.textContent += content;
				state.sawContent = true;
				chunks.push({
					type: "text-delta",
					index: state.textIndex,
					text: content
				});
			}
			for (const tc of toolCalls) {
				const id = toString(tc.id) ?? "";
				const protocolIndex = typeof tc.index === "number" && Number.isInteger(tc.index) ? tc.index : void 0;
				const fn = isRecord(tc.function) ? tc.function : void 0;
				const name = fn !== void 0 ? toString(fn.name) ?? "" : "";
				const argsDelta = fn !== void 0 ? toString(fn.arguments) ?? "" : "";
				let index;
				if (protocolIndex !== void 0) index = state.toolIndexByProtocolIndex.get(protocolIndex);
				else if (id !== "") index = state.toolIndexById.get(id);
				else if (name !== "") index = state.toolIndexByAnonymousName.get(name);
				else index = state.lastAnonymousIndex >= 0 ? state.lastAnonymousIndex : void 0;
				if (index === void 0) {
					chunks.push(...closeText(state), ...closeReasoning(state));
					index = state.nextIndex;
					state.nextIndex += 1;
					if (protocolIndex !== void 0) state.toolIndexByProtocolIndex.set(protocolIndex, index);
					if (id !== "") state.toolIndexById.set(id, index);
					if (name !== "" && protocolIndex === void 0 && id === "") {
						state.toolIndexByAnonymousName.set(name, index);
						state.lastAnonymousIndex = index;
					}
					state.toolIdByIndex.set(index, id);
					state.toolNameByIndex.set(index, name);
					state.toolArgsByIndex.set(index, "");
					chunks.push({
						type: "block-start",
						index,
						blockType: "tool-call"
					});
					state.sawContent = true;
				}
				if (id !== "") {
					state.toolIdByIndex.set(index, id);
					state.toolIndexById.set(id, index);
				}
				if (name !== "") state.toolNameByIndex.set(index, name);
				if (protocolIndex === void 0 && id === "" && name !== "") {
					state.toolIndexByAnonymousName.set(name, index);
					state.lastAnonymousIndex = index;
				}
				const accumulated = (state.toolArgsByIndex.get(index) ?? "") + argsDelta;
				state.toolArgsByIndex.set(index, accumulated);
				const effectiveName = state.toolNameByIndex.get(index) ?? "";
				chunks.push({
					type: "tool-call-delta",
					index,
					id: ToolCallId(state.toolIdByIndex.get(index) ?? `sensenova-tool-${index}`),
					...effectiveName !== "" ? { name: effectiveName } : {},
					argumentsDelta: argsDelta
				});
			}
		}
		if (finishReason !== void 0) {
			state.finished = true;
			chunks.push(...closeText(state), ...closeReasoning(state), ...closeToolCalls(state));
			chunks.push(...usageChunksFrom(event, state));
			chunks.push({
				type: "finish",
				reason: mapFinishReason(finishReason)
			});
			continue;
		}
		const usageRec = isRecord(event.usage) ? event.usage : void 0;
		if (usageRec !== void 0 && state.pendingUsage === void 0) state.pendingUsage = mapUsage(usageRec);
	}
	return chunks;
}
/** 把 OpenAI SSE 响应体翻译为宿主 StreamChunk 序列。 */
async function* parseOpenAiSse(body, signal, idleTimeoutMs) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state = createSseState();
	let buffer = "";
	let finished = false;
	let watchdogReject;
	let watchdogTimer;
	const armWatchdog = () => {
		if (watchdogTimer !== void 0) clearTimeout(watchdogTimer);
		watchdogTimer = setTimeout(() => {
			watchdogReject?.(new DOMException(`SenseNova stream idle for ${idleTimeoutMs}ms`, "TimeoutError"));
		}, idleTimeoutMs);
	};
	const disarmWatchdog = () => {
		if (watchdogTimer !== void 0) {
			clearTimeout(watchdogTimer);
			watchdogTimer = void 0;
		}
	};
	try {
		for (;;) {
			const read = await new Promise((resolve, reject) => {
				watchdogReject = reject;
				reader.read().then(resolve, reject);
				armWatchdog();
			});
			disarmWatchdog();
			const { done, value } = read;
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const event = parseSseDataLine(line);
				if (event === void 0) continue;
				if (finished) {
					for (const chunk of usageChunksFrom(event, state)) yield chunk;
					continue;
				}
				for (const chunk of processChunkEvent(event, state)) {
					yield chunk;
					if (chunk.type === "finish") finished = true;
				}
			}
		}
		if (buffer.trim() !== "") {
			const event = parseSseDataLine(buffer);
			if (event !== void 0) if (finished) for (const chunk of usageChunksFrom(event, state)) yield chunk;
			else for (const chunk of processChunkEvent(event, state)) {
				yield chunk;
				if (chunk.type === "finish") finished = true;
			}
		}
		if (!finished) {
			const trailing = [
				...closeText(state),
				...closeReasoning(state),
				...closeToolCalls(state)
			];
			for (const chunk of trailing) yield chunk;
			if (!state.sawContent) throw new LlmError("llm-sensenova: SenseNova returned an empty response；SenseNova 返回了空响应，重试通常可恢复", "EMPTY_RESPONSE");
			if (state.pendingUsage !== void 0) yield {
				type: "usage",
				usage: state.pendingUsage
			};
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
		}
	} catch (error) {
		if (signal?.aborted && isTimeoutReason(signal.reason) || isTimeoutReason(error)) throw new LlmError(`llm-sensenova: SenseNova stream stalled or timed out；SenseNova 流式响应停摆或超时（空闲/首字节超时，已释放并发额度），交宿主重试层处理`, "TIMEOUT", { cause: error });
		if (signal?.aborted || error instanceof LlmError) throw error;
		throw new LlmError(`llm-sensenova: SenseNova stream failed: ${errorChain(error)}；SenseNova 流式响应中途失败`, "TRANSPORT", { cause: error });
	} finally {
		disarmWatchdog();
		await reader.cancel().catch(() => void 0);
		reader.releaseLock();
	}
}
/** 判断错误文本是否为「模型不可路由」的 404 措辞。 */
function isModelNotFoundText(errText) {
	const lower = errText.toLowerCase();
	return lower.includes("model route not found") || lower.includes("model is not found");
}
/** 是否为 AbortSignal.timeout / 看门狗 / 排队超时产生的 TimeoutError。 */
function isTimeoutReason(value) {
	return value instanceof Error && value.name === "TimeoutError";
}
/**
* 429001 分级探测退避档位（毫秒）——每次宿主重试各自重新探测，等待随连续 429001
* 次数递增，任一成功即清零、恢复后立即回到最短档 3s。
*
* 2026-09-16 实测修订（0916 会话日志）：原档位封顶 15s 过短。
* pro 段实测「每成功步摊到 2.5~7.5 次 429」，且宿主 llm-retry 的 maxRetries 只有 10，
* 按原档位（3/5/10/15 封顶）累计重试窗口仅约 33 秒，对分钟级 TPM 窗口严重不足 ——
* 结果是 **整整 13/16 个回合因重试预算耗尽被丢弃**（turn/end reason=error），
* 而同一会话切到 flash 后 2/2 回合全部完成。退避太短是"回合被杀"的直接原因。
* 现延长到 3/5/10/15/30/60/120s（累计约 4 分钟），并配合 providerRetryPolicy 的
* maxRetries 一起放宽（见 providerRetryPolicy）。
* 官方文档将 429 统一标注为 quota_exceeded_error 且建议「指数退避重试」，未公开数值；
* 实测 key A 30k 请求 429001、key B 同刻通过 → per-key 限速差异，短探测 + 换 key 优先。
*/
const TPM_PROBE_BACKOFF_STEPS_MS = [
	3e3,
	5e3,
	1e4,
	15e3,
	3e4,
	6e4,
	12e4
];
/**
* **请求数**限流（rpm/rps）的分级探测退避档位（毫秒）。
*
* 🔴 2026-09-24 新增。为什么不复用 {@link TPM_PROBE_BACKOFF_STEPS_MS}：
* 两者恢复窗口差一个量级 —— 请求数桶按秒/分钟补充（实测 code 8 是 15s 桶），
* 而 token 桶是 60s 滑动窗口。等 120s 对一个 15s 桶没有任何额外收益，
* 只会在**每个**宿主重试周期白白多花 105 秒。
*
* 上限取 30s（= 2 个 15s 桶），足够跨过请求数限流的恢复窗口；
* 若连 30s 都恢复不了，说明是更上层的账号级饱和，继续拉长等待也无意义
* （实测依据：今天在 120s 档连续 90 分钟零成功，拉长等待与成功率无关）。
*/
const RPM_PROBE_BACKOFF_STEPS_MS = [
	3e3,
	5e3,
	1e4,
	15e3,
	3e4
];
/**
* 🔴 2026-09-27 **移除**：原「全池饱和时最多连续跳过几轮 key 轮换」常量（值 4）。
*
* 移除理由（实测确认，同日诊断报告见 `output/dsh-0.1.7-rc.2-plugin-adaptation-report.md`
* 之前的根因分析）：它的判据 `atTopFloor` 把 **RPM 顶档与 TPM 顶档等价看待**，而
* `RPM_PROBE_BACKOFF_STEPS_MS` 只有 5 档（3/5/10/15/30s）、是**秒级桶**、恢复远快于宿主
* 重试间隔 ⇒ **纯 RPM 限流第 5 轮就进入「不换 key」状态**（实测每轮请求数
* `[3,3,3,3,1,1,1,1,3,1,1,1]`）。再叠加「档位计数只在 2xx 时清零」⇒ 短路⇒零成功⇒
* 计数永不清零⇒顶档判据永真，构成**正反馈死锁**，只能重启 web 解开。
*
* 该职能现由 `key-pool.ts` 的运行态/阻塞态双列表接管：key 进了阻塞态就不再被 agent
* 请求选中（等价于「跳过轮换」但不会锁死），而恢复权交给**不与 agent 请求耦合**的
* 探测调度器 —— 这正是旧机制做不到的部分。
*/
/**
* 命名像"配额耗尽"、实为**速率限流**的 429 error.code（商汤实测）：
* 三者挂在同一句 message `inference exceeds tpm/rpm limit` 下，账号配额充足时同样返回，
* 属商汤 code 命名误导。必须与 8 / 429001 同等对待，否则 quotaRotation 在换到这类
* 账户后会因"不识别"而停止轮换（死锁在单个 key 上）。
*/
const QUOTA_ALIAS_CODES = new Set([
	"insufficient_quota",
	"ModelAccountTpmRateLimitExceeded",
	"quota_exceeded_error"
]);
/**
* 是否为**请求数**限流（rpm）的 code。
*
* 🔴 为什么用模式匹配而不是白名单：商汤的 code 会随版本漂移（2026-09-23 起
* v4.1 把 429003/8 换成了 `RateLimitExceeded.Endpoint{RPM,TPM}Exceeded` 这一族命名）。
* 白名单每漂移一次就漏一次，而这一族的命名**自带语义**（RPM/TPM 写在 code 里），
* 按语义匹配比枚举形态更耐漂移。已实测覆盖：`RateLimitExceeded.EndpointRPMExceeded`、
* `ModelAccountRpmRateLimitExceeded`；并确认不会误伤 `...EndpointTPMExceeded` /
* `ModelAccountTpmRateLimitExceeded`（"Tpm" 不含子串 "rpm"）。
*/
function isRpmCode(code) {
	return typeof code === "string" && /rpm/i.test(code);
}
/** 429 响应体的形态摘要（原始 error.code + message），用于错误消息与日志诊断。 */
function rateLimitDetail(bodyText) {
	try {
		const parsed = JSON.parse(bodyText);
		if (!isRecord(parsed) || !isRecord(parsed.error)) return bodyText.slice(0, 80);
		const code = parsed.error.code;
		const message = parsed.error.message;
		const parts = [];
		if (code !== void 0) parts.push(`code=${String(code)}`);
		if (typeof message === "string" && message !== "") parts.push(message.slice(0, 80));
		return parts.join(", ");
	} catch {
		return bodyText.slice(0, 80);
	}
}
/**
* 解析 429 响应体并分类为「可轮换的限流」及其退避档位。
*
* 商汤 429 存在多种 error.code 形态（实测至少四种，且会随版本漂移）：
*   - `8`                              rps/rpm exhausted（速率桶，补充 ≈1 个/14s）
*   - `429001`                         inference tpm exhausted（TPM 60s 窗口）
*   - `insufficient_quota`             ← 命名误导：message 同为 tpm/rpm 限流，实为速率限流
*   - `ModelAccountTpmRateLimitExceeded` 账号级 TPM 限流
* 历史实现只认前两种，导致后两种被判为「非配额类」→ 不触发 key 轮换、也不走分级探测。
* 现按「code 白名单 + message 兜底 + 429 一律可轮换」三级判定：HTTP 429 本身就是限流，
* 换 key 是唯一主动手段，未知形态一律按 TPM 类处理（kind:'tpm'，3s 起分级探测）。
*/
function classify429Body(bodyText) {
	let parsed;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		parsed = void 0;
	}
	const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : void 0;
	const code = error?.code;
	const message = typeof error?.message === "string" ? error.message : "";
	if (code === 8 || code === "8") return {
		quota: true,
		retryFloorMs: QUOTA_RATE_RETRY_FLOOR_MS,
		kind: "rate"
	};
	if (code === 429001 || code === "429001") return {
		quota: true,
		retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0],
		kind: "tpm"
	};
	if (isRpmCode(code)) return {
		quota: true,
		retryFloorMs: RPM_PROBE_BACKOFF_STEPS_MS[0],
		kind: "rpm"
	};
	if (typeof code === "string" && QUOTA_ALIAS_CODES.has(code)) return {
		quota: true,
		retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0],
		kind: "tpm"
	};
	if (/tpm|rpm|rate.?limit|quota/i.test(message)) return {
		quota: true,
		retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0],
		kind: "tpm"
	};
	return {
		quota: true,
		retryFloorMs: TPM_PROBE_BACKOFF_STEPS_MS[0],
		kind: "tpm"
	};
}
/** 上抖幅度比例（base 的 0~30%）。 */
const RETRY429_JITTER_RATIO = .3;
/**
* 由 429 分类结果、动态下限与 Retry-After 头算出基础等待。
*
* @param classified - {@link classify429Body} 的静态分类（提供静态 floor）
* @param dynamicFloorMs - stream 层算好的配额类动态下限（429001 分级探测档），优先于静态 floor
* @param headerMs - 网关 Retry-After（毫秒）
* @returns 计划；无任何可用依据时 undefined（交由宿主自己的指数退避）
*/
function plan429RetryAfterMs(classified, dynamicFloorMs, headerMs) {
	const floorMs = dynamicFloorMs ?? classified.retryFloorMs;
	const header = headerMs !== void 0 && headerMs > 0 ? headerMs : void 0;
	if (floorMs !== void 0) return {
		baseMs: Math.max(floorMs, header ?? 0),
		respectHeader: header !== void 0 && header >= floorMs
	};
	if (header !== void 0 && header <= PROVIDER_RETRY_AFTER_CAP_MS) return {
		baseMs: header,
		respectHeader: true
	};
}
/**
* 给基础等待加**单向上抖**，并保证结果不越过天花板（纯函数，`random` 注入以便测试）。
*
* 🔴 不变量（两条都必须成立，见同名单测）：
*   1. `applyUpwardJitter(b, c, r) >= min(b, c)` —— 只向后推迟，绝不提前；
*   2. `applyUpwardJitter(b, c, r) <= c`         —— 绝不越过天花板。
*
* 第 2 条尤其不可放松：`ceilingMs` 是防悬崖不变量的上界，越过它会让宿主因
* `providerRetryAfterMs > policy.maxDelayMs` **直接放弃重试**（回合立即失败，
* 见 W1 的 `QUOTA_RETRY_AFTER_CEILING_MS` 注释）。所以当上抖空间不足时，
* 退让方向必须是"往小抖"，**而不是抬高天花板**。
*/
function applyUpwardJitter(baseMs, ceilingMs, random) {
	const headroom = ceilingMs - baseMs;
	if (headroom <= 0) return ceilingMs;
	const jitterSpan = Math.round(baseMs * RETRY429_JITTER_RATIO);
	const width = jitterSpan <= headroom ? jitterSpan : headroom;
	return baseMs + Math.round(random() * width);
}
/** 把预流 HTTP 失败映射为稳定 LlmError。
* dynamicFloorMs：stream 层算好的配额类动态退避下限（429001 分级探测），
* 覆盖 classify429Body 返回的静态 floor；undefined 时用静态 floor。 */
function httpError(status, errText, retryAfterMs, dynamicFloorMs) {
	if (status === 401) return new LlmError("llm-sensenova: SenseNova API error 401 — the API key is missing or invalid；SenseNova API 返回 401：密钥缺失或无效", "INVALID_CREDENTIAL", { status: 401 });
	if (status === 404 && isModelNotFoundText(errText)) return new LlmError("llm-sensenova: SenseNova model is not routable — the model id is no longer served；SenseNova 模型不可路由：该模型 id 已下线", MODEL_NOT_FOUND_CODE, { status: 404 });
	if (status === 429) {
		const plan = plan429RetryAfterMs(classify429Body(errText), dynamicFloorMs, retryAfterMs);
		let providerRetryAfterMs;
		if (plan !== void 0) providerRetryAfterMs = plan.respectHeader ? Math.min(plan.baseMs, QUOTA_RETRY_AFTER_CEILING_MS) : applyUpwardJitter(plan.baseMs, QUOTA_RETRY_AFTER_CEILING_MS, Math.random);
		const detail = rateLimitDetail(errText);
		return new LlmError(`llm-sensenova: SenseNova API error 429 — rate limited (${detail})；SenseNova API 返回 429：请求被限流（${detail}）`, "RATE_LIMIT", {
			status: 429,
			...providerRetryAfterMs !== void 0 ? { providerRetryAfterMs } : {}
		});
	}
	return new LlmError(`llm-sensenova: SenseNova API error ${status}: ${errText.slice(0, 500)}`, "PROVIDER_HTTP_ERROR", { status });
}
/** SenseNova（OpenAI 兼容）适配器。 */
var SensenovaAdapter = class extends LlmAdapter {
	deps;
	fetchImpl;
	gate;
	catalog = [];
	/** 进程内失败缓存：运行时返回 MODEL_NOT_FOUND 的模型 id，直到适配器生命周期结束。 */
	failedModels = /* @__PURE__ */ new Set();
	/**
	* 配额类 429 粘住 key（design D5，仅 quotaRotation 开启时读写）：
	* 有 sessionId 的请求按会话分桶（同一会话后续请求粘住切换后的 key）；
	* 无 sessionId 的请求共享进程级桶（undefined 键）——宿主 GenerateOptions
	* 仅提供 sessionId 这一会话标识，粘性粒度即「会话（无标识时为进程）」，
	* 与 spec「同一会话后续请求继续使用新 key」对齐。条目仅存内存，随适配器
	* 生命周期结束。
	*/
	quotaStickyKeys = /* @__PURE__ */ new Map();
	/**
	* 429001 连续命中计数（per-session，分级探测用）：决定本次请求的探测档位
	* TPM_PROBE_BACKOFF_STEPS_MS[count]。
	*
	* 推进单位 = **一次 stream() 调用**（= 一次宿主重试周期），见 stream() 内的
	* 「W3」注释：档位快照在入口取一次，轮换出的新 key 复用同一档，整轮结束才 +1；
	* 仅请求真正成功（拿到 2xx）时清零。仅内存，随适配器生命周期。
	*/
	tpmHitCounts = /* @__PURE__ */ new Map();
	/**
	* 请求数限流（rpm）的连续命中计数，**与 {@link tpmHitCounts} 完全隔离**。
	*
	* 🔴 2026-09-24 新增。不隔离的后果有两个，都是实测抓到的：
	*   1. RPM 事件推高 TPM 档位 —— 两类限流的恢复窗口差一个量级（秒级 vs 分钟级），
	*      混在一个计数里会让 token 限流凭空少探测好几轮；
	*   2. RPM 自己吃到 TPM 的 120s 档 —— 今天 37 条 RPM 记录被迫等 120 秒。
	* 推进/清零规则与 tpmHitCounts 完全一致（每轮 +1、2xx 清零）。
	*/
	rpmHitCounts = /* @__PURE__ */ new Map();
	/**
	* 🔴 2026-09-27 **移除**：原「全池饱和标记」`quotaSaturated: Map<string|undefined, number>`。
	*
	* 它记录「本会话已连续跳过几轮 key 轮换」，与同时被移除的 `SATURATION_SKIP_ROUNDS`
	* 常量、`atTopFloor`/`saturated` 判定、`rotationAllowed` 守卫一起构成旧短路机制。
	*
	* 移除原因见 `SATURATION_SKIP_ROUNDS` 处的说明（RPM 分支误判 + 计数永不清零 ⇒ 死锁）。
	* 其职能现由 `key-pool.ts` 的双列表接管，适配器只负责通过 `deps.reportRateLimit` /
	* `deps.reportSuccess` 上报分类结果，不再自己维护任何池状态。
	*/
	constructor(deps) {
		super();
		this.deps = deps;
		this.fetchImpl = deps.fetchImpl ?? fetch;
		this.gate = deps.concurrencyGate ?? new KeyedConcurrencyGate();
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: "SenseNova"
		};
	}
	providerRetryPolicy(_provider) {
		return this.deps.options().retryPolicy ?? FALLBACK_RETRY_POLICY;
	}
	async listModels(provider) {
		const connection = this.deps.options();
		let apiKey;
		try {
			apiKey = await this.deps.resolveApiKey(connection);
		} catch {
			return [];
		}
		const response = await this.fetchImpl(`${connection.apiBase}/models`, {
			headers: {
				accept: "application/json",
				authorization: `Bearer ${apiKey}`,
				...attributionHeaders()
			},
			signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
		});
		if (response.status === 401) throw new LlmError("llm-sensenova: SenseNova API rejected the API key (401)", "INVALID_CREDENTIAL", { status: 401 });
		if (!response.ok) throw new LlmError(`llm-sensenova: models endpoint returned HTTP ${response.status}`, "PROVIDER_HTTP_ERROR", { status: response.status });
		const models = parseCatalog(await response.json(), this.failedModels, connection.modelSelection ?? EMPTY_MODEL_SELECTION);
		this.catalog = models;
		return models.map((model) => ({
			provider,
			id: model.id,
			name: model.name,
			inputModalities: model.inputModalities
		}));
	}
	async resolveModel(provider, model, _signal) {
		const entry = this.catalog.find((m) => m.id === model);
		const reasoning = entry !== void 0 ? entry.reasoning : reasoningInfoFrom({}, model);
		const contextWindow = entry?.contextWindow ?? MODEL_CONTEXT_OVERRIDES.get(model) ?? DEFAULT_CONTEXT_WINDOW;
		const maxOutput = MODEL_MAX_OUTPUT_OVERRIDES.get(model) ?? entry?.maxOutputTokens;
		return {
			provider,
			id: model,
			name: displayNameFor(model),
			inputModalities: entry?.inputModalities ?? inputModalitiesFrom({}, model),
			context: { contextWindow },
			...maxOutput !== void 0 ? { defaultMaxTokens: maxOutput } : {},
			...reasoning !== void 0 ? { reasoning } : {}
		};
	}
	async *stream(options) {
		const connection = this.deps.options();
		const imageData = await prepareImageDataUrls(options.messages, this.deps.resolveImage, options.signal);
		const l2Params = l2ParamsFor(options.model, connection.requestParams ?? {});
		const body = JSON.stringify(buildOpenAiBody(options, imageData, l2Params));
		const tried = /* @__PURE__ */ new Set();
		const limit = connection.concurrency;
		const connectMs = this.deps.timeouts?.connectMs ?? 45e3;
		const streamIdleMs = this.deps.timeouts?.streamIdleMs ?? 6e4;
		const queueMs = this.deps.timeouts?.queueMs ?? connection.queueMs;
		const quotaRotation = connection.quotaRotation === true;
		const stickyKey = quotaRotation ? this.quotaStickyKeys.get(options.sessionId) : void 0;
		let apiKey = await this.deps.resolveApiKey(connection, stickyKey !== void 0 ? { preferredKey: stickyKey } : void 0);
		let response;
		let release;
		const connectCleanups = [];
		const probeKey = options.sessionId;
		const entryHits = this.tpmHitCounts.get(probeKey) ?? 0;
		const entryProbeFloorMs = TPM_PROBE_BACKOFF_STEPS_MS[Math.min(entryHits, TPM_PROBE_BACKOFF_STEPS_MS.length - 1)];
		const entryRpmHits = this.rpmHitCounts.get(probeKey) ?? 0;
		const entryRpmFloorMs = RPM_PROBE_BACKOFF_STEPS_MS[Math.min(entryRpmHits, RPM_PROBE_BACKOFF_STEPS_MS.length - 1)];
		let probeHitThisCall = false;
		let rpmHitThisCall = false;
		let probeResetBySuccess = false;
		let attemptIndex = 0;
		try {
			for (let rotations = 0;;) {
				attemptIndex += 1;
				tried.add(apiKey);
				try {
					release = await this.gate.acquire(apiKey, limit, options.signal, queueMs);
				} catch (error) {
					if (!isTimeoutReason(error)) throw error;
					throw new LlmError(`llm-sensenova: request queued behind the per-key concurrency limit for over ${queueMs ?? 6e4}ms；SenseNova 请求排队超时（未占用并发额度），交宿主重试层退避后重试`, "TIMEOUT", { cause: error });
				}
				let attempt;
				try {
					const connectController = new AbortController();
					const connectTimer = setTimeout(() => {
						connectController.abort(new DOMException("connect timed out", "TimeoutError"));
					}, connectMs);
					const onHostAbort = () => connectController.abort(options.signal?.reason);
					if (options.signal !== void 0) if (options.signal.aborted) connectController.abort(options.signal.reason);
					else options.signal.addEventListener("abort", onHostAbort, { once: true });
					connectCleanups.push(() => {
						clearTimeout(connectTimer);
						options.signal?.removeEventListener("abort", onHostAbort);
					});
					attempt = await this.fetchImpl(`${connection.apiBase}/chat/completions`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							authorization: `Bearer ${apiKey}`,
							...attributionHeaders()
						},
						body,
						signal: connectController.signal
					});
					clearTimeout(connectTimer);
				} catch (error) {
					release();
					release = void 0;
					if (options.signal?.aborted) throw error;
					if (isTimeoutReason(error)) throw new LlmError(`llm-sensenova: request to ${connection.apiBase} timed out after ${connectMs}ms；SenseNova 请求建连或首包超时（已释放并发额度），交宿主重试层处理`, "TIMEOUT", { cause: error });
					throw new LlmError(`llm-sensenova: request to ${connection.apiBase} failed: ${errorChain(error)}；连接 SenseNova API 失败，通常是网络或代理问题`, "TRANSPORT", { cause: error });
				}
				if (attempt.ok) {
					response = attempt;
					this.tpmHitCounts.delete(options.sessionId);
					this.rpmHitCounts.delete(options.sessionId);
					this.deps.reportSuccess?.(apiKey);
					probeResetBySuccess = true;
					break;
				}
				const errText = await attempt.text().catch(() => "");
				const retryAfterMs = parseRetryAfterMs(attempt.headers.get("retry-after"));
				if (attempt.status === 404 && isModelNotFoundText(errText)) {
					release();
					release = void 0;
					this.failedModels.add(options.model);
					throw httpError(attempt.status, errText, retryAfterMs);
				}
				const classified = classify429Body(errText);
				const quota429 = attempt.status === 429 && classified.quota;
				let dynamicFloorMs;
				let kickedThisAttempt = false;
				let poolStateThisAttempt;
				if (classified.kind === "tpm") {
					dynamicFloorMs = entryProbeFloorMs;
					probeHitThisCall = true;
					if (quotaRotation) {
						const reported = this.deps.reportRateLimit?.(apiKey, "tpm");
						kickedThisAttempt = reported?.kicked === true;
						poolStateThisAttempt = reported;
					}
				} else if (classified.kind === "rpm") {
					dynamicFloorMs = entryRpmFloorMs;
					rpmHitThisCall = true;
					if (quotaRotation) poolStateThisAttempt = this.deps.reportRateLimit?.(apiKey, "rpm");
				} else if (classified.kind === "rate" && quotaRotation) poolStateThisAttempt = this.deps.reportRateLimit?.(apiKey, "rate");
				const eventFloorMs = dynamicFloorMs ?? classified.retryFloorMs;
				const emitRateLimitEvent = (outcome) => {
					const described = this.deps.describeKey?.(apiKey);
					this.deps.errorLog?.()?.record({
						ts: (/* @__PURE__ */ new Date()).toISOString(),
						model: options.model,
						status: attempt.status,
						code: extractErrorCode(errText),
						kind: classified.kind ?? "",
						quota: classified.quota,
						message: summarize(rateLimitDetail(errText)),
						...eventFloorMs !== void 0 ? { retryFloorMs: eventFloorMs } : {},
						...retryAfterMs !== void 0 && retryAfterMs > 0 ? { retryAfterHeaderMs: retryAfterMs } : {},
						...outcome.providerRetryAfterMs !== void 0 ? { providerRetryAfterMs: outcome.providerRetryAfterMs } : {},
						...classified.kind === "tpm" || classified.kind === "rpm" ? { probeHits: classified.kind === "tpm" ? entryHits : entryRpmHits } : {},
						...outcome.kicked !== void 0 ? { kicked: outcome.kicked } : {},
						...poolStateThisAttempt !== void 0 ? {
							poolRunning: poolStateThisAttempt.running,
							poolBlocked: poolStateThisAttempt.blocked
						} : {},
						rotated: outcome.rotated,
						attempt: attemptIndex,
						account: fingerprint(apiKey),
						...described !== void 0 ? {
							accountLabel: described.label,
							accountRef: described.ref
						} : {},
						session: fingerprint(options.sessionId)
					});
				};
				const quotaRotate = quota429 && quotaRotation;
				if ((attempt.status === 401 || quotaRotate) && options.signal?.aborted !== true && rotations < connection.accountCount) {
					const next = await this.deps.rotateApiKey(apiKey, attempt.status === 401 ? "invalid-credential" : "quota-exhausted", tried);
					if (next !== void 0 && !tried.has(next)) {
						if (attempt.status === 429) emitRateLimitEvent({
							rotated: true,
							kicked: kickedThisAttempt
						});
						const rejectedKey = apiKey;
						release();
						release = void 0;
						apiKey = next;
						rotations += 1;
						if (quotaRotate) {
							this.quotaStickyKeys.set(options.sessionId, next);
							if (kickedThisAttempt) {
								for (const [session, sticky] of this.quotaStickyKeys) if (sticky === rejectedKey) this.quotaStickyKeys.delete(session);
							}
						}
						continue;
					}
				}
				if (quotaRotate) this.quotaStickyKeys.delete(options.sessionId);
				release();
				release = void 0;
				const failure = httpError(attempt.status, errText, retryAfterMs, dynamicFloorMs);
				if (attempt.status === 429) emitRateLimitEvent({
					rotated: false,
					kicked: kickedThisAttempt,
					...failure.failure.providerRetryAfterMs !== void 0 ? { providerRetryAfterMs: failure.failure.providerRetryAfterMs } : {}
				});
				throw failure;
			}
			if (response === void 0) throw new LlmError("llm-sensenova: SenseNova API returned no response", "PROVIDER_PROTOCOL_ERROR");
			if (response.body === null) throw new LlmError("llm-sensenova: SenseNova API returned no response body", "PROVIDER_PROTOCOL_ERROR");
			yield* parseOpenAiSse(response.body, options.signal, streamIdleMs);
		} finally {
			for (const cleanup of connectCleanups) cleanup();
			release?.();
			if (probeHitThisCall && !probeResetBySuccess) this.tpmHitCounts.set(probeKey, entryHits + 1);
			if (rpmHitThisCall && !probeResetBySuccess) this.rpmHitCounts.set(probeKey, entryRpmHits + 1);
		}
	}
};
//#endregion
//#region src/key-pool.ts
/** 池策略缺省值。 */
const DEFAULT_KEY_POOL_PARAMS = Object.freeze({
	kickThreshold: 2,
	probeInitialMs: 15e3,
	probeBackoffFactor: 2,
	probeMaxMs: 6e4,
	capacity: 10
});
/**
* 运行态 / 阻塞态双列表 key 池。
*
* 实例应当是**池级单例**（由 `index.ts` 的 `apply()` 创建一次并注入适配器），
* 因此其状态对所有会话共享 —— key 的配额本来就是全局属性。
*/
var SensenovaKeyPool = class {
	running = [];
	blocked = [];
	index = /* @__PURE__ */ new Map();
	/** 上次选中的 key，作为环回起点（比维护数组下标更耐增删）。 */
	lastPicked;
	opts;
	constructor(deps) {
		this.opts = deps;
	}
	now() {
		return this.opts.now?.() ?? Date.now();
	}
	params() {
		return this.opts.params();
	}
	/** 池内被追踪的 key 总数（运行态 + 阻塞态）。 */
	get size() {
		return this.index.size;
	}
	/** 该 key 是否处于运行态。不在池内或已阻塞都返回 false。 */
	isRunning(key) {
		return this.index.get(key)?.phase === "running";
	}
	/** 阻塞态条目（顺序 = 进入阻塞态的顺序）。 */
	blockedEntries() {
		return this.blocked;
	}
	/**
	* 把当前解析出的全部 key 灌入池。
	*
	* **幂等**：已存在的 key 保持其相位与计数（不重置），只有新 key 追加到运行态末尾。
	* 超过 `capacity` 的部分被忽略。
	*
	* @param keys - 按配置顺序解析出的 key（调用方已按 key 去重）。
	* @returns 因容量被丢弃的 key 数量（0 = 未截断），供调用方决定是否 warning。
	*/
	seed(keys) {
		const capacity = Math.max(1, Math.floor(this.params().capacity));
		let dropped = 0;
		for (const key of keys) {
			if (key === "") continue;
			if (this.index.has(key)) continue;
			if (this.index.size >= capacity) {
				dropped += 1;
				continue;
			}
			const entry = {
				key,
				phase: "running",
				tpmStrikes: 0,
				blockedSince: 0,
				probeAttempts: 0,
				lastProbedAt: 0
			};
			this.running.push(entry);
			this.index.set(key, entry);
		}
		return dropped;
	}
	/**
	* 选本次请求的起始 key。
	*
	* 顺序：会话粘性 `preferred`（**必须在运行态**，否则忽略）→ 运行态首项 →
	* （运行态为空的兜底）阻塞最久的一把。
	*
	* ⚠️ 粘性 key 若已被踢出或被 401 移除，这里会自动落到运行态的正确一把 ——
	* 这是旧实现起始处 `stickyKey ?? resolveApiKey` 留下的死锁残留的修复点。
	*/
	pickStart(preferred) {
		if (this.running.length === 0) {
			const borrowed = this.oldestBlocked(EMPTY_EXCLUDE);
			if (borrowed !== void 0) this.lastPicked = borrowed.key;
			return borrowed?.key;
		}
		const first = this.running[0];
		if (first === void 0) return void 0;
		const chosen = preferred !== void 0 && this.isRunning(preferred) ? preferred : first.key;
		this.lastPicked = chosen;
		return chosen;
	}
	/**
	* 轮换到下一把 key。
	*
	* 从 `lastPicked` 的下一个位置在运行态里**环回**查找第一个不在 `exclude` 的 key；
	* 运行态候选全部被排除时，**借用**阻塞态中 `blockedSince` 最小（阻塞最久）且不在
	* `exclude` 的一把 —— 借用**不改变其相位**，仅本次使用。
	*
	* @param exclude - 本轮已试过的 key（适配器的 `tried` 集合）。
	* @returns 下一把 key；池内已无可试者返回 undefined（调用方据此结束本轮）。
	*/
	pickNext(exclude) {
		const count = this.running.length;
		if (count > 0) {
			const anchor = this.lastPicked === void 0 ? -1 : this.running.findIndex((entry) => entry.key === this.lastPicked);
			for (let step = 1; step <= count; step += 1) {
				const entry = this.running[(anchor + step + count) % count];
				if (entry === void 0 || exclude.has(entry.key)) continue;
				this.lastPicked = entry.key;
				return entry.key;
			}
		}
		const borrowed = this.oldestBlocked(exclude);
		if (borrowed !== void 0) this.lastPicked = borrowed.key;
		return borrowed?.key;
	}
	/**
	* 记一次 tpm 类限流。
	*
	* - **运行态**：计数 +1；达到 `kickThreshold` 且**运行态多于 1 把**时移入阻塞态。
	* - **阻塞态**：**不计 strikes**（相位只由探测决定），但刷新 `lastProbedAt` ——
	*   刚被借用试过就不必马上再探测。
	* - **不在池内**：忽略。
	*
	* @returns `kicked` = 本次是否发生「运行态 → 阻塞态」迁移；`strikes` = 当前计数。
	*/
	recordTpmStrike(key) {
		const entry = this.index.get(key);
		if (entry === void 0) return {
			kicked: false,
			strikes: 0
		};
		if (entry.phase === "blocked") {
			entry.lastProbedAt = this.now();
			return {
				kicked: false,
				strikes: entry.tpmStrikes
			};
		}
		entry.tpmStrikes += 1;
		const threshold = Math.max(1, Math.floor(this.params().kickThreshold));
		if (entry.tpmStrikes < threshold) return {
			kicked: false,
			strikes: entry.tpmStrikes
		};
		if (this.running.length <= 1) return {
			kicked: false,
			strikes: entry.tpmStrikes
		};
		this.moveToBlocked(entry);
		return {
			kicked: true,
			strikes: entry.tpmStrikes
		};
	}
	/**
	* 记一次成功（agent 请求拿到 2xx）。
	*
	* 计数清零；若该 key 正处于阻塞态（被借用后成功）⇒ 立即挂回运行态末尾 ——
	* 「成功是池已恢复的最强证据」的落点。
	*/
	onSuccess(key) {
		const entry = this.index.get(key);
		if (entry === void 0) return;
		entry.tpmStrikes = 0;
		if (entry.phase !== "blocked") return;
		entry.probeAttempts = 0;
		this.moveToRunning(entry);
	}
	/** 401 永久禁用：把该 key 从池中彻底移除。 */
	remove(key) {
		const entry = this.index.get(key);
		if (entry === void 0) return;
		this.detach(entry);
		this.index.delete(key);
		if (this.lastPicked === key) this.lastPicked = void 0;
	}
	/** 该条目的下次可探测时刻。 */
	nextProbeAt(entry) {
		return entry.lastProbedAt + this.probeIntervalMs(entry);
	}
	/** 探测间隔：`probeInitialMs × factor^probeAttempts`，封顶 `probeMaxMs`。 */
	probeIntervalMs(entry) {
		const params = this.params();
		const initial = Math.max(1, Math.floor(params.probeInitialMs));
		const factor = params.probeBackoffFactor >= 1 ? params.probeBackoffFactor : 1;
		const ceiling = Math.max(initial, Math.floor(params.probeMaxMs));
		const growth = factor ** Math.min(Math.max(0, entry.probeAttempts), 16);
		return Math.min(Math.round(initial * growth), ceiling);
	}
	/**
	* 回写一次探测结果。
	*
	* 成功 ⇒ 计数清零并挂回运行态末尾；失败 ⇒ `probeAttempts + 1`（下次退避更久）。
	* 两种情况都刷新 `lastProbedAt`。
	*/
	recordProbe(entry, recovered) {
		entry.lastProbedAt = this.now();
		if (recovered) {
			entry.probeAttempts = 0;
			entry.tpmStrikes = 0;
			if (entry.phase === "blocked") this.moveToRunning(entry);
			return;
		}
		entry.probeAttempts += 1;
	}
	/** 只读快照（设置页诊断面板用）。 */
	snapshot() {
		return {
			running: this.running.map((entry) => entry.key),
			blocked: this.blocked.map((entry) => ({
				key: entry.key,
				blockedSince: entry.blockedSince,
				probeAttempts: entry.probeAttempts
			}))
		};
	}
	/** 阻塞态中 `blockedSince` 最小且不在 `exclude` 的一把（即「阻塞最久」）。 */
	oldestBlocked(exclude) {
		let oldest;
		for (const entry of this.blocked) {
			if (exclude.has(entry.key)) continue;
			if (oldest === void 0 || entry.blockedSince < oldest.blockedSince) oldest = entry;
		}
		return oldest;
	}
	moveToBlocked(entry) {
		this.detach(entry);
		entry.phase = "blocked";
		entry.blockedSince = this.now();
		entry.probeAttempts = 0;
		entry.lastProbedAt = this.now();
		this.blocked.push(entry);
	}
	moveToRunning(entry) {
		this.detach(entry);
		entry.phase = "running";
		entry.blockedSince = 0;
		this.running.push(entry);
	}
	/** 从当前所属列表摘除（不改变相位字段，供上层决定挂到哪里）。 */
	detach(entry) {
		const from = entry.phase === "running" ? this.running : this.blocked;
		const index = from.indexOf(entry);
		if (index >= 0) from.splice(index, 1);
	}
};
/** 复用的空集合，避免 `pickStart` 每次分配。 */
const EMPTY_EXCLUDE = /* @__PURE__ */ new Set();
//#endregion
//#region src/error-log-api.ts
/**
* 错误记录的**只读 HTTP 接口**（2026-09-18，W5 之后的「诊断区块」）。
*
* 为什么走 HTTP 路由而不是 typert RPC：本场景只需"读一个日志文件并算几个数"，
* 路由注册一行 `ctx.connection.fetch.register(...)` 即可，且同源请求自带 cookie
* 鉴权 ⇒ client 侧 `fetch` 就能用，省掉一层 codegen/类型声明。
*
* 三条硬约束（都来自"这是设置页里的一小块区域"这个定位）：
*  1. **不全量回传**：`sensenova-errors.jsonl` 上限 5 MB，直接塞给浏览器会卡。
*     ⇒ 读文件后只在 host 侧聚合，client 只拿「三个数字 + 最近 N 条」。
*  2. **懒创建、缺失即正常**：文件只在第一次真实 429 时出现 ⇒ 不存在时返回
*     `available: false` 而不是报错（否则设置页会一直显示红字）。
*  3. **永不抛**：读取/解析异常一律降级为"空快照 + available:false"，因为这块 UI
*     是辅助信息，坏掉不能影响设置页本身（与 error-log.ts 的 `record()` 同一原则）。
*/
/** 路由路径（client 侧硬编码同值；约定与官方路由一致，挂在 `/api/` 下）。 */
const ERROR_LOG_ROUTE = "/api/sensenova/errorLog";
/**
* 单次读取的字节上限。日志文件本身按 5 MB 滚动，所以默认值给足余量；
* 万一被外部工具改大，也只读尾部并置 `truncated: true`（统计口径随之收窄，
* 宁可标注也不无声截断）。
*/
const ERROR_LOG_READ_LIMIT_BYTES = 16 * 1024 * 1024;
/** 统计窗口默认 24 小时。 */
const ERROR_LOG_DEFAULT_WINDOW_MS = 1440 * 60 * 1e3;
/** 解析失败或文件不可读时返回的空快照（UI 只需据此显示"暂无记录"）。 */
function emptySnapshot(filePath, windowMs) {
	return {
		available: false,
		path: filePath,
		windowMs,
		total: 0,
		distinctCodes: 0,
		distinctModels: 0,
		entries: [],
		truncated: false
	};
}
/**
* 把 JSONL 文本解析成事件数组（纯函数，便于单测）。
*
* @param text - 文件内容（或尾部切片）
* @param dropFirst - true 时丢弃第一行：按字节截取尾部时首行大概率是半截 JSON。
* @returns 可解析的事件，**保持文件顺序**（新的在后）；坏行直接跳过。
*/
function parseErrorLogText(text, dropFirst = false) {
	const lines = text.split("\n");
	const start = dropFirst ? 1 : 0;
	const events = [];
	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index]?.trim();
		if (line === void 0 || line === "") continue;
		try {
			const parsed = JSON.parse(line);
			if (typeof parsed === "object" && parsed !== null) events.push(parsed);
		} catch {
			continue;
		}
	}
	return events;
}
/** 把事件压成前端要的一条。`message` 再截一次，防止旧版本写入的超长行撑爆 UI。 */
function toEntry(event) {
	return {
		ts: typeof event.ts === "string" ? event.ts : "",
		model: typeof event.model === "string" ? event.model : "",
		code: typeof event.code === "string" ? event.code : "",
		kind: typeof event.kind === "string" ? event.kind : "",
		rotated: event.rotated === true,
		attempt: typeof event.attempt === "number" ? event.attempt : 0,
		message: typeof event.message === "string" ? event.message.slice(0, 200) : "",
		...typeof event.retryFloorMs === "number" ? { retryFloorMs: event.retryFloorMs } : {},
		...typeof event.providerRetryAfterMs === "number" ? { providerRetryAfterMs: event.providerRetryAfterMs } : {},
		...typeof event.probeHits === "number" ? { probeHits: event.probeHits } : {},
		...typeof event.kicked === "boolean" ? { kicked: event.kicked } : {},
		...typeof event.poolRunning === "number" ? { poolRunning: event.poolRunning } : {},
		...typeof event.poolBlocked === "number" ? { poolBlocked: event.poolBlocked } : {},
		...typeof event.accountLabel === "string" && event.accountLabel !== "" ? { accountLabel: event.accountLabel } : {},
		...typeof event.accountRef === "string" && event.accountRef !== "" ? { accountRef: event.accountRef } : {},
		account: typeof event.account === "string" ? event.account : ""
	};
}
/**
* 由事件列表算出快照（纯函数，便于单测）。
*
* 统计口径：**按事件时间戳落在窗口内**才算，而不是"文件里的最后 N 条"——
* 因为文件可能几分钟没更新，用条数当窗口会让"近 24h 共 37 次"长期虚高。
*/
function summarizeErrorLog(events, options) {
	const cutoff = (options.now ?? Date.now()) - options.windowMs;
	const recent = events.filter((event) => {
		const parsed = Date.parse(typeof event.ts === "string" ? event.ts : "");
		return Number.isFinite(parsed) && parsed >= cutoff;
	});
	const codes = /* @__PURE__ */ new Set();
	const models = /* @__PURE__ */ new Set();
	for (const event of recent) {
		if (typeof event.code === "string" && event.code !== "") codes.add(event.code);
		if (typeof event.model === "string" && event.model !== "") models.add(event.model);
	}
	const tail = events.slice(Math.max(0, events.length - options.limit));
	return {
		available: true,
		path: options.filePath,
		windowMs: options.windowMs,
		total: recent.length,
		distinctCodes: codes.size,
		distinctModels: models.size,
		entries: tail.map(toEntry).reverse(),
		truncated: false
	};
}
/** 读取日志文本；超过上限时只读**尾部**（真读尾部，不是读完再切）。 */
async function readWithinLimit(filePath) {
	const info = await stat(filePath);
	if (info.size <= 16777216) return {
		text: await readFile(filePath, "utf8"),
		truncated: false
	};
	const handle = await open(filePath, "r");
	try {
		const start = info.size - ERROR_LOG_READ_LIMIT_BYTES;
		const length = info.size - start;
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);
		return {
			text: buffer.toString("utf8"),
			truncated: true
		};
	} finally {
		await handle.close();
	}
}
/**
* 组装一次查询结果：读文件 → 解析 → 汇总。
*
* **绝不抛**：文件不存在（懒创建）、权限问题、解析异常，一律降级为空快照。
*/
async function readErrorLogSnapshot(options = {}) {
	const filePath = options.filePath ?? defaultErrorLogPath(options.env ?? process.env);
	const windowMs = options.windowMs ?? 864e5;
	const requested = options.limit ?? 50;
	const limit = Math.min(Math.max(1, Math.trunc(Number.isFinite(requested) ? requested : 50)), 200);
	try {
		const { text, truncated } = await readWithinLimit(filePath);
		return {
			...summarizeErrorLog(parseErrorLogText(text, truncated), {
				filePath,
				windowMs,
				limit,
				...options.now === void 0 ? {} : { now: options.now }
			}),
			truncated
		};
	} catch {
		return emptySnapshot(filePath, windowMs);
	}
}
/** 解析 query 里的数字参数（非法即回退默认）。 */
function numberParam(url, key, fallback) {
	const raw = url.searchParams.get(key);
	if (raw === null || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}
/**
* HTTP 处理函数：`GET /api/sensenova/errorLog?limit=50&windowMs=86400000`。
*
* ⚠️ **实测（2026-09-18）：`ctx.connection.fetch.register` 的 `methods` 在框架层就做了过滤** ——
* 非 GET 请求不会被派发到这里，而是落回普通分发链、最终得到 **404**，不是本函数返回的 405。
* 因此下面的 405 分支是**防御性兜底**（万一将来外层不再按 methods 过滤，行为仍然正确）；
* 端到端只能观察到 404。单测里那条 405 断言是**直接调用本函数**验证的，不等于端到端路径。
*/
async function handleErrorLogHttp(request) {
	if (request.method !== "GET") return new Response(null, {
		status: 405,
		headers: { allow: "GET" }
	});
	const url = new URL(request.url);
	const snapshot = await readErrorLogSnapshot({
		limit: numberParam(url, "limit", 50),
		windowMs: numberParam(url, "windowMs", ERROR_LOG_DEFAULT_WINDOW_MS)
	});
	return new Response(JSON.stringify(snapshot), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		}
	});
}
//#endregion
//#region src/model-info-api.ts
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
/** 路由路径（client 侧硬编码同值；约定挂在 `/api/` 下）。 */
const MODEL_INFO_ROUTE = "/api/sensenova/modelInfo";
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
const MODEL_PARAM_SPECS = [
	{
		key: "model",
		label: "模型 id",
		range: "目录里声明的 id",
		serverDefault: "—",
		hostSupport: "yes",
		l2: false
	},
	{
		key: "messages",
		label: "对话消息",
		range: "system / user / assistant / tool",
		serverDefault: "—",
		hostSupport: "yes",
		l2: false
	},
	{
		key: "stream",
		label: "流式输出",
		range: "boolean",
		serverDefault: "false",
		hostSupport: "yes",
		l2: false,
		note: "本适配器恒发 true（SSE 解析路径是唯一实现）。文档建议长文本/思考模式必开，避免超时。"
	},
	{
		key: "stream_options",
		label: "流式 usage 开关",
		range: "{include_usage: boolean}",
		serverDefault: "true",
		hostSupport: "no",
		l2: false,
		note: "【实测】显式 false 会让 usage 帧**整个消失** ⇒ 插件已显式写死 true，把默认值依赖变成契约。"
	},
	{
		key: "temperature",
		label: "采样温度",
		range: "[0, 2)",
		serverDefault: "1",
		hostSupport: "yes",
		l2: false,
		note: "思考模式下不生效（服务端不报错）。"
	},
	{
		key: "top_p",
		label: "核采样阈值",
		range: "(0, 1]",
		serverDefault: "1（glm/kimi 为 0.95）",
		hostSupport: "no",
		l2: true,
		note: "【实测】kimi-k3 固定 0.95；思考模式下 <0.95 会被自动抬到 0.95，非思考模式固定 1.0 并被忽略。"
	},
	{
		key: "max_tokens",
		label: "输出上限",
		range: "逐模型不同，见模型表",
		serverDefault: "逐模型",
		hostSupport: "yes",
		l2: false,
		note: "【实测】思考 token 与输出共享此预算，超出会截断思考（finish_reason=length）。宿主会把适配器上报的 defaultMaxTokens 物化成这个字段。"
	},
	{
		key: "stop",
		label: "停止序列",
		range: "string | string[]",
		serverDefault: "—",
		hostSupport: "yes",
		l2: false
	},
	{
		key: "reasoning_effort",
		label: "思考档位",
		range: "见模型表",
		serverDefault: "v4=high；v4.1/kimi=high；glm=max",
		hostSupport: "yes",
		l2: false,
		note: "【实测】唯一 UI 可调项。`none` 是 5/5 模型通用的关思考方式。"
	},
	{
		key: "thinking",
		label: "思考开关（显式）",
		range: "{\"type\":\"enabled\"/\"disabled\"}",
		serverDefault: "enabled",
		hostSupport: "no",
		l2: false,
		note: "🔴【实测】glm-5.2 传它直接 400；字符串形态 5/5 全拒。⇒ 插件**永不发送**本参数，一律用 reasoning_effort。"
	},
	{
		key: "tools",
		label: "工具定义",
		range: "function 数组",
		serverDefault: "—",
		hostSupport: "yes",
		l2: false,
		note: "【实测】5/5 模型的 17 项工具调用契约全部通过。"
	},
	{
		key: "tool_choice",
		label: "工具选择策略",
		range: "none / auto / required",
		serverDefault: "auto",
		hostSupport: "no",
		l2: false,
		note: "【实测】`required` 5/5 模型均可用且真返回 tool_calls。"
	},
	{
		key: "frequency_penalty",
		label: "频率惩罚",
		range: "[-2, 2]",
		serverDefault: "0",
		hostSupport: "no",
		l2: true,
		note: "🔴【实测】kimi-k3 传非 0 直接 400（\"only 0 is allowed\"）。思考模式下不生效。"
	},
	{
		key: "presence_penalty",
		label: "存在惩罚",
		range: "[-2, 2]",
		serverDefault: "0",
		hostSupport: "no",
		l2: true,
		note: "🔴【实测】kimi-k3 传非 0 直接 400。思考模式下不生效。"
	},
	{
		key: "seed",
		label: "随机种子",
		range: "[0, 9999999)",
		serverDefault: "—",
		hostSupport: "no",
		l2: true,
		note: "Beta；接受性 5/5 通过（kimi-k3 已整体排除，见模型表）。"
	},
	{
		key: "do_sample",
		label: "是否采样（glm 独有）",
		range: "boolean",
		serverDefault: "true",
		hostSupport: "no",
		l2: true,
		note: "仅 glm-5.2。false 时忽略 temperature/top_p，输出更稳定（适合代码/翻译）。"
	},
	{
		key: "response_format",
		label: "结构化输出",
		range: "{type: text/json_object}",
		serverDefault: "text",
		hostSupport: "no",
		l2: false,
		note: "【实测】json_object 5/5 可用。⚠️ 未纳入 L2：对 DSH 的 agent 对话没有意义，且是 v4「三方组合 400」的参与者。lite 的 JSON 输出会包在 ```json 围栏里。"
	},
	{
		key: "n",
		label: "生成候选数",
		range: "[1, 5]",
		serverDefault: "1",
		hostSupport: "no",
		l2: false,
		note: "🔴【实测】v4/v4.1/kimi 上 n>1 被**静默降到 1**，只在 lite 真生效；且是 v4「三方组合 400」的参与者。⇒ 不提供。"
	},
	{
		key: "parallel_tool_calls",
		label: "并行工具调用",
		range: "boolean",
		serverDefault: "true",
		hostSupport: "no",
		l2: false,
		note: "【实测】v4 上与 n/response_format 同传会 400。未纳入 L2。"
	},
	{
		key: "logprobs",
		label: "返回对数概率",
		range: "boolean",
		serverDefault: "—",
		hostSupport: "no",
		l2: false,
		note: "仅 v4.1 文档提及；未实测，DSH 不消费。"
	}
];
const NOTES_LITE = [
	"上下文 262,144（≠ 1M，其余模型都是 1M）。",
	"【实测】`max` 与 `minimal` 都被拒：服务端词表就是 low/medium/high/xhigh/none。",
	"【实测】JSON 模式输出会被包在 ```json 围栏里，解析侧需剥围栏。",
	"【实测】`n:2` 是 5 个模型里唯一真生效的。"
];
const NOTES_V4 = [
	"【实测】无视觉能力：贴图后模型会**幻觉**（编造\"心形图案、数字9\"），且图片被网关接受并计费（ptok 109 vs 纯文本 14）⇒ 最危险，切勿给它发图。",
	"【实测】文档写的 `max` 档是错的（400）；服务端词表 low/medium/high/xhigh/none。",
	"【实测】`n` + `parallel_tool_calls` + `response_format` 三者同时传会 400。",
	"【实测】思考模式会把推理写进可见正文（`none` 只是关掉思考通道，不是关掉推理能力）。"
];
const NOTES_V41 = [
	"视觉实测通过：准确读出测试图中的红方块 / 蓝圆 / 数字 42。",
	"【实测】图片 token 在 ~1003 封顶（服务端自行缩放，与文件大小解耦）⇒ 图片预算可相对放宽。",
	"【实测】全 7 档都接受（含 minimal/xhigh/max）；文档声称 medium/xhigh 会被映射到 high（未实测确认）。",
	"目录 `input_modalities` 长期只报 [\"text\"] ⇒ 视觉能力由白名单硬补。",
	"【实测】`deepseek-v4.1-flash` 是 403 诱饵 id，唯一可调的是本 id。"
];
const NOTES_GLM = [
	"【实测】无视觉能力但**诚实拒答**（明确说\"我无法直接看到图片\"），不产生幻觉 ⇒ 比 v4-flash 安全。",
	"🔴【实测】`thinking` 参数**硬拒**（400）：必须用 `reasoning_effort`，本插件永不发送 thinking。",
	"默认思考档位是 `max`（不是 high）⇒ 输出预算必须给到 131072。",
	"独有 `do_sample` 参数（false 时输出更稳定，适合代码/翻译）。"
];
const NOTES_KIMI = [
	"视觉实测通过：准确读出测试图中的红方块 / 蓝圆 / 数字 42。",
	"🔴 图片输入**只吃 Base64**（不吃公网 URL），且 `content` 必须是对象数组 —— 插件已统一发 data URL，天然兼容。",
	"🔴【实测】图片 token **线性增长**（7MB 图 = 3168 prompt tokens，是 v4.1 的 3 倍）⇒ 大图对 TPM 的冲击远超其它模型。",
	"🔴【实测】传非 0 的频率惩罚/存在惩罚直接 400（\"only 0 is allowed\"）⇒ L2 参数全部排除。",
	"文档写 `max_completion_tokens`，实测 `max_tokens` 是同一字段别名且被遵守（max_tokens=8 真被截断到 8）。",
	"temperature 固定 1、top_p 固定 0.95（文档口径，未实测偏离值）。"
];
/** 模型事实表（Phase 0 实测 + 文档）。 */
const MODEL_FACT_SHEETS = [
	{
		id: "sensenova-6.8-flash-lite",
		displayName: "SenseNova 6.8 Flash Lite",
		contextWindow: MODEL_CONTEXT_OVERRIDES.get("sensenova-6.8-flash-lite") ?? 262144,
		maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get("sensenova-6.8-flash-lite") ?? 65536,
		vision: true,
		visionNote: "支持 JPG/JPEG/PNG/WebP；公网 URL 与 Base64 均可。",
		efforts: [...MODEL_L2_PARAM_SUPPORT.get("sensenova-6.8-flash-lite") ?? []].length > 0 ? [
			"none",
			"low",
			"medium",
			"high",
			"xhigh"
		] : [],
		blockedL2Params: [],
		notes: NOTES_LITE
	},
	{
		id: "deepseek-v4-flash",
		displayName: "DeepSeek V4 Flash",
		contextWindow: MODEL_CONTEXT_OVERRIDES.get("deepseek-v4-flash") ?? 1048576,
		maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get("deepseek-v4-flash") ?? 131072,
		vision: false,
		textOnlyBehavior: "hallucinates",
		efforts: [
			"none",
			"low",
			"medium",
			"high",
			"xhigh"
		],
		blockedL2Params: [],
		notes: NOTES_V4
	},
	{
		id: "deepseek-flash",
		displayName: "DeepSeek V4.1 Flash",
		contextWindow: MODEL_CONTEXT_OVERRIDES.get("deepseek-flash") ?? 1048576,
		maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get("deepseek-flash") ?? 131072,
		vision: true,
		visionNote: "支持 JPEG/PNG/GIF/WebP；单图 ≤50MB（实测 8MB 即 413，文档口径不可信）；URL 与 Base64 均可。",
		efforts: [
			"none",
			"low",
			"medium",
			"high",
			"xhigh",
			"minimal",
			"max"
		],
		blockedL2Params: [],
		notes: NOTES_V41
	},
	{
		id: "glm-5.2",
		displayName: "GLM-5.2",
		contextWindow: MODEL_CONTEXT_OVERRIDES.get("glm-5.2") ?? 1048576,
		maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get("glm-5.2") ?? 131072,
		vision: false,
		textOnlyBehavior: "refuses",
		efforts: [
			"none",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		blockedL2Params: [],
		notes: NOTES_GLM
	},
	{
		id: "kimi-k3",
		displayName: "Kimi K3",
		contextWindow: MODEL_CONTEXT_OVERRIDES.get("kimi-k3") ?? 1048576,
		maxOutputTokens: MODEL_MAX_OUTPUT_OVERRIDES.get("kimi-k3") ?? 131072,
		vision: true,
		visionNote: "支持 JPEG/PNG/WebP/GIF/BMP/HEIC/HEIF；**仅 Base64**（不吃公网 URL）；`content` 必须是数组。",
		efforts: [
			"none",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		],
		blockedL2Params: [
			"top_p",
			"frequency_penalty",
			"presence_penalty",
			"seed",
			"do_sample"
		],
		notes: NOTES_KIMI
	}
];
/** Phase 0 实测完成时间（数据新鲜度标注）。 */
const PHASE0_PROBED_AT = "2026-09-23 19:45 GMT+8";
/**
* 组装快照。**绝不抛**：任何一步失败都降级为 `available: false` + error 说明。
*/
async function buildModelInfoSnapshot(deps) {
	let accounts;
	try {
		accounts = deps.accountPool();
	} catch {
		accounts = {
			slots: 0,
			refs: [],
			activeAccount: "",
			quotaRotation: false
		};
	}
	let settingsProbe;
	try {
		settingsProbe = deps.settingsProbe();
	} catch (err) {
		settingsProbe = {
			serviceAvailable: false,
			accountsInSettings: -1,
			namespacesSeen: 0,
			error: String(err?.message ?? err).slice(0, 200)
		};
	}
	const base = {
		available: false,
		accounts,
		settingsProbe,
		params: MODEL_PARAM_SPECS,
		l2Allowed: [],
		probedAt: PHASE0_PROBED_AT
	};
	const selection = deps.currentSelection();
	if (selection === void 0 || typeof selection.model !== "string" || selection.model === "") return {
		...base,
		error: "default-model-unavailable"
	};
	const provider = typeof selection.provider === "string" && selection.provider !== "" ? selection.provider : "sensenova";
	const model = selection.model;
	let resolved;
	try {
		resolved = await deps.resolveModelInfo(provider, model);
	} catch (err) {
		return {
			...base,
			selection: {
				provider,
				model,
				...selection.reasoningEffort !== void 0 ? { reasoningEffort: selection.reasoningEffort } : {}
			},
			error: `resolve-model-failed: ${String(err?.message ?? err).slice(0, 200)}`
		};
	}
	if (resolved === void 0) return {
		...base,
		selection: {
			provider,
			model,
			...selection.reasoningEffort !== void 0 ? { reasoningEffort: selection.reasoningEffort } : {}
		},
		error: "model-info-unavailable"
	};
	const allowed = MODEL_L2_PARAM_SUPPORT.get(model);
	const factSheet = DOCUMENTED_VISION_MODELS.has(model) || DOCUMENTED_TEXT_ONLY_MODELS.has(model) ? MODEL_FACT_SHEETS.find((sheet) => sheet.id === model) : void 0;
	return {
		available: true,
		accounts,
		settingsProbe,
		selection: {
			provider,
			model,
			...selection.reasoningEffort !== void 0 ? { reasoningEffort: selection.reasoningEffort } : {}
		},
		resolved: {
			...resolved.name !== void 0 ? { name: resolved.name } : {},
			...resolved.inputModalities !== void 0 ? { inputModalities: resolved.inputModalities } : {},
			...resolved.context !== void 0 ? { contextWindow: resolved.context.contextWindow } : {},
			...resolved.defaultMaxTokens !== void 0 ? { defaultMaxTokens: resolved.defaultMaxTokens } : {},
			...resolved.reasoning?.efforts !== void 0 ? { efforts: resolved.reasoning.efforts } : {},
			...resolved.reasoning?.defaultEffort !== void 0 ? { defaultEffort: resolved.reasoning.defaultEffort } : {}
		},
		...factSheet !== void 0 ? { facts: factSheet } : {},
		params: MODEL_PARAM_SPECS,
		l2Allowed: allowed !== void 0 ? [...allowed] : [],
		probedAt: PHASE0_PROBED_AT
	};
}
/**
* HTTP 处理函数：`GET /api/sensenova/modelInfo`。
*
* 与错误记录路由同一条实测结论：框架层按 `methods` 过滤，非 GET 根本不会进这里
* （表现是 404），下面的 405 分支只是防御性兜底。
*/
function handleModelInfoHttp(request, deps) {
	if (request.method !== "GET") return Promise.resolve(new Response(null, {
		status: 405,
		headers: { allow: "GET" }
	}));
	return buildModelInfoSnapshot(deps).then((snapshot) => new Response(JSON.stringify(snapshot), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store"
		}
	})).catch((err) => new Response(JSON.stringify({
		available: false,
		error: `handler-failed: ${String(err?.message ?? err).slice(0, 200)}`,
		params: MODEL_PARAM_SPECS,
		l2Allowed: [],
		probedAt: PHASE0_PROBED_AT
	}), {
		status: 200,
		headers: { "content-type": "application/json; charset=utf-8" }
	}));
}
//#endregion
//#region src/index.ts
/**
* dsh-sensenova-freeapi — DeepSeek Harness 的 SenseNova（OpenAI 兼容）LLM
* provider 插件（host 侧）。
*
* 注册 `sensenova` 路由并声明为可配置 provider（显示名 SenseNova），在 Models
* 页提供卡片；设置段挂在 `llm-sensenova` 命名空间下，支持共享 `apiBase` 下
* 的默认账号 + 多账号列表 + 手动钉选（activeAccount）。key 一律通过宿主
* 凭据服务解析（环境变量兜底），原文不落日志。
*
* ```yaml
* - id: llm-sensenova
*   name: "dsh-sensenova-freeapi"
*   config:
*     apiKeyEnv: SENSENOVA_API_KEY
* ```
*
* `name` 必须是完整包名（加载器按真实包名从 node_modules 解析）；YAML 中以
* `@` 开头的标量必须加引号。
*
* @module dsh-sensenova-freeapi
*/
const name = "llm-sensenova";
const inject = ["llm"];
/** 复用的空集合：`rotateApiKey` 在无 exclude 时不必每次分配。 */
const EMPTY_KEY_SET = /* @__PURE__ */ new Set();
const NS = "llm-sensenova";
const PROVIDER = "sensenova";
const DEFAULT_API_KEY_ENV = "SENSENOVA_API_KEY";
const DEFAULT_API_BASE = "https://token.sensenova.cn/v1";
/**
* 重试策略 schema（2026-09-17 W1）。
*
* ⚠️ **为什么不用官方的 `RetryPolicySchema`**：它的 `backoff.maxDelayMs` 缺省是
* `DEFAULT_MAX_DELAY_MS = 10_000`，而本适配器能吐出的 `providerRetryAfterMs`
* 上限是 `QUOTA_RETRY_AFTER_CEILING_MS = 300_000`。用户在设置页**只要改了任意
* 一项**（例如只调 `maxRetries`），union 分支就会用它自己的缺省把 `maxDelayMs`
* 填成 10_000 ⇒ **悬崖立刻重现**（宿主对 `pra > maxDelayMs` 是直接放弃重试，
* 不是夹到上限）。实测证据：`output/temp/probe-w1.mjs` 用例 ②（只给
* `maxRetries: 30`，结果 `maxDelayMs` 变成 10000）。
*
* 改用**字段级独立缺省**的等价 schema：schemastery 对部分输入做深合并，缺失键
* 各自取自己的缺省、互不污染（实测 `probe-w1b.mjs` 第三组）。
*
* 校验强度不变：`resolveRetryPolicy()` 仍在 `resolveAdapterOptions()` 里做最终
* 校验（未知键、数值范围、`initialDelayMs ≤ maxDelayMs` 等），非法值照样被拒，
* 且错误会在设置保存时暴露。`mode` 的 `z.union` 只用于 schema 层校验——
* 设置页是本插件自写的组件（一个 `<select>`），不走通用 union 渲染。
*/
const RetryPolicyFieldsSchema = z.object({
	mode: z.union([z.const("normal"), z.const("always")]).default("normal"),
	maxRetries: z.natural().min(0).default(24),
	backoff: z.object({
		initialDelayMs: z.natural().min(1).default(500),
		maxDelayMs: z.natural().min(1).default(QUOTA_RETRY_AFTER_CEILING_MS),
		jitterRatio: z.number().min(0).max(1).default(DEFAULT_RETRY_JITTER_RATIO)
	})
});
/**
* 对外导出的配置 schema。
*
* ⚠️ **类型断言是刻意的**：`.volatile()` 把字段类型包成 `Volatile<T>`，官方
* `llm-deepseek` 因此把接口写成 `apiKeyEnv: Volatile<string>` 并在读取处用
* `plainOptions()`（`isVolatile(v) ? v.get() : v`）逐字段解包。
*
* 本插件**保持 `SensenovaConfig` 为「解析后形态」**（下游 `resolveAdapterOptions()`、
* `normalizeRequestParams()` 全按普通值读），schema 上的 volatile 标记只服务设置层
* （`describe()` → `volatileForm()` 需要它才不跳过本 namespace）。故此处显式断言，
* 避免为一个纯标注性改动重写整条读值路径。
*
* ⚠️ 这条断言成立的前提是**下游必须先经 `plainConfig()` 解包**（见 `apply()` 入口）。
* 实测形状：带 volatile 的字段在 schema 输出里是 `{ get() }` 对象，
* `JSON.stringify(Config({...}))` 会得到一串 `{}` ⇒ 不解包则 `config.accounts` 是引用、
* `accounts.slots` 会读成 0。
*
* 验收判据（必须同时成立才说明"设置层修好、运行期没坏"）：
* `GET /api/sensenova/modelInfo` 的 `settingsProbe.namespacesSeen` 从 **0 → 1**，
* 且 `accounts.slots` 仍为 **3**。
*/
const Config = z.object({
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV).volatile(),
	apiBase: z.string().default(DEFAULT_API_BASE).volatile(),
	accounts: z.array(z.object({
		id: z.string().default(""),
		label: z.string().default(""),
		apiKeyEnv: z.string().role("credential-ref").default("")
	})).default([]).volatile(),
	activeAccount: z.string().default("").volatile(),
	modelSelection: z.object({
		include: z.array(z.string()).default([]),
		exclude: z.array(z.string()).default([])
	}).volatile(),
	concurrency: z.natural().min(1).default(1).volatile(),
	queueTimeoutMs: z.natural().min(1e3).default(DEFAULT_QUEUE_TIMEOUT_MS).volatile(),
	quotaRotation: z.boolean().default(false).volatile(),
	retryPolicy: RetryPolicyFieldsSchema.volatile(),
	errorLog: z.boolean().default(true).volatile(),
	poolPolicy: z.object({
		kickThreshold: z.natural().min(1).max(10).default(DEFAULT_KEY_POOL_PARAMS.kickThreshold),
		probeInitialMs: z.natural().min(5e3).max(3e5).default(DEFAULT_KEY_POOL_PARAMS.probeInitialMs),
		probeBackoffFactor: z.number().min(1).max(10).default(DEFAULT_KEY_POOL_PARAMS.probeBackoffFactor),
		probeMaxMs: z.natural().min(5e3).max(6e5).default(DEFAULT_KEY_POOL_PARAMS.probeMaxMs),
		capacity: z.natural().min(1).max(10).default(DEFAULT_KEY_POOL_PARAMS.capacity)
	}).volatile(),
	requestParams: z.object({
		topP: z.number().min(0).max(1),
		frequencyPenalty: z.number().min(-2).max(2),
		presencePenalty: z.number().min(-2).max(2),
		seed: z.number().min(0).max(9999999),
		doSample: z.boolean()
	}).volatile()
});
/**
* cordis 的 `Volatile<T>` 在运行期是一个**只带 `get()` 的对象**。
*
* 实测形状：`Object.keys(config.accounts)` = `['get']`，`JSON.stringify(config)` 里
* 每个字段都是 `{}` ⇒ 直接把 `config.accounts` 当下发数组用会读到引用对象。
*
* 用**结构化判定**而不是 `@deepseek-ai/cosmokit` 的 `isVolatile()`：本插件的
* tsdown `external` 白名单里没有 cosmokit（新增值 import 会被**打进产物**）。
* 本插件的字段类型只有 string/number/boolean/array/plain-object，都不带 `get`
* 方法，故该判定不会误伤。
*/
function isVolatileRef(value) {
	return typeof value === "object" && value !== null && typeof value.get === "function";
}
/**
* 把带 volatile 引用的配置解包成普通值（对齐官方 `llm-deepseek` 的 `plainOptions()`）。
*
* 🔴 与 `.volatile()` 配套，缺了它整个插件会读到引用对象。
*
* @param config - `apply()` 收到的原始配置（字段可能是 volatile 引用）。
* @returns 字段全部为普通值的配置，可直接交给 `resolveAdapterOptions()`。
*/
function plainConfig(config) {
	const out = {};
	for (const [key, value] of Object.entries(config)) out[key] = isVolatileRef(value) ? value.get() : value;
	return out;
}
/** 把配置的并发上限归一化为正整数（非正整数/无法解析回退 1）。 */
function normalizeConcurrency(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}
/** 把配置的排队超时归一化为正整数毫秒；非法值回退 DEFAULT_QUEUE_TIMEOUT_MS。 */
function normalizeQueueTimeout(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_QUEUE_TIMEOUT_MS;
}
/** 整数钳制：非法或越界一律回落缺省，**绝不抛**（与 `normalizeConcurrency` 同一约定）。 */
function clampInt(value, min, max, fallback) {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
/**
* 归一化 key 池策略（2026-09-27 新增）。
*
* 约定与其它归一化助手一致：**非法值回退缺省，绝不抛** —— 抛会打断设置保存、让整个
* 设置页卡住（本插件在 `normalizeRequestParams` 处已确立该约定）。
*
* 额外维护一条不变量：`probeMaxMs >= probeInitialMs`。否则退避会「越等越短」，与
* 探测退避的意图正好相反；违反时把 `probeMaxMs` 抬到 `probeInitialMs`。
*/
function normalizePoolPolicy(value) {
	const raw = typeof value === "object" && value !== null ? value : {};
	const probeInitialMs = clampInt(raw.probeInitialMs, 5e3, 3e5, DEFAULT_KEY_POOL_PARAMS.probeInitialMs);
	const backoff = typeof raw.probeBackoffFactor === "number" && Number.isFinite(raw.probeBackoffFactor) ? raw.probeBackoffFactor : DEFAULT_KEY_POOL_PARAMS.probeBackoffFactor;
	const probeMaxMs = clampInt(raw.probeMaxMs, 5e3, 6e5, DEFAULT_KEY_POOL_PARAMS.probeMaxMs);
	return {
		kickThreshold: clampInt(raw.kickThreshold, 1, 10, DEFAULT_KEY_POOL_PARAMS.kickThreshold),
		probeInitialMs,
		probeBackoffFactor: backoff >= 1 && backoff <= 10 ? backoff : DEFAULT_KEY_POOL_PARAMS.probeBackoffFactor,
		probeMaxMs: Math.max(probeMaxMs, probeInitialMs),
		capacity: clampInt(raw.capacity, 1, 10, DEFAULT_KEY_POOL_PARAMS.capacity)
	};
}
/** 领域层规范化模型 id：去除首尾空白、过滤空项、稳定去重。 */
function normalizeModelIds(value) {
	if (!Array.isArray(value)) return [];
	const seen = /* @__PURE__ */ new Set();
	const result = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const id = item.trim();
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		result.push(id);
	}
	return result;
}
/** 规范化用户模型选择配置；未配置时保持 undefined，便于 settings unset。 */
function normalizeModelSelection(selection) {
	if (selection === void 0 || selection === null || typeof selection !== "object") return void 0;
	return {
		include: normalizeModelIds(selection.include),
		exclude: normalizeModelIds(selection.exclude)
	};
}
function resolveSlot(id, label, value) {
	const ref = typeof value === "string" ? value.trim() : "";
	return isCredentialRefName(ref) ? {
		id,
		label,
		ref,
		isLiteral: false
	} : {
		id,
		label,
		ref: "",
		isLiteral: false
	};
}
/**
* 把用户配置的 `retryPolicy` 与缺省值**逐层合并**（2026-09-17 W1）。
*
* ⚠️ 为什么不能写成 `config.retryPolicy ?? DEFAULT_RETRY_POLICY_CONFIG`：
* 设置页允许只改其中一项（例如只调 `maxRetries`），而 `RetryPolicyConfig` 在
* schema 里是 `z.union` 形状，用户只填部分键时缺省 `backoff` **未必被补全**
* ⇒ `resolveRetryPolicy()` 会退回 schema 缺省 `maxDelayMs = 10_000`，而该值
* 远小于适配器能吐出的 pra 上限（300_000）⇒ **悬崖立刻重现**。
*
* 逐层兜底把"防悬崖"从「用户必须填全」变成「结构性保证」。
* 并集安全：`ALWAYS_POLICY_KEYS` 与 `NORMAL_POLICY_KEYS` 都接受
* `maxRetries`/`retryableCodes`（后者明确注释为"切模式后保留的惰性字段"），
* 因此合并出的对象无论走哪条分支都能通过 `validateKeys`。
*/
function mergeRetryPolicy(config) {
	if (config === void 0) return DEFAULT_RETRY_POLICY_CONFIG;
	const base = DEFAULT_RETRY_POLICY_CONFIG;
	const override = config;
	const merged = {
		...base,
		...override,
		backoff: {
			...base.backoff,
			...override.backoff
		}
	};
	const backoff = merged.backoff ?? {};
	merged.backoff = {
		...backoff,
		maxDelayMs: Math.max(backoff.maxDelayMs ?? 0, QUOTA_RETRY_AFTER_CEILING_MS)
	};
	return merged;
}
/**
* 从原始 config 到解析后连接事实的唯一显式步骤。程序化构造可能绕过
* Schemastery 归一化，因此每个默认值在此重新判定——既用于加载时的组合配置，
* 也用于 settings 快照首次使用。
*/
/**
* 归一化 L2 请求参数默认值。
*
* 遵循本插件的通用约定：**非法值一律回退「不注入」，绝不抛** —— 抛会打断设置保存，
* 让整个设置页卡住。Schemastery 已在 schema 层做过范围校验，这里防御的是
* "程序化构造绕过 schema"的情形（单测、profile patch 直写）。
*
* 返回值里只保留**合法**字段；全不合法时返回空对象 ⇒ `l2ParamsFor()` 自然不注入。
*/
function normalizeRequestParams(input) {
	if (input === void 0) return {};
	const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : void 0;
	const out = {};
	const topP = num(input.topP, 0, 1);
	if (topP !== void 0) out.topP = topP;
	const frequencyPenalty = num(input.frequencyPenalty, -2, 2);
	if (frequencyPenalty !== void 0) out.frequencyPenalty = frequencyPenalty;
	const presencePenalty = num(input.presencePenalty, -2, 2);
	if (presencePenalty !== void 0) out.presencePenalty = presencePenalty;
	const seed = num(input.seed, 0, 9999999);
	if (seed !== void 0) out.seed = seed;
	if (typeof input.doSample === "boolean") out.doSample = input.doSample;
	return out;
}
function resolveAdapterOptions(config) {
	const accounts = [];
	const defaultEnv = config.apiKeyEnv ?? "SENSENOVA_API_KEY";
	accounts.push(resolveSlot("default", "Default", defaultEnv));
	for (const [index, account] of (config.accounts ?? []).entries()) {
		if (account === void 0) continue;
		const refName = typeof account.apiKeyEnv === "string" && account.apiKeyEnv.trim() !== "" ? account.apiKeyEnv.trim() : void 0;
		if (refName === void 0) continue;
		const id = typeof account.id === "string" && account.id.trim() !== "" ? account.id.trim() : `account-${index + 2}`;
		const label = typeof account.label === "string" && account.label.trim() !== "" ? account.label.trim() : `Account ${index + 2}`;
		accounts.push(resolveSlot(id, label, refName));
	}
	const modelSelection = normalizeModelSelection(config.modelSelection);
	return {
		apiBase: config.apiBase ?? "https://token.sensenova.cn/v1",
		activeAccount: typeof config.activeAccount === "string" ? config.activeAccount : "",
		accounts,
		concurrency: normalizeConcurrency(config.concurrency),
		queueTimeoutMs: normalizeQueueTimeout(config.queueTimeoutMs),
		quotaRotation: config.quotaRotation === true,
		retryPolicy: resolveRetryPolicy(mergeRetryPolicy(config.retryPolicy), "llm-sensenova.retryPolicy"),
		errorLog: config.errorLog !== false,
		poolPolicy: normalizePoolPolicy(config.poolPolicy),
		requestParams: normalizeRequestParams(config.requestParams),
		...modelSelection !== void 0 ? { modelSelection } : {}
	};
}
function apply(ctx, config) {
	const resolvedConfig = plainConfig(config);
	const current = () => resolvedConfig;
	let lastRaw;
	let lastGood;
	const options = () => {
		const raw = current();
		if (raw === lastRaw && lastGood !== void 0) return lastGood;
		const next = resolveAdapterOptions(raw);
		lastRaw = raw;
		lastGood = next;
		return next;
	};
	options();
	const resolveRef = async (spec) => {
		if (spec.isLiteral || !isCredentialRefName(spec.ref)) return void 0;
		const ref = credentialRef(spec.ref);
		const credentials = ctx.get("credentials");
		if (credentials !== void 0) {
			const resolved = await credentials.resolve(ref);
			if (resolved !== void 0 && resolved.value !== void 0 && resolved.value !== "") return resolved.value;
		}
		const ambient = launchEnvironmentOf(ctx).get(spec.ref);
		if (ambient !== void 0 && ambient.value.length > 0) return ambient.value;
	};
	const slots = () => options().accounts.map((spec) => ({
		id: spec.id,
		label: spec.label,
		ref: spec.ref,
		resolveKey: () => resolveRef(spec)
	}));
	const preferredId = () => {
		const active = options().activeAccount;
		return active !== "" ? active : void 0;
	};
	const pool = new SensenovaAccountPool({
		slots,
		preferredId
	});
	const gate = new KeyedConcurrencyGate();
	const keyPoolParams = () => options().poolPolicy;
	const keyPool = new SensenovaKeyPool({ params: keyPoolParams });
	/** key → 可读描述（账户名 + credential-ref 名），供限流事件的展示字段反查。 */
	const keyIndex = /* @__PURE__ */ new Map();
	/** 登记一次凭据解析的结果，供 `describeKey` 反查（key 原文只在内存，绝不进日志）。 */
	const rememberKey = (key, slot) => {
		keyIndex.set(key, {
			label: slot.label,
			ref: slot.ref
		});
	};
	const errorLog = new SenseNovaErrorLog();
	const resolveApiKey = async (connection, hint) => {
		const resolved = await pool.resolveKey();
		if (resolved === void 0) throw new LlmError(`llm-sensenova: no API key for provider route "${PROVIDER}" (apiBase ${connection.apiBase}); store a key through the credentials service or settings；未配置 SenseNova API 密钥，请在设置页或凭据页配置`, "MISSING_CREDENTIAL");
		const fallbackKey = assertUsableApiKey(resolved.key, "llm-sensenova", resolved.slot.label);
		rememberKey(fallbackKey, resolved.slot);
		const all = await pool.resolvedAccounts();
		for (const account of all) rememberKey(account.key, account.slot);
		const dropped = keyPool.seed(all.map((account) => account.key));
		if (dropped > 0) ctx.logger.warn("llm-sensenova: %d 个账户超出 key 池容量上限 %d，已被忽略（可调高设置页的「槽位上限」）", dropped, keyPoolParams().capacity);
		return keyPool.pickStart(hint?.preferredKey) ?? fallbackKey;
	};
	const rotateApiKey = async (rejectedKey, rejection, exclude) => {
		pool.markRejected(rejectedKey, rejection);
		if (rejection === "invalid-credential") keyPool.remove(rejectedKey);
		const next = keyPool.pickNext(exclude ?? EMPTY_KEY_SET);
		if (next === void 0) return void 0;
		return assertUsableApiKey(next, "llm-sensenova", keyIndex.get(next)?.label ?? next);
	};
	const adapter = new SensenovaAdapter({
		options: () => {
			const resolved = options();
			return {
				apiBase: resolved.apiBase,
				accountCount: resolved.accounts.length,
				concurrency: resolved.concurrency,
				queueMs: resolved.queueTimeoutMs,
				quotaRotation: resolved.quotaRotation,
				retryPolicy: resolved.retryPolicy,
				requestParams: resolved.requestParams,
				...resolved.modelSelection !== void 0 ? { modelSelection: resolved.modelSelection } : {}
			};
		},
		resolveApiKey,
		rotateApiKey,
		concurrencyGate: gate,
		reportRateLimit: (key, kind) => {
			const poolState = () => {
				const state = keyPool.snapshot();
				return {
					running: state.running.length,
					blocked: state.blocked.length
				};
			};
			if (kind !== "tpm") return {
				kicked: false,
				...poolState()
			};
			const { kicked } = keyPool.recordTpmStrike(key);
			return {
				kicked,
				...poolState()
			};
		},
		reportSuccess: (key) => keyPool.onSuccess(key),
		describeKey: (key) => keyIndex.get(key),
		resolveImage: createResolveImage(() => ctx.get("attachments")),
		imagePolicy: () => DEFAULT_IMAGE_POLICY,
		errorLog: () => options().errorLog ? errorLog : void 0
	});
	ctx.llm.registerConfigurableProviders([{
		provider: PROVIDER,
		displayName: "SenseNova",
		settingsNs: NS,
		settingsPath: []
	}]);
	ctx.llm.registerAdapter([PROVIDER], adapter);
	const probeScheduler = createProbeScheduler({
		keyPool,
		gate,
		apiBase: () => options().apiBase,
		concurrency: () => options().concurrency
	});
	ctx.effect(() => {
		const controller = new AbortController();
		const timer = setInterval(() => {
			probeScheduler.tick(controller.signal);
		}, PROBE_TICK_MS);
		timer.unref?.();
		return () => {
			clearInterval(timer);
			controller.abort();
		};
	}, "llm-sensenova: blocked-key probe scheduler");
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
	});
	ctx.inject(["connection"], (connectionCtx) => {
		connectionCtx.effect(() => connectionCtx.connection.fetch.register({
			path: ERROR_LOG_ROUTE,
			methods: ["GET"],
			requestBody: "buffered",
			fetch: (request) => handleErrorLogHttp(request)
		}), `llm-sensenova: error log route ${ERROR_LOG_ROUTE}`);
	});
	const modelInfoDeps = () => ({
		currentSelection: () => {
			try {
				const raw = ctx.get("agentDefaultModel")?.currentSelection?.();
				if (typeof raw !== "object" || raw === null) return void 0;
				const selection = raw;
				return {
					...typeof selection.provider === "string" && selection.provider !== "" ? { provider: selection.provider } : {},
					...typeof selection.model === "string" && selection.model !== "" ? { model: selection.model } : {},
					...typeof selection.reasoningEffort === "string" && selection.reasoningEffort !== "" ? { reasoningEffort: selection.reasoningEffort } : {}
				};
			} catch {
				return;
			}
		},
		resolveModelInfo: async (provider, model) => {
			try {
				const info = await ctx.get("llm")?.resolveModelInfo?.(provider, model);
				return typeof info === "object" && info !== null ? info : void 0;
			} catch {
				return;
			}
		},
		requestParams: options().requestParams,
		accountPool: () => {
			const resolved = options();
			return {
				slots: resolved.accounts.length,
				refs: resolved.accounts.map((account) => account.ref),
				activeAccount: resolved.activeAccount,
				quotaRotation: resolved.quotaRotation
			};
		},
		settingsProbe: () => {
			try {
				const settings = ctx.get("settings");
				const writable = typeof settings?.writable === "boolean" ? settings.writable : void 0;
				if (settings?.describe === void 0) return {
					serviceAvailable: false,
					accountsInSettings: -1,
					namespacesSeen: 0
				};
				const described = settings.describe({ redactSecrets: true });
				if (!Array.isArray(described)) return {
					serviceAvailable: true,
					accountsInSettings: -1,
					namespacesSeen: 0,
					...writable !== void 0 ? { writable } : {},
					error: "describe-not-array"
				};
				const hits = described.filter((row) => row?.ns === NS);
				if (hits.length === 0) return {
					serviceAvailable: true,
					accountsInSettings: -1,
					namespacesSeen: 0,
					...writable !== void 0 ? { writable } : {}
				};
				const first = hits[0];
				const accountsRaw = (typeof first.value === "object" && first.value !== null ? first.value : void 0)?.accounts;
				return {
					serviceAvailable: true,
					accountsInSettings: Array.isArray(accountsRaw) ? accountsRaw.length : -1,
					namespacesSeen: hits.length,
					...writable !== void 0 ? { writable } : {}
				};
			} catch (err) {
				return {
					serviceAvailable: false,
					accountsInSettings: -1,
					namespacesSeen: 0,
					error: String(err?.message ?? err).slice(0, 200)
				};
			}
		}
	});
	ctx.inject(["connection"], (connectionCtx) => {
		connectionCtx.effect(() => connectionCtx.connection.fetch.register({
			path: MODEL_INFO_ROUTE,
			methods: ["GET"],
			requestBody: "buffered",
			fetch: (request) => handleModelInfoHttp(request, modelInfoDeps())
		}), `llm-sensenova: model info route ${MODEL_INFO_ROUTE}`);
	});
}
/**
* 探测用的固定模型 id。
*
* 用 v4.1 的 `deepseek-flash`：它已实测可路由，且**限流是 key 级的**（与服务端用哪个
* 模型无关）⇒ 用哪个模型探测结论都一样。固定常量最简单，也不依赖会话上下文。
*/
const PROBE_MODEL = "deepseek-flash";
/** 单次探测的超时（毫秒）。故意短于生产建连超时：探测要的是快速结论，不是结果本身。 */
const PROBE_TIMEOUT_MS = 1e4;
/** 探测定时器的粒度（毫秒）。取 5s 以尊重最短 15s 的探测间隔。 */
const PROBE_TICK_MS = 5e3;
/**
* 创建阻塞态 key 的恢复探测调度器。
*
* **为什么必须有它**：agent 请求只会选中**运行态**的 key，阻塞态的 key 不会被任何 agent
* 请求碰到 ⇒ 若不主动探测，它们永远回不来。这正是旧「全池饱和短路」无法自解的根源 ——
* 它的恢复权握在「跳过轮数涨到 5」上，而那个计数只在请求成功时才清零，成功又依赖轮换，
* 于是构成死锁。本调度器把「恢复」与「agent 请求」彻底解耦。
*
* 抽成工厂是为了**可测试**：单测直接调 `tick()`，不需要真实定时器，也不需要网络
* （注入 `fetchImpl`）。`apply()` 只负责用 `ctx.effect` 包一层定时器。
*/
function createProbeScheduler(deps) {
	const now = deps.now ?? Date.now;
	const doFetch = deps.fetchImpl ?? fetch;
	const model = deps.model ?? "deepseek-flash";
	const timeoutMs = deps.timeoutMs ?? 1e4;
	/**
	* 发一次「最小请求」，判断该 key 的配额是否已恢复。
	*
	* 判据**只有 HTTP 状态码**：2xx ⇒ 已恢复；其余（尤其 429）⇒ 未恢复。
	* 请求体刻意压到最小，且**显式关闭思考** —— v4.1 默认开启思考，不关的话这个"最小请求"
	* 并不小（Phase 0 实测 `reasoning_tokens` 20~29）。
	*/
	const probeOne = async (key, signal) => {
		const timeout = AbortSignal.timeout(timeoutMs);
		const response = await doFetch(`${deps.apiBase()}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${key}`,
				...attributionHeaders()
			},
			body: JSON.stringify({
				model,
				messages: [{
					role: "user",
					content: "ping"
				}],
				max_tokens: 1,
				stream: true,
				reasoning_effort: "none",
				stream_options: { include_usage: true }
			}),
			signal: signal === void 0 ? timeout : AbortSignal.any([signal, timeout])
		});
		await response.body?.cancel().catch(() => void 0);
		return response.ok;
	};
	return { tick: async (signal) => {
		const at = now();
		for (const entry of deps.keyPool.blockedEntries()) {
			if (at < deps.keyPool.nextProbeAt(entry)) continue;
			const release = deps.gate.tryAcquire(entry.key, deps.concurrency());
			if (release === void 0) continue;
			let recovered = false;
			try {
				recovered = await probeOne(entry.key, signal);
			} catch {
				recovered = false;
			} finally {
				release();
			}
			deps.keyPool.recordProbe(entry, recovered);
			return true;
		}
		return false;
	} };
}
//#endregion
export { Config, DEFAULT_API_BASE, DEFAULT_API_KEY_ENV, DOCUMENTED_TEXT_ONLY_MODELS, DOCUMENTED_VISION_MODELS, PROBE_MODEL, PROBE_TICK_MS, PROBE_TIMEOUT_MS, SensenovaAdapter, apply, createProbeScheduler, inject, mergeRetryPolicy, name, normalizeConcurrency, normalizeModelSelection, normalizePoolPolicy, normalizeQueueTimeout, plainConfig, resolveAdapterOptions };

//# sourceMappingURL=index.js.map