import test from 'node:test';
import assert from 'node:assert/strict';

import { createStreamAccumulator } from '../lib/stream.mjs';

test('拼接 text 块，忽略 reasoning（含缺 block-start 的容错）', () => {
	const acc = createStreamAccumulator();
	acc.push({ type: 'block-start', index: 0, blockType: 'reasoning' });
	acc.push({ type: 'reasoning-delta', index: 0, text: '内心戏' });
	acc.push({ type: 'block-start', index: 1, blockType: 'text' });
	acc.push({ type: 'text-delta', index: 1, text: '会话' });
	acc.push({ type: 'text-delta', index: 1, text: '删除功能' });
	acc.push({ type: 'text-delta', index: 2, text: '！' }); // 无 block-start，按 text 处理
	acc.push({ type: 'finish', reason: { kind: 'stop' } });
	assert.equal(acc.text(), '会话删除功能！');
	assert.equal(acc.finishKind(), 'stop');
	assert.equal(acc.sawToolCall(), false);
});

test('出现工具调用必须被记下（delta 与 block-end 两条路）', () => {
	const a = createStreamAccumulator();
	a.push({ type: 'tool-call-delta', index: 0, id: 'c', name: 'read', argumentsDelta: '{}' });
	assert.equal(a.sawToolCall(), true);

	const b = createStreamAccumulator();
	b.push({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c', name: 'read', arguments: '{}' } });
	assert.equal(b.sawToolCall(), true);
});

test('未观测到终态 finish ⇒ incomplete（fail-closed，绝不当成 stop）', () => {
	assert.equal(createStreamAccumulator().finishKind(), 'incomplete');

	const noReason = createStreamAccumulator();
	noReason.push({ type: 'finish' });
	assert.equal(noReason.finishKind(), 'incomplete');
});

test('finish 的 kind 原样带出，failure 可读', () => {
	const acc = createStreamAccumulator();
	acc.push({ type: 'finish', reason: { kind: 'max-tokens' } });
	assert.equal(acc.finishKind(), 'max-tokens');
	assert.equal(acc.failure(), null);

	const err = createStreamAccumulator();
	err.push({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'busy' } } });
	assert.equal(err.finishKind(), 'error');
	assert.equal(err.failure().code, 'RATE_LIMIT');
});

test('脏 chunk 不抛错', () => {
	const acc = createStreamAccumulator();
	acc.push(null);
	acc.push(undefined);
	acc.push({ type: 'unknown-chunk' });
	acc.push({ type: 'text-delta', index: 0, text: undefined });
	assert.equal(acc.text(), '');
	assert.equal(acc.finishKind(), 'incomplete');
});

test('首个终态胜：后到的 finish 不得覆盖 error/aborted', () => {
	const acc = createStreamAccumulator();
	acc.push({ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'busy' } } });
	acc.push({ type: 'finish', reason: { kind: 'stop' } });
	assert.equal(acc.finishKind(), 'error');
	assert.equal(acc.failure().code, 'RATE_LIMIT');
});

test('畸形的 finish 也算终态：后续合法 stop 不得翻案（R2，故意 fail-closed）', () => {
	const acc = createStreamAccumulator();
	acc.push({ type: 'finish' });
	acc.push({ type: 'finish', reason: { kind: 'stop' } });
	assert.equal(acc.finishKind(), 'incomplete');
});
