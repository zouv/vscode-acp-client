# Chat 面板 · 会话状态、诊断与几何（状态卡 / 通知 / 后台任务 / 日志与构建指纹）

> **这是什么**：`arch/chat-panel.md` 的**分册**（2026-10-12 从主文件拆出）。
> 管**会话的状态与可观测性**：连接状态卡与自动连接、会话状态通知（等待权限 / 等待表单 / 轮次完成）、
> 轮次之外的后台子任务、按会话状态的收尾、构建指纹与日志桥、几何变化后的重算、
> 空态地址栏与 Times 的按会话记忆、回填分帧与长任务看门狗。
>
> **§5.x 的编号原样保留**（与主文件同一套编号，跨文件连续）——**不要重编号**，引用只需换文件名。
>
> **分册导航**：面板骨架与消息纪律见 [`chat-panel.md`](./chat-panel.md)（§5.1–§5.12）；
> 输入侧与抽屉见 [`chat-panel-input.md`](./chat-panel-input.md)；
> 记录区见 [`chat-panel-records.md`](./chat-panel-records.md)；
> 会话目录与重开路径见 [`chat-panel-sessions.md`](./chat-panel-sessions.md)；
> 任务路由见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)。

---

### 5.28 连接状态卡与自动连接（CUSTOM-20260930-123..126、194、195）

**它修的是什么**：点 Connect 之后面板立刻切到草稿页，而真正的 spawn + initialize（首次 `npx` 可能下载几分钟）
**在界面上完全不可见**；而草稿页中央是空的（`focusDraft` 调 `showEmpty(false)`）。结果是用户反复点按钮，
连上之后又只看到一片空白。现在这一层是四态卡片（`html/client/stateCard.ts`）：未连接 / 连接中 / 已就绪 /
**建会话中**（195 —— 草稿页首条消息发出去到会话回来之间）。

| 关注点 | 规则 |
|---|---|
| 四态 | `phase = connecting ? 'connecting' : (creating && connected ? 'creating' : (connected ? 'ready' : 'disconnected'))`。`connected` 有**两个来源**（`boot`/`focus`/`sessionsChanged` 的 `agentConnected` 说的是"进程还活着/已死"，`connection{state:'connected'}` 说的是"刚连上"），`connecting` 也有两个（本地点击、宿主广播）。`creating` 只有一条路：`composer.send()` 的草稿分支（见下行的"建会话中"）。**`creating` 以 `connected` 为前提**：socket 半路掉了要退回 `disconnected`（Connect 按钮回来），不能把用户留在一张永远转圈的卡上。 |
| 首帧占位（booting，2026-10-21） | 面板打开到收到宿主第一条消息之间显示 `Starting VAC…` / `Loading the chat panel…`（body.ts 里静态写好同样的句子，脚本还没跑起来时就能看到，替代此前的空白/黑屏）。它在 `phase()` **最后**判定：任何已发生的相位（connecting / connected / restore / creating）都优先；`noteBoot` / `setConnected` / `setRestore` / `onConnection` 任一到达即退出。 |
| **建会话中也属于"在等"（195）** | 用户报「发出第一条消息后要等很久、消息区才有反应」。实测那段时间**全在 `session/new` 这一发请求里**：agent 侧 `session/create` 的 `sdk-initialize` 一步 675ms / 11116ms / 13194ms（三次采样），而"建完会话 → 应用草稿选择 → 发出消息"只要 ~160ms。原本屏幕上**没有一处**能看出"已经在建了"：卡片还写着 "Claude Code is ready"、输入框的字故意留着（058）⇒ placeholder 被内容挡着、按钮只是 disabled。所以这一相位只干一件事：把等待说出来（标题 + 转圈 + 秒表）。`render()` 里把"在等"的两态收成一个 `waiting` 变量（转圈 / `aria-busy` / Connect 按钮退场三处共用）。 |
| **`connection` 必须无条件回话** | `refreshSessions` 靠签名去重（`conn:` 位），而 `ensureConnected` 在进程已起时**不发任何事件** ⇒「已连接 + 无会话 + 点 Connect」这条路上宿主原本一句话都不会说，客户端的"连接中"会**永久卡死**（pitfalls #29 的形态：效果上没变化 ≠ 可以不回话）。三种出口（无 agent / 成功 / 失败）各发一次。 |
| **建会话中的进出（195）** | 进：`composer.send()` 的草稿分支（与 `state.draftPending = true` 同一帧）→ `stateCard.beginCreating()`。出：`boot` 的 `resolveDraft`（成功）/ `failDraft`（失败，**先收相位再写错误**，反了报错会被压在下面）/ `dropDraft`。失败与丢弃都必须把相位收干净，否则下一个草稿页会带着上一轮的"建会话中"进来。 |
| 顺序是承重的 | `handleConnectAgent` 里 `focusSession(newest)` 必须排在 `connection{connected}` **之前**——客户端靠这个顺序决定开不开草稿，反了会在刚打开的会话旁边多出一张空标签。`connection` 因此也进了 `STRUCTURAL_MESSAGE_TYPES`（排进合帧队列就可能反过来）。 |
| 谁写 `display` | **仍然只有 `boot.showEmpty()`**。卡片模块只写内容（textContent / checked / disabled / 子节点 hidden）。卡片是 `role="status"`，所以文本**先比较再写**——每写一次读屏就播报一次。 |
| 草稿的时机 | 点 Connect **不再立即开草稿**。`handleConnectAgent` 成功后：**有会话就聚焦最新的那条**，**没有会话就建一个**（131，用户在三方案里选的）。"未连接时输入框禁用"因此自然成立——`composer.ts` 的 `canCompose()` 一个字节没改。**为什么无会话时是"建会话"而不是"开草稿"**：草稿页**永远**做不到"和正常会话一样"——图片要挂在会话上，模式/模型选择器来自 `session/new` 的响应，没有会话就没有（`composer.setDraft` 的注释里写着这条）。代价：连上后不说话就离开会在 agent 历史里留一条空会话（`session/close` 不删历史，058）。 |
| 相位也是面板级的 | `stateCard.render()` 把相位写到 `body[data-phase]`，header 上的 `Times` 按钮据此隐藏（129 之前它在未连接时也显示）。写在 body 上而不是让每个按钮各自监听：少三处同步，而且**本地点击发起的 `connecting` 也覆盖到了**（那条路径不经过宿主）。 |
| `stickyUser` 的残留 | `showEmpty(true)` 里补 `NS.stickyUser.reset()`：置顶卡片是 `.messages-column` 的绝对定位子元素，`transcriptView.reset()` 清不掉它，而卡片没有背景 ⇒ 草稿页会让上一个会话的置顶卡**透出来**。 |
| 无会话的失败 | `case 'error'` 与 `draftFailed` 原先往空 transcript 里 append 通知并 `showEmpty(false)`（卡片被藏起来、中央只剩一行孤零零的报错），现在写进卡片的 `.state-error`。 |
| 自动连接的前提 | `autoConnect && !agentConnected && !focused`，**立即连接**（2026-10-21 去掉了原来的 1s 延时；用户要求打开面板即连）。布防**幂等**（boot 会在同一个文档上投递两次），连接前**复查**一次（用户可能已经在别的草稿页打字——判据用 `composer.isComposable()` 这个**直接信号**，不用代理信号）。 |
| 预热（2026-10-21） | 视图一 resolve（`ChatViewProvider.resolveWebviewView` / `openEditorChat`）就调 `ChatPanelHost.prewarm()` → `ensureConnected`，**只建连接、不建会话**（有可恢复会话时仍由卡片先问）。首次连接的 npx 冷启动实测 **36s**（`initialize` 请求→响应），这段现在与 webview 渲染重叠。预热失败只写日志；真正的 Connect 会重试。日志分段：`prewarm connected in Nms`、`initialized in Nms`、`session ready in Nms`。 |
| npx 本地缓存（2026-10-21） | 实测 `npx <spec>` 每次 11–17s（`--offline` 也一样），而 `node <entry>` + initialize 只要 **0.6s**。首次仍走 npx（行为不变），连接稳定 15s 后 `AgentManager.scheduleInstall` 在 `globalStorage/agents/<agent>` 后台 `npm install`（一次性 ~75s / ~320MB），下一轮启动直接 `node <entry>`。缓存 **7 天过期**，或 spec 变化 → 重建并回退 npx。日志：`Spawning … (cached runtime)`、`Agent runtime cached for … in Nms`。 |
| 不谎报失败 | 45s 没回话**不报错**：`ensureConnected` 本身没有超时，首次 `npx` 下载可以几分钟。只把按钮放开（允许重试）并说明原因——谎报失败比慢更糟。 |
| 设置的读写 | `vac.autoConnectOnOpen` 经 `PanelPrefsIO` 注入缝读写（默认实现才碰 `vscode.workspace`；测试给桩，**不碰真实 settings.json**）。**写失败时广播的是设置真值而不是请求值**，否则复选框会显示一个 settings.json 里没有的值。宿主只在这一个 key 上挂了 `onDidChangeConfiguration`——面板把这个配置项**渲染成了控件**，控件显示过期值就是在撒谎。 |
| 开关什么时候在 | 只在**未连接 / 连接中**显示。连上之后卡片是"去下面打字"的路标，不是一个设置表单——开关管的是"下次打开这个面板"（127，用户复验提出）；**连接中仍然保留**，那恰恰是最想关掉它的时刻。隐藏的是整行 `#autoConnectRow` 而不是那个 `<input>`，否则标签文字会留在原地。 |
| 居中与溢出 | `#emptyState` 用「容器 `flex-start` + 卡片 `margin: auto`」而不是 `justify-content: center`（内容一超高，center 会把顶部裁掉且**滚不到**，pitfall #17 同族）；卡片**不写 `overflow`**（会在 flex 列里被压扁），写 `width: 100%`（否则取 fit-content，窄侧边栏里的行为就只能靠推断，见 pitfalls #31）。实测入口：`preview-records.mjs` 的 `#empty` / `#connecting` / `#ready` / `#narrow`，几何靠 `#probe` + `chrome --dump-dom` 读回来。 |

### 5.34 会话状态通知：等待权限 / 等待表单 / 轮次完成（CUSTOM-20261001-156/157）

**为什么有它**：多会话是常态，而"某个 agent 在后台被挂住"从前只有一条出路 —— 弹到窗口顶部的
QuickPick（用户截图：他在会话 A 打字，会话 B 的权限请求弹到窗口顶部）。现在：**哪个会话在等你，
就发一条右下角通知**，点「打开会话」跳过去作答。§5.8 的 `canPresent` 判据是同一次改写的另一半。

| 关注点 | 规则 |
|---|---|
| 通道 | `vscode.window.showWarningMessage / showInformationMessage(text, '打开会话')`。**没有更"系统级"的 API**：窗口失焦时会不会变成 Windows 系统 toast 是 **VS Code 宿主自己的行为**，扩展控制不了（验收时看一眼即可，别去写平台特判） |
| 级别 | 等待类 = **warning**（VS Code 的 info 会自动消失、warning 会一直挂着——agent 被挂住不能错过）；完成 = **info** |
| 只在"不在屏幕上"时发 | 判据是**宿主**的 `isSessionOnScreen(sessionId)` = 聚焦匹配 **且** 有可见 surface。正在看的会话不发（卡片/抽屉就在眼前）；面板被编辑器盖住、或你看的是别的会话 → 发。**判据刻意不放进 SessionNotifier**：那样它要持有宿主状态，就不可能两行测完 |
| 三类事件 | 等待权限 / 等待表单 → `ChatPanelHost.show()`（权限与表单共用那一个双形状方法，所以只有一个挂点）；轮次完成 → **`finalizeTurn`**（全仓唯一的轮次结束收敛点，全仓只有一个调用点 —— 不需要第二份"这一轮结束了吗"的状态）。**出错并入完成**（`failed: true` + 同一份文案），不新开一类：同一次失败发两条通知就是噪声 |
| 取消不发 | `stopReason === 'cancelled'` ⇒ 静默（用户自己按的 Stop，他知道）。文案在导出的纯函数 `stopReasonText()` 里 —— 记录区（`applyStopReason`）与通知**共用同一份**，两处各写一份迟早各说各话（pitfall #19） |
| 去重 | 键 = `sessionId::kind::token`（等待类 token = promptId；完成类 = 每会话自增轮次号），由 **SessionNotifier 自己拼**（调用方只给 token），`forget(sessionId)` 才是前缀匹配。会话关闭时 forget |
| 点击 | `focusSession(sessionId, { force: true })`（080/087 的既定用法：否则焦点没变就不发事件）+ 有面则 `reveal(false)`（点通知是**显式用户动作**，可以抢焦点——与 `canPresent` 里那个 `reveal(true)` 的克制正好相反），没有面才 `executeCommand('vac-chat.focus')`。会话已经关了 ⇒ 记日志、什么都不做（静默会像一个坏掉的按钮，#29） |
| 模块边界 | `SessionNotifier` **不 import vscode，也不 import Logger**（后者会把它拖进 vscode）：纯逻辑 + 注入的 `NoticeChannel`，所以 `npx mocha --ui tdd out/test/session-notifier.test.js` 直接可跑。真实通道 `vscodeNoticeChannel()` 放在 `ChatPanelHost.ts`（与 `vscodePanelPrefs()` 并排，同一理由） |
| 通知刷屏 | 同一后台会话连发多个权限请求 = 多条通知（VS Code 自己会堆叠）。接受；要收敛的话再加"同会话 N 秒合并"，但那是另一个决定 |

**"每个请求恰好被答一次"没有被碰**：`PermissionBridge` 一行逻辑都没改（只改了 `canPresent` 的文档）。
`owner` 的语义从"此刻看得见"变成"归面板拥有"之后，`answer()` 原有的 `owner === 'panel'` 守卫
自动覆盖了"后台请求等用户跳过来再答"这条新路径。

### 5.37 轮次之外的 agent 工作：后台子任务（CUSTOM-20261001-162）

**现象（用户报）**：任务还在跑（在等子 agent），发送按钮却已经变回普通状态。
**根因**：`running` 原本只由"该会话的 `session/prompt` 请求还没返回"（`SessionManager.inFlightTurns`）
决定，而 **Claude Code 的后台子任务（Task 工具带 `run_in_background`）会在轮次结束后继续干活** ——
轮次一结束，面板就让它看起来"空闲"了。它的产出此后以**轮次外的通知**继续到达（日志里这类通知还带
adapter 的私有标记 `_meta."_claude/origin".kind = "task-notification"`），它们的完结则以
`<task-notification>` 注入块回到会话里（109 早就在处理这类块）。

**状态机**（三条进出条件都要求**有证据**，不猜）：

| 边 | 条件 | 为什么 |
|---|---|---|
| 进入 | 某个 tool call 的 `rawInput.run_in_background` 为真 | agent 明说"我起了个后台任务"，也是唯一能**提前**知道的信号；**轮次还在飞时就要记下来**（任务会比轮次活得久） |
| 保持 | 该会话还有**产出型**通知（助手/思考分片、`tool_call(_update)`）⇒ 看门狗重新武装 | 还在说话/调工具就还在干活。**刻意排除** `session_info_update` / `available_commands_update` / `current_mode_update` / `usage_update` —— 那些是 housekeeping，空闲时也会来，算进去等于给空闲会话钉一个 Stop 按钮 |
| 退出 ① | 收到 `<task-notification>` 注入块 | 等的就是它；这是**正常结束**，不发通知（与 turn-done 同一态度） |
| 退出 ② | 新轮次开始 | 轮次自己就报告 running，不必再替后台任务占位 |
| 退出 ③ | 看门狗超时（默认 **120 s** 无产出）| **必须说出来**：发一条通知（`background-stalled`，info 级，仅当该会话不在屏幕上 —— 与 156 同一条规则）。静默复原正是用户看到的那种"没人告诉我发生了什么" |

**关键取舍**：
- `running` 现在 = `isTurnInFlight(id) || backgroundTasks.has(id)`（`isSessionRunning`），
  所以发送按钮、标签圆点的"正在做事"外圈都跟着它走 —— 客户端**零改动**。
- 超时窗口是**可注入的 ctor 参数**（`backgroundQuietMs`，默认 120 s，比实测看到的最长静默间隔
  57 s 宽裕一倍）；测试把它调到毫秒级。
- 一个诚实的边界：**"任务已启动"这个信号来自 adapter 的 `rawInput`**（本仓库已有先例：074 的
  `_meta.claudeCode.toolName`、153 的 `_askUserQuestionCustomAnswer`）。若某个版本不带这个入参，
  本机制会安静地不生效（不误报）—— 落盘日志里那行 `keeps running outside the turn (a background
  task was launched)` 就是判据：**它没出现 ⇒ 信号没来**，而不是状态机坏了。

### 5.38 切会话 / 新建会话时的「按会话状态」收尾（CUSTOM-20261001-165）

用户报：**新建会话时，输入框右侧的上下文表盘还显示着上一个会话的数字**。顺着这条查了一遍
"客户端按会话存活、却没人负责收尾"的状态，三处问题、一条清单：

| 状态 | 收尾在哪 | 本轮修的是什么 |
|---|---|---|
| 上下文表盘（`--vac-*` 圆环） | `composer.setFocus`（`renderContext(meta.usage)`）**有**；`composer.setDraft` **漏了** | 草稿页没有会话也就没有用量，但没人清 ⇒ 上一条会话的百分比留在那儿（用户截图） |
| 附件 chip | **没人**（宿主只在"变化时"发 `attachments`，客户端切会话时清空自己的列表） | 切走再切回：chip 不见了，而宿主仍持有它们、**发送时照样带上** —— "看不见却会发出去"比少一个 chip 糟得多。现在 `pushFocus` / `pushBoot` 都会补发当前聚焦会话的那一份（`pushAttachments`） |
| 图片放大浮层（lightbox） | **没人** | 浮层里是上一个会话的图，切走还盖着新会话的内容。与 154 那次"切走了浮框还在"同一条规矩：**浮层属于它打开时的那个会话** ⇒ 切会话时 `close()` |
| **置顶条的收缩状态（166）** | 原先是个**模块级布尔** —— 既会串到别的会话，切回来又丢。现在按会话记（`collapsedBySession`），见 §5.25 |
| **表单抽屉的收缩状态（166）** | 同一形状：收起过的表单让**下一张表单**一冒出来就是收起的。现在"哪张被推开了"只由 `dismissed[promptId]` 记，换一张表单就从展开态开始 |

**改动只有一个理由**：凡是"跟着某个会话才有意义"的东西，切换时必须有明确的收尾点。
已有的收尾点（改这块之前先看它们，别再加第二个入口）：

- `boot.applyFocus`（focus 消息）：`outline` / `rail` / `stickyUser` / `sessionMenu` /
  `directoryMenu` / lightbox 按会话重置；
- `transcriptView.reset()` + `syncDrawers()`（两个抽屉是**记录驱动**的，见 §5.35）；
- `composer.setFocus` / `setDraft`：草稿文字（按 id 存）、命令/配置项、**上下文表盘**、附件列表。

**没改的**（看过，不是同一类问题）：tab 栏（`setSessions` 按会话）、连接相位（面板级）、
`imageThumbs`（客户端缓存，重挂载后回退成图标 —— 已在 096 的注释里写明是有意的代价）。

### 5.39 构建指纹与日志桥的滚动窗口（CUSTOM-20261002-173）

**它解决的是"排查时无法判定窗口跑的是哪份代码"**。2026-10-02 排查「表单的选项说明丢了」时，
两边都能证明代码是对的（报文里选项带 `description`；当前客户端确实把它画成灰字第二行），可用户窗口里就是没有。
当时手里只有**间接**证据（宿主 04:08 之后没重启过、客户端代码 12:05 才重新编译），
而"那份 dist 里到底有没有这段渲染"**无从查证** —— 未提交的中间态已经不存在了。
所以这一轮不是去改渲染，而是**让运行时自己报身份**。

**三个上报点（互为对照，缺一不可）**：

| 位置 | 谁写的 | 回答什么 |
|---|---|---|
| `ACP Client extension activating... [build …]` | 宿主 activate（`src/extension.ts`） | **宿主进程**载入的是哪份代码 |
| `<body data-vac-build="…">` | 宿主渲染文档时（`html/body.ts`） | 这份 webview 文档是哪次构建生成的 |
| `chat-panel: client(info): build …` | 客户端 boot 第一条日志（`html/client/boot.ts`） | 这个 webview **实际拿到**的文档带的是哪个指纹 |

指纹形如 `v0.2.0-custom.6·2819d85-dirty·2026-10-02T13:45:07.598Z·9f3e1a2b4c5d(2110432B)`：
版本号（`package.json`）+ git 短 sha（打包时由 `webpack.config.js` 的 DefinePlugin 注入，工作区不干净会带 `-dirty`）
+ 打包时间 + **打包产物 sha256 前 12 位与字节数**。最后一项是唯一真正识别代码的：同一版本编两次只有它不同。
算法与兜底都在 [`src/utils/BuildInfo.ts`](../src/utils/BuildInfo.ts)（**刻意不 import vscode**，
因为无头预览与单测会在裸 node 下 require 它；任何一步失败只退化成 `unknown`，绝不抛）。

**判读规则**：客户端那行与宿主那行一致 ⇒ 跑的是当前构建；客户端是**旧值** ⇒ 窗口是旧的；
**压根没有这两行** ⇒ 这个窗口根本没重载过（改了代码只 `Ctrl+R` 之前先 `npm run compile`，见 `docs/dev-workflow.md`）。

**顺带修掉的真凶：日志桥的配额**。客户端 `console.warn/error` 经 `clientLog` 转发进日志文件，
原先的上限是**每次加载共 50 条**（终身）。实测这 50 条被 `[vac] renderMarkdown asked` 那条诊断
**在 200ms 内一次性烧光**（真机日志里那 50 条全是它），此后任何诊断都进不了日志 ——
于是"日志里没有"被误读成"诊断没执行"，白掉一轮排查。现在：

- 转发配额改成**滚动窗口**（`WINDOW_MS = 10000` / `MAX_PER_WINDOW = 30`）：窗口一滑配额就回来，
  突发噪声挡得住，而长命 webview（用户窗口开一整天）不会被永久静音。
- 噪声源本身限流：那条 markdown 诊断只报**前 3 次 + 每 25 次**一次。

⚠️ 改这两处时注意：客户端代码在模板字符串里（反引号/反斜杠，pitfalls #11），
且**配额是每条 webview 独立的**（计数器在闭包里）——重挂载会重置，这是有意的。

### 5.40 几何变了要重算视口判定（CUSTOM-20261003-176）

**问题**：`pinned`（是否贴底）与 `#jumpToLatest` 的显隐原先**只在 `scroll` 事件里**更新
（`scroll.ts` 的 `onScroll`）。可是让"内容末尾相对视口的位置"改变的原因里，有一大半**不会派发
scroll 事件**：底部留白（输入卡 / 表单抽屉 / 权限抽屉的高度都进 `#messages` 的 padding-bottom）
变化、内容被 markdown 回填撑高、抽屉换题…… 于是视口判定停在旧值：

- 本来贴底的人，抽屉长高后内容被挤到浮层后面 —— 他看到的 Jump 状态却是旧的，滚动条也已经在头，
  表现成"**面板没到底、却滚不动、还盖着内容**"（用户 2026-10-03 报的正是这个）；
- 反向：内容缩到不再需要滚动时，Jump 还挂在屏幕上（明明没得滚了还在提示"回到底部"）。

**修法**（三条，缺一不可）：
1. `scroll.ts` 把 `onScroll` 的判定拆成 `recompute()`，并新增 **`reflowNow()`**：先记下变化前的
   `pinned`，重算，然后**若原来贴底就把视口带到新的底部**（含刚长出来的留白）。这正是"贴着底部"
   该有的语义，也是用户明确要过的（"消息区的触底判断保持在输入框上面"）；上翻看历史的人不受影响。
2. **三个写留白高度的模块**（`composer.ts` / `elicitationView.applyDrawerHeight` /
   `permissionDrawer.ts`）写完 CSS 变量后各喊一声 `NS.scroll.reflowNow()`。
3. **不能只靠 ResizeObserver**（152 的既有教训）：抽屉切题 / 展开 / 收起会改变高度，而它的回调按帧
   投递，所以 `elicitationView.refresh()` 里**显式**再写一次高度（同一条腿走两遍，代价是一次
   `offsetHeight` 读取）。

**怎么验（量，别推 —— pitfall #31）**：`preview-records.mjs` 的
`#elicbottomstuckprobe` / `#elicbottomstuckgrowdrawerprobe` / `#elicbottomstuckpullupgrowdrawerprobe` /
`#elicbottomstucktallgrowprobe` 四档，把"内容 + 表单抽屉 + 输入卡"的几何与滚动状态一起读出来
（`atMax` / `padBottom` / `drawerH` / `coveredByDrawer` / `pinned` / `jumpHidden`）。
⚠️ 预览驱动**默认不接** `scroll.ts`（不调 `NS.scroll.init`），所以档位里显式接了一次 —— 否则
`pinned` / `jumpHidden` 两列恒为初值，读出来是假数据。

**逻辑侧**由 `src/test/chat-client.test.ts` 的三条用例钉住（留白进"内容末尾"的语义、
贴底时 reflow 跟着走、没贴底时绝不抢视口）。

### 5.45 空态地址栏 / Times 的按会话记忆 / 拖拽落点（CUSTOM-20261008-199..201）

**199 空态地址栏**。没有聚焦会话、也没有草稿时（"已连接、还没有会话"是**真实且常见**的一态：连接首次
要 npx 下载适配器，日志里 02:06:05 `no focused session … opening empty panel` 之后 20 多秒才发出
`session/new`），`#cwdBtn` **不再隐藏**（090 的相反决定），显示宿主随 boot 下发的 `defaultCwd`
（`SessionManager.resolveDefaultCwd()`）并且 `disabled`。两件事值得记住：

- **为什么敢显示**：090 反对的是"能点开目录抽屉、抽屉却在讲一个没有会话的面板"。`disabled` 之后
  按钮在**事件层**就点不动，那条顾虑按构造成立；而"地址栏空着"本身是用户看得见的坏相。
- **顺带修掉的是纯布局病**：`.session-title` 是这一行唯一的弹性项（`flex: 1`），它一消失，
  `Times` / `Sub-agents` / `☰` 那一组就整组滑到左边。现在 `#timeToggle` 带 `margin-left: auto`
  兜底 —— 有弹性项时 auto margin 分不到任何空间，所以对原有布局是零变化。
- **同源的后果**：`currentCwd()`（155 的历史默认筛选）在空态也答 `defaultCwd` ——
  "地址栏显示了什么就默认筛什么"这条不变量是 155 建立起来的，不让它在这里断掉。

**200 Times 按会话记**。状态从"webview 本地的一个全局布尔"（`vscode.setState` 的 `showTimes`，
关掉编辑器面板就没了）搬到**宿主 globalState 的 Main 偏好记录**，与主大纲偏好、主 tab 顺序共用**同一条**记录；
Side 后来使用独立记录（见 §5.55）⇒ `setUiPref` 自此有三个写者，合并语义（缺字段 = 这一轮没改它）是硬约束。

- 规则一句话：有效值 = `timesBySession[会话] ?? timesDefault`。拨一次**既**记到当前会话名下、
  **又**把 `timesDefault` 改掉（用户要的"新会话沿用最后一次拨的值"）。
- 草稿页与空态没有会话 id ⇒ 跟随 `timesDefault`；新会话第一次聚焦时同理（它还没有记录）。
- **缺字段 ≠ 设为 false**：只带大纲偏好（或只带 tab 顺序）的消息里 times 两项是 `undefined`，
  那时必须**保留本地值** —— 否则拖一次大纲宽度就把用户开着的 Times 关掉。
- 状态机独立成 `html/client/times.ts`（与 `stateCard` 同类：加载期不碰 DOM，因此能在桩 DOM 里
  单独驱动）。boot 只发三声通知：`init` / `setFocus` / `noteSessions`。**留在 boot 里会重演
  pitfalls #38 的老路**（"模块级布尔 = 全局状态"，而这里的状态是**属于某个会话**的）。
- 写回前按"本面知道的会话"裁表（`pruned`），宿主那侧还有 200 条上限 —— 这张表随用户拨开关增长。
- **迁移只有一次**：本地那个旧的 `showTimes=true` 被播上去一次（本地记 `timesMigrated`）。
  本地值胜出的理由：它是用户真拨过的，而宿主那一份是本次改动才出现的。
- **图标化（2026-10-19）**：`#timeToggle` 不再有文字；`times.init` 用 `NS.icons.icon('history')`
  挂上时钟（图标的唯一来源在 `icons.ts`），tooltip 随开关状态写 `Show/Hide the wall-clock time…`，
  `aria-pressed` 给读屏。`.off` 的透明度仍是唯一的关闭态视觉。
- **切 tab 的感知延时（2026-10-19）**：点击 tab 时 `tabs.activateModel` **先** `setFocus(model.summary)`
  （高亮 + 地址栏在宿主回包前的那次绘制就切过去），再发 `focusSession`；记录区仍要等宿主回包后的
  `hydrate` **同步**重建。真正的耗时在 hydrate（DOM + sanitize + 折叠量测），不是消息往返 ——
  `boot.applyFocus` 会打一行 `[vac] focus: hydrate N entries in Xms` 供真机判断。

**201 拖拽落点**。198 把 `dragover`/`drop` 挂在**每个 `.tab`** 上，而 `.tabs` 是 `flex: 0 0 auto`：
最后一个 tab 右边的空白属于 `.tab-strip`、tab 之间还有 2px 的缝，指针落在这些地方**没有落点**
（松手即复位）；更糟的是**指示线没有 dragleave 清除**，用户看到的正是"线还在那儿、松手却没插进去"。
现在落点容器是**整条 `#tabStrip`**：

- 插入位由**指针横坐标与各 tab 中点**算（`boundaryFor` → 0..n），指示线由同一个数字决定
  （`markBoundary`：中间那位画左线、`n` 画在最后一个的右边）；边界清单 = `data-session-id`
  与 `data-restore-id` 两类 tab（待恢复的也参与排序与落点，2026-11-10）。草稿 tab 没有
  `data-session-id`，指针落在它上面就等于"插到最后一条会话之后"。
- `dragleave` **只清线、不清拖动**（`relatedTarget` 仍在条带内则不动）——
  指示线是"此刻落在哪"的提示，不是拖动本身。
- 落点算不出来（合成事件没有 `clientX`）时**不搬**，也不写盘；搬完原地不动（`moveTo` 判的是
  搬动前后的数组内容）同样不写盘。
- 先落盘再重渲染：渲染若抛错，顺序也已经交上去了（两件事不共享失败点）。
- 三条常驻诊断：`[vac] tabdrag start=…` 与 `drop from=… to=… order=…`（走日志桥落进
  `~/.vac/vac.log`）。真机若仍复位，这两行能直接区分"dragstart 没跑 /
  drop 没到 / 落了但顺序被覆盖"。

**验收**：客户端桩 DOM 新增「Times 开关按会话记忆」6 条 + tab 条带 6 条（末尾空白 / 缝隙 /
草稿 tab / 离开条带 / 无坐标 / 原位不写盘）+ 地址栏 2 条；宿主 `npm test` 新增
`chat panel: Times prefs` 4 条（三个写者互不覆盖、垃圾进不去、200 条上限、boot 的 `defaultCwd` 非空）。
布局用 `preview-records.mjs` 的 `#nosessionheaderprobe` **读数字**：`gapRight == padRight`（Times 贴右缘）、
`cwdDisabled: true`、`cwdText` 是默认目录。**201 的真机拖拽不在自动覆盖范围**（见 `docs/03-验收清单.md` 验收 210）。

### 5.46 回填分帧、滚动诊断不读几何、长任务看门狗（CUSTOM-20261008-202）

**症状**：在草稿页打开一条 581 条记录的历史会话，**loading 期间点标签栏没反应**。

**证据**（`~/.vac/vac.log`，2026-10-08 08:55）：客户端连续 **50 秒**一行日志都没有，
恢复后攒下的 4 条 `markdownRendered` 一次性涌出（12.158–12.168），而 `press@outside` 那一行出现在
恢复后的第一刻（11.249）—— 也就是**那次点击被压后了约 50 秒**。同一时间宿主也是一行没写，但
`session/load` 的响应 08:55:36 就到了 ⇒ 卡的是**客户端**，不是宿主。

**为什么**：那一批回填 139 条，每条都要消毒 + 插 DOM + 读几何（`patch` 收尾的 `follow()` 读
`scrollHeight`、`refreshPreview` 读 `textContent`），而这条会话的转录有 2428 个工具卡、17000px 高 ——
几百次"写一段又读一次几何"交错起来就是几百次**强制整页重排**，合成了一个几十秒的长任务。
长任务期间浏览器会把输入压后、甚至丢掉：症状于是长得像"处理器没接上"。

**修法（两处，都是小改）**：

1. **`scroll.follow()` 在"用户没贴底"那一格里只为诊断读 `scrollHeight`** —— 现在只在**它真会被记下来**
   时才读（`diagAllows`，与日志那套节流/配额同一判据）。这是那个长任务里最值得砍的一半：真机日志里
   `skip-unpinned` / `grew-unpinned` 就是这条链打出来的，流式/回放期间几十次每秒。
2. **回填应用分帧**：`transcriptView.queueMarkdown` 按时间片（每片 ≤ 8ms）落地，剩下的排到下一帧
   ⇒ 单任务不超过一帧。每片只做三个可合帧收尾（`reassert` / `follow` / `stickyUser.schedule`），
   其中 `follow` 让 stream/tool Markdown 撑高后也继续保持 Tail 置底；`rail.reflow()`
   只在整批结束时点一次 —— 逐片点名时那趟全量量测自己就成 50ms+ 的长任务（`#mdsliceprobe` 量到过）。
   一条回填抛错只跳过它自己（**先推游标再干活**），否则它会被每帧重试一次（死循环 + 刷屏）。

**诊断**：新增 `html/client/perf.ts` —— `PerformanceObserver('longtask')`，>300ms 才记一行
（`[vac] longtask NNNNms during=<阶段>`），自己也有 1s 节流（173 的配额规矩）。下次再"点了没反应"，
日志里就有数字，不必再靠"日志突然断了"反推。

**验收**：桩 DOM 5 条（顺序 / 跨批 / 坏条不拖累 / 不贴底不读几何 / 看门狗安装与阈值）+ 真 Chromium 的
`#mdsliceprobe` 档（同一条 DOM 上"整批一次"与"分帧"对照）。
⚠️ **探针复现不出真机那 50 秒**：合成条目（300×5KB）整批只花 ~20ms、分帧反而 ~165ms（多出来的帧各自
要重排），而真机是 **~360ms/条**（50s/139）—— 差两个数量级。所以它只能说明"分帧之后一个批次绝不落在
单个任务里"，**不能**证明真机修好；真机判据是下一次的 `longtask` 日志行（`docs/03-验收清单.md` 验收 211）。

**2026-10-21 补充（用户再次报"滚动条触底、底部内容被输入卡盖住"）**：当天日志（`~/.vac/vac.log`）
里 242 条 `scroll#` 全部自洽，四个病灶标记（`clamped-short` / `follow-fell-short` /
`tail-covered-heal` / `atmax 且 pin=0`）一次都没出现——但同一时刻有 **`sup=20/21`**，说明关键采样被
各自 12 条/10s 与日志桥 30 条/10s 的配额吞了。所以加了三条定向采样，读法：

- **`cov=1` / `gap=N`**：`cov` = 已在滚动范围末尾（`st >= max-32`）且末条记录底边 **压在输入卡顶边之下**；
  `gap` = 末条底边 − 卡片顶边（负数 = 卡片上方，健康）。`cov=1` 可直接定案；但 `cov=0` 不能排除
  “内容长高后停在上方、尚未 atMax”的遮挡，还要结合 `last/comp` 与 `pin/tail/dist` 读。
- **`wheel dy=N`**：滚轮事件的下一帧采样一次。用来区分"他滚了一格"与"位置根本没动"（后者是手势没落到
  `#messages` 上，见同一文件的 `press@messages-bar`）。
- **`heal-skip:<原因>`**：自愈没出手的理由（`unpinned` / `no-tail` / `not-atmax` / `no-api` /
  `no-composer` / `no-rect` / `composer-hidden` / `var-ok` / `clear`），只在理由变化时记一行。
  下次"没有 tail-covered-heal"就能读出是被哪道门槛挡住了，而不是"没发生"。

### 5.52 设置面板与「新输出自动展开」（2026-10-21）

**为什么有它**：面板里散落的开关（自动连接、Times、大纲、协议日志）各自藏在不同控件/VS Code Settings 里，
用户要求一个集中的设置入口；同时新增「新输出自动展开」，它的卡片类型需要一个可勾选的地方。

**结构**：`body.ts` 的 `#settingsOverlay > #settingsPanel`（遮罩 + 居中面板），左侧 `#settingsNav`
（role=tablist）右侧 `#settingsBody`；`settingsPanel.ts` 只渲染，宿主是唯一写者。
Tab 栏：`#settingsBtn` 用 `margin-left: auto` 固定在条带最右；`#newTab` 紧跟在最后一个 tab 右侧
（`.tabs` 先按内容宽，tab 多到放不下才自己横向滚动）。

| 关注点 | 规则 |
|---|---|
| 数据与写入 | `ChatPanelHost.settingsItems()` 生成 `SettingItem[]`；`handleSetSetting(key,value)` 按 key 决定写 **VS Code 配置**（`vac.autoConnectOnOpen` / `restoreSessionsOnOpen` / `defaultWorkingDirectory` / `autoApprovePermissions` / `logTraffic` / `customModels` / `agents`）还是 **面板 UiPrefs**（`panel.autoExpandDefault` / `panel.autoExpandKinds.*` / `panel.autoExpand.toolHeight` / `panel.autoExpand.thoughtHeight` / `panel.flatTools` / `panel.sendKey` / `panel.composerMaxWidth` / `panel.inputMaxHeight` / `panel.defaultModel.<agent>` / `panel.defaultEffort.<agent>` / `panel.recentDirectoryLimit` / `panel.markdownStyle` / `panel.timesDefault` / `panel.outlineMode` / `panel.outlineWidth`）；`handleSettingAction` 处理 `pickDefaultWorkingDirectory`（系统 `showOpenDialog`）/ `openAgentCache` / `clearAgentCache`（`rmSync`，Linux/Windows 上运行中的模块可能被锁）/ `resetPanelPrefs` / `openLog` / `copyBuildInfo`。写完**重发整张表**，被夹紧的值（宽度 160–480、展开高度 0 或 80–2000、输入卡 360–1200 / 80–800）会回显真实值。 |
| 默认模型 / 默认推理强度 | `UiPrefs.defaultModelByAgent` / `defaultEffortByAgent`（agent → 值）。`session-created('new')` 时 `applyRememberedModel` 与记住的模式并行应用，按会话挂在 `modelApply` 上；`applyRememberedEffort` 排在模型之后（模型切换可能级联出新的 effort 候选），挂在 `effortApply` 上。草稿页的显式选择先 `await` 这三者再落地（后到的赢）。打开历史会话不套用。`defaultAgentItems` 对每个 agent 各给两行：有候选就渲染下拉（来自 `draftOptions` 快照），没候选退化成文本输入。推理强度按 ACP 的 `category === 'thought_level'` 识别（Claude 的 Effort、Codex 的 reasoning_effort 同一类目），应用前逐项校验。 |
| Recently used 目录条数 | `UiPrefs.recentDirectoryLimit`（0–30，默认 8；**0 = 不显示「Recently used」分组**，设置面板清空输入框回落 8）。`ChatPanelHost.recentLimit()` 是唯一读取口，`recentDirectories()` 按它截断（0 时直接返回，不问 agent）；`setUiPref` 合并、`settingsItems()` 回显与 `handleSetSetting` 写入都经 `ChatPanelHost.clampRecentDirectories` 夹紧。改动在下一次打开目录抽屉时生效（`directoryChoices` 是即时计算的）。 |
| 历史显示上限 | `UiPrefs.historyDisplayLimit`（0–10000，0=不限）由 `ChatPanelHost.clampHistoryDisplayLimit` 夹紧，Main/Side 共享；`boot` → `sessionMenu.applyPrefs` 在抽屉非加载态即时刷新；`visibleRows` 先目录/搜索过滤，`limitRows` 再截显示，保留已加载数据与正确计数。 |
| Markdown 渲染预设 | `UiPrefs.markdownStyle`（`editor` / `github` / `obsidian` / `typora` / `atom` / `minimal` / `things`，默认 `editor`）。宿主 `resolveMarkdownStyle` 是白名单（旧值 `compact` / `reading` 回落 `editor`）；该全局字段变化时 `uiPrefs` 分别投影到 Main 双面与 Side，`boot.applyMarkdownStyle` 只写 `body[data-md-style]`，具体排版与配色在 `styles.ts` 里按属性选择器覆盖：每套预设各定义一组 `--vac-md-*` 变量（`vscode-light` / `vscode-dark` 下取硬值，其余主题回落 token），规则统一作用于 `.md`。`editor` 不写任何覆盖 = 原有跟随主题的行为。 |
| 发送快捷键 / 输入卡尺寸 | `UiPrefs.sendKey` 由 `composer.applyUiPrefs` 消费（`onKeyDown` 决定 Enter 是否发送；另一种组合留给 textarea 换行）；`composerMaxWidth` / `inputMaxHeight` 写 body 的 `--vac-composer-max` / `--vac-input-max-h`。`flatTools` 同时由标题栏的 Sub-agents 按钮写（两个写者都落到同一份 UiPrefs）。 |
| 面板尺寸 | **固定**：`height: clamp(320px, 80vh, 640px)` + `max-height: calc(100vh - 32px)`，切换分组/改值不跳动；内容在 `#settingsBody` 内滚动。窄面板（<520px）左侧导航变成顶部横排。 |
| 协议 | `getSettings` → `settings`（ExtToChat）；`setSetting` / `settingAction`（ChatToExt）。三者都在 `verifySession` 守卫**之前**处理（非会话作用域）。 |
| 双向同步 | `onDidChangeConfiguration` 里 `affectsConfiguration('vac')` → `postSettings()`；面板 scoped 偏好经 `projectUiPrefs` 定向投影（主双面同域，Side 独立），真正全局字段变化才三面同步，见 §5.55。 |
| 分组 | general / chat / appearance / shortcuts / advanced；**没有条目的分组不显示**（客户端 `groupsWithItems`）。窄面板（<520px）左侧导航自动变成顶部横排。 |
| Chat 快捷键 | `shortcuts.ts` 的 `DEFAULT_SHORTCUTS` / `canonicalizeShortcut` / `normalizeShortcutMap` / `applyShortcutSetting` 是宿主规则；`ChatPanelHost.handleShortcutSetting` 逐项写入并拒绝重复，`UiPrefs.shortcuts` 是共享字段，经 `projectUiPrefs` / `postUiPrefs` 投影三面。客户端 `settingsPanel.ts` 的 `renderShortcutControl` / `onRecordingKeyDown` 负责录制、禁用、重置及冲突提示；`client/shortcuts.ts` 的 `fromEvent` / `onKeyDown` 只消费本 webview 按键（IME/AltGr/死键与浮层优先、匹配后停止冒泡给宿主），`tabs.activateRelative` 按显示顺序切换并给懒恢复加单飞闸门；宿主按 `trackRestore` 向发起面回 `restoreFinished` 成败，`boot` → `tabs.finishRestore` 解除闸门。`scroll.jumpToTop` / `jumpToLatest` 复用 Tail 与滚动状态机。键位用物理 code，跨布局和系统快捷键可能冲突。**2026-11-08**：新增 `closeSession`（默认 `Alt+KeyW`，`tabs.closeActive` → 既有 `closeModel`，草稿丢弃 / 待恢复遗忘 / 运行中确认全部继承）；**2026-11-09**：新增 `restoreClosed`（默认 `Alt+KeyT`，客户端只发面板级 `restoreLastClosed`；宿主 `recentlyClosed` 栈在 `closeSession` **关闭之前**从活会话取描述符（side chat 不入栈、同 id 去重、上限 20），还原走 `handleOpenHistorySession(..., keepOthers)` 并写回 `additionalDirectories`，空栈时回一条 error）；`fromEvent` 在字母 code 上比较 `event.key` 与物理字母，若不一致（macOS Option 产出 å / π 等真实字符）就不匹配，避免默认 Alt 快捷键吞掉输入 |
| tab 条横向滚轮（2026-11-08） | `tabs.installWheel`（挂在 `#tabStrip`）：纯纵向 `wheel` 转成内层 `#tabs.scrollLeft`，`deltaMode` 按行 16px / 页 clientWidth 归一；横向触控板手势（`deltaX`）、Shift/Ctrl/Meta 组合、无溢出或已到边界都**不 preventDefault**（与 `scroll.ts` 的滚轮门控同一取舍）。#tabStrip 自己仍是 `overflow: hidden`（+ / 设置按钮固定右侧），真正的滚动容器是 `.tabs` |
| 自动展开的范围 | 有效值 = `autoExpandBySession[sessionId] ?? autoExpandDefault`（与 Times 同一条"按会话 + 默认值"模型）。卡片类型是**全局** `autoExpandKinds`（`tool` / `thought` / `diff`），默认 `thought + tool`；写过空数组才是"全不展开"（类型在 Chat 分组）。**展开后的限高**在 Appearance 分组：`autoExpandToolHeight`（默认 360）/ `autoExpandThoughtHeight`（默认 240），0 = 不限，夹在 80–2000；只作用于自动展开时打了 `.auto-expanded` 的卡（手动点开的不受限），超出部分在卡片内部滚动。 |
| 长编辑器（子面板） | `vac.customModels`（`type:'models'`）与 `vac.agents`（`type:'json'`）在主面板只显示摘要 + `Edit…`（摘要放文字列，按钮与其它控件右缘对齐）；点击打开 `#settingsSubOverlay` 子面板。自定义模型：说明行 + 表头（Model id / Alias / Description）+ 可滚动列表，Add model 靠右紧跟列表、Done 靠右下；Agent JSON：文本框铺满剩余高度，Cancel 在左、Save 在右。模型改动即时提交（每个 input 的 change），JSON 是 Save/Cancel（Save 先本地 `JSON.parse`，非法就在子面板里报错、不发送）。Esc 先收子面板、再收主面板。 |
| 模型排序与并发 | `settingsPanel.modelRow/installModelDrag/moveModelRow/queueModelCommit` 沿 DOM 顺序采集；拖拽手柄、上下按钮、落点线和 live 播报共用一条提交链。`setModelList` 请求经 `ChatPanelHost.handleSetModelList` 和 `SerialTaskQueue` 按生效层+写目标+值做 CAS、写后核对，回 `SettingItem.modelSync`；冲突保留草稿供 Reload / Overwrite（重新校验），错误可 Retry / 确认 Discard。`composer.renderMenu` 用 `modelOrder.orderOption` 仅重排 agent 已有模型，每组内按自定义顺序，其他候选稳定。进程内串行不是跨 IDE 原子锁。 |
| 自定义模型的 description | 存进 `vac.customModels` 后，`composer.menuItem` 用它作为模型菜单项的**副标题 + 悬停 tooltip**（`name` 覆盖 agent 返回的裸 id 标签）。此前只存不用。 |
| 自动展开的作用面 | **只作用于 live 路径**（`transcriptView.append` / `patch` / `updateTool`）；`hydrate`（历史回放）刻意不展开 —— 大会话整屏展开既卡又抢滚动位置。展开后 `append` 的 `scroll.follow()` 按最终高度贴底；`patch` 里推理块定稿的"自动折叠"在勾了 `thought` 时不生效。 |
| 运行中会话的关闭确认 | 宿主 `closeSessionWithConfirm`：`isSessionRunning` 为真时 `showWarningMessage(..., {modal:true}, 'Close')`；确认后仍走 `SessionManager.closeSession`（内部先 `cancelTurn` 并回答待决请求）。× / Delete / 右键 / 中键四条入口共用。 |
| 中键关闭 | `tabs.ts` 每个 tab 的 `mousedown`（button==1 → `preventDefault`，压住 WebView 的自动滚动）与 `auxclick`（button==1 → `closeModel`）。中键回调直接闭包捕获 model；`modelIndexOf` 同时识别 live、draft、restore，供 tab 方向键和 Delete 使用。 |

### 5.53 内层滚动卡片的焦点门控与自动追尾（2026-10-28）

**症状**：在消息面板里用滚轮滚动时，指针一进到带滚动条的卡片（`.diff-body` / `.tool-seg-out` /
`.thought-body` / 自动展开的 `.tool-body`）上，滚动就被卡片接管——整块面板的滚动被打断。

**为什么**：这是嵌套滚动容器的默认行为，纯 CSS 修不了（`overscroll-behavior: contain` 只会让面板
**更**接不上）。所以把"谁吃滚轮"做成显式的两个状态，逻辑全在 `html/client/scroll.ts`（`init` 里注册）：

| 机制 | 规则 |
|---|---|
| 聚焦（`setActive` / `activeScroller` / `activeCard` / `reclaimActive`） | `pointerdown`（document，capture）**只认左键**（`button === 0`；合成事件缺 `button` 时按左键）落在卡片上 ⇒ 该卡片**离落点最近**的纵向滚动容器（落点在标题栏这类"不在滚动区里"的地方时取卡片里第一个**卡片自己的**纵向滚动区；正文内嵌的 `.mermaid-chart` 不参与这个兜底——只有点中图表本身才聚焦图表）拿到 `.scroll-active`。**再次左键原地点击同一张卡片**（未拖动 >4px、未框选文本、没点在按钮/链接/折叠头/文件 chip 等交互控件上）⇒ `setActive(null)` 取消聚焦。右键（上下文菜单）与中键（自动滚动）都不改变焦点。`pressLabel` 用事件 `offsetX/offsetY` 与目标 client 几何识别原生横条/纵条，两类滚动条均不参与聚焦或二次点击取消；只有 `#messages` 自身滚动条进入面板拖条路径。点面板空白 / 输入卡 / 标签栏即交还。切会话（`restore`）也交还。内层重建后 `reclaimActive` 找同卡接替者，没有则清焦点，不能留下半失效状态。 |
| 滚轮门控（document `wheel`，`capture` + `passive:false`） | 按**指针位置**分流：已聚焦卡片只滚有效 `activeScroller`，到边界就停、面板不动（`scrollInner` 夹紧，不交余量）；未聚焦卡片只要有纵向 `deltaY`，无论是否命中内层或原生横条，都 `preventDefault` + `writeTop(面板 + delta)` 并取消 Tail，不能因 `!scroller` 早退。离开卡片、Ctrl/Cmd+wheel、纯横向与 Shift+wheel 保持原生；`cancelable=false` 不做补偿滚动。斜向输入由 `wheelDelta` 归一化双轴后按轴处理：纵向走焦点规则，横向经 `nearestHorizScroller` 写最近容器 `scrollLeft`。纵向候选只认 `INNER_SCROLL_SELECTOR`（`.thought-body` / `.tool-body` / `.tool-seg-out` / `.diff-body` / `.elic-preview`）；横向识别独立使用 `overflowX` + 真实横向溢出，不把 pre/table 混入纵向白名单。`isVertScrollable` 用标准 `overflowY` + `scrollHeight > clientHeight + 1`，不再扣横条高度而漏掉小幅真实纵向溢出。 |
| 一张卡一条滚动条 | 自动展开时外层 `.tool-body` 是视口，里层 `.tool-seg-out`（510）/`.diff-body`（340）**不再各自限高**；`styles.ts` 同时覆盖自动展开的直接 `.diff-body` 与 `.tool-seg-out` 内嵌 diff，均设 `max-height:none`，保留横向 `overflow:auto`。不这么做就是"滚动条套滚动条"。 |
| 中键原生自动滚动（`guardMiddleAutoScroll` / `restoreMiddleGuard`） | Chromium autoscroll 由浏览器内部驱动，**不反复派发 `wheel`**，会绕过门控直接选中内层。未聚焦卡片在 `pointerdown(button===1)` 时收集落点到 `#messages` 间的**全部**有效纵向白名单与真实横向候选，暂存各节点 inline overflow 并统一设为 **`overflow:clip`**（`hidden` 仍是滚动候选），不取消默认动作，让原生滚动落到面板；已聚焦卡片跳过。保护持续到下一次按下，并在 `pointercancel` / Escape / blur / 页面隐藏时逐一精确恢复；下一次左键先恢复再聚焦。不能下一 macrotask 就恢复，否则 Chromium 可能尚未完成 autoscroll 启动。 |
| 自动追尾（`flushTails`） | `MutationObserver`（`childList`+`characterData`，subtree）回调**只记**变化点与新增节点（`mutatedNodes` / `addedLists`，不读布局）；祖先链展开、`isVertScrollable`、新增子树扫描都在 `flushTails` → `collectTailCandidates` 里、推迟到 `NS.dom.schedule` 那一帧，并先按 `isLiveCard` 过滤卡片。一个容器要同时满足：仍纵向可滚 / `innerPinned` 不是 false（用户没在里面往上滚过）/ 所属卡片 `isLiveCard`（`.thought-spin`、`.tool-status.tc-in_progress`、`.subagent-state[data-state="running"]`）才跟到 `scrollHeight`。 |
| 样式 | `.messages .scroll-active { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }` —— 用 outline 不用 border，聚焦瞬间不产生 1px 布局位移。 |

**三条不变量**（破了不会有任何自动检查报错）：

1. **聚焦卡片内滚动时面板绝不跟着动**。`scrollInner` 只写内层容器、自己夹紧；把余量交给面板那版
   已经被用户否掉（"卡片内和消息面板一起滚动"）。
2. **只追"还在流式"的卡片**。历史回放 / 已完成的卡片如果也追，一打开旧会话，每个长输出卡都会停在
   自己的**末尾**而不是开头（用户要看的是命令输出的第一行）。
3. **用户在容器里往上滚过就不再追**（`innerPinned`）。工具卡的 body 每个输出 chunk 都会重建
   （`toolCallView.fillToolBody`），新容器没有历史，因此它默认"贴底"——重建后重新跟到最后一行正是
   期望行为；而 `.thought-body` 这类身份稳定的容器靠 `scroll` 事件记住用户的取舍。

**诊断**：`focus:<容器类>`（聚焦变化，强制记）、`wheel-card:<容器类>` / `wheel-gate:<容器类>`
（只在**换了卡片**时记一条，避免每 700ms 一条把日志桥的共享配额吃光，见 §5.46 的配额规矩）。

**验收**：`src/test/chat-client.test.ts` 的 scroll 桩套件覆盖无纵向内层、横向-only、小幅纵横溢出、双轴输入、失效焦点、完整中键候选链与滚动条焦点隔离；当前完整宿主 **650 passing**。`node scripts/preview-records.mjs --wheel-scroll-probe` 用 CDP 真实坐标输入覆盖十档 wheel、原生横条点击和直接/嵌套 diff 几何；`--middle-scroll-probe` 覆盖未聚焦、聚焦、普通区域、横向-only、横向工具与纵向嵌横向六档。两者都检查实际滚动位置、Tail、样式恢复与 pageerror；合成 `PointerEvent` 不会触发原生 autoscroll，不能替代。真机验收见 `docs/03-验收清单.md` 246–249、256。

### 5.54 Tail（消息面板自动追尾）与会话级开关的「落定」（2026-10-28）

**为什么要它**：用户要一个"一直跟到最后一条"的显式开关；并且明确要求 **Tail / Times / 自动展开 /
Outline 都是会话级**——在一个会话里拨它只影响这个会话，只有**下一个新开的会话**继承新值。

**状态**：`client/tail.ts`（新模块，与 `times.ts` 完全同形）：

| 项 | 规则 |
|---|---|
| 数据 | `UiPrefs.tailBySession`（会话 → 布尔）+ `tailDefault`。宿主按 Main/Side 分域存 `globalState`，主 view/editor 同一份，Side 独立。**默认 `tailDefault` = true** —— 不开按钮时也照旧"贴底跟随"，那是改动前就有的行为，按钮只是把它显式化。 |
| 运行时 | `scroll.ts` 的 `tail` 旗标：`setTail(on, immediate)`；`follow()` 只看 **`tail`**，`reflow()` 以 **`pinned || tail`** 决定是否保持底部。**Tail 关掉 ⇒ follow 绝不自动滚**（"别动我的视口"），开着时持续跟到底，不被布局滚动留下的 `pinned=false` 锁死。`pinned` 仍如实反映几何上的"贴底"，Tail **不许伪造它**（Jump、探针都读它）。`immediate` 只在**用户点按钮**时为真（换会话由 `restore` 决定落点）。 |
| 退出路径 | ① **真实用户滚动**改变了阅读进度 → `cancelTail('scroll')`。判据不是“非程序写入”本身（浏览器 scroll anchoring / 内容折叠后的夹紧 / 布局重排也会改 scrollTop），而是**用户意图 + 实际位移**：wheel（document 门控）、拖 `#messages` 滚动条（pointerdown 记 `barStartTop`，scrollTop 位移 >1 才算）、中键自动滚动（button 1 记 `middleStartTop`，位移 >1 才算）、键盘翻页（PageUp/PageDown/Home/End/方向键），窗口 800ms；仅按下滚动条/中键但没有位移**不取消**。② 大纲跳到某条记录（`jumpTo`）；③ 切会话恢复到用户自己选的中间位置（`restore`，静默清手势）。都只改这个会话那一条记录，不动默认值。 |
| 手势闸门（2026-11-05） | `gestureHeld() = barDragging || middleScrolling`。手势期间 `follow()` 的 rAF、`reflow()`、`reassert()/settleAnchor()` 都不写 `scrollTop`；`healIfTailCovered` 跳过；`writeTop` 在手势中 re-baseline 起点。松手时 `settleGesture()` 先按真实位移结算（有位移则取消 Tail）再清状态，避免旧起点污染后续 follow/Jump。原生 scroll 事件在无手势时仍同步 `recompute()`，手势时改为 rAF 合并，减少慢速拖条的强制重排。 |
| 滚轮门控与 Tail | 指针在**未聚焦**卡片的内层滚动区时，门控用 `writeTop(panel + delta)` 滚面板；它走的是程序写入口，所以该分支**显式** `cancelTail('scroll')`。滚**已聚焦**卡片的内部不关 Tail（面板没动，滚轮意图撤回）。 |
| Markdown 异步回填 | `transcriptView.afterMarkdownSlice` 在 `reassert()` 后调一次 `follow()`，覆盖 stream / tool key / 普通 patch 三条路径；普通 patch 的重复通知由现有 rAF 合帧。恢复中间阅读位置已取消 Tail，所以不会与 `reassert()` 抢视口。 |
| 异步长高的根本保证（2026-11-09） | `follow()` 只覆盖"写入者主动喊"的长高；markdown 分片回填、图片解码、Mermaid、字体替换、`<details>` 动画都可能落在那一帧**之后**，于是视口停在半空直到下一条消息。现由 `scroll.ts` 的 `recordObserver`（`ResizeObserver`，观察 `#messages` 直系记录节点，新增/移除由既有 `MutationObserver` 同步 `observe`/`unobserve`）在**布局之后、绘制之前**把 `scrollTop` 压回 `scrollHeight - clientHeight`：只在 `tail && !gestureHeld() && restoreTarget === null && 尚未到底` 时写，已在底部或 Tail 关闭时什么都不做。尾部留白（输入卡/抽屉）仍由 `reflowNow` 链路负责。CSS 侧 `body[data-tail="on"] .messages { overflow-anchor: none; }` 关掉浏览器滚动锚定，避免第三方改 `scrollTop` 与贴底写入互相拉扯。 |
| Tail 关闭时的 Jump | `follow()` 在 `!tail` 时每帧最多调度一次 `recompute()`（只读几何、更新 pinned/Jump，**不写 scrollTop**）。没有它，Tail 关闭后内容长高但无 scroll 事件，Jump 会一直不出现（真机日志出现过 `pin=1 dist=13327`）。 |
| Jump 恢复追尾 | Jump click 先调 `tail.resumeFromJump()`：只把**当前会话**的 Tail 恢复为开并 `apply(false)`，不改 `tailDefault`，已开时不重复写偏好；随后由 Jump handler 走唯一一次同步 `writeTop(scrollHeight)`。不能用 Tail 按钮的 `apply(true)`，否则会重复置底。程序 scroll 不取消刚恢复的 Tail，后续 `follow()` 继续跟随。 |
| 快捷键首尾跳转 | `jumpToLatest()` 同时供 Jump 按钮与快捷键使用；`jumpToTop()` 清恢复目标与锚点、取消当前会话 Tail，经 `writeTop(0)` / `recompute()` 落顶；`bottomFrameEpoch` 防止已排队 follow 帧把视口抢回。 |
| 无会话焦点 | `focusDraft()` 与关闭聚焦会话的 `sessionClosed` 分支绕过 `applyFocus()`，因此在 `currentSessionId=null` 后都必须显式 `tail.setFocus(null)`；否则按钮仍显示并改写旧会话。 |
| 启动偏好顺序 | `ChatPanelHost.pushBoot()` 对目标 surface 先发已有 `uiPrefs`、再发 `boot`。`boot → applyFocus → scroll.restore()` 恢复到中间位置会立即取消 Tail 并写回；偏好必须先到，否则会用未 hydrate 的整表覆盖其他会话记录。 |
| 诊断 | `scroll#` 行带 `tail=0|1`；`setTail` / `cancelTail` 真正翻转时强制记 `tail:on` / `tail:off <scroll|restore>`；scroll 来源分 `user-scroll` / `layout-scroll` / `scroll-after-program`。 |
| 视觉提示（2026-11-05） | `tail.apply()` 同时写 `body[data-tail="on|off"]`。CSS 在 `.messages-column` 上画左右两个 L 形角（`::before` / `::after`，约 28×16、2px 边框、竖臂 mask 向上渐隐），中间由 `.tail-fade` 提供一层全宽淡渐隐（不画实线）；`bottom` 跟随 `--vac-composer-h/--vac-elic-h/--vac-perm-h`，`pointer-events:none`，不占布局；`data-composer="off"` 与 disconnected/connecting 相位下不显示。`scroll.recompute()` 另写 `body[data-messages-scroll="on|off"]`（`scrollHeight > clientHeight + 1`），**消息区没有滚动条时角标与渐隐都不显示**；同时写 `--vac-scrollbar-w`（`offsetWidth - clientWidth`），右侧角标/渐隐用 `right: calc(var(--vac-scrollbar-w,0px) + 2px)` 让出滚动条。`.jump-latest` 显式 `z-index:7`，避免窄面板下角压住 Jump。 |

**「落定」（`seedKnown`，四个模块同一件事）**：光有"按会话 + 默认值"还不够 —— 一个没有记录的
**已开启**会话会跟着默认值走，于是"A 里拨开关，切到 B 发现它也变了"。所以 `noteSessions`（boot 在
`boot` / `sessionsChanged` 处喂**打开的会话**）与 `applyPrefs` 之后，给每个还没有记录的会话补一条
"此刻的有效值"。之后默认值怎么变都与它们无关，只有真正**新开**的会话才继承。顺序约束：
宿主偏好到之前（`prefsSeen` 为假）不落定，否则会用本地默认值把用户的真实选择钉死。

**图标**：Tail = `icons.tail`（两颗**同向**的下尖角 = 一直跟到最后一行）；自动展开 = `icons.expand`
（两颗**朝外**的尖角 = 卡片被撑开）。2026-10-28 用户要求两者对调：原先 Tail 是"箭头 + 底线"、
自动展开是双下尖角，读起来后者更像 Tail。

**「Recently used」的删除**：列表是从会话条目**派生**的（`SessionHistoryStore.recentDirectories` +
agent 的 `session/list`），删不掉源数据 ⇒ `SessionHistoryStore` 用**独立 key**
`vac.recentCwdDismissed.v1` 记一份"不想再看到"的路径集合，`ChatPanelHost.recentDirectories` 在合并
两个来源时统一过滤；同一目录再新建会话即自动恢复（`upsertNew` 里 `undismiss`）。客户端点完立刻
把行拿掉（不等往返），再发 `removeRecentDirectory` 让宿主持久化并回一份新候选。

**验收**：桩 DOM 覆盖 Tail 开关、真实/布局滚动、布局滚动后的 `follow/reflowNow`、Jump，以及 stream/tool Markdown 时间片的跟随接线。
真 Chromium `#elictailfollowprobe` 同时摆出 composer 与表单抽屉：先形成 `Tail=true / pinned=false`，再只让末条 stream Markdown 长高；
通过判据是 Tail 仍开、`atMax=true` 且末条底边不超过最高可见遮挡层顶边（1px 容差），不能只看滚动条。真机见 `docs/03-验收清单.md`。

### 5.55 Main/Side 偏好分域与重复投影收敛（2026-11-04）

**根因**：Side 加入后仍沿用主双面时代的单份 `UiPrefs`、全 surface 广播和 `*BySession` 整表替换；
客户端又只上传本面认识的 session，Main/Side 因而互删记录并用对方默认值补写。不能只把两张 map 做 union：
四个 default 与大纲布局也必须分域，而主 view/editor 仍须共享。

| 关注点 | 当前契约 |
|---|---|
| 存储 | `vac.outlinePrefs.v1` 保留 Main scoped + 全局字段 + 主 `tabOrder`，旧数据自然归 Main；`vac.sideUiPrefs.v1` 只保存 Side scoped，不含全局字段或主 tab 顺序。 |
| scoped 字段 | `times/tail/outlineOpen/autoExpand` 四组 `BySession/Default`，加 `outlineMode/outlineWidth` 与 `outlineTab`。Main 与 Side 各自持有；`tabOrder` 仅 Main。 |
| 全局字段 | `autoExpandKinds`、展开限高、`flatTools`、输入卡尺寸、`sendKey`、Markdown、最近目录条数、每 agent 默认 model/effort 等继续共享。 |
| 写入与投影 | `setUiPref/patchUiPrefs` 按可信消息来源 `from` 选择 `main|side`，统一进入 `commitUiPrefs()`；`projectUiPrefs()` 按白名单组装目标 scope，`postUiPrefs()` 对 Main scoped 只发 view/editor，对 Side scoped 只发 side，全局变化则分别向三面发送各自投影。数组/Record 按值比较，完全无变化不写盘、不广播；`autoExpand.persist()` 携带相同 `autoExpandKinds` 不算全局变化。 |
| 启动与默认值 | `pushBoot()` 先发送目标 surface 的 `uiPrefs` 再发 `boot`。没有 Side key 时使用 Side 内置 defaults/layout 和空 session map，不复制 Main scoped，但仍投影共享字段。 |
| 客户端收敛 | `times/tail/autoExpand/outline.applyPrefs()` 以本模块消费的原始字段生成 `lastPrefsKey`；完全相同的重复投影在 `seedKnown()` 前直接返回。autoExpand 签名还包含全局 kinds 与限高，保证真全局变化仍生效。否则旧空投影每次整表替换后都会再次 `seedKnown()`，形成持续回写。 |
| 生命周期 | `releaseSideSession()` 只清 Side scope 的目标 session，保留兄弟 Side、Side defaults/layout、Main key 与主 `tabOrder`。Extension Host 启动时清 Side 遗留四张 per-session map，避免异常重载复活孤儿状态，但保留 Side defaults/layout；不恢复 Side 会话。 |
| Reset | `resetPanelPrefs` 同时恢复 Main、Side scoped 与全部共享字段的显式完整默认值（含 `outlineTab: 'messages'`），更新两个 Memento key，并分别向三面发送完整投影；不能只清局部字段或让客户端保留旧值。 |
