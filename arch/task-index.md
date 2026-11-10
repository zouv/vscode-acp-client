# 任务 → 代码入口（分册）

> 由 ARCHITECTURE.md §2 拆出；先看 ARCH §0.5 作用域路由。

## 2. 按「我要做什么」反查代码位置（任务 → 入口）

> 行号会随改动漂移；**优先按「函数名 / 注释锚点」搜索**，行号仅作初始定位。
>
> **自愈规则（铁律）**：若按本表的函数名搜不到 / 对不上（已改名或删除）→ **以 grep/代码为准**，
> 完成任务后**顺手把本表这一行订正**。宁可信代码、修本表，也不要迁就一张过期的表。

### 2.1 进程与连接（`src/core/AgentManager.ts`、`AgentConnector.ts`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 改启动命令 / 环境变量 / cwd | `launch()`、`spawnAgent()` | Windows 与类 Unix 分支不同 |
| 修「npx/tool 找不到」 | `resolveUnixShell()` | 类 Unix 走 login shell 以加载 nvm/Homebrew |
| 修进程残留 / 关不干净 | `terminateTree()`；宿主退出兜底 `AgentManager.trackDying` / `killSurvivors` | 类 Unix 杀进程组（`exit` 时同步 SIGKILL 未退出者），Windows 用 `taskkill /T /F` |
| 改 agent 是否已连接的判定 | `AgentConnector.isConnected` / `agentIdOf` | 以**进程索引**为准，不是「有没有会话」 |
| 避免一个 agent 被并发拉起两个进程 | `AgentConnector.ensure()` | 单飞（single-flight）合并 |
| 首次连接慢 / npx 启动开销 | `AgentManager.spawnAgent`（缓存命中走 `node <entry>`）+ `scheduleInstall`/`runInstall`；纯逻辑在 `AgentInstall.ts` | 实测 npx 11–17s vs 直启 0.6s；缓存目录 `globalStorage/agents/`，7 天过期 |
| 控制面 RPC 排队 | `AgentConnector.enqueue()` | new/load/resume/fork/close/delete 等控制面调用串行，**prompt 不排**；每任务截止后队列前进；认证弹框在队列外（`withAuthRetry` 包 `enqueue`，不反过来） |
| 修 Windows 启动参数 / `%` 展开 / PATH 大小写 | `launchCommand()` + `TerminalCommand.resolveWindowsCommand` / `cmdShimCommandLine` / `mergeEnv` | 不再 `shell:true`；含 `%`、`"`、换行的参数对 `.cmd` 垫片直接报错 |

### 2.2 协议与握手（`src/core/ConnectionManager.ts`；超时/恢复见 [分册](arch/connection-lifecycle.md)）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 声明/收回客户端能力 | `connect()` 里的 `clientCapabilities` | 含 `fs`、`terminal`、`elicitation.form`、`subagents`、`session.configOptions.boolean`。**别声明 `_meta.terminal_output(_delta)`**：Claude 适配器会因此改走 `_meta` 终端输出 |
| 声明 `clientInfo` | 同上，`clientInfo` | 版本取自 `BuildInfo.readPackageVersion()` |
| 读 agent 扩展能力（steering 等） | `connect()` 里的 `_meta` 解析 | `InitializeResponse._meta.steering.supported` |
| 抓协议流水 | `tapStream()` | 双向 TransformStream，落 `VAC Traffic` 通道 + 日志文件 |
| SDK 自己关了连接（进程还活着） | `ConnectionManager.watchClose` / `onConnectionLost` → `SessionManager.handleAgentGone(name, kill=true)` | 与 `agent-closed` 共用恢复/拆除分支；先 detach 的一方生效，另一方 no-op |

### 2.3 会话生命周期（`src/core/SessionManager.ts`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 新建会话 / 复用已有会话 | `createSession()` / `connectToAgent()` | `connectToAgent` 有活会话就复用；`session/new` 失败**只抛错、不杀进程**（同进程的其它会话要活着） |
| 打开历史会话 | `openExistingSession()` | **唯一决策点**：live → focus，否则 load，再否则 resume；同 id 并发打开经 `openings`（`liveOrJoin`/`shareOpen`）共享一次 RPC，后到者得 `'live'` |
| 重放历史 / 轻量恢复 | `loadSession()` / `resumeSession()`（实体 `loadSessionNow` / `resumeSessionNow`） | load 走 `session-load-start/end`，面板显示覆盖层；`additionalDirectories` 经 `directoriesParam`（能力门控 + 绝对路径）在 new/load/resume/自动恢复统一传（fork 原样沿用源会话已被接受的额外根） |
| 关闭单个会话 / 断开整个 agent | `closeSession()` / `disconnectAgent()` | 先结算权限/表单；有在途轮次时先 `cancelTurn`；**先本地 `removeSession` 再 best-effort `session/close`**（15s 截止） |
| 删除会话（真删） | `deleteSession()` | 先 cancel/close 活会话 → best-effort `session/delete`（能力 `delete`）→ 清本地缓存 |
| 普通分叉 / 临时 Side | `forkSession()` / `forkSideSession()`，共用 `requestFork()` | `session/fork`（能力 `fork`）；普通 fork 可带 `messageId` 并重放，Side 从不带 messageId、不 load/resume/focus/写历史；主会话查询用 `getMainLiveSessions()` |
| 认证失败（-32000） | `authError.ts`：`isAuthRequiredError`；`auth.ts`：`runAuthFlow`；`SessionManager.withAuthRetry` | 只认 code -32000；new / list / load / resume / prompt 都经 `withAuthRetry` 认证后重试一次，认证 UI 不占控制面队列 |
| API key 认证 / 登出 | `auth.ts`：`takesApiKey` / `setAuthSecrets` / `forgetApiKey`；`SessionManager.logout` + 命令 `vac.logoutAgent` | key 走 `authenticate._meta['api-key'].apiKey`（codex-acp 约定），**流量日志里按键名脱敏**（`LogPrivacy.redactTraffic`，流量日志默认关闭）；`logout` 需能力 `auth.logout` |
| 焦点切换 | `focusSession()` | `active-session-changed` 的唯一出口 |
| 每会话工作目录 | `resolveDefaultCwd()` / `sessionCwd()` / `cwd.ts:pickDefaultCwd` | 会话级属性，与进程 cwd 无关 |
| 自定义模型注入 | `metaFor()` | 经 `AgentProfile` 按 kind 分化 |
| 设配置项（含布尔） | `setConfigOption()` | UI 一律传字符串；选项 `type==='boolean'` 时按 `{type:'boolean', value}` 上线（SDK 契约） |

### 2.4 发消息与轮次（`src/core/SessionManager.ts`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 发一轮 prompt | `sendPrompt()` | 有在途轮次则抛错；进出分别 emit `turn-state-changed` |
| 取消当前轮次 | `cancelTurn()` | **先回答待决权限/表单**，再发 `session/cancel`；轮次在途时两桥 `holdCancelled`，cancel 后晚到的请求直接答 cancelled，轮次结束 `releaseCancelHold` 解除 |
| 轮次中补发消息 | `steerPrompt()` / `supportsSteering()` | 走 `extMethod('_session/steering')`；返回 `'idle'` 表示要回落成普通 prompt |
| 轮次是否进行中 | `hasRunningTurn()` / `isTurnInFlight()` | UI 的 Stop 按钮与 `vac.turnInProgress` 靠它 |
| 流式更新分发 | `handlers/SessionUpdateHandler.ts:handleUpdate` | 单订阅者抛错不影响其它 |

### 2.5 聊天 UI（`src/ui/chat/**`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 面板整体行为 / 消息协议 | `ChatPanelHost.ts`（文件表见 `arch/chat-panel.md` §5.1；主题细节按该文顶部的分册导航表分流） | **勿整读**，用 grep 定位 |
| 侧边栏视图注册 / 主双面焦点 | `ChatViewProvider.ts:resolveWebviewView` / `syncFocus` | 视图上**只能有一个** `onDidReceiveMessage` |
| 编辑区主面板 | `ChatEditorPanel.ts:open` / `focusMostRecentSession` | 与侧边栏共享同一个 host |
| Side 打开 / 多标签 / 关闭 | `ChatPanelHost` 的 `openSide` / `sideFocus` / `sideClose` 分支 + `SideChatPanel.open` / `activate` / `closeGroup` + `SessionManager.forkSideSession` | 仅主 surface 可打开；每次 fork 新 tab；活动 Side 由 `surfaceFocused['side']` 唯一决定；fork/attach 失败不留下半状态；详见 `arch/chat-panel.md` §5.7 |
| `/side` 与选区引用预填 | `composer.ts` 的 `commandList` / `isSideCommand` / `appendQuote` + `contextMenu.ts` 的 `itemsFor` + `boot.ts` 的 `syncSideOrigin` | 本地命令先于 running/steering 早退；右键捕获源 sessionId 与选区，不传 messageId；引用只追加草稿、不自动发送 |
| 记录区渲染 | `transcript/TranscriptStore.ts`、`content/*`、`html/client/transcriptView.ts`；Read 高亮见 `ChatPanelHost.readLanguageForMarkdown` / `content/readHighlight.ts` / `SafeMarkdown.render` / `toolCallView.readContextKey` | Read 仅宿主可信单路径 + 原文推导无语言代码围栏；行号复原、缓存按路径失效；`styles.ts` 重置 webview 默认 code 背景。mermaid fence → `client/mermaid.ts`（懒加载、图表/原文切换与缩放；渲染进 `.mermaid-stage` 离屏舞台而不是 `document.body`，单图超时 + `maxTextSize/maxEdges` 上限，失败回落原文；SVG 内联样式改挂块级 HTML `<style>`，切换前折叠将被隐藏视图内的选区，规避 webview 原生崩溃） |
| 上下文压缩回放 / 实时压缩 | `ChatPanelHost.onSessionUpdate` 的 `compaction_update` / `compaction_summary_chunk` 分支 + `TranscriptStore.upsertCompact` + `transcript/compaction.ts` + `diskSessions.readTranscriptCompactions` + `html/client/transcriptView.ts` 的 `buildCompact` | 三条来源（update / summary chunk / 旧适配器 user chunk）都落成独立的 compact 记录；完整历史由适配器从原始 JSONL 重建（0.91.0 的 `getSessionMessages` 只有压缩后链，首条会变成 summary） |
| 进场 / 收尾时 markdown 没渲染 | `ChatPanelHost.prefillReplayMarkdown`（`session-load-end`）/ `prefillSnapshotMarkdown`（`snapshotOf`，只同步补最新 30 条）/ `armSettlePrefill` → `settlePrefillMarkdown`（会话安静 600ms）+ 客户端 `transcriptView.patch` 的「带 text 的 html 照收」规则 | 宿主自己补渲染，不再依赖客户端那条往返（见 `arch/chat-panel.md` §5.7） |
| 权限卡片 / 抽屉 | `html/client/permissionView.ts`、`permissionDrawer.ts` | 与 `PermissionBridge` 配对 |
| 表单卡片 | `html/client/elicitationView.ts` | 与 `ElicitationBridge` 配对 |
| 从记录 fork / Rewind | `ChatPanelHost` 的 `forkFromMessage` / `rewindTo` + `html/client/contextMenu.ts` + `boot.ts` 的 `rewindReady` | fork：面板只报 entryId，宿主查 ACP `messageId` → `forkSession`。Rewind：只对**用户**记录，取它之前最近一条助手记录的 `messageId` 截断（无则新建同目录会话），关闭旧 tab（可 Alt+T 撤销），原文经 `composer.setInputText` 回填；文件改动不回退 |
| sub-agent 子会话卡 | `html/client/transcriptView.ts` 的 `buildSubagent` / `patchSubagent`（记录类型 `subagent`） | 状态/标题走 `revise` 就地补丁；Cancel 发 `cancelSubagent` |
| Agent map（底栏 `N Agents` / 子 agent 树） | `agentmap/AgentMapStore.ts`（`upsert` / `noteUsage` / `noteTool` / `snapshot` / `signature`）+ `ChatPanelHost` 的 `subagent_update`、`agentMapSoon`、`pushAgentMap`、`requestAgentMap` / `stopAgent` + 客户端 `html/client/agentMap.ts` | 声明 `clientCapabilities._meta["vac/agentMap"]`；子会话 usage/tool **只喂注册表**、不并回父转录；Stop 走 `SessionManager.cancelSubagent`；详见 `arch/chat-panel.md` §5.57 |
| 编辑区标签栏右侧入口 | `package.json(menus.editor/title)` → `vac.openChatFromEditorTab`（动作同 `vac.openChatInEditor`） | 图标用 `resources/icon-editor-color.svg`（全彩徽标）—— 路径图标按**图片**渲染，颜色按 SVG 自己的来；Chat 面板已在编辑区激活时隐藏 |
| 历史列表筛选与显示上限 | `html/client/sessionMenu.ts` 的 `visibleRows` / `limitRows` / `applyPrefs` / `buildRowActions` / `applyAction` + `ChatPanelHost.clampHistoryDisplayLimit` | 目录与搜索先过滤、再截取已加载行；0 不限，不删数据；Archive / Rename / Delete 沿用宿主回执，详见 `arch/chat-panel-sessions.md` §5.24 |
| 会话 tab 右键菜单 | `html/client/contextMenu.ts` 的 `itemsFor`（`.tab` 分支） | 顺序（2026-10-29）：**Rename** / **Mark as unread**（发 `markUnread`，与后台输出同一条 attention 状态；聚焦到该会话时清掉）/ **New Session in This Folder**（沿用该会话 cwd + 额外根目录，`newSessionInDirectory`；**新 tab 插到被右键 tab 右侧** —— 宿主 `insertSessionAfter` / `placeSessionAfterInTabOrder` 展开 live 顺序后写回 `uiPrefs.tabOrder`）/ **Duplicate**（`session/fork` 不带 messageId，保留上下文与消息记录）/ **Copy working directory**（读 tab 的 `data-cwd`，没有则置灰）/ **Copy Session ID** / **Close**（永远最后）。草稿与待恢复 tab 没有 `data-session-id`，只有 Close。Close / Rename 都转到 `tabs.ts` 的 `closeModel` / `startRename`（运行中会话先弹面板内确认） |
| 会话 tab 状态点 | `html/client/tabs.ts` 的 `directoryAbbrev` / `dotClass` / `dotStatusText` + `styles.ts` 的 `.tab-dot` | 16px 方块里写目录缩写（最多 4 个字母，按 `data-len` 分档）；**固定五色**：橙 `#e8912d` 等回答 / 蓝 `#3b82f6` 在跑 / 蓝灰 `#7d8fa8` 载入 / 浅绿 `#7bc96f` 未读 / 浅灰 `#b8c0cc` 空闲；字母固定深色（running 白字）；`busy`（running/loading）外加 `tab-ring` 扩散圈 |
| 大纲 Messages / Cards tab；右栏 Details 模式 | `html/client/outline.ts`（`setTab` / `noteToolUpdate` / `cardAnchors` / `setPane` / `openRail` / `setDetailWidth`）+ `html/client/detailPane.ts`（`open` / `onEntryUpdated` / `setFocus` / `handleEscape`）+ `transcriptView.cardInfo` / `cardCount` / `reveal` + `toolCallView.render/update` 的 `slotPrefix` + `UiPrefs.outlineTab` | Messages = user/assistant；Cards = `ordered()` 全部记录（含消息），每行显示类型徽标 + 工具名/标题；点击 `reveal` 先展开被折叠的父工具卡；`toolUpdate` 仅 Cards tab 用 rAF 合并刷新；tab 按 Main/Side scoped 持久化，缺省 messages。**Details = 只检视一张工具卡**（同一视图模型再渲染一份、按会话记 entryId、详情宽度客户端本地持久化）；入口是卡头 `.tool-open-detail` 与右键 "Open in details"；详见 `arch/chat-panel.md` §5.58 |
| **面板内通用浮层**（确认 / 输入） | `html/client/popover.ts` 的 `NS.popover.confirm` / `prompt` + `body.ts` 的 `#popover` + `styles.ts` 的 `.popover` | **非模态**（不铺遮罩、不挡其它会话），z-index 95 高于设置面板与图片浮层；危险操作默认焦点在 Cancel；点外面 / Esc 取消。删除会话、关闭运行中会话、会话重命名、设置破坏性动作共用 |
| 会话 tab 中键关闭 | `html/client/tabs.ts` `renderTabs`（`mousedown` button==1 + `auxclick`） | 与 × / Delete / 右键 Close 汇入 `closeModel`；运行中会话的确认在宿主 `closeSessionWithConfirm`（原生模态） |
| 自定义模型排序 / 设置面板 | `settingsPanel.modelRow` / `installModelDrag` / `queueModelCommit` + `ChatPanelHost.handleSetModelList` + `ModelListSync` + `client/modelOrder.orderOption` | 模型列表支持拖拽、键盘和作用域+值 CAS 冲突处理；只重排 agent 已给的 model 候选；设置层优先级与子面板见 `arch/chat-panel-state.md` §5.52 |
| Chat 自定义快捷键 | `shortcuts.ts` 的 `canonicalizeShortcut` / `normalizeShortcutMap` / `applyShortcutSetting` + `ChatPanelHost.handleShortcutSetting` + `html/client/shortcuts.ts` 的 `fromEvent` / `onKeyDown` | 默认 Alt+A/E/I/P/N/W/T；`UiPrefs.shortcuts` 三面共享，事件仅当前 webview，IME/AltGr 与浮层优先；设置录制、禁用、重置与重复校验见 `arch/chat-panel-state.md` §5.52 |
| 输入卡选择器（模式 / 模型 / Effort） | `html/client/composer.ts` 的 `buildPicker` / `renderPickers` / `renderMenu` / `menuItem` | 按钮图标来自 `icons.ts`（`mode` / `model` / `effort`；Effort = 三根递增信号条，14px），菜单项是**名称 + 说明两行**、选中项打勾；说明优先取 agent/自定义模型的 `description`。Effort 按 `category === 'thought_level'` 识别。**2026-10-29**：`buildPicker` 把 `category` 写到 `data-category`；`renderPickers` 把 mode 最后 append，CSS 用 `.picker[data-category="mode"] { margin-left:auto }` 让它靠右、紧挨上下文进度，菜单 `right:0` 向左展开 |
| 引用标签点击跳转 | `html/client/composer.ts` 的 `activeFileChip` / `renderAttachments` + `links.ts` 的 `[data-path]` 委托 + `ChatPanelHost.handleOpenFile` | `.ref-tag` 与非图片 `.attachment` 带 `data-path` / `data-line` / `data-end-line`（`.attachment[data-path]` 有 cursor + hover）；**消息卡片侧同一条链路**：`contentBlocks.fileLinkTarget` 解析 `#L12-L30` → `resource_link` 视图的 `line`/`endLine` → `toolCallView` 写 `data-end-line`（markdown 正文链接与 tool locations 同样带）；`openFile` 透传 `endLine`，宿主打开文件并框选整段行区间（`doc.lineAt(end).range.end`）。`.attachment` 的 `×` 必须 `stopPropagation`，否则删除会顺带打开 |
| 输入卡 Send 灰置 / 命令面板收起 | `composer.ts` 的 `refreshSendState` / `hasSendableContent` / `openSlash` / `hideSlash` + document click 监听 | 空或纯空白（含换行）且无附件时 Send 灰置；Stop 态始终可点。点弹层与输入框之外的空白处收起 `/` 命令面板（Esc 仍可用） |
| Agent 选择器 | `html/client/tabs.ts` 的 `renderAgentBar` / `renderAgentMenu` | 从原生 `<select>` 改为与输入卡同一套 `.picker` 控件（图标 + 名称 + 说明 + 勾选）；说明来自 `SessionSummary.agentKind`（`ChatPanelHost.toSummary` 填），只在**多个 agent 都有会话**时显示 |
| 会话 tab / 目录图标悬停提示 | `html/client/tabs.ts` 的 `showTip` / `hideTip` | 自绘 `.tab-tip` 浮层（原生 `title` 不能分段着色）：tab = 标题 + 灰色 SessionId；目录图标 = 路径（无 `Dir:` 前缀）+ 灰色 State |
| Markdown 渲染预设 | `UiPrefs.markdownStyle` + `boot.ts` 的 `applyMarkdownStyle` + `styles.ts` 的 `body[data-md-style]` 规则 | `editor`（默认，跟随主题）/ `github` / `obsidian` / `typora` / `atom` / `minimal` / `things`；每套预设都带排版 + 明暗两套配色（变量 `--vac-md-*`，高对比度主题回落 token），不改渲染链路 |
| 新输出自动展开 | `html/client/autoExpand.ts`（状态 + 地址栏按钮）+ `transcriptView.setAutoExpand` / `expandEntry` | 按会话（`autoExpandBySession` + 默认值）与全局卡片类型（`autoExpandKinds`：tool / thought / diff）；只作用于 live append/patch/updateTool，hydrate 不碰 |
| 消息面板自动追尾（Tail 按钮 / Jump） | `html/client/tail.ts`（状态 + 地址栏按钮 + `resumeFromJump`）+ `scroll.setTail` / `follow` / `reflow` / `cancelTail` / `scheduleRecompute` + `transcriptView.afterMarkdownSlice`；开启时写 `body[data-tail="on"]`，消息列底部左右两个 L 形角高亮（中间不亮，随 `--vac-composer-h` 等让位）；拖条/中键按实际位移判定，手势期间 follow/reflow 不写回 | 与 Times 同一形态：`tailBySession` + `tailDefault`（默认 true）；**只有真实用户滚动**（wheel / 拖滚动条 / 中键自动滚动 / 键盘翻页）才取消，浏览器自身 scroll（anchoring / 夹紧 / 布局变化）不取消；Tail 开启时 follow/reflow 不被布局滚动留下的 `pinned=false` 锁死，stream/tool Markdown 每片收尾也 follow；Tail 关闭时 `follow()` 每帧重算 pinned/Jump；Jump 置底并恢复**当前会话** Tail，不改默认值，且只同步写一次 scrollTop；草稿 / 关闭聚焦会话同步 `tail.setFocus(null)`；`pushBoot` 定向顺序为 `uiPrefs → boot`，避免恢复中间位置时用未 hydrate 的表写回；§5.54 |
| 目录抽屉「Recently used」删一条 / 同路径重复 | `html/client/directoryMenu.ts` 的 `makeRow(..., removable)` / `removeRecent` + 宿主 `handleRemoveRecentDirectory` + `SessionHistoryStore.dismissRecentDirectory` + `historyDirs.recentDirectoryList` | 列表是派生的 ⇒ 记 `vac.recentCwdDismissed.v1` 并在合并时过滤；**去重按 `directoryKey`**（`F:/x` 与 `f:/x` 是同一条）；同目录再建会话即恢复；**顶部 `#cwdSearch` 本地搜索**两组候选，Browse 始终可达 |
| 「Recently used」条数范围 / 0 隐藏分组 | `ChatPanelHost.clampRecentDirectories`（唯一夹紧口：0–30，默认 8；空串回落 8）+ `recentDirectories()`（limit=0 直接返回）+ `settingsItems()` + 客户端 `settingsPanel.ts` 的 number 步进 | 历史 CHANGELOG / ROADMAP 里的 3–16 是已发布记录，不改 |
| 首屏连接预热 / 连接耗时 | `ChatPanelHost.prewarm`（由 `ChatViewProvider.resolveWebviewView` / `openEditorChat` 调用） | 只预热 `ensureConnected`、不建会话；日志里有 `prewarm connected in Nms` 与 `initialized in Nms` / `session ready in Nms` |
| webview 样式 | `html/styles.ts` | 按 §5 的锚点搜 |

### 2.6 能力实现（`src/handlers/`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 读文件（含未保存内容） | `FileSystemHandler.readTextFile` / `openDocument` / `FileSlice.sliceLines` | 优先 `workspace.textDocuments` 中 `file:` scheme 的文档；非绝对路径报错；不做工作区边界限制（additionalDirectories 需要） |
| 写文件 | `FileSystemHandler.writeTextFile` | 写完以 preview 打开 |
| 终端创建/输出/结束 | `TerminalHandler.createTerminal` / `readOutput` / `waitForTerminalExit` | `readOutput` 不抛异常，供面板调用；已释放终端保留在共享 `RetainedPool`（最多 10 个） |
| 权限自动批准 | `PermissionHandler.requestPermission` | 读 `vac.autoApprovePermissions` |
| 权限面板/弹框分流 | `PermissionBridge.request` / `canPresent` / `setSessionResolver`；`ElicitationBridge` 同构 | presenter 只对「屏幕上的会话」返回 true；**子会话 id 经 `ChatPanelHost.subagentParents` 解析到父会话**后才判归属，否则请求会落到窗口顶部 QuickPick |
| 权限/表单归属（子会话） | `PermissionBridge.setSessionResolver` / `ElicitationBridge.setSessionResolver` + `ChatPanelHost` 构造器注册 | `Pending` 同时保留原始 id（撤销/取消用）与 `panelSessionId`（记录锚点）；`cancelSession` / `hasPendingFor` 双匹配 |
| 面板内确认/输入浮层 | `html/client/popover.ts` 的 `NS.popover.confirm` / `prompt` | 非模态；删除/关闭运行中/重命名/设置破坏性动作共用；`settingAction` 的 `confirm` 文案由宿主 `SettingItem` 提供 |
| 表单字段扁平化 | `ElicitationBridge.fieldsOf` / `optionOf` | JSON Schema → 五种字段；选项的 description 与 preview 都保留 |
| sub-agent 子会话 / 取消子会话 | `ChatPanelHost.onSessionUpdate` 的 `subagent_update` 分支 + `subagentParents`（**仅** `SUBAGENT_TRANSCRIPT_KINDS` 内的 tool_call / message / thought / subagent_update 别名回父会话，子会话的 usage/plan/标题/模式/配置一律丢弃）、`SessionManager.cancelSubagent` | draft 能力；卡片由 `TranscriptStore.upsertSubagent` 建；并行子会话的正文字段按 `origin` 隔离合帧 |

### 2.7 侧边栏树（`src/ui/SessionTreeProvider.ts`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 树的一级/二级节点 | `agentNodes` / `agentChildren` | 二级来源见下两行 |
| agent 侧会话列表 | `agentSourced` / `fetchList` / `loadMore` | 需要 `session/list` 能力；`error` 态渲染 `errorLeaf`（Retry = `vac.refreshSessions`），**只在 idle/invalidate 时重取** —— 否则 VS Code 反复要 children 会变成对失败 `session/list` 的 ~50ms 重试环 |
| 本地缓存会话列表 | `localSourced` / `localItem` | 需要 load/resume 能力 |
| 能力探测 | `probe()` | 探测前会 `ensureConnected` |
| 刷新节流 | `refresh()` | 50ms 合并，避免风暴 |

### 2.8 配置与 agent 接入（`src/agents/`、`src/config/`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 加一个 agent | `inferAgentKind()` + `AgentProfile.ts` + `package.json(contributes.configuration.vac.agents)` | 先跑 `scripts/probe-agent-init.mjs --agent "<命令>" --session` 看它声明的能力/认证方式/配置项，再判断有没有 **专有 `_meta` 需求** |
| 改 agent 排序 | `AgentConfig.getAgentNames` | 只把第一个 Claude 提前，不全排序 |
| 适配器换包 / 旧配置迁移 | `AgentMigration.ts` 的 `REPLACEMENTS` + `AgentConfig.offerAgentMigration` | 只改写用户显式配置的 scope（全局 / 工作区）；默认值直接改 `package.json` |
| 改设置项 | `package.json(contributes.configuration)` | 前缀必须 `vac.` |
| 改设置项的作用域 / 覆盖提示 | `SettingScope.ts` 的 `resolveSetting` / `writeSetting`；面板侧 `ChatPanelHost.settingsItems` 的 `scope`/`source` + `html/client/settingsPanel.ts` | 顺序：工作区 > 用户 > `~/.vac/config.json` > `package.json` 默认；面板写**当前生效层** |
| 新增跨 IDE 全局配置键 | `GlobalSettings.ts` 的 `GLOBAL_SETTING_KEYS` + `setGlobalValue`；再在 `SettingScope.CONFIG_SETTING_KEYS` 登记 | 白名单之外的键不落 `~/.vac`；密钥永不进这里 |

### 2.9 Dashboard（`src/dashboard/`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 统计口径 / 窗口 / 聚合 | `usage/UsageIndex.ts` | 纯逻辑，配 `.spec.ts` |
| 转录根目录 | `defaultClaudeProjectsDir` / `defaultCodexSessionsDir` | 分别认 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，否则 `~/.claude` / `~/.codex` |
| Claude 转录解析 | `usage/ClaudeUsageSource.ts`、`usage/JsonlUsageSource.ts` | 增量只读新增字节 |
| Codex 转录解析 | `usage/CodexUsageSource.ts` | 按回合 `token_count` 差值 |
| 价格与成本估算 | `usage/pricing.ts`（`PRICING_AS_OF`） | 是**估值**，UI 标 "est." |
| 扫描编排 / 文件监听 | `usage/UsageService.ts`（`setEnabled` / `replaceSources` / `refresh` / `startWatching`） + `extension.ts` 配置队列 | enabled 门控、单飞/防抖、AbortSignal；禁用停止 watcher/扫描，换目录等待旧任务与落盘再重建 |
| HTML / 客户端脚本 | `DashboardHtml.ts` + `DashboardHtml.spec.ts` / `DashboardClient.spec.ts` | 无外部依赖，手写脚本 |
| 视图与消息 | `DashboardViewProvider.ts` | 无 `retainContextWhenHidden` |

---
