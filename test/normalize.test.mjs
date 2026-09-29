import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanTitleText, normalizeTitle, truncateUtf8 } from '../lib/normalize.mjs';

test('cleanTitleText 去掉 ANSI/CSI 控制序列并折叠空白', () => {
	assert.equal(cleanTitleText('\u001b[31m红色\u001b[0m 标题'), '红色 标题');
	assert.equal(cleanTitleText('  a\n\n b\tc '), 'a b c');
	assert.equal(cleanTitleText('a\u200bb\u202ec'), 'abc');
});

test('truncateUtf8 在预算内原样返回，超预算不劈开码点', () => {
	assert.equal(truncateUtf8('abc', 10), 'abc');
	assert.equal(truncateUtf8('中文标题', 7), '中文');
	assert.equal(Buffer.byteLength(truncateUtf8('中文标题', 7), 'utf8') <= 7, true);
});

test('truncateUtf8 拒绝非法预算', () => {
	assert.throws(() => truncateUtf8('a', 0), /maxBytes/);
	assert.throws(() => truncateUtf8('a', 1.5), /maxBytes/);
});

test('normalizeTitle = 清洗 + 截断 + 去尾空白', () => {
	assert.equal(normalizeTitle('\u001b[1m你好 世界\u001b[0m', 80), '你好 世界');
	assert.equal(normalizeTitle('中文标题测试', 7), '中文');
	assert.equal(normalizeTitle('   ', 80), '');
});

test('cleanTitleText 处理 OSC（BEL 终止 / ST 终止 / 未终止）与非空白 C1 控制序列', () => {
	assert.equal(cleanTitleText('ok\u001b]0;title\u0007done'), 'okdone');
	assert.equal(cleanTitleText('ok\u001b]8;;http://x\u001b\\done'), 'okdone');
	assert.equal(cleanTitleText('ab\u001b]unterminated'), 'ab');
	assert.equal(cleanTitleText('ok\u009b31mdone'), 'okdone');
	assert.equal(cleanTitleText('ok\u009d0;t\u0007done'), 'okdone');
});
