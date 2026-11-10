# Chat 面板 · 输入侧与交互抽屉（输入卡 / 草稿 / 表单与权限抽屉 / steering）（续 2）

> 接上篇：[chat-panel-input.md](chat-panel-input.md)

### 5.36 记住用户选过的模式（CUSTOM-20261001-159/160）

用户要求："记住我的模式选择，下次打开新会话时默认使用此模式（比如这个会话我改成了 bypass）"。

| 关注点 | 规则 |
|---|---|
| 按 agent 记 | `vac.lastMode.v1`（globalState，`Record<agentName, {configId, value}>`）。模式是各 agent 自己的词表，按会话记等于没记（新建会话正是要跨会话）；globalState 而不是内存：重载窗口后"又回到默认模式"正是要消灭的现象 |
| 记什么 | 权威的**那一份**：`configOptions` 里 `category === 'mode'` 的 `currentValue`（128 的教训：`modes.currentModeId` 只是镜像）。`modeOptionOf()` 是唯一的判据出处（三处问它：picker、记、应用） |
| **在哪记** | 只记**用户动作**：`setConfigOption`（且 configId 就是那个 mode option）、`setMode`、以及草稿页 `applyDraftSelections` 里成功应用的模式项。**agent 自己切的模式不记**（plan mode 自动激活不是偏好），否则"默认值"会悄悄跟着上一个会话的际遇走 |
| 在哪应用 | `session-created` 的**第三参 `origin`**（`'new' | 'load' | 'resume' | 'side'`，按"仅追加尾参"的契约加的）。**只对 `'new'` 应用**：打开历史/恢复的会话有自己的模式；Side 继承 fork 时的上下文与 UI 元数据，不套用主会话默认配置或恢复行为。`origin === undefined`（老调用方、测试直接 emit）按**非新建**处理 —— 宁可不动 |
| 三道闸门 | 与草稿选择逐条相同：新会话仍提供该 id 且 `category === 'mode'` / 值仍在候选里（`selectValues`）/ 与当前值相同则跳过。**失败只记日志、不写记录区**：默认值不是用户的请求，为它报错是噪声（草稿选择则相反：那是用户显式做的事） |
| 不播报 | 应用后播种 switch 基线（`choices.set(sessionId, choiceState(...))`），否则 agent 随后的通知会被当成一次用户从未做过的切换播报（073/151 那套机制） |
| 与草稿页的顺序 | 草稿页的显式选择必须**后**落地：两个都是同一条连接上的 `setConfigOption`，后到的赢。`session-created` 启动的那次应用挂在 `modeApply` 上，`handleCreateDraftAndSend` 先 `await awaitModeApply(sessionId)` 再应用用户选的值 |
| 草稿页显示它（160） | `handleListDraftOptions` 用 `withRememberedMode()` 把记住的值 overlay 到快照的那一项上——"你不改的话就会建成这样"。**只改这一份拷贝**：`draftOptions` 里那份是 agent 的真实状态，不能被偏好改写 |

### 5.42 回车只发送、绝不停止（CUSTOM-20261004-182）

**现象**：用户报「输入框消息发出之后，再按一次 Enter 会触发停止」。
**根因**：回车与 Send/Stop 按钮**共用一条路由** —— `state.running ? cancel() : send()`。按钮那样做没问题（它的 title/aria 会变成 `Stop`，用户看得见自己在按什么），但**回车没有这个提示**；而发完消息后光标还在输入框里、手也还在键盘上，第二次回车就把整轮停掉了（代价是不可逆的：工具调用被中止）。
**修法**：回车只调 `send()`。`send()` 本来就守着"跑着不发"和"空内容且无附件不发"，于是"跑着按回车"变成一个**安全的空操作**。停止保持为**显式动作**：Send/Stop 按钮（含 `Stop` 提示）或 Escape。
**教训**：**一个输入不该在两种状态下做相反的事**，除非当下就有可见的提示。"发消息"与"中止整轮"是量级完全不同的两个动作（后者不可逆），把它们接到同一个键上，误触成本由用户承担。

> 187 补了这条的另一半：跑着时回车**不该是空操作**。见 §5.44（steering：把消息注入正在跑的那一轮；
> 不支持的 agent 则在输入卡上方写明原因 —— 182 那种"静默空操作"正是用户随后报的"发不出去了"）。

### 5.43 停止要二次确认（CUSTOM-20261004-183）

**来源**：用户「Escape 不管触发停止还是关弹窗类界面，都是不可逆的，需要先弹二次确认框」。
**先把事实核清楚**（决定这条改动该盖到哪）：Escape 在本面板里干的活分两类 ——

| 动作 | 可逆吗 | 处理 |
|---|---|---|
| **停止本轮**（webview 有焦点、轮次在跑） | **不可逆**（工具调用被掐断、agent 正在做的事丢了） | **加二次确认**（本条） |
| 关菜单 / 图片浮层 / 历史列表 | 可逆（都能重开、不丢内容） | 保持一键 |
| 表单抽屉收起 | 可逆（**只收起**，打过的字全在；152 起就绝不 cancel） | 保持一键 |

**做法**：`#stopConfirm`（`body.ts`）是输入卡上方的一条（同宽同中线，观感沿用抽屉那一套），默认隐藏。
**三条触发路径都走它**：

- **webview 内的 Escape**：composer 的 document 级 keydown（**bubble**，`event.defaultPrevented`
  守卫，IME `isComposing` 跳过）。浮层/菜单在 capture 阶段先消费（popover / outline / contextMenu /
  directoryMenu / sessionMenu / settingsPanel / elicitation / lightbox），没人消费的 Escape 才显示这一问。
- **输入卡 Stop 按钮**：`showStopAsk()`。
- **侧边栏标题栏 Stop / 命令面板**（2026-10-29）：`vac.cancelTurn` 先 `chat.requestStop(id)` →
  宿主向可见 surface 发 `stopAsk` → `showStopAsk(true)`（force：客户端 `state.running` 可能晚一拍）；
  无可见 surface 时才用非模态 warning 兜底。

条上两个按钮（`data-stop-confirm="stop" | "keep"`）：点了 `Stop` 才真的发 `cancelTurn`；
`Keep going`（或**再按一次 Escape**）只是收起这一问。轮次自己结束（`setRunning(false)`）或换会话
（`setFocus` 且 changed）时这一问自动收起。

⚠️ **Escape 不再有 workbench keybinding**（2026-10-29 删除）：旧键位直接执行 `vac.cancelTurn`，
绕过了这条确认。不要把它加回去；否则「按 Esc 关浮层」也会变成停止。

⚠️ 两个实现要点（都踩过）：
- **它必须放在 `.composer-inner` 里**：`.composer-main` 是 flex **行**（`justify-content:center`），
  直接挂在它下面会被当成行内项**压成 0 高**（第一版读数 `stopConfirmH: 0`，截图里也看不到）。
- 它长在 `#composer` 里 ⇒ 高度自动进 `--vac-composer-h`（composer 的观察器），消息区照常让位、
  176 的视口重算也在。实测：`stopConfirmH 41`、`composerH 84 → 131`、`messagesPadBottom 155px`。
- `role="alertdialog"` 而不是 `dialog`：**不抢焦点、不模态** —— 它只是横在输入卡上方的一条，
  别遮住你要停的那个会话。

**验收档**：`#composerdraftstopconfirm`（截图，借"已连接"相位才看得到 composer）、
`#stopconfirmprobe`（读数）。⚠️ 纯 `#stopconfirm` 那张截图里 composer 不可见 —— 那是**既有**现象
（`#composer*` 档一直如此，与 183 无关），要出图得借一个 `setConnected(true)` 的相位。

### 5.44 轮次进行中的补充消息（steering，CUSTOM-20261004-187）

**来源**：用户「任务在进行中，输入框的内容没法 Enter 发送了，需要支持增量发送」。182 刚把回车改成
"只调 send()"，而 `send()` 守着"跑着不发" ⇒ **跑着按回车 = 静默空操作**（那正是 182 想要的
"误触不会停轮次"，但没有第二条路把消息送出去）。

**协议**（读实跑的 `claude-agent-acp` 源码确认，非猜）：适配器注册了自定义方法
**`_session/steering`**，参数 `{sessionId, prompt: ContentBlock[], _meta?: {steering: {idleBehavior}}}`
—— 它把消息**注入正在跑的那一轮**，而不是排成第二个 `session/prompt`；能力在
`InitializeResponse._meta.steering.supported` 里声明。`idleBehavior: 'promptRequired'` 表示
"如果当前没有轮次在跑，请改用普通 prompt"（应答 `{outcome: 'promptRequired'}`）。
SDK 侧走 `ClientSideConnection.extMethod(method, params)`（就是普通 JSON-RPC request，不过滤方法名）。

**链路**：`initialize` 读能力 → `ConnectionInfo.supportsSteering` → `SessionManager`
（`supportsSteering` / `hasRunningTurn` / `steerPrompt`）→ `ChatPanelHost.handleSendPrompt`
在落完用户气泡后判 `hasRunningTurn && supportsSteering` → `steerPrompt`；**成功就原样返回**。
→ 能力随 `SessionMeta.steering` 下发 → composer 决定 running 时回车是"发出去"还是"原地提示"。

**三条不变量（破了不会有自动检查报错）**：
1. **steering 不产生第二个 `PromptResponse`**。走正常路径会 await 一个永远不来的响应：Stop 按钮
   永不熄灭、`finalizeTurn` 永不执行（不会 touchHistory / 不会发"轮次完成"通知）。所以宿主在
   steer 成功后**一个轮次状态都不动**（不 `endBackgroundTask`、不 `finalizeTurn`、不 `refreshSessions`）。
2. **能力是**每个 agent 一份**，跟着连接走**（`ConnectionInfo`），并随 `SessionMeta` 下发；客户端在
   **换会话时先重置为 false**（宁可提示，也不把消息发给不认它的 agent）。`meta` 里没这个字段时
   一律当"不支持"。
3. **`steerPrompt` 的 `'idle'` 必须落回普通路径**：我们这边的 `inFlightTurns` 可能陈旧（后台任务、
   别处发起的轮次），agent 说"我没在跑"时**不能把消息吞掉**。

**界面**：支持的 agent 什么都不用多说（回车就发出去了，与 Claude Code CLI 一致）；不支持的
显示 `#steerHint`（输入卡上方一条，与 `#stopConfirm` 同位置家族）—— 判据是
**running && !steering && 输入框里确实有东西**（少了最后一条就会在每次长轮次里无缘无故常驻）。
它同样必须放在 `.composer-inner` 里（理由见 5.43）。

**验收**：`npm test` 的 `chat panel: a message sent mid-turn steers the running turn`（宿主：注入 /
不产生第二个轮次 / idle 回落 / 不支持的 agent 不走这条路）与
`chat client logic: composer input bar` 里的 187 三条（回车发得出 / 不支持的保持不发并给提示 /
能力不跨会话泄漏）。**真机未跑**：要拉起 agent 且让一轮真的跑着才能验，见"自动化能覆盖到哪"那张表。