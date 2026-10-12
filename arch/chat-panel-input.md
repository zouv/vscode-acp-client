# Chat 面板 · 输入侧与交互抽屉（输入卡 / 草稿 / 表单与权限抽屉 / steering）

> **这是什么**：`arch/chat-panel.md` 的**分册**（2026-10-12 从主文件拆出，主文件当时 1200+ 行）。
> 管**用户从面板往下发出的东西**：底部输入卡、草稿页、表单（AskUserQuestion）与权限抽屉、
> 回车语义、停止的二次确认、轮次中补发消息（steering）。
>
> **§5.x 的编号原样保留**（与主文件同一套编号，跨文件连续）——代码注释与其它文档里有几十处
> 「§5.7」「§5.32」之类的引用，**重编号会把它们变成指向空处的雷**。因此引用只需换文件名。
>
> **分册导航**：面板骨架与消息纪律见 [`chat-panel.md`](./chat-panel.md)（§5.1–§5.12）；
> 记录区（折叠 / 时间 / 渲染 / 右键）见 [`chat-panel-records.md`](./chat-panel-records.md)；
> 会话目录与重开路径见 [`chat-panel-sessions.md`](./chat-panel-sessions.md)；
> 会话状态、诊断与几何见 [`chat-panel-state.md`](./chat-panel-state.md)；
> 任务路由见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)。

---

### 5.27 表单：ACP elicitation / AskUserQuestion（CUSTOM-20260929-119，152 改悬浮抽屉）

**为什么需要它**：AskUserQuestion 在 ACP 里走 **elicitation（form 模式）**协议，而 adapter 用
`clientCapabilities.elicitation.form` 门控——**不声明时连工具本身都被禁用**
（`disallowedTools = ["AskUserQuestion"]`）。所以"官方插件会弹选项面板、我们的面板只有一个卡住的工具卡"
不是渲染问题，是**能力声明缺失**。

**[152] 呈现方式**：记录里只留一行"待回答"条，表单本体在**悬浮抽屉**里（底部、贴着输入卡上方、
与它同宽同中线），多道题按 tab 分页 —— 用户 2026-09-30 报"表单以消息卡片的形式出现"，而问题多、
选项带长介绍时那张卡会把记录区撑得很长，且混在消息里不像"现在需要你操作"。细节见 §5.33。

| 关注点 | 规则 |
|---|---|
| 谁能弹 | `canPresent` 与权限卡**共用同一套判据**（会话还在 + 至少一个可用的 surface，对该会话聚焦且面不可见则 `reveal` 不抢焦点，见 §5.8） |
| 通道 | `AcpClientImpl.unstable_createElicitation` → `ElicitationHandler`（策略+弹框兜底）→ `ElicitationBridge`（**与 `PermissionBridge` 同构**：FIFO / `resolved` 幂等位 / `settleWith` 单点 resolve / `cancelSession`·`cancelAll`·`onPresenterLost`） |
| 三态 | `accept`（带 content）/ `decline`（**跳过**：空答案，轮次继续）/ `cancel`（中止工具调用）。adapter 的 `applyAskElicitationResponse` 就是这么解释的；**轮次被取消时回 cancel 而不是 decline**——空答案会骗到 agent |
| 作用域 | **只支持 `sessionId`**：ACP 还允许把表单挂在 `requestId` 上（与任何会话无关），那种没有会话可归属 ⇒ 直接 `cancel`，并记日志说明 |
| 字段扁平化 | `fieldsOf(requestedSchema)` → `select`(oneOf) / `multi`(array+anyOf) / `boolean` / `number` / `text`。**认不出的形状不进表单**（省略字段是合法答案——schema 里没有任何 required；猜一个比不填更糟）。`_meta._askUserQuestionCustomAnswer` 标记的自由文本框会带上 `customFor`，客户端据此把它排进对应问题（§5.33）。**[153] 标记缺失时按名字兜底**：实测 2026-10-01 的真机请求里 adapter **不再发** `_meta`（只有 `title: 'Other'` + 一句 description），只认标记会让那个框变成**独立的一题**（多出一个 "Other" 标签页、问题块里看不到自拟输入框）⇒ 现在额外认 `<某字段>_custom` 这个名字约定，且**父字段必须存在**；误判面很窄，真误判也只是排到那道题下面（提交时的字段名与取值不变） |
| 记录与回传 | 新记录类型 `kind: 'elicitation'`（`TranscriptStore.appendElicitation`，一个 promptId 一条，同权限卡）+ 客户端 `elicitationView.ts`；回答走 `elicitationAnswer` 消息（**会话作用域，必须放在 `verifySession` 守卫之后**）。**表单记录是 transcript 的记录 ⇒ boot/focus 的全量快照天然把它带回来**，切会话/双 surface/重挂载都不需要新机制；抽屉**不是**真相，它每次都由记录重新算出来 |
| 半填的草稿 | **只留在 webview 里**（DOM 就是表单状态），不进 transcript——否则每次 revise/快照都会把草稿重发一遍。结算态（accepted/declined/cancelled + summary）才由宿主写进记录。152 的抽屉因此**不重建已渲染的表单**（按 promptId 缓存元素），切 tab / 收起 / 重绘 chrome 都不碰输入控件 |
| 兜底弹框 | 无面板时**逐字段**问（VS Code 没有表单对话框）：select/multi → QuickPick、boolean → Yes/No、文本/数字 → InputBox。**取消某一步 = decline（跳过）**；面板里的 Cancel 才是硬中止 |
| **重开别人的会话不会重抛（实测）** | `session/load` 一个"卡在提问上"的会话时，adapter **只回放工具卡**、不会重新发 elicitation（`probe-elicitation.mjs --no-answer` 造出该状态再 `--reopen` 实测：0 次）。官方插件能弹是因为**那个未决请求在它自己的进程里**；我们重开时是另一个进程，替它回答不了。详见 pitfalls #32 |

### 5.31 底部栏：悬浮输入卡 + 预留功能区（CUSTOM-20260930-132..139）

**症状**：面板一拉开，底部输入框横向铺满整个 webview（一行文字横跨 1400px+），发送按钮离正文很远、不好点。

**先撤销了一半**：132 曾把**消息列与输入区一起**限到 820px 居中；137 按用户要求撤销了**消息列**的限宽（消息要平铺开、读得更宽），只保留底部这一块限宽 —— 两件事的目标本来就不同：消息区要宽，输入条要短。

| 主题 | 结论 |
|---|---|
| 底部栏结构（138） | `.composer` 是**两列** flex：`.composer-main`（输入卡）+ `.composer-aside`（预留功能区）。用两列而不是"给左边补一段 padding"的算法，是因为主列宽度天然等于"面板宽 − 预留区宽"，**输入卡的中线与消息列的中线自动重合** —— 少维护一个等式（pitfall #24） |
| 输入卡宽度（137） | `--vac-composer-max: 720px`，定义在 `body` 上（输入区是它的后代；`.composer` **不是** `.message-area` 的后代，挂那边够不着）。窄面板自动退化成满宽 |
| 为什么不用 media / container query | 它们键的是**窗口**（或另一个容器），而这里取决于**面板**宽度 —— 正是 pitfalls #25/#26 说的代理信号。`max-width` 自带退化：窄面板下没有余量可分 |
| 竖线（138） | `.composer-aside` 的 `border-left` 就是用户要的那根线。它的宽度取自 `--vac-aside-w`（由 `outline.ts` 的 `applyReserve()` 写入 = 大纲栏宽度，默认 240）⇒ 与**钉住的大纲栏左边界**落在同一条竖线上。两个宽度**同源**，不是对齐到一个常量（pitfall #19） |
| `.composer` 的左右 padding 必须为 0（138） | 右侧任何 padding 都会让竖线比大纲栏左边界靠左同样的像素数（实测差 8px 就是这么来的）。输入卡自己的边距交给 `.composer-main` 的**对称** padding —— 对称 padding 不改变主列中心，所以卡片与消息列的中线仍然重合（实测 `dxCardVsCol = 0`） |
| 真悬浮（139 + 140） | 139 去掉通栏的 `border-top`，改由卡片的描边 + `box-shadow` + 8px 圆角 + 四周留白表达"浮在底部"，但它**仍在文档流里** —— 于是底部这一整条（含卡片两侧那两块空白）都不显示消息，用户报"输入框两侧还是会盖住消息内容"。140 改成**真悬浮**：`.composer` 绝对定位（`body` 因此要 `position: relative`）、**背景透明**（有底色就等于把两侧的消息蒙上一块），消息区占满整个高度、卡片浮在上面 |
| 底部留白（140 + 144） | **一贯存在**：`.messages` 的 `padding-bottom: calc(24px + var(--vac-composer-h, 0px))` —— 内容永远停在卡片上方、不会被它遮挡（用户明确要求"消息区的触底判断应该保持在输入框上面的位置"）。配套的是 `scroll.ts` 的判据要**减掉这段留白**：用"内容末尾"而不是"可滚动范围的末尾"算 distance，这样"内容末尾进入视口"与"判定为到底"就是同一件事 —— 否则会出现"Jump 还说没到底、下面却已经是空白"的灰色地带（那正是被反复报的那个区间）。⚠️ 中途试过"只在贴底那一刻让位"的条件式（`.pin-bottom` 类）：**方向是错的** —— 未到底的内容会被卡片切断，还要在 scroll.ts 里维护"切类 + 位置补偿"，白白多出三个坑（都实测过，记录见 changelog）。`--vac-composer-h` 由 `composer.ts` 的 `watchHeight()` 用 ResizeObserver 观察底栏本身写入（pitfall #27）；`#jumpToLatest` 的 `bottom` 用同一个变量补偿。桩 DOM 里 `#composer` / `body.style.setProperty` / `getComputedStyle` 都不存在，三处都判空 |
| 底栏的两条"隐形"规则（144） | ①**编辑区面不能给底栏刷背景**：`.surface-editor .composer { background: editor-background }` 会把这条浮层变成一块**不透明带** —— 输入卡两侧的消息、右侧大纲栏的底部全被它盖住。而这个面正是用户日常用的：预览脚本默认渲染**侧边栏面**，所以这条一直没被照出来（`#…surfaceeditor` 档就是为它加的，探针读 `composerBg`）。②**底栏空区不吞点击**：`.composer` 通栏但 `pointer-events: none`，只有 `.composer-inner`（卡片与它的弹层）是 `auto` —— 否则输入卡两侧、大纲栏底部那块的点击会被它拦下（实测：大纲最后一条的 `elementFromPoint` 命中的是 composer，而不是那条记录） |
| 悬浮后的 z-index | 底栏 `z-index: 8`：高于置顶卡片（6）与引导条（3）；消息内容本身不带 z-index。`.picker-menu`（20）与 `.slash-popup`（30）都在底栏的层叠上下文内，所以它们照样盖住消息区 |
| 默认一行（139） | `autoGrow` 里 60px 的下限已放开，高度就是内容的自然高度；空内容 / JS 未跑时由 `.prompt-input` 的 `min-height: calc(1.4em + 4px)` 保底（与 1.4 的行高同源） |
| 高度上限是两件事 | `autoGrow` 的 320 是**内容**上限；`--vac-input-max-h: min(320px, 38vh)` 是**视口**上限。两者并存时浏览器取小的那个，所以 JS 不需要知道视口有多高 |
| 预留功能区（138 + 143） | 与输入区并列的第二列，宽度与大纲栏同源。**[143] 只在钉住的大纲栏可见时才占宽度**（`applyReserve` 写 0 或侧栏宽）—— 没有大纲就没有那根竖线，输入卡随之在面板里居中；`width` / `border-left` / `padding-left` 三处都用 `min(…, var(--vac-aside-w, 0px))`，否则宽度归零时那 1px 边框与 8px padding 仍然占着位置。**里面先空着**：用户要求"留着后面设计好方案再谈怎么用"，138 搬进去的上下文圆环 143 已回到按钮栏。`max-width: 40%` 仍是窄面板下的安全阀 |
| 未连接时不显示底栏（143） | `body[data-phase="disconnected"] .composer, body[data-phase="connecting"] .composer { display: none }` —— 那时输入框本来就是禁用的，露一个"看得见却打不了字"的框只会让人以为它坏了。相位由 `stateCard` 写在 `body[data-phase]` 上（与上面 `Times` 那条同一个机制）。副产品：`display: none` 让 ResizeObserver 把 `--vac-composer-h` 归零，消息区不再为一条并不存在的底栏留白 |
| 一体式卡片（133） | `.composer-card` 里装 textarea 与 `.composer-bar`；textarea 去边框、透明底。`.input-row` 这层已删（它唯一的子节点就是 textarea，而原 `flex:1` 在 flex **列**里含义完全不同） |
| 卡片不许写 overflow | `.picker-menu` 与 `.slash-popup` 都要向上弹；而且 column flex 上的 overflow 会**压扁子项**而不是让容器滚动（pitfalls #17） |
| 焦点环（134） | 从 textarea 移到卡片（`.composer-card:focus-within { border-color: --vscode-focusBorder }`），只对 `.prompt-input` 抑制 outline。全局 `:focus-visible` 不动 —— **"环 = 键盘焦点"的语义（062）不变** |
| `.slash-popup` 的 left/right | 从 6px 改成 0：定位祖先已从 `.composer` 换成 `.composer-inner`，0 才对得上卡片的边 |
| `#rail` 与 `#jumpToLatest`（132） | 搬进了 `.messages-column`（原为 `.message-area` 的子节点）。它们的横坐标来自 CSS 的 `left:0` / `left:50%`，锚错一层就贴错边。137 撤销列限宽后列恢复满宽、与改动前逐像素一致，搬迁**保留** —— 列才是消息内容的定位容器，将来若再限宽也不必重做。**别挪回 `.message-area`** |
| 消息列的定位意义 | `.messages-column` 不再限宽，但它仍是 `.sticky-user` / `.rail` / `#jumpToLatest` 的定位容器；`alignToContent()` 量的仍是滚动条宽（`offsetWidth − clientWidth`） |

**怎么验收（布局只能量，不能推 —— pitfalls #31）**：`preview-records.mjs` 的 `#composer*` 档**必须显式给宽档**（`shoot()` 的 size 参数）—— 输入卡的限宽在脚本默认的 500 档下不显形。读数输出在 `#composer*probe` 的 `<pre id="probe">` 里，主数字是 **`dxAsideVsOutline`**（预留区左边界 − 大纲栏左边界，138 的核心验收）与 `dxCardVsCol`（输入卡中心 − 消息列中心），配套 `dxRailVsCol` / `dxJumpVsCol` / `inputH` / `slashW` / `cardFocusWithin`；rail 与 jump-latest 平时是 hidden，探针会**临时去掉 hidden 再量**（`display:none` 的 rect 全为 0）。改前 / 改后对比：`--out` 两个目录并排看 `composer-wide.png`（配方写在脚本头部注释里）。

**实测（1440×1000，Chrome 无头）**：钉住 240px 大纲栏时 `dxAsideVsOutline = 0`、`dxCardVsCol = 0`、`dxRailVsCol = 0`、`dxJumpVsCol = 0`、`asideW = 240`、`asideVar = 240px`、`cardW = 720`、`inputH = 27`、`cardRadius = 8px`、`cardOverflow = visible`；未钉住时 `colW = 1424`（消息满宽）、`asideLeft = 1184`；窄档 500 下输入卡随主列收缩且 `dxCardVsCol = 0`；矮窗口 1440×560 下 `inputH` 被 `max-height` 夹在 176.7px。

**[140] 真悬浮**：`#composerbottom` 档（滚到最底）读 `composerPosition = absolute`、`composerBg = rgba(0,0,0,0)`、`messagesPadBottom = 108px`（= 24 + 底栏 84），关键是 **`lastGap = 111 > 底栏高 85`** —— 小于就说明最后一条被卡片压住、而且滚不动。**[141] 目录菜单**：`#historyfilter` 档读 `drawerOverflowY = visible`、`menuH = 260`（= 它自己的 max-height；修好前只露两三行）、`menuBorderColor = rgb(0,120,212)`。**[143]**：`#composerwide`（未钉住）`asideW = 0` 且 `cardCenter = colCenter = 712`（输入卡居中于面板）、`#composeroutline`（钉住）`asideW = 240` 且 `dxAsideVsOutline = 0`、`#phasedisconnected` 档 `composerDisplay = none` 且 `messagesPadBottom` 回落 24px。**[144]**：各档 `messagesPadBottom = 108px`（= 24 + 卡片 84，**一贯存在**），`scroll.ts` 的判据减掉它 ⇒ `#composerjustup`（贴底后上滚 40px）读到 `messagesClasses = messages`（已无切类逻辑，Jump 与留白天然一致）。**编辑区面**（`#…surfaceeditor` 档）：`composerBg = rgba(0, 0, 0, 0)` —— 改之前是 `rgb(31, 31, 31)`，那就是"遮挡"本身。**大纲滚到底**：`topElementAtLastItem` 从 `composer` 让开（底栏空区加了 `pointer-events: none`）。

---

### 5.32 草稿页的输入卡为什么能"完整"（模式/模型/斜杠命令，CUSTOM-20260930-151）

**问题**：点 tab 栏的「+」得到的是草稿页（058），它在 ACP 里**还不是 session** —— 而模式、模型、
可用命令在协议里**全是会话级的**：`NewSessionRequest` 只有 `cwd` / `mcpServers` /
`additionalDirectories`（**没有 mode/model 入参**，已核对 SDK 的 `types.gen.d.ts`），
`availableCommands` 也**只**出现在 `session/update` 的 `available_commands_update` 通知里。
于是草稿页的输入卡长期只有一个 textarea，看起来"没渲染完整"。

**做法**：宿主按 agent 留一份**上一次会话的快照**，草稿页拿它渲染，用户的选择随
`createDraftAndSend` 一起走、在建出会话后逐项校验并应用（"新会话继承上次用的模式/模型"）。

| 主题 | 结论 |
|---|---|
| 数据从哪来 | `ChatPanelHost.rememberAgentOptions(sessionId)` → `Map<agentName, {configOptions, availableCommands}>`，并按 agent 持久化到 `globalState`（`vac.draftOptions.v1`，照抄 077 的 `uiPrefs` 模式）。**不持久化等于默认路径不生效**：VS Code 重载后宿主内存里的活动会话全没了，"全新窗口点 + 还是空输入卡"正是用户报的现象 |
| 挂在哪些事件上 | `session-created` / `session-load-end` / `config-options-changed` / `available-commands-changed`。**不挂 `pushMeta`**：它在"没有 surface attach"或"不是聚焦会话"时提前 return，后台会话的变化进不了快照 |
| 为什么还要 `session-load-end` | `loadSession` 是"先注册 placeholder → emit `session-created` → 收到响应才写 `configOptions`"，**而且不走 `applyConfigOptions`** ⇒ 只挂 `session-created` 会让"打开一个历史会话"把快照的配置项清空 |
| 为什么**空值不覆盖** | `resumeSession` 的 `availableCommands` 恒为 `[]`（不重放），照单全收会把斜杠命令**擦掉**。空数组在这两条路径上只表示"还没填"，不表示"这个 agent 没有"。代价：可能留着一个陈旧的选项而它应用时会被跳过；收益：快照不会退化（陈旧 ≠ 退化） |
| 隐藏依赖 | `config-options-changed` / `available-commands-changed` / `mode-changed` 都由 **core 自己**从 agent 推送里落账：`SessionManager` 订阅构造器注入的 `SessionUpdateHandler`，把 `config_option_update` / `available_commands_update` / `current_mode_update` 分别交给 `applyConfigOptions` / `applyAvailableCommands` / `applyCurrentMode`。**不要**改回"由面板监听器顺手调一下"——`ChatPanelHost.onSessionUpdate` 开头会丢弃**会话注册前**到达的通知，而 core 侧的 `apply*` 带 `PendingSessionState` 缓冲、由 `registerSession` 的 `drainInto` 落盘，正好覆盖那个竞态（`applyStateFrom` 在注册之前跑，drain 时响应里的 `modes`/`configOptions` 已就位） |
| 谁发起请求 | `composer.setDraft()` 自己发 `listDraftOptions`（不是 boot）：要渲染应答的组件才是知道自己缺东西的那个，而且这样能落在 `chat-client.test.ts` 的桩 DOM 覆盖里（`loadClient` **刻意不加载 boot**）。应答由 boot 的消息 switch 转给 `NS.composer.setDraftOptions` |
| 迟到的应答 | 请求与应答都带 `draftId`，`setDraftOptions` 只认**当前聚焦的那个草稿**。`draftSeq` 是每个 webview 独立的，两个面会同时存在 `draft-1` ⇒ 定向与 `draftId` 两道判定都不能省 |
| 选择存在哪 | 存在 **boot 持有的 draft 对象**上（`draft.selections`），composer 只读它 —— 一份副本（pitfall #19）。切走再切回时靠它重放；快照每次聚焦都会重新下发，所以"快照值"永远不许覆盖用户已经选过的值 |
| 草稿态点菜单**不发** `setConfigOption` | 草稿没有 sessionId，那条消息会带 `sessionId: null` 被守卫静默丢弃（§5.4 规则一）—— 用户选了等于没选。改为只改本地副本的 `currentValue`（显示即所得）+ 记进 `selections` |
| 应用时机 | `createSession` → 发 `draftResolved`（保持 058 的不变量）→ 逐项校验后 `await setConfigOption` → 播种切换基线 → `pushMeta` → 首条消息。**在首条消息之前**是重点：第一轮就该跑在用户选的模式/模型上 |
| 三道校验闸门 | ① 按**新会话**的 `configOptions` 校验 id 与取值（`selectValues()`，`sessionChoices.ts` 的纯函数，含分组形态；快照可能来自 agent 旧版本）；② 与当前值相同的跳过（省一次往返，也少一次让 agent 推通知的机会）；③ 单项失败**不阻断**发消息，但**不许静默**（pitfalls #29）：记日志 + 在记录区留一行，否则用户只看到选择器自己弹回默认值 |
| 为什么要播种切换基线 | 应用完 `this.choices.set(sessionId, choiceState(sessionId))`。**不播种反而静默**（`syncChoices` 在 `!previous` 时 return），真正会出噪声的时序是：agent 在应用前先推过一次 `session/update`（`onSessionUpdate` 拿**默认值**当基线），应用后的通知 diff 非空 ⇒ 播出一条用户**从未做过**的切换。这是 pitfall #34 那套"两份副本 + 去重"的既定前提 |
| 不可覆盖的边界 | 全新环境（本进程没开过该 agent 的会话、globalState 也空）仍然只有输入框 —— 没有会话就没有地方问，这是这条路的**固有边界**，不是漏做 |
| 验收 | 桩 DOM：`chat-client.test.ts` 的 `draft composer options` 套件（渲染、迟到的应答、不发 setConfigOption、重试带当前选择、切回不丢）。宿主：`chat-panel.test.ts` 的草稿套件（空也回话、load/resume 两条时序、应用在首条消息之前、陈旧值跳过、失败留痕、应用不播报切换）。布局：`preview-records.mjs` 的 `#composerdraft*` 档（卡片 + 完整底栏） |

### 5.33 表单抽屉：分页 / 下拉 / 收起（CUSTOM-20260930-152）

**一句话**：记录层一行（`⏳ 待回答 · <gist>` + `Open form`），抽屉层一面（`#elicDrawer`）。

| 关注点 | 规则 |
|---|---|
| 层级 | `position: fixed`。**不要**用 `transform` 居中：我们要的规则是"与输入卡**同一个包含块**"（见下），transform 给不了这个。居中规则**必须与输入卡同源**：`left: 0; right: var(--vac-aside-w, 0px); margin: 0 auto; width: min(100% - 16px, --vac-composer-max)`。输入卡的中心不是面板中心——`.composer-main` 是"面板宽 − 预留功能区"，钉住大纲栏时两者差 `asideW/2`（240px 的栏 ⇒ 120px 偏移，用户 2026-10-01 报的"没居中"就是这个）。`bottom: var(--vac-composer-h)` 直接叠在底栏上（实测抽屉下沿 = 输入卡上沿）。`z-index: 9`（高于底栏 8、低于右键菜单 60 与图片浮层 90） |
| 高度让位 | 新增 `--vac-elic-h`：`#messages` 的 `padding-bottom` 与 `#jumpToLatest` 的 `bottom` 各加一段（实测展开 405px = 24 + 底栏 84 + 抽屉 297；收起 145px）。写变量的是 `applyDrawerHeight()`，**观察器 + 显式调用两条腿**：ResizeObserver 的回调按帧投递，不是每个宿主都送达（无头预览里就没送达，第一版只靠它 ⇒ 留白停在旧值，抽屉会压住最后一条记录）。这是 pitfall #27 的同一件事：量，并且别赌回调时机 |
| 题目分页 | 一个 tab 一道题（标题取 `field.title`，即 AskUserQuestion 的 `header`）；`customFor === X` 的字段并进 `X` 那道题（**按名字配对**，不按位置）。tab 上的圆点 = 已答/未答。**[154] bar（用户要求）：没有标题行** —— tab 条、`Answered n/N` 与收起箭头合成一条，进度与箭头**靠右** |
| 单选 | **[154] 平铺的 radio 列表**（用户第二次改规则：不要下拉）——每行 = **主标题 + 副标题（选项说明）**，末尾一行 `Other`（自由作答也是一"选"）。底层就是一组普通 radio，`collect()` 的判据一个字节没动；点击时**显式**取消同级 checked（桩 DOM 没有原生 radio 组行为，显式让两边一致）。没有下拉菜单 = 没有"菜单被裁/开错方向"那一类问题（153 为此改过两版规则） |
| 多选 | **经典复选框列表**（用户规则 2），行 = 选项名 + 选项介绍（用户规则 3） |
| 自拟框 | **[154] 单选：跟着"被选中的那一行"走**（`placeCustomBoxes` 把它 `appendChild` 进那行的容器里），没选时**藏在自己的题块里**（`data-elic-home`）而不是从 DOM 摘掉 —— 摘掉就再也找不回来，写进去的字也会掉出 `collect()`（这条是踩出来的）。多选：仍在列表下方。**任何形态都必须带那行说明**（"填了它就以它作答、取代上面所选"）——adapter 的 `applyAskElicitationResponse` 里 custom **优先于**选择，只写"追加"就是 UI 撒谎。**[189] 只在真的换行时才搬**（`if (box.parentNode !== host)`）：`placeCustomBoxes` 每个 `input` 事件都会跑一次，而无条件的 `appendChild` 会把里面的输入框**摘下来再插回去** ⇒ **每敲一个键就失焦**（用户报的"输入一个字符就失去焦点"；实测同一个父级也照样失焦，见 pitfalls #50 / `#elicfocusprobe`） |
| 收起 | bar 右端的箭头把抽屉收成**一行**。**[177] 收起时保留完整 tab 条**（用户要求：收起后仍要看得到每一题的标题与圆点状态，而不是只显示当前那一题 —— 否则收起等于"看不见还剩几题没答"）；藏起来的只有正文（`.elic-panes`）与操作栏。**收起态点任一 tab 会展开到那一题**（否则点了像没反应）。实测收起态高度 **33px**（一行 · 1440×1000 预览档 `#elicshrunkprobe`）**Escape 只收起、绝不 cancel**（cancel 会中止工具调用，不能由一次误按键触发）。收起会把这个 promptId 记进 `dismissed`：切走再回来不会自动重弹，内联条的「Open form」是回来的路 |
| 打开策略 | 自动打开 = 聚焦会话里有 pending 且该 promptId 没被收起过；**主动打开**（内联条 / 收起态）才把焦点给抽屉（显式动作才抢焦点，同 019/125 的态度） |
| **[161] Submit 的门禁** | 多题时 Submit **只在最后一题那一页可点**（用户要求防误提交：翻页看看后面还有没有时，第一页的提交按钮就在手边，很容易顺手点掉）。**禁用而不是隐藏**，并带一句 `title` 说明为什么——看得见的禁用按钮会说明"还差一步"，藏起来只会让人以为这个表单没有提交按钮。Skip / Cancel 不受影响（它们是逃生门，任何一页都该能用）。判据里还带着 `sending`：否则提交后一次 input/change 触发的 refresh 会把它重新点亮，又变回两条回答路径。页号超出**当前表单**的题数时**夹回最后一页**（否则一个 pane 都不显示，而且会骗过上面这条"已在最后一题"的判据）。**[188] 这个页号是每张表单自己的**：`activeTabs[promptId]`（缺省 0），不再是模块级的一个数字 —— 原来是全局数字时，夹回会拿**上一张**表单的页号去夹**新**表单，于是"新表单一冒出来就停在最后一个 tab"（用户报的现象；166 已经为 `collapsed` 踩过同一个坑，见 pitfalls #38 的复发记录） |
| **附加说明是「追加」（168）** | 用户明确要求（并确认了 adapter 的行为）：选项旁输入的文字**在选项基础上追加**，不是替换。做法在**我们这侧**：`collect()` 把两者合成**一个**答案（`选项 — 说明`，用选项的 label），并且**不再单独发** `question_N_custom` —— adapter 的 `applyAskElicitationResponse` 是「custom 优先并 return」（有它就丢掉所选项），单独发就等于替换。只在**没有勾选任何选项**时，那行文字才作为独立答案发送（自由作答）。那条「replacing the option picked above」的说明行随之删掉（旧语义遗留，用户报「描述不对」），说明只留在输入框的 tooltip 里 |
| **每个选项行都有自己的补充框（168）** | 多选的每一项都带一个（单选那个由题目级的 extra 框移进所选行）；只在**该行被勾中**时显示（同 154 的「框跟着所选行」）。它不是 schema 字段（`data-elic-note` 而非 `data-field`）⇒ 不会被通用收集循环看到，只被 `collect()` 并进那一项 |
| **取消选择：只剩 Clear answer（174）** | 168 曾让「再点一次已选中的单选行」也取消选择（当时那是唯一入口）。**174 起删掉**：抽屉底部已有 `Clear answer`，一个按钮做这件事比"再点同一行"可预期得多，也免得手抖点两下静默丢掉选择。现在单选就是**原生 radio**（再点保持选中），`data-elic-picked` 那套记账一并删除；显式互斥仍然保留（桩 DOM 没有原生 radio 组行为）。未答的题按「未选择」反馈，**不阻塞 Submit**（adapter 的 schema 什么都不 required，空 content 也接受 —— 已实测） |
| ⚠️ **选项说明为什么会丢（2026-10-03 定的案）** | 真机日志 `[vac] form fields: 1 question(s), 4 option(s), **0 with description**`。根因**不在我们这侧**：ACP SDK 用 zod 解析入站请求（`acp.js` 里 `validate.zCreateElicitationRequest.parse(params)`），而 0.21.1 的 `zEnumOption` 只声明了 `const` 与 `title` —— zod 的 object **丢弃未声明的键**，于是 adapter 发来的 `description`（以及 `_meta`）在进到 `fieldsOf` 之前就没了。**为什么此前三轮都"验证通过"**：153/168/173 的验证都是把日志里的**原始报文**直接喂 `fieldsOf`，绕过了 SDK 那一层（原始 JSON-RPC 流量日志当然还在）。修法见 `pitfalls.md` #43（两条路：本地回填 / 升 SDK ≥1.3） |
| **诊断日志（168）** | 表单构建时 `console.warn('[vac] form fields: N question(s), M option(s), K with description')`。**这行最终真的抓到了案子**（2026-10-03：`0 with description`），但它第一次写下来时**根本进不了日志** —— 被日志桥那 50 条终身配额挤掉（见 §5.39 / pitfalls #42，173 已修）。诊断通道要先能落盘，诊断才有意义 |
| **只看当前会话** | `setSession(sessionId)`（boot 在 `syncElicitations()` 这个唯一入口里同步）+ `pendingForms()` 按 `state.sessionId` 过滤。为什么不用"转录已经是当前会话的"当判据：那是**代理信号**（pitfall #25/#26），一旦某条路径没重建转录，别的会话的表单就会在这边显示出来（用户 2026-10-01 报的正是它）。记录仍记着"谁的表单" —— 切回去它自己会回来。**[154] 另一半在清记录那一侧**：`sessionId` 为空时 `pendingForms()` 直接返回空（草稿页/空态没有会话），而 boot 里所有清记录的地方统一走 `resetTranscript()` 包装（reset + 对账）—— 上一版只调了 `reset`，切到草稿页时抽屉就留在屏幕上了（用户第二张图） |
| 多个待答表单 | 抽屉同一时刻只呈现一个（记录里第一条未收起的），其余靠各自内联条的「Open form」切过去（`open(promptId)`）——不做叠层 |
| 委托点击 | 抽屉自己持有一个**容器级** click 监听（tab / 收起 / 清除所选，容器不重建 ⇒ 不怕 pitfall #28 的"重建后 target 脱离"）；`data-elic-action`（提交/跳过/取消）继续走 `links.ts` 的全局委托，根节点查找改为 `.elic` **或** `.elic-drawer`；下拉菜单项的 `data-elic-pick` 与"点外面关菜单"走 document 级监听 |
| 记录层的 pending 条 | 一行：⏳ + `<gist>`（`state.message` 折成一行）+ `Open form`。结算后仍是那张只读卡（问题 + 曾提供的选项 + 结果说明）——那是历史，不该被这次改动抹掉 |
| 已答判定 | 从 **DOM** 读（DOM 就是表单状态）：radio/checkbox 看 `checked`，文本框看非空。`onDrawerChange`（容器上的 change/input 委托）负责重算 tab 圆点/进度/未答提示 —— 少了它，勾选框不会让进度动（第一版就漏了） |
| 桩 DOM 的两个约束 | ①客户端代码里**不要用带值的属性选择器**（`[data-x="v"]`）——`src/test/chat-client.test.ts` 的桩只支持 `[attr]`，用它会让"找不到自己的 input"的 bug 在测试里永远绿；一律 `querySelectorAll('[attr]')` + 过滤（`inputsNamed`/`findByAttr`）。②`loadClient` 刻意不加载 boot，所以抽屉的**请求/应答**接线由 `NS.elicitationView.init()` 自己完成，测试直接调它 |

### 5.35 权限抽屉：与表单抽屉同形，贴在输入框上方（CUSTOM-20261001-158）

用户要求（原话）："询问权限的弹框…需改为跟选项弹框类似，在输入框上面弹出"。

| 关注点 | 规则 |
|---|---|
| 两层 | 记录区一行（⏳ + 标题 + `Review`）+ 本体在 `#permDrawer`（body 级浮层）。与表单（152）**逐条同构**——两者都是"agent 被挂住等你点一下"的东西，没有理由长得不一样 |
| 两个抽屉可以同时存在 | 同一会话先来表单又来权限是真实组合。**各有各的容器与高度变量**（`--vac-elic-h` / `--vac-perm-h`），`.perm-drawer` 的 `bottom` = `composer-h + elic-h` ⇒ 权限**贴在表单上面**，不相交、不需要 JS 协调。权限抽屉单独的 `max-height: min(50vh, 320px)`（权限提示天然短；两个 70vh 叠起来会淹没面板） |
| 为什么另起容器而不是并进 `#elicDrawer` | 后者由 `elicitationView` 端到端拥有（forms / dismissed / tabs / collapsed / ResizeObserver）。塞两种 state 进去要引入"谁拥有 body"的协调器 + 跨类型 tab/收起语义，收益只是一个 CSS 变量 |
| 显示 = 记录驱动 | `permissionDrawer.sync()` 从转录算 pending（按聚焦会话过滤），由 boot 的**唯一入口 `syncDrawers()`** 在六处（boot/focus/sessionClosed/append/revise/resetTranscript）对账。宿主不知道有抽屉这回事 |
| 没有"收起" | 与表单刻意不同：权限请求是阻塞的，收起它没有意义；记录行的 `Review` 是唯一的主动打开入口。Escape 不接管 |
| 回答路径唯一 | 发送与"发送中"守卫都在 `permissionView.answer(host, promptId, optionId)`（`links.ts` 只把按钮解析到宿主：`.perm` **或** `.perm-drawer`，与表单的写法一致）。按钮在两个宿主里都存在，两处各自发送就是两份知识；发送中禁用**全文档**同 promptId 的按钮 |
| 高度让位 | 消息区 `padding-bottom` 与 `#jumpToLatest` 的 `bottom` 都把两个变量**相加**（`composer-h + elic-h + perm-h`）。观察器 + 显式 poke 两条腿（pitfall #27：ResizeObserver 回调按帧投递，不是每个宿主都送达） |
| 桩 DOM 注意 | 客户端用 `document.querySelectorAll('[data-perm-option]')` 找按钮——测试桩的 `document` 起初**没有** `querySelectorAll`，那会让"发送中禁用"这条断言永远绿（假阴性）。桩已补上（解析到 body） |

### 5.36 记住用户选过的模式（CUSTOM-20261001-159/160）

用户要求："记住我的模式选择，下次打开新会话时默认使用此模式（比如这个会话我改成了 bypass）"。

| 关注点 | 规则 |
|---|---|
| 按 agent 记 | `vac.lastMode.v1`（globalState，`Record<agentName, {configId, value}>`）。模式是各 agent 自己的词表，按会话记等于没记（新建会话正是要跨会话）；globalState 而不是内存：重载窗口后"又回到默认模式"正是要消灭的现象 |
| 记什么 | 权威的**那一份**：`configOptions` 里 `category === 'mode'` 的 `currentValue`（128 的教训：`modes.currentModeId` 只是镜像）。`modeOptionOf()` 是唯一的判据出处（三处问它：picker、记、应用） |
| **在哪记** | 只记**用户动作**：`setConfigOption`（且 configId 就是那个 mode option）、`setMode`、以及草稿页 `applyDraftSelections` 里成功应用的模式项。**agent 自己切的模式不记**（plan mode 自动激活不是偏好），否则"默认值"会悄悄跟着上一个会话的际遇走 |
| 在哪应用 | `session-created` 的**第三参 `origin`**（`'new' | 'load' | 'resume'`，按"仅追加尾参"的契约加的）。**只对 `'new'` 应用**：打开历史/恢复的会话有自己的模式，那是"重新打开它"的一部分。`origin === undefined`（老调用方、测试直接 emit）按**非新建**处理 —— 宁可不动 |
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
| **停止本轮**（输入框有焦点、轮次在跑） | **不可逆**（工具调用被掐断、agent 正在做的事丢了） | **加二次确认**（本条） |
| 关菜单 / 图片浮层 / 历史列表 | 可逆（都能重开、不丢内容） | 保持一键 |
| 表单抽屉收起 | 可逆（**只收起**，打过的字全在；152 起就绝不 cancel） | 保持一键 |

**做法**：`#stopConfirm`（`body.ts`）是输入卡上方的一条（同宽同中线，观感沿用抽屉那一套），默认隐藏。
两条触发路径都走它：**Escape**（输入框内）与 **Stop 按钮**。条上两个按钮（`data-stop-confirm="stop" | "keep"`）：
点了 `Stop` 才真的发 `cancelTurn`；`Keep going`（或**再按一次 Escape**）只是收起这一问。
轮次自己结束（`setRunning(false)`）或换会话（`setFocus` 且 changed）时这一问自动收起。

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
