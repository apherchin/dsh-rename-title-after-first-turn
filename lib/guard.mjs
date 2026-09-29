/**
 * 守卫判定（G1–G7）。
 *
 * 纯函数：不读时钟、不读全局状态、不抛错（脏输入一律当"拦住"）。
 * 顺序即优先级，理由字符串用于日志/warn，不参与逻辑。
 */

/** 落库时写进 `source.provider` 的稳定标识（也是"我们命名过"的判据）。 */
export const PROVIDER_ID = 'session-title-first-turn';

/**
 * 取日志里全部 `session/title` 事件（按日志顺序）。
 * @param {unknown} events 会话事件数组。
 * @returns {Array<object>} 标题事件。
 */
function titleEvents(events) {
	return (Array.isArray(events) ? events : []).filter((event) => event?.type === 'session/title');
}

/**
 * 是否已经有我们写的标题（幂等判据，跨重启有效）。
 * @param {unknown} events 会话事件数组。
 * @returns {boolean} 有则 true。
 */
export function hasOurTitle(events) {
	return titleEvents(events).some((event) => event.data?.source?.provider === PROVIDER_ID);
}

/**
 * 最新一条标题是否来自用户手改（手改永不覆盖）。
 * @param {unknown} events 会话事件数组。
 * @returns {boolean} 最新一条是 user 来源则 true。
 */
export function isUserPinned(events) {
	const titles = titleEvents(events);
	const latest = titles[titles.length - 1];
	return latest !== undefined && latest.data?.source?.kind === 'user';
}

/**
 * 是否主会话。
 *
 * **fail-closed**：形状不认识（没有 `header`）就当作"不是主会话"，一律不碰 —— G1 是兑现
 * 「subagent / teammate 完全不碰」这条硬要求的唯一守卫，它在脏输入上必须关闭而不是放行。
 * 交叉验证（spec §4）：`delegationDepth` 若存在且非 0，也判为非主会话。
 * @param {object} session 会话对象。
 * @returns {boolean} 主会话则 true。
 */
export function isMainSession(session) {
	const header = session?.header;
	if (header === null || typeof header !== 'object') return false;
	if (header.parentSession !== undefined && header.parentSession !== null) return false;
	const depth = header.delegationDepth;
	return depth === undefined || depth === 0;
}

/**
 * 守卫总判定。
 *
 * 脏输入一律 fail-closed：`input`/`attempts`/`maxAttempts` 形状不可信时**不放行**、也**不抛错**。
 * @param {{session: object, events: unknown, turn: unknown, attempts: number, inFlight: boolean, hasRoute: boolean, maxAttempts: number}} input 判定输入。
 * @returns {{proceed: boolean, reason: string}} 判定结果。
 */
export function decide(input) {
	const src = input !== null && typeof input === 'object' ? input : {};
	const attempts = Number.isInteger(src.attempts) ? src.attempts : Number.POSITIVE_INFINITY;
	if (!isMainSession(src.session)) return { proceed: false, reason: 'not-main-session' };
	if (!Number.isInteger(src.turn) || src.turn < 1) return { proceed: false, reason: 'bad-turn' };
	if (hasOurTitle(src.events)) return { proceed: false, reason: 'already-titled' };
	if (isUserPinned(src.events)) return { proceed: false, reason: 'user-pinned' };
	if (src.inFlight === true) return { proceed: false, reason: 'in-flight' };
	if (!Number.isInteger(src.maxAttempts) || src.maxAttempts < 1) return { proceed: false, reason: 'attempts-exhausted' };
	if (attempts >= src.maxAttempts) return { proceed: false, reason: 'attempts-exhausted' };
	if (src.hasRoute !== true) return { proceed: false, reason: 'no-route' };
	return { proceed: true, reason: 'proceed' };
}
