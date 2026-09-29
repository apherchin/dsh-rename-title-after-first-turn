# dsh-session-title-first-turn

[中文](#中文) ｜ [English](#english)

主会话「第一轮对话结束后，自动总结命名**一次**」的 **host-only** DSH 插件（不改 `app.asar`，无 client 半边）。

---

## 中文

### 它解决什么

DSH 自带的兜底命名是「首条消息截到 40 字节」，经常读起来不像个标题；而内置的 first-prompt 标题 provider 在本机**近乎必失败**。本插件在**第一轮真正结束之后**（已有提问、已有回答）用一次模型调用总结出标题，**此后永久不再改**。

### 行为

- **触发**：`turn/end` 且 `turn >= 1`。`turn === 1` 是**第一次机会**；**成功落库后永久冻结**（后续轮次被幂等守卫跳过）。第一次机会失败时，允许在后续轮次重试，上限 `maxAttempts`。
- **只碰主会话**：`session.header` 必须是对象、`parentSession` 为空、且 `delegationDepth` 缺失或为 `0`；**subagent / teammate 会话一律不动**。判据是 **fail-closed**（形状不认识就不碰），因为它是兑现这条硬要求的唯一守卫。
- **素材**：第一轮的「首条人类提问 + `turn === 1` 的所有助手 `text` 块」（`reasoning` 与工具调用一律排除）。重试时素材仍**只取第一轮**。
- **落库**：`session.append("session/title", { title, messageSeqs: [首条人类消息 seq], source: { kind: "provider", provider: "session-title-first-turn", model } })`。宿主按 higher-seq-wins 推给客户端 ⇒ **侧栏自动改名，无需刷新页面**。
- **用户手改的名字永不覆盖**。
- **失败一律降级**为「保持 DSH 自带兜底名」，只记一行 `warn`，**绝不外抛**（插件跑在宿主 Node 进程里，抛错会波及整个应用）。

### 安装

```bash
dsh plugin --profile <你的 profile> add dsh-session-title-first-turn
```

包内声明了 `dsh.bundle.patch`，所以 `dsh plugin` 会**自动把它记进 `dsh.profile.bundles`**，无需手工编辑 profile 文件。然后重启 DSH（打包版没有「刷新页面」）。

手动兜底（不用 `dsh plugin` 时）：`pnpm add dsh-session-title-first-turn`，再在 `cordis.patch.yml` 追加

```yaml
- insert:
    - id: session-title-first-turn
      name: "dsh-session-title-first-turn"
```

> 可选：想让本插件**独占命名权**，同时停用内置的 first-prompt provider（把 `- id: session-title-llm` + `disabled: true` 加进 profile 补丁）。包里的 `cordis.patch.yml` 有这两行的注释版本——**默认不启用**，因为它会改变别人的默认行为。

### 配置（profile 那条 `insert` 的 `config`，全部可选）

| 键 | 默认 | 允许范围 | 含义 |
|---|---|---|---|
| `targetCjkCharacters` | 12 | 1–60 | 中文目标字数 |
| `targetWords` | 6 | 1–30 | 非中文目标词数 |
| `maxInputBytes` | 8192 | 256–1000000 | 素材字节上限（分数向下取整） |
| `maxOutputTokens` | 2048 | 32–32000 | 输出上限（内置 provider 是 64，疑似被推理 token 吃光 ⇒ 本机 28/30 失败） |
| `timeoutMs` | 60000 | 1000–900000 | 端到端超时；是**硬边界**（`Promise.race`），适配器不看 `signal` 也会返回 |
| `maxAttempts` | 3 | 1–10 | 每个会话最多尝试次数（1 = 只试第一轮）。**含「无路由」那种没打到模型的尝试** |
| `maxTitleBytes` | 80 | 8–512 | 落库标题的 UTF-8 字节上限 |

非法/越界值一律**回退缺省**，不抛错。

### 兼容性

- **实测环境**：DSH 桌面壳 `0.1.7-rc.2`（Windows）。
- **host-only**：没有 client 半边 ⇒ **不参与**渲染端「每条 client entry 必须 active」的全有全无启动门禁。
- 用到的服务：`llm`（`ctx.llm.stream`）；订阅 `session/event`、`session/disposed`。
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

- **按包名装的**：`dsh plugin --profile <你的 profile> remove dsh-session-title-first-turn`
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

### Install

```bash
dsh plugin --profile <your-profile> add dsh-session-title-first-turn
```

The package declares `dsh.bundle.patch`, so `dsh plugin` also records it in `dsh.profile.bundles` — no profile file editing. Restart DSH afterwards.

### Config (all optional)

`targetCjkCharacters` 12 · `targetWords` 6 · `maxInputBytes` 8192 · `maxOutputTokens` 2048 · `timeoutMs` 60000 · `maxAttempts` 3 · `maxTitleBytes` 80. Out-of-range values fall back to defaults instead of throwing.

### Compatibility

Tested on DSH desktop `0.1.7-rc.2` (Windows). Uses `llm` (`ctx.llm.stream`) and subscribes to `session/event` / `session/disposed`. No npm dependencies, no build step, and — being host-only — it takes no part in the renderer's all-or-nothing "every client entry must activate" boot gate.

### Tests

```powershell
Get-ChildItem test -Filter '*.test.mjs' | ForEach-Object { node $_.FullName; "exit=$LASTEXITCODE $($_.Name)" }
```

Expected: **47 pass / 0 fail**. Do **not** use `node --test` on Windows sandboxes that forbid named pipes — the runner fails with a misleading `# fail 1`.

---

### License

MIT
