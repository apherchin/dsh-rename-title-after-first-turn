import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt, frameMaterial } from '../lib/prompt.mjs';

test('buildSystemPrompt 带上目标字数、要求单行纯文本', () => {
	const prompt = buildSystemPrompt({ targetWords: 6, targetCjkCharacters: 12 });
	assert.match(prompt, /one line/);
	assert.match(prompt, /6 words/);
	assert.match(prompt, /12 CJK characters/);
	assert.match(prompt, /No code is allowed/);
});

test('frameMaterial 小素材原样打包', () => {
	const result = frameMaterial({ question: { seq: 9, text: '能不能自动改名？' }, answerText: '可以，做法是…' }, 8192);
	assert.equal(result.truncated, false);
	assert.match(result.text, /能不能自动改名？/);
	assert.match(result.text, /可以，做法是…/);
	assert.equal(Buffer.byteLength(result.text, 'utf8') <= 8192, true);
});

test('frameMaterial 超长素材被截到预算内且带截断标记', () => {
	const question = { seq: 9, text: '问'.repeat(5000) };
	const result = frameMaterial({ question, answerText: '答'.repeat(5000) }, 4096);
	assert.equal(result.truncated, true);
	assert.equal(Buffer.byteLength(result.text, 'utf8') <= 4096, true);
	assert.match(result.text, /已截断/);
	assert.equal(result.text.includes('undefined'), false);
	assert.equal(result.text.startsWith('Generate the session title'), true);
});

test('frameMaterial 在极小预算下也不超预算、不抛错', () => {
	const result = frameMaterial({ question: { seq: 1, text: '问'.repeat(200) }, answerText: '答'.repeat(200) }, 256);
	assert.equal(Buffer.byteLength(result.text, 'utf8') <= 256, true);
	assert.equal(result.truncated, true);
});

test('frameMaterial 缺回答时也成立（JSON 里是空串）', () => {
	const result = frameMaterial({ question: { seq: 3, text: '跑一下测试' }, answerText: '' }, 8192);
	assert.equal(result.truncated, false);
	assert.match(result.text, /"assistantFirstReply":""/);
});

test('question 为 null / 文本为空 + 超长回答也不抛错（永不抛错契约）', () => {
	for (const budget of [256, 8192, 65536]) {
		const result = frameMaterial({ question: null, answerText: '答'.repeat(5000) }, budget);
		assert.equal(Buffer.byteLength(result.text, 'utf8') <= budget, true);
		assert.equal(result.text.includes('undefined'), false);
	}
	const empty = frameMaterial({ question: { seq: 1, text: '' }, answerText: '答'.repeat(5000) }, 256);
	assert.equal(Buffer.byteLength(empty.text, 'utf8') <= 256, true);
});

test('极小预算（130）不抛错且落在预算内；预算形如 60% 的分配不会算出非法值', () => {
	const result = frameMaterial({ question: { seq: 1, text: '问'.repeat(200) }, answerText: '答'.repeat(200) }, 130);
	assert.equal(Buffer.byteLength(result.text, 'utf8') <= 130, true);
	assert.equal(result.truncated, true);
	// 固定信封大小是预算算法的基准常量，改前缀一个字就会静默挪动所有预算 ⇒ 钉住它
	const envelope = frameMaterial({ question: { seq: 1, text: '' }, answerText: '' }, 8192);
	assert.equal(Buffer.byteLength(envelope.text, 'utf8'), 128);
});

test('分数预算不丢素材：8192.5 按 8192 处理，素材仍在（R2）', () => {
	const result = frameMaterial({ question: { seq: 1, text: 'x'.repeat(2000) }, answerText: '' }, 8192.5);
	assert.equal(Buffer.byteLength(result.text, 'utf8') > 128, true);
	assert.equal(Buffer.byteLength(result.text, 'utf8') <= 8192, true);
	assert.match(result.text, /xxxx/);
});

test('question.text 不是字符串时返回空提问而不是抛错（R2）', () => {
	const result = frameMaterial({ question: { seq: 1, text: 42 }, answerText: 'a'.repeat(100) }, 130);
	assert.equal(typeof result.text, 'string');
	assert.equal(Buffer.byteLength(result.text, 'utf8') <= 130, true);
});

test('回答为空时提问可用满预算，不再白扔 40%（R2）', () => {
	const long = 'x'.repeat(20000);
	const empty = frameMaterial({ question: { seq: 1, text: long }, answerText: '' }, 8192);
	const withAnswer = frameMaterial({ question: { seq: 1, text: long }, answerText: 'y'.repeat(20000) }, 8192);
	const emptyBytes = Buffer.byteLength(empty.text, 'utf8');
	// ⚠️ 不能用"总字节数更大"来断言：两种情形都会把预算吃满（实测 empty=7199、withAnswer=7214），
	// 而有回答时反而多花 15 字节的第二个截断标记 ⇒ 总字节数衡量不了"提问拿到多少预算"。
	// 改为直接量提问素材的保留量（这才是"不白扔 40%"的真意）：empty 保留 ~7056 个 x，withAnswer 只有 ~4233。
	assert.match(empty.text, /x{6000}/);
	assert.equal(/x{6000}/.test(withAnswer.text), false);
	assert.equal(emptyBytes > 6000, true);
	assert.equal(emptyBytes <= 8192, true);
});
