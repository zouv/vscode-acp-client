# Chat 面板 · 会话状态、诊断与几何（状态卡 / 通知 / 后台任务 / 日志与构建指纹）（续 2）

> 接上篇：[chat-panel-state-1b.md](chat-panel-state-1b.md)

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