# Chat 面板子系统 · 代码链路图谱（`src/ui/chat/`）

> **这是一个分册群**（本文件 **451 行**）。同属 `§5.x` 一套编号、按主题拆开——**不要重编号**，
> 代码注释与其它文档里有几十处「§5.7」「§5.32」之类的引用，重编号会把它们变成指向空处的雷；
> 读到某个编号时用 grep 定位即可（跨文件引用则按文件名找）：
>
> | 分册 | 主题 | 覆盖的 §5.x |
> |---|---|---|
> | 本文件 | 面板骨架与消息纪律、安全、子 agent、双 surface、大纲、性能、引导条、面板审计 | §5.1–§5.12 |
> | [chat-panel-sessions.md](./chat-panel-sessions.md) | 会话目录与重开路径、历史选择器过滤、会话恢复 | §5.13–§5.15、§5.24、§5.48 |
> | [chat-panel-records.md](./chat-panel-records.md) | 记录区：折叠 / 时间 / 渲染 / 右键 / 置顶 / 文件引用呈现 | §5.16–§5.23、§5.25–§5.26、§5.29–§5.30、§5.41、§5.47、§5.49–§5.51 |
> | [chat-panel-input.md](./chat-panel-input.md) | 输入侧与交互抽屉：输入卡 / 草稿页 / 表单与权限抽屉 / 回车语义 / steering | §5.27、§5.31–§5.33、§5.35–§5.36、§5.42–§5.44 |
> | [chat-panel-state.md](./chat-panel-state.md) | 会话状态、诊断与几何：状态卡 / 通知 / 后台任务 / 日志与构建指纹 / 滚动诊断 / Tail 与会话级开关 | §5.28、§5.34、§5.37–§5.40、§5.45–§5.46、§5.53–§5.54 |
>
> **什么时候读**：改 `src/ui/chat/**` 之前，先按上表挑**一个**分册读，不要整包通读。
> 只是想知道「某个文件负责什么」不必读它们——那是 [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §1 的职责表。
> 这些分册回答的是**另一类问题**：「这块代码为什么长这样」「哪些不变量破了不会有任何自动检查报错」。
>
> **导航**：任务路由见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)（§0 架构图 / §0.5 任务路由 / §1 文件职责）；
> 历史坑点见 [`../docs/pitfalls.md`](../docs/pitfalls.md)。
>
> **体量沿革（2026-10-12）**：本文件曾长到 **1206 行**。按它自己沿用的「~400 行即拆分」，
> 记录区、输入侧、会话状态三块已拆成上面的分册，主文件只留 §5.1–§5.12（骨架层，451 行）。
> 下次再超 400 行时，§5.12 面板审计（历史结论表）是下一个拆分对象。

---

## 5. 新 Chat 面板子系统（`src/ui/chat/`，CUSTOM-20260923-011）

> 这一整棵树是自建的，与其它模块无耦合，因此不参与任何合并冲突。入口是 `index.ts`，
> 外部只依赖它导出的 `ChatViewProvider`（侧边栏视图）与 `ChatPanelHost`（面板宿主）。

### 5.1 文件职责

| 文件 | 职责 | 何时改它 |
|---|---|---|
| `ChatViewProvider.ts` | **侧边栏 `vac-chat` 视图的注册者**，也是视图上**唯一**的 `onDidReceiveMessage` 注册者；同时持有编辑区面板（`openEditorChat`）并做双面焦点同步（`syncFocus`） | 视图注册 / 双面同步 |
| `ChatPanelHost.ts` | 面板的扩展侧宿主：session/update → transcript，用户消息 → SessionManager；markdown 往返、链接白名单、附件。持有**多个 surface**（侧边栏 / 编辑区），`post()` 广播、`boot` 定向 | 改面板行为 |
| `ChatSurface.ts` | **019 新增**。把 `WebviewView`（侧边栏）与 `WebviewPanel`（编辑区）归一化：`visible` / `reveal(preserveFocus)` / `onDidDispose`。差异只在显隐与前置方式（`show` vs `reveal`） | 新增第三种承载方式 |
| `Outbox.ts` | **022 新增**。流式消息合帧队列：只合并「队尾单条同 id 的 append」，其余按 FIFO 原样发。顺序不变式 INV-A..E 见 §5.10 | 改合帧策略 / 新增消息类型 |
| `ChatEditorPanel.ts` | **019 新增**。编辑区面板生命周期：`open()` / `close(reason)`。视图类型 `vac-chat-editor`。**监听器必须先于 `attachSurface` 注册**（见 §5.7） | 编辑区面板行为 |
| `panelContract.ts` | `IChatPanel` / `PanelContext` / `PanelId` 三个纯接口：宿主与 surface 之间的契约（宿主独占全部 transcript，所以 detach 一个 surface 不会丢内容；detach 后**允许**继续收到零星事件，宿主丢弃而不是抛错） | 面板接口变更 |
| `SessionNotifier.ts` | **会话状态通知**（等待权限 / 等待表单 / 轮次完成）→ 右下角通知（带「打开会话」按钮）。去重键 `sessionId::kind::token` 由本模块拼，调用方只给 token。**不 import vscode**（UI 通道靠注入缝），可被 vitest 直接驱动（见 §5.34） | 改「哪个会话在等用户」的通知口径 |
| `diskSessions.ts` | 从 Claude Code 自己的会话目录（`<config>/projects/<slug>/<sessionId>.jsonl`）**补全**历史列表：`session/list` 不是全集。厂商私有格式、只读每个文件的前若干行、只扫当前工作目录的 slug、**只对 profile 声明 `transcriptStore: 'claude'` 的 agent 生效**（按 kind，入口 `ChatPanelHost` 的 `transcriptDirFor`，目录取 agent 自己 env 里的 `CLAUDE_CONFIG_DIR`）；任何一步失败都只当作「没有补充」（见 §5.45） | 历史列表比官方少几条 / Claude 转录目录格式变更 |
| `protocol.ts` | postMessage 判别联合（`ExtToChat` / `ChatToExt`）+ `verifySession` 纪律 | 增删消息类型 |
| `markdown.ts` | `SafeMarkdown`：覆盖 `marked` 的 `html`/`link`/`image` 三个渲染钩子。**必须用 `new Marked()`**（不能用全局单例，渲染钩子会被别处改掉） | markdown 安全策略变更 |
| `sessionChoices.ts` | **073 新增**。切换状态（mode + config options）的**快照 / 按通知载荷打补丁 / 算差异 → 人类可读的一句话**。纯函数，宿主只做缓存与发帖（去重靠"缓存由宿主独占"，见 §5.22）。**128 起模式以 config option 为权威**：快照的 modeId 由它派生、mode payload 写回该副本——两通道各存一份副本且只写一份时，去重会静默失效（见 §5.22 末与 pitfalls #34） | 改切换提示的表述、或改"两条上报路径怎么去重" |
| `historyDirs.ts` | **079 新增**。历史选择器的目录过滤器：`directoryKey`（目录同一性：平台大小写规则 + 尾分隔符）/ `directoryOptions`（候选目录与条数）/ `folderName`。纯函数，宿主算 key、客户端只比较（见 §5.24） | 改"两个路径算不算同一个目录"、或改候选目录的来源与排序 |
| `transcript/types.ts` | transcript 记录模型（`user`/`assistant`/`thought`/`tool`/`plan`/**`content`**/`notice` 七类，`content` 承载非文本消息块）+ `ToolInvocation`。`EntryBase.atIsElapsed`：true 表示 `at` 是「回放起点 0 起的相对毫秒」而非墙钟（见 §5.17） | 记录结构变更 |
| `transcript/TranscriptStore.ts` | 按会话存记录；三重上限（500 条 / 24 会话 LRU / 64KB 每条）；活跃会话豁免 LRU。`finalizeStreaming` 带 `only` 过滤（**不要**在正文 chunk 上调用无参形式，那会把一次回复碎成 N 个气泡）。**`beginReplay`/`endReplay`**：回放计时态——期间 append 的记录 `at` 写成 0 起相对毫秒并打 `atIsElapsed`（拿不到转录真实时刻时不再用 `Date.now()` 冒充墙钟） | 容量策略 / 新记录类型 |
| `transcript/ToolInvocationStore.ts` | 工具调用索引，严格实现 ACP 的 **replace-collection** 语义 | 工具调用字段变更 |
| `transcript/agentTerminals.ts` | **agent 自己跑的终端**（Zed 约定：`_meta.terminal_info` / `terminal_output(_delta)` / `terminal_exit`，codex-acp 用它）：`applyTerminalMeta` 按**每条更新自己的** `_meta` 累加进 `ToolInvocation.agentTerminals`（`_meta` 整体替换，不能读 `inv.meta`；尾部保留 256KB）；`agentTerminalMarkdown` 出 console 围栏。`toToolCallView` 据此把该 terminal 项换成文本，客户端自建的终端仍是 chip。纯逻辑，配 `.spec.ts` | Codex 命令输出不显示 / 新的终端 `_meta` 形状 |
| `content/contentBlocks.ts` | `ContentBlock`（5 种）→ 可序列化视图模型 | 新增内容类型 |
| `content/toolCalls.ts` | `ToolInvocation` → `ToolCallView`（命令、locations、diff/terminal/content 项；对象形状的 `rawOutput` 以 JSON 进 OUT 兜底，裸 `{exit_code}` 跳过） | 工具调用渲染数据 |
| `nesting/NestingStrategy.ts` | `NestingStrategy` 接口 + `resolveNestingStrategy(agentName)` 分派（按 `AgentProfile.nesting`，即 kind，不按名字）+ `flatNesting`（**空实现，且是默认路径**） | 新增 agent 的嵌套策略 |
| `nesting/ClaudeCodeNesting.ts` | Claude Code 的嵌套推断：显式链接（父的 `rawOutput`/`_meta` 里出现子 id）优先，时序包含回退。**全部是启发式猜测** | 探针 (b) 有新发现时改这里 |
| `html/index.ts` | `renderChatHtml(webview, nonce, surface = 'view')`：外壳 + 样式 + 标记 + 脚本。**`surface` 会变成 `<body class="surface-view\|surface-editor">`**（050），供 CSS 区分侧边栏与编辑区底色 | 装配顺序变更 |
| `html/shell.ts` / `styles.ts` / `body.ts` | CSP 与文档外壳 / 全部 CSS / 静态标记 | UI 外观 |
| `html/nonce.ts` | CSP nonce 生成 | — |
| `html/client/*.ts` | webview 内联客户端 JS，**每个模块是一个字符串**，统一挂到 `window.__vac`。构件：`dom` / `icons` / `links`（链接与文件 chip）/ `boot`（装配入口）/ `tabs` / `transcriptView` / `toolCallView`（记录区，见 §5.16+）/ `rail`（左侧引导条，§5.11）/ `scroll` + `perf`（滚动记忆与长任务看门狗，§5.10/§5.46）；`scroll` 还负责**内层滚动卡片的焦点门控与自动追尾**（§5.53）/ `times`（记录时刻，§5.29）/ `stickyUser`（置顶最近的用户消息，§5.25）/ `outline` + `contextMenu` + `sessionMenu` + `directoryMenu`（大纲与三个右键菜单，§5.9/§5.50）/ `permissionView` + `permissionDrawer`（权限卡与抽屉，§5.8/§5.35）/ `elicitationView`（表单，§5.33）/ `lightbox`（图片放大）/ `stateCard`（**连接状态卡**，§5.28）/ `composer`（输入卡，§5.32）/ `autoExpand`（新输出自动展开，按会话 + 卡片类型，2026-10-21）/ `tail`（消息面板自动追尾，2026-10-28，§5.54）/ `settingsPanel`（设置面板，2026-10-21）。058 新增 `directoryMenu.ts`；097 新增 `lightbox.ts`；102 新增 `stickyUser.ts`；123 新增 `stateCard.ts`（它同时接管了原先散在 `sessionMenu.ts` 与 `boot.ts` 的空态文案和 Connect 按钮）；151 起 `composer.ts` 也接管**草稿页**的输入卡；152 起 `elicitationView.ts` 从"记录里的内联卡"改成**悬浮抽屉**（记录只留一行待答条） | 改前端交互 |

**终端输出通路**（CUSTOM-20260923-012）：ACP 的 `Terminal` 工具内容只是引用（`{terminalId}`），终端归客户端所有。
链路为：`ConnectionInfo.terminals`（`ConnectionManager` 暴露）→ `TerminalHandler.readOutput(terminalId)`
（只读、未知 id 返回 `null`）→ `ChatPanelHost.handleOpenTerminal` → 作为 `content` 条目追加。
**例外：agent 自己的终端**（codex-acp）——`terminalId` 不是客户端建的，输出走工具更新的 `_meta`，
由 `transcript/agentTerminals.ts` 累加后直接渲染成文本，不出 chip（点了也打不开）。

### 5.2 webview 客户端代码的三条纪律（写之前必读）

客户端 JS 嵌在 **TS 模板字符串**里，因此：

1. **模板字符串内部严禁反引号**（哪怕在注释里）——会直接终止字符串，tsc 报出的
   `TS1005` 位置与肇事处相距甚远。注释一律用单引号。见 `docs/pitfalls.md` #11。
2. **想出现在生成脚本里的反斜杠必须双写**：源里写 `'\n'`，生成脚本才是 `'\n'`。
   `\u` 转义只吃 4 位十六进制。
3. 改动后**必须**跑校验：
   ```bash
   node scripts/check-webview-client.mjs
   ```
   它把各模块的模板内容抽出、拼接，交给 `new Function()` 做语法校验（只解析不执行）。
   已接入 `precompile`（`npm run compile` 前自动跑，见 `package.json`）。
4. **不要在模板体里写含 `/` 的正则**（CUSTOM-20260925-049 新增）；
   **也不要在字符串里写 `\\'`（转义单引号）**（CUSTOM-20260927-094 新增，同一类坑的第二个形态）。
   上面那个检查器是**按原始模板文本**解析的——**它不还原模板转义**。于是源码里的
   `/^\\/[a-zA-Z]:/`（生成的脚本里是 `/^\/[a-zA-Z]:/`，完全合法）在它眼里是
   「转义的反斜杠 + 未转义的 `/`」⇒ **正则在此提前结束**，后面的 `[a-zA-Z]:` 成了裸代码，
   报出一个位置完全对不上的 `Unexpected token ':'`。
   同理 `'…agent\\'s…'`（生成脚本里是 `'…agent\'s…'`，合法）在它眼里是
   「转义的反斜杠 + **字符串结束**」，后面的 `s transcript folder…` 成了裸代码 ⇒ `Unexpected identifier 's'`。
   避开办法：改写成语义等价的**无正则**形式（本次用 `charCodeAt` 判断盘符），或者让正则里
   不出现 `/`；字符串则**避免转义引号**——换个不含撇号的措辞，或用双引号包住整串。
   **字符串**里的其它转义（`\\n` / `\\u2026`）没有这个问题，只有「反斜杠 + 引号」和「正则里的 `/`」会这样炸。
   完整经过见 `docs/pitfalls.md` #11 的复发记录。

### 5.3 面板切换与在途状态

- 面板的 transcript 存在**扩展宿主**（`TranscriptStore`），切走再切回不丢内容，也不需要重新 `session/load`。
- 面板未 attach 时记录照常累积（后台会话继续跑），只是 `postMessage` 被守卫丢弃。
- 视图 id `vac-chat` 只对应**一个**视图，所有 agent 共用同一个面板宿主；`vac-chat.focus` 的 5 个调用点
  （`extension.ts` ×4 + `SessionTreeProvider` 的树项命令）**都不需要改**：无论聚焦哪个 agent，内容都由
  `ChatPanelHost` 按会话渲染。

### 5.4 消息纪律（改协议前必读）

**规则一：会话作用域的消息必须带 `sessionId`。**
扩展侧 `ChatPanelHost.onMessage` 用 `verifySession()` 校验其对应会话存在；不匹配（含过期会话）一律丢弃并记日志——
**绝不静默落到「当前聚焦会话」上**。webview 侧同样只处理与当前聚焦会话匹配的消息。
客户端用 `NS.bridge.postForSession(msg)` 发这类消息（它会给缺失的 `sessionId` 打上当前聚焦会话）。

**规则二：非会话作用域的消息必须在守卫之前处理。**
`verifySession` 守卫之前的那个 switch 是给**按设计不带 `sessionId`** 的消息用的：
`ready` / `newSession` / `focusAgent` / `renderMarkdown` / `copy` / `openLink` / `executeCommand` /
`connectAgent` · `listHistory` · `openHistorySession` · `createDraftAndSend`（032/033/058）/
`setUiPref`（077）/ `setAutoConnect`（125）。
**把这类消息放到守卫之后 = 它们会被全部丢弃。**
这不是理论风险：Phase 2 的 `renderMarkdown` 就被放在了守卫之后，导致 markdown 渲染整条链失效
（助手气泡只显示原始 markdown 文本，代码块/复制按钮/链接全都没有），而所有自动化检查都是绿的——
因为 tsc/lint/webpack 都看不到「消息被运行时守卫丢掉」。见 `CUSTOM-20260923-012`。

### 5.5 webview 侧的安全约定

- CSP：`script-src` **只有 nonce**（无 `'unsafe-inline'`），`img-src` 额外允许 `data:`（非文本内容的 base64 图片）。
- 链接：markdown 渲染出的 `<a>` **不带真实 href**。点击分两条通道：可放行协议（仅 `http`/`https`/`mailto`）
  写 `data-href`，回传扩展侧复验后 `openExternal`；**本地文件路径**（相对/绝对/`file:`，含 `:12` / `#L12` 行号后缀）
  写 `data-path` + `data-line`，走 `openFile`（按会话 cwd 解析、跳到行）。两者都不是 → `link-blocked` 静态 span。
  **`command:` 必须拒绝**——那等于把 IDE 变成远程命令执行。
- markdown：扩展侧 `SafeMarkdown` 渲染 + 客户端 `DOMParser` 白名单双重兜底。

### 5.6 子 agent 分组：全部是推断（CUSTOM-20260923-013）

> **前提**：ACP **没有**子 agent / 父子工具调用概念——枚举 SDK 全部 239 个 schema 定义，
> `parent|subagent|delegate|nested|child|spawn` **零命中**。工具调用是只以 `toolCallId` 为键的**扁平集合**。
> 因此界面上任何"树"都是**事后推断**，依据是 agent 自定义的 `rawInput` / `rawOutput` / `_meta`（均为 `unknown`）。

两条铁律，改这块之前请先读：

1. **默认必须是扁平的。** `flatNesting`（空实现）是**默认路径**而非兜底分支——对形状未知的 agent，
   时间线顺序是正确的，**错的树比没有树更糟**。新 agent 只有在实测过它的流量之后才应接入推断策略。
2. **推断出来的边必须在 UI 上可区分。** `inferredParent: true` 的边带 `?` 角标与 tooltip，
   明说"此链接由时序与产出推断而来，可能是错的"。**绝不允许**把推断结果伪装成协议事实。

推断分两级，显式优先：

| 级别 | 判据 | 标记 |
|---|---|---|
| 显式 | 某个 Task 类调用的 `rawOutput` 或 `_meta` 里**出现了子调用的 toolCallId**——与厂商无关，不需要知道键名 | `inferredParent: false` |
| 时序回退 | 子调用区间被父区间包住，取**最内层**（跨度最小）者 | `inferredParent: true` |

护栏（宁可漏连，不可错连）：父区间须比子区间长 ≥ 50ms；深度上限 3；**并列（跨度相同）不连**；
**只有 Task 类调用能做父**（Task 可嵌 Task，普通 Edit/Read 不会被误归组）。

`apply()` 是「先算后改 + 迭代收敛」——单趟边改边算会让结果依赖遍历顺序；而深度护栏读的是上一轮的深度，
单趟会让一条全新的深链全部连上（深度都从 0 开始）。**改动前请先跑 `src/test/nesting.test.ts`（11 条）**，
它把上面每条护栏都钉死了。

### 5.7 双 surface：侧边栏 + 编辑区（CUSTOM-20260924-019）

**为什么必须新建面板**：侧边栏的 `webview` 视图**无法被拖进编辑区**，VS Code 也没有对应的声明式开关；
编辑区承载 webview 的唯一途径是 `vscode.window.createWebviewPanel`（本仓库此前零处使用）。
用户选的是「并存可切换」而非「移动」，所以侧边栏视图原样保留，`vac-chat.focus` 的 5 个调用点一处未改。

**成本为什么低**：transcript 存在扩展宿主（011 的设计），与视图无关；`renderChatHtml(webview, nonce)`
的形参本来就是普通 `vscode.Webview`。第二个面 = 再 attach 一次，**不需要第二份状态，也不会触发 `session/load`**。

| 关注点 | 规则 |
|---|---|
| 状态归属 | 只有一个 `ChatPanelHost`，两个面读同一份 `TranscriptStore` / 工具索引 / 附件 / usage |
| 下行消息 | `post(msg)` **广播**（客户端本来就按 `currentSessionId` 过滤，广播即同步） |
| `boot` | **定向**（`pushBoot(from)`）。广播会让另一个文档被迫 `hydrate` → reset + 重建 + 滚到底 |
| `focus` / `meta` / `sessionsChanged` / `append` / `revise` | 广播 |
| `renderMarkdown` 往返 | 请求照旧；`markdownRendered` 广播（两个文档都需要 html，`TranscriptStore.patch` 幂等）。**186 加了一条铁律：一份 html 只对"它照之渲染的那段文本"有效**。请求带的是发起那一刻的文本，而正文还在流（适配器 `includePartialMessages: true`，一条消息拆成很多 chunk），所以回填往往对不上当前文本。两边都要判：宿主 `handleRenderMarkdown` 比对 `item.text` 与 store 当前 `entry.text`，不符就**不落盘、不回填**；客户端 `patch` 则用 `asked[entryId]`（这次问的是哪段文本）判定，不符就丢掉手里的 html。**不判的后果**：正文冻在"第一段"上，后面收到的内容一个字都不显示（用户报的"消息显示不全"），而且换会话/重开都还是那一版。**2026-10-27 起宿主还有第二条通道（不再依赖这条往返）**：`session-load-end` → `prefillReplayMarkdown`、`snapshotOf` → `prefillSnapshotMarkdown`、以及**每个会话安静 600ms 后**的 `armSettlePrefill` → `settlePrefillMarkdown`（覆盖"轮次结束后仍在输出"的尾随记录——它们再也等不到 `streaming:false`，客户端的定稿重试点因此永不触发），由宿主把缺 html 的 assistant / thought 自己渲染掉；回放时以 `revise { text, html, streaming:false }` 下发，客户端规则是**同一条 patch 里带着 text 的 html 一律照收**（它渲染的就是那次给的 text，没有"客户端问过哪一段"这回事）。安静窗口那条**在轮次仍在跑时跳过还在 stream 的记录**（半截正文会随下一片变回原文），轮次结束则一起渲染。起因：真机日志里一次 37 条记录的回放，客户端**只为最后一条**发过请求，其余全停在原文，而两端都没有一条报错——这条往返会静默断在客户端侧，所以进场与收尾都不再只靠它 |
| 关掉再打开 | `onDidDispose` → `detachSurface('editor')`；store 不动；重开 → 新文档 → `ready` → 定向 boot → 全量快照 |
| 窗口重载后恢复 | **非目标**（需 `registerWebviewPanelSerializer`） |

**三条不变量**（踩了不会有自动检查报错）：

1. **编辑区面不按 agent 分流**：任何 agent 的会话都能显示在编辑区——旧版的「聚焦到 legacy agent 就拒绝 /
   关掉面板」已随旧面板一起删除（031 起不再有这条判断）。仍然成立的是**下半条**：**没有聚焦会话是合法状态**，
   不该关面板、也不该拒绝打开——窗口重载后 `activeSessionId` 就是 null，而状态栏仍会显示"第一个已连接的 agent"
   （`activeSession?.agentDisplayName || connectedAgents[0]`），所以"状态栏写着 Claude Code"
   并不代表它被聚焦。这条曾经让「打开编辑区面板」的按钮在重载后必被拒。
2. **`attachSurface` 之前必须先注册 `onDidReceiveMessage` / `onDidDispose`**。`attachSurface` 会写 HTML，
   文档的 `ready` 紧随其后；注册晚了会漏掉第一条 `ready`，面板永久空白。
3. **`detach()` 只断侧边栏面**（`detachSurface('view')`）。写成清空全部 = 侧边栏视图被销毁时编辑区一起变空白。

**打开面板时的目标会话（031）**：`ChatEditorPanel.open()` 的顺序是
「已有面板 → 直接 `reveal`」→「没有聚焦会话 → `focusMostRecentSession()`
（复用面板 agent 选择器那套：取最近一个 live 会话并 `focusSession`）」→「`createWebviewPanel`
（`ViewColumn.Beside` + `retainContextWhenHidden`）并**重新读一次 context** 作为 boot 快照」。
**刻意不自动建会话**：`open()` 不该 spawn 进程；空面板是合法结果，面板里的 `+` 一键开新会话。

**`syncFocus()` 为什么要看两个面**：若第一行写成 `if (!this.view) return`，则「侧边栏从未打开」时
焦点变化推不到任何面板。编辑区面板恰好是"没有侧边栏也能用"的场景，所以现在的判据是
`this.view || this.editor.isOpen` 才把 `PanelContext` 推给宿主。

**编辑区面消息不走"当前面"**：`ChatEditorPanel` 把消息直接转给宿主
（`onMessage(msg, 'editor')`），由宿主按 `sessionId` 分派——surface 是哪一个不影响处理。

### 5.8 面板内权限卡（CUSTOM-20260924-020）

**三条会挂死 agent 的泄漏路径**（改这块之前必须知道，三条都得自己堵）：

1. **SDK 对 `session/request_permission` 没有超时**——呈现不出来就是永久等待。
   所以 `canPresent` 里的 `surface.reveal(true)` 不是锦上添花，是"让 agent 继续跑"的必要动作。
2. **取消轮次必须回答 `cancelled`**（ACP 契约）。`SessionManager.cancelTurn` 的第一句就是
   `bridge.cancelSession(sessionId)`。**不要**把它挪到 `connection.cancel()` 之后。
3. **并发请求**：弹框路径走全局 FIFO（`drain()`），一次只弹一个。

**状态机**（`PermissionState.status`，客户端 `permissionView.applyState` 消费）：

```
pending ──用户点按钮──► selected        （回答 optionId）
   │  └──取消/会话关闭──► cancelled     （回答 { outcome: 'cancelled' }）
   └──最后一条 surface 断开──► deferred ──弹框回答──► selected | cancelled
```

**回答路径唯一性**：`deferred` 时卡片按钮**禁用**。存在两条回答路径 = 用户以为点了 A 实际生效 B，
而 `answer()` 对已 deferred 的 prompt 直接拒绝（记日志），不做事后补救。

**`canPresent(sessionId)` = "这条请求归面板拥有"**（实现见 `ChatPanelHost.canPresent`）：

| 条件 | 为什么 |
|---|---|
| 会话还活着 | `sessionOf(...)` 取不到 ⇒ 面板里没有它的转录可画，只能走弹框 |
| 有可用的面 | `surfaceShowing(sessionId) ?? activeSurface()`：优先"正在显示这个会话"的面，否则退到最近活跃的面。**一个面都没有**就什么都画不出来 ⇒ 弹框是**唯一**不会挂死 agent 的出口（第 1 条泄漏路径） |

**"聚焦匹配"不再是必要条件**（[156]）：非聚焦会话的请求照建记录（客户端会按会话过滤增量，切过去时靠 focus 快照带回来），宿主在 `show()` 里发现"这条不在屏幕上"就**发通知**（见 §5.34）。旧判据的后果是用户看到的那一幕：他在会话 A 里打字，会话 B 的权限请求弹到窗口顶部。

`surface.reveal(true)` 仍然只为**聚焦**会话做（agent 被挂住，而且那正是用户在用的会话）；后台会话绝不抢视图——那是通知的事。

**协议**：`permissionAnswer` 是**会话作用域**的（带 `sessionId`），因此在 `ChatPanelHost.onMessage`
里必须放在 `verifySession` 守卫**之后**（§5.4 规则一）。卡片状态本身**不占新消息类型**，
走现有的 `append` / `revise`，快照天然携带待决卡片。

**安全**：`toolCall.title` / `option.name` 是 agent 可控字符串，客户端一律 `NS.dom.el(..., text)`，
**禁止 innerHTML**（`permissionView.ts` 头部有说明）。

**非目标**：权限超时（落点：`PermissionBridge.request`）。

### 5.9 会话大纲（CUSTOM-20260924-021，076 加钉住式右侧栏，077 二次优化）

**纯客户端**：不动协议、不加命令、不改 `package.json`。锚点来自 `transcriptView.ordered()`，
**不是** `Object.keys(objects)` —— 后者的顺序保证只覆盖整数样式的键，错了的表现是"跳转到不相干的消息"。
076 起锚点从「只收 `user`」扩到「`user` + `assistant`」（其它 kind 仍排除），每项带类型图标 + hover 全文。

| 关注点 | 规则 |
|---|---|
| DOM 锚 | 每个节点在 `place()` 里打 `data-entry-id`；`node(id)` / `entry(id)` 是唯一查找入口 |
| 布局读取 | **只在 rAF 回调里**（`NS.dom.schedule`）。scroll 事件只置脏位，否则每帧强制重排 |
| 高亮 | 缓存的 `[{id, top}]` 上二分；`invalidate()`（transcript 变更）后重建；重建只在抽屉打开时做 |
| 跳转 | `scroll.jumpTo(node)` 先置 `pinned = false` 再写 `scrollTop`，随后 scroll 事件按真实距离重算 |
| Escape | **捕获阶段**监听 + `stopPropagation`：composer 在 textarea 上监听 Escape 取消轮次，不拦会误取消 |
| 上限 | 200 条锚点，多出的折叠成一行「… N earlier hidden」 |
| **两类行的区分度（191）** | 锚点既有 `user` 也有 `assistant`，而在此之前两者**只有一小格图标**不同（076/077 只给图标带了 kind 类），文字颜色/字重/缩进完全一样 —— 整排读起来是同质列表（用户报"用户消息区分度不明显"）。现在 **kind 类挂在行上**（`outline.ts` 的 `row.className = 'outline-item kind-' + entry.kind`），按两级拉开：**用户行 = 骨架**（正常前景色 + `font-weight: 600` + 图标 `opacity: 1`）、**助手行 = 补充**（`descriptionForeground` + `font-size: .95em` + 图标 `.45`）。**刻意不用左竖条/背景色**做这个区分 —— 那两条通道已被"当前项"占用（`.outline-item.active` 的 border-left 与背景），一个颜色两种意思是 047 的教训。另一条分工：**kind 决定字重/字号/图标浓淡，只有"颜色"让位给选中态**（写成整条 `:not(.active)` 会让选中一个用户行时字重从 600 掉回 400 —— 选中一个东西不该改变它是什么）。**缩进那一档试过又撤了**：助手行 `padding-left` 读起来像子项，但侧栏默认只有 240px，缩进直接吃掉可读宽度、长标题更早被省略号截断（实测同一行少显示一个字）；三档（颜色/字重/字号）已经够分辨 —— 别再顺手加回来 |
| **有没有东西可导航（081）** | **这条判据管所有形态**：没有锚点（无会话 / 新会话 / 全是工具记录）时，☰ 按钮、下拉浮层、**钉住的右侧栏****一律不显示**。045 当年只把它加在 ☰ 按钮上——那时下拉是唯一形态，"没有按钮就没有大纲"成立；076 让它可钉住之后，钉住的那一栏**没走这条判据**，于是空态旁边会摊着一列 "OUTLINE / No messages yet"，把空态挤出面板正中（用户截图）。判据只有一处（`outline.ts` 的 `anchorsPresent`，由 `syncButton()` 唯一写入、`renderVisibility()` 读取），**mode 只是偏好、不决定可不可见**：钉住状态留着，第一条消息一到那栏自己回来。副作用：空对话时没法点 ✕ 取消钉住（等第一条消息即可）——因为此时它本来也没有内容可导航 |

**`invalidate()` 的调用点**在 `boot.ts` 的 `append` / `revise` / `focus` / `boot` / `sessionClosed` / `error`
分支里——**不要**放进 `meta` / `attachments`，那会让抽屉在流式期间被反复重建。

**钉住式右侧栏（CUSTOM-20260926-076，077 二次优化）**：下拉与侧栏两种形态并存，`mode ∈ {popup, sidebar}`
+ 瞬态 `isOpen`。下拉头部「固定到右侧」并进 `.outline-head`（"N messages" 同一行，`#outlinePin` 是
`.outline-head-info` 计数容器的兄弟、静态），把大纲钉成常驻右栏（`#outlineSidebar`，`#messages` 的 flex
兄弟、定宽，宽度由 JS 写 inline）。

| 关注点 | 规则 |
|---|---|
| 持久化 | `mode` / `width`（180px~50%）走**宿主 `globalState`**（077）：`setUiPref`（webview→ext）存 `vac.outlinePrefs.v1`，`uiPrefs`（ext→webview）随 boot 带回、`applyPrefs()` 恢复——跨窗口重载/编辑器面板重开存活（webview 本地 `vscode.setState` 只活在同一实例 reload） |
| **开/关按会话记（204）** | `mode` 是**布局**偏好（"允不允许出现侧栏"），而"这个会话里它开着吗"是**另一件事**，按会话记：`outlineOpenBySession` + `outlineOpenDefault`（与 Times 200 同一套语义：有效值 = 表里的记录 ?? 默认值；拨一次两处都写）。焦点咽喉点同步（`boot.applyFocus` → `NS.outline.setSession`，与 `stickyUser.setSession` 同形）。**两个 bug 的公共根因就在这一行**：以前关侧栏只改瞬态 `isOpen`（`mode` 仍是 sidebar），于是 ①重启后 `applyPrefs` 把它重新算成 `mode === 'sidebar'` ⇒ 自己回来；②`uiPrefs` 是**广播**的（宿主在**任何** `setUiPref` 之后都回一次），客户端收到就走 `applyPrefs` ⇒ **点一下 Times（200 起它会发 setUiPref）或拖一下 tab（198）就能让刚关掉的侧栏弹回来**（用户报的两条）。现在 `isOpen` 一律由那两份持久状态推出来，**回话只是收敛、不是命令**；关（☰ / Escape / ✕）一律落盘。旧记录（没有这两项）按老行为补一次 `openDefault = true`（钉住过的人升级后侧栏不该无声消失） |
| 跳转 | 侧栏模式**不关**（常驻导航）；下拉模式维持「跳完收起」 |
| `close()` 语义 | **只关下拉**：`boot.ts` 会话切换调 `close()`，侧栏模式 no-op——否则刚恢复的侧栏会被 boot 的 close 关掉 |
| 点击外部 | 只关下拉；侧栏是常驻面板，在 transcript 里点来点去不关 |
| 调宽 | `#outlineResize` pointer 事件：`width = clamp(start - dx, 180, area*0.5)`（拖左变宽）；`pointerup` 持久化 + `NS.rail.reflow()`（`#messages` 变窄改折行 → 左 rail 圆点重对齐） |
| 图标着色 | `NS.icons.icon(kind, 'outline-kind outline-kind-<kind>')`；`.outline-kind-user` 蓝（`--vscode-button-background`）、`.outline-kind-assistant` 灰（`--vscode-descriptionForeground`），与 transcript 气泡同色系 |
| 时间 | 移到每项最右（正文 `flex:1` 占满左侧），`HH:MM:SS` |
| 计数 | `transcriptView.messageAnchorCount()`（user+assistant，O(1)）驱动 ☰ 显隐 |

### 5.10 长会话性能：outbox / 增量文本 / rAF / 滚动记忆（CUSTOM-20260924-022）

**四个病灶**（改之前先确认还在不在）：① 扩展侧每个 chunk 一次 postMessage；② 客户端每次整段重设
`textContent`（累积全文，O(n²)）+ 读 `scrollHeight` 强制重排；③ `refreshSessions()` 每个 chunk 都跑，
于是每片重建整条标签栏；④ 工具分组的整容器 `querySelectorAll` 在每次工具更新时都跑。

| 手段 | 位置 |
|---|---|
| 合帧队列（只合并队尾单条同 id 的 append） | `ChatPanelHost.post()` 按类型路由 → `Outbox` |
| 标签栏快照签名（没变就不发） | `ChatPanelHost.refreshSessions()` |
| 增量文本追加（前缀成立才 `appendData`） | `transcriptView.setStreamingText()` |
| rAF 合帧：滚动跟随 + 工具分组重排 | `dom.schedule` ← `scroll.follow()` / `refreshGroupingSoon()` |
| 每会话滚动记忆（含贴底状态）+ 持久化 | `scroll.remember/restore/reassert/forget` + `boot.applyFocus` |

**INV-A..F（顺序不变式，破了**没有任何自动检查会报错**）**

- **INV-A** 某条 entry 的 `revise` 不得越过创建它的 `append`。客户端 `patch()` 对未知 id 是
  **静默 no-op**（`transcriptView.patch` 的前两行），越过 = 那条更新凭空消失。
  靠 FIFO + 只合并队尾保证。
- **INV-B** `markdownRendered` 同样只能按 FIFO 走，不得被"提前冲刷"。
- **INV-C** `sessionsChanged` 不得延迟/合并——它驱动 Send/Stop 按钮（`boot.syncFocusedState`），
  晚了按钮状态就是错的。它走 `flushThenPost`，且**只在签名变化时**才调（否则会顺带把队列冲掉，
  等于取消合帧）。
- **INV-D** `sessionClosed` 不得延迟。
- **INV-E** 每次 `boot`/`focus` 快照前必须先 `flush()`（`pushBoot`/`pushFocus` 的第一句）。
- **INV-F** **只延后**滚动、大纲 tick、工具分组重排。`hydrate` / `append` / `patch` / `updateTool` /
  `pending` 表 / `requestMarkdown` **一律同步**——`applyFocus` 里 `hydrate()` 之后立刻
  `requestMarkdown()`，一旦延后 `pendingMarkdown()` 就是空的，markdown 整条链静默失效（P0 #1 那个 bug）。

**滚动记忆的两个陷阱**：
1. `hydrate()` 里**不能**留无条件的 `toBottom()`——决策在 `applyFocus`（切走前 `remember`、
   hydrate 后 `restore`），留着会把刚恢复的位置立刻冲掉，表现为"功能做了但没生效"。
2. markdown 回填会改变高度 → `markdownRendered` 后要 `reassert()` 再对齐；
   用户一旦自己滚动就放弃恢复（`expectedTop` 区分程序写入与用户滚动）。

**诊断**：每轮结束打一行 `chat-panel: outbox sent=N merged=M queued=K`。`merged` 占比高 = 合帧在工作。
**043 起这三个数字是「单轮」语义**（`finalizeTurn` 打印后 `resetStats()`）——此前是累计值，
`merged/sent` 会漂向长期均值、那行诊断随时间失去意义。轮末的 `queued` 正常是 0–2（还在飞行中的那一帧），
**跨轮持续偏大**才是"有东西绕过 outbox"的真信号。

### 5.11 左侧引导条（CUSTOM-20260924-023）

**职责与 5.9 不同**：抽屉（§5.9）管「跨轮次回看某句话」，引导条管「这一轮干到哪一步了」。
形态照 Claude Code 官方扩展：轮次大实心点 + 步骤小空心点 + 一条竖线，可点跳转、当前项高亮。

| 关注点 | 规则 |
|---|---|
| DOM 位置 | `#rail`/`#railTrack` 与 `#messages` 同属 **`.messages-column`**（`#messages` 之外）。**不要**放进 `#messages`：那里的三档间距阶梯（`.messages > * + *` 的 `margin-top`）会位移它，它也会被当成一个"条目"参与 flex 排版。**132 起它是该列的绝对定位子元素**（原为 `.message-area` 的兄弟节点）：横向位置全靠 CSS 的 `.rail{left:0}`、JS 只测纵向，所以**锚在哪一层就贴哪条左缘**。137 撤销了消息列的限宽（列恢复满宽，与改动前逐像素一致），搬迁仍然保留 —— 列才是消息内容的定位容器，将来若再限宽也不必重做（见 §5.31）。**别挪回去** |
| 随内容滚动 | track 做 `translateY(-scrollTop)`（同一个 rAF tick 里，且值未变则不写） |
| 布局读取分档 | **`invalidate()`**（条目集合/状态变化）先比标记签名，签名没动就**不读布局**——流式 chunk 走的就是这条；**`reflow()`**（布局变化、resize）只测量不重建。500 个标记全量测 `offsetTop` 是毫秒级的，分档就是为了避开它 |
| **布局变化后重对齐（070）** | **不枚举触发事件，而是观察布局本身**：一个 `ResizeObserver` 观察**每条记录节点**（`watch()`，由 `transcriptView` 在"节点进 `#messages`"与"节点被替换"的**全部 6 处**调用——漏一处 = 那条记录的圆点从此不再动，且完全静默），回调 → `reflow()`。此前只有"标记集变化 / window resize / markdown 回填"三个时机，`<details>` 展开、工具卡正文展开（`links.toggleBody` 改的是 `hidden` 属性，**没有任何事件**）、图片加载完都不在其中 ⇒ 展开后圆点停在旧高度。**回调跳过 `streaming` 的记录**：流式条目每个 chunk 都在长，测量它们会毁掉上面那条"流式期间零布局读取"（streaming 条目的首行不可能移动，圆点本来就对）。**只观察记录节点**，观察 rail/track 自己就是观察自己的输出（回环）。不做 `toggle` 兜底——它只覆盖 `<details>`，是"半个修复且没有信号"（完整教训见 `pitfalls.md` #27）。`reset()` 要 `resetNodes()`：ResizeObserver **强引用**被观察元素 |
| 隐藏面板 | `measure()` 在 `#messages` 高度为 0 时**直接返回并保留 `needMeasure`**：否则每个点都被钉到 `top: 0`、而且这个错误位置会被当成真相缓存下来（后台编辑器组、还没 reveal 的 webview 都会碰上）。恢复可见时 ResizeObserver 会重新报尺寸，测量自然发生 |
| 点尺寸 | 尺寸与左偏移在 CSS（`.rail-dot.turn/.step`），用 `margin-top: -半高` 抵消，**所以 JS 写的 `top` 是圆心**（读 JS 时别以为它是顶边——这一条曾经让"对齐"修错方向） |
| **圆心怎么定（061）** | **锚到条目里的类型图标**：`node.querySelector('.rec-icon, .tool-icon')`，它的几何中心就是要对的中心（`icons.attach()` 本来就把它放在首行上）——**按构造对齐，没有常量、不按类型分支**。此前的 `top = y + 6` 是量出来的常量，而工具卡（3px 内边距）与用户气泡（6px）的首行中心不在一处，**统一偏上 6–9px**。`points[]` 里 `y`（条目顶边，供 `syncActive` 二分）与 `centre`（圆心）**必须分开**；`rail-line` 的两端用 `centre` |
| 命中区（062） | `.rail-dot::after { inset: -5px }` 把可点范围扩到约 17px（`step` 只有 7px），**外观不变**、不参与布局 |
| **当前项指示（062）** | **刻意不用环**：环在这个面板里已经是**键盘焦点**的语义（047 的全局 `:focus-visible`），再用 `--vscode-focusBorder` 画环就是"一个颜色两种意思"。改用**尺寸**：`.rail-dot.active { transform: scale(1.4) }`（scale 以中心为基准，所以不影响上面的圆心对齐） |
| 状态着色 | `running`（工具 `in_progress`/`pending`、文本 `streaming`、待决权限卡）蓝 / `failed` 红 / 其余灰 |
| 工具状态来源 | `transcriptView.updateTool` 会把新 view model 存回 `objects[]`——**`status` 不在 `PATCH_KEYS` 里**，不存回工具跑完了点还是蓝的 |
| 点击穿透 | `.rail` 整体 `pointer-events: none`（别挡住左侧文字选区），只有 `.rail-dot` 是 `auto` |
| `hidden` | `.rail` **不能写 `display`**（pitfall #13，靠文件顶部的 `[hidden]{display:none!important}` 兜底） |

### 5.12 面板审计与阶段 1 修复（CUSTOM-20260925-038..041）

对整套面板（侧边栏 + 编辑区）做过一次系统审计，四面（逻辑 / 性能 / 交互 / 无障碍）都有实质发现。
**038-041 只落地了「正确性」这一档**，性能与交互档的做法见下方"待办"，别当成已经安全。

**四条已落地的规则（改动时不要破坏）**

1. **`EntryPatch` 的键名 = 记录字段名，逐字相同**（`entries` / `blocks`，见 `transcript/types.ts`）。
   曾经的 `plan` / `content` 与记录层的 `entries` / `blocks` 错位，客户端 `PATCH_KEYS` 抄了协议层的
   名字 ⇒ patch 写进 `entry.plan`、渲染读 `entry.entries`，**更新静默丢弃**（`patch()` 对未知键不报错）。
   表现是 plan 卡永远停在第一次快照、切走再切回才对。**编译器看不见这类错位**（pitfall #18）。
2. **`resource_link` 的点击通道在宿主侧决定**：`contentBlocks.localPathOf(uri)` 判本地文件 → 填 `path`
   → 客户端写 `data-path`（走 `openFile`，相对路径按会话 cwd 解析）；http/https/mailto → `data-href`；
   **两者都不是 → 静态 chip**（不得长成可点的样子，否则点一次吃一个 `Blocked link` 警告）。
   注意 Windows 盘符（`C:\x`）符合 URI scheme 语法，**必须先于 scheme 判定**。
   **同一个判定用于 markdown 正文链接**（184）：`markdown.ts` 的 `link()` 先剥行号后缀（`path:12` / `path#L12`）
   再调**同一个** `localPathOf`，命中就写 `data-path` + `data-line`。此前它只放行 http/https/mailto，
   agent 写的 `[GOAL.md:74](GOAL.md:74)` 全被渲染成带删除线的 `link-blocked` 灰字 —— 看着能点、点了没反应。
   **剥行号必须早于 scheme 判定**：`GOAL.md:74` 里 `GOAL.md` 本身就是合法 scheme 语法。
3. **工具卡的 body 只有一个构建入口 `fillToolBody(body, tool)`**，`render()` 与 `update()` 共用。
   两条路径各写一遍是「locations 时有时无」与「展开的 diff 被下一次更新合上」的共同根因
   （pitfall #15 的第二次复发）。重建前 `captureExpansion` / 重建后 `applyExpansion`，按
   `data-expand-key` 搬运展开态。`bodySignature` 命中则连重建都跳过；签名**刻意不序列化 payload**，
   遇 image block 返回 `null`（不可缓存 → 无条件重建），宁可多建一次也不冒陈旧渲染的风险。
4. **`ChatPanelHost.dispose()` 必须注销 `SessionUpdateHandler` 监听器**。
   此前只是碰巧被 `SessionUpdateHandler.dispose()` 兜住。
   `Outbox.stats()` 是**单轮**语义（`finalizeTurn` 打印后 `resetStats()`）——累计会让 `merged/sent`
   漂向长期均值，那行诊断就失去意义。

**两条不变式（破了不会有自动检查报错）**

- **INV-G 替换型 patch 的键名不得改名。** 改 `EntryPatch` 或 `PATCH_KEYS` 任一侧，必须 `grep` 出全部
  消费点对照：`transcript/types.ts` ↔ `TranscriptStore.patch` ↔ `ChatPanelHost` 的调用点 ↔
  客户端 `PATCH_KEYS`。**四处**，少一处就是静默失效。
- **INV-H 工具卡 body 的字段覆盖要跟着渲染函数走。** `bodySignature` 必须涵盖渲染函数读的**每一个**
  字段；漏一个 ⇒ 该字段变化时签名不变 ⇒ **卡片永久陈旧**。加字段到 `renderContentItem` 时，
  同步加进签名（image 例外：它返回 `null` 走无条件重建）。

**审计查到的其余问题（阶段 1 时"查到但未修"；阶段 2-4 的 043-052 已全部落地，见下）**

| 档 | 问题 | 位置 |
|---|---|---|
| 性能 | **嵌套推断在每次 `tool_call_update` 全量重算**，且每个候选 `JSON.stringify` 父输出（上限 200KB） | `ChatPanelHost.onSessionUpdate` 的 `tool_call_update` 分支 + `ClaudeCodeNesting.payloadContains` |
| 性能 | `toolCallView.update` 末尾**同步**跑 `refreshGrouping` 的 `querySelectorAll`，绕过 022 的 rAF 合帧 | 对照 `transcriptView.refreshGroupingSoon` |
| 性能 | `outline.invalidate()` 每个 append/revise 至少走一遍全量锚点扫描（rail 已用签名降到 O(1)，抽屉没做） | `html/client/outline.ts` |
| 性能 | **TEMP 诊断常驻**：每次新增条目后 4 秒全量 `getBoundingClientRect` 走查（白条根因已在 037 修掉） | `html/client/transcriptView.ts` 的 `checkTextless` 整块 |
| 交互 | **键盘完全不可达**：标签 / 抽屉行 / 菜单项 / 斜杠项 / chip / 卡头都是 div+click，无 `tabindex` | 各 client 模块 |
| 交互 | 无 `aria-selected`（标签已有 `role=tab`）、无 `aria-live`（流式不播报）；`composer.focusInput()` 写了从未被调用 | `tabs.ts` / `body.ts` / `composer.ts` |
| 交互 | **webview 内零拖拽/粘贴处理**，附件只能走命令与资源管理器右键 | 全量 grep 为空 |
| 界面 | `SafeMarkdown.code` 已输出 `data-lang`，界面完全没用（无语言标签） | `markdown.ts` 产出，无消费 |
| 界面 | 编辑区面仍用 `--vscode-sideBar-background`（`body` / `.composer` / `.load-overlay`），与周围编辑器底色不一致 | `styles.ts` |
| 登记 | `.tab-dot.attention` 是**从未被任何 JS 使用**的死 CSS（像没接完的功能），用户已决定不加功能 | `styles.ts` |
| 登记 | 无 sessionId 的 `error` notice 只进当前 DOM、不进 store，切走再切回消失（**注释已声明是刻意的**） | `boot.ts` 的 `error` 分支 |

**阶段 2-4 的落地结果（CUSTOM-20260925-043..052）**

| # | 做了什么 | 关键约束（改动时别破） |
|---|---|---|
| 043 | 嵌套推断去重复序列化；`ToolInvocationStore.list()` 去掉无谓排序 | 两个缓存都**按对象引用**失效（`upsert*` 整体替换字段，引用变化即失效信号）。**不要给工具索引加 LRU 上限**——`snapshotOf` 靠它补水视图模型，淘汰会渲染出 027 消灭掉的空壳卡（理由写在类注释里） |
| 044 | 工具路径并入 rAF 合帧；`bodySignature` 用**哈希**而非长度 | **INV-H 加强**：长度不是变化信号（同长度改写会永久陈旧）。指纹化不可便宜完成时返回 `null` → 无条件重建，语义永不退化 |
| 045 | 抽屉"要不要显示 ☰"降到 O(1) | `place()` 是唯一的新增入口（`patch` 从不改 `kind`），计数器才不会漂 |
| 046 | 删掉 TEMP 诊断（约 98 行） | 白条根因在 037 的 `.messages > * { flex: 0 0 auto }`。**复发时先量高度**（036 的教训），需要时再按显式开关装轻量版，别让它常驻 |
| 047 | 键盘可达性：真 `<button>` + `:focus-visible` + roving tabindex | 委托式 click 覆盖了键盘（**Enter/Space 由浏览器原生触发 click**）——所以**不要再补一套 keydown 分支**，两套会漂。按钮样式重置块**必须放在各 class 规则之前** |
| 048 | `aria-busy` 驱动流式播报 | 计数器由 `place()` / `patch()` 的 `wasStreaming` 对比维护；`lastBusy` 守卫避免每片写 DOM |
| 049 | 附件拖拽（`attachPath`）；粘贴图片明确提示暂不支持 | 消息**会话作用域**，在守卫**之后**处理。拖拽路径**不 reveal surface**（拖拽本就在可见面上）。取不到路径必须报出来 |
| 050 | 草稿按会话记忆；编辑区面用编辑器底色；`prefers-reduced-motion` | `stashDraft()` **必须在 `state.sessionId` 改写之前**调用。CSS 里**只有** `.surface-editor` 的覆盖规则——侧边栏面不能加 |
| 051 | 代码块语言标签 | 标签在左上角（右上角归 Copy），`pointer-events: none`；只有带语言的块才让出顶部内边距。**不引入高亮器**（要改 CSP） |
| 052 | 清死代码；两处"刻意保留"写明理由 | `dom.esc` **删除处写了"不要补回来"**——通用转义助手是"用字符串拼 HTML"的邀请函。`statusGlyph` 组与 `.tab-dot.attention` 保留但必须带"为什么在这"的注释 |

**仍刻意不改的（登记在案，别当 bug 修）**

- `.tab-dot.attention`（死 CSS，设计预留）与无 sessionId 的 `error` notice（只进当前 DOM、不进 store）
  ——两者都在代码注释与 `pitfalls.md` #20 里写明了理由。
- `sanitize()` 放行整个 `data-*` 家族，而点击委托信任其中几个属性 —— 当前不可利用
  （`SafeMarkdown.html()` 把原始 HTML 转义成文本，无注入路径），但作为"将来 marked 新增钩子"的
  兜底时形同虚设。见 `pitfalls.md` #21。
- `'Claude Code'` 字面量剩 2 处（语义各不相同）——见 `pitfalls.md` #19 的处置原则：
  跨宿主/客户端或跨语义的重复，要么注释互指，要么让一侧成为唯一真源（走协议下发）。

**其他值得知道的风险**

- `'Claude Code'` 这个字面量还剩 **2 个语义不同的地方**：`agents/AgentProfile.ts` 的 `label`（配置默认名）、
  `stateCard.ts` 的空态文案（客户端硬编码，123 从 `sessionMenu.ts`/`boot.ts` 收拢到这里）。
  转录目录（`diskSessions`）与嵌套策略（`NestingStrategy`）2026-10-25 起都改为按 **kind**（`AgentProfile.transcriptStore` / `nesting`）——
  此前它们按名字判断，用户在 `vac.agents` 里改个名就悄悄失效。排序（`AgentConfig.getAgentNames`）一直按 kind。
- `sanitize()` 的 `ATTR_ALLOWLIST` **放行全部 `data-*`**，而点击委托偏偏信任 `data-href` / `data-path` /
  `data-terminal`——这层兜底实际没约束住它最该约束的几个属性。当前不可利用（`SafeMarkdown.html()`
  把原始 HTML 转义成文本，没有注入路径），但将来若 marked 新增没人覆盖的钩子，这层就形同虚设。



| **收缩控件 = 原生 details（171）** | 卡片里的折叠三角是唯一控件，点它**走原生**：不 `preventDefault`，浏览器开合克隆体自己的 `<details>`（与界面里的折叠**字面同逻辑** —— 字形、收成一行、图片/文件与文字同行全部复用），`toggle` 事件把状态按会话记进 `collapsedBySession`。166/167 自造的 `.collapsed` 类与其 CSS 已整体删除（169 的权重坑就是自造一套的代价）。左侧通道的小方块按钮 169 已按用户要求删除 |
| **收缩状态按会话（166）** | 用户报"切一次 tab 就弹回展开"。`collapsed` 原先是个模块级布尔：会串会话、切回来又丢。现在 `collapsedBySession[sessionId]`，会话 id 由 boot 在 `applyFocus` 的咽喉点同步进来（`setSession`，与 `elicitationView.setSession` 同一形态）。**同类问题见 §5.38 的清单**，本轮还顺手修了表单抽屉的同一处（换一张表单要从展开态开始） |

### 5.13–5.15 已拆出：会话目录与重开路径

> **§5.13（replay 怎么测）、§5.14（每会话工作目录）、§5.15（草稿页与目录选择）、
> §5.24（历史选择器的目录过滤）**
> 已移到 **[`chat-panel-sessions.md`](./chat-panel-sessions.md)**（CUSTOM-20260925-060、079）。
>
> **为什么是这三节一起走**：它们是同一个主题的三面——**会话生命周期**。
> 建会话时选目录（5.15）、已存在会话的目录从哪来（5.14）、重开会话那条 replay 链怎么测（5.13），
> 共享同一个前提：**cwd 是会话级属性、且由协议固定在创建时**。
>
> **§5.x 的编号原样保留**，所以各处引用只需换文件名，不必重编号（理由同 042）。
>
> 本文件保留的是**面板本体**：文件职责（§5.1）、客户端三条纪律（§5.2）、在途状态（§5.3）、
> 消息纪律（§5.4）、安全约定（§5.5）、子 agent 分组推断（§5.6）、双 surface（§5.7）、
> 权限卡（§5.8）、会话大纲（§5.9）、长会话性能与 INV-A..F（§5.10）、引导条（§5.11）、
> 面板审计结论表（§5.12）。

> **记录区（§5.16 起）另见 [`chat-panel-records.md`](./chat-panel-records.md)**：折叠与 INV-J、
> 每条记录的时间显示、工具输出的 markdown 渲染、思考块的 markdown（§5.21）、切换模型/模式的提示（§5.22）、
> 自定义右键菜单、置顶本轮提问（§5.25）、文件引用的三种呈现（§5.47）、以及客户端逻辑测试的边界。
>
> **输入侧（§5.27、§5.31 起）另见 [`chat-panel-input.md`](./chat-panel-input.md)**：表单与权限抽屉、
> 悬浮输入卡与底部栏、草稿页、回车语义、停止的二次确认、轮次中补发消息（steering）。
>
> **会话状态与诊断（§5.28、§5.34、§5.37 起）另见 [`chat-panel-state.md`](./chat-panel-state.md)**：
> 连接状态卡与自动连接、会话状态通知、后台子任务、按会话状态的收尾、构建指纹与日志桥、
> 几何变化后的重算、空态地址栏与 Times 的按会话记忆、回填分帧与长任务看门狗。
>
> **编号不连续是正常的**：章节号是**稳定的引用地址**，不是阅读顺序——`§5.24` 在 sessions、
> `§5.16–§5.23` 在 records、`§5.32` 在 input、`§5.39` 在 state，等等。按上面那张导航表找。
