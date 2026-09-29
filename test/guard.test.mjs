import test from 'node:test';
import assert from 'node:assert/strict';

import { PROVIDER_ID, decide, hasOurTitle, isMainSession, isUserPinned } from '../lib/guard.mjs';

const mainSession = { id: 'session-main', header: { delegationDepth: 0 } };
const childSession = { id: 'session-child', header: { parentSession: 'session-main', delegationDepth: 1 } };
const base = { session: mainSession, events: [], turn: 1, attempts: 0, inFlight: false, hasRoute: true, maxAttempts: 3 };

const ourTitle = { type: 'session/title', seq: 20, data: { title: '我们的名字', messageSeqs: [9], source: { kind: 'provider', provider: PROVIDER_ID } } };
const userTitle = { type: 'session/title', seq: 30, data: { title: '手改的名字', messageSeqs: [], source: { kind: 'user' } } };
const otherProviderTitle = { type: 'session/title', seq: 15, data: { title: '内置的名字', messageSeqs: [9], source: { kind: 'provider', provider: 'session-title-first-prompt-llm' } } };

test('G1：子会话（有 parentSession）一律不做', () => {
	assert.equal(isMainSession(childSession), false);
	assert.deepEqual(decide({ ...base, session: childSession }), { proceed: false, reason: 'not-main-session' });
});

test('G2：turn 非法则不做', () => {
	for (const turn of [undefined, null, 0, -1, 1.5, '1']) {
		assert.deepEqual(decide({ ...base, turn }), { proceed: false, reason: 'bad-turn' });
	}
});

test('G3：已经有我们的标题就跳过（幂等）；内置 provider 的标题不算数', () => {
	assert.equal(hasOurTitle([ourTitle]), true);
	assert.equal(hasOurTitle([otherProviderTitle]), false);
	assert.deepEqual(decide({ ...base, events: [ourTitle] }), { proceed: false, reason: 'already-titled' });
	assert.deepEqual(decide({ ...base, events: [ourTitle] }), { proceed: false, reason: 'already-titled' });
});

test('G4：用户手改过名（最新一条是 user 来源）就不覆盖', () => {
	assert.equal(isUserPinned([ourTitle, userTitle]), true);
	assert.equal(isUserPinned([userTitle, ourTitle]), false);
	assert.deepEqual(decide({ ...base, events: [ourTitle, userTitle] }), { proceed: false, reason: 'already-titled' });
	assert.deepEqual(decide({ ...base, events: [userTitle] }), { proceed: false, reason: 'user-pinned' });
});

test('G5/G6/G7：in-flight、尝试用尽、无路由分别拦住', () => {
	assert.deepEqual(decide({ ...base, inFlight: true }), { proceed: false, reason: 'in-flight' });
	assert.deepEqual(decide({ ...base, attempts: 3 }), { proceed: false, reason: 'attempts-exhausted' });
	assert.deepEqual(decide({ ...base, attempts: 2, maxAttempts: 3 }), { proceed: true, reason: 'proceed' });
	assert.deepEqual(decide({ ...base, hasRoute: false }), { proceed: false, reason: 'no-route' });
});

test('正常路径：主会话 + turn=1 + 无历史标题 + 有路由 ⇒ proceed', () => {
	assert.deepEqual(decide(base), { proceed: true, reason: 'proceed' });
	assert.deepEqual(decide({ ...base, turn: 4, events: [otherProviderTitle] }), { proceed: true, reason: 'proceed' });
});

test('脏输入一律 fail-closed（不抛错、不误判为主会话、不因缺字段放行）', () => {
	assert.deepEqual(decide(null), { proceed: false, reason: 'not-main-session' });
	assert.deepEqual(decide(undefined), { proceed: false, reason: 'not-main-session' });
	assert.deepEqual(decide({ session: undefined, turn: 1, events: [], hasRoute: true, maxAttempts: 3 }), {
		proceed: false,
		reason: 'not-main-session'
	});
	assert.equal(isMainSession({}), false);
	assert.equal(isMainSession(undefined), false);
	assert.equal(isMainSession({ header: { parentSession: undefined, delegationDepth: 1 } }), false);
	assert.equal(isMainSession({ header: { delegationDepth: 0 } }), true);
	assert.deepEqual(decide({ ...base, maxAttempts: undefined }), { proceed: false, reason: 'attempts-exhausted' });
	assert.deepEqual(decide({ ...base, attempts: undefined }), { proceed: false, reason: 'attempts-exhausted' });
});
