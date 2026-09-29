/**
 * 提示词与素材打包。
 *
 * 系统提示与 DSH 内置 provider 同风格（同一行纯文本标题、用消息的语言、不要 Markdown/代码）。
 * 用户消息把「提问 + 助手首轮回答」包成 JSON，这样用户文本无法伪造结构分隔符；
 * 整个 JSON 消息的 UTF-8 字节数由 frameMaterial 截到 maxInputBytes 之内。
 */
import { truncateUtf8 } from './normalize.mjs';

/** 截断标记：让模型知道素材不完整。 */
const TRUNCATION_MARK = ' …(已截断)';

/**
 * 构造系统提示。
 * @param {{targetWords: number, targetCjkCharacters: number}} config 目标长度配置。
 * @returns {string} 系统提示。
 */
export function buildSystemPrompt(config) {
	return [
		'Create a concise title for an AI coding-assistant session from its first exchange.',
		'Return only the title on one line, in plain text of the natural language of the messages, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
		'Use the language of the messages.',
		`Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`
	].join('\n');
}

/**
 * 把素材包成最终的 user 消息体。
 * @param {string} questionText 提问文本。
 * @param {string} answerText 助手首轮回答文本（可为空串）。
 * @returns {string} 完整消息体。
 */
function frame(questionText, answerText) {
	const payload = { firstUserMessage: questionText, assistantFirstReply: answerText };
	return `Generate the session title from this JSON object describing the first exchange:\n${JSON.stringify(payload)}`;
}

/**
 * 在非正/非有限预算下安全截断。
 *
 * 为什么需要：`truncateUtf8` 要求预算是**正整数**（0 非法并抛错），而"预算算到 0"是极小
 * `maxInputBytes` 下的正常中间态。把预算问题变成抛错会把整条命名链路炸掉 —— 方向错了：
 * 应当少给模型素材，而不是不命名。
 * 非字符串文本、非有限/非正预算一律当"没有素材"处理（返回空串），**永不抛错**。
 * @param {unknown} text 待截断文本。
 * @param {number} maxBytes 预算（可为 0、负数、分数或非有限值）。
 * @returns {string} 截断结果（可能为空串）。
 */
function cut(text, maxBytes) {
	if (typeof text !== 'string' || text === '') return '';
	const budget = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 0;
	return budget <= 0 ? '' : truncateUtf8(text, budget);
}

/**
 * 给被截断的字段补标记（没被截就不补）。
 * @param {string} kept 截断后的文本。
 * @param {string} original 原始文本。
 * @returns {string} 可能带标记的文本。
 */
function withMark(kept, original) {
	return Buffer.byteLength(kept, 'utf8') < Buffer.byteLength(original, 'utf8') ? kept + TRUNCATION_MARK : kept;
}

/**
 * 在字节预算内打包素材：提问优先（最多占预算 60%），其余给回答；超预算就整体回缩重算。
 *
 * **永不抛错**：预算小到装不下内容时返回最小信封 `frame('', '')`，而不是抛异常。
 * 标记与预算在**同一轮**里计算，所以标记既不会被后续回砍吃掉，也不会把总字节撑破预算。
 * 回答为空串时把整份预算都给提问（那条 60% 上限是为"两者并存"定的，单独提问不该白扔 40%）。
 * @param {{question: {seq: number, text: string} | null, answerText: string}} material 第一轮素材。
 * @param {number} maxInputBytes 预算（UTF-8 字节；分数会被向下取整，非有限值当 0）。
 * @returns {{text: string, truncated: boolean}} 消息体与是否发生截断。
 */
export function frameMaterial(material, maxInputBytes) {
	const questionText = typeof material?.question?.text === 'string' ? material.question.text : '';
	const answerText = typeof material?.answerText === 'string' ? material.answerText : '';
	const limit = Number.isFinite(maxInputBytes) ? Math.floor(maxInputBytes) : 0;
	const full = frame(questionText, answerText);
	if (Buffer.byteLength(full, 'utf8') <= limit) return { text: full, truncated: false };

	const overhead = Buffer.byteLength(frame('', ''), 'utf8');
	let budget = Math.max(0, limit - overhead);
	for (let attempt = 0; attempt < 12; attempt += 1) {
		const questionShare = answerText === '' ? budget : Math.floor(budget * 0.6);
		const keptQuestion = cut(questionText, Math.min(questionShare, budget));
		const keptAnswer = cut(answerText, Math.max(0, budget - Buffer.byteLength(keptQuestion, 'utf8')));
		const text = frame(withMark(keptQuestion, questionText), withMark(keptAnswer, answerText));
		if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: true };
		budget = Math.floor(budget * 0.875);
	}
	return { text: frame('', ''), truncated: true };
}
