# Chat 面板 · 记录区（折叠 / 时间 / 内容渲染 / 右键菜单）

> **这是什么**：`arch/chat-panel.md` 的**继续拆分**（CUSTOM-20260925-068 之后，2026-09-26）。
> 主文件到 396 行、贴着它自己那条「超过 ~400 行即拆分」的线，而**记录区**这一块正在长——
> 于是有了这个文件。
>
> **为什么是"记录区"**：它管**一条记录长什么样、能不能折、要不要显示时间、内容怎么渲染、
> 右键给什么**、以及**记录之外的观感**（置顶本轮提问、文件引用的呈现、会话 tab 的目录标识、
> 工具输出被输入卡压住时的自愈）。与主文件的边界很清楚：主文件管面板骨架（surface / 协议纪律 /
> 子 agent / 大纲 / 性能不变式），这里管**记录本身**。
>
> **§5.x 编号继续沿用主文件那一套**（本节从 §5.16 起），所以引用只需换文件名，不必重编号。
> 覆盖：§5.16–§5.23、§5.25–§5.26、§5.29–§5.30、§5.41、§5.47、§5.49–§5.51。
>
> **配套（面板分册群，均沿用同一套 §5.x 编号）**：面板骨架与消息纪律见 [`chat-panel.md`](./chat-panel.md)；
> 会话目录与重开路径见 [`chat-panel-sessions.md`](./chat-panel-sessions.md)；
> 输入侧与抽屉见 [`chat-panel-input.md`](./chat-panel-input.md)；
> 会话状态、诊断与几何见 [`chat-panel-state.md`](./chat-panel-state.md)。

---

### 5.16 记录的折叠（Thought / 用户消息）与 INV-J

**两条记录可以折叠**：`thought`（推理块）与**多行**用户消息。两者共用同一套形态：`<details>` +
`<summary>`（标签）+ 内容体。

| 关注点 | 规则 |
|---|---|
| 折叠三角 | **真元素 `.fold-caret`，不是 `summary::before`**——伪元素永远画在内容之前，而类型图标是 `prepend` 到 `summary` 的，用伪元素会把三角挤到图标**左边**。正确顺序 `[图标][三角][标签]` 靠"先建三角、图标再 prepend"**按构造**得到。三角本身是空的：字形与方向由 CSS 依 `details[open]` 驱动 ⇒ **切换不需要 JS** |
| 重写 summary 时 | **保留所有元素子节点**（只丢文本与 `.thought-spin`）。按名字逐个列（旧写法只列 `.rec-icon`）会在新增挂件时**静默丢掉它** |
| 用户消息的切分 | **首行在 `summary`、其余在 `body`**（**不**重复全文，否则展开时文字两遍）；**默认展开**（刚发的消息不该被藏起来）；**折叠控件每条都有（113）**——单行消息不是"没有可折的东西"：它在更窄的宽度下会折行，而折叠态的 summary 不折行，那时折叠是真的动作。单行时 body 为空 ⇒ **不生成 `.fold-body`**（见下） |
| **触发条件（071，取代 064；113 去掉"单行退回气泡"）** | 判据是**实测渲染行数**，不是任何字符特征：先建出真正会渲染的 `<details>`（caret 与图标都在，宽度才对）、插入 DOM，再用 `Range.getClientRects()` **只框住文本节点**数行盒（`height > 0` 的矩形个数；行长边界会多出一个零高矩形），多于一行才**切分**；只有一行就把**全文留在 summary**、body 为空（**控件保留**，这是 113：单行消息在更窄的宽度下会折行，那时折叠是真实动作）。**064 的"`有 \n` 或 `长度 > 160`"已经删掉**——阈值与换行都是**代理信号**，两次都不够用（窄侧边栏里 100 字无换行的消息视觉上三行却不折叠，见 pitfalls #25 的第二次复发）。旧判据只保留为**量不出来时**的回退档 |
| **`.fold-body` 在不在是有含义的（113）** | 它 = "caret 后面还藏着东西"：单行消息的 body 为空 ⇒ **不生成这个元素**。置顶条的收缩按钮正是按它判断的（按 `.user-fold` 判断会变成"每条消息都配一个没反应的按钮"，那正是 104 拒绝过的）。`settleUserFold` 的"先清空旧 body 再重判"因此要按需重加，不能无条件 append 一个空 span |
| 切分点 | 有 `\n` 且其后还有可见内容 ⇒ **按 `\n` 切**（精确答案）；否则二分找**第一行末尾** → 回退到最近空格 → 不切断代理对。切在 `\n` 上时**那个换行符被丢弃**：summary 与 body 的块边界本身就渲染成一次换行，留着会多出一整行空行 |
| 量不出来时（隐藏面板 / 无 `createRange` / 超 2000 字） | 回退 064 的判据，并把节点标成 `data-fold="heuristic"`；等它第一次拿到真实尺寸（`rail` 的 ResizeObserver 正好报这个事件）**只重判一次**，两个方向都要能改（折→不折、不折→折）。**不要每次 resize 都重判**——那会与引导条互相打架 |
| 折叠态 | summary 占**恰好一行**并省略号截断（`.user-fold:not([open]) > summary`）——**只在折叠态**：展开时若还是 `nowrap`，第一段会被截成"半句话加省略号"，看起来像内容丢了 |
| 展开态 | body 是 **inline**：切分点只是实现细节，块级 body 会在半句话处凭空多一处换行 |
| **用户消息的宽度（105）** | `.entry-user { align-self: stretch }`——**靠左、铺满内容盒**。原先是 `flex-end` + `max-width:88%`，气泡宽度 = 内容宽度；于是**折叠后只剩首行、宽度跟着缩短**，面板在折/展时自己变窄（用户报"体验不好"）。宽度现在是常量，折与不折只影响高度。连带：正文与时刻同一起点（`.rec-time` 的右对齐已删）、圆角四角一致（原来的 `8/8/2/8` 缺口指向右下，靠左之后方向反了）。**置顶卡片里的克隆体吃的是同一套规则**，所以"铺满"也决定了卡片里没有空档（169 起卡片里那条折叠三角就是**唯一**的收缩控件，位置见 §5.25） |
| **正文从第二行开始（108）** | summary 第一行只放图标/caret（+图片 chip），正文包进 `.bubble-body`（`display:block`）另起一行。`textNodeOf` 改为在 `.bubble-body` 里找文本节点（图标/caret/chip 都在外面）。`unfoldUser` 重建气泡时把 chip 一并迁过去。折叠态的截断从整个 summary 改到 `.bubble-body` 自己（否则图片 chip 会被一起截掉） |
| **Thought 展开态的高度上限（217）** | `.thought-body` 的 `max-height` **300px → 600px**（用户 2026-10-09："Thought 卡片展开后显示的内容高度有点低，加大一倍"）。它是**滚动视口**的高度：超长推理一次能看到更多，超出才滚动。真 Chromium 读数钉住（`preview-records.mjs` 的 `#subagentprobe`：`thoughtMaxHeight: 600px`） |
| **图片附件进用户气泡（108）** | `UserEntry` 加 `attachments?: ContentBlockView[]`；`handleSendPrompt` 把图片的 `toContentView` 循环提前到 `appendUser` 之前、把 views 一并传入，删掉独立 `content` 条目的 append。**Replay 路径（111）**：replay 把文本与图片分成两条 chunk（100 的教训），气泡里没有可合并的东西——改为在 replay 开始前读转录（`readTranscriptUserImages`），按 `uuid` 建 `messageId → 图片视图` 表，`user_message_chunk` 的文本分支据此并入 `appendUser`，随后的图片 chunk 丢弃。任何失败退化为"没有图片" |
| **注入块分流（109）** | `<task-notification>`、`<system-reminder>` 等注入块走 `user_message_chunk` 通道，被无条件渲染成蓝色用户气泡。改为**前缀判据**（`isInjectedChunk`），两条入口（replay 分支、`handleSendPrompt`）共用同一个判据，分流成 `notice` 的 `meta` 级别（居中、灰色、小字、无气泡、无图标）。发送路径仍然真的发出去（agent 期待收到），只是不再产生用户气泡 |
| **IDE 上下文 → 文件 chip（205）** | `<ide_opened_file>…</ide_opened_file>` 是 IDE（官方 Claude Code 扩展）注入的"当前打开的文件"**上下文**，它跟 109 那批一样走 user chunk 通道 ⇒ 同一条消息渲染成**两个**蓝色气泡（用户报："附加的文件没有合并到一个对话里，分成了两条对话"）。**它的正确形状不是提示条而是 chip**（官方插件就是这么画的：同一个气泡里，chip 在上、正文在下）：`ideOpenedFilePath()` 抠出路径，按「会话::messageId」暂存（回放里两条 chunk 同 messageId、顺序不保证），正文 chunk 到的时候作为 `attachments` 进同一个气泡（chip 是 `resource_link` 视图 → 点它走 openFile，见 039）；块本身**不建记录**。⚠️ **判据要放在 `isInjectedChunk` 之前**（它也以 `<ide_` 开头）；其它 `<ide_*>` 块（`<ide_selection>` / `<ide_diagnostics>`）归 109 那条路（`<ide_` 进了前缀表），认不出形状也不会变成"用户说过的话"。暂存表只留最近 20 条（用户只开了个文件、没有下文时那条永远没人来取），会话关闭即清 |

| **点击切换区（213）** | 用户气泡的折叠由 `<summary>` 的原生点击触发，而正文（`.bubble-body`）**在** summary 里（折叠态"首行预览"的要求）⇒ 在正文里划选 == 点它，读者刚要选的内容反被折起来（用户 2026-10-09 报："点击任意位置都折叠，没法框选文字内容"）。修法是在 summary 的 click 上 `preventDefault` 拦掉原生的开合，**按状态分格**：展开态 —— 正文区一切点击都不折叠（可自由框选），切换区 = 标题行（caret/图标/chip）；折叠态 —— 整行（含那一行预览）仍是切换区（"第一行就是全部"，用户要求它能点）；另加一条通用闸门：**手里已有选区**（从正文拖到行尾空白再松手也算划选）一律不折叠。助手气泡（114）不需要这条 —— 它的正文本来就在 summary 外。**同日补**：展开态**第一行本身**仍选不中 —— 它落在 summary 里，而 summary 是 `cursor:pointer; user-select:none` 的切换区（用户报"鼠标变手、选了没反应"）。加一条 `.user-fold[open] > summary .bubble-body { user-select:text; cursor:text }` 解禁（**折叠态刻意不解禁**：那一行预览就是"点它展开"的切换区）；真 Chromium 读数钉住：`userSelect:text / cursor:text / 选中 3 字符`（修前 none/pointer/0） |

| **文件引用进气泡（215）** | 用户报："引用了文件的消息发出去后，消息面板里这条用户消息卡片里看不到引用的文件"——发送路径只给**图片**建了气泡视图，文件引用只进了发给 agent 的 blocks。修法：气泡视图与 blocks 在**同一个循环**里砌出来（uri / `#L` 片段 / name 各只有一个来源，pitfall #19）——图片进 `imageViews`、文件转成 `resource_link` 视图（`toContentView` 会认出本地文件给出 `path`，气泡里的 chip 点击走 openFile）。空文字 + 只有文件引用时同样落成 `content` 条目，不产生空气泡 |

| **回放里的文件引用（216）** | 用户报："reload 之后这条消息变回原文"。**根因**：Claude Code 把用户的 `resource_link` 块**序列化成一段文本**存进自己的转录（`[@名](file:///…`），`session/load` 回放时**单独发一条** `user_message_chunk`（与正文共用一个 messageId）；宿主原先只认**块** ⇒ 它被当正文又建一条气泡，而气泡正文是**纯文本节点**（不渲染 markdown）⇒ 那串 markdown 原样显示。修法与 111（图片）同路：`markdown.fileMentionViews()` 认出"整段就是若干条 `[@名](本地路径)`"（标签必须以 `@` 开头、每段都得是链接 ⇒ 正文里随手写的链接不会中招；路径复用 184 的 `fileLinkTarget`，`name` 把 `#L437-440` 归一成 live chip 的 `:437-440`），`diskSessions.readTranscriptUserAttachments()`（**并入并取代** 111 的 `readTranscriptUserImages`，图片与引用同一次扫描收齐，open 会话少扫一遍 5–13MB 的转录）按 uuid 给出 `{images, files, hasProse}`，正文 chunk 把三者一并传进 `appendUser`。**丢弃附件 chunk 的判据是"这条记录有没有正文"，不是"转录里知道这条 messageId"**——只引用文件不打字的消息（215 支持）回放时只有附件 chunk，按后者处理会连记录一起消失（比原文更糟）；同一判据顺带修掉 111 的同类洞（只有图片没有正文的消息此前也被丢掉）。读不到转录时 mention chunk 落成 `content` 条目（与发送路径同形），绝不显示原文 |

**INV-J（破了不会有自动检查报错；`src/test/chat-client.test.ts` 是它的守卫）**：
①三角在图标**之后**；②summary 重写后**图标与三角都还在**；③用户消息折叠**不重复全文**、
默认展开、**每条消息都有控件**（113）——单行时 body 为空且**不生成 `.fold-body`**（那个元素
就是"后面还有东西"的标记，置顶条的收缩按钮按它判断）；④**触发判据是"屏幕上几行"**——
两个方向都要测：只折行无换行的消息**必须切分**（有 `.fold-body`），
一行放得下的长文本**必须不切分**（无 `.fold-body`）；只测前者说明不了它是测量而不是"更宽的阈值"；⑤**点击分格（213）**——展开态点正文必须被拦下、点 caret 放行；折叠态整行放行；手里有选区一律拦下（三条用例在 `chat-client.test.ts`）；⑥**展开态的第一行可框选**（`.bubble-body` 的 user-select 必须是 text —— `#userfoldprobe` 读计算值 + 实选字数）。

### 5.16.1 助手消息的折叠（114；折叠态一行 115→116）

`agent_message_chunk`（助手气泡）与用户消息**共用同一套折叠控件**：真三角 `.fold-caret`、
`<details>` 原生开关（切换不需要 JS）、**默认展开**（刚到的回答不该被藏起来）。
**思考块本来就能折叠**（§5.16 的 `.thought`），所以 114 只补助手这一类。

| 关注点 | 规则 |
|---|---|
| 结构 | `details.msg-fold[open] > summary.msg-head([icon][caret][.msg-preview])` ＋ `div.bubble-body`（summary 的**兄弟**） |
| **正文为什么不在 summary 里** | 用户气泡里是惰性文本，整行当点击区没问题；**助手正文是 markdown HTML**（链接、代码 Copy、图片 chip），而且**在 `<summary>` 里划选文本 == 点它** —— 读者选中一段回答就会把它折起来。所以切换区只有那一行 [图标][三角]，正文在外面 |
| 折叠怎么实现 | **首行预览**：一段预览文本放在 summary 里（`.msg-preview`，真文本节点），折叠时显示、展开时由 CSS 藏掉。**"更聪明"的两条路都试过并否掉了**：按测量切开正文（渲染后的 markdown 里"切在第几个字符"没有意义）、给正文加行钳制（**`details` 折叠时对非 summary 子节点的隐藏，作者样式抢不过**——115 用 `display` 覆盖，结果折叠后正文干脆不可见，用户看到的正是"折叠后文字没了"） |
| **折叠后占几行（115→116）** | **一行**：`[图标][三角][正文首行]`，与用户消息一致（用户要求）。115 想用 flex 把正文的首行挪到标题行上——**没用**：`display:flex` 挂在 `details` 上并不产生"两个 flex 项目"的布局（实测首行跑到图标行、其余照旧另起）。116 改成"预览文本"这条唯一可行的路。**这类判断必须靠 `preview-records.mjs` 截图，不要靠推理**（pitfalls #31） |
| 预览从哪来 | `refreshPreview(record, body)`，在 **`applyAssistant` 末尾**调用——那是正文内容变化仅有的两个入口（首次渲染 / 每次 patch）的汇聚点，所以只有一个同步点。文本取自**渲染后**正文的**首个块元素**（`firstElementChild.textContent`），纯流式文本没有元素子节点时回退到整段文本；只取一行、截到 240 字（`ASSISTANT_PREVIEW_CHARS`）。**取自渲染结果而不是 `entry.text`**，否则 `## 标题` 会原样出现在预览里 |
| 预览不是"正文的副本"隐患 | 展开时它是 `display:none`：不参与渲染，也不进划选/全选复制（`Copy message` 读 `entry.text`，与 DOM 无关）；折叠时正文被浏览器整块藏起来，屏幕上只有这一份 |
| 图标挂在哪 | `icons.attach` 的 `HOST.assistant` 从 `.bubble` 改成 `.msg-head`（在 caret 之后 prepend ⇒ 仍是 `[图标][三角]`）。**顺带删掉 `applyAssistant` 里 takeIcon/putIcon 那一对**：图标不再住在被重写的节点里，没有东西能擦掉它 |
| 外观挂在哪 | `.entry-assistant .msg-fold`（原来是 `.bubble`）——details 现在包住标题行+正文两段。`.md` 类名移到 `.bubble-body`，故 `.entry-assistant .bubble-body.md { white-space: normal }` |
| 重写路径 | `patch` 里 `node.querySelector('.bubble')` → `.bubble-body`（否则 markdown 永远落不进新结构，且是**静默**的：记录还在、只是不再更新） |
| 构建顺序 | 标题行里是 `[图标][三角][预览]`（INV-J ① ＋ 预览垫底）。`buildAssistantFold` 必须**先把正文 append 进 details、再调 applyAssistant**——预览刷新顺着 records 找 `.msg-preview`，正文不在树里时那条链是断的（116 的第一版就栽在这，图上是"折叠后一片空白"） |

### 5.17 每条记录的时间（065）

**事实**：**每条记录都已经带 `at`**（`TranscriptStore` 在 append 时打的时间戳），只是一直没显示过。
Thought 的 `Thought for Ns` 是**耗时**不是时刻。

| 层次 | 做法 | 理由 |
|---|---|---|
| 悬停 | 每条记录的 `title` 是完整时刻（HH:MM:SS） | 零成本、零噪声，随时可查 |
| 工具耗时 | `ToolCallView.elapsedMs`（宿主用 `endedAt - startedAt` 算），卡头显示 `1.2s` / `420ms` / `2m 5s`，**常显** | 与 `Thought for Ns` 同类信息，不设开关。**不下发两个时间戳**：已完成的时长不需要客户端时钟；**仍在跑的不显示**——`status` 的脉动已说明"进行中"，实时计时器意味着每帧重渲染 |
| 每条时刻 | 头部「Times」开关（持久化）⇒ **只在工具卡上**显示 HH:MM：关 = `3ms`（耗时，常显）；开 = `3ms 18:32`（耗时 + 时刻，见 129）。**[146] 普通消息与 Thought 不显示时刻** —— ACP 里只有工具调用带 `elapsedMs`，它们根本没有"耗时"这个量，单独挂一个时刻读起来像缺了一半 | `.rec-time` 元素**始终在 DOM 里**（`transcriptView` 一律插入），显隐由一个类决定：`.messages.show-times .tool-head .rec-time { display: block }` ⇒ **切换开关不重渲染任何东西**。工具卡的时刻是**标题行里的一项**（`.tool-head .rec-time { position: static }`，跟在 `.tool-time` 后面，整行读作 `3ms 18:32`）；其余记录的时刻元素仍插在 `summary` 里，只是选择器不放它出来（`.rec-time` 的绝对定位对它们才成立，工具卡是例外）。挂在**标题行**而不是记录节点上，是因为折叠的 `<details>` 会隐藏 summary 之外的一切。**145 曾试图让工具卡的时刻也浮到右上角**（好让所有记录对齐），靠 `padding-right` 硬留槽位 —— 结果把工具卡本来工整的一行挤散了，**已回退** |

**时长的格式化在 `NS.dom.duration`**（最底层模块）：`toolCallView` 与记录层都要用，而模块加载顺序
**只允许依赖指向前方**——放在 `transcriptView` 里 `toolCallView` 用不到，抄第二份又会漂（pitfalls #19）。

**[回放拿不到真实时刻 → 按 0 起步（CUSTOM）]**：ACP 的 `session/update` **不带任何时间字段**（核对过
SDK），回放记录默认全用 `Date.now()`——一个几十条的旧会话所有记录挤在同一秒，还读起来像个真实墙钟（误导）。
修法分两层：① 回放期间（`session-load-start` → `TranscriptStore.beginReplay`，先 `ensureSession` 建桶——
通知还没到桶可能不存在）append 的记录 `at` 写成「回放起点 0 起的相对毫秒」并打 `atIsElapsed`；命中转录真实时刻时
（`preloadTranscriptTimes` 预读 + `stampReplayTime` 覆盖，仅 Claude Code）把 `at` 改回真实 epoch 并**清掉**标记；
`session-load-end` → `endReplay`，之后的记录回到墙钟。② 客户端按 `atIsElapsed` 选格式与颜色：真实 = `HH:MM`
（`descriptionForeground`），回退 = `+M:SS`（`inputPlaceholderForeground` + 斜体，前缀 `+` 读作计时）——
颜色/字形/前缀三重信号，不靠单一颜色也能辨认真假。`finalizeStreaming` 对 `atIsElapsed` 的 thought **不产耗时**
（没有真实起点，`Date.now() - at` 会算出巨大错数）。

### 5.18 工具输出按 markdown 渲染（066）

**事实**：Claude Code 的 Bash 结果**本身就是 markdown 包装的**（抓包夹具里 12 处带 ``` 围栏），
所以按纯文本渲染会显示字面的 ``` 并丢掉代码块样式与 Copy 按钮。

- **复用助手气泡那条 markdown 往返**（宿主 `SafeMarkdown` + 客户端 `sanitize` 双重兜底），
  **不写第二个更弱的渲染器** —— 行为一致是这条的全部价值。
- 工具内容项没有身份 ⇒ 给它稳定 key：**`entryId + '#' + 项下标`**（下标在同一调用内稳定）。
- 协议：`renderMarkdown` / `markdownRendered` 的 item 各加可选 `key`；**带 key 的项宿主不做
  `transcripts.patch`**（它不是记录，没有可打补丁的对象），HTML 原样回给请求它的元素。
- 客户端两份缓存（`mdCache` / `mdPending`），**按会话清空**（`transcriptView.reset()` 里调到）：
  工具 body 在 `bodySignature` 变化时会**整块重建**，缓存是让已渲染 HTML 挺过重建的关键。
- **防御**：拿不到 `entryId` 时（无唯一 key）**回落纯文本**——key 撞车会把一条记录的 HTML 喂给另一条。
- **[147] 助手/思考那条往返上的两处守卫**（用户报"最后一条不渲染、重开会话就正常"）：
  ①`boot.requestMarkdown` 里原来有一条"聚焦会话为空就整批不发"的守卫 —— 而 `transcriptView` 的
  item **自带 sessionId**（请求方就是它），根本不需要借聚焦状态；那道守卫只会在"正文刚落地、
  聚焦还没同步好"的那一帧白白丢掉一次请求（pending 不清空，但下一次触发可能永远不来 —— 128 修
  的就是这个形状）。守卫现在只留给**没有会话身份**的工具项。
  ②客户端处理 `markdownRendered` 时**不再**拿 item.sessionId 跟 boot 的 `currentSessionId` 比：
  两端来源不同，一旦不一致就把回填**静默丢掉**，那条记录于是一直停在原文 —— 而宿主其实已经把
  html 写进了 store，所以它表现为"重开会话就正常"（重开走快照，不经过这里）。`entryId` 在 store
  里全局唯一，按它回填本来就串不了台。**判据**：客户端的请求链路本身由桩测试钉住了
  （`markdown asks for itself`，含"正文后到 + finalize"那条），所以再遇到同类症状应当先怀疑
  **回填这一侧**，而不是去翻 `markPending`。

### 5.19 右键菜单是自己的（067）

Webview 默认弹 **Chromium 的原生菜单**，它在这个面板上有两个问题：`Cut`/`Paste` 对只读内容没有意义；
`Copy` 复制的是**选区**（右键时通常没有选区）⇒ 看起来可用、实际什么都不做。

- `contextmenu` 上 `preventDefault()` **整体接管**（留着原生菜单会得到两个菜单）。
- 项：`Copy`（选区，**无选区时禁用**）/ `Copy message` / `Copy code` / `Select all`。**没有 Cut/Paste**。
  **禁用项比"点了没反应"诚实得多** —— 本次故障的全部体感就是"点了没反应"。
- 复制走扩展侧 `copy` 通道（与代码块 Copy 同一条路）：webview 的 `navigator.clipboard` 依赖文档焦点。
- **输入框里不接管**（那里系统的 Cut/Paste 是对的）。
- 关闭：任意点击 / Esc / 滚动 / resize / 失焦；位置贴边翻转。项是真 `<button>`（047 的规矩）。

### 5.20 客户端逻辑的自动测试（068）

`src/test/chat-client.test.ts`：**桩 DOM** + 只加载被测链路的模块
（`dom` → `icons` → `links` → `toolCallView` → `transcriptView`），其余协作者给最小替身。

- **边界画在被测链路上**：不加载 `boot`（它的 `init()` 会去接十几个 `body.ts` 的元素，
  为了让它跑起来就得把桩扩张成一个假 DOM ⇒ 一堆与产品无关的桩代码）。
- **能测逻辑，不能测布局**：结构、顺序、类名、内容切分 ✅；尺寸、换行位置、颜色、焦点 ❌
  （需要真 Chromium——用 jsdom 之类的近似实现测布局只会给出**假信心**，与 `docs/dev-workflow.md` 的分区表一致）。
- 桩是**外部 API 的测试替身**（同目录里早有假 Memento），不是我们自己知识的第二份拷贝（那才是 pitfalls #19）。
- **它的假设也要被检验**：068 落地过程中两次"测试错了、产品没错"——①按"容器的第一个子节点"取记录，
  而 `place()` 会把 `.rec-time` 插进标题行（**第一例是假通过**）；②用户记录是**包着 details 的 div**，
  而 Thought 记录**本身就是 details**，只认一种形态会误判"无折叠"。⇒ **按标记（`[data-kind]`）定位，不要假设位置。**
- **071 之后的桩**：折叠判据要"实测行数"，于是在 `document` 上补了一个**确定性的 Range 模型**
  （每 N 字一行，`charsPerLine` 可调）。**这不是假装测布局**：换行位置仍是浏览器的活，桩只回答
  "这个前缀占几行"，被测的是我们的逻辑（二分、空格回退、`\n` 优先级、回退档、重判）。
  把 `charsPerLine` 调大就能测"一行放得下的长文本**不**折叠"——那是**唯一**能把"测量"与"更宽的阈值"分开的办法。

### 5.21 思考块也走 markdown（072）

**事实**：`thought` 记录此前是**纯文本**（`buildThought` 直接写 `entry.text`），所以 agent 推理里的
反引号、`- ` 列表符、``` 围栏全部以字面字符显示。夹具里 `agent_thought_chunk` 有 492 条，
比正文的 422 条还多——这是记录区里最显眼的一处"markdown 没支持"。

- **复用助手气泡那条往返**（宿主 `SafeMarkdown` → 客户端 `sanitize`），不写第二个渲染器。
- `ThoughtEntry.html`；`TranscriptStore.patch` 的 thought 分支**必须处理 `html`**
  ——不加就是**静默丢弃**（宿主自己的补丁落不了库，切会话又变回纯文本）。
- **INV-K：思考块的合并分支必须清掉 `html`**（`appendThoughtChunk` 的 merges 分支）。
  助手分支一直有这一行，思考分支漏了的话，之后每个 chunk 都会带上**过期前缀**的 html
  ——正文冻结或来回跳，而且没有任何报错。
- **流式期间不渲染 markdown**：只从**定稿**的 revise 排 pending。给还在长的正文应用"某个前缀的 html"
  是错的；定稿的 revise 又**不带 html 键**，所以 `patch` 里必须"html 到了就不再请求、定稿且没有 html 就重新排"
  两个方向都写（`trackMarkdown`，与助手共用）——只判断 `changes.html` 会永远不排，表现就是
  "markdown 刚到达又被原文覆盖"。
- **hydrate 也要覆盖**：`buildThought` 直接按 `entry.html` 决定渲染方式，否则从快照恢复的思考块永远是纯文本。
- **CSS 作用域**：markdown 规则从 `.bubble` 扩到 `.bubble, .md` **共享**（各写一套 = 同一份知识存两份）。
  `.thought-body.md` 回到 `white-space: normal`（pre-wrap 会把 marked 的换行**再加一倍**）；
  正文保持斜体（推理的视觉身份），但 `pre`/`code`/`table` 内重置为非斜体。
- **顺带**：GFM **任务列表的勾选态**。`marked` 默认输出 `<input type="checkbox" disabled>`，
  而客户端白名单没有 `INPUT` ⇒ 被 unwrap，`- [x] 做完了` 与未完成**长得一模一样**。
  修法是**覆盖渲染器的 `checkbox` 钩子**输出字形 span——**不**把表单控件加进白名单；
  覆盖 `checkbox` 而不是 `listitem`，是为了不重写 marked 自己那套紧/松列表的插入位置。

### 5.22 切换模型/模式的提示（073）

**事实**：`setModel` / `setMode` / `setConfigOption` 以前只 `pushMeta()`，记录区里不留痕迹——
读者回看时不知道从哪一句起换了模型。Claude 官方插件在切换处插一条分隔式提示。

- **纯函数放 `src/ui/chat/sessionChoices.ts`**（取快照 / 按通知载荷打补丁 / 算差异 → 人类可读的一句话），
  宿主只做缓存与发帖。抽出来的理由是**可测**：真正的分支（谁先到、同一次切换被上报两次怎么办、
  级联变更怎么表述）在编排器里没法单测。
- **去重靠"缓存由我们独占"**：同一次切换有两条上报路径——我们自己的 setter 与 agent 的
  `config_option_update` / `current_mode_update`。**先到的那条**算出差异并提示，后到的那条与我们刚写入的
  快照一比就是空的。**通知路径用载荷**而不是 `SessionManager` 的状态：两个监听器的先后顺序不保证，
  读状态可能拿到改前或改后。
- **但"两条路径产出同一个快照"是个契约，而它一度不成立。** 模式在
  `session.modes.currentModeId` 与 `configOptions[category='mode'].currentValue` 里**各有一份副本**，
  而两份**不会同时被写**（`setMode` 在会话有 configOptions 时提前 return，`current_mode_update`
  也从不落到 `SessionManager`）⇒ 上面那句去重**静默失效**：一次切换被报成两条，第二条还是
  "新的一半 + 旧的一半"拼出来的、现实中不存在的状态（实测 `Manual mode · Bypass permissions mode`）。
  现在**以 config option 为权威**：快照的 modeId 由它派生（没有这个选项时才回退 `modes.currentModeId`，
  纯 modes 通道的 agent 不受影响），只带 modeId 的 payload 会把值**写回**那份副本，`choiceChanges`
  跳过该选项（否则一次变化会被报两遍）。`SessionManager.applyConfigOptions` 同步把值写回 `modes`，
  让 `metaOf` 等其它消费者也看到新值。完整教训见 pitfalls #34。
- **首次见到某会话只做基线**（`onSessionUpdate` 顶部播种）⇒ 打开会话不会打印"切到它本来就有的模型"。
  同理，**"从无到有"不算切换而是初始化**：会话的第一个快照是空的（`SessionManager` 那时还没有东西），
  选项列表往往随后才到——把"出现"当"切换"会给每个会话都打印一行 `Model: … · Mode: … · Reasoning effort: …`。
  `choiceChanges` 因此只在**两边都知道**这个选项、且值真的不同时才产出标签（代价是极小窗口内的切换不提示，
  而那个窗口里 picker 本身还是空的）。
- 表述：`model` → `Switched to <名字>`；`mode` → `Switched to <名字> mode`（来自 `session.modes`
  还是 category='mode' 的配置项都一样——读者不该看出差别）；其它 → `<选项名>: <值名>`
  （只说 "Switched to High" 是个谜语）。级联变更合成**一条**（` · ` 连接），model/mode 排前面。
- 渲染：`NoticeEntry['level']` 增加 `'switch'`——它是**表现形式，不是严重级别**；CSS 用左右虚线做成一行。
  **协议没有变化**（`level` 本来就在记录里）。

### 5.23 内容块审计的其余补充（074 / 075）

对 ACP 全部 11 种 `session/update` 与 5 种内容块盘过一遍，补了三处、**刻意没做**两处。

| 做了什么 | 关键点 |
|---|---|
| 工具卡显示真实工具名（074） | `kind` 是 ACP 的粗粒度词表（Run / Read），两张 "Run" 卡只能靠标题区分。夹具里 **12/12** 个工具调用都带 `_meta.claudeCode.toolName`，取出来与 kind 标签**并列**（不替换）。**chip 要可加可删可改**：`update` 路径也得调（占位卡靠 update 才拿到真实视图模型）。`_meta` 是厂商私有的，**只认这一种已知形状**、其余静默——猜第二个厂商的键就是把推断当事实（§5.6） |
| 会话标题（075 的提示已废；[163] 静默；[164] 冻结） | `session_info_update` 更新标签栏与会话历史。**075**：缓存上一次的标题、对「真正的改名」插一行 `Session renamed to “…”` —— **[163] 取消**（用户报：会话进行中自己冒出一行改名）。**[164] 标题由第一次对话定死**：① 那一刻已经拿到的自动命名就是它的名字；② 没拿到就用**第一条用户消息**（`toSummary` 的回退链 `session.title ?? stored.title ?? stored.firstPrompt`）；③ **之后任何标题都不再改**，包括几轮之后才生成的「第一个自动命名」。**冻结点 = 第二次发言那一刻**（`handleSendPrompt` 里判 `turnsDone`）——不放在「第一轮结束时」，因为 adapter 正是在 idle（轮次结束）那一刻才去读并推标题（`maybeUpdateSessionTitle` 的注释：「SDK 在后台生成标题，`idle` 是轮次结束信号，也是新标题可能已落地的时刻」），在那儿冻结会把刚生成的自动命名一起挡在门外。**判定只有一处**（`trackTitle` 返回是否收下，SessionManager 的`applySessionInfoUpdate` 跟着它走）：只挡宿主那份 map 是不够的 —— tab 的标题读的是 `session.title`（第一版就是这么漏的，两条测试抓住）。 |
| 思考块里的非文本内容（075） | `agent_thought_chunk` 带的图片/资源此前直接 `return` 丢掉。现在复用 `postContentNotice`，**但先 `finalizeEntries(only:'thought')`**：记录只并入"最后一条"，不关掉旧思考块的话它会永远停在 `Thinking…`（后续 thought chunk 会另起一条） |
| **没做**：`available_commands_update` | 斜杠菜单已经消费它，再提示纯属噪声 |
| **没做**：`usage_update` 的成本数字 / 用户消息里的非文本内容 | 前者令牌条里已有；后者在 replay 路径上从未出现过 |

### 5.26 工具卡的标题与 IN / OUT（CUSTOM-20260929-117）

对齐官方 Claude Code 面板的观感（用户拿它的截图当参照）：卡片标题是**人写的一句话**、正文按
**IN / OUT** 分段。数据来自真实抓包夹具（`claude-code-session-load.json`），不是推断：

| 关注点 | 规则 |
|---|---|
| 标题从哪来 | `rawInput.description`（模型写的描述，如 "List files in the working directory"）→ 回退 ACP 的 `title`。**用户看到的那行"Bash 查看博客目录及父目录现有内容"= 工具名 chip（074 的 `_meta.claudeCode.toolName`）+ 这段描述** |
| **为什么要在 store 里 latch** | 描述**比首帧晚到**（真夹具里是第 3 条 update），而两处来源的存活方式不同：`rawInput` 是"键在才覆盖"（描述留下了），`_meta` 是**整体替换**（`_meta.claudeCode.title` 只活在那一条 update 里）。任何"要用时再读一遍"的写法都会让标题在下一个 chunk **闪回命令行**，且没有任何报错 ⇒ `ToolInvocation.description` 只在**有值时**写入（`ToolInvocationStore.latchDescription`），`toToolCallView` 直通 |
| `title` 没被改 | 它仍是 ACP 给的原值：**IN 段显示的就是它**，rail 的 tooltip 也读它（`rail.ts` 用 `view.title`）。客户端只是把 `.tool-title` 这个**节点**的文字换成 `description || title`，悬停仍给 title |
| **对齐的两条硬规则（122）** | ①OUT 的底色与内边距**挂在内容格上，不能挂在 grid 容器上**——容器的左右内边距会把整个网格（含标签列）推右 6px（实测 IN 内容 x=65 / OUT x=71）；②工具输出里的 `pre` 必须**显式**指定编辑器字体与字号，否则回落到浏览器默认 monospace，字面宽度与左边界都与 IN 不同。修后两侧正文同起于 x=71（`#probe` 读数） |
| **IN / OUT 的排版（121）** | **左右两栏**（对齐官方插件）：`.tool-seg` 是 `grid-template-columns: 30px minmax(0,1fr)`，段标在左列、内容在右列 ⇒ 一张卡省掉两行（一轮十几张工具卡，这是可观的纵向空间）。**除标签外的每个子节点都要显式 `grid-column: 2`**，否则 auto-placement 把第二个子节点甩回第一列。工具输出里的**围栏语言标签要藏掉**（`.code-lang` + `has-lang` 给 pre 预留的 20px 顶边距）——命令输出显示 "console" 没有信息量，那片空白却很明显 |
| IN / OUT | 段标只在**有命令行**时出现（`tool.command`）：Bash 这类 execute 调用是"输入 → 输出"，正是官方的样子；Read / Edit / Search 没有输入行，**不套 OUT 标签**——那会是对调用方向的断言，而客户端并不知道。它们的正文布局与 117 之前逐字一致（零回归） |
| 默认展开还是收起 | **收起**（118 定案）：117 让"有命令行的卡"自动展开，用户否掉了——长会话会变成一堵命令输出墙。所以**每张卡都默认收起**，IN/OUT 一点即开，标题行给的是 agent 的描述，读者知道点开是什么。展开态与 caret/`aria-expanded` 由 `links.toggleBody` 统一维护 |
| **OUT 空盒子（118）** | 用户报"IN/OUT 出来了但 OUT 没内容"。两个独立的成因，都修了：①**空白文本项**照旧渲染出一个空节点（026 的规矩是空白不可见）⇒ `fillToolBody` 直接跳过它；②`rawOutput` 是 agent 在**每条**结果里都会写的字段，却从未进过视图模型 ⇒ `ToolCallView.output` 兜底渲染（**仅当 items 里没有可见项**，见 `hasVisibleItem`）。`bodySignature` 必须带 `out:`（INV-H） |
| **工具文本的 markdown 请求曾没人发（118）** | `toolCallView` 的 `mdPending` 队列**只写不读**：全项目只有 `transcriptView.flushPending` 会 `requestMarkdown()`，而它只在 assistant/thought 记录跟踪 markdown 时触发 ⇒ 工具正文的渲染请求**只在恰好后面跟着一次 assistant finalize 时**才发得出去。以工具调用结束的轮次（或 assistant 条目本来就带 html 的 replay）⇒ 工具正文**永远空白**，且没有任何报错。修法：`markdownText` 入队后 `scheduleMarkdown()`（一帧一次，合并多个 item）。**助手/思考这一侧当时漏了同一个病**：`transcriptView.markPending` 只入队，而全项目唯一的 `flushPending` 挂在 `patch()` 路径上 ⇒ 「最后一次 DOM 更新就是它自己的 append」的记录（**一轮的最后一条正是这个形状**：收尾的 revise 若晚到，或这轮根本不是本面板发起的，就再也没有 patch 了）永远等不到渲染请求，界面只剩原文，两侧还都不报错。照同一形态补上 `scheduleMarkdown()`；另给 `handleRenderMarkdown` 的静默丢弃补了一行日志 |
| 输出限高 | `.tool-seg-out` 复用 `.diff-body` 的 340px + `overflow:auto`（长输出不该把面板顶走，也不再引入第二个魔数）；**221 起子 agent 卡放大到 510px**（用户：展开后高度再放大 1/2，报告是长文） |
| **Edit/Write 卡的 diff 默认展开（223）** | 用户 2026-10-09："外层卡片默认是折叠的，里面文件的折叠希望默认展开"。Edit/Write/Delete/Move 的 diff 默认展开（`body.hidden = false`），Bash 的输出照旧默认收起（118 定案：长会话会变成一堵命令输出墙）。`aria-expanded` 与 caret 字形同步（▾ 展开 / ▸ 收起）。`captureExpansion`/`applyExpansion` 仍然保住用户手动收起的态（040 的既有机制） |
| **工具输出的 markdown 表格（218）** | 用户报"bash 输出的 md 没渲染"。事实是**渲染了**：Claude Code 把 stdout 包在一条三反引号围栏（语言标 console）里发过来，066 的规则把围栏画成**代码块**，围栏里的 md 语法因此是字面量。判据（用户 2026-10-09 选定，**刻意窄**）：**整段恰好是一条围栏 且 内容里有 GFM 表格分隔行** ⇒ 拆掉围栏、把内容交给 markdown 渲染（`toolMarkdownSource`）。于是"脚本自己打印 markdown"（例 `node scripts/x.mjs`）变真表格，而 `ls -la` / `git diff` / 代码片段照旧是代码块——拆了它们会被 md 语法吃掉（`#` 变标题、`-` 变列表、4 空格缩进变代码块）。**两个来源同一判据**：内容块的文本，与 `rawOutput` 兜底（含表格才走 markdown，否则仍是 `<pre class="tool-raw">`）。助手正文里的围栏**不动**（那是引用，不是产出）。**220 修补排版**：拿到 markdown 的工具正文宿主带 `.md` 类（否则 `.tool-text` 的 `white-space: pre-wrap` 会把 marked 输出的块间换行再渲染一遍，表格每行下多一行空白、单元格按原文折行）；`.md th/.md td` 补 `white-space: normal; word-break: keep-all`（长中文词不在词中断开）。**当日就踩了同一条地雷**：注释里写裸反引号被 `check-webview-client.mjs` 拦下 —— pitfalls #11 的复发记录 2 记上了 |
| **子 agent 的标识（219，判据已修订）** | 用户问"有的消息是主 agent 输出、有的是子 agent 输出，能区分吗"。ACP 没有"这话谁说的"字段。**首版判据选错**：只认 `_meta.claudeCode.toolResponse.agentType`，而当前适配器的 `toolResponse` 根本没有这个字段（三个日志里 `agentType` 出现 0 次）——用户当日就追问"看不出有什么差异"。**真正的判据是 `rawInput.subagent_type`**（委派调用**输入**里就写着派给谁，首帧 `tool_call` 上就有：实测 `Explore` / `Plan` / `story_editor`）；`_meta.claudeCode.toolResponse.agentType` 是更早一次载荷的形状，保留作兜底。`ToolInvocation.subagent` **必须 latch**（理由与 description 完全相同：`_meta` 整体替换，`rawInput` 只在 `tool_call` 首帧给全）→ `ToolCallView.subagent` 直通 → 客户端 `applySubagent`：卡头插 `subagent · <agentType>` chip（与 `applyToolName` 同形：可增 / 可删 / 可补丁；tooltip 给已知细节），无命令行的卡正文段标成 **'Sub-agent report'**。`bodySignature` 补 `sub:`（INV-H）。**没有两个已知键就当不是委派**，绝不猜 |
| **工具自己报的耗时（221）** | `toolResponse.elapsedTimeSeconds` 只在**完成的那一条** update 里出现一次（与 `subagent_type` 同形），所以 latch 而不是按需读。卡头的耗时显示优先用它，没有才回退到 `elapsedMs`（`endedAt - startedAt`，含传输与渲染开销）；tooltip 标注来源（'Reported by the tool' vs 'This tool call took'） |
| **子 agent chip 的 tooltip 带指令（222）** | `rawInput.prompt` 在首帧 `tool_call` 上就有（与 `subagent_type` 同帧），截断到 ~200 字进 tooltip。完整版本来就在卡片的正文里（Agent 调用的第一个内容块就是 prompt 本身），这里只是让 tooltip 能回答"我让它去干什么" |
| **思考 token 的兜底显示（224）** | ACP 的 `Usage` 类型里有 `thoughtTokens` 字段，但实测当前适配器发过来的 `usage_update` 只有 `used` / `size` / `_meta._claude/model` —— 没有 `thoughtTokens`。所以是**兜底显示**：有就加在 tooltip 里（`· Nk thinking`），没有就不显示。不猜、不编一个数 |
| 测试 | 客户端 4 条（描述回退 / update 路径补上描述 / IN-OUT 分段与默认展开 / 无命令行卡不变）+ 宿主 3 条（latch 跨 `_meta` 替换存活、无描述就是无描述、真夹具 live 流把 description 送到 webview）；**218 再加 2 条客户端**（含表格 ⇒ 交出去的是无围栏内容；不含 ⇒ 围栏保留）、**219 再加 3 条客户端 + 3 条宿主**（chip 文本 / tooltip / 正文段标、update 路径补上 chip、无委派就没有 chip；身份 latch、没有 agentType 就不算、身份一路走到视图模型） |
| 观感证据 | `preview-records.mjs` 的夹具里有两条 Bash（一条带描述、一条没有），真 Chromium 截图即验收（pitfall #31） |

---

### 5.25 置顶本轮提问（102 首版，103 收紧判据，104 吸顶交棒 + 悬浮卡片 + 收缩，105 对齐/高亮/铺满，166 判据再改 + 收缩按会话，167 三角真凶 + TOP_GAP=3，169 删左侧小方块，171 折叠走原生 details，**172 改成整段前缀 = 推挤 + 抽回**）

**一句话**：**活动前缀**（顶边越过判定线的**每一条**用户消息）各有一张卡片，每条按"这一轮的结束
位置"落位 —— 新提问的顶边碰到旧卡底边时两张一起悬浮，继续滚旧卡被逐渐顶出上沿，反向滚动时旧卡
又从上沿抽回。本体一律让位（`visibility: hidden`），副本接管原处。

| 关注点 | 规则 |
|---|---|
| 判据（172 定稿） | `natural = node.offsetTop - scrollTop`；`natural < TOP_GAP`（严格；**167 起 TOP_GAP = 3px**）的是**候选**，取**整段前缀**（102/166 只取最后一条）。
走到第一条没进窗口的就收工（它之后只会更低），而它的 `natural` 同时是前缀末条的**上夹**（顺手多读一次 offsetTop，与 104 的开销相同）。**103 的两条旧规则都已作废**：
"完全离开视口"（102）与"视口里有更晚的提问就不置顶"（103）—— 后者被用户推翻，理由是
反例很常见：视口中间摆着一条提问、更早那条已经滚上去，那时什么都不钉，读者就找不到"我上面那条问的是什么" |
| 落位（172） | `top = min(TOP_GAP, 上夹 - 本卡高)`；上夹 = **下一条用户消息的 natural**（前缀内取下一候选；前缀末条取那条 follow；没有下一条就没有上夹）。这就是原生 `position: sticky` 分区头的等价式，**逐条独立，不是链式递推** | **[181] 上夹再减 `CARD_GAP(8)`**：卡底与它顶住的那条之间留一条缝（172 是无缝相接，用户 2026-10-04 报"间隔太近、叠到了一起"） |
| **为什么上夹锚"自然位置"** | 锚"下一条**已渲染**的位置"会让旧卡底边永远停在钉住那条的顶上 ⇒ 旧卡**永久残留一条边**、永远"看不到全部消失"，与用户"直到卡片 A 看不到"直接冲突（把这条记进 pitfalls #40）。锚自然位置（布局量，随滚动线性减小）才会一路滑成负值、被 `overflow: hidden` 裁掉 |
| "两张一起悬浮"是怎么来的 | 过渡帧里旧卡被顶着往上走，而新卡**还在自己的自然位置上**（它没进前缀 ⇒ **不需要副本**，本体就在那儿）—— 看上去就是"两张卡相接"，其实只有一张是克隆体。新卡越线后才接管（≤TOP_GAP 的窗口，与 104 的交接窗同一个常量）。用户要的"旧卡底边 == 判定线"在公式里**逐字成立**：`top + 卡高 == 下一条的 natural` |
| 卡片不再唯一（172） | 每张卡 = `.sticky-card > .sticky-body > 克隆体`，由 `stickyUser.ts` 按条动态建 —— `body.ts` 只留空的 `#stickyUser`（固定 id 的 `#stickyCard`/`#stickyBody` 会撞成重复 id）。折叠仍走克隆体自己的原生 `<details>`（171） |
| 隐藏本体 | `.messages .sticky-source { visibility: hidden }`。**visibility 不是 display**：几何必须保住 —— rail 按 `getBoundingClientRect` 逐节点测量、`NS.scroll.jumpTo` 的 `node.offsetTop` 都还依赖它。**前缀 `.messages` 是承重的**：`cloneNode` 连 `class` 一起复制，去掉前缀副本也会被藏起来（悬浮条"打不开了"，静默）；`buildCard` 另有一道同因防线（显式摘类）。172 起是**集合式 diff**（同钉两张时两张本体都要让位），每帧幂等重贴；user 条目节点不会被 `replaceChild` 换掉，但仍留这一层，因为漏掉的代价是"本体和副本同屏"这种静默的错 |
| 位置怎么落地（172） | 卡片留在**文档流**里（host 是 flex 列），每张写 `marginTop = top - 前一张的实际底边`（第 0 张相对 host 的 `padding-top`，可为负 ⇒ 越过上沿被裁掉，那就是"被顶出去"）。按**实际底边**而不是链式累加：卡高含 2px 边框、还可能被收成一行，累加常量会从第二张开始漂（pitfall #24 的正解：锚已经在正确位置的那张） |
| 高度上限（172） | **去掉了 `max-height: 40%`**：卡堆里它裁掉的是**最下面、也就是最新**的那张（读者最需要的那页）。现在高度由内容决定，`overflow: hidden` 只负责裁上沿 |
| 为什么**没有阈值** | 用户选定"露出一像素就算在显示区"。单一阈值 ⇒ 同一画面从不同方向到达结果相同、不会闪；"露出超过 X 才不置顶"是量出来的常量，换面板高度/字号就错位（pitfalls #24/#26）。102 的 8px 容差已在 103 去掉 |
| 为什么不用**滚动方向** | 判据只依赖当前画面。记住方向会让同一画面从不同来向显示不同结果 |
| 横向范围 | `#stickyUser` 与 `#messages` 同属 **`.messages-column`**（103 新增的定位容器）。102 时它是 `.message-area` 那一 flex 行的兄弟，而该行还有**定宽可拖拽**的大纲栏 ⇒ 覆盖层横跨两段、右边伸进大纲栏下面。挪进容器后由**构造**保证不越界。该列 132 一度限过宽、**137 已撤销**（见 §5.31）：sticky 是列的绝对定位子元素，宽度始终跟着列走；`alignToContent()` 量的仍是滚动条宽（`offsetWidth − clientWidth`，与列宽无关），照旧成立。`#jumpToLatest` 也在 132 搬进了该列 |
| 三层结构（104/107） | `.sticky-user`＝定位层（透明、`pointer-events:none`，卡片周围的内容与点击都透过去）→ `.sticky-card`＝外观层（底色/圆角/**2px `--vscode-foreground` 边框**/阴影；107 起描边回到真 `border`，位移由 host 的 padding 差 2px 补偿）→ `.sticky-body`＝克隆体的 flex 列（`align-self` 必需） |
| 对齐（105，用户报"还是没对齐"） | 卡片右缘要让开**滚动条**：`.messages` 是滚动容器，`scrollbar-width: thin` 照样占布局宽度 ⇒ 消息的内容盒比消息列窄几像素，而悬浮条不是滚动容器。`alignToContent()` 用 `offsetWidth - clientWidth` 量出来写进 host 的 `right`（没有滚动条就是 0）。**别换成常量**——它随滚动条出现/消失、随主题与字号变（pitfall #24 的反面：锚真实几何） |
| 用户消息铺满（105） | `.entry-user { align-self: stretch }`（原 `flex-end` + `max-width:88%`）。气泡宽度=内容宽度时，折叠后只剩首行、宽度随之缩短，面板在折/展时会自己变窄；铺满后宽度是常量，折与不折只影响高度。这**同时决定**了卡片里有没有空档给内容 |
| 排版一致性 | 用户气泡的宽度 = 卡片的内容盒宽度，而卡片的内容盒由"`.messages` 的内边距 + 107 的 2px 边框补偿 + 105 的滚动条让位"三者共同决定；水平内边距必须与 `.messages` 相同（左 19 / 右 10），否则克隆体会整体偏移。103 修的是 flex 基准，105 修的是这层横向几何 |
| `TOP_GAP` 只有一个来源 | 它既是布局（JS 写进 host 的 inline `padding-top`）又是交棒窗口。两者必须相等，否则每次交棒都带一段位移 ⇒ 由 JS 写，CSS 不写 padding-top（pitfall #19） |
| 收缩（169/171/172） | 控件是卡片里的折叠三角（169 删掉了卡片左侧那个小方块）。它走**原生 `<details>`**（171）：浏览器开合，"收成一行"、"图片/文件与文字同行"这些规则全是现成的；`toggle` 事件把状态记回 `collapsedBySession[sessionId][entryId]` —— **按会话 + 按卡**（172；判据即 pitfalls #38 的"用户说每个 X 自己保持，代码里就该出现 byX"）。卡的折叠改变卡高 ⇒ 记账后要重量、重排 |
| 跳转（170/171/172） | 落点 `NS.scroll.jumpTo(node, 0)`：**在交接窗口之内**（0 ≤ natural < TOP_GAP），消息就地接管卡片的位置、本体让位 ⇒ 既不重叠也不偏下。170 的"让开卡高"解反了：那让开的是**别的东西占着的位置**。172 起目标取自**被点那张卡**的 `data-sticky-id`（每张卡各代表一条消息） |
| 渲染状态 | 克隆体不在 `#messages` 里，`.messages.show-times` 这类**状态类选择器够不着它** ⇒ `sync()` 把 `show-times` 抄到 host（用 `classList.toggle`：整体重写 `host.className` 会抹掉各卡身上的 `.entering`），`boot.applyTimes` 之后调 `NS.stickyUser.refresh()` 重建。**再加新的"挂在 `#messages` 上的渲染开关"时，别忘了这里也要抄一份** |
| 成本（172） | 一帧一次（`dom.schedule` + `syncQueued` 去重，流式 chunk 也会触发）。热路径**先读后写**：一次读完 scrollTop / 各 offsetTop / 没量过的高度，纯算术算完所有 top，再统一写 `marginTop` 与 class。克隆**按条缓存**，只有 `.fold-body` 这个结构信号变了才重建（拿高度做信号会每帧强制重排）。被顶出上沿、且超出 `KEEP_MARGIN`(24px) 的卡**不渲染**（但仍在上夹计算里 —— 它是上一条的上夹来源）；`KEEP_MARGIN` 只为省掉交界线上的克隆抖动，不改变画面（留着的那张整条在 y<0） |
| 维护提示 | 判据依赖 `node.offsetTop` 与 `#messages` 的 `scrollTop` **在同一坐标系**。当前靠"节点与 `#messages` 同处 `.messages-column`"成立——**给 `#messages` 或那条链上新加带 `position` 的祖先时要重新核对**（`NS.scroll.jumpTo` 的 `node.offsetTop - container.offsetTop` 是同一个前提） |

案例钉在 `src/test/chat-client.test.ts`「image chip and pinned question」一组里（172 起含：相接、
推挤、顶出后不再渲染、抽回、方向无关、集合式 source、按卡跳转、按卡折叠、卡堆不变式）。**桩要如实
建模三件事**，否则这些会假通过/假失败：①卡片由客户端动态建（`#stickyUser > .sticky-card >
.sticky-body > 克隆体`；不再有固定的 `#stickyCard`/`#stickyBody`，169 起也没有 `#stickyToggle`）；
②`#messages` 的 `offsetTop` 基准（首条记录在 `offsetTop = 8`，正是"停在最上面的提问不被接管"那条
的判据）；③`insertBefore` 的**移动**语义（pitfall #41 —— 桩漏了它，卡堆重排会被静默打乱）。
做过 RED 验证，每次失败的都正好是应该失败的那几条：把上夹改回"下一条已渲染的位置" ⇒ 推挤/顶出红；
`markSources` 改空实现 ⇒ 集合式 source 红；去掉可见过滤 ⇒"顶出后不再渲染"红；
去掉 `alignToContent()` ⇒"the stack ends where the messages end"红。

### 5.29 记录时刻的位置与上下文用量（CUSTOM-20260930-129）

用户在复验 123 时提的三条界面调整。

| 关注点 | 规则 |
|---|---|
| 时刻挂在**标题行**里 | `.rec-time` 绝对定位浮在记录右上角，但**DOM 上必须位于标题行之内**（工具卡是 `.tool-head` 的一项，其余进 `summary`）——折叠的 `details` 会隐藏 summary 之外的一切，挂在记录节点上的话折叠态就看不到时刻了。`.messages > *` 因此要有 `position: relative`。工具卡用 `appendChild`（跟在耗时之后 ⇒ `2.2s 11:57`），其余用 `insertBefore(…, summary.firstChild)`（绝对定位下 DOM 顺序无关，这样能保住"正文是 summary 最后一个子节点"这条既有约束） |
| 顶部进度条已删除 | `#usageBar` / `tabs.renderUsage` / `.usage-bar` `.usage-track` `.usage-fill` 全部删掉；**成本**信息移进底部圆环的 tooltip。上下文用量现在只有一处呈现 |
| 底部圆环 | 24px 的两圈 SVG。内圈 = 进度（`stroke-dashoffset` 由 JS 按百分比算好，`rotate(-90deg)` 把起点挪到 12 点方向），圆心 = 百分比数字（不带 `%`），配色沿用 0.7 / 0.9 两档。**外圈 = "有轮次在跑"**：一段 1/4 弧缓慢旋转，用 `currentColor`（**不是**进度的蓝色——同色会被读成两根进度条），半径比内圈大 2.5（只差 1.5 时两环贴在一起，读不出是"外圈"）。数据仍是 `meta.usage`；`setRunning` 是外圈的唯一开关，而那条路径拿不到 `meta`，所以 composer 自己留了一份 `lastUsage` |
| 圆环的数字从哪来（185） | **唯一写入者是 `usage_update`**（`used` = 当前上下文 token 数，`size` = 窗口大小）。185 之前这里还有第二个写入者：`PromptResponse.usage.totalTokens` 被折进 `used` —— 那是**单位张冠李戴**，协议里该字段是 *Sum of all token types across session*（claude-agent-acp 每轮 `+= input/output/cache_read/cache_write`），只增不减，于是长会话出现 `1841k / 1000k` 这种"超过上限"的读数。**要展示会话累计量就另开字段，别复用 `used`**（pitfall #48）。另外 tooltip 里的金额是 agent 给的裸浮点，展示前 `toFixed(2)` |
| **外圈动画不能被"重建"（190）** | 外圈那条 CSS 动画**靠节点活着**：重建 `<svg>` 等于让动画从 0 重新开始。而 `renderContext` 原来每次都重建，`setRunning` 又由 `sessionsChanged` 驱动、宿主**每个 `agent_message_chunk` 都 `refreshSessions()`** ⇒ 流式期间每秒重建几十次 ⇒ 外圈永远停在起点角度（用户报的"任务进行中时闪烁失效，只剩下面多了一段圆环"）。修法：**数字没变就不重建**（`drawnGauge` 记住上次画的 used/size），只改 class/title —— 于是 `setRunning` 只翻 `running` 类。验收档 `#gauge-rebuild`（判据是**节点身份**，见 pitfalls #51：无头里量不了动效本身） |
| 视觉验收 | `preview-records.mjs` 的 `#times` / `#timescollapsed` / `#gauge`（外加 `#gaugewarn` / `#gaugehot` / `#gaugebusy` / `#gaugebig`）。**圆环的配色与外圈半径都是看图才改对的**——布局与观感不靠推（pitfall #31） |

### 5.30 标签状态点：颜色说状态，外圈说"正在做事"（CUSTOM-20260930-130）

**分工**（用户指定）：圆点的**颜色**表达这个会话处在什么状态，圆点外的**涟漪圈**表达"它正在做事"。
两者必须独立 —— 一个卡在权限提示上的轮次两件事同时为真（在跑 **+** 在等人），挤进同一个信号就必然丢掉一件。

| 状态 | 颜色 | 外圈 |
|---|---|---|
| 等人回答（权限 / 表单） | 橙 `--vscode-charts-orange` | 有（轮次通常还在跑） |
| 轮次在跑 | 蓝 `--vscode-progressBar-background` | 有 |
| 载入历史（replay） | 黄 `--vscode-charts-yellow` | 有 |
| 后台有新输出（unread） | 蓝 `--vscode-charts-blue` | 无 —— 它是关于**过去**的提示，不是当下的活动 |
| 平常 | 灰 `--vscode-descriptionForeground` | 无 |

- **数据**：`waiting` 从两个桥的 `hasPendingFor(sessionId)` 读 —— **桥才是 pending 的唯一持有者**，
  宿主不存第二份（pitfalls #19）。
- **必须计入 `refreshSessions` 的签名**：数据变了而签名没变 ⇒ 标签栏永远不刷新。这条在 022（unread）
  与 063 上各踩过一次，警告就写在签名旁边。
- **样式**：颜色走 `color` + `background: currentColor`，外圈的 `border-color` 用同一个 `currentColor` ——
  颜色只有一个来源，改一处就够。
- 另：就绪卡的标题是 **`Claude Code is ready`** 而不是 `Connected to Claude Code` —— 后者与
  `Connect to Claude Code` 只差一个字母，扫读时会被读成"还需要连接"。

### 5.41 置顶卡四改：跳转落点 / 折叠同步 / 长会话量测 / 卡堆的缝（CUSTOM-20261004-178..181）

**① 点卡片跳转的落点（178）**。三次演化，都写在 `stickyUser.ts` 的注释里：

| 版本 | clearance | 结果 |
|---|---|---|
| 170 | `host.offsetHeight + TOP_GAP + 2` | 消息落在条**下面**、不重叠；但 host 是 absolute 覆盖层、高度含**已被顶出屏幕**的卡 ⇒ 上方卡一多就把消息推得很低（"定位偏下"） |
| 171 | `0` | 消息就地接管悬浮条的位置；代价是那条**仍在活动前缀里** ⇒ 本体隐藏、克隆体站原位 ⇒ 用户看到的仍是悬浮样式 |
| **178** | `TOP_GAP + STACK_SEAM(2)` | 推过判定线一点点：这条成为 `found.follow` ⇒ 本体**不再被接管**（真实消息显示在最顶），上方卡堆按 `layout()` 的 `top = min(TOP_GAP, next.natural - h)` **自己滑出上沿** |

关键认识：**不需要额外的抑制态，也不需要量"屏幕外那些卡"的高度** —— 落点一过线，既有公式就把整堆卡推到负 y、被 host 的 `overflow:hidden` 裁掉。另新增 `NS.stickyUser.stackInfo()`（可见卡堆的 `top`/`bottom`/`cards`）：这才是"落点有没有被盖住"该问的量（170 问错了对象）。
实测（真 Chromium）：`nodeNatural 5 / targetVisibility visible / overlap false / 卡堆 -5..60`（底边正好接上消息顶边）。

**② 折叠状态只有一份（179）**。用户要"卡片与消息保持一致"，而两边原先各存一份（记录侧**根本没存**，卡片侧有自己的 `collapsedBySession`）⇒ 必然漂（pitfall #19）。现在：

- 真相在**记录层**：`transcriptView` 的 `foldBySession[会话][条目]`，粒度沿用 166/172；`reset()` **不清**它（切会话回来还要用）；会话由 boot 的焦点咽喉点（`stickyUser.setSession` → `setFoldSession`）同步。
- 唯一写入入口 `setUserCollapsed(entryId, collapsed)`：写存储 → 应用给**记录本体** → 通知置顶卡（`onFoldChanged`）→ 刷 `scroll.reflowNow()`（176）与 `outline.invalidate()`。**幂等守卫**（写同值直接返回）打断"程序化改 `details.open` → 再触发一次 toggle → 又回写"的来回震荡。
- **`toggle` 不冒泡** ⇒ 记录侧只能在 `buildUserBubble`（唯一造 user-fold 的地方）逐节点挂监听；`stickyUser` 那侧同理（克隆体在 `buildCard` 里挂）。
- ⚠️ **验证时注意**：`<details>` 的 toggle 事件是**异步派发**的，探针在同一同步块里读会得出"没同步"的错觉 —— 采样必须延时（`#stickynarrowstickyclickprobe` 的延时行）。

**③ 长会话里的量测（180）**。

- **rail.measure() 读写分离**：旧版边读边写（读一次 `getBoundingClientRect` → 写一次 `dot.style.top`），任何样式写都让下一次布局读**强制重排** ⇒ n 个标记 = n 次强制重排。现在 ① 只读（容器几何 + 每个节点的一行中心）② 只写（hidden / top / 线），输出逐字不变。**性质由桩单测钉住**（记一条读写时间线，断言"写→读"来回只剩常数次）。
- **置顶条用户列表按内容版本缓存**：`userEntries()` 原先每帧 + 每次折叠都走一遍 `ordered()` 全表；`transcriptView.version()` 在 `place()`/`reset()` 自增，缓存据此失效 —— pitfall #27 的正解（让**会改它的代码**举手）。
- **不做虚拟列表**（用户拍板）：它会同时打破 rail 的逐条圆点、大纲锚点、按会话的**绝对** `scrollTop` 记忆、置顶卡依赖"下一条记录的自然位置"的上夹（pitfall #40）、工具卡分组与 `node(id)` 五处不变量。
- ⚠️ **测量教训**：无头预览跑在 `--virtual-time-budget` 下，`performance.now()` 是虚拟时钟（量出 3010ms 是假的）；"数强制重排"又会被 `NS.dom.schedule` 的"已有一帧在排就只入队"挡住（无头下真 rAF 未必送达 ⇒ 那一帧永远挂着）。**结论：涉及帧机制的代价，用桩单测钉结构性质，别在无头里追毫秒**。

**④ 卡堆的缝（181）**。172 的"推挤"是**严丝合缝**（`top = next.natural - h` ⇒ 卡底正好压在下一条的顶边上，探针里 `contact: true`），为的是看着连续；但用户用下来报"间隔太近、叠到了一起"。现在在上夹里再减一个 `CARD_GAP = 8`：卡底与它顶住的那条之间留 8px，三种情形一起受益（卡与卡、最后一张卡与它顶住的用户消息、以及被顶出上沿的过程）。**只改上夹** —— `TOP_GAP`（判定线/交接窗）不动，那是"什么时候接管"，是另一件事。实测（`#stickystackpushprobe`）：旧卡 `bottom 22` / `nextUserTop 30` ⇒ 缝 8px、`contact: false`。

### 5.47 文件引用的三种呈现（CUSTOM-20261008-206..208、20261009-214）

用户提的三条，其实是"文件引用"在三个位置上的形状问题：

**① 用户气泡里的文件 chip 与 caret 同栏（气泡内）**。108/112 的"chip 与图标同在第一行"只做给了
**图片** chip：CSS 的 flex 判据是 `summary:has(.content-image-chip)`，而文件 chip 外面还套着一个
`.chip-row`（块级 div）⇒ 它自己占一行（用户报"引用的文件 Tag 应该放在折叠按钮同栏"）。
修法两条一起：flex 判据补上 `:has(.chip-row)`，并让那层包装**不占盒**（`.entry-user ... .chip-row
{ display: contents }`，于是 chip 自己成为 flex 项）。同一轮把 tag **加高**（`.chip` 默认 `padding: 0 5px`
是零纵向内边距，文件名被上下描边紧压着）并加上 `</>` 图标（`NS.icons` 新增 `file` 形状；只给**本地文件**
chip 加 —— 真链接给代码图标会误导）。实测：`caretTop 85 / chipTop 86`（同栏）、tag 高 16→23px。

**② 输入框引用栏里的「编辑器当前文件」格**：宿主订阅 `onDidChangeActiveTextEditor` /
`onDidChangeTextEditorSelection`，把当前文件 + 多行选区的行区间推给客户端（`activeFile` 消息，
**非会话作用域**、两个面都发）；客户端在 `#attachments` 那一行渲染一格：
`+` 开关 + 文件 tag（图标 + 文件名 + `:12-40`）—— **214 起只剩"还没引用"这一态**（已引用时
整格不出现，见下 ②d；206 时的 `×` 与 208 的两态配色已退役）。

- **已引用与否从附件列表现算**（`state.attachments` 里有没有同 `path` 的一条），不另存一份状态：
  宿主的 `attachments` 回复一到，`+` 自己变 `×`（pitfall #19 的老规矩）。
- **点 `+` 的路径**：会话页发 `attachPath`（新增 `meta`，与 `paths` 下标平行，带显示名与行区间）；
  草稿页走 193 的本地列表（`addDraftPaths(paths, meta)`）—— 草稿没有会话，会话作用域的消息会被宿主丢掉。
- **点 `×`**：会话页 `detachFile`；草稿页就地删本地那份。
- **tag 本体可点**（`data-path` → 既有的 `openFile` 通道，与记录里的文件 chip 一致）。
- **行区间**：`readActiveFileFrom(editor)` 把 0 基行号换成 1 基，并处理"拖到下一行行首不算那一行"
  （与编辑器自己的显示一致）；单行选区不带区间。**抽成接收结构子集的纯函数**是为了可测 —— 真
  `vscode.window.activeTextEditor` 在测试宿主里造不出来（同 `pickDefaultCwd` 的既有做法）。
- **推的方式**：按"路径 + 行区间"签名去重（`onDidChangeTextEditorSelection` 每次光标移动都回调，
  叠成行号之后同一行里动就不发），面刚挂上来时 `force` 推一次（签名是全局的，第二个面不该因为
  "另一个面拿过了"而拿不到）。

**③ agent 也看得到行区间**：发送时把区间挂进资源链接的 uri 片段
（`file:///….cs#L12-40`，`name` 里已经有给人看的 `文件名:12-40`）—— 不认片段的实现照旧忽略它。

**②b 三条修正（207）**：①气泡里那个 `</>` 图标**插在最前面** —— 原来 `el('button','chip', text)`
已经把文件名写进去了，`appendChild` 会把图标放到名字**后面**（用户截图就是反的），改成
`insertBefore(icon, firstChild)`；②引用栏那个开关**排在 tag 之后**（与附件 chip 的 `×` 一致）；③**同一个
文件支持引用多段** —— 同一性从"路径"改成"路径 + 行区间"（`sameRef`），于是"当前框选与已引用的不同 ⇒
显示 `+`（可以再引用一段）、相同 ⇒ `×`（点它只摘这一段）"。为此宿主两处按路径写的判断必须跟着改：
`addAttachments` 的去重（原来同文件的第二段**根本入不了列**）与 `detachFile`（原来会把这个文件的**所有**段
一起摘掉）；`detachFile` 因此加上可选区间（带 = 只摘那一段，不带 = 整条路径全摘，拖拽/粘贴的旧行为不变）。
顺带修了草稿页的投影函数 `draftFilesOf` —— 它只手抄了 `{id,kind,name,path}`，区间在投影时掉了，
"这一段加过没有"永远答"没有"（见 pitfalls #58）。

**②c 两态一个 chip（208）**：开关（`+`/`×`）**收进 chip 里面**（原来露在 tag 外面，用户嫌突兀），
外层 `.ref-chip` 负责描边 + 底色，里面是**两个平级的真按钮**（`.ref-tag` 点开文件 / `.ref-toggle` 切换引用）
—— button 里不能嵌 button，所以是平级而不是嵌套，键盘各自可达。两态用底色 + 描边一起区分：
**预选**（还没引用）= 中性 chip 底色**混入**主题强调色（`color-mix`，见 pitfalls #59）+ **虚线**；
**已引用** = 与其它附件 chip 同观感（`--vscode-textCodeBlock-background` + 实线）。

**②d 已引用不再重复显示 + 附件 chip 补图标 + × 按同一性摘（214）**：用户报两条 ——
①编辑器里重复选择已引用的（同文件、或同文件 + 同行区间）时，引用栏那格与附件行里的 chip
**同一条显示两遍**（截图里两枚一模一样的 tag）；②已添加引用的文件 tag 左侧**没有图标**。
修法：`renderAttachments` 只在这条**还没引用**时才渲染引用格（`!isReferenced(activeFile)`）——
于是"已引用"那一态连同 `.ref-on` 配色、`.ref-toggle` 的 `×` 分支与 `detachReference` 一起退役
（别留没有写者的死 CSS，pitfall #20）；文件附件 chip 补上与引用格同一枚 `</>` 图标；
**附件 chip 的 `×` 顺势改成按"路径 + 区间"同一性摘**（`sameRef`）——它此前是唯一按整路径摘的
出口（宿主 `detachFile` 不带区间 = 该路径**全摘**），引用格的 `×` 退役后它就是唯一摘除口，
不修的话"点 5-9 那段的 × 会把 12-40 一起带走"。

**验收**：客户端桩（出现 `+` / 行区间进 `meta` / 宿主回复后**引用格消失**且附件 chip 带图标、
点附件 `×` 走带区间的 `detachFile` / 草稿页攒本地并同样按同一性摘）；宿主 4 条（无编辑器与
非本地文件 ⇒ 不显示、整文件、1 基行区间与"下一行行首"边界、`attachPath` 的 meta → 附件与发送时的
uri 片段）；真 Chromium 的 `#refchip` 档（`toggle:'+'`、`label`、`href` 为真实路径、
**翻转后 `refChipAfterAttach:false` + `attachmentIconAfterAttach:true`**）+ `#filechip` 档
（气泡里的文件 chip：`caretTop/chipTop` 同栏、`chipH`、`hasIcon`）。

### 5.49 「尾巴被输入卡压住」的按结果自愈、可见性重判与日志轮转（CUSTOM-20261009-210）

**症状**（用户 2026-10-09 第三次报，截图在 aki_work 会话）：滚动条已触底、消息却没拉到底部 ——
到底时最后一条记录被悬浮输入卡压住，而且**滚无可滚**。像素量化：截图刻底部留白只剩 ~24px
（变量的缺省值），而卡片实高 ~80–104px ⇒ `--vac-composer-h` 停在 0 而卡片可见。

**根因**：见 pitfalls #62 —— 该变量的唯一写者是 `composer.ts` 的 ResizeObserver，
而 display:none 循环（相位切换 / 文档不渲染的时段）里真 Chromium 的 RO 只回调初始一次，
hide 与恢复都不报。"变量=0 而卡片可见"于是可达。

**三层修法（都在 `html/client/` 里）**：
- **①按结果自愈**：`scroll.ts` 新增 `healIfTailCovered(distance)`，由 `recompute()` 收尾调用
  （每次 scroll 均跑）。前置**两条**（缺一不可）：**真在滚动范围末尾**（`st ≥ max − 1`）＋
  **贴底态**（`distance < PIN_THRESHOLD`）；然后在末条记录与 `#composer` 两个 `getBoundingClientRect`
  上判 `last.bottom > composer.top + 1` 且卡片可见（height > 0）⇒ 记一行 `tail-covered-heal`
  （强制、记的是**修复前**的现场）并调 `NS.composer.refreshHeight()`。
  ⚠️ **at-max 门槛是 2026-10-09 用户实测倒逼出来的**：首版只在 `distance<32` 判，于是从底部
  上滚一格（尾巴刚离开卡片上方、st 还在阈值内）被误判成"被压住"⇒ 自愈 reflow 把视口拉回底部
  ⇒ **滚轮一格都推不上去**（用户报"滚动滚不上去了，会被自动拉回去"）。修复面必须收窄到病灶格。
  `healing` 闸门保证一条 recompute 链只尝试一次（重写变量 → reflow → 再次 recompute 不会打转）。
  桩 DOM 的判空链（`NS.dom.qs` / `NS.composer` 缺席）先短路，别把客户端逻辑测试打红。
- **②写者自己重取**：`composer.ts` 的 `watchHeight` 在 `visibilitychange`（回到 visible）与
  `window resize` 上再跑一次 `apply()`；并把 `apply` 以 `NS.composer.refreshHeight` 暴露出去
  （判据在滚动侧、写口在这里，唯一写者不变）。`apply` 幂等：值没变时 `noteGeometry` 去重、
  `setProperty` 同值、`reflowNow` 只在贴底时写一次 scrollTop。
- **③pin 重判**：`scroll.ts` 的 `init` 在同样的两个钩子上跑 `reflow()` —— 贴底者被带回新底部，
  没贴底者只刷新 pin/Jump（不抢视口）。日志里另有一条：`pin=1` 却停在 `st=418/6781` 卡了五分钟
  （192 的"某个量在说谎"现场），同一根因（文档不渲染的时段没有 scroll 事件）。顺带把 `reflow()`
  里的裸 `container.scrollTop =` 换成 `writeTop()`（192 的规矩：程序写走同一个出口，
  否则它引发的 scroll 事件会被误标成 user-scroll）。

**日志轮转**：`Logger.ts` 的超限处置从 **truncate 到 0** 改成**轮转**（超限时改名成 `.log.1`，
只留一份备份）—— 2026-10-09 那次清零恰好毁掉了要查的现场（pitfalls #61 有完整推理链）。

**验收**：桩 DOM 4 条（`mountHeal`：被压住重测 / 健康不打扰 / 上翻不重测 / 卡片隐藏不关它的事，
`src/test/chat-client.test.ts` 的 176 套件内）＋ 真 Chromium 的 `#composerbottomtailprobe`
（把 `--vac-composer-h` 人为踩回 0px → 滚到底派发 scroll → 读 `varAfter` 回到真实高度、
`covered=false`、`lastGap ≥ 卡片高`；截图档 `tail-covered.png`）。

### 5.50 右键菜单的四个上下文格 与 历史列表行的悬停动作（CUSTOM-20261009-211/212）

**右键菜单**（`contextMenu.ts` 的 `itemsFor`，四个专属分支**排在通用清单之前** —— 通用那条
`Copy` 复制的是**选区**、无选区时禁用，而用户报的"有个 Copy 但点不动"正是这几处）：
- **大纲行**（`.outline-item[data-jump-id]`）：`Copy` = 这一条的**正文**（`transcriptView.entry(id).text`，
  取不到时退回行上可见文本）——不是选区，也不需要选区；
- **地址栏**（`.session-title`，即 body.ts 的 `#cwdBtn`；用类选择器是为了桩 DOM 也认）：
  `Copy` = `NS.tabs.currentCwd()`（拿不到退回按钮文本 —— 草稿页它可能是 "Default directory"）；
- **会话 tab**（`.tab`）：`Close`（= tab 上的 × 同一条路，`NS.tabs.closeTabNode` 按 kind 分派
  草稿=丢弃 / 待恢复=本地忘掉 / 真会话=closeSession）＋ `Rename`（仅真会话 tab，改名见下）；
- **历史列表行**（`.outline-item[data-open-session]`）：`Archive` / `Rename` —— 悬停图标够不着的
  键盘用户（Shift+F10）走这里同一对动作、同一个出口。

**会话 tab 的两个菜单项（211）**：`Close` = `NS.tabs.closeTabNode`（按 kind 分派：草稿=丢弃 /
待恢复=本地忘掉 / 真会话=closeSession，与 tab 上的 × 同一条路）；`Rename` = 发 212 的
`renameSession {sessionId, currentTitle}`（初值取 `.tab-label` 上**看得见**的标题，同源原则），
改名由宿主弹原生输入框，回执后 `refreshSessions` 把新标题经 `sessionsChanged` 推回来 —— tab
自己也就换了名字。**首版曾按用户早先口述做了 `Remove`（归档+忘掉+关闭），用户随后更正
"要的是 Rename 不是 Remove"，已整条删除**（包含 `removeSession` 消息）。

**历史行的悬停动作（212，仅悬停显示）**：`sessionMenu.renderList` 把每行包进
`.session-row`（`position: relative`），动作层 `.row-actions` 是**行的兄弟**（button 不能嵌
button；行仍是真 `<button>`）绝对定位浮在右端，默认 `opacity:0; pointer-events:none`，
`.session-row:hover / :focus-within` 才现身；两个动作是真 button 但 `tabIndex=-1`（与 tab 的 ×
出 tab 序同一先例，089）。点击**只发消息**（`archiveSession` / `renameSession {currentTitle}`），
等宿主做完回 `sessionAction` 再 `applyAction` **就地**改 `lastMessage.sessions` 重渲染
（归档摘行 / 改名换标签，计数与过滤都跟着走）——**不重发整份 history**：那会经 `setHistory`
按 askedCwd 重派生 filterKey，把手选的目录过滤重置掉；也不做乐观更新（#29 那类"界面变了、
宿主没做成"的不一致）。

**宿主侧（212）**：`renameSession` / `archiveSession` 两条**必须在 verifySession 守卫之前**
（列表里的行大多不是活会话）。覆盖存在 `globalState` 的 `vac.sessionLabels.v1`
（`{sessionId: {title?, archived?}}` —— 按 id 记、与来源无关；不写 SessionHistoryStore：
它只覆盖本地那一段且 memento key 冻结）。生效点两处：`postHistory` 与
`handleSupplementHistory`（唯一装配点：归档滤行、改名换标题，补扫也不能把归档的行漏回来）；
`toSummary` 的标题链最前插覆盖（tab / 树跟着换名字，`refreshSessions` 推一把）。
改名走原生 `showInputBox`（清空 / 取消都当"没改"——清空意味着"回到原始标题"，
而底层标题（agent/缓存/磁盘）列表这边拿不到，不猜）。

**行内布局（212 修）**：目录名从"行最右端"改成**会话名后的括号后缀**（`(aki_work)`，靠左）——
2026-10-09 用户报：原来它与右端的悬停图标重叠（图里就是"图标压在 aki_work 上"）。
CSS 上 `.session-row .outline-text { flex: 0 1 auto }`（标题按内容占位、过长才省略，右端空档
留给 `.row-actions`）；**只限历史行**——大纲行的 `.outline-text` 仍是 `flex: 1`（时刻贴右缘）。

**验收**：客户端桩 —— contextMenu 4 条（大纲行 / 地址栏 / tab（草稿只给 Close）/ 历史行）＋
history picker 4 条（每行一对动作且不嵌套 / 点 Archive 只发消息 / 点 Rename 带 currentTitle /
applyAction 摘行换标签且不重置过滤）；真 Chromium 的 `#historyrowprobe`（默认 opacity=0、
动作落在行内且纵向居中、图标画出来、点击发出 `archiveSession`、回执后行数 -1；
截图档 `history-row-actions.png` 第一行是"悬停后"的摆法 —— 无头里触发不了真 :hover）。

### 5.51 会话 tab 的目录标识（CUSTOM-20261009-225，修订 226/227/228/229）

状态圆点（7px 圆点）改造成 16px **方形**圆角块，里面写目录缩写（最多 4 个字母，按非字母数字 + 驼峰边界拆词取首字母，大写）。

**取最底层目录名（227 修订，用户报"DGAD 不对"）**：首版 `cwd.split(/[\\/]/)` 在模板串里求值后客户端拿到 `/[\/]/`（只匹配正斜杠），Windows 路径（`D:\Git\…`）整条不拆 ⇒ 整条路径进拆词 ⇒ DGAD。修法：模板串里写**四个**反斜杠（`/[\\\\/]/`），客户端拿到 `/[\\/]/`（同时匹配两种分隔符）⇒ 取到最后一段目录名再拆词。

**布局分档（227 → 228 → 229 三次修订）**：`NS.dom.el(tag, cls, text)` 把缩写当一个文本节点，一行排不下才换行 ⇒ 4 个字母挤一行。227 改成每个字母一个 `<span class="dir-letter">`、宽度 50%，让 4 字母排成 2x2。228 让 1~3 个字母走单行居中（宽度 auto）、只有 4 个才折 2x2，并改由 dot 上的 **`data-len`** 分档（选择器不再靠猜元素位置）。
**229（用户报"3 字母并排挤、4 字母中间空"）**：`width: 50%` 的等分格把每个字母居中在自己的 8px 格里 —— 4 字母的墨迹因此被推到方块四角、中缝 3.5px；3 个字母挤成单行时墨迹占满 **15/16px**、首尾贴到圆角上。现在 **3/4 两档共用一套紧凑两列网格**（`grid-template-columns: repeat(2, auto)` + `justify-content`/`align-content: center` + `column-gap: 1px`）：4 个自然排成 2x2（中缝 1.0px、整块 11.0px 居中），3 个是「上 2 下 1」（第 3 个 `grid-column: 1 / -1` 跨两列居中）。1/2 个字母不变，仍走弹性单行。

**字号分档与圆角（228，229 修订）**：字号原先是写死的 `0.42em`，真机（`--vscode-font-size` 默认 13px）只有 **≈5.5px**。228 起按字母数分档；**229 起两行档同字号**：1 个 `min(0.7em, 9.1px)` / 2 个 `min(0.6em, 7.8px)` / **3、4 个 `min(0.54em, 7px)`**（229 把 4 个从 `min(0.5em, 6.5px)` 提上来：网格收紧后两行的行盒 2×7 = 14px，方块里还剩 2px 余量；6.5px 是旧布局为"被等分格浪费掉的空间"付的代价）。圆角 `4px` → `6px`；6px 是四档的共同上限 —— 2x2 的角格里有字，再圆就削到笔画。写成 `min(em, px)` 是因为**方块固定 16px 而字号是相对的**：不封顶的话用户把工作区字号调到 16px 以上，两行会顶破方块、被 `overflow: hidden` 削掉。

**dot 的 tooltip（228，229 补状态）**：`title` = **两行、各带标签**：`Dir: <完整 cwd>` + `State: <会话状态>`
（228 只有 cwd；229 加状态与标签 —— 标签是必要的，两行裸值悬停时分不清哪行是路径哪行是状态）。229 的依据：dot 同时用**颜色**表达状态，而颜色没有名字、标签栏也没有图例 —— 悬停是唯一能"问出来"的地方。状态文案与 `dotClass` 的优先级**逐条对齐**（`tabs.ts:dotStatusText`：等人回答 > 轮次在跑 > 载入历史 > 后台有新输出 > Idle）；两处一旦漂移，颜色与文字就会对同一个会话各说各话。没有 cwd 的会话只有 `State:` 那一行。

**颜色分工（226 修订，用户报"完成态看不见"）**：首版把状态色写在 `color:` 上，而 `background: currentColor` 会把 color 当背景用 —— 完成态（无状态类）时 color 是 `descriptionForeground`（灰）、背景灰、文字近黑 ⇒ 看不见。现在**状态色只给 background-color，文字色固定在 color 上**（不再吃状态类）；外圈单独读 `--tab-dot-state` 自定义属性（background-color 不能给 currentColor 用）。

缩写规则：'story-myriad-pavilion' → 'SMP'，'AbcDeFg' → 'ADF'，'abc-de-fg' → 'ADF'。

**踩坑**：拆词不用正则 lookbehind（本文件要走 check-webview-client.mjs 的 new Function 解析，lookbehind 在它的目标解析里会报 Unexpected token）—— 用两轮拆分（先按非字母数字切，再按驼峰边界切）。预览主题里原先没有 `--vscode-charts-orange/yellow/blue` 三个 token，waiting/loading/attention 三态的 background-color 算出来是透明 —— 补齐后探针才验得出对比色。

### 5.52 表单回执卡：标出所选 + 可折叠（CUSTOM-20261013-231）

**为什么在"记录区"分册**：抽屉（待答态）归 `chat-panel-input.md` §5.33，而**已答态是记录区的事** ——
它是历史、跟消息一起滚、不在抽屉里。231 之前这张卡只有"题面 + 曾提供的选项 + 底下一行 summary"，
**每个选项画出来一模一样**，答案只活在那一行拼接串里（`Answered · question_0: … · question_1: …`）。

| 关注点 | 规则 |
|---|---|
| 结构 | 结算态 = `<details class="elic-fold">`（`summary` = 标题 + `Answered · N questions` + `.fold-caret`）+ `.elic-body`（逐题）+ `.elic-note`。**折叠走原生 `<details>`**，与消息 / Thought 同一机制（`.fold-caret` 的方向由 `details[open]` 驱动，不需要 JS）；**默认展开**（`fill` 里显式 `fold.open = true`）—— 这张卡的意义就是让人一眼看到答了什么 |
| 题数 | `Answered · N questions` 里的 N = `groupsOf(state).length`（`_custom` 字段已并回父题，不会被多算）。不用 `Object.keys(answers).length`：弹框路径会多带一个 `_custom` 键 |
| 标出所选 | 每个选项前画一个单选圈（`.elic-option.static::before`）：未选空心、选中实心（`--vscode-focusBorder`）并把标签加粗 —— 与 Claude 的回执同形，左列对齐。**命中判据要同时认三种答案形状**（`optionMatches`，见 pitfalls #67）：面板无补充框 = `option.value`、面板带补充框 = `"<选项标题> — <说明>"`、弹框兜底 = `option.value`。对不上任何选项的值（"Other" 里打的字、多选追加的那一项）**单独合成一行** `.picked.elic-other` —— 否则这次回答在卡上凭空消失 |
| 非选项字段 | 文本 / 数字直接显示答案；**布尔没勾时答案里根本没有这个键**，只在"整张表是 accepted"时才读作 `No`（declined/cancelled 显示 `—`，不然等于替用户编答案）。231 之前这三种一律只画一个破折号 |
| 分组的来源 | 回执卡与抽屉**同一个 `groupsOf(state)`**（`fill` 里不再裸遍历 `state.fields`）—— 两处若用不同分组，自拟框的位置就会一边对一边错 |
| 已知代价 | 折叠态**不持久**：`applyState` 对结算态每次 revise/快照都会 `fill` 重建，`open` 回到默认。要持久得仿 `userCollapsed` 按 entryId 记账 —— 目前不做（历史卡从简，默认态就是想要的态） |
| 验收 | 无头档 `#elicsettled` / `#elicsettledfree` / `#elicsettledfolded`（`elic-settled*.png`）+ 探针 `elicprobe`。**折叠的判据只能是卡片自身的高度**（319 → 61）：折叠态下正文的 `getComputedStyle(...).display` 仍是作者写的 `flex`、`getBoundingClientRect()` 也照旧报 252 —— 浏览器在渲染层藏它，这两个读数都会骗人 |
