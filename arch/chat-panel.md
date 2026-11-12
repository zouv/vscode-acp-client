
> **这是一个分册群**。同属 `§5.x` 一套编号、按主题拆开——**不要重编号**，
> 代码注释与其它文档里有几十处「§5.7」「§5.32」之类的引用，重编号会把它们变成指向空处的雷；
> 读到某个编号时用 grep 定位即可（跨文件引用则按文件名找）：
>
> | 分册 | 主题 | 覆盖的 §5.x |
> |---|---|---|
> | 本文件 | 面板骨架与消息纪律、安全、子 agent、主双面与 Side surface、大纲、引导条、Agent map（§5.57）、右栏 Details（§5.58）；性能/审计保留跳转入口 | §5.1–§5.12、§5.57–§5.58 |
> | [chat-performance.md](./chat-performance.md) | 长会话、流式 Markdown 尾块与原生正文渲染窗口 | §5.10 |
> | [chat-panel-audit.md](./chat-panel-audit.md) | 历史面板审计结论与风险 | §5.12 |
> | [chat-panel-sessions.md](./chat-panel-sessions.md) | 会话目录与重开路径、历史选择器过滤、会话恢复 | §5.13–§5.15、§5.24、§5.48 |
> | [chat-panel-records.md](./chat-panel-records.md) | 记录区：折叠 / 时间 / 渲染 / 右键 / 置顶 / 文件引用呈现 / 上下文压缩 compact 行 | §5.16–§5.23、§5.25–§5.26、§5.29–§5.30、§5.41、§5.47、§5.49–§5.51、§5.55 |
> | [chat-panel-input.md](./chat-panel-input.md) | 输入侧与交互抽屉：输入卡 / 草稿页 / 表单与权限抽屉 / 回车语义 / steering | §5.27、§5.31–§5.33、§5.35–§5.36、§5.42–§5.44 |
> | [chat-panel-usage.md](./chat-panel-usage.md) | 上下文用量 Tip（圆环点击 / 增长曲线 / token 构成 / 费用 / 额度 / 双色） | §5.59 |
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
> 记录区、输入侧、会话状态三块已拆成上面的分册，主文件保留 §5.1–§5.12 的骨架与跳转入口。
> 2026-11-02 再拆出 §5.10 性能与 §5.12 历史审计，主文件回到 400 行以内。

---

## 5. 新 Chat 面板子系统（`src/ui/chat/`，CUSTOM-20260923-011）

> 这一整棵树是自建的，与其它模块无耦合，因此不参与任何合并冲突。入口是 `index.ts`，
> 外部只依赖它导出的 `ChatViewProvider`（侧边栏视图）与 `ChatPanelHost`（面板宿主）。

### 5.1 文件职责

| 文件 | 职责 | 何时改它 |
|---|---|---|
| `ChatViewProvider.ts` | **侧边栏 `vac-chat` 视图的注册者**，也是视图上**唯一**的 `onDidReceiveMessage` 注册者；同时持有编辑区主面板与一个多标签 `SideChatPanel`，负责主双面焦点同步和统一 dispose | 视图注册 / surface 归属 |
| `ChatPanelHost.ts` | 面板的扩展侧宿主：session/update → transcript，用户消息 → SessionManager；markdown 往返、链接白名单、附件。持有 `view` / `editor` / `side` 三个 surface；流式记录可广播，boot/focus/meta/sessionsChanged 按主/Side 定向 | 改面板行为 |
| `ChatSurface.ts` | 把 `WebviewView` 与 `WebviewPanel` 归一化：`SurfaceKey = 'view' \| 'editor' \| 'side'`，统一 `visible` / `reveal` / `onDidDispose`；`panelSurface(panel, 'side')` 复用同一 adapter | 新增承载方式 |
| `Outbox.ts` | **022 新增**。流式消息合帧队列：合并「队尾单条同 id 的 append」、首尾相接的 `appendText`（已含于队尾 append 则丢弃）、同条目 `toolUpdate` 后者胜，其余按 FIFO 原样发。顺序不变式 INV-A..E 见 §5.10；规则见 `arch/chat-performance.md`「长会话卡顿第二轮」 | 改合帧策略 / 新增消息类型 |
| `ChatEditorPanel.ts` | 编辑区主面板生命周期：`open()` / `close(reason)`，视图类型 `vac-chat-editor`。**监听器必须先于 `attachSurface` 注册**（见 §5.7） | 编辑区面板行为 |
| `SideChatPanel.ts` | 临时 `vac-side-chat` 单面板多标签：`open()` 严格串行且每次 fork 新 Side；按创建顺序登记成员，引用按 sessionId 分队列，异常只回滚本次；活动关闭选右/左邻，源关闭清理其子 Side，不注册 serializer | Side 生命周期 |
| `panelContract.ts` | `IChatPanel` / `PanelContext` / `PanelId` 与 `SideChatOpener`（open/has/sessionIds/activate/close）：宿主与 surface 解耦；detach 后允许零星事件，宿主丢弃而不是抛错 | 面板接口变更 |
| `SessionNotifier.ts` | **会话状态通知**（等待权限 / 等待表单 / 轮次完成）→ 右下角通知（带「打开会话」按钮）。去重键 `sessionId::kind::token` 由本模块拼，调用方只给 token。**不 import vscode**（UI 通道靠注入缝），可被 vitest 直接驱动（见 §5.34） | 改「哪个会话在等用户」的通知口径 |
| `diskSessions.ts` | 从 Claude Code 自己的会话目录（`<config>/projects/<slug>/<sessionId>.jsonl`）**补全**历史列表：`session/list` 不是全集。厂商私有格式、只读每个文件的前若干行、只扫当前工作目录的 slug、**只对 profile 声明 `transcriptStore: 'claude'` 的 agent 生效**（按 kind，入口 `ChatPanelHost` 的 `transcriptDirFor`，目录取 agent 自己 env 里的 `CLAUDE_CONFIG_DIR`）；任何一步失败都只当作「没有补充」（见 §5.45）。另提供 `readTranscriptCompactions`（compact boundary → summary uuid 的 trigger/preTokens）与 `readTranscriptUserAttachments` 的 `compactSummary` 标记（见 §5.55） | 历史列表比官方少几条 / Claude 转录目录格式变更 / compact 行元数据 |
| `protocol.ts` | postMessage 判别联合（`ExtToChat` / `ChatToExt`）+ `verifySession` 纪律；Side 增加 `openSide` / `sideFocus` / `sideClose` / 带 sessionId 的 `sideQuote`，`SessionSummary.sideChat` 带 parentSessionId/parentTitle/forkedAt | 增删消息类型 |
| `markdown.ts` | `SafeMarkdown`：覆盖 `marked` 的 `html`/`link`/`image` 三个渲染钩子。**必须用 `new Marked()`**（不能用全局单例，渲染钩子会被别处改掉） | markdown 安全策略变更 |
| `sessionChoices.ts` | **073 新增**。切换状态（mode + config options）的**快照 / 按通知载荷打补丁 / 算差异 → 人类可读的一句话**。纯函数，宿主只做缓存与发帖（去重靠"缓存由宿主独占"，见 §5.22）。**128 起模式以 config option 为权威**：快照的 modeId 由它派生、mode payload 写回该副本——两通道各存一份副本且只写一份时，去重会静默失效（见 §5.22 末与 pitfalls #34） | 改切换提示的表述、或改"两条上报路径怎么去重" |
| `historyDirs.ts` | **079 新增**。历史选择器的目录过滤器：`directoryKey`（目录同一性：平台大小写规则 + 尾分隔符）/ `directoryOptions`（候选目录与条数）/ `folderName`。纯函数，宿主算 key、客户端只比较（见 §5.24） | 改"两个路径算不算同一个目录"、或改候选目录的来源与排序 |
| `transcript/types.ts` | transcript 记录模型（`user`/`assistant`/`thought`/`tool`/`plan`/**`content`**/`notice`/**`compact`** 八类，`content` 承载非文本消息块，`compact` 承载上下文压缩摘要）+ `ToolInvocation`。`EntryBase.atIsElapsed`：true 表示 `at` 是「回放起点 0 起的相对毫秒」而非墙钟（见 §5.17、§5.55） | 记录结构变更 |
| `transcript/TranscriptStore.ts` | 按会话存记录；`onRemove` 在条目/LRU/drop/dropAgent 淘汰时驱动工具引用回收；三重上限（500 条 / 24 会话 LRU / 64KB 每条）；活跃会话豁免 LRU。`finalizeStreaming` 带 `only` 过滤（**不要**在正文 chunk 上调用无参形式，那会把一次回复碎成 N 个气泡）；它只遍历每会话的「仍在流式」集合（`open`，由 append/patch/裁剪维护），不扫全表。`peekEntries` / `lastEntry` 是宿主内部只读视图（不拷贝、不触 LRU），发给 webview 的一律走 `snapshot`。**`beginReplay`/`endReplay`**：回放计时态——期间 append 的记录 `at` 写成 0 起相对毫秒并打 `atIsElapsed`（拿不到转录真实时刻时不再用 `Date.now()` 冒充墙钟）。`upsertCompact` 按 compactionId 幂等建/更新 compact 记录（见 §5.55） | 容量策略 / 新记录类型 |
| `transcript/ToolInvocationStore.ts` | 工具调用索引；严格 ACP replace-collection；单消息 boundedPayload 限长；`remove` 由 TranscriptStore 淘汰后无剩余引用触发（不独立 LRU） | 工具字段 / 内存回收 |
| `transcript/agentTerminals.ts` | **agent 自己跑的终端**（Zed 约定：`_meta.terminal_info` / `terminal_output(_delta)` / `terminal_exit`，codex-acp 用它）：`applyTerminalMeta` 按**每条更新自己的** `_meta` 累加进 `ToolInvocation.agentTerminals`（`_meta` 整体替换，不能读 `inv.meta`；尾部保留 256KB）；`agentTerminalMarkdown` 出 console 围栏。`toToolCallView` 据此把该 terminal 项换成文本，客户端自建的终端仍是 chip。纯逻辑，配 `.spec.ts` | Codex 命令输出不显示 / 新的终端 `_meta` 形状 |
| `content/contentBlocks.ts` | ContentBlock（5 种）→ 可序列化视图模型；拒绝截断后必需字段缺失的块 | 内容类型 / 大结果截断 |
| `content/toolCalls.ts` | `ToolInvocation` → `ToolCallView`（命令、locations、diff/terminal/content 项；对象形状的 `rawOutput` 以 JSON 进 OUT 兜底，裸 `{exit_code}` 跳过） | 工具调用渲染数据 |
| `nesting/NestingStrategy.ts` | `NestingStrategy` 接口 + `resolveNestingStrategy(agentName)` 分派（按 `AgentProfile.nesting`，即 kind，不按名字）+ `flatNesting`（**空实现，且是默认路径**） | 新增 agent 的嵌套策略 |
| `nesting/ClaudeCodeNesting.ts` | Claude Code 的嵌套推断：显式链接（父的 `rawOutput`/`_meta` 里出现子 id）优先，时序包含回退。**全部是启发式猜测**。无 Task 类调用时 `apply` 直接跳过；`needsPass`（`NestingStrategy` 可选门控）+ `nestingInputsOf` 让与链接无关的 `tool_call_update` 不再重算 | 探针 (b) 有新发现时改这里 |
| `html/index.ts` | `renderChatHtml(webview, nonce, surface = 'view')`：外壳 + 样式 + 标记 + 脚本。`surface` 变成 `<body class="surface-view\|surface-editor\|surface-side">`；Side 复用完整聊天骨架，来源横幅在 sessionHeader 与 messageArea 之间 | 装配顺序变更 |
| `html/shell.ts` / `styles.ts` / `body.ts` | CSP 与文档外壳 / 全部 CSS / 静态标记 | UI 外观 |
| `html/nonce.ts` | CSP nonce 生成 | — |
| `html/client/modelOrder.ts` | `orderOption` 依据自定义模型顺序稳定重排 agent 已提供的模型、保留分组与未配置项相对顺序 | 自定义模型排序 |
| `html/client/shortcuts.ts` | 当前 Chat webview 的快捷键匹配与分发：`fromEvent` 给设置录制器共用，`onKeyDown` 在 IME/浮层门控后调用 tab/scroll/composer；设置值由宿主 `shortcuts.ts` 规范化并经 `uiPrefs` 下发 | Chat 快捷键 |
| `html/client/*.ts` | webview 内联客户端 JS，**每个模块是一个字符串**，统一挂到 `window.__vac`。构件：`dom` / `icons` / `links`（链接与文件 chip）/ `boot`（装配入口）/ `tabs` / `transcriptView` / `toolCallView`（记录区，见 §5.16+）/ `rail`（左侧引导条，§5.11）/ `scroll` + `perf`（滚动记忆与长任务看门狗，§5.10/§5.46）；`scroll` 还负责**内层滚动卡片的焦点门控与自动追尾**（§5.53）/ `times`（记录时刻，§5.29）/ `stickyUser`（置顶最近的用户消息，§5.25）/ `outline` + `contextMenu` + `sessionMenu` + `directoryMenu`（大纲与三个右键菜单，§5.9/§5.50）/ `detailPane`（右栏 Details 模式，§5.58）/ `mermaid`（懒加载 tiny、图表/原文切换、主题重渲染，§5.56）/ `permissionView` + `permissionDrawer`（权限卡与抽屉，§5.8/§5.35）/ `elicitationView`（表单，§5.33）/ `lightbox`（图片放大）/ `stateCard`（**连接状态卡**，§5.28）/ `composer`（输入卡，§5.32）/ `autoExpand`（新输出自动展开，按会话 + 卡片类型，2026-10-21）/ `tail`（消息面板自动追尾，2026-10-28，§5.54）/ `settingsPanel`（设置面板，2026-10-21）/ `agentMap`（子 agent 徽标与树面板，§5.57）/ `popover`（面板内非模态确认 / 输入浮层，2026-10-29；会话删除 / 关闭运行中 / 重命名 / 设置破坏性动作共用）。058 新增 `directoryMenu.ts`；097 新增 `lightbox.ts`；102 新增 `stickyUser.ts`；123 新增 `stateCard.ts`（它同时接管了原先散在 `sessionMenu.ts` 与 `boot.ts` 的空态文案和 Connect 按钮）；151 起 `composer.ts` 也接管**草稿页**的输入卡；152 起 `elicitationView.ts` 从"记录里的内联卡"改成**悬浮抽屉**（记录只留一行待答条） | 改前端交互 |

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

**规则三：surface 归属必须与会话归属同时成立。**
`canSurfaceAccess(from, sessionId)` 要求主 surface 只能操作非 Side，Side 只能操作 `surfaceFocused['side']` 绑定的 Side；
`openSide` 只接受正在显示该源主会话的 view/editor。权限/表单仍共用一个 Host presenter，但 Host 调
`PermissionBridge.answer()` / `ElicitationBridge.submit()` 时总传消息中的 expected sessionId，拒绝 stale/cross-surface promptId 回答别的会话。

### 5.5 webview 侧的安全约定

- CSP：`script-src` **只有 nonce**（无 `'unsafe-inline'`），`img-src` 额外允许 `data:`（非文本内容的 base64 图片）。
- 链接：markdown 渲染出的 `<a>` **不带真实 href**。点击分两条通道：可放行协议（仅 `http`/`https`/`mailto`）
  写 `data-href`，回传扩展侧复验后 `openExternal`；**本地文件路径**（相对/绝对/`file:`，含 `:12` / `#L12` /
  `#L12-L30` 行号后缀）写 `data-path` + `data-line` + `data-end-line`，走 `openFile`（按会话 cwd 解析、
  框选行区间）。两者都不是 → `link-blocked` 静态 span。
  **`command:` 必须拒绝**——那等于把 IDE 变成远程命令执行。
- **本地路径同样要拒绝远程位置**：`contentBlocks.localPathOf` 只接受正常绝对路径（盘符 / 单个前导 `/`）、
  相对路径，以及**没有 authority** 的 `file:` URI。UNC（`\\host\share`，含 `//host/share` 写法）与
  `file://host/...` 一律返回 undefined —— 记录区里的链接由 agent 输出（可被提示注入）驱动，
  Windows 上打开 UNC 会触发 SMB 连接并可能泄露 NTLM。`//localhost/...` 被 WHATWG URL 归一化成空 host，
  仍按本机文件处理（回环，不是远程共享）。
- markdown：扩展侧 `SafeMarkdown` 渲染 + 客户端 `DOMParser` 白名单双重兜底。
- Mermaid：唯一绕过客户端白名单的输出（`mermaid.render` 产出的 SVG 直接写入 `.mermaid-chart`）。源码只从 `<code>` 的 `textContent` 读取，配置 `securityLevel:'strict'`、`flowchart.htmlLabels:false`，不调用 `bindFunctions`，错误信息只写 `textContent`。库文件是带 nonce 的外部脚本（仍满足 `script-src 'nonce-…'`，未放宽 `cspSource`）。

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

**协议级子会话（`subagent_update`）是另一层**：声明 `subagents` 后适配器把子 agent 自己的流量
路由到**子 sessionId**，宿主用 `subagentParents` 把它并回父会话渲染。别名**只对承载记录的类型生效**
（`SUBAGENT_TRANSCRIPT_KINDS`：`tool_call` / `tool_call_update` / `agent_message_chunk` /
`agent_thought_chunk` / 子会话自己的 `subagent_update`）。子会话的 `usage_update` / `plan` /
`session_info_update` / `current_mode_update` / `config_option_update` / 压缩等状态**必须丢弃**——
并到父会话会直接改坏父的上下文圆环、Todo 卡、tab 名与 "Switched to …" 提示。并行子会话的正文
在 `TranscriptStore` 里按 `origin`（子会话 id）隔离合帧，不会因为「上一条还在流式」就被拼进另一个
来源的气泡。工具调用仍并回父会话，嵌套推断据此把子调用挂在 Task 下。
**2026-11-09 起**：子会话的 `usage_update` / `tool_call(_update)` 在**被丢弃之前**还会喂给
Agent map 注册表（§5.57）——那只用于徽标与树面板，不改变上面任何一条转录规则。

### 5.7 主双面与临时 Side surface（CUSTOM-20260924-019）

**为什么必须新建面板**：侧边栏的 `webview` 视图**无法被拖进编辑区**，VS Code 也没有对应的声明式开关；
编辑区承载 webview 的唯一途径是 `vscode.window.createWebviewPanel`（本仓库此前零处使用）。
用户选的是「并存可切换」而非「移动」，所以侧边栏视图原样保留，`vac-chat.focus` 的 5 个调用点一处未改。

**成本为什么低**：transcript 存在扩展宿主（011 的设计），与视图无关；`renderChatHtml(webview, nonce)`
的形参本来就是普通 `vscode.Webview`。第二个面 = 再 attach 一次，**不需要第二份状态，也不会触发 `session/load`**。

| 关注点 | 规则 |
|---|---|
| 状态归属 | 只有一个 `ChatPanelHost`，主双面读同一份 `TranscriptStore` / 工具索引 / 附件 / usage；Side 在同一 store 中按自己的 sessionId 隔离 |
| 下行消息 | `post(msg)` **广播**（客户端本来就按 `currentSessionId` 过滤，广播即同步）；boot/focus/meta/sessionsChanged 等会话外壳状态按下表及 Side 规则定向 |
| `boot` | **定向**（`pushBoot(from)`），已有 UI 偏好时顺序为 **`uiPrefs → boot`**：恢复中间滚动位置可能立即取消 Tail 并写回，不能让未 hydrate 的偏好表抢先。广播 `boot` 会让另一个文档被迫 `hydrate` → reset + 重建 + 滚到底 |
| `focus` / `meta` / `sessionsChanged` / `append` / `revise` | 主双面之间广播；Side 不接收主 sessions/focus。`meta` 按 sessionId 投递给绑定它的 surface；Side sessionsChanged 含面板全部成员，focus/boot 的 summary/meta/snapshot 仅活动 Side；append/revise 仍可广播，由客户端 currentSessionId 过滤 |
| 主双面 `surfaceFocused` 与 `focus` 同源 | `pushFocus()` 无 `to` 时广播给两个主面，因此它**同时**把 `surfaceFocused` 写成该会话（`lastActive` 只用于 reveal/附件，不参与路由）。只更新 `lastActive` 会让另一面的记录过期：`pushMeta` 跳过它、`openSide` 被拒、`isSessionOnScreen` 误判（通知被吞）、`requestStop` 打错面。Side 的 `surfaceFocused['side']` 只由 `pushFocus('side')` / `activateSideSession` 写，主焦点广播永不碰它 |
| `renderMarkdown` 往返 | 请求按 surface/session 过滤；`markdownRendered` 广播（所有显示该 session 的文档都需要 html，`TranscriptStore.patch` 幂等）。**186 加了一条铁律：一份 html 只对"它照之渲染的那段文本"有效**。请求带的是发起那一刻的文本，而正文还在流（适配器 `includePartialMessages: true`，一条消息拆成很多 chunk），所以回填往往对不上当前文本。两边都要判：宿主 `handleRenderMarkdown` 比对 `item.text` 与 store 当前 `entry.text`，不符就**不落盘、不回填**；客户端 `patch` 则用 `asked[entryId]`（这次问的是哪段文本）判定，不符就丢掉手里的 html。**不判的后果**：正文冻在"第一段"上，后面收到的内容一个字都不显示（用户报的"消息显示不全"），而且换会话/重开都还是那一版。**2026-10-27 起宿主还有第二条通道（不再依赖这条往返）**：`session-load-end` → `prefillReplayMarkdown`、`snapshotOf` → `prefillSnapshotMarkdown`、以及**每个会话安静 600ms 后**的 `armSettlePrefill` → `settlePrefillMarkdown`（覆盖"轮次结束后仍在输出"的尾随记录——它们再也等不到 `streaming:false`，客户端的定稿重试点因此永不触发），由宿主把缺 html 的 assistant / thought 自己渲染掉；回放时以 `revise { text, html, streaming:false }` 下发，客户端规则是**同一条 patch 里带着 text 的 html 一律照收**（它渲染的就是那次给的 text，没有"客户端问过哪一段"这回事）。安静窗口那条**在轮次仍在跑时跳过还在 stream 的记录**（半截正文会随下一片变回原文），轮次结束则一起渲染。起因：真机日志里一次 37 条记录的回放，客户端**只为最后一条**发过请求，其余全停在原文，而两端都没有一条报错——这条往返会静默断在客户端侧，所以进场与收尾都不再只靠它 |
| 关掉再打开 | `onDidDispose` → `detachSurface('editor')`；store 不动；重开 → 新文档 → `ready` → 定向 boot → 全量快照 |
| 窗口重载后恢复 | **非目标**（需 `registerWebviewPanelSerializer`） |

**Side 是第三个、但不参与主焦点模型的 surface**：

- `ChatViewProvider` 装配一个多标签 `SideChatPanel`；每次 `open()` 都从对应主会话末尾 fork 新 Side，同源/跨源均并存，新 tab 自动激活。标签为 `来源标题 · Side短id`，保持创建顺序且不可拖拽；关闭活动 tab 优先右邻、否则左邻，最后一个才销毁面板；源关闭只清理其子 Side。
- Side attach/activate 只写 `surfaceFocused['side']`，不改全局 `focused`、主 surface `lastActive` 或主 tab 顺序。Side boot/sessionsChanged 含全部成员，focus/boot 的 summary/meta/snapshot 仅活动 Side；`autoConnect=false`，不含主 recoverable/defaultCwd；`syncSideOrigin()` 显示 `From <完整 parentSessionId>`，非空 `parentTitle` 追加为 ` · <标题>`，并显示 forkedAt tooltip；无标题/空白标题只留 UUID，晚到标题与父改名随 summaries 原地刷新，不重新 hydrate。
- `SIDE_MESSAGE_TYPES` 与 `canSurfaceAccess()` 双层拒绝递归 Side、普通 fork、新建/恢复及跨 session 操作；`sideFocus/sideClose` 单独校验 Side surface 与面板成员，可切换/关闭非活动 tab，其他普通消息仍只准活动 Side。
- `ready` 先交 `host.onMessage(..., 'side')` 触发定向 boot，再只 flush 活动 Side 的引用。`sideQuote` 带 sessionId，宿主按 Side 分队列、客户端再校验 currentSessionId；引用不进 ACP prompt，直到用户显式发送。
- 后台 Side 权限/表单不抢活动 tab，通知点击经 `activate(..., { reveal: true })` 定位对应 Side；后台输出只标自己的 unread。权限/表单回答继续由 Bridge 校验 expected session，且每个请求恰好结算一次。
- 关闭先 `releaseSideSession()` 清 Side scope 中指定 Side 的四张 per-session UI prefs，保留兄弟 Side、Side defaults/layout 与全部 Main prefs，再经 `deleteSession()` 结算请求、cancel/close/delete/local forget；成员/listener/panel/surface 幂等清理。无 serializer，窗口重载不恢复；Host 启动会清 Side 遗留 per-session map，但保留 Side defaults/layout。Main/Side 投影与回写收敛见 `arch/chat-panel-state.md` §5.55。

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

> 续：[chat-panel-1b.md](chat-panel-1b.md)
