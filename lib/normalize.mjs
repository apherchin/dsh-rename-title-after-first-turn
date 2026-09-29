/**
 * 标题文本清洗与 UTF-8 安全截断。
 *
 * 口径与 DSH 内置 `@deepseek-ai/dsh-session-title` 的 normalize 一致：先去掉终端控制序列与
 * 不可见/方向性控制符，再把空白折叠成单空格；截断按**码点**边界，绝不劈开一个字符。
 * 纯函数、零依赖（本机插件不能 import @deepseek-ai/*）。
 */

/** OSC 序列（含未终止尾巴）。 */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
/** CSI 序列（如 SGR 颜色码）。 */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
/** 其余两字节 ESC 控制序列。 */
const ESC_SEQUENCE = /\u001B[@-_]/gu;
/** 非空白 C0/C1 控制符。 */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
/** 方向性与不可见控制符（会让显示出来的标题有欺骗性）。 */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

/**
 * 清成一行规范文本。
 * @param {unknown} input 任意输入（会被 String() 化）。
 * @returns {string} 去掉控制符、空白折叠、已 trim 的单行文本。
 */
export function cleanTitleText(input) {
	return String(input)
		.replace(OSC_SEQUENCE, '')
		.replace(CSI_SEQUENCE, '')
		.replace(ESC_SEQUENCE, '')
		.replace(CONTROL_CHARACTER, '')
		.replace(DIRECTIONAL_CONTROL, '')
		.replace(/\s+/gu, ' ')
		.trim();
}

/**
 * 按 UTF-8 字节预算截断，不劈开码点。
 * @param {string} input 已规范化的文本。
 * @param {number} maxBytes 正整数预算。
 * @returns {string} 预算内最长的码点前缀。
 */
export function truncateUtf8(input, maxBytes) {
	if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
	if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
	let used = 0;
	let output = '';
	for (const character of input) {
		const bytes = Buffer.byteLength(character, 'utf8');
		if (used + bytes > maxBytes) break;
		output += character;
		used += bytes;
	}
	return output;
}

/**
 * 规范一条标题并施加字节上限。
 * @param {unknown} input 待规范文本。
 * @param {number} maxBytes 字节上限。
 * @returns {string} 单行、去尾空白、可能为空串的标题。
 */
export function normalizeTitle(input, maxBytes) {
	return truncateUtf8(cleanTitleText(input), maxBytes).trimEnd();
}
