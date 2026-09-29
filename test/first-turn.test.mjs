import test from 'node:test';
import assert from 'node:assert/strict';

import { collectFirstTurn, textOfContent } from '../lib/first-turn.mjs';

test('textOfContent 只取 text 块（reasoning / tool-call 必须排除）', () => {
	const content = [
		{ type: 'reasoning', text: '先想一下' },
		{ type: 'text', text: '第一段' },
		{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
		{ type: 'text', text: '第二段' }
	];
	assert.equal(textOfContent(content), '第一段\n第二段');
	assert.equal(textOfContent(undefined), '');
});

test('collectFirstTurn 取首条人类提问 + turn===1 的助手文本', () => {
	const events = [
		{ seq: 9, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '能不能自动改名？' }] } },
		{ seq: 10, type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS 正文' }] } },
		{ seq: 17, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '推测' }, { type: 'text', text: '可以，做法是…' }] } } },
		{ seq: 30, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
		{ seq: 40, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮提问' }] } },
		{ seq: 48, type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第二轮回答' }] } } },
		{ seq: 60, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '补充：只改一次' }] } } }
	];
	assert.deepEqual(collectFirstTurn(events), {
		question: { seq: 9, text: '能不能自动改名？' },
		answerText: '可以，做法是…\n\n补充：只改一次'
	});
});

test('collectFirstTurn：助手第一轮没有文字时 answerText 为空串，提问照给', () => {
	const events = [
		{ seq: 5, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '跑一下测试' }] } },
		{ seq: 6, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-call', id: 'c', name: 'pwsh', arguments: '{}' }] } } }
	];
	assert.deepEqual(collectFirstTurn(events), { question: { seq: 5, text: '跑一下测试' }, answerText: '' });
});

test('collectFirstTurn：没有人类消息时 question 为 null', () => {
	const events = [
		{ seq: 0, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '环境快照' }] } },
		{ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] } }
	];
	assert.deepEqual(collectFirstTurn(events), { question: null, answerText: '' });
});
