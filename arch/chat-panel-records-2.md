# Chat 面板 · 记录区（折叠 / 时间 / 内容渲染 / 右键菜单）（续 2）

> 接上篇：[chat-panel-records-1b.md](chat-panel-records-1b.md)

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
| **框选 vs 跳转（2026-10-19）** | 拖选文本松手时浏览器**仍会派发 click** —— 旧逻辑把它当成"点卡片"，刚框选好的内容立刻被跳转带走（用户报："点击后松开就触发定位，没法框选复制里面的一段文本"）。现在 click 处理先看 `window.getSelection()`：**有非空选区就不跳转**；普通点击照旧跳。"选区"比"跳到原消息"是更具体的用户意图，不需要额外的拖拽距离阈值 |
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

| 状态 | 颜色（2026-10-29 起固定 hex） | 外圈 |
|---|---|---|
| 等人回答（权限 / 表单） | 橙 `#e8912d` | 有（轮次通常还在跑） |
| 轮次在跑 | 蓝 `#3b82f6` | 有 |
| 载入历史（replay） | 蓝灰 `#7d8fa8` | 有 |
| 后台有新输出（unread） | 浅绿 `#7bc96f` | 无 —— 它是关于**过去**的提示，不是当下的活动 |
| 平常 | 浅灰 `#b8c0cc` | 无 |

> **固定配色（2026-10-29）**：用户要求不再跟随主题的 `charts.*` / `progressBar`，五态各用固定 hex；
> 字母色固定 `#1f2328`，只有 running 的蓝底改用白字（深色对比不足）。`.surface-editor` 不再覆盖
> `.tab-dot` 的字色。

> **涟漪曾被裁掉（2026-10-19）**：228/229 给 `.tab-dot` 加了 `overflow: hidden`（防止放大字号时
> 字母顶出方块），它同时把 `::after` 的涟漪（`scale(1.9)`）裁进了 16px 方块 —— 看起来像"运行中
> 的动效被屏蔽了"。现在忙碌态 `.tab-dot.busy { overflow: visible }`，空闲态仍裁剪字母。
> **验收判据在 `#tabsprobe`**：忙碌点的 `overflow` 必须是 `visible`、`::after` 的 `animationName`
> 必须是 `tab-ring`；空闲/unread 则是 `hidden` / `none`。改 `.tab-dot` 的布局时先看这两项。
>
> **放开 `overflow` 的代价：涟漪会把标签条带撑出纵向滚动条（2026-10-26，用户报"三个点一直在闪、
> 每闪一次排版也闪一下"）**。`.tabs` 只写了 `overflow-x: auto`，按规范另一轴的 `visible` 会被算成
> `auto` ⇒ 这条横向滚动带同时也是**纵向滚动容器**；而 `scale(1.9)` 的涟漪属于 transformed overflow，
> Chromium 把它算进 scrollable overflow。于是涟漪每长到峰值就冒出一根**纵向滚动条**（带上下箭头，
> 用户圈出来的就是它）、占掉 10px 宽度，动画回落它又消失 —— 整条 tab 带每 1.4s 抖一次。
> **修法**：`.tabs { overflow-y: hidden }`（涟漪最多被裁 1px，肉眼无感）。**别删那一行**。
> 读数在 `preview-records.mjs` 的 `#tabbusyprobe`：`tabsVScroll`（= `offsetWidth − clientWidth`）
> 必须为 **0**；量的时候涟漪冻结在 `scale(1.9)` 峰值，且命令行**不能**加 `--hide-scrollbars`
> （那条参数把滚动条从布局里也拿掉，两种状态都读 0，探针会静默失去判别力）。

> **选中 / 未选中 tab 的区分（2026-10-19）**：用户报"区分度不明显"。现在四条同向叠加 ——
> 未选中用 `tab-inactiveForeground` + `opacity: .7`；选中用**与面板同色的底** + 1px 边框 +
> **顶部 2px 强调线**（`tab-activeBorderTop`，回退 `focusBorder`）+ `font-weight: 600` + `opacity: 1`。
> 底色必须**按面**取：侧边栏面 `sideBar-background`、编辑区面 `editor-background`
> （`.surface-editor .tab.active` 覆盖）—— 只写 editor 时侧边栏的选中 tab 与面板不同色，
> 那正是"看起来没选中"的一半原因。`.tab-dot` 的字母色从 2026-10-29 起固定为深色，不再按面取。
> 拖拽落点指示线用的是左右 `inset` 阴影，与顶部强调线不冲突。

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
  （与编辑器自己的显示一致）；**单行选区也算行区间**（2026-10-27：选中一行里的几个字返回
  `lineStart === lineEnd`，只有空选区才引用整个文件）。**抽成结构子集的纯函数**是为了可测 —— 真
  `vscode.window.activeTextEditor` 在测试宿主里造不出来（同 `pickDefaultCwd` 的既有做法）。
- **推的方式**：按"路径 + 行区间"签名去重（`onDidChangeTextEditorSelection` 每次光标移动都回调，
  叠成行号之后同一行里动就不发），面刚挂上来时 `force` 推一次（签名是全局的，第二个面不该因为
  "另一个面拿过了"而拿不到）。

**③ agent 也看得到行区间**：发送时把区间挂进资源链接的 uri 片段
（`file:///….cs#L12-40`，`name` 里已经有给人看的 `文件名:12-40`）—— 不认片段的实现照旧忽略它。
**2026-10-30**：这个片段不再只是给 agent 看的 —— `contentBlocks.fileLinkTarget` 把它解析成
`line` / `endLine` 放进 `resource_link` 视图，`toolCallView` 据此写 `data-line` + `data-end-line`，
所以用户气泡 / 回放 mention / 工具内容里的文件 chip 点击都会框选整段。正文 markdown 链接同样
带 `data-end-line`（解析器与 `localPathOf` 同在 `contentBlocks`，`markdown.ts` 单向依赖它）。
输入框附件行里可点击的 `.attachment[data-path]` chip 补了 cursor + hover 反馈。

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

**症状**（用户 2026-10-09 第三次报，截图在 workspace 会话）：滚动条已触底、消息却没拉到底部 ——
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
`Copy selection` 复制的是**选区**、无选区时禁用，而用户报的"有个 Copy 但点不动"正是这几处）：
- **大纲行**（`.outline-item[data-jump-id]`）：`Copy` = 这一条的**正文**（`transcriptView.entry(id).text`，
  取不到时退回行上可见文本）——不是选区，也不需要选区；
- **地址栏**（`.session-title`，即 body.ts 的 `#cwdBtn`；用类选择器是为了桩 DOM 也认）：
  `Copy` = `NS.tabs.currentCwd()`（拿不到退回按钮文本 —— 草稿页它可能是 "Default directory"）；
- **会话 tab**（`.tab`）：`Rename` / `Mark as unread` / `New Session in This Folder` /
  `Duplicate` / `Copy working directory` / `Copy Session ID`（仅真会话 tab，见下）＋ `Close`
  （永远最后；草稿/待恢复只有它。= tab 上的 × 同一条路，`NS.tabs.closeTabNode` 按 kind 分派
  草稿=丢弃 / 待恢复=本地忘掉 / 真会话=closeSession）；
- **历史列表行**（`.outline-item[data-open-session]`）：`Archive` / `Rename` —— 悬停图标够不着的
  键盘用户（Shift+F10）走这里同一对动作、同一个出口。

**会话 tab 的菜单项（211，2026-10-29 重排）**：顺序固定为 `Rename` → `Mark as unread` →
`New Session in This Folder` → `Duplicate` → `Copy working directory` → `Copy Session ID` →
`Close`。`Close` = `NS.tabs.closeTabNode`（按 kind 分派：草稿=丢弃 / 待恢复=本地忘掉 /
真会话=closeSession，与 tab 上的 × 同一条路）；`Rename` = 发 212 的
`renameSession {sessionId, currentTitle}`（初值取 `.tab-label` 上**看得见**的标题，同源原则），
改名走面板内输入浮层，回执后 `refreshSessions` 把新标题经 `sessionsChanged` 推回来。
**`Mark as unread`** 发 `markUnread {sessionId}` → 宿主把它加进 `unread` 集合（与后台输出同一个
浅绿 attention 点），聚焦到该会话时由 `active-session-changed` 清掉；已经是未读时置灰。
**`Copy working directory`** 读 tab 上的 `data-cwd`（`tabs.ts` 渲染时写入），没有 cwd 时置灰。
**首版曾按用户早先口述做了 `Remove`（归档+忘掉+关闭），用户随后更正
"要的是 Rename 不是 Remove"，已整条删除**（包含 `removeSession` 消息）。

**会话 tab 的新建 / 复制（2026-10-27）**：两个都只在**真会话 tab** 上出现（草稿/待恢复没有
`data-session-id`，维持只有 Close）。`New Session in This Folder` 发 `newSessionInDirectory`
（会话作用域）→ 宿主按源会话的 `cwd` + `additionalDirectories` 调 `createSession`；新会话照常
套用记住的模式/默认模型/默认强度。**新 tab 落在被右键的 tab 右侧**：宿主拿到新 `sessionId` 后，
先把「现有 tabOrder + 不在表里的 live 会话」展开成完整顺序，再把新 id 插到源 id 之后写回
`uiPrefs.tabOrder`（`ChatPanelHost.insertSessionAfter` / `placeSessionAfterInTabOrder`）。
`Duplicate` 发 `duplicateSession` → 宿主走
`session/fork` **不带 messageId**（在末尾分叉），新会话继承源会话的上下文与消息记录，再由
`openExistingSession` 重放并聚焦。agent 不支持 fork 时由 `reportError` 在记录区给出提示。
tab 的悬停提示改为自绘浮层：标题正常色、**SessionId 灰色**（`tabs.ts` 的 `showTip`）。

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

**行内布局（212 修）**：目录名从"行最右端"改成**会话名后的括号后缀**（`(workspace)`，靠左）——
2026-10-09 用户报：原来它与右端的悬停图标重叠（图里就是"图标压在 workspace 上"）。
CSS 上 `.session-row .outline-text { flex: 0 1 auto }`（标题按内容占位、过长才省略，右端空档
留给 `.row-actions`）；**只限历史行**——大纲行的 `.outline-text` 仍是 `flex: 1`（时刻贴右缘）。

**验收**：客户端桩 —— contextMenu 4 条（大纲行 / 地址栏 / tab（草稿只给 Close）/ 历史行）＋
history picker 4 条（每行一对动作且不嵌套 / 点 Archive 只发消息 / 点 Rename 带 currentTitle /
applyAction 摘行换标签且不重置过滤）；真 Chromium 的 `#historyrowprobe`（默认 opacity=0、
动作落在行内且纵向居中、图标画出来、点击发出 `archiveSession`、回执后行数 -1；
截图档 `history-row-actions.png` 第一行是"悬停后"的摆法 —— 无头里触发不了真 :hover）。

> 续：[chat-panel-records-3.md](chat-panel-records-3.md)
