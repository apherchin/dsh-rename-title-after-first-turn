/**
 * 编排：把「守卫 → 取素材 → 调模型 → 清洗校验 → 落库」串起来。
 *
 * 依赖全部以参数注入（llm / logger / streamFactory），所以可以在离线测试里用假对象驱动。
 * **handle() 永不外抛**：所有失败都降级为「保持兜底名」+ 一条 warn。
 */
import { randomUUID } from 'node:crypto';

import { collectFirstTurn } from './first-turn.mjs';
import { PROVIDER_ID, decide } from './guard.mjs';
import { normalizeTitle } from './normalize.mjs';
import { buildSystemPrompt, frameMaterial } from './prompt.mjs';
import { createStreamAccumulator } from './stream.mjs';

/** 标题事件的来源标识（写进 `source.provider`）；与插件名一致，属对外协议字符串。 */
const SOURCE_KIND = 'dsh-session-title-first-turn';
/** 辅助 LLM 请求的 purpose（对外协议字符串：DeepSeek 适配器据此关掉思考）；pi-ai 目前不消费。 */
const PURPOSE = 'session-title';

/** 配置缺省值（spec §8）。 */
const DEFAULTS = {
	targetCjkCharacters: 12,
	targetWords: 6,
	maxInputBytes: 8192,
	maxOutputTokens: 2048,
	timeoutMs: 60000,
	maxAttempts: 3,
	maxTitleBytes: 80
};

/**
 * 取一个正整数配置，非法/越界就回退缺省。
 * @param {unknown} value 原始值。
 * @param {number} fallback 缺省值。
 * @param {number} min 下界（含）。
 * @param {number} max 上界（含）。
 * @returns {number} 生效值。
 */
function positiveInt(value, fallback, min, max) {
	return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/**
 * 把一次 abort 变成 rejection，用于给流迭代设**硬边界**。
 * 为什么需要：`for await` 只有在流自己结束时才返回；若某个适配器不消费 `signal`，
 * 它会永不结束 ⇒ in-flight 永久占用、该会话从此静默不再尝试。用 race 强制返回。
 * @param {AbortSignal} signal 信号。
 * @returns {Promise<never>} 永不 resolve；signal 已 abort 时立即 reject。
 */
function abortRejection(signal) {
	return new Promise((_, reject) => {
		const onAbort = () => reject(signal.reason ?? new Error('aborted'));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * 规范化插件配置（不抛错，坏值回退）。
 * @param {unknown} raw profile 里那条 insert 的 config。
 * @returns {Readonly<object>} 冻结后的配置。
 */
export function resolveConfig(raw) {
	const input = raw !== null && typeof raw === 'object' ? raw : {};
	return Object.freeze({
		targetCjkCharacters: positiveInt(input.targetCjkCharacters, DEFAULTS.targetCjkCharacters, 1, 60),
		targetWords: positiveInt(input.targetWords, DEFAULTS.targetWords, 1, 30),
		maxInputBytes: positiveInt(input.maxInputBytes, DEFAULTS.maxInputBytes, 256, 1000000),
		maxOutputTokens: positiveInt(input.maxOutputTokens, DEFAULTS.maxOutputTokens, 32, 32000),
		timeoutMs: positiveInt(input.timeoutMs, DEFAULTS.timeoutMs, 1000, 900000),
		maxAttempts: positiveInt(input.maxAttempts, DEFAULTS.maxAttempts, 1, 10),
		maxTitleBytes: positiveInt(input.maxTitleBytes, DEFAULTS.maxTitleBytes, 8, 512)
	});
}

/**
 * 造命名代理。
 * @param {{config: object, llm: {stream: Function}, logger?: {info?: Function, warn?: Function}, streamFactory?: Function}} deps 依赖。
 * @returns {{handle: (session: object, event: object) => Promise<void>, forget: (session: object | string) => void}} 代理。
 */
export function createTitleAgent(deps) {
	const { config, llm, logger } = deps;
	const attempts = new Map();
	const inFlight = new Set();

	/**
	 * 取会话当前路由（与内置 provider 同源）。
	 * @param {object} session 会话对象。
	 * @returns {{provider: string, model: string} | undefined} 合法路由或 undefined。
	 */
	function routeOf(session) {
		const route = session?.requestHeader?.()?.config;
		const provider = route?.provider;
		const model = route?.model;
		if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return undefined;
		return { provider, model };
	}

	/** 记一行 warn；logger 自身抛错也不能外抛。 */
	function warn(message) {
		try {
			logger?.warn?.(message);
		} catch {
			/* logger 自身出错也不能外抛 */
		}
	}

	/** 记一次尝试（含「无路由」这种没打到模型的尝试，spec §9）。 */
	function bumpAttempts(sessionId) {
		attempts.set(sessionId, (attempts.get(sessionId) ?? 0) + 1);
	}

	/**
	 * 生成并落库一次标题。失败一律 throw，由 handle 统一降级。
	 * @param {object} session 会话。
	 * @param {Array<object>} events 会话事件快照。
	 * @param {{provider: string, model: string}} route 路由。
	 * @returns {Promise<string>} 落库的标题。
	 */
	async function run(session, events, route) {
		const { question, answerText } = collectFirstTurn(events);
		if (question === null) throw new Error('no eligible human message to title from');
		const material = frameMaterial({ question, answerText }, config.maxInputBytes);
		const accumulator = createStreamAccumulator();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error('session-title-first-turn: timeout')), config.timeoutMs);

		try {
			const stream = (deps.streamFactory ?? ((options) => llm.stream(options)))({
				provider: route.provider,
				model: route.model,
				messages: [
					{
						id: randomUUID(),
						role: 'user',
						content: [{ type: 'text', text: material.text }],
						source: { kind: SOURCE_KIND }
					}
				],
				system: buildSystemPrompt(config),
				maxTokens: config.maxOutputTokens,
				sessionId: session.id,
				purpose: PURPOSE,
				signal: controller.signal
			});
			const iterate = (async () => {
				for await (const chunk of stream) accumulator.push(chunk);
			})();
			// 结果统一由 race 处理；这里只防「race 先 reject 而 iterate 后 reject」造成的未处理 rejection
			iterate.catch(() => {
				/* 见上 */
			});
			await Promise.race([iterate, abortRejection(controller.signal)]);
		} finally {
			clearTimeout(timer);
		}

		// 只有 stop 算成功：'incomplete'（未观测到 finish）与畸形 finish 都 fail-closed（见 lib/stream.mjs）
		if (accumulator.finishKind() !== 'stop') {
			const failure = accumulator.failure();
			throw new Error(`model finish was "${accumulator.finishKind()}"${typeof failure?.code === 'string' ? ` (${failure.code})` : ''}`);
		}
		if (accumulator.sawToolCall()) throw new Error('title output contained a tool call');
		const title = normalizeTitle(accumulator.text(), config.maxTitleBytes);
		if (title === '') throw new Error('title output was empty');

		session.append('session/title', {
			title,
			messageSeqs: [question.seq],
			source: { kind: 'provider', provider: PROVIDER_ID, model: { provider: route.provider, model: route.model } }
		});
		return title;
	}

	/**
	 * 处理一条会话事件（只对 turn/end 有反应）。
	 * @param {object} session 会话。
	 * @param {object} event 会话事件。
	 * @returns {Promise<void>} 永不 reject。
	 */
	async function handle(session, event) {
		try {
			if (event?.type !== 'turn/end') return;
			if (session === null || typeof session !== 'object') return;
			if (typeof session.append !== 'function' || typeof session.snapshotEvents !== 'function') return;

			const events = session.snapshotEvents();
			const route = routeOf(session);
			const decision = decide({
				session,
				events,
				turn: event.data?.turn,
				attempts: attempts.get(session.id) ?? 0,
				inFlight: inFlight.has(session.id),
				hasRoute: route !== undefined,
				maxAttempts: config.maxAttempts
			});
			if (!decision.proceed) {
				// spec §9：无路由要「记 warn 并计入尝试」；其余跳过原因按 §4 保持静默（尤其 G1 绝不记日志）
				if (decision.reason === 'no-route') {
					bumpAttempts(session.id);
					warn(`session-title-first-turn: ${session.id} skipped: no session route available yet`);
				}
				return;
			}

			inFlight.add(session.id);
			try {
				const title = await run(session, events, route);
				logger?.info?.(`session-title-first-turn: session ${session.id} titled "${title}"`);
			} finally {
				inFlight.delete(session.id);
				bumpAttempts(session.id);
			}
		} catch (error) {
			warn(`session-title-first-turn: ${session?.id ?? '?'} skipped: ${String(error)}`);
		}
	}

	/**
	 * 忘掉一个会话的全部内存状态（会话被处置时由 index.mjs 调用）。
	 *
	 * 为什么需要：这两个容器按会话 id 累积，而宿主是**长跑**进程 —— 不清理就是无界增长；
	 * 且与本项目踩过的「幽灵未读」事故同型（只在 disposed 时摘除，漏了就永久残留）。
	 * @param {object|string} session 会话对象或会话 id。
	 * @returns {void}
	 */
	function forget(session) {
		const id = typeof session === 'string' ? session : session?.id;
		if (typeof id !== 'string' || id === '') return;
		attempts.delete(id);
		inFlight.delete(id);
	}

	return { handle, forget };
}
