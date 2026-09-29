/**
 * 「第一轮」素材选取。
 *
 * 只认两类事件：
 *  - 提问：第一条 `user/message` 且 `data.source.kind === "user"`（排除 agent-instructions /
 *    runtime-context / skill-catalog 这类合成消息 —— 它们也会以 user 角色出现）。
 *  - 回答：`assistant/message` 且 `data.turn === 1`，只取 `message.content` 里的 text 块
 *    （reasoning 与 tool-call 一律排除；子代理会话常见「整条只有 reasoning + tool-call」）。
 *
 * 素材**永远只取第一轮**：即使命名在后续轮次重试，产出的名字也仍是「第一轮的总结」。
 */

/**
 * 从一个 content 数组里取 text 块并拼接。
 * @param {unknown} content 消息 content（可能是 undefined / 非数组）。
 * @returns {string} text 块用换行拼接的结果。
 */
export function textOfContent(content) {
	if (!Array.isArray(content)) return '';
	return content
		.filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('\n');
}

/**
 * 取第一轮的提问与助手回答文本。
 * @param {unknown} events 会话日志事件（`session.snapshotEvents()`）。
 * @returns {{question: {seq: number, text: string} | null, answerText: string}} 素材（answerText 可能为空串）。
 */
export function collectFirstTurn(events) {
	let question = null;
	const answers = [];
	for (const event of Array.isArray(events) ? events : []) {
		if (question === null && event?.type === 'user/message' && event.data?.source?.kind === 'user') {
			const text = textOfContent(event.data.content).trim();
			if (text !== '') question = { seq: event.seq, text };
			continue;
		}
		if (event?.type === 'assistant/message' && event.data?.turn === 1) {
			const text = textOfContent(event.data.message?.content).trim();
			if (text !== '') answers.push(text);
		}
	}
	return { question, answerText: answers.join('\n\n') };
}
