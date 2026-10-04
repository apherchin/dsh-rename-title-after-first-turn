# dsh-rename-title-after-first-turn

[中文](#中文) ｜ [English](#english)

主会话「第一轮对话结束后，自动总结命名**一次**」的 **host-only** DSH 插件（不改 `app.asar`，无 client 半边）。

> ## ✅ 在用（2026-10-04 恢复）· Active
>
> **中文**：本插件曾在 2026-10-04 短暂退役（当时判断"DSH 0.2.0 已把标题做成可插拔 seam，官方接替就够了"）。
> **同一天恢复**，因为把官方 provider 在本机的失败原因查实了：
>
> - 官方 `session-title-first-prompt-llm` **只在首条人类消息时运行**，且只把**那一条提问**发出去（`messageSeqs:[首条]`），看不到本轮助手干了什么；
> - 它预算固定 **`maxOutputTokens: 64`**；而"按 `purpose: 'session-title'` 关掉思考"是**适配器职责**，
>   本机建模走 `llm-pi-ai`（本地 OpenAI-Responses 代理）**没有这条行为**，而 `deepseek-v4.1-flash` 的思考在配置里**不可关闭**
>   ⇒ 64 token 被 reasoning 全部吃光（实测 `status: incomplete` / `reasoning_tokens: 64` / 无 message）⇒ 会话永远停在 fallback。
>   对照组：同一请求放宽到 1024 token 即正常返回标题。
>
> 因此现在**两条一起**：profile 里 `session-title-llm: disabled: true`（跳过官方）+ 本插件启用。
> 本插件写出的 `session/title` 在更后的 seq 上 ⇒ 即使官方那条侥幸成功也会被覆盖。
> 复现脚本：`Day1\work\post-0.2.0-cleanup-20261004\probe-title-request.mjs`；完整分析：`Day1\reports\dsh-0.2.0升级-自建资产覆盖度审计-20261004.md` §9。
>
> **English**: Briefly retired on 2026-10-04, then **reactivated the same day** once the official provider's
> failure on this machine was pinned down: it fires only on the first human message (sending that message alone),
> with a fixed `maxOutputTokens: 64`, and the "disable thinking for `purpose: 'session-title'`" behaviour lives in
> the **DeepSeek adapter** — our route is `llm-pi-ai`, whose model cannot turn thinking off, so all 64 tokens go to
> reasoning and the provider gets empty output. The official provider is therefore disabled in the profile and
> this plugin owns naming (its later-seq `session/title` also overrides a lucky official one).

---

## 中文

### 它解决什么

DSH 自带的兜底命名是「首条消息截到 40 字节」，经常读起来不像个标题；而内置的 first-prompt 标题 provider 在本机**必失败**——根因已查实：它只给 `maxOutputTokens: 64`，而"按 `purpose` 关掉思考"是**适配器职责**，本机 pi-ai 路由没有这条行为、`deepseek-v4.1-flash` 的思考又关不掉 ⇒ 64 token 全被 reasoning 吃光（详见顶部说明与报告 §9）。本插件在**第一轮真正结束之后**（已有提问、已有回答）用一次模型调用总结出标题，**此后永久不再改**。

### 与官方 first-prompt provider 的区别（2026-10-04 实测）

DSH 0.2.0 起自带 `@deepseek-ai/dsh-session-title-first-prompt-llm`（下称"官方"）。两者写的是**同一种**事件
（`session/title`，`source.kind = "provider"`），因此可以共存（higher-seq-wins），但行为差别很大：

| | 官方 first-prompt | 本插件 first-turn |
|---|---|---|
| **触发时机** | **首条符合条件的人类消息**到达时（助手回答还不存在） | `turn/end` 且 `turn >= 1`（本轮回答结束之后） |
| **送进模型的素材** | **只有那一条人类消息**（会话日志实测载荷 `messageSeqs:[首条]`） | **首轮提问 + 首轮回答正文**，包成一条 JSON（提问优先占预算 60%，截断处补 `…(已截断)`） |
| **输入上限** | `maxInputBytes: 4096` | `maxInputBytes` 默认 **8192**（可配 256–1,000,000） |
| **输出上限** | **64 token** | **2048 token** |
| **怎么关掉"思考"** | 靠**适配器**按封套上的 `purpose: 'session-title'` 关闭——只有官方 DeepSeek 适配器实现了这条 | 不依赖任何适配器特殊行为；预算足够容纳思考 |
| **失败之后** | 保留 fallback，**不自动重试**（只能显式 `ctx.sessionTitle.refresh()`） | 最多自动重试 `maxAttempts`（默认 3），用尽后静默放弃 |
| **fork / 子会话** | fork 会话不自动跑（继承种子标题） | 只认**主会话**（`parentSession` 空、`delegationDepth` 为 0）；子代理 / 队友 / fork 一律不碰 |
| **本机实测结果** | **必失败**：`status: incomplete`、`reasoning_tokens: 64`、无输出 ⇒ 会话永远停在 fallback | 稳定成功（实例：「抖音账号管理器编码代理会话」） |

#### 官方在本机为什么必失败（复现记录）

1. 官方预算固定 **64 token**；
2. 它靠封套上的 `purpose: 'session-title'` 让**适配器**关掉思考（官方文档原话：*DeepSeek 适配器根据该用途禁用思考……其他适配器负责自身用途专用行为*）；
3. 本机建模走的是 **pi-ai 路由**（`llm-pi-ai` → 本地 OpenAI-Responses 代理），**不是**官方 DeepSeek 适配器 ⇒ 没有这条 purpose 行为；
4. 而 `deepseek-v4.1-flash` 的 reasoning 在本机配置里**不可关闭** ⇒ **64 token 全被思考吃光**，模型一个标题字都没写出来。

把同一条请求直接打给本地代理（复现脚本 `probe-title-request.mjs`）：

| `max_output_tokens` | HTTP | status | usage | 输出 |
|---|---|---|---|---|
| **64**（官方默认值） | 200 | `incomplete` | `output_tokens: 64`，其中 **`reasoning_tokens: 64`** | **无 message**（预算全给了思考） |
| 1024 | 200 | `completed` | `output_tokens: 101`（reasoning 97） | 正常标题 |

⇒ 不是模型或网络问题，而是"**官方默认 64 token 预算 × 本机路由关不掉思考**"的组合。

#### 两者如何共存（本插件的姿态）

- 本插件**不使用**官方的 `ctx.sessionTitle.register()` seam —— 那个 seam 只允许注册一个提供方、第二次注册会立即抛错；
  本插件直接 append 官方 `session/title` 事件，因此**可与官方并存**。
- 它写的事件 **seq 更大**（在 `turn/end` 之后，而官方在首条消息时）⇒ **官方那条即使侥幸成功，也会被本插件覆盖**。
- 包内 `cordis.patch.yml` **默认把官方关掉**（`- id: session-title-llm` + `disabled: true`），
  省掉每个新会话那次注定失败的 64-token 调用。想保留官方（例如改用官方 DeepSeek 适配器的路由，
  或自行把它的 `maxOutputTokens` 调大），把该文件里那两行注释掉即可。

### 行为

- **触发**：`turn/end` 且 `turn >= 1`。`turn === 1` 是**第一次机会**；**成功落库后永久冻结**（后续轮次被幂等守卫跳过）。第一次机会失败时，允许在后续轮次重试，上限 `maxAttempts`。
- **只碰主会话**：`session.header` 必须是对象、`parentSession` 为空、且 `delegationDepth` 缺失或为 `0`；**subagent / teammate 会话一律不动**。判据是 **fail-closed**（形状不认识就不碰），因为它是兑现这条硬要求的唯一守卫。
- **素材**：第一轮的「首条人类提问 + `turn === 1` 的所有助手 `text` 块」（`reasoning` 与工具调用一律排除）。重试时素材仍**只取第一轮**。
- **落库**：`session.append("session/title", { title, messageSeqs: [首条人类消息 seq], source: { kind: "provider", provider: "session-title-first-turn", model } })`。宿主按 higher-seq-wins 推给客户端 ⇒ **侧栏自动改名，无需刷新页面**。
- **用户手改的名字永不覆盖**。
- **失败一律降级**为「保持 DSH 自带兜底名」，只记一行 `warn`，**绝不外抛**（插件跑在宿主 Node 进程里，抛错会波及整个应用）。

### 安装

```bash
dsh plugin --profile <你的 profile> add dsh-rename-title-after-first-turn
```

包内声明了 `dsh.bundle.patch`，所以 `dsh plugin` 会**自动把它记进 `dsh.profile.bundles`**，无需手工编辑 profile 文件。然后重启 DSH（打包版没有「刷新页面」）。

手动兜底（不用 `dsh plugin` 时）：`pnpm add dsh-rename-title-after-first-turn`，再在 `cordis.patch.yml` 追加

```yaml
- insert:
    - id: session-title-first-turn
      name: "dsh-rename-title-after-first-turn"
```

> 可选：想让本插件**独占命名权**，同时停用内置的 first-prompt provider（把 `- id: session-title-llm` + `disabled: true` 加进 profile 补丁）。包里的 `cordis.patch.yml` 有这两行的注释版本——**默认不启用**，因为它会改变别人的默认行为。

### 配置（profile 那条 `insert` 的 `config`，全部可选）

| 键 | 默认 | 允许范围 | 含义 |
|---|---|---|---|
| `targetCjkCharacters` | 12 | 1–60 | 中文目标字数 |
| `targetWords` | 6 | 1–30 | 非中文目标词数 |
| `maxInputBytes` | 8192 | 256–1000000 | 素材字节上限（分数向下取整） |
| `maxOutputTokens` | 2048 | 32–32000 | 输出上限。**别照抄官方的 64**：本机路由关不掉思考，64 会被 reasoning 吃光（已实测：64 → `status: incomplete`、一个标题字都没有；1024 → 正常返回标题） |
| `timeoutMs` | 60000 | 1000–900000 | 端到端超时；是**硬边界**（`Promise.race`），适配器不看 `signal` 也会返回 |
| `maxAttempts` | 3 | 1–10 | 每个会话最多尝试次数（1 = 只试第一轮）。**含「无路由」那种没打到模型的尝试** |
| `maxTitleBytes` | 80 | 8–512 | 落库标题的 UTF-8 字节上限 |

非法/越界值一律**回退缺省**，不抛错。

### 兼容性

- **实测环境**：DSH 桌面壳 **`0.2.0-rc.2`**（Windows，2026-10-04 复核）；历史记录：`0.1.7-rc.2` 亦可用。
- **与官方 provider 的关系**：本插件与会 `first-prompt` 节奏的官方 provider 功能重叠，本机做法是**关掉官方**（见顶部说明）。0.2.0 起官方标题服务是**可插拔 seam**（`ctx.sessionTitle.register(provider)`，第二次注册会立即抛错），但本插件**不使用**该 seam——它直接 append 官方 `session/title`，因此不受"只能注册一个 provider"的约束，也能与官方共存（谁 seq 大谁赢）。
- **host-only**：没有 client 半边 ⇒ **不参与**渲染端「每条 client entry 必须 active」的全有全无启动门禁。
- 用到的服务：`llm`（`ctx.llm.stream`）；订阅 `session/event`、`session/disposed`。0.2.0 起 `snapshotEvents`/`eventAt`/`ownEvents` 被弃用，但本插件**不读会话日志**，因此不受影响。
- 零 npm 依赖、无安装脚本、无构建步骤。

### 合规（按官方 `cordis-plugin-development` 对齐）

- **bundle 形态**：`package.json` 声明 `dsh.bundle.patch`（官方交付单位；缺它 `install_bundle` 会**回滚整次安装**）。
- **不 import 任何 `@deepseek-ai/*` 运行时包**（只读 `ctx` 上的服务）。
- **不 append 新的 session 事件类型**：只 append 官方的 `session/title`，并带 `source.kind = "provider"`，满足宿主「provider 来源必须 cite 更早的 user 消息」这条不变量。
- `apply` 与所有回调**绝不外抛**，出错只记一行 `warn`。

### 测试

⚠️ 本机沙箱**禁止命名管道** ⇒ `node --test` 会 `spawn EPERM` 并给出**误导性的 `# fail 1`**。逐文件跑（任意 cwd）：

```powershell
Get-ChildItem test -Filter '*.test.mjs' | ForEach-Object { node $_.FullName; "exit=$LASTEXITCODE $($_.Name)" }
```

期望合计 **47 pass / 0 fail**（`normalize 5 / first-turn 4 / stream 7 / prompt 10 / guard 7 / plugin-core 14`）。
三个变异点（去掉 `text` 块过滤 / `isMainSession` 恒 true / `messageSeqs` 置空）都会让对应断言变红。

### 已知取舍

- 路由长期不可用 ⇒ `maxAttempts` 用尽后该会话**静默永久放弃**（只剩历史 `warn` 可查）。
- 超时用 `Promise.race` 保证调用方不被挂住、in-flight 一定释放；被放弃的那次迭代若适配器永不结束，仍会在后台悬着。
- `attempts` / `inFlight` 只在 `session/disposed` 时清理（与首方 `dsh-session-title` 同形）。
- 素材信封固定 128 字节：`maxInputBytes < 128` 时返回值会略超预算、`128 ≤ 预算 ≲ 173` 时返回空信封（配置下限 256，正常不可达）。

### 停用 / 卸载

- **按包名装的**：`dsh plugin --profile <你的 profile> remove dsh-rename-title-after-first-turn`
- **按绝对路径 insert 装的**：从 `~\.dsh\profiles\<profile>\cordis.patch.yml` 删掉 `id: session-title-first-turn` 那条 `insert`
- 两种都要**重启 DSH**（已加载插件文件的内容改动不热重载）。

---

## English

A **host-only** DSH plugin that names a main session **once**, right after its first turn ends — and never touches it again.

- **Trigger**: `turn/end` with `turn >= 1`. Turn 1 is the first chance; once a title lands the session is frozen (idempotent guard). A failed first attempt may retry up to `maxAttempts`.
- **Main sessions only**: `session.header` must be an object, `parentSession` empty, `delegationDepth` absent or `0`. **Subagent and teammate sessions are never touched** — the predicate is fail-closed, since it is the only guard for that hard requirement.
- **Material**: the first turn's first human question plus every assistant `text` block of `turn === 1` (`reasoning` and tool calls excluded). Retries still feed **turn 1 only**.
- **Persist**: `session.append("session/title", …)` with `source.kind = "provider"`, so the sidebar renames itself (higher-seq-wins) without a page reload. Manual renames are never overwritten.
- **Failures degrade** to DSH's built-in fallback name with a single `warn` line; `apply` never throws.

### How it differs from the official first-prompt provider

DSH 0.2.0 ships `@deepseek-ai/dsh-session-title-first-prompt-llm` (the "official" one). Both write the **same** event
(`session/title` with `source.kind = "provider"`), so they can coexist (higher-seq-wins) — but their behaviour differs:

| | Official first-prompt | This plugin (first-turn) |
|---|---|---|
| **Trigger** | the first eligible **human message** (before any answer exists) | `turn/end` with `turn >= 1` (after the first answer) |
| **Material sent** | **that single human message** (logged payload: `messageSeqs:[first]`) | **first question + first-turn assistant text**, wrapped in one JSON body (question gets 60% of the budget) |
| **Input cap** | `maxInputBytes: 4096` | `maxInputBytes` default **8192** (configurable 256–1,000,000) |
| **Output cap** | **64 tokens** | **2048 tokens** |
| **Disabling "thinking"** | delegated to the **adapter** via `purpose: 'session-title'` — only the official DeepSeek adapter implements it | needs no adapter-specific behaviour; the budget simply leaves room for reasoning |
| **On failure** | keeps the fallback, **no automatic retry** (explicit `refresh()` only) | retries up to `maxAttempts` (default 3), then gives up silently |
| **fork / child sessions** | forks don't run it (they inherit the seed title) | main sessions only (`parentSession` empty, `delegationDepth` 0); subagent / teammate / fork untouched |
| **Measured on this host** | **always fails**: `status: incomplete`, `reasoning_tokens: 64`, no output ⇒ the session stays on the fallback | works reliably (e.g. `"抖音账号管理器编码代理会话"`) |

**Why the official provider always fails here**: its fixed 64-token budget assumes the adapter disables thinking for
`purpose: 'session-title'`. This host routes through **pi-ai** (a local OpenAI-Responses proxy), which has no such
purpose-specific behaviour, and `deepseek-v4.1-flash`'s reasoning cannot be turned off ⇒ all 64 tokens go to reasoning
and the provider receives empty output. Reproducing the very same request against the local proxy:
64 tokens → `status: incomplete` with `reasoning_tokens: 64` and no message; 1024 tokens → `completed` with a real title.
So it is not a model or network problem — it is the "official 64-token default × a route that cannot disable thinking" combination.

**Coexistence**: this plugin does **not** use the `ctx.sessionTitle.register()` seam (which allows only one provider and
throws on a second registration). It appends the official `session/title` event directly, and always with a **later seq**
than the official one (`turn/end` vs. first message), so even a lucky official title gets overridden. Its bundled
`cordis.patch.yml` disables the official provider by default; comment out those two lines to keep both.

### Install

```bash
dsh plugin --profile <your-profile> add dsh-rename-title-after-first-turn
```

The package declares `dsh.bundle.patch`, so `dsh plugin` also records it in `dsh.profile.bundles` — no profile file editing. Restart DSH afterwards.

### Config (all optional)

`targetCjkCharacters` 12 · `targetWords` 6 · `maxInputBytes` 8192 · `maxOutputTokens` 2048 · `timeoutMs` 60000 · `maxAttempts` 3 · `maxTitleBytes` 80. Out-of-range values fall back to defaults instead of throwing.

### Compatibility

Tested on DSH desktop **`0.2.0-rc.2`** (Windows, re-checked 2026-10-04); previously verified on `0.1.7-rc.2`. Uses `llm` (`ctx.llm.stream`) and subscribes to `session/event` / `session/disposed` — it never reads the session log, so the 0.2.0 deprecation of `snapshotEvents`/`eventAt`/`ownEvents` does not affect it. No npm dependencies, no build step, and — being host-only — it takes no part in the renderer's all-or-nothing "every client entry must activate" boot gate.

### Tests

```powershell
Get-ChildItem test -Filter '*.test.mjs' | ForEach-Object { node $_.FullName; "exit=$LASTEXITCODE $($_.Name)" }
```

Expected: **47 pass / 0 fail**. Do **not** use `node --test` on Windows sandboxes that forbid named pipes — the runner fails with a misleading `# fail 1`.

---

### License

MIT
