/**
 * 自包含的 LLM 流式累积器（本机插件不能 import @deepseek-ai/dsh-llm 的 BlockAssembler）。
 *
 * 认得的 chunk 形状（与 dsh-llm 的 BlockAssembler 对齐）：
 *   {type:'block-start', index, blockType}
 *   {type:'text-delta', index, text} | {type:'reasoning-delta', index, text}
 *   {type:'tool-call-delta', index, id, name, argumentsDelta}
 *   {type:'block-end', index, block}
 *   {type:'usage', usage} | {type:'finish', reason, replayState}
 * 缺 block-start 的 delta 按 text 处理（与 BlockAssembler 的 ensure() 同口径）。
 *
 * ⚠️ **fail-closed**：整条流结束却**从未观测到** `finish`（或 `reason` 不可用）时，
 * `finishKind()` 返回 `'incomplete'` 而不是 `'stop'` —— 否则适配器静默结束时，半截文本会被
 * 当成完整标题落库（2026-09-26 规格评审修正；上游 BlockAssembler 的缺省是 `stop`，我们故意不跟）。
 */

/** 未观测到终态 finish 时的哨兵值（不是 'stop'，落库方必须拦下）。 */
const INCOMPLETE = 'incomplete';

/**
 * 造一个累积器。
 * @returns {{push(chunk: unknown): void, text(): string, sawToolCall(): boolean, finishKind(): string, failure(): object | null}}
 */
export function createStreamAccumulator() {
	/** @type {Map<number, string>} index → blockType */
	const blockTypes = new Map();
	/** @type {string[]} */
	const parts = [];
	let sawToolCall = false;
	let finish = null;

	return {
		push(chunk) {
			if (chunk === null || typeof chunk !== 'object') return;
			switch (chunk.type) {
				case 'block-start':
					blockTypes.set(chunk.index, chunk.blockType);
					break;
				case 'text-delta':
					if ((blockTypes.get(chunk.index) ?? 'text') === 'text') parts.push(typeof chunk.text === 'string' ? chunk.text : '');
					break;
				case 'reasoning-delta':
					break;
				case 'tool-call-delta':
					sawToolCall = true;
					break;
				case 'block-end':
					if (chunk.block !== null && typeof chunk.block === 'object' && chunk.block.type === 'tool-call') sawToolCall = true;
					break;
				// 首个终态胜：畸形 finish（缺 reason）也会被当成终态并锁死 —— 故意 fail-closed：
				// 一个协议违例不得让后续合法 stop 把"未完成"洗成成功。
				case 'finish':
					if (finish === null) finish = chunk.reason !== null && typeof chunk.reason === 'object' ? chunk.reason : { kind: INCOMPLETE };
					break;
				default:
					break;
			}
		},
		text() {
			return parts.join('');
		},
		sawToolCall() {
			return sawToolCall;
		},
		finishKind() {
			return typeof finish?.kind === 'string' ? finish.kind : INCOMPLETE;
		},
		failure() {
			return finish?.failure ?? null;
		}
	};
}
