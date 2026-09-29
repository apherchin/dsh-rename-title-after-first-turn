import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDER_ID } from '../lib/guard.mjs';
import { createTitleAgent, resolveConfig } from '../lib/plugin-core.mjs';

/** 假会话：append 会写进 events，与真实日志同一方向。 */
function makeSession({ id = 'session-main', parentSession, initialEvents = [] } = {}) {
	const events = [...initialEvents];
	const appended = [];
	const session = {
		id,
		header: parentSession === undefined ? { delegationDepth: 0 } : { parentSession, delegationDepth: 1 },
		requestHeader: () => ({ config: { provider: 'local-deepseek', model: 'deepseek-v4.1-flash', maxTokens: 128000 } }),
		snapshotEvents: () => events,
		append: (type, data) => {
			appended.push({ type, data });
			events.push({ type, seq: events.length + 100, data });
		},
		appended
	};
	return session;
}

/** 一条标准的第一轮日志：提问 seq=9、助手回答、turn/end。 */
function firstTurnEvents() {
	return [
		{ seq: 9, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '能不能自动改名？' }] } },
		{ seq: 17, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '可以，做法是追加一条标题事件。' }] } } },
		{ seq: 40, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
	];
}

/** 假 ctx.llm.stream：按脚本吐 chunk。 */
function makeLlm(chunks) {
	const calls = [];
	return {
		calls,
		stream(options) {
			calls.push(options);
			return (async function* generate() {
				for (const chunk of chunks) yield chunk;
			})();
		}
	};
}

function makeLogger() {
	const lines = [];
	return {
		lines,
		info: (message) => lines.push(['info', String(message)]),
		warn: (message) => lines.push(['warn', String(message)])
	};
}

test('resolveConfig：缺省值正确，非法/越界一律回退缺省，坏值不抛错', () => {
	assert.deepEqual(resolveConfig(undefined), {
		targetCjkCharacters: 12,
		targetWords: 6,
		maxInputBytes: 8192,
		maxOutputTokens: 2048,
		timeoutMs: 60000,
		maxAttempts: 3,
		maxTitleBytes: 80
	});
	const cfg = resolveConfig({ maxAttempts: 0, maxOutputTokens: 'x', maxTitleBytes: 8, timeoutMs: 100 });
	assert.equal(cfg.maxAttempts, 3);
	assert.equal(cfg.maxOutputTokens, 2048);
	assert.equal(cfg.maxTitleBytes, 8);
	assert.equal(cfg.timeoutMs, 60000);
	const upper = resolveConfig({
		maxAttempts: 99,
		maxInputBytes: 255,
		maxTitleBytes: 513,
		timeoutMs: 900001,
		maxOutputTokens: 99999,
		targetWords: 99,
		targetCjkCharacters: 99
	});
	assert.equal(upper.maxAttempts, 3);
	assert.equal(upper.maxInputBytes, 8192);
	assert.equal(upper.maxTitleBytes, 80);
	assert.equal(upper.timeoutMs, 60000);
	assert.equal(upper.maxOutputTokens, 2048);
	assert.equal(upper.targetWords, 6);
	assert.equal(upper.targetCjkCharacters, 12);
});

test('主线：turn=1 结束 ⇒ append 一条逐字正确的 session/title', async () => {
	const session = makeSession({ initialEvents: firstTurnEvents() });
	const llm = makeLlm([
		{ type: 'block-start', index: 0, blockType: 'reasoning' },
		{ type: 'reasoning-delta', index: 0, text: '先想' },
		{ type: 'block-start', index: 1, blockType: 'text' },
		{ type: 'text-delta', index: 1, text: '会话自动' },
		{ type: 'text-delta', index: 1, text: '重命名' },
		{ type: 'finish', reason: { kind: 'stop' } }
	]);
	const logger = makeLogger();
	const agent = createTitleAgent({ config: resolveConfig({}), llm, logger });

	await agent.handle(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

	assert.equal(session.appended.length, 1);
	assert.deepEqual(session.appended[0], {
		type: 'session/title',
		data: {
			title: '会话自动重命名',
			messageSeqs: [9],
			source: { kind: 'provider', provider: PROVIDER_ID, model: { provider: 'local-deepseek', model: 'deepseek-v4.1-flash' } }
		}
	});
	assert.equal(llm.calls.length, 1);
	assert.equal(llm.calls[0].purpose, 'session-title');
	assert.equal(llm.calls[0].maxTokens, 2048);
	assert.equal(llm.calls[0].sessionId, 'session-main');
	assert.equal(llm.calls[0].provider, 'local-deepseek');
	assert.match(llm.calls[0].system, /one line/);
	assert.match(llm.calls[0].messages[0].content[0].text, /能不能自动改名？/);
	assert.equal(logger.lines.some(([level]) => level === 'info'), true);
});

test('子会话（有 parentSession）完全不碰：不调模型、不 append', async () => {
	const session = makeSession({ id: 'session-child', parentSession: 'session-main', initialEvents: firstTurnEvents() });
	const llm = makeLlm([{ type: 'finish', reason: { kind: 'stop' } }]);
	const agent = createTitleAgent({ config: resolveConfig({}), llm, logger: makeLogger() });

	await agent.handle(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

	assert.equal(llm.calls.length, 0);
	assert.equal(session.appended.length, 0);
});

test('已有我们的标题 ⇒ 后续轮次不再改名', async () => {
	const ourTitle = { seq: 50, type: 'session/title', data: { title: '上一轮起的名字', messageSeqs: [9], source: { kind: 'provider', provider: PROVIDER_ID } } };
	const session = makeSession({ initialEvents: [...firstTurnEvents(), ourTitle] });
	const llm = makeLlm([{ type: 'text-delta', index: 0, text: '新名字' }, { type: 'finish', reason: { kind: 'stop' } }]);
	const agent = createTitleAgent({ config: resolveConfig({}), llm, logger: makeLogger() });

	await agent.handle(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });

	assert.equal(llm.calls.length, 0);
	assert.equal(session.appended.length, 0);
});

test('用户手改过名 ⇒ 绝不覆盖', async () => {
	const userTitle = { seq: 50, type: 'session/title', data: { title: '我起的名字', messageSeqs: [], source: { kind: 'user' } } };
	const session = makeSession({ initialEvents: [...firstTurnEvents(), userTitle] });
	const llm = makeLlm([{ type: 'text-delta', index: 0, text: '想覆盖你' }, { type: 'finish', reason: { kind: 'stop' } }]);
	const agent = createTitleAgent({ config: resolveConfig({}), llm, logger: makeLogger() });

	await agent.handle(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

	assert.equal(session.appended.length, 0);
	assert.equal(llm.calls.length, 0);
});

test('模型失败（max-tokens / 工具调用 / 空输出）⇒ 不 append、不外抛、warn 文案能区分原因', async () => {
	const cases = [
		{
			chunks: [{ type: 'text-delta', index: 0, text: '半截' }, { type: 'finish', reason: { kind: 'max-tokens' } }],
			pattern: /max-tokens/
		},
		{
			chunks: [{ type: 'tool-call-delta', index: 0, id: 'c', name: 'read', argumentsDelta: '{}' }, { type: 'finish', reason: { kind: 'stop' } }],
			pattern: /tool call/
		},
		{ chunks: [{ type: 'finish', reason: { kind: 'stop' } }], pattern: /empty/ }
	];
	for (const { chunks, pattern } of cases) {
		const session = makeSession({ initialEvents: firstTurnEvents() });
		const logger = makeLogger();
		const agent = createTitleAgent({ config: resolveConfig({}), llm: makeLlm(chunks), logger });

		await agent.handle(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

		assert.equal(session.appended.length, 0);
		const warns = logger.lines.filter(([level]) => level === 'warn').map(([, text]) => text);
		assert.equal(warns.length, 1);
		assert.match(warns[0], pattern);
	}
});

test('未观测到终态 finish（静默结束）⇒ 编排层拦下、不落库、warn 含 incomplete', async () => {
	const session = makeSession({ initialEvents: firstTurnEvents() });
	const logger = makeLogger();
	const agent = createTitleAgent({
		config: resolveConfig({}),
		llm: makeLlm([{ type: 'text-delta', index: 0, text: '半截标题' }]),
		logger
	});

	await agent.handle(session, { type: 'turn/end', data: { turn: 1 } });

	assert.equal(session.appended.length, 0);
	const warns = logger.lines.filter(([level]) => level === 'warn').map(([, text]) => text);
	assert.equal(warns.length, 1);
	assert.match(warns[0], /incomplete/);
});

test('超时是硬边界：适配器不消费 signal 也会返回、不落库、有 warn、in-flight 已释放', async () => {
	const session = makeSession({ initialEvents: firstTurnEvents() });
	const logger = makeLogger();
	let seenSignal;
	let factoryCalls = 0;
	const agent = createTitleAgent({
		config: resolveConfig({ timeoutMs: 1000 }),
		llm: {
			stream: () => {
				throw new Error('不该走到 llm.stream：测试用 streamFactory');
			}
		},
		logger,
		streamFactory: (options) => {
			factoryCalls += 1;
			seenSignal = options.signal;
			return (async function* neverEnds() {
				await new Promise(() => {
					/* 永不 settle，且完全不看 signal */
				});
			})();
		}
	});

	const started = Date.now();
	await agent.handle(session, { type: 'turn/end', data: { turn: 1 } });

	assert.equal(seenSignal instanceof AbortSignal, true);
	assert.equal(Date.now() - started < 5000, true);
	assert.equal(session.appended.length, 0);
	assert.equal(logger.lines.some(([level]) => level === 'warn'), true);

	// in-flight 必须已释放：下一轮仍会真的再尝试（而不是被 'in-flight' 挡住）
	await agent.handle(session, { type: 'turn/end', data: { turn: 2 } });
	assert.equal(factoryCalls, 2);
});

test('会话被处置后 forget 清掉记忆：尝试次数不再累积', async () => {
	const session = makeSession({ initialEvents: firstTurnEvents() });
	const llm = makeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'busy' } } }]);
	const agent = createTitleAgent({ config: resolveConfig({ maxAttempts: 1 }), llm, logger: makeLogger() });

	await agent.handle(session, { type: 'turn/end', data: { turn: 1 } });
	assert.equal(llm.calls.length, 1);
	await agent.handle(session, { type: 'turn/end', data: { turn: 2 } });
	assert.equal(llm.calls.length, 1); // 尝试用尽 ⇒ 不再尝试

	agent.forget(session);

	await agent.handle(session, { type: 'turn/end', data: { turn: 3 } });
	assert.equal(llm.calls.length, 2); // 记忆已清 ⇒ 重新尝试
});

test('append 抛错 ⇒ handle 不抛（resolve）', async () => {
	const session = makeSession({ initialEvents: firstTurnEvents() });
	session.append = () => {
		throw new Error('invariant violated');
	};
	const logger = makeLogger();
	const agent = createTitleAgent({
		config: resolveConfig({}),
		llm: makeLlm([{ type: 'text-delta', index: 0, text: '名字' }, { type: 'finish', reason: { kind: 'stop' } }]),
		logger
	});

	await assert.doesNotReject(() => agent.handle(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }));
	assert.equal(logger.lines.some(([level]) => level === 'warn'), true);
});

test('maxAttempts=1：第一次失败后再来一轮也不再尝试', async () => {
	const session = makeSession({ initialEvents: firstTurnEvents() });
	const llm = makeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'busy' } } }]);
	const agent = createTitleAgent({ config: resolveConfig({ maxAttempts: 1 }), llm, logger: makeLogger() });

	await agent.handle(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
	await agent.handle(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });

	assert.equal(llm.calls.length, 1);
	assert.equal(session.appended.length, 0);
});

test('非 turn/end 事件一律忽略', async () => {
	const session = makeSession({ initialEvents: firstTurnEvents() });
	const llm = makeLlm([{ type: 'finish', reason: { kind: 'stop' } }]);
	const agent = createTitleAgent({ config: resolveConfig({}), llm, logger: makeLogger() });

	await agent.handle(session, { type: 'user/message', data: {} });
	await agent.handle(session, { type: 'turn/end', data: { turn: 0 } });

	assert.equal(llm.calls.length, 0);
	assert.equal(session.appended.length, 0);
});

test('无路由：记 warn 且计入尝试（spec §9），不会静默吞掉（R3）', async () => {
	const session = makeSession({ initialEvents: firstTurnEvents() });
	session.requestHeader = () => undefined;
	const llm = makeLlm([{ type: 'finish', reason: { kind: 'stop' } }]);
	const logger = makeLogger();
	const agent = createTitleAgent({ config: resolveConfig({ maxAttempts: 2 }), llm, logger });

	await agent.handle(session, { type: 'turn/end', data: { turn: 1 } });
	assert.equal(llm.calls.length, 0);
	assert.equal(session.appended.length, 0);
	assert.equal(logger.lines.filter(([level]) => level === 'warn').length, 1);

	await agent.handle(session, { type: 'turn/end', data: { turn: 2 } });
	assert.equal(logger.lines.filter(([level]) => level === 'warn').length, 2);

	// 无路由那次也计入尝试 ⇒ 用尽后不再 warn
	await agent.handle(session, { type: 'turn/end', data: { turn: 3 } });
	assert.equal(logger.lines.filter(([level]) => level === 'warn').length, 2);
});

test('其它跳过原因保持静默：子会话 / 已有我们的标题 / 用户手改名都零日志（R3）', async () => {
	const cases = [
		makeSession({ id: 'session-child', parentSession: 'session-main', initialEvents: firstTurnEvents() }),
		makeSession({
			initialEvents: [
				...firstTurnEvents(),
				{ seq: 70, type: 'session/title', data: { title: 'x', messageSeqs: [9], source: { kind: 'provider', provider: PROVIDER_ID } } }
			]
		}),
		makeSession({
			initialEvents: [...firstTurnEvents(), { seq: 71, type: 'session/title', data: { title: 'y', messageSeqs: [], source: { kind: 'user' } } }]
		})
	];
	for (const session of cases) {
		const logger = makeLogger();
		const llm = makeLlm([{ type: 'finish', reason: { kind: 'stop' } }]);
		const agent = createTitleAgent({ config: resolveConfig({}), llm, logger });
		await agent.handle(session, { type: 'turn/end', data: { turn: 1 } });
		assert.equal(logger.lines.length, 0);
		assert.equal(llm.calls.length, 0);
		assert.equal(session.appended.length, 0);
	}
});
