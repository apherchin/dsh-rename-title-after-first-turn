/**
 * dsh-session-title-first-turn —— 主会话「首轮结束后自动总结命名」的 host 半边。
 *
 * 只做接线：读 config → 造代理 → 订阅 session/event。全部逻辑在 lib/plugin-core.mjs（可离线测）。
 * 两条纪律（本机血泪教训）：
 *  1. 本插件 **host-only**（无 dsh.client），不参与渲染端「每条 client entry 必须 active」的启动门禁；
 *  2. apply 与所有回调 **绝不外抛** —— 出错只记一行 warn，功能失效也不能影响宿主。
 */
import { createTitleAgent, resolveConfig } from './lib/plugin-core.mjs';

export const name = 'session-title-first-turn';
export const inject = ['llm'];

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文。
 * @param {unknown} rawConfig profile 那条 insert 的 config。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
	try {
		const config = resolveConfig(rawConfig);
		if (typeof ctx.llm?.stream !== 'function') {
			ctx.logger?.warn?.('session-title-first-turn: ctx.llm.stream 不可用，插件将不会命名任何会话');
		}
		const agent = createTitleAgent({ config, llm: ctx.llm, logger: ctx.logger });
		ctx.on('session/event', (session, event) => {
			void agent.handle(session, event).catch((error) => {
				try {
					ctx.logger?.warn?.(`session-title-first-turn: handle 意外 reject: ${String(error)}`);
				} catch {
					/* 绝不再抛 */
				}
			});
		});
		ctx.on('session/disposed', (session) => {
			try {
				agent.forget(session);
			} catch {
				/* 绝不再抛 */
			}
		});
		ctx.logger?.info?.(
			`session-title-first-turn: apply ok (maxAttempts=${config.maxAttempts}, maxOutputTokens=${config.maxOutputTokens}, maxInputBytes=${config.maxInputBytes})`
		);
	} catch (error) {
		try {
			ctx.logger?.warn?.(`session-title-first-turn: apply failed: ${String(error)}`);
		} catch {
			/* 绝不再抛 */
		}
	}
}
