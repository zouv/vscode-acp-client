// 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// webview 样式。全部走 `--vscode-*` 主题变量，不硬编码颜色，因此自动适配明/暗主题。
// 工具调用状态类用的是 ACP 的真实取值（pending / in_progress / completed / failed）——
// 旧面板判的是 'running'，那是个 ACP 从不发送的字符串。
export function styles(): string {
  return `<style>
  * { box-sizing: border-box; }

  /* ⚠️ 不要删这条规则。
     'hidden' 属性靠 UA 样式表的 [hidden]{display:none} 生效，而**作者样式里的任何 display
     声明都会覆盖它**——这与选择器权重无关，是"作者样式 > UA 样式"的层叠顺序决定的。
     本文件里 .load-overlay / .agent-bar / .attachments 都需要 flex 布局，没有这条 !important
     的话它们会**永远可见**（曾导致加载遮罩常驻不消失、并吞掉整个面板的点击）。
     改了这条之后：给任何用 hidden 控制的元素加 display 都要先想一下这里。
     另：本文件是模板字符串，注释里禁用反引号——用单引号。 */
  [hidden] { display: none !important; }

  /* --- 键盘可达性基础设施（）------------------------
     面板此前**完全无法用键盘操作**：标签、抽屉行、菜单项、斜杠项、工具卡头、
     diff 头、文件 chip 都是 div/span + click，既不可聚焦也没有 Enter/Space 处理。
     它们现在都是真正的 <button>，这一块的职责是**把 UA 的按钮样式抹平**，
     使外观与改动前一致，并补上面板从来没有过的焦点环。

     位置有讲究：必须放在下方各 class 规则**之前**，让同权重的 class 规则覆盖它。
     （'.chip' / '.tab.active' / '.outline-item:hover' / '.rail-dot.turn' 都在后面，
     它们要么权重更高、要么同权重后出现，所以外观不受影响。） */
  button { font-family: inherit; font-size: inherit; color: inherit; }
  /* [CUSTOM- '.session-title'（显示工作目录的那格）从 span 变成了按钮，
     因此也进这个清单。**注意它不加 width: 100%**——它自身有 'flex: 1' 要吃掉剩余
     宽度，两者会打架。 */
  .tab, .outline-item, .picker-item, .slash-item,
  .tool-head, .diff-head, .chip, .session-title {
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
  }
  /* 宽度：这三个都在**块级容器**里（.outline-list / .picker-menu / .slash-popup），
     按钮默认是 inline-block（收缩到内容宽），所以必须显式铺满。
     **'.tab' 不在此列**——它是 '.tabs'（flex 行）的子项，给 flex 子项写 width: 100%
     会解析成"容器内容宽的 100%"，而容器宽又由子项决定（循环），浏览器只能退回
     max-content 求解，结果是每个标签都被撑到最宽那个的宽度、整条标签栏变形。 */
  .outline-item, .picker-item, .slash-item, .tool-head, .diff-head { width: 100%; }
  .picker-item, .slash-item { display: block; }
  /* [CUSTOM- 自定义模型的副标题（description）：主标签下一行，次要色。 */
  .picker-item-label { display: block; }
  .picker-item-desc {
    display: block; margin-top: 2px;
    font-size: 0.82em; color: var(--vscode-descriptionForeground);
    white-space: normal;
  }
  /* .rail-dot 也是 <button>：它自带 background（两级样式权重更高），但 '.turn' 那档
     **只设了 background、没设 border**，不抹掉 UA 的 2px outset 就会多出一圈边框。
     padding 同理——它的尺寸完全由 CSS 决定，多 1px 就会偏位。 */
  .rail-dot { padding: 0; border: none; background: transparent; }
  /* 焦点必须可见。用 :focus-visible 而不是 :focus，鼠标点击不会留下焦点环。 */
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  body {
    margin: 0;
    padding: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    /* [CUSTOM- 底栏（.composer）改成绝对定位、浮在消息区之上 —— 它的定位祖先
       就是这里，所以 body 必须 positioned。 */
    position: relative;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    /* 底部栏的尺度，定义在这一层是因为输入区是 body 的
       后代（.composer 不是 .message-area 的后代，挂那边够不着）。
       · --vac-composer-max：输入卡宽度。137 起**消息列不再限宽**（用户要求消息平铺开、
         读得更宽），只有底部这一块仍限宽 —— 卡片过宽时发送按钮离正文太远、不好点。
       · --vac-input-max-h：输入框的**视口**上限。与 autoGrow 里那个 320 是两件事——
         320 管"内容最多长到多高"，这条管"面板再高也不许高过屏幕的 38%"；两者同时存在时
         浏览器取更小的那个，所以 composer.ts 不需要知道视口有多高。 */
    --vac-composer-max: 720px;
    --vac-input-max-h: min(320px, 38vh);
  }

  /* --- Agent selector ------------------------------------------------- */
  .agent-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    position: relative;
  }
  .agent-select {
    flex: 1;
    min-width: 0;
    max-width: none;
    justify-content: flex-start;
  }
  #agentMenu { left: 0; right: auto; min-width: 220px; }

  /* [CUSTOM- 待恢复的 tab（本地页，宿主里还没有它）：与草稿同族但**不是**新会话 ——
     用虚一点的名字色 + 一个空心点区分，tooltip 写明 click to open；不可拖拽（顺序由 tabOrder 决定）。 */
  .tab-restore .tab-label { color: var(--vscode-descriptionForeground); font-style: italic; }
  .tab-dot.restore {
    width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
    background: transparent; border: 1px dashed var(--vscode-descriptionForeground);
  }
  /* [CUSTOM- 恢复卡片上的第二个按钮（次要动作）：比主按钮安静一档。 */
  .state-fresh {
    font-family: inherit; font-size: inherit; cursor: pointer;
    margin-left: 8px; padding: 3px 10px; border-radius: 3px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
  }
  .state-fresh:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }

  /* --- Tabs ------------------------------------------------------------ */
  .tab-strip {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 6px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    /* [CUSTOM- 动作按钮（+ / 设置）固定在右侧，只有 #tabs 自己滚动；
       旧实现让整条 strip 滚，tab 一多就把按钮挤出视口。 */
    overflow: hidden;
    scrollbar-width: thin;
  }
  /* [CUSTOM- overflow-y: hidden 是**承重的**，别删。只写 overflow-x 时，另一轴的
     visible 会被规范算成 auto（实测 computed 就是 auto）⇒ 这条横向滚动条带同时也是纵向
     滚动容器。而「运行中」tab 的涟漪（.tab-dot.busy::after，放大到 1.9 倍、比 16px 的
     dot 多伸出约 7px）属于 transformed overflow，Chromium 会把它算进 scrollable overflow：
     涟漪一长过 tab 高度就**冒出一根纵向滚动条**，占掉 10px 宽度 ⇒ 整条 tab 带每 1.4s
     抖一次（用户 2026-10-26 报"每闪一次排版也闪一下"，圈出来的那根带箭头的细条就是它）。
     隐藏纵向后涟漪被裁掉最多 1px，肉眼无感；真 Chromium 读数由 preview-records.mjs 的
     #tabbusyprobe 钉住（tabsVScroll 必须为 0）。 */
  .tabs {
    display: flex; gap: 2px; flex: 0 1 auto; min-width: 0;
    overflow-x: auto; overflow-y: hidden; scrollbar-width: thin;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    /* [CUSTOM- 不参与收缩：tab 多了要让 .tabs 横向滚动，而不是把每个标签挤成省略号。 */
    flex: 0 0 auto;
    max-width: 200px;
    padding: 4px 6px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 4px 4px 0 0;
    /* 未选中的底：优先用主题自己的 'tab.inactiveBackground'（多数主题给的是一个比面板略深的
       色块），没有就保持透明 —— 这样在侧边栏与编辑区两种面里都不会凭空造色。 */
    background: var(--vscode-tab-inactiveBackground, transparent);
    /* [CUSTOM- 选中/未选中的区分度（用户 2026-10-19 报"不太明显"）：
       未选中先退到 descriptionForeground + 更低的透明度，选中态再用
       ① 与面板同色的底、② 顶部 2px 强调线、③ 加粗、④ 满不透明度，
       四条同向叠加。只靠 0.75 透明度 + 一个几乎同色的背景，在深色主题里几乎看不出来。 */
    color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground));
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    white-space: nowrap;
    opacity: 0.7;
    /* [CUSTOM- 手工拖拽排序。button（047 为了键盘可达性选的）在 Blink 里
       光靠 draggable 属性有时不起拖 —— 这一行是官方给"可拖元素"的兜底。 */
    -webkit-user-drag: element;
  }
  .tab:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
  .tab.active {
    /* 与**面板底色**同色（侧边栏 / 编辑区各自匹配，见 .surface-editor 的覆盖），
       这样它才像是"连着下面内容的当前页"，而不是另一块贴纸。 */
    background: var(--vscode-sideBar-background);
    border-color: var(--vscode-panel-border);
    /* 顶部强调线：不占布局（拖拽指示线用的是左右 inset，两者不冲突）。 */
    box-shadow: inset 0 2px 0 var(--vscode-tab-activeBorderTop, var(--vscode-focusBorder));
    color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
    font-weight: 600;
    opacity: 1;
  }
  .tab-label { overflow: hidden; text-overflow: ellipsis; }
  /* [CUSTOM- 圆点有**两个独立的信号**（用户指定）：
       · 背景色说"这个会话处在什么状态"；
       · 外面的圈说"它正在做事"。
     两者必须独立——卡在权限提示上的轮次两件事同时为真。状态色只写 background-color；
     外圈单独读 --tab-dot-state（background-color 不能给 currentColor 用）。
     **它只是提示**：不弹窗、不抢焦点——与"不做后台权限卡"的决定不冲突。 */
  /* [CUSTOM- 目录标识：dot 放大成方形并写目录缩写。
     ⚠️ 226：状态色只给 background，文字色固定在 color（否则完成状态看不见）。
     ⚠️ 2026-10-29：用户要求**固定配色**（不再跟随主题的 charts.* / progressBar）：
       橙 #e8912d（等回答）/ 蓝 #3b82f6（在跑）/ 蓝灰 #7d8fa8（载入）/
       浅绿 #7bc96f（未读）/ 浅灰 #b8c0cc（空闲）。
       文字固定 #1f2328；running 的蓝底另用白字（深色对比不足）。
     方形不是矩形：宽高都 16px（226 从 18 缩到 16，用户报"可以稍微小一些"）。
     2x2 布局（227）：4 个字母排两行两列 —— flex-wrap + 行高 1 让两行正好占满。
     228 把 227 的"字号压到半格"换成了**按字母数分档**（见下面三条 [data-len]），
     并让 1~3 个字母走单行。 */
  .tab-dot {
    position: relative;
    width: 16px; height: 16px; border-radius: 6px; flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center;
    flex-wrap: wrap; align-content: center;
    /* [CUSTOM-228/229 字号按字母数分档（下面两条 [data-len]），这里是**两行**那一档
       （3 个字母走「上 2 下 1」、4 个走 2x2，都是两行）。
       写成 min(em, px)：方块是**固定 16px**，字却是相对字号 —— 用户把工作区字号调到
       16px 以上时，两行会顶破方块、被 overflow 削掉。min() 让默认字号下取等值、
       大字号下不再长大。7px 是两行档的上限（两行的行盒 2×7=14px，方块里还剩 2px 余量）。
       6px 圆角是四档的共同上限：2x2 的角格有字，再圆就削到笔画。 */
    font-size: min(0.54em, 7px); font-weight: 700; line-height: 1; letter-spacing: 0;
    /* 文字色：固定深色（2026-10-29 起不再取面板底色）——固定浅色底上要保证可读；
       running 的蓝底另用白字（见下面 .tab-dot.running）。 */
    color: #1f2328;
    /* 背景色：固定空闲浅灰；下面的状态类**只覆盖这一个属性**。 */
    background-color: #b8c0cc;
    padding: 0;
    overflow: hidden;
  }
  /* [CUSTOM-228 字母越少给得越大。1~2 个字母走**单行居中**（弹性那套，宽度随字形走）。 */
  .tab-dot[data-len="1"] { font-size: min(0.7em, 9.1px); }
  /* [CUSTOM- 228/229 为了让放大字号时的字母不顶出方块加了 overflow: hidden —— 而它同时
     把 130 的"运行中涟漪"（.tab-dot.busy::after，放大到 1.9 倍）裁在了方块里：外圈动画
     看起来像失效/被屏蔽。忙碌态放开裁剪，涟漪才能画到方块之外；空闲态仍裁剪字母。 */
  .tab-dot.busy { overflow: visible; }
  .tab-dot[data-len="2"] { font-size: min(0.6em, 7.8px); }
  /* [CUSTOM-229 3/4 个字母改用**紧凑两列网格**：列宽随字形走（auto），整块再在方块里居中。
     227/228 的等分格（width: 50%）把每个字母居中在自己的 8px 格里 —— 4 个字母的墨迹因此被推到
     方块四角、中间空出一大块；而 3 个字母挤成单行时墨迹占满 15/16px、首尾贴到圆角上。
     现在两档共用这套网格：4 个自然排成 2x2，3 个是「上 2 下 1」（第 3 个跨两列居中）。 */
  .tab-dot[data-len="3"],
  .tab-dot[data-len="4"] {
    display: grid;
    grid-template-columns: repeat(2, auto);
    justify-content: center;
    align-content: center;
    column-gap: 1px;
  }
  .tab-dot[data-len="3"] .dir-letter:nth-child(3) { grid-column: 1 / -1; }
  /* [CUSTOM- 每个字母一个 span。宽度随字形走：3 个字母跨两列靠它居中，2x2 靠网格列宽贴紧。 */
  .tab-dot .dir-letter { text-align: center; }
  /* 优先级：等人回答 > 轮次在跑 > 载入历史 > 后台有新输出 > 平常。
     每条只改 background-color —— color 不动（running 例外：蓝底需要白字）。
     2026-10-29：固定配色，不再读主题变量。 */
  .tab-dot.waiting { background-color: #e8912d; }   /* 等人回答：橙 */
  .tab-dot.running { background-color: #3b82f6; color: #ffffff; }   /* 轮次在跑：蓝 */
  .tab-dot.loading { background-color: #7d8fa8; }   /* 载入历史：蓝灰 */
  /* [CUSTOM- 后台会话在你离开后有了新输出 —— 由宿主侧的 unread 集合驱动。 */
  .tab-dot.attention { background-color: #7bc96f; }   /* 未读：浅绿 */
  /* 外圈：一圈向外扩散的涟漪，只在"正在做事"（轮次在跑 / 正在载入）时出现。
     早先把 running 做成圆点自身的脉动，那样两个信号就挤在同一个像素上了。
     [CUSTOM- 外圈要跟随**背景色**（状态色），而 background-color 不能给
     currentColor 用 —— 所以外圈单独读 background-color。 */
  .tab-dot.busy::after {
    content: ''; position: absolute; inset: -1px; border-radius: 50%;
    /* 226：外圈跟随背景色（状态色），不是文字色 —— 文字色现在是固定的对比色。
       2026-10-29：状态色固定成同一套 hex。 */
    border: 1px solid var(--tab-dot-state, #b8c0cc);
    animation: tab-ring 1.4s ease-out infinite;
  }
  /* 226：每条状态类把状态色同时写进自定义属性，外圈读它。 */
  .tab-dot.busy.waiting { --tab-dot-state: #e8912d; }
  .tab-dot.busy.running { --tab-dot-state: #3b82f6; }
  .tab-dot.busy.loading { --tab-dot-state: #7d8fa8; }
  .tab-dot.busy.attention { --tab-dot-state: #7bc96f; }
  @keyframes tab-ring {
    0% { transform: scale(0.7); opacity: 0.9; }
    100% { transform: scale(1.9); opacity: 0; }
  }
  /* [CUSTOM- 会话 tab / 目录图标的自绘悬停提示（2026-10-27）：需要分段着色，
     原生 title 做不到。position: fixed，跟随锚点几何写入 left/top；不拦截鼠标。 */
  .tab-tip {
    position: fixed; z-index: 70; max-width: 420px;
    padding: 5px 8px; border-radius: 3px;
    background: var(--vscode-editorWidget-background, var(--vscode-dropdown-background));
    color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
    font-size: 0.88em; line-height: 1.45;
    white-space: pre-wrap; word-break: break-all;
    pointer-events: none;
  }
  .tab-tip-line.dim { color: var(--vscode-descriptionForeground); }
  /* [CUSTOM- 手工排序的落点指示：目标 tab 的哪一侧会被插进去。
     2px 的竖线用 inset 阴影画（跟着 .tab 的圆角走），拖动中的那个自己淡化 —— 让人看清
     "被搬走的是哪一个"。 */
  .tab.dragging { opacity: 0.45; }
  .tab.drop-before { box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
  .tab.drop-after { box-shadow: inset -2px 0 0 var(--vscode-focusBorder); }
  .tab-close {
    border: none; background: transparent; color: inherit; cursor: pointer;
    padding: 0 2px; line-height: 1; opacity: 0.6; font-size: 11px;
  }
  .tab-close:hover { opacity: 1; color: var(--vscode-errorForeground); }
  .tab-new {
    flex: 0 0 auto; margin-left: 4px; padding: 2px 8px; cursor: pointer;
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    font-family: inherit; font-size: 14px; line-height: 1.2;
  }
  .tab-new:hover { background: var(--vscode-list-hoverBackground); }
  /* [CUSTOM- Tab 栏右侧的设置入口：与 + 一样固定在动作区，只显示图标。 */
  .tab-settings {
    flex: 0 0 auto; margin-left: auto; padding: 2px 6px; cursor: pointer;
    display: inline-flex; align-items: center;
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid transparent; border-radius: 3px;
  }
  .tab-settings:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-panel-border); }
  .tab-settings .btn-icon { display: inline-flex; }

  /* --- Session header / usage ------------------------------------------ */
  .session-header {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 10px;
    min-height: 22px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 0.9em;
    /* Anchor for the conversation outline dropdown. Do NOT add overflow here. */
    position: relative;
    color: var(--vscode-descriptionForeground);
  }
  .session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  /* [CUSTOM- 没有聚焦会话/草稿时这一格**显示默认目录但点不动**（090 当初是整格
     隐藏）。禁用态必须看起来像一句说明而不是一个坏掉的按钮：不换手型、没有 hover 反馈，
     并且比真实路径淡一点（同一个 .tab/.tab-close 用 opacity 表达"弱化"的习惯）。 */
  .session-title:disabled { cursor: default; opacity: 0.8; }
  /* [CUSTOM- 把右侧那一组（Times / Sub-agents / ☰）钉在右边。原先靠 '.session-title'
     的 flex: 1 吃掉剩余宽度把它们顶过去 —— 那一格一旦不显示了（上面那种空态），整组就会滑到
     ↺ 旁边。有 flex 项能成长时 auto margin 分不到任何空间，所以这条对原有布局零影响。 */
  .session-header > #tailBtn { margin-left: auto; }
  /* --- Conversation outline () ---------------------- */
  /* 抽屉从标题栏下沿展开。.session-header 没有 overflow: hidden（已核对），
     否则绝对定位的抽屉会被裁掉——这是这类浮层最常见的失灵原因。 */
  .outline-btn {
    flex: none; cursor: pointer; font-family: inherit; font-size: 1em; line-height: 1;
    padding: 2px 5px; border-radius: 3px;
    background: transparent; color: var(--vscode-icon-foreground, currentColor);
    border: 1px solid transparent;
  }
  .outline-btn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  /* Icon buttons in the session header (history / clock, ). */
  .outline-btn .btn-icon { display: inline-flex; align-items: center; }
  .outline-btn .btn-icon svg { display: block; width: 14px; height: 14px; }
  .outline-btn.on {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .outline {
    position: absolute; top: 100%; left: 6px; right: 6px; z-index: 25;
    max-height: 50vh; overflow-y: auto;
    background: var(--vscode-dropdown-background, var(--vscode-editorWidget-background));
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 4px;
    box-shadow: 0 3px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
  }
  .outline-head {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 8px; font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    position: sticky; top: 0;
    background: inherit;
  }
  .outline-more { margin-left: auto; }
  /* [CUSTOM- 历史浮层里的目录过滤菜单要能**溢出**浮层本身。
     因果链：菜单是绝对定位，它的包含块是 .outline-head（sticky ⇒ positioned），而 head 在
     #history 内部 ⇒ #history 的 overflow-y: auto **会把它裁掉**（可见高度 = head 底边到
     #history 底边的距离；历史列表越短它越矮，实测只剩几行）。把滚动从容器下移到 .outline-list：
     #history 不再裁剪任何后代，菜单高度交回它自己的 max-height 单独控制。
     只写在 #history 上、不动 .outline 的通用规则 —— #outline / #cwdMenu 里没有这种嵌套菜单。
     head 的 background: inherit 与 sticky 都保留（后者仍是菜单的定位锚）。 */
  #history { display: flex; flex-direction: column; overflow: visible; }
  /* 目录过滤菜单还必须是**画在上面**的那一个：head 上要有正的 z-index。
     因果链：历史行外套的那层 .session-row 是 position: relative（悬停图标要一个定位祖先）
     ⇒ 每一行都是"定位元素、z-index: auto"，与同样 z-index: auto 的 .outline-head 落在
     **同一个绘制步**里；同一步内按 DOM 顺序画，而列表排在 head 之后 ⇒ 行画在 head 之上。
     菜单自己的 z-index: 20 **救不了**：position: sticky 让 head 自成层叠上下文，菜单被封在里面
     （把它抬到 999 也照样被盖）。只有抬 head 这一层才行——整棵子树（chip + 菜单）随之进入
     "z-index > 0"那一步、画在所有 auto 的行之上。
     只写 #history（沿用上面那条的口径）：#outline / #cwdMenu 里没有 .session-row，没有这个竞争。
     验收档 #historyfilter 用 elementFromPoint 量"那一点上最上面是谁"，不靠肉眼。 */
  #history .outline-head { flex: none; z-index: 2; }
  #history .outline-list { flex: 1; min-height: 0; overflow-y: auto; }
  /* --- 时间显示（）------------------------------------
     每条记录的时刻。元素**始终在 DOM 里**，可见性由 #messages 上的一个类决定
     （与 flat-tools 同一套机制）⇒ 切换开关**不需要重渲染任何东西**，纯样式翻转。
     默认隐藏；鼠标悬停在整条上另有一个完整时刻（见 transcriptView.place 设的 title）。 */
  /* [CUSTOM- 打开 Times 时，时刻**跟着记录的标题行走**，不再单独占一行：
     非工具卡的记录浮在自己节点的右上角（下面那条 .messages > * 提供定位上下文），工具卡则作为
     .tool-head 里的一项参与 flex 排版、排在耗时之后 ⇒ 标题行右侧读作 "2.2s 11:57"。 */
  .rec-time {
    display: none;
    position: absolute; top: 0; right: 0;
    font-size: 0.78em; color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
    /* 它只是文本：既不接点击，也不该挡住底下那行的 hover（整条记录的完整时刻在 node.title 上）。 */
    pointer-events: none;
  }
  /* [CUSTOM- 时刻**只在工具卡上显示**（用户定的）：ACP 里只有工具调用带耗时
     （elapsedMs），普通消息与 Thought 根本没有"耗时"这个量 —— 给它们单独挂一个时刻，读起来
     像是缺了一半的信息，齐不齐也都靠排版去凑。所以开关只对工具卡生效：
       关 = 3ms（耗时，常显）；开 = 3ms 18:32（耗时 + 时刻，见下）。
     非工具记录的 .rec-time 仍然在 DOM 里（transcriptView 一律插入），只是这条选择器不再放它出来。 */
  .messages.show-times .tool-head .rec-time { display: block; }
  /* 记录节点当定位上下文，时刻才浮得住。position: relative 不改变布局（只建立上下文），
     所以对既有排版（rail 的测量、置顶克隆）没有影响。 */
  .messages > * { position: relative; }
  /* 工具卡：时刻是标题行里的一项，静态排版、跟在 .tool-time 后面 ⇒ 整行读作 "3ms 18:32"。
     [CUSTOM- 145 曾把它改成"也浮到右上角"来跟其它记录对齐 —— 那会挤掉标题行的
     宽度（要靠 padding-right 硬留槽位），工具卡本来就工整的一行反而散了，**已回退**。 */
  .tool-head .rec-time { position: static; }
  /* [CUSTOM- 回退时刻（atIsElapsed，回放拿不到转录真实时刻）与真实时刻的区分：
     更暗的占位灰 + 斜体，再配合 label 的 '+' 前缀，三重信号确保不靠单一颜色也能辨认。 */
  .rec-time.elapsed { color: var(--vscode-inputPlaceholderForeground); font-style: italic; }
  /* 105 之前这里有一条 .entry-user .rec-time { text-align: right }（时刻跟着右对齐的气泡走）。
     用户消息改为靠左铺满后它没有存在理由了——留着会让时刻与正文分居两端。 */
  /* 工具耗时常显（与 Thought 的 "Thought for Ns" 同类信息，不需要开关）。 */
  .tool-time {
    flex: 0 0 auto; font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
  }
  /* [CUSTOM- 目录抽屉里的分组标题 / 说明行。观感沿用 .picker-group，
     因为它俩都是"同一类浮层里的分组头"。 */
  .outline-group {
    padding: 5px 8px 2px; font-size: 0.82em; line-height: 1.35;
    color: var(--vscode-descriptionForeground);
  }
  /* 草稿标签：会话还不存在，所以是空心虚线点 + 斜体标签，与真实会话区分开。 */
  .tab-draft .tab-dot {
    background: transparent;
    border: 1px dashed var(--vscode-descriptionForeground);
  }
  .tab-draft .tab-label { font-style: italic; }
  .outline-item {
    display: flex; align-items: baseline; gap: 8px;
    padding: 4px 8px; cursor: pointer;
    border-left: 2px solid transparent;
  }
  .outline-item:hover { background: var(--vscode-list-hoverBackground); }
  /* [CUSTOM- 「Recently used」行：主按钮 + 右侧删除（两个**兄弟** —— button 不能嵌 button）。
     主按钮占满剩余宽度，删除按钮常显但低调（次要色），悬停才提亮：它在下拉里必须能被看见，
     否则用户永远不知道这个列表可以清。 */
  .outline-row { display: flex; align-items: center; }
  .outline-row > .outline-item { flex: 1; min-width: 0; width: auto; }
  .outline-remove {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; margin-right: 4px; padding: 0;
    border: none; border-radius: 3px; cursor: pointer;
    background: transparent; color: var(--vscode-descriptionForeground);
  }
  .outline-remove:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-foreground);
  }
  .outline-remove-icon, .outline-remove-icon svg { display: block; width: 12px; height: 12px; }
  .outline-item.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-left-color: var(--vscode-focusBorder);
  }
  .outline-time {
    flex: none; font-size: 0.82em; font-variant-numeric: tabular-nums;
    color: var(--vscode-descriptionForeground);
  }
  .outline-time.elapsed { color: var(--vscode-inputPlaceholderForeground); font-style: italic; }
  .outline-item.active .outline-time { color: inherit; opacity: 0.85; }
  .outline-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 历史列表行的悬停动作（Archive / Rename）。
     图标层是行的**兄弟**（button 不能嵌 button，见 sessionMenu.buildRowActions），
     绝对定位浮在行的右端：默认透明且不接事件，悬停/键盘聚焦整行时才现身 ——
     "仅鼠标悬停时显示"是用户点名要的形态。背景取行自己的悬停色，使这条贴合在行上
     （行被指到时底色就是它）；覆盖在最右的目录 chip 上是有意的（官方插件同形）。 */
  .session-row { position: relative; }
  .session-row:hover .outline-item { background: var(--vscode-list-hoverBackground); }
  .row-actions {
    position: absolute; top: 0; right: 6px; bottom: 0;
    display: flex; align-items: center; gap: 2px;
    opacity: 0; pointer-events: none;
    background: var(--vscode-list-hoverBackground);
    transition: opacity 80ms ease-out;
  }
  .session-row:hover .row-actions,
  .session-row:focus-within .row-actions { opacity: 1; pointer-events: auto; }
  .row-action {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; padding: 0;
    border: none; border-radius: 4px; cursor: pointer;
    background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground));
  }
  .row-action:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2)); }
  .row-action-icon { display: inline-flex; }
  /* [ 修] 历史行：标题不再吃满整行。.outline-text 的 flex: 1 会把右端推满，
     目录名于是被挤到最右侧、与悬停的 Archive/Rename 重叠（用户 2026-10-09 报，图里就是"图标压在
     workspace 上"）。改 0 1 auto：标题按内容占位、过长才收缩出省略号，目录名紧跟其后（"(workspace)"），
     右端空档留给 .row-actions。**只限历史行**（.session-row 前缀）——大纲行的 .outline-text 仍是
     flex: 1，那条行的时刻要贴右缘。 */
  .session-row .outline-text { flex: 0 1 auto; }
  /* [CUSTOM- 「这一行是谁说的」要一眼看得出来。用户报"右侧边栏用户消息区分度不明显" ——
     在此之前两类行只有**一小格图标**在区分（076/077），文字颜色/字重/缩进完全一样，整排读起来是
     一片同质的列表。做法是把两个方向拉开：

       · **用户行 = 骨架**：正常前景色 + 中等字重 + 图标满不透明 —— 它是"我在问什么"的地图。
       · **助手行 = 补充**：描述色（更暗）+ 字号略小 + 图标半隐 + **缩进一格**（padding-left），
         读起来"挂在上面那条下面"，而不是并列的另一条。

     刻意**不用**左竖条/背景色做这个区分：那两条通道已经被"当前项"占着（.outline-item.active
     的 border-left 与背景）—— 一个颜色两种意思正是 047 踩过的坑（rail 的焦点环 vs 位置）。

     还有一条**分工**要写清楚：kind 决定"字重 / 字号 / 图标浓淡"，**只有颜色让位给选中态**
     （选中行有它自己的 foreground）。第一版把整条规则都写成 :not(.active)，结果选中一个用户行
     时它的字重从 600 掉回 400 —— 选中一个东西不该**改变它是什么**。

     **缩进那一档试过又撤了**（用户看过效果后定的）：padding-left 让助手行读起来像"子项"，
     但侧栏本来就窄（默认 240px），缩进直接吃掉可读宽度、长标题更早被省略号截断 ——
     而"是谁说的"靠颜色/字重/字号已经够了。**别再顺手加回来**：那是拿宽度换层级。 */
  .outline-item.kind-user .outline-text { font-weight: 600; }
  .outline-item.kind-assistant .outline-text { font-size: 0.95em; }
  .outline-item.kind-user .outline-kind { opacity: 1; }
  .outline-item.kind-assistant .outline-kind { opacity: 0.45; }
  .outline-item:not(.active).kind-user .outline-text { color: var(--vscode-foreground); }
  .outline-item:not(.active).kind-assistant .outline-text { color: var(--vscode-descriptionForeground); }
  /* [CUSTOM- 历史会话行右侧的目录提示（只显示最后一段，全路径在 tooltip 里）。
     没有它的话，245 条跨目录会话只能靠 hover 才知道各自属于哪个项目。 */
  .outline-cwd {
    flex: 0 0 auto; max-width: 40%; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
    font-size: 0.82em; color: var(--vscode-descriptionForeground);
  }
  /* [CUSTOM- 钉住按钮并进 .outline-head（"N messages" 同一行）。
     .outline-head-info 是 render() 清空并回填的计数容器；钉住按钮是它的兄弟、静态。 */
  .outline-head-info {
    display: flex; align-items: center; gap: 8px;
    flex: 1; min-width: 0;
  }
  /* 大纲项里的类型图标（user/assistant）。挂 .outline-kind 而不是 .rec-icon：后者是
     "贴在记录气泡里"的语义（icons.attach 用），这里是列表项里独立的一格。 */
  .outline-kind { flex: none; display: inline-flex; align-items: center; align-self: center; opacity: 0.7; }
  .outline-kind svg { display: block; }
  .outline-item.active .outline-kind { opacity: 1; }
  /* [CUSTOM- 按类型着色：user 与 transcript 用户气泡同色（蓝），
     assistant 用中性灰。SVG 是 stroke=currentColor，改 color 即可区分。 */
  .outline-kind-user { color: var(--vscode-button-background); }
  .outline-kind-assistant { color: var(--vscode-descriptionForeground); }

  /* --- 右侧常驻大纲栏（）----------------------------- */
  /* 是 #messages 的 flex 兄弟、定宽（JS 拖拽后写 inline width 覆盖这里的默认 240px）。
     绝对定位的调宽手柄因此要 relative 锚定；注意别加 overflow，否则 left:-3px 的手柄被裁。 */
  .outline-sidebar {
    flex: 0 0 auto; width: 240px;
    display: flex; flex-direction: column;
    border-left: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    position: relative;
  }
  .outline-sidebar-head {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .outline-sidebar-title {
    flex: 1; font-size: 0.8em; color: var(--vscode-descriptionForeground);
    text-transform: uppercase; letter-spacing: .04em;
  }
  /* 列表独立滚动，不跟着 #messages 走。 */
  .outline-sidebar .outline-list { flex: 1; overflow-y: auto; scrollbar-width: thin; }
  /* 调宽手柄：钉在侧栏左缘（跨过 1px 边框各留 3px 命中区）。 */
  .outline-resize {
    position: absolute; left: -3px; top: 0; bottom: 0; width: 6px;
    cursor: col-resize; z-index: 4;
  }
  /* [CUSTOM- 这里原有 .usage-bar / .usage-track / .usage-fill——顶部那条进度条
     整个删掉了，底部改画圆环（.gauge-* 见下），三条规则一起成了死 CSS，一并清掉。 */

  /* [CUSTOM- 未连接（含正在连接）时，header 只留历史按钮和地址：
     Times / Tail 在没有记录的界面上没有意义。相位由 stateCard 写在 body 的 data-phase 上，
     所以这里不需要任何 JS。 */
  body[data-phase="disconnected"] #timeToggle,
  body[data-phase="disconnected"] #tailBtn,
  body[data-phase="connecting"] #timeToggle,
  body[data-phase="connecting"] #tailBtn { display: none; }

  /* --- Messages -------------------------------------------------------- */
  .message-area { position: relative; flex: 1; min-height: 0; display: flex; }
  /* [CUSTOM- 消息列：.message-area 这一行里除它之外只有定宽的大纲栏。
     置顶副本（.sticky-user）是它的绝对定位子元素，于是"覆盖层不会盖到大纲栏上"是按构造
     成立的——不用量大纲栏宽度。min-width: 0 与 #messages 当初作为 flex 项时同义。 */
  /* 消息列**不限宽**。132 一度给它加过版心（max-width +
     auto margin 居中），本轮按用户要求撤销：消息要平铺开、读得更宽；限宽只保留在底部输入卡上
     （卡片太宽时发送按钮离正文太远，那是另一个问题）。
     这一层的定位意义不变 —— 置顶卡片（.sticky-user）、引导条（.rail）与 Jump to latest 都是
     它的绝对定位子元素，所以 132 把后两者搬进来的改动**保留**：列满宽时它们与内容的位置关系
     与改动前逐像素一致，将来若再限宽也不必重做。 */
  .messages-column {
    position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
  }
  /* --- Conversation rail () ------------------------- */
  /* 左侧引导条：轮次大点 + 步骤小点，随内容滚动（track 由 JS 做 translateY(-scrollTop)）。
     注意本元素**不能**写 display——hidden 属性靠文件顶部的 [hidden]{display:none!important}
     生效，那条规则就是为它兜底的（见 pitfalls #13）；absolute 定位的元素默认就是块级。
     条本身 pointer-events: none，避免挡住左侧文字的选区；只有点可点。 */
  .rail {
    position: absolute; left: 0; top: 0; bottom: 0; width: 20px;
    overflow: hidden; z-index: 3; pointer-events: none;
  }
  .rail-track { position: absolute; left: 0; top: 0; width: 100%; height: 0; }
  .rail-line {
    position: absolute; width: 1px; left: 9.5px;
    background: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  }
  .rail-dot {
    position: absolute; border-radius: 50%; box-sizing: border-box;
    pointer-events: auto; cursor: pointer;
  }
  /* [CUSTOM- 命中区扩展：'step' 只有 7px，鼠标几乎点不中。
     用一层透明的 ::after 把可点范围撑到约 17px——**外观完全不变**（inset 为负，
     伪元素不参与布局，也不影响 #1 的圆心对齐）。 */
  .rail-dot::after {
    content: ''; position: absolute; inset: -5px; border-radius: 50%;
  }
  /* 两级：轮次点更大且实心，步骤点小且空心。margin-top 取负的一半尺寸，
     这样 JS 只需写 top = 中心 y（绝对定位元素的 margin 会参与位移，这里正好要用）。 */
  .rail-dot.turn {
    left: 5px; width: 10px; height: 10px; margin-top: -5px;
    background: var(--vscode-descriptionForeground, #888);
  }
  .rail-dot.step {
    left: 6.5px; width: 7px; height: 7px; margin-top: -3.5px;
    border: 1px solid var(--vscode-descriptionForeground, #888);
    background: var(--vscode-editor-background);
  }
  .rail-dot.turn.done { opacity: 0.75; }
  .rail-dot.step.done { opacity: 0.6; }
  .rail-dot.running {
    border-color: var(--vscode-charts-blue, var(--vscode-focusBorder));
    background: var(--vscode-charts-blue, var(--vscode-focusBorder));
  }
  .rail-dot.failed {
    border-color: var(--vscode-charts-red, #f14c4c);
    background: var(--vscode-charts-red, #f14c4c);
  }
  /* [CUSTOM- 「当前视口在哪」的指示器**刻意不用环**：这个面板里
     「环」已经被 047 定义成**键盘焦点**的语义（全局 :focus-visible 规则），
     再用 --vscode-focusBorder 画一个环，一个颜色就有了两种意思，用户分不清
     "我在哪" 与 "焦点在哪"。改用**尺寸**——scale 以中心为基准，所以不影响 #1 的圆心对齐。 */
  .rail-dot.active {
    opacity: 1;
    transform: scale(1.4);
  }
  .messages {
    flex: 1;
    overflow-y: auto;
    /* padding-left 给左侧引导条留出通道（.rail 是绝对定位的、与 #messages 同属
       .messages-column 的兄弟节点，覆盖在这条空隙上）。[CUSTOM- rail 原来挂在
       .message-area 上，随版心一起搬进了列 —— 通道必须跟着列走：它靠 .rail 的 left:0 定位，
       锚在面板上就会在列居中之后与内容脱开。
       [CUSTOM- 底部 4px → 24px：最后一条记录贴着输入框的上边框时，
       读者会以为"下面还有内容、没滚到底"（用户反馈）。留白本身就是"到头了"的信号。 */
    padding: 8px 10px 24px 19px;
    /* [CUSTOM- 留白**一贯存在**（069 的 24px + 悬浮输入卡的高度）：内容永远停在
       卡片上方、不会被它遮挡 —— 用户明确要求"消息区的触底判断应该保持在输入框上面的位置"。
       （中途试过"只在贴底那一刻让位"的条件式，那会让未到底的内容被卡片切断 —— 方向是错的，
       而且它还要在 scroll.ts 里维护"切类 + 位置补偿"，白白多出三个坑。）
       高度随输入框在 1 行与多行之间变化，由 composer.ts 的 ResizeObserver 写进
       --vac-composer-h（pitfall #27：别去列"什么会让它变高"）。
       [CUSTOM- 表单抽屉（.elic-drawer）也浮在底栏之上，同一个道理再加一段：
       --vac-elic-h 由 elicitationView.ts 的观察器写（收起成一行时它自己会变小）。 */
    padding-bottom: calc(24px + var(--vac-composer-h, 0px) + var(--vac-elic-h, 0px) + var(--vac-perm-h, 0px));
    display: flex;
    flex-direction: column;
    /* 间距交给下面的阶梯控制。统一 gap 会让「同属一组的连续推理」和「跨类型的独立块」
       看起来一样疏——那正是"不同段区分度太低"的来源。 */
    gap: 0;
    scrollbar-width: thin;
  }
  /* [CUSTOM- 子项**不许被压缩**——这条是 .messages 用 flex 排布的前提，别删。
     规范：flex 子项的「自动最小尺寸」在其 overflow 不是 visible 时**等于 0**。而工具卡
     .tool 正好有 overflow: hidden，于是内容一超出容器，flex 就把 206 张卡一起压成 2px
     （只剩两条边框），卡片内容被 overflow 裁掉——用户看到的就是"整屏白条"。
     用户气泡 / plan 卡没有 overflow，自动最小尺寸是内容高度，压不动，所以它们看起来是好的：
     user h=31 / tool h=2 / plan 正常 这组数据就是这条规范留下的指纹。
     加 flex-shrink: 0 之后，溢出的内容会交给 .messages 的 overflow-y: auto 去滚。
     对照：.tab-strip 同样是 flex + overflow，但它的子项早就写了 flex: 0 0 auto，所以从没出过这个问题。 */
  .messages > * { flex: 0 0 auto; }

  /* [CUSTOM- 内层滚动卡片的「焦点」指示（2026-10-28）：滚轮默认滚整个面板，
     只有用户**点进**某张卡片之后，这张卡片内部的滚动区才吃滚轮（见 client/scroll.ts
     的 setActive）。没有这个环，用户就无从知道"我现在的滚轮会滚谁"。
     用 outline 而不是 border：不占布局、聚焦瞬间不会让卡片抖 1px；
     outline-offset: -1px 把环画在盒子内侧，不顶到相邻内容。 */
  .messages .scroll-active {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  /* [CUSTOM- 「新输出自动展开」的卡片限高（2026-10-21）：只有带 .auto-expanded 的卡
     吃这两个变量（手动点开的不受限）。变量由 client/autoExpand.ts 写到 body 上；
     0 / 'none' = 不限。超出的内容在卡片内部滚动，而不是把整条消息拉成一堵墙。 */
  .messages .tool.auto-expanded .tool-body {
    max-height: var(--vac-tool-expand-h, 360px);
    overflow-y: auto;
  }
  .messages details.thought.auto-expanded .thought-body {
    max-height: var(--vac-thought-expand-h, 240px);
    overflow-y: auto;
  }
  /* [CUSTOM- 一张卡片只留**一个**纵向滚动条（2026-10-28）。
     自动展开时外层 .tool-body 已经是滚动视口，而它里面还套着 .tool-seg-out（510px）与
     .diff-body（340px）——三条滚动条一根套一根，用户只看得到"卡边层层嵌套"。
     这里只取消**限高**（overflow 保留：diff / 代码块仍要横向滚），超出的高度交给外层那一个。
     非自动展开的卡片同理：视口是 .tool-seg-out（510），里面的 diff 不再自己限高。
     结果：一个卡片恰好一条纵向滚动条，scroll.ts 的"最近滚动容器"也永远只有唯一答案。 */
  .messages .tool.auto-expanded .tool-body .tool-seg-out,
  .tool-body .tool-seg-out .diff-body { max-height: none; }

  /* [CUSTOM- 内层滚动区**不许把滚动链传给面板**（2026-10-28）。滚轮的拦截在 scroll.ts，
     但浏览器把某一串滚轮判成不可取消（或边界接力）时仍会自己滚——那时卡片滚到尽头就会
     带动整块面板，正是用户报的"卡片和面板一起滚"。contain 把这条链在本层掐断，
     面板只能由"指针不在卡片上"那条路滚。不许换成 auto（那会显式允许接力）。 */
  .messages .thought-body,
  .messages .tool-body,
  .messages .tool-seg-out { overscroll-behavior: contain; }

  /* [CUSTOM- 卡片内的滚动条统一细一档（2026-10-28）。此前只有 .messages 写了
     scrollbar-width: thin，卡片自己的滚动视口（.tool-body / .tool-seg-out / .thought-body /
     .diff-body）漏了 ⇒ 内层滚动条比面板外层粗一大截（用户截图圈出来的那根）。
     代码块与宽表格的滚动条同样并进来，面板里所有纵向/横向滚动条保持同一档宽度。 */
  .messages .thought-body,
  .messages .tool-body,
  .messages .tool-seg-out,
  .messages .diff-body,
  .messages .elic-preview,
  .messages .md pre,
  .messages .table-wrap { scrollbar-width: thin; }

  /* [CUSTOM- Drop feedback: shown while a file is dragged over the
     panel. Uses the focus border so it is visible in every theme. */
  body.drop-active .message-area {
    outline: 2px dashed var(--vscode-focusBorder);
    outline-offset: -4px;
  }

  /* [CUSTOM- 悬浮在消息列顶部的「本轮提问」。不透明背景是必须的——
     它盖在消息之上，半透明会让下面那行字透出来。

     [CUSTOM- 克隆体要和列表里长得一样，靠的是**把列表那套排布条件照搬过来**，
     不是给克隆体写一套新样式：
       · 用户气泡的右对齐与 88% 宽度来自 .entry-user{align-self:flex-end; max-width:88%}，
         而 align-self **只在 flex 容器里生效**。102 时这里是个普通块容器，于是克隆体左对齐、
         按块级撑开（用户报的"被拉长、没靠右"）——所以 .sticky-body 是 flex 列。
       · 水平内边距与 .messages 相同（左 19 给引导条让位、右 10）—— 内容盒宽度与列表逐像素相同，
         否则 max-width:88% 的 88% 会落在两个不同的基数上。

     [CUSTOM- 改成悬浮卡片。要点是**分成两层**：
       · 这一层只负责定位与内边距，背景透明、pointer-events: none —— 卡片周围要让内容与点击
         都透过去（悬浮，不是盖一层膜）。
       · 卡片（.sticky-card）才画底色/描边/阴影。描边在 104 里用 box-shadow 环画（避开布局
         位移），**107 已改回真 border** —— 位移由这里的 padding 差 2px 补偿，见下面 .sticky-card
         那段（pitfall #19 的同一笔账：常量只有一个来源）。
     [CUSTOM- 这一层的直接子节点现在是**多张** .sticky-card（卡堆）：它们的
     「marginTop」 由 JS 写（每张按前一张的实际底边落位），所以这里仍然只是 flex 列 + 裁剪。
     padding-top 由 stickyUser.ts 写入（那里的 TOP_GAP）——那 8px 同时是"本体交棒"的阈值，
     布局与判据必须相等，所以只留一个来源（pitfall #19）。

     [CUSTOM- **去掉 max-height: 40%**。卡堆之后它是错的裁法：卡片从下往上数，
     被裁的正好是**最下面、也就是最新**的那张（读者最需要的那一页）。现在高度由内容决定
     （最下那张卡的底边），「overflow: hidden」 只负责裁**上沿** —— 那才是"被顶出去"的裁剪来源。 */
  .sticky-user {
    position: absolute; top: 0; left: 0; right: 0; z-index: 6;
    padding: 0 8px 8px 17px;
    display: flex; flex-direction: column;
    pointer-events: none;
    overflow: hidden;
  }
  .sticky-user > * { flex: 0 0 auto; pointer-events: auto; }
  /* [CUSTOM- 高亮边框（用户要求"加些高亮/阴影，跟原消息区分开"）。107 起
     改成 **2px + --vscode-foreground**：105 用的是 1px --vscode-focusBorder，而气泡底色是
     --vscode-button-background（蓝）——两者在默认主题里都是蓝的，对比度极低，用户回报
     "看到了但很不明显"。换成前景色（深色主题近白、浅色主题近黑）压在蓝气泡上，两种主题
     都清楚。
     · 语义上仍是 border 不是环：环在这个面板里被定义为键盘焦点（062 的教训）。
     · 上面 padding 里的 17/8 与列表的 19/10 差 2，就是给这条 2px 边框让位的：
       卡片的内容盒因此**仍然逐像素等于** .messages 的内容盒（克隆体落在原位上，
       交棒时看不出接缝）。padding-top 依旧由 JS 写（TOP_GAP）。
       垂直方向的 2px 不补：边框让克隆体的落点比 TOP_GAP 低 2px，交棒那一帧因此有 2px 的
       沉降，肉眼不可见；要抹平就得让交棒窗口跟着 +2，那样这个常量就有了第二个来源
       （pitfall #19），不划算。 */
  /* [CUSTOM- 卡堆：每张卡一份 .sticky-card > .sticky-body > 克隆体（由 stickyUser.ts
     动态建）。子节点顺序从旧到新（旧的在上），「marginTop」 由 JS 按前一张的实际底边写。 */
  .sticky-card {
    position: relative;
    display: flex; flex-direction: column;
    background: var(--vscode-sideBar-background);
    border: 2px solid var(--vscode-foreground);
    border-radius: 8px;
    box-shadow: 0 4px 10px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
    overflow: hidden;
    cursor: pointer;
  }
  .surface-editor .sticky-card { background: var(--vscode-editor-background); }
  /* 同 .messages > *（037）：克隆体在"列 flex + overflow:hidden"里同样不许被压缩。 */
  .sticky-body { display: flex; flex-direction: column; }
  .sticky-body > * { flex: 0 0 auto; }
  /* [CUSTOM- 收缩：**不再自造 .collapsed 类** —— 直接开合克隆体里的原生
     <details>（用户要求：与界面里的折叠同一套逻辑）。于是字形、"收成一行"、
     "图片/文件与文字同行"这些规则全部复用记录列表那一套，这里一条都不用写。
     自造一套的代价 169 已经付过：被同权重的记录列表规则压掉，折叠"只加类、不动画面"。 */
  /* [CUSTOM- 悬浮条"被抽出来"的入场：新建那张卡时加 .entering，
     动画结束由 host 上的 animationend 委托摘掉 —— 不是每次 sync 都播（sync 每帧都在跑）。
     [CUSTOM- 选择器从 .sticky-user 改成 .sticky-card：卡堆里是**每张卡**各播一次
     （新卡进来时），而不是整层播。 */
  @keyframes vac-sticky-in {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: none; }
  }
  .sticky-card.entering { animation: vac-sticky-in 160ms ease-out; }
  @media (prefers-reduced-motion: reduce) { .sticky-card.entering { animation: none; } }
  /* [CUSTOM- 时刻的显隐由 .messages.show-times 控制，而克隆体不在 #messages 里
     —— 不同步这个状态就会出现"列表有时刻、置顶副本没有"。show-times 由 render() 从
     #messages 抄到 host 上。
     [CUSTOM- 但这条规则现在**不再需要**：时刻只留给工具卡（见 .rec-time 那段），
     而置顶条里永远是用户消息 ⇒ 克隆体上不该出现时刻。留着它反而会让"开关一开，置顶那份
     凭空多个时刻"。 */
  .sticky-user.show-times .rec-time { display: none; }
  /* [CUSTOM- 本体交棒给悬浮条时隐藏：副本已经站在它原来的位置上，留着就是同屏两份。
     用 visibility 而不是 display —— 几何保持不变，rail 的测量与 jumpTo 依赖的 offsetTop 都还成立。

     **'.messages' 这个前缀是承重的，不是修饰**：cloneNode 会连 class 一起复制，而副本不在
     #messages 里 —— 去掉前缀，换成副本看不见（悬浮条"打不开了"，静默）。render() 里另有一道
     同因的防线（显式摘掉这个类）。 */
  .messages .sticky-source { visibility: hidden; }
  /* 三档间距阶梯：同类紧 / 跨类松 / 轮次边界最松。
     data-kind 由 transcriptView.place() 打在每条上，这里纯用兄弟选择器实现。 */
  .messages > * + * { margin-top: 10px; }
  .messages > [data-kind="thought"] + [data-kind="thought"] { margin-top: 2px; }
  .messages > [data-kind="tool"]    + [data-kind="tool"]    { margin-top: 4px; }
  .messages > [data-kind="content"] + [data-kind="content"] { margin-top: 2px; }
  .messages > [data-kind="user"] { margin-top: 16px; }
  .jump-latest {
    /* [CUSTOM- 底栏浮在面板底部，这个按钮要跟着抬起来，否则会被输入卡盖住。
       [CUSTOM- 表单抽屉也浮在同一处，所以再抬一段（同 --vac-composer-h 的写法）。 */
    position: absolute; left: 50%; transform: translateX(-50%);
    bottom: calc(12px + var(--vac-composer-h, 0px) + var(--vac-elic-h, 0px) + var(--vac-perm-h, 0px));
    padding: 3px 10px; border-radius: 12px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; font-family: inherit; font-size: 0.9em;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
  }
  .jump-latest:hover { background: var(--vscode-button-hoverBackground); }

  /* [CUSTOM- 空态居中：它原来是 #messages 的**兄弟**，而 .message-area 是 flex 行、
     #messages 是 flex: 1 —— 自由空间被它吃光，margin: auto 没有可分配的余量可分，
     于是空态被顶到最右边（面板越宽越明显；窄侧边栏里看不出来，所以一直没被发现）。
     改为**覆盖在消息区之上并自我居中**（.message-area 本来就是 position: relative，
     .jump-latest 早就这么用）。不占布局，也不会与谁重叠：空态出现 ⟺ 没有聚焦会话 ⟺ 没有锚点
     ⟺ 081 已经把大纲栏与引导条收掉了。 */
  /* 状态卡（取代 090 的空态排版）。
     居中的方式很关键：**不用** 'justify-content: center' + 容器滚动——内容一旦比消息区高，
     center 会把顶部裁掉且**滚不到**（pitfall #17 同族）。改成
     「容器 flex-start + 卡片 margin: auto」：有富余空间时两轴居中，超高时可完整滚动。
     这一层的 display 唯一写者是 boot.showEmpty()，所以这里可以放心写 flex。 */
  .empty-state {
    position: absolute; top: 0; right: 0; bottom: 0; left: 0;
    display: flex; flex-direction: column; align-items: center;
    justify-content: flex-start; overflow-y: auto;
    text-align: center; color: var(--vscode-descriptionForeground); padding: 20px;
  }
  .state-card {
    /* 'margin: auto' 是上面那条居中的另一半，不要删。
       'width: 100%' 让卡片跟随容器收缩（上限 max-width）。卡片是纵向 flex 的子项，交叉轴
       不会被拉伸，宽度只能靠 width 显式约束 —— 否则它取 fit-content，在窄侧边栏里会不会
       自己收下去就成了"关于浏览器行为的推断"（pitfall #31）。
       实测（preview-records 的 #emptynarrow，把消息区钉死 260px）：cardW=220、居中偏差 0、无裁切。 */
    width: 100%;
    margin: auto;
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    max-width: 420px; padding: 18px 20px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    /* ⚠️ 这里**绝不能**写 overflow：卡片是 flex 列的子项，overflow 非 visible 会把它的
       自动最小尺寸变成 0，卡片会被压扁（pitfall #17）。 */
  }
  /* 转圈槽位：固定最小高度，连接中之外空着也不让标题上下跳。
     #stateBusy 只由 hidden 切换——**不要**给它写 display，否则它会永远可见（pitfall #13）。 */
  .state-head { display: flex; align-items: center; justify-content: center; min-height: 16px; }
  .state-title { margin: 0; font-weight: 600; color: var(--vscode-foreground); }
  .state-hint { margin: 0; font-size: 0.92em; }
  .state-error {
    margin: 0; max-width: 100%; text-align: left; font-size: 0.92em;
    padding: 4px 8px; border-radius: 3px; word-break: break-word;
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-errorBackground, transparent);
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }
  .state-actions { display: flex; gap: 6px; margin-top: 4px; }
  .state-connect {
    padding: 4px 14px; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: 0.95em;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .state-connect:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  /* 连接中 = 不可点：用 secondary 配色而不是压暗前景色，明暗主题下都可读。 */
  .state-connect:disabled {
    cursor: default; opacity: 0.65;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  }
  .state-opt {
    display: flex; align-items: center; gap: 6px; cursor: pointer;
    margin-top: 2px; font-size: 0.88em;
  }
  /* 选择器限定在本卡片内：写成全局 input[type=checkbox] 会连带改掉表单卡（119）的复选框。 */
  .state-opt input { flex: none; margin: 0; accent-color: var(--vscode-button-background); }

  .entry { display: flex; flex-direction: column; gap: 4px; max-width: 100%; }
  /* [CUSTOM- 用户消息**靠左铺满**（用户要求）。原来是 align-self:flex-end +
     max-width:88%，于是气泡宽度=内容宽度(fit-content)：短消息是个小气泡，而折叠后只剩首行、
     宽度随之缩短 —— 面板在折叠/展开时"会自己变窄"，读起来像布局在跳。铺满之后宽度是常量，
     折与不折只影响高度。顺带：正文与时刻同一起点，圆角也改成四角一致（原来的 8/8/2/8
     是"右下收尾"的对话气泡形，靠左之后那个缺口指向反了）。 */
  .entry-user { align-self: stretch; }
  /* [CUSTOM- 气泡观感同时挂在「单行气泡」与「多行折叠的 details」上，
     所以展开时背景与圆角是**连续的一整块**，不会出现两条气泡。 */
  .entry-user .bubble,
  .entry-user .user-fold {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    padding: 6px 10px; border-radius: 8px;
    white-space: pre-wrap; word-break: break-word;
  }
  /* 折叠时背景与内边距在 details 上，summary 只是它的第一行——必须抹掉，
     否则会出现两层内边距 / 两层背景。 */
  .entry-user .user-fold > summary {
    cursor: pointer; user-select: none; list-style: none;
    background: transparent; padding: 0; border-radius: 0; color: inherit;
  }
  /* [ 补] 展开态的**正文第一行**必须可框选。它落在 summary 里，而上面那条
     user-select: none（summary 整体当"切换区"的历史写法）连同 cursor: pointer 一起把它按住了 ——
     鼠标变成手、还选不中（用户 2026-10-09 报："展开情况下正文第一行还是无法框选，鼠标变手，
     点了又没反应"；第一行之外的各行在 fold-body 里，本来就能选）。展开态给 .bubble-body 解禁
     （文字恢复文本光标 + 可选中；点击不再折叠由 213 的 click 拦截负责）；**折叠态刻意不解禁** ——
     那一行预览按用户要求就是"点它就展开"的切换区。 */
  .entry-user .user-fold[open] > summary .bubble-body { user-select: text; cursor: text; }
  /* [CUSTOM- 正文从第二行开始（图标与折叠三角留在第一行）。
     .bubble-body 是 block，所以 summary 里的文字永远另起一行；折叠态的截断
     作用在它自己身上（不再是整个 summary，否则图片 chip 也会被截掉）。 */
  .bubble-body { display: block; }
  /* [CUSTOM- 折叠时正文提到第一行（用户要求）：
     图标/caret 与"优化下排版"在同一行，而不是把正文挤到第二行。 */
  .entry-user .user-fold:not([open]) .bubble-body {
    display: inline;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* [CUSTOM- 图片 chip 在气泡内：第一行、caret 之后、正文之前。
     图片在 summary 里，气泡内留一点间距。 */
  /* [CUSTOM- 气泡内的图片 chip 用深色半透明底：chip 的默认底色
     (--vscode-textCodeBlock-background) 压在蓝气泡上对比度太低，图片名几乎看不见。 */
  /* [CUSTOM- 带图片的气泡：summary 改为 flex 行，图标/caret/chip 都排在
     第一行，正文（.bubble-body）用 flex-basis:100% 撑到第二行。
     **注意**：无图片时 bubble-body 是 block（自然另起一行），不能给所有 summary 都套 flex
     —— block 在 flex 容器里不会换行，会把正文挤到与图标同一行。 */
  /* [CUSTOM- 文件 chip（'.chip-row' 里那个 .chip）与图片 chip **同栏**：
     以前 summary 只在 ':has(.content-image-chip)' 时才变 flex 行，而文件 chip 外面那层 '.chip-row'
     是个块级 div ⇒ 它自己占一行（用户报的第 1 条：文件 tag 掉到了第二行）。
     两条一起收：summary 变 flex 行 + 那层包装不占盒（'display: contents'），chip 自己成为 flex 项。 */
  .entry-user .user-fold > summary:has(.content-image-chip),
  .entry-user .user-fold > summary:has(.chip-row) {
    display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px;
  }
  .entry-user .user-fold > summary .chip-row { display: contents; }
  /* [CUSTOM- 用户气泡里的文件 tag 加高一点：'.chip' 默认 'padding: 0 5px'（零纵向内边距），
     文件名被上下描边紧压着（用户报的第 2 条）。**只加在气泡内**，工具卡那套 chip 的几何不动
     （122 的"两侧正文同起于 x=71"是量过的）。 */
  .entry-user .user-fold > summary .chip { padding: 2px 6px; }
  /* [CUSTOM- chip 里的 '</>' 图标（见 toolCallView 的 resource_link 分支）。 */
  .chip-icon { display: inline-flex; align-items: center; }
  .chip-icon svg { display: block; width: 12px; height: 12px; opacity: 0.85; }
  /* [CUSTOM- 折叠时 bubble-body 也是 flex 项（不占满一行），与图标/caret 同行。 */
  .entry-user .user-fold:not([open]) > summary:has(.content-image-chip) .bubble-body,
  .entry-user .user-fold:not([open]) > summary:has(.chip-row) .bubble-body {
    flex-basis: auto;
  }
  .entry-user .user-fold > summary:has(.content-image-chip) .bubble-body,
  .entry-user .user-fold > summary:has(.chip-row) .bubble-body {
    flex-basis: 100%;
  }
  .entry-user .content-image-chip {
    margin: 2px 4px 2px 0;
    vertical-align: middle;
    background: rgba(0, 0, 0, 0.25);
    border-color: rgba(255, 255, 255, 0.15);
  }
  .entry-user .user-fold > summary::-webkit-details-marker { display: none; }
  /* 折叠态：summary 占**恰好一行**并以省略号截断——现在只截正文（.bubble-body），
     图标与折叠三角留在第一行（[CUSTOM-）。
     **只在折叠态生效**——展开时若还是 nowrap，第一段会被截成"半句话加省略号"。 */
  /* 展开态：body 是 **inline**，从切分点接着往下流。切分点只是实现细节
     （长单行消息没有换行可切），用块级 body 会在半句话处多出一处换行。 */
  .entry-user .user-fold .fold-body {
    display: inline;
    white-space: pre-wrap; word-break: break-word;
  }
  /* 展开态：body 是 **inline**，从切分点接着往下流。切分点只是实现细节
     （长单行消息没有换行可切），用块级 body 会在半句话处多出一处换行。 */
  .entry-user .user-fold .fold-body {
    display: inline;
    white-space: pre-wrap; word-break: break-word;
  }
  .entry-assistant { align-self: stretch; }
  /* [CUSTOM- 助手消息也是 <details>（与用户消息同一套折叠控件），
     **外观因此挂在 details 上**——它现在包住「标题行 + 正文」两段，而原来只有一个 .bubble。 */
  .entry-assistant .msg-fold {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px 8px 8px 2px;
    padding: 6px 10px;
    word-break: break-word;
    white-space: pre-wrap;
  }
  /* 标题行（图标 + 折叠三角 + 折叠时的首行预览）就是切换区。**正文刻意不在 summary 里**：
     在 <summary> 里划选文本 == 点它，读者选中一段回答就会把它折起来；而 markdown 正文里
     还有链接 / 代码 Copy / 图片 chip。见 buildAssistantFold 的注释。 */
  .entry-assistant .msg-head {
    cursor: pointer; user-select: none; list-style: none; padding: 0;
  }
  .entry-assistant .msg-head::-webkit-details-marker { display: none; }
  /* 展开态：图标行在上、正文在下（正文是 summary 的块级兄弟，天然另起一行）。 */
  .entry-assistant .bubble-body.md { white-space: normal; }
  /* [CUSTOM- 折叠态：正文被浏览器整块藏起来（details 的默认行为，作者样式
     **抢不过**——115 用 display 试过，折叠后正文依旧不可见），所以"首行"由 summary 里的
     .msg-preview 提供 —— 它是**真文本节点**，随正文内容更新（refreshPreview）。
     展开时必须藏掉它，否则正文上方会多出一份重复的首行。 */
  .entry-assistant .msg-fold[open] .msg-preview { display: none; }
  /* 折叠态那一行不换行、超出省略号（与用户消息折叠后一样只占一行）。 */
  .entry-assistant .msg-fold:not([open]) > .msg-head {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .entry-notice { align-self: center; font-size: 0.9em; padding: 2px 8px; border-radius: 4px; }
  /* --- Record-type icons () -------------------------- */
  /* 每类记录左侧一个内联 SVG 图标。用 currentColor 描边，所以自动跟随所在文字的颜色
     （用户气泡=按钮前景色、推理=次要色、工具卡=正文色）。 */
  .rec-icon {
    display: inline-flex; align-items: center; vertical-align: -1px;
    margin-right: 4px; opacity: 0.7;
  }
  .rec-icon svg { display: block; }
  .tool-icon { flex: 0 0 auto; display: inline-flex; align-items: center; opacity: 0.7; }
  .tool-icon svg { display: block; }
  /* --- Form: ACP elicitation / AskUserQuestion (, 152 改悬浮抽屉) ----
     与权限卡同一族观感（它也是**阻塞的**：agent 在等到答复前不会继续），但内容是一张表单，
     所以用的是 VS Code 的输入控件配色，而不是自造一套。

     [152] 分成两层：
       · 记录层（.elic）：内联的一条记录。pending 时**只有一行**"待回答"（表单本体在抽屉里，
         内联卡会把记录区撑长、也不像"现在需要你操作"）；结算后是只读的问答摘要（历史）。
       · 抽屉层（.elic-drawer，body 级浮层）：贴在输入卡之上、与它同宽同中线。多道题按 tab
         分页，题内控件见下面的 .elic-select / .elic-option / .elic-input。 */
  .entry-elicitation { align-self: stretch; }
  .elic {
    border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-panel-border));
    border-left-width: 3px;
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; gap: 8px;
  }
  .elic.pending { border-left-color: var(--vscode-focusBorder, var(--vscode-charts-blue)); }
  .elic.deferred { opacity: 0.75; }
  .elic.accepted, .elic.declined, .elic.cancelled {
    border-left-color: var(--vscode-panel-border); background: transparent;
  }
  .elic-title { font-size: 0.95em; font-weight: 600; word-break: break-word; }
  .elic-body { display: flex; flex-direction: column; gap: 8px; }
  .elic-field { display: flex; flex-direction: column; gap: 3px; }
  /* The "Other" box belongs to the question above it, so it is indented and quiet. */
  .elic-field.elic-other { margin-left: 14px; opacity: 0.9; }
  .elic-label { font-size: 0.9em; color: var(--vscode-descriptionForeground); }
  .elic-help { font-size: 0.92em; word-break: break-word; }
  .elic-option { display: flex; align-items: baseline; gap: 6px; cursor: pointer; }
  .elic-option.static { cursor: default; }
  .elic-option input { flex: none; margin: 0; }
  .elic-option-text { display: flex; flex-direction: column; }
  .elic-option-label { font-size: 0.95em; }
  .elic-option-desc { font-size: 0.88em; color: var(--vscode-descriptionForeground); }
  .elic-input {
    font-family: inherit; font-size: 0.95em; width: 100%;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 3px; padding: 3px 6px;
  }
  .elic-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .elic-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .elic-btn {
    font-family: inherit; font-size: 0.92em; padding: 3px 10px; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .elic-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .elic-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .elic-btn:disabled { cursor: default; opacity: 0.5; }
  .elic-note { font-size: 0.88em; color: var(--vscode-descriptionForeground); }
  .elic-note:empty { display: none; }

  /* --- [CUSTOM-231 已答回执卡（标出所选 / 可折叠）------------------------ */
  /* 标题行就是折叠区。折起来走**原生 details**——与记录区的消息 / Thought 同一套机制，
     三角直接复用 .fold-caret（它的方向由 details[open] 驱动，不需要 JS）。默认展开
     （见 elicitationView.fill 的 fold.open = true）：这张卡的意义就是让人一眼看到答了什么。 */
  .elic-fold > summary {
    display: flex; align-items: baseline; gap: 8px; cursor: pointer;
    list-style: none; user-select: none;
  }
  .elic-fold > summary::-webkit-details-marker { display: none; }
  .elic-fold > summary .elic-title { flex: 1; min-width: 0; }
  .elic-count { flex: none; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .elic-fold > .elic-body { margin-top: 6px; }
  /* [CUSTOM-231 每个选项前面画一个单选圈：未选空心、选中实心并加粗 —— 左列因此对齐，
     只看卡片就能读出答了哪个，不必回头去读底下那行 summary。圈自己是 flex 项，
     用 align-self 挪到标签那一行的高度（.elic-option 是 baseline 对齐的）。 */
  .elic-option.static::before {
    content: ''; flex: none; align-self: flex-start; margin-top: 0.3em;
    width: 9px; height: 9px; box-sizing: border-box;
    border: 1px solid var(--vscode-descriptionForeground); border-radius: 50%;
  }
  .elic-option.static.picked::before {
    background: var(--vscode-focusBorder, var(--vscode-charts-blue));
    border-color: var(--vscode-focusBorder, var(--vscode-charts-blue));
  }
  .elic-option.static.picked .elic-option-label { font-weight: 600; }
  /* 非选项字段（文本 / 数字 / 布尔）的答案，以及自拟答案那一行。 */
  .elic-answer { font-size: 0.95em; }
  /* [CUSTOM-231 选项预览：**就地展开在被选行下方**（不是 Claude 那种右侧分栏 —— 这个面板的
     宽度就是侧栏宽度）。等宽 + white-space: pre：preview 里是 ASCII 框图，一个空格的宽度都得
     留住，所以不换行、放不下就横向滚。缩进与自拟框对齐（22px）。 */
  .elic-preview {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em; line-height: 1.35;
    white-space: pre; overflow: auto; max-height: 220px;
    margin: 4px 0 2px 22px; padding: 6px 8px;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  }
  .elic-preview[hidden] { display: none; }

  /* --- [CUSTOM- 记录里的"待回答"条 --------------------------- */
  /* [CUSTOM- 权限的记录行与它逐条同构（同一个形状、同一份样式），
     所以选择器并组 —— 两处各写一份就是 pitfall #19 说的那种"迟早只改一边"。 */
  .elic-pending-row, .perm-pending-row { display: flex; align-items: center; gap: 6px; }
  .elic-pending-icon, .perm-pending-icon { flex: none; font-size: 0.95em; }
  .elic-pending-text, .perm-pending-text {
    flex: 1; min-width: 0; font-size: 0.92em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .elic-open, .perm-open {
    flex: none; font-family: inherit; font-size: 0.88em; padding: 2px 8px;
    border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
  }
  .elic-open:hover, .perm-open:hover { background: var(--vscode-button-hoverBackground); }

  /* --- [CUSTOM- 抽屉 ---------------------------------------- */
  /* 定位：与输入卡**同一套居中规则**（用户 2026-10-01 报"没居中"）。输入卡的中心不是面板中心：
     '.composer-main' 是"面板宽 − 预留功能区（--vac-aside-w，钉住大纲栏时 240px）"，卡片在它
     里面居中 —— 所以抽屉的包含块必须用 right 把那一段让出来，否则钉住大纲时抽屉会整体右移
     asideW/2（实测差 ~120px）。'.composer-main' 的 padding-inline: 8px 用 '100% - 16px' 对齐。
     **不要**用 transform 居中 —— 抽屉里的下拉菜单是 position: fixed，transform 会让它变成
     "相对该元素"定位。bottom 跟着 --vac-composer-h：浮层叠在底栏之上，两者一起由消息区的
     留白让位。 */
  /* [CUSTOM- 停止确认条：与输入卡同宽同中线、贴在它上方；观感沿用抽屉那一套。
     不抢焦点、不模态（role=alertdialog），所以它不需要 z-index 之争 —— 它就在流里。 */
  .stop-confirm {
    display: flex; align-items: center; gap: 8px;
    width: 100%; margin: 0 0 6px; padding: 6px 10px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
    border-radius: 6px; font-size: 0.9em;
  }
  .stop-confirm-text { flex: 1; min-width: 0; }
  .stop-confirm-btn {
    flex: none; padding: 2px 10px; cursor: pointer; font-family: inherit; font-size: inherit;
    color: var(--vscode-button-secondaryForeground, inherit);
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  }
  .stop-confirm-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground, transparent)); }
  .stop-confirm-btn[data-stop-confirm="stop"] {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-inputValidation-errorBorder, var(--vscode-button-background, #0e639c));
    border-color: transparent;
  }

  /* [CUSTOM- 「这个 agent 吃不了轮次中的补充消息」那条说明。
     与 #stopConfirm 同一个位置家族（.composer-inner 里、输入卡上方），但它是**陈述**不是提问：
     没有按钮、不抢焦点，用最轻的描边与描述色，避免在长轮次里喧宾夺主。 */
  .steer-hint {
    width: 100%; margin: 0 0 6px; padding: 5px 10px;
    color: var(--vscode-descriptionForeground);
    background: transparent;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 6px; font-size: 0.88em;
  }

  .elic-drawer, .perm-drawer {
    position: fixed; left: 0; right: var(--vac-aside-w, 0px); margin: 0 auto;
    bottom: var(--vac-composer-h, 0px);
    width: min(100% - 16px, var(--vac-composer-max, 720px));
    max-height: min(70vh, 560px);
    z-index: 9;                       /* 高于底栏（8），低于右键菜单（60）与图片浮层（90） */
    display: flex; flex-direction: column;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-panel-border));
    border-radius: 8px;
    box-shadow: 0 -2px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
  }
  .elic-drawer[hidden], .perm-drawer[hidden] { display: none; }
  /* [CUSTOM- 权限抽屉：与表单抽屉同形，但**贴在它上面**（两者可能同时 pending：
 同一会话先来表单又来权限），所以 bottom 要把表单那一段让出来 —— 各自的高度变量相加，
    不需要 JS 协调谁在上面。高度上限也单独收小：权限提示天然只有一行标题加几个按钮，
    两个 70vh 的抽屉叠起来会把面板淹没。 */
  .perm-drawer {
    bottom: calc(var(--vac-composer-h, 0px) + var(--vac-elic-h, 0px));
    max-height: min(50vh, 320px);
  }
  .perm-drawer-card { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .perm-drawer-hint { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  /* [CUSTOM- 抽屉的头部行没了：tab 条、进度与收起箭头合成一条 bar，
     进度与箭头靠右（用户要求）。收起时 tab 条让位给当前题的名字。 */
  .elic-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 2px 8px 0 10px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .elic-progress { flex: none; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .elic-toggle {
    flex: none; width: 22px; height: 20px; padding: 0; cursor: pointer;
    background: transparent; border: none; color: inherit; font-family: inherit;
    font-size: 0.8em; line-height: 1;
  }
  .elic-toggle:hover { background: var(--vscode-toolbar-hoverBackground, transparent); border-radius: 3px; }
  /* 收起态 = 只剩 bar 这一行（用户要的"^ 收成一行"）：正文与操作栏都藏起来。
     [CUSTOM- **tab 条留在原地**（用户要求）：收起后仍要看得见每一题的标题与
     圆点状态（已答/未答），而不是只显示当前那一题 —— 否则收起等于"看不见还剩几题没答"。
     点其中任一 tab 会展开到那一题（见 onDrawerClick）。 */
  .elic-drawer.collapsed .elic-note { display: none; }
  .elic-drawer.collapsed .elic-panes { display: none; }
  .elic-drawer.collapsed .elic-actions { display: none; }
  .elic-form { display: flex; flex-direction: column; min-height: 0; }
  /* 操作栏与结果说明固定在抽屉底部（表单区自己滚，按钮不跟着滚走）。 */
  .elic-drawer .elic-actions { padding: 8px 10px; border-top: 1px solid var(--vscode-panel-border); }
  .elic-drawer .elic-note { padding: 0 10px 8px; }
  .elic-tabs {
    display: flex; flex-wrap: wrap; gap: 2px; flex: 1; min-width: 0;
  }
  .elic-tab {
    display: flex; align-items: center; gap: 5px; max-width: 100%;
    font-family: inherit; font-size: 0.88em; padding: 3px 8px; cursor: pointer;
    background: transparent; color: var(--vscode-descriptionForeground);
    border: none; border-bottom: 2px solid transparent;
  }
  .elic-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .elic-tab-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .elic-tab-dot {
    flex: none; width: 6px; height: 6px; border-radius: 50%;
    background: var(--vscode-descriptionForeground); opacity: 0.5;
  }
  .elic-tab.answered .elic-tab-dot { background: var(--vscode-charts-green, #89d185); opacity: 1; }
  /* 表单区可滚动（表单可以很长）。 */
  .elic-panes { padding: 10px; overflow-y: auto; min-height: 0; }
  .elic-panes .elic-field[hidden] { display: none; }
  .elic-unanswered { font-size: 0.85em; color: var(--vscode-descriptionForeground); opacity: 0.85; }
  .elic-unanswered[hidden] { display: none; }
  .elic-custom-label {
    margin-top: 4px; font-size: 0.88em; color: var(--vscode-descriptionForeground);
  }
  .elic-custom-hint { font-size: 0.82em; color: var(--vscode-descriptionForeground); opacity: 0.85; }
  /* [CUSTOM- 自拟框：跟着**被选中的那一行**走（默认藏着，选了才出现）。 */
  .elic-custom { display: flex; flex-direction: column; gap: 3px; margin: 4px 0 2px 22px; }
  .elic-custom[hidden] { display: none; }
  /* 单选改成平铺的 radio 列表（用户 2026-10-01 的修改）：每行 = 主标题 + 副标题（说明），
     自拟框插在选中行的下面（见 .elic-custom 的 margin-left 缩进）。 */
  .elic-option-row { display: flex; flex-direction: column; }
  .elic-option-row + .elic-option-row { margin-top: 6px; }
  .elic-option-row .elic-option { align-items: flex-start; }
  .elic-option-row .elic-option input { margin-top: 2px; }
  .elic-option-row .elic-option-desc { margin-top: 1px; }
  .elic-option-row.elic-other-row .elic-option-label { color: var(--vscode-descriptionForeground); }
  .elic-clear {
    align-self: flex-start; margin-top: 4px; padding: 0;
    font-family: inherit; font-size: 0.82em; cursor: pointer;
    background: transparent; border: none; color: var(--vscode-textLink-foreground, var(--vscode-descriptionForeground));
    text-decoration: underline;
  }
  .elic-clear[hidden] { display: none; }

  /* --- Permission card () --------------------------- */
  /* [CUSTOM- sub-agent 子会话卡（ACP draft subagent_update）：身份 + 工作状态 + 取消。
     子会话**自己的输出内联在父会话的记录里**（宿主把子会话别名回父会话），所以这张卡刻意做得很
     轻 —— 它不是可折叠容器，不重复那份输出。 */
  .entry-subagent { align-self: stretch; }
  .subagent {
    border: 1px solid var(--vscode-panel-border);
    border-left-width: 3px;
    border-radius: 6px;
    padding: 6px 10px;
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; gap: 4px;
  }
  .subagent-head { display: flex; align-items: center; gap: 8px; }
  .subagent-title {
    flex: 1; font-size: 0.9em; color: var(--vscode-descriptionForeground);
    word-break: break-word;
  }
  .subagent-state {
    flex: none; font-size: 0.78em; padding: 0 6px; border-radius: 3px;
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .subagent-state[data-state="running"] {
    color: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); border-color: currentColor;
  }
  .subagent-state[data-state="requires_action"] {
    color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); border-color: currentColor;
  }
  .subagent-cancel {
    flex: none; padding: 2px 10px; border-radius: 4px; cursor: pointer; font-size: 0.8em;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-panel-border);
  }
  .subagent-cancel:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
  }
  .subagent-desc { font-size: 0.85em; color: var(--vscode-descriptionForeground); word-break: break-word; }

  /* 面板内的权限请求卡：替代窗口级 QuickPick。配色故意用 warn 边框而不是普通卡片，
     因为它是**阻塞的**——agent 在等到答复前不会继续。 */
  .entry-permission { align-self: stretch; }
  .perm {
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
    border-left-width: 3px;
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-background));
    display: flex; flex-direction: column; gap: 8px;
  }
  .perm.pending { border-left-color: var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground)); }
  .perm.deferred { opacity: 0.75; }
  .perm.selected, .perm.cancelled { border-left-color: var(--vscode-panel-border); background: transparent; }
  .perm-head { display: flex; align-items: center; gap: 6px; }
  .perm-badge {
    flex: none; width: 16px; height: 16px; border-radius: 50%;
    background: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
    color: var(--vscode-editor-background);
    font-size: 0.75em; font-weight: 700; line-height: 16px; text-align: center;
  }
  .perm-title { flex: 1; font-size: 0.95em; word-break: break-word; }
  .perm-kind {
    flex: none; font-size: 0.8em; padding: 0 5px; border-radius: 3px;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
  }
  .perm-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .perm-btn {
    padding: 3px 12px; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: 0.92em;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  }
  .perm-btn.allow {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .perm-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .perm-btn:disabled { cursor: default; opacity: 0.5; }
  .perm-note { font-size: 0.88em; color: var(--vscode-descriptionForeground); }
  /* Non-text message content (image / resource chips) */
  .entry-content { align-self: stretch; gap: 2px; }
  .entry-notice.info { color: var(--vscode-descriptionForeground); }
  /* [CUSTOM- 切换提示（模型 / 模式 / 配置项）：居中的分隔式一行，参照
     Claude 官方插件的「Switched to …」。它不是一条内容气泡，而是时间线上的一处标记，
     所以左右各引一条虚线把它与两侧内容分开，并且**占满整行**。
     必须显式写 flex-direction: row —— .entry 是 column，只覆盖 display 会让两条虚线
     上下堆叠（分隔线跑到文字上方和下方，看起来像一条空记录）。 */
  .entry-notice.switch {
    align-self: stretch;
    display: flex; flex-direction: row; align-items: center; gap: 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.88em;
  }
  .entry-notice.switch::before,
  .entry-notice.switch::after {
    content: ''; flex: 1 1 auto; min-width: 12px;
    border-top: 1px dashed var(--vscode-panel-border);
  }
  .entry-notice.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-foreground)); }
  /* [CUSTOM- 注入块（<task-notification> 等）：不是用户输入，也不该是气泡。
     居中、灰色、小字，不拿 icon（icon 是"谁说的"的记号，而它不是任何一方）。 */
  .entry-notice.meta {
    align-self: stretch;
    text-align: center;
    font-size: 0.82em;
    color: var(--vscode-descriptionForeground);
    opacity: 0.85;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .entry-notice.error {
    color: var(--vscode-inputValidation-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
  }

  /* Markdown
     [CUSTOM- 作用域是 .bubble **和** .md：助手气泡（.bubble.md）与
     思考块正文（.thought-body.md）走的是同一条 markdown 往返，排版规则必须共用——
     各写一套就是「同一份知识存两份」（pitfalls #19）。 */
  .bubble p, .md p { margin: 0 0 6px; }
  .bubble p:last-child, .md p:last-child { margin-bottom: 0; }
  .bubble h1, .bubble h2, .bubble h3, .bubble h4, .bubble h5, .bubble h6,
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 8px 0 4px; line-height: 1.3; }
  .bubble ul, .bubble ol, .md ul, .md ol { margin: 4px 0; padding-left: 20px; }
  .bubble pre, .md pre {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 4px; padding: 8px; overflow-x: auto; margin: 6px 0;
  }
  .bubble code, .md code {
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size, 0.95em);
  }
  .bubble :not(pre) > code, .md :not(pre) > code {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 0 3px;
  }
  .bubble blockquote, .md blockquote {
    margin: 6px 0; padding-left: 10px;
    border-left: 3px solid var(--vscode-panel-border);
    color: var(--vscode-descriptionForeground);
  }
  .bubble table, .md table { border-collapse: collapse; margin: 6px 0; }
  /* [CUSTOM- 宽表格自己的横向滚动容器（由 links.decorateScrollables 套上）。
     与 .bubble pre 同一个套路：滚动发生在块内部，气泡本身不被撑宽。
     min-width:0 让它在 flex/宽度受限的父级里真的能收缩，否则 overflow 不会生效。 */
  .table-wrap { overflow-x: auto; max-width: 100%; }
  .table-wrap > table { margin: 6px 0; }
  .bubble th, .bubble td, .md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; }
  /* [CUSTOM- 工具输出的 md 表格不要再被 pre-wrap 拖下水：
     .tool-text 是 white-space: pre-wrap（工具正文一直是字面文本），而 218 起其中会拿
     markdown（元素化），marked 输出的块间换行会被 pre-wrap 再渲染一遍 ⇒ 每行下多一行空白、
     单元格内按原文折行，"约**十二万九千六百年**"被折成两行两截。
     修两边：宿主上的 '.md' 复位空白（与 .thought-body.md 同一条），表格自己则要求单元格
     能自然折行但不靠换行符撑开 —— '十二万九千六百年' 是一个词，别在中途断它。 */
  .md th, .md td { white-space: normal; word-break: keep-all; overflow-wrap: anywhere; }
  .bubble a, .md a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  .bubble a:hover, .md a:hover { text-decoration: underline; }
  /* [CUSTOM- Markdown 渲染预设（2026-10-27 引入；2026-10-28 重做，设置 → Appearance）。
     'editor'（默认）= 上面那套「跟随主题变量」的逻辑，不加任何覆盖。
     其余三套参考成熟应用：GitHub / Obsidian / Typora —— 不只改排版，也各带一套配色。
     配色只在 vscode-light / vscode-dark 下取硬值（每个预设都能明暗各看一套），
     默认变量仍指向主题 token，因此高对比度主题回落到编辑器的可读性配色、不被硬色覆盖。
     变量定义在 body 上，规则统一作用于 .md（助手气泡 / 推理正文 / 工具输出）。 */

  /* GitHub：GitHub 正文观感 —— 蓝链接、灰细描边、表头底色、标题下边框。 */
  body[data-md-style="github"] {
    --vac-md-fg: var(--vscode-foreground);
    --vac-md-link: var(--vscode-textLink-foreground);
    --vac-md-border: var(--vscode-panel-border);
    --vac-md-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-inline-code-fg: var(--vscode-foreground);
    --vac-md-inline-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-quote-fg: var(--vscode-descriptionForeground);
    --vac-md-quote-border: var(--vscode-panel-border);
    --vac-md-quote-bg: transparent;
    --vac-md-th-bg: var(--vscode-textCodeBlock-background);
  }
  body.vscode-light[data-md-style="github"] {
    --vac-md-fg: #1f2328;
    --vac-md-link: #0969da;
    --vac-md-border: #d1d9e0;
    --vac-md-code-bg: #f6f8fa;
    --vac-md-inline-code-fg: #1f2328;
    --vac-md-inline-code-bg: rgba(175, 184, 193, 0.2);
    --vac-md-quote-fg: #59636e;
    --vac-md-quote-border: #d1d9e0;
    --vac-md-th-bg: #f6f8fa;
  }
  body.vscode-dark[data-md-style="github"] {
    --vac-md-fg: #e6edf3;
    --vac-md-link: #4493f8;
    --vac-md-border: #3d444d;
    --vac-md-code-bg: #151b23;
    --vac-md-inline-code-fg: #e6edf3;
    --vac-md-inline-code-bg: rgba(101, 108, 118, 0.25);
    --vac-md-quote-fg: #9198a1;
    --vac-md-quote-border: #3d444d;
    --vac-md-th-bg: #151b23;
  }
  body[data-md-style="github"] .md { color: var(--vac-md-fg); line-height: 1.65; }
  body[data-md-style="github"] .md p { margin: 0 0 10px; }
  body[data-md-style="github"] .md p:last-child { margin-bottom: 0; }
  body[data-md-style="github"] .md h1,
  body[data-md-style="github"] .md h2 {
    margin: 18px 0 8px; padding-bottom: 4px;
    border-bottom: 1px solid var(--vac-md-border);
  }
  body[data-md-style="github"] .md h3,
  body[data-md-style="github"] .md h4,
  body[data-md-style="github"] .md h5,
  body[data-md-style="github"] .md h6 { margin: 16px 0 6px; }
  body[data-md-style="github"] .md h1 { font-size: 1.7em; }
  body[data-md-style="github"] .md h2 { font-size: 1.45em; }
  body[data-md-style="github"] .md h3 { font-size: 1.2em; }
  body[data-md-style="github"] .md h4 { font-size: 1.05em; }
  body[data-md-style="github"] .md h5 { font-size: 0.95em; }
  body[data-md-style="github"] .md h6 { font-size: 0.88em; }
  body[data-md-style="github"] .md ul,
  body[data-md-style="github"] .md ol { margin: 0 0 10px; padding-left: 22px; }
  body[data-md-style="github"] .md li + li { margin-top: 3px; }
  body[data-md-style="github"] .md pre {
    margin: 10px 0; padding: 10px; border-radius: 6px;
    background: var(--vac-md-code-bg);
    border: 1px solid var(--vac-md-border);
  }
  body[data-md-style="github"] .md :not(pre) > code {
    padding: 1px 4px; border-radius: 4px;
    background: var(--vac-md-inline-code-bg);
    color: var(--vac-md-inline-code-fg);
  }
  body[data-md-style="github"] .md blockquote {
    margin: 10px 0; padding: 2px 12px;
    border-left: 3px solid var(--vac-md-quote-border);
    color: var(--vac-md-quote-fg);
  }
  body[data-md-style="github"] .md a { color: var(--vac-md-link); }
  body[data-md-style="github"] .md table { margin: 10px 0; }
  body[data-md-style="github"] .md th,
  body[data-md-style="github"] .md td {
    border-color: var(--vac-md-border); padding: 4px 8px;
  }
  body[data-md-style="github"] .md th { background: var(--vac-md-th-bg); font-weight: 600; }
  body[data-md-style="github"] .md hr {
    border: 0; border-top: 1px solid var(--vac-md-border); margin: 14px 0;
  }

  /* Obsidian：紫色强调 —— 链接 / 行内代码 / 引用条都用强调色，
     引用带淡紫底，标题不加下边框（与 GitHub、Typora 一眼分开）。 */
  body[data-md-style="obsidian"] {
    --vac-md-fg: var(--vscode-foreground);
    --vac-md-link: var(--vscode-textLink-foreground);
    --vac-md-border: var(--vscode-panel-border);
    --vac-md-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-inline-code-fg: var(--vscode-textLink-foreground);
    --vac-md-inline-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-quote-fg: var(--vscode-descriptionForeground);
    --vac-md-quote-border: var(--vscode-textLink-foreground);
    --vac-md-quote-bg: transparent;
    --vac-md-th-bg: var(--vscode-textCodeBlock-background);
  }
  body.vscode-light[data-md-style="obsidian"] {
    --vac-md-fg: #222222;
    --vac-md-link: #7852ee;
    --vac-md-border: #dedede;
    --vac-md-code-bg: #f7f5ff;
    --vac-md-inline-code-fg: #6b46d6;
    --vac-md-inline-code-bg: rgba(120, 82, 238, 0.10);
    --vac-md-quote-fg: #5b5b66;
    --vac-md-quote-border: #8a6df0;
    --vac-md-quote-bg: rgba(120, 82, 238, 0.05);
    --vac-md-th-bg: rgba(120, 82, 238, 0.08);
  }
  body.vscode-dark[data-md-style="obsidian"] {
    --vac-md-fg: #dcddde;
    --vac-md-link: #a88bfa;
    --vac-md-border: #3a3a42;
    --vac-md-code-bg: #23222b;
    --vac-md-inline-code-fg: #c4a7ff;
    --vac-md-inline-code-bg: rgba(168, 139, 250, 0.12);
    --vac-md-quote-fg: #b3b3bd;
    --vac-md-quote-border: #a88bfa;
    --vac-md-quote-bg: rgba(168, 139, 250, 0.07);
    --vac-md-th-bg: rgba(168, 139, 250, 0.10);
  }
  body[data-md-style="obsidian"] .md { color: var(--vac-md-fg); line-height: 1.6; }
  body[data-md-style="obsidian"] .md p { margin: 0 0 8px; }
  body[data-md-style="obsidian"] .md p:last-child { margin-bottom: 0; }
  body[data-md-style="obsidian"] .md h1,
  body[data-md-style="obsidian"] .md h2,
  body[data-md-style="obsidian"] .md h3,
  body[data-md-style="obsidian"] .md h4,
  body[data-md-style="obsidian"] .md h5,
  body[data-md-style="obsidian"] .md h6 { margin: 14px 0 6px; font-weight: 600; }
  body[data-md-style="obsidian"] .md h1 { font-size: 1.5em; }
  body[data-md-style="obsidian"] .md h2 { font-size: 1.3em; }
  body[data-md-style="obsidian"] .md h3 { font-size: 1.15em; }
  body[data-md-style="obsidian"] .md h4 { font-size: 1.05em; }
  body[data-md-style="obsidian"] .md h5 { font-size: 1em; }
  body[data-md-style="obsidian"] .md h6 { font-size: 0.92em; }
  body[data-md-style="obsidian"] .md ul,
  body[data-md-style="obsidian"] .md ol { margin: 4px 0; padding-left: 20px; }
  body[data-md-style="obsidian"] .md li + li { margin-top: 2px; }
  body[data-md-style="obsidian"] .md pre {
    margin: 8px 0; padding: 10px; border-radius: 6px;
    background: var(--vac-md-code-bg);
    border: 1px solid var(--vac-md-border);
  }
  body[data-md-style="obsidian"] .md :not(pre) > code {
    padding: 1px 5px; border-radius: 4px;
    background: var(--vac-md-inline-code-bg);
    color: var(--vac-md-inline-code-fg);
  }
  body[data-md-style="obsidian"] .md blockquote {
    margin: 8px 0; padding: 6px 12px;
    border-left: 3px solid var(--vac-md-quote-border);
    border-radius: 0 6px 6px 0;
    color: var(--vac-md-quote-fg);
    background: var(--vac-md-quote-bg);
  }
  body[data-md-style="obsidian"] .md a { color: var(--vac-md-link); }
  body[data-md-style="obsidian"] .md table { margin: 8px 0; }
  body[data-md-style="obsidian"] .md th,
  body[data-md-style="obsidian"] .md td {
    border-color: var(--vac-md-border); padding: 3px 8px;
  }
  body[data-md-style="obsidian"] .md th { background: var(--vac-md-th-bg); font-weight: 600; }
  body[data-md-style="obsidian"] .md hr {
    border: 0; border-top: 1px solid var(--vac-md-border); margin: 12px 0;
  }

  /* Typora：文档观感 —— 大行距、大段落间距，h1/h2 带下边框，
     行内代码用暖橙色（Typora 默认主题的标志色），代码块无描边、只留底色。 */
  body[data-md-style="typora"] {
    --vac-md-fg: var(--vscode-foreground);
    --vac-md-link: var(--vscode-textLink-foreground);
    --vac-md-border: var(--vscode-panel-border);
    --vac-md-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-inline-code-fg: var(--vscode-textLink-foreground);
    --vac-md-inline-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-quote-fg: var(--vscode-descriptionForeground);
    --vac-md-quote-border: var(--vscode-panel-border);
    --vac-md-quote-bg: transparent;
    --vac-md-th-bg: var(--vscode-textCodeBlock-background);
  }
  body.vscode-light[data-md-style="typora"] {
    --vac-md-fg: #333333;
    --vac-md-link: #4183c4;
    --vac-md-border: #dfe2e5;
    --vac-md-code-bg: #f8f8f8;
    --vac-md-inline-code-fg: #e96900;
    --vac-md-inline-code-bg: #f8f8f8;
    --vac-md-quote-fg: #777777;
    --vac-md-quote-border: #dfe2e5;
    --vac-md-th-bg: #f8f8f8;
  }
  body.vscode-dark[data-md-style="typora"] {
    --vac-md-fg: #d6d6d6;
    --vac-md-link: #66b2ff;
    --vac-md-border: #3e3e3e;
    --vac-md-code-bg: #2b2b2b;
    --vac-md-inline-code-fg: #ffb86c;
    --vac-md-inline-code-bg: #2b2b2b;
    --vac-md-quote-fg: #9a9a9a;
    --vac-md-quote-border: #3e3e3e;
    --vac-md-th-bg: #2b2b2b;
  }
  body[data-md-style="typora"] .md { color: var(--vac-md-fg); line-height: 1.7; font-size: 1.02em; }
  body[data-md-style="typora"] .md p { margin: 0 0 12px; }
  body[data-md-style="typora"] .md p:last-child { margin-bottom: 0; }
  body[data-md-style="typora"] .md h1,
  body[data-md-style="typora"] .md h2 {
    margin: 20px 0 10px; padding-bottom: 4px;
    border-bottom: 1px solid var(--vac-md-border);
  }
  body[data-md-style="typora"] .md h3,
  body[data-md-style="typora"] .md h4,
  body[data-md-style="typora"] .md h5,
  body[data-md-style="typora"] .md h6 { margin: 16px 0 8px; }
  body[data-md-style="typora"] .md h1 { font-size: 1.7em; }
  body[data-md-style="typora"] .md h2 { font-size: 1.4em; }
  body[data-md-style="typora"] .md h3 { font-size: 1.2em; }
  body[data-md-style="typora"] .md h4 { font-size: 1.08em; }
  body[data-md-style="typora"] .md h5 { font-size: 1em; }
  body[data-md-style="typora"] .md h6 { font-size: 0.92em; }
  body[data-md-style="typora"] .md ul,
  body[data-md-style="typora"] .md ol { margin: 4px 0 12px; padding-left: 24px; }
  body[data-md-style="typora"] .md li + li { margin-top: 2px; }
  body[data-md-style="typora"] .md pre {
    margin: 10px 0; padding: 12px; border-radius: 3px;
    background: var(--vac-md-code-bg);
  }
  body[data-md-style="typora"] .md :not(pre) > code {
    padding: 1px 4px; border-radius: 3px;
    background: var(--vac-md-inline-code-bg);
    color: var(--vac-md-inline-code-fg);
  }
  body[data-md-style="typora"] .md blockquote {
    margin: 10px 0; padding: 2px 14px;
    border-left: 4px solid var(--vac-md-quote-border);
    color: var(--vac-md-quote-fg);
  }
  body[data-md-style="typora"] .md a { color: var(--vac-md-link); }
  body[data-md-style="typora"] .md table { margin: 10px 0; }
  body[data-md-style="typora"] .md th,
  body[data-md-style="typora"] .md td {
    border-color: var(--vac-md-border); padding: 4px 10px;
  }
  body[data-md-style="typora"] .md th { background: var(--vac-md-th-bg); font-weight: 600; }
  body[data-md-style="typora"] .md hr {
    border: 0; border-top: 1px solid var(--vac-md-border); margin: 16px 0;
  }

  /* Atom：Obsidian「Atom」主题（One Dark 血统）—— 蓝灰底、蓝色强调、
     行内代码与代码块用 1px 内描边代替边框，行距收紧。 */
  body[data-md-style="atom"] {
    --vac-md-fg: var(--vscode-foreground);
    --vac-md-link: var(--vscode-textLink-foreground);
    --vac-md-border: var(--vscode-panel-border);
    --vac-md-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-inline-code-fg: var(--vscode-foreground);
    --vac-md-inline-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-quote-fg: var(--vscode-descriptionForeground);
    --vac-md-quote-border: var(--vscode-textLink-foreground);
    --vac-md-quote-bg: transparent;
    --vac-md-th-bg: var(--vscode-textCodeBlock-background);
  }
  body.vscode-light[data-md-style="atom"] {
    --vac-md-fg: #383a42;
    --vac-md-link: #1592ff;
    --vac-md-border: #dbdbdc;
    --vac-md-code-bg: #f7f7f8;
    --vac-md-inline-code-fg: #383a42;
    --vac-md-inline-code-bg: #f7f7f8;
    --vac-md-quote-fg: #8e8e90;
    --vac-md-quote-border: #1592ff;
    --vac-md-th-bg: #f0f0f1;
  }
  body.vscode-dark[data-md-style="atom"] {
    --vac-md-fg: #dcddde;
    --vac-md-link: #61afef;
    --vac-md-border: #424958;
    --vac-md-code-bg: #20242b;
    --vac-md-inline-code-fg: #dcddde;
    --vac-md-inline-code-bg: #20242b;
    --vac-md-quote-fg: #888888;
    --vac-md-quote-border: #61afef;
    --vac-md-th-bg: #20242b;
  }
  body[data-md-style="atom"] .md { color: var(--vac-md-fg); line-height: 1.5; }
  body[data-md-style="atom"] .md p { margin: 0 0 8px; }
  body[data-md-style="atom"] .md p:last-child { margin-bottom: 0; }
  body[data-md-style="atom"] .md h1,
  body[data-md-style="atom"] .md h2,
  body[data-md-style="atom"] .md h3,
  body[data-md-style="atom"] .md h4,
  body[data-md-style="atom"] .md h5,
  body[data-md-style="atom"] .md h6 { margin: 20px 0 8px; }
  body[data-md-style="atom"] .md h1 { font-size: 1.6em; }
  body[data-md-style="atom"] .md h2 { font-size: 1.4em; }
  body[data-md-style="atom"] .md h3 { font-size: 1.2em; }
  body[data-md-style="atom"] .md h4 { font-size: 1.05em; }
  body[data-md-style="atom"] .md h5 { font-size: 0.95em; }
  body[data-md-style="atom"] .md h6 { font-size: 0.88em; }
  body[data-md-style="atom"] .md ul,
  body[data-md-style="atom"] .md ol { margin: 4px 0; padding-left: 20px; }
  body[data-md-style="atom"] .md li + li { margin-top: 2px; }
  body[data-md-style="atom"] .md pre {
    margin: 8px 0; padding: 10px; border-radius: 4px;
    background: var(--vac-md-code-bg);
    box-shadow: inset 0 0 0 1px var(--vac-md-border);
  }
  body[data-md-style="atom"] .md :not(pre) > code {
    padding: 1px 5px; border-radius: 4px;
    background: var(--vac-md-inline-code-bg);
    color: var(--vac-md-inline-code-fg);
    box-shadow: inset 0 0 0 1px var(--vac-md-border);
  }
  body[data-md-style="atom"] .md blockquote {
    margin: 8px 0; padding: 2px 12px;
    border-left: 2px solid var(--vac-md-quote-border);
    color: var(--vac-md-quote-fg);
  }
  body[data-md-style="atom"] .md a { color: var(--vac-md-link); }
  body[data-md-style="atom"] .md table { margin: 8px 0; }
  body[data-md-style="atom"] .md th,
  body[data-md-style="atom"] .md td {
    border-color: var(--vac-md-border); padding: 3px 8px;
  }
  body[data-md-style="atom"] .md th { background: var(--vac-md-th-bg); font-weight: 600; }
  body[data-md-style="atom"] .md hr {
    border: 0; border-top: 1px solid var(--vac-md-border); margin: 14px 0;
  }

  /* Minimal：Obsidian「Minimal」主题 —— 标题刻意做小（h1 仅 1.125em）、
     层级靠字重区分，h5/h6 小型大写；配色克制，引用只有 1px 细线。 */
  body[data-md-style="minimal"] {
    --vac-md-fg: var(--vscode-foreground);
    --vac-md-link: var(--vscode-textLink-foreground);
    --vac-md-border: var(--vscode-panel-border);
    --vac-md-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-inline-code-fg: var(--vscode-foreground);
    --vac-md-inline-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-quote-fg: var(--vscode-descriptionForeground);
    --vac-md-quote-border: var(--vscode-panel-border);
    --vac-md-quote-bg: transparent;
    --vac-md-th-bg: transparent;
  }
  body.vscode-light[data-md-style="minimal"] {
    --vac-md-fg: #2b2b2b;
    --vac-md-link: #8a5cf5;
    --vac-md-border: #e3e3e3;
    --vac-md-code-bg: #f5f5f5;
    --vac-md-inline-code-fg: #2b2b2b;
    --vac-md-inline-code-bg: #ededed;
    --vac-md-quote-fg: #6b6b6b;
    --vac-md-quote-border: #d5d5d5;
  }
  body.vscode-dark[data-md-style="minimal"] {
    --vac-md-fg: #dcddde;
    --vac-md-link: #a68bfa;
    --vac-md-border: #3a3a3a;
    --vac-md-code-bg: #262626;
    --vac-md-inline-code-fg: #dcddde;
    --vac-md-inline-code-bg: #2d2d2d;
    --vac-md-quote-fg: #9a9a9a;
    --vac-md-quote-border: #4a4a4a;
  }
  body[data-md-style="minimal"] .md { color: var(--vac-md-fg); line-height: 1.5; }
  body[data-md-style="minimal"] .md p { margin: 0 0 10px; }
  body[data-md-style="minimal"] .md p:last-child { margin-bottom: 0; }
  body[data-md-style="minimal"] .md h1,
  body[data-md-style="minimal"] .md h2,
  body[data-md-style="minimal"] .md h3,
  body[data-md-style="minimal"] .md h4,
  body[data-md-style="minimal"] .md h5,
  body[data-md-style="minimal"] .md h6 { margin: 20px 0 6px; }
  body[data-md-style="minimal"] .md h1 { font-size: 1.125em; font-weight: 600; }
  body[data-md-style="minimal"] .md h2 { font-size: 1.05em; font-weight: 600; }
  body[data-md-style="minimal"] .md h3 { font-size: 1em; font-weight: 500; }
  body[data-md-style="minimal"] .md h4 { font-size: 0.9em; font-weight: 500; }
  body[data-md-style="minimal"] .md h5 {
    font-size: 0.85em; font-weight: 500; font-variant: small-caps; letter-spacing: 0.02em;
  }
  body[data-md-style="minimal"] .md h6 {
    font-size: 0.85em; font-weight: 400; font-variant: small-caps; letter-spacing: 0.02em;
    color: var(--vac-md-quote-fg);
  }
  body[data-md-style="minimal"] .md ul,
  body[data-md-style="minimal"] .md ol { margin: 4px 0; padding-left: 2em; }
  body[data-md-style="minimal"] .md li + li { margin-top: 2px; }
  body[data-md-style="minimal"] .md pre {
    margin: 8px 0; padding: 10px; border-radius: 4px;
    background: var(--vac-md-code-bg);
  }
  body[data-md-style="minimal"] .md :not(pre) > code {
    padding: 1px 4px; border-radius: 3px;
    background: var(--vac-md-inline-code-bg);
    color: var(--vac-md-inline-code-fg);
  }
  body[data-md-style="minimal"] .md blockquote {
    margin: 10px 0; padding: 2px 12px;
    border-left: 1px solid var(--vac-md-quote-border);
    color: var(--vac-md-quote-fg);
  }
  body[data-md-style="minimal"] .md a { color: var(--vac-md-link); }
  body[data-md-style="minimal"] .md table { margin: 10px 0; }
  body[data-md-style="minimal"] .md th,
  body[data-md-style="minimal"] .md td {
    border-color: var(--vac-md-border); padding: 3px 8px;
  }
  body[data-md-style="minimal"] .md th { font-weight: 600; }
  body[data-md-style="minimal"] .md hr {
    border: 0; border-top: 1px solid var(--vac-md-border); margin: 16px 0;
  }

  /* Things：Obsidian「Things」主题 —— 蓝色强调、下划线链接，
     h3/h4/h5 分别上蓝/黄/红，粗体与斜体用粉色，引用是绿松石色。 */
  body[data-md-style="things"] {
    --vac-md-fg: var(--vscode-foreground);
    --vac-md-link: var(--vscode-textLink-foreground);
    --vac-md-border: var(--vscode-panel-border);
    --vac-md-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-inline-code-fg: var(--vscode-foreground);
    --vac-md-inline-code-bg: var(--vscode-textCodeBlock-background);
    --vac-md-quote-fg: var(--vscode-charts-green, var(--vscode-descriptionForeground));
    --vac-md-quote-border: var(--vscode-charts-green, var(--vscode-descriptionForeground));
    --vac-md-quote-bg: transparent;
    --vac-md-th-bg: var(--vscode-textCodeBlock-background);
    --vac-md-h3: var(--vscode-textLink-foreground);
    --vac-md-h4: var(--vscode-charts-yellow, var(--vscode-foreground));
    --vac-md-h5: var(--vscode-charts-red, var(--vscode-foreground));
    --vac-md-h6: var(--vscode-descriptionForeground);
    --vac-md-strong: var(--vscode-charts-purple, var(--vscode-foreground));
  }
  body.vscode-light[data-md-style="things"] {
    --vac-md-fg: #222222;
    --vac-md-link: #4d8ce6;
    --vac-md-border: #ebedf0;
    --vac-md-code-bg: #f6f7f8;
    --vac-md-inline-code-fg: #222222;
    --vac-md-inline-code-bg: #f6f7f8;
    --vac-md-quote-fg: #2f8f98;
    --vac-md-quote-border: #3eb4bf;
    --vac-md-th-bg: #f6f7f8;
    --vac-md-h3: #2e80f2;
    --vac-md-h4: #b07d28;
    --vac-md-h5: #d43c3c;
    --vac-md-h6: #6b7078;
    --vac-md-strong: #d94f8a;
  }
  body.vscode-dark[data-md-style="things"] {
    --vac-md-fg: #dcddde;
    --vac-md-link: #79a9ec;
    --vac-md-border: #35393e;
    --vac-md-code-bg: #282c34;
    --vac-md-inline-code-fg: #dcddde;
    --vac-md-inline-code-bg: #282c34;
    --vac-md-quote-fg: #3eb4bf;
    --vac-md-quote-border: #3eb4bf;
    --vac-md-th-bg: #282c34;
    --vac-md-h3: #5b9bff;
    --vac-md-h4: #e5b567;
    --vac-md-h5: #ff6b6b;
    --vac-md-h6: #9aa0a8;
    --vac-md-strong: #ff82b2;
  }
  body[data-md-style="things"] .md { color: var(--vac-md-fg); line-height: 1.5; }
  body[data-md-style="things"] .md p { margin: 0 0 10px; }
  body[data-md-style="things"] .md p:last-child { margin-bottom: 0; }
  body[data-md-style="things"] .md h1,
  body[data-md-style="things"] .md h2,
  body[data-md-style="things"] .md h3,
  body[data-md-style="things"] .md h4,
  body[data-md-style="things"] .md h5,
  body[data-md-style="things"] .md h6 { margin: 18px 0 8px; }
  body[data-md-style="things"] .md h1 { font-size: 1.7em; }
  body[data-md-style="things"] .md h2 { font-size: 1.5em; }
  body[data-md-style="things"] .md h3 { font-size: 1.2em; color: var(--vac-md-h3); }
  body[data-md-style="things"] .md h4 { font-size: 1.1em; color: var(--vac-md-h4); }
  body[data-md-style="things"] .md h5 { font-size: 1em; color: var(--vac-md-h5); }
  body[data-md-style="things"] .md h6 { font-size: 0.9em; color: var(--vac-md-h6); }
  body[data-md-style="things"] .md strong { color: var(--vac-md-strong); }
  body[data-md-style="things"] .md em { color: var(--vac-md-strong); }
  body[data-md-style="things"] .md ul,
  body[data-md-style="things"] .md ol { margin: 4px 0; padding-left: 22px; }
  body[data-md-style="things"] .md li + li { margin-top: 2px; }
  body[data-md-style="things"] .md pre {
    margin: 8px 0; padding: 8px; border-radius: 4px;
    background: var(--vac-md-code-bg);
  }
  body[data-md-style="things"] .md :not(pre) > code {
    padding: 1px 4px; border-radius: 4px;
    background: var(--vac-md-inline-code-bg);
    color: var(--vac-md-inline-code-fg);
  }
  body[data-md-style="things"] .md blockquote {
    margin: 10px 0; padding: 2px 12px;
    border-left: 3px solid var(--vac-md-quote-border);
    color: var(--vac-md-quote-fg);
  }
  body[data-md-style="things"] .md a {
    color: var(--vac-md-link);
    text-decoration: underline; text-underline-offset: 2px;
  }
  body[data-md-style="things"] .md table { margin: 10px 0; }
  body[data-md-style="things"] .md th,
  body[data-md-style="things"] .md td {
    border-color: var(--vac-md-border); padding: 3px 8px;
  }
  body[data-md-style="things"] .md th { background: var(--vac-md-th-bg); font-weight: 600; }
  body[data-md-style="things"] .md hr {
    border: 0; border-top: 1px solid var(--vac-md-border); margin: 16px 0;
  }
  /* GFM 任务列表的勾选态（）：由宿主侧 markdown.ts 的 checkbox
     钩子渲染，白名单里因此不需要 INPUT。 */
  .task-box { font-family: var(--vscode-editor-font-family); opacity: .85; }
  .link-blocked {
    color: var(--vscode-descriptionForeground);
    text-decoration: line-through;
    cursor: help;
  }
  .img-chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 0 5px; font-size: 0.9em;
  }
  .content-image { max-width: 100%; border-radius: 4px; margin: 4px 0; cursor: zoom-in; }
  /* [CUSTOM- 图片以「缩略图 + 文件名」的紧凑 chip 呈现（此前按原始尺寸平铺，
     一张 1344x695 的截图就把整个面板撑满）。点击整块打开放大层（097）。 */
  .content-image-chip {
    display: inline-flex; align-items: center; gap: 6px;
    max-width: 100%; padding: 2px 8px 2px 2px;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    cursor: zoom-in; font-family: inherit; font-size: 0.88em; color: inherit;
  }
  .content-image-chip:hover { background: var(--vscode-list-hoverBackground); }
  .content-thumb {
    display: block; flex: 0 0 auto;
    width: 24px; height: 24px; object-fit: cover; border-radius: 2px;
  }
  .content-image-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* [CUSTOM- 编辑区面与编辑器标签同处一列：用侧边栏底色会像"外部面板
     贴在了编辑区里"。类名由 body(surface) 打在 <body> 上（见 html/body.ts）。
     侧边栏面不加任何规则——它必须保持侧边栏底色。 */
  .surface-editor {
    background: var(--vscode-editor-background);
  }
  /* [CUSTOM- tab 的"选中态底色"必须跟着**这个面**的底走：侧边栏面用 sideBar、
     编辑区面用 editor。dot 的字母色从 2026-10-29 起是固定深色，不再按面取。 */
  .surface-editor .tab.active { background: var(--vscode-editor-background); }
  /* [CUSTOM- 这里原来还有 .composer。底栏从 140 起是**浮在消息之上的透明层**
     （见 .composer 那段），给它刷 editor-background 就等于把整条底栏变成一块不透明带：输入卡
     两侧的消息、右侧大纲栏的底部全被盖住 —— 用户报的"还是遮挡"就是这个，而且它**只在编辑区
     面出现**（本脚本的预览默认渲染侧边栏面，所以一直没照出来）。
     编辑区面的底色差异现在只由 .load-overlay 承担（它本来就是不透明遮罩）。 */
  .surface-editor .load-overlay {
    background: var(--vscode-editor-background);
  }

  /* [CUSTOM- 尊重系统的"减少动效"偏好。面板的 pulse / spin 是纯装饰
     （进度点、加载圈），关掉不影响任何状态表达。 */
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }

  /* [CUSTOM- 代码块的语言标签。放**左上角**——右上角归 Copy 按钮。
     pointer-events: none 让它不挡住代码的选区。 */
  .code-lang {
    position: absolute; top: 4px; left: 6px;
    font-family: var(--vscode-editor-font-family); font-size: 0.78em;
    color: var(--vscode-descriptionForeground);
    pointer-events: none;
  }
  /* 只有带语言标签的代码块才需要让出顶部空间，否则普通代码块会凭空多出一条空白。 */
  .code-wrap.has-lang pre { padding-top: 20px; }

  /* Copy button injected into rendered code blocks */
  .code-wrap { position: relative; }
  .code-copy {
    position: absolute; top: 4px; right: 4px;
    padding: 1px 6px; border-radius: 3px; cursor: pointer;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: none; font-family: inherit; font-size: 0.85em; opacity: 0;
    transition: opacity .12s ease-in-out;
  }
  .code-wrap:hover .code-copy { opacity: 1; }

  /* --- Thoughts --------------------------------------------------------
     三级视觉层次里最轻的一档（L1 气泡 / L2 卡片 / L3 轻卡）。
     折叠态刻意做得很安静：无背景、无边框、次要色、略小字号——推理是辅助信息。
     展开态给出淡背景 + 边框 + 圆角，与折叠态形成**强对比**。
     缺了这个对比时，展开与折叠只差高度，读者分辨不出"这是一段独立内容"。 */
  .thought {
    border-radius: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .thought > summary {
    cursor: pointer;
    user-select: none;
    list-style: none;
    padding: 1px 2px;
    border-radius: 3px;
  }
  .thought > summary::-webkit-details-marker { display: none; }
  /* --- 折叠三角（）----------------------------------
     它是**真元素**（.fold-caret），不是 summary::before —— 伪元素永远画在内容之前，
     而类型图标（icons.attach 会 prepend 到 summary）必须排在三角**前面**，
     否则顺序会变成「▸ 图标 标签」而不是「图标 ▸ 标签」。
     三角本身是空元素：字形与方向由 CSS 依 details[open] 驱动，所以切换不需要 JS。 */
  .fold-caret { display: inline-block; flex: none; width: 12px; opacity: .7; }
  .fold-caret::before { content: '▸'; }
  details[open] > summary .fold-caret::before { content: '▾'; }
  .thought[open] {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    padding: 2px 6px 4px;
  }
  .thought[open] > summary { color: var(--vscode-foreground); }
  .thought-body {
    /* [CUSTOM- 300px → 600px：用户 2026-10-09 报"Thought 展开后内容高度有点低，
       加大一倍"。它是**滚动视口**的高度（超出才滚动），一倍之后长推理一次能看到更多。 */
    max-height: 600px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
    margin-top: 3px; padding-left: 14px;
    font-style: italic; opacity: 0.85;
  }
  /* [CUSTOM- 渲染成 markdown 的推理正文（宿主侧 SafeMarkdown → .md）。
     两处必须覆盖：
       · white-space —— pre-wrap 会把 marked 输出里的换行**再加一倍**（每个 <p> 之间
         多出一整行空行），所以 md 态回到 normal，与 .entry-assistant .bubble-body.md 同理；
       · font-style —— 正文保持斜体（那是「这是推理」的视觉身份），但代码块与表格里
         的斜体很难读，就地重置为非斜体。 */
  .thought-body.md { white-space: normal; }
  .thought-body.md pre, .thought-body.md code, .thought-body.md table { font-style: normal; }
  .thought-spin {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--vscode-progressBar-background); margin-right: 5px;
    animation: pulse 1.1s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }

  /* --- Tool calls ------------------------------------------------------ */
  .tool {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; margin: 3px 0;
    background: var(--vscode-editorWidget-background);
    overflow: hidden;
  }
  .tool-head {
    display: flex; align-items: center; gap: 6px;
    padding: 3px 7px; cursor: pointer; user-select: none;
  }
  .tool-head:hover { background: var(--vscode-list-hoverBackground); }
  .tool-caret { flex: 0 0 auto; width: 10px; opacity: .7; }
  .tool-status { flex: 0 0 auto; width: 12px; text-align: center; font-weight: 700; }
  .tool-status.tc-pending { color: var(--vscode-descriptionForeground); }
  .tool-status.tc-in_progress { color: var(--vscode-progressBar-background); animation: pulse 1.1s ease-in-out infinite; }
  .tool-status.tc-completed { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .tool-status.tc-failed { color: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
  .tool-kind {
    flex: 0 0 auto; font-size: 0.82em; text-transform: uppercase; letter-spacing: .04em;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 3px;
  }
  .tool-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* [CUSTOM- 工具自己的名字（Bash / Read / Edit …），来自 agent 的 _meta。
     与左侧的 kind 标签（Run / Read）并列：kind 是 ACP 的粗粒度词表，名字是具体工具，
     两张 "Run" 卡靠它才分得开。 */
  .tool-name {
    flex: 0 0 auto; font-size: 0.82em; padding: 0 4px; border-radius: 3px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-textCodeBlock-background);
  }
  /* [CUSTOM- 委派给**子 agent** 的卡。与 .tool-name 同样是一个 chip，但配色不同：
     它表达的不是"哪个工具"，而是"这段产出不是你正在对话的那个 agent 写的" —— 折叠态也看得见，
     而"这话是谁说的"正是在折叠态被问出来的。其余细节（id / 模型 / token / 耗时）在 tooltip 里。 */
  .tool-subagent {
    flex: 0 0 auto; font-size: 0.82em; padding: 0 4px; border-radius: 3px;
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    background: var(--vscode-badge-background, var(--vscode-textCodeBlock-background));
    cursor: help;
  }
  .tool-inferred {
    flex: 0 0 auto; font-size: 0.8em; color: var(--vscode-descriptionForeground);
    cursor: help;
  }
  /* Step count on a parent card ("N steps") */
  .tool-steps {
    flex: 0 0 auto; font-size: 0.78em; padding: 0 5px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  /* Sub-agent grouping: children indent under their parent with a connector.
     Links are INFERRED (ACP has no nesting concept), so the grouping is purely
     visual and can be switched off with the "Sub-agents" toggle. */
  .messages:not(.flat-tools) .tool[data-parent-id] {
    margin-left: 18px;
    border-left: 2px solid var(--vscode-focusBorder, var(--vscode-panel-border));
  }
  .messages.flat-tools .tool[data-parent-id] { margin-left: 0; }

  .nest-toggle {
    flex: 0 0 auto; padding: 2px 7px; border-radius: 3px; cursor: pointer;
    background: transparent; color: var(--vscode-descriptionForeground);
    border: 1px solid transparent; font-family: inherit; font-size: 1em; line-height: 1;
  }
  /* [CUSTOM- 地址栏功能按钮统一观感（2026-10-27）：未开启 = 灰色 + 无底框；
     开启 = 强调色 + 可见底框。Times / 自动展开 / Sub-agents 走同一套 .on/.off，
     历史 ↺ 是动作（没有开关态），按未开启的样式呈现即可。颜色只用主题 token，
     侧边栏与编辑区两个面、所有配色主题自动一致。 */
  .session-header .outline-btn {
    color: var(--vscode-descriptionForeground);
    background: transparent; border-color: transparent;
  }
  .session-header .outline-btn:hover,
  .session-header .nest-toggle:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-foreground);
  }
  .session-header .outline-btn.on,
  .session-header .nest-toggle.on {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
  }
  .session-header .nest-toggle.off {
    background: transparent; border-color: transparent;
  }
  .nest-toggle.off { opacity: 1; }
  /* [CUSTOM- Times 改成纯图标后是**方块**按钮（文字容量不再存在）：
     只给 #timeToggle 收窄内边距，旁边的 'Sub-agents' 仍是有文字的胶囊。 */
  #timeToggle {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 3px 5px; line-height: 0;
  }
  #timeToggle .time-icon, #timeToggle .time-icon svg { display: block; }
  /* [CUSTOM- Tail（自动追尾，2026-10-28）：与 Times 同样是**方块**图标按钮（没有文字），
     所以内边距收窄、图标自己撑尺寸；.on/.off 沿用上面那套强调色 / 无底框的约定。 */
  #tailBtn {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 3px 5px; line-height: 0;
  }
  #tailBtn .tail-icon, #tailBtn .tail-icon svg { display: block; }
  /* [CUSTOM- 纵向收紧：工具卡一轮十几张，body 的上下留白各收 2px 就有几十像素。 */
  .tool-body { padding: 3px 7px 5px; border-top: 1px solid var(--vscode-panel-border); }
  /* [CUSTOM- IN / OUT 段：**左右两栏**（对齐官方插件）——段标在左列、
     内容在右列。写成两行（标签一行、内容一行）时每张卡要多占两行，而工具卡在一轮里动辄十几张。
     等宽只给命令本身（IN），不套整段——OUT 里是 markdown 渲染结果，等宽会毁掉它的排版。 */
  .tool-seg {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    column-gap: 8px; align-items: start;
    margin: 0 0 4px;
  }
  .tool-seg:last-child { margin-bottom: 0; }
  .tool-seg-label {
    grid-column: 1;
    font-size: 0.72em; letter-spacing: .06em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    /* 与右侧首行的文字基线大致对齐（等宽 0.92em 的行盒比标签高一档）。 */
    padding-top: 3px;
  }
  /* 段里除标签外的每个子节点都落在右列（否则 auto-placement 会把第二个子节点甩回第一列）。 */
  .tool-seg > :not(.tool-seg-label) { grid-column: 2; min-width: 0; }
  /* [CUSTOM- OUT 是一块内容区：淡背景 + 圆角，并且**限高滚动**——长输出不该把
     面板顶走（340px 与 .diff-body 同一档，不新增第二个魔数）。
     **底色与内边距挂在"内容格"上，不挂在网格容器上**：容器带左右内边距会把整个网格（含标签列）
     往右推 6px，于是 OUT 的内容比 IN 偏右——实测 IN 内容列 x=65、OUT x=71，肉眼就是"没对齐"。
     这也是为什么这里不用 padding 而用子选择器给每个内容格各自加框。 */
  .tool-seg-out { background: transparent; padding: 0; border-radius: 0; }
  .tool-seg-out > :not(.tool-seg-label) {
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 2px 6px;
  }
  /* [CUSTOM- 工具输出里的代码块不要那两个装饰：围栏语言标签（"console"）对
     命令输出没有信息量，而 has-lang 会给 pre 预留 20px 顶部内边距——那正是 OUT 框里
     上方那片空白。assistant 气泡里的代码块照旧保留。 */
  .tool-seg-out .code-lang { display: none; }
  .tool-seg-out .code-wrap.has-lang pre { padding-top: 0; }
  /* [CUSTOM- **字体与字号必须和 IN 的命令行一致**：工具输出里的 pre 落在
     .tool-text 里（不在 .bubble/.md 作用域内），拿不到那套等宽规则，于是回落到浏览器默认
     monospace（Windows 上是 Courier）——与 IN 的编辑器字体**字面宽度与左边界都不同**，
     视觉上就是"IN/OUT 没对齐"，两种等宽并排也显得脏。顺带清掉 UA 给 pre 的 1em 上下边距
     （盒子的底色与内边距已经由 .tool-seg-out 提供）。 */
  .tool-seg pre, .tool-seg code {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.92em;
  }
  .tool-seg-out pre { margin: 0; background: transparent; }
  .tool-seg-out > .tool-text:first-of-type { margin-top: 0; }
  .tool-seg-out .chip-row { margin-top: 0; }
  /* [CUSTOM- 兜底的原始输出（agent 报了 rawOutput、但 content 里没有可渲染的项）：
     终端文本按等宽渲染，限高与 .tool-seg-out 一致。 */
  .tool-raw {
    font-family: var(--vscode-editor-font-family); font-size: 0.9em;
    white-space: pre-wrap; word-break: break-all; margin: 0;
  }
  /* [CUSTOM- 340px → 510px：用户 2026-10-09 报"子 agent 卡展开后高度再放大 1/2"。
     报告是长文（story_editor 那份就有近千 token），340px 时一次只能看到开头，
     而要"读子 agent 的话"必须先把 OUT 展开 —— 高度翻倍能让一次可见内容多一半。 */
  .tool-body .tool-seg-out { max-height: 510px; overflow: auto; }
  .tool-command {
    font-family: var(--vscode-editor-font-family); font-size: 0.92em;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 3px; padding: 2px 6px; margin: 0;
    white-space: pre-wrap; word-break: break-all;
  }
  .chip-row { display: flex; flex-wrap: wrap; gap: 4px; margin: 3px 0; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px; padding: 0 5px; cursor: pointer;
    font-family: var(--vscode-editor-font-family); font-size: 0.88em;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  .chip-static { cursor: default; }
  .chip-static:hover { background: var(--vscode-textCodeBlock-background); }
  .tool-text { white-space: pre-wrap; word-break: break-word; margin: 3px 0; }

  /* Diff */
  .diff {
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    margin: 4px 0; overflow: hidden;
    font-family: var(--vscode-editor-font-family); font-size: 0.9em;
  }
  .diff-head {
    display: flex; align-items: center; gap: 6px;
    padding: 2px 6px; cursor: pointer;
    background: var(--vscode-textCodeBlock-background);
  }
  .diff-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .diff-stat { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .diff-add { color: var(--vscode-charts-green); }
  .diff-del { color: var(--vscode-charts-red); }
  .diff-body { max-height: 340px; overflow: auto; }
  .diff-line { display: flex; white-space: pre; }
  .diff-no {
    flex: 0 0 auto; width: 4ch; text-align: right; padding-right: 8px;
    color: var(--vscode-editorLineNumber-foreground); user-select: none;
  }
  .diff-code { flex: 1; padding-right: 6px; }
  .diff-line.add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(155,185,85,0.16)); }
  .diff-line.del { background: var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,0.14)); }
  .diff-line.ctx { color: var(--vscode-descriptionForeground); }
  .diff-note { padding: 3px 6px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }

  /* Plan */
  .plan {
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    background: var(--vscode-editorWidget-background); padding: 5px 8px; margin: 3px 0;
  }
  .plan-title { font-weight: 600; font-size: 0.92em; margin-bottom: 3px; }
  .plan-row { display: flex; gap: 6px; padding: 1px 0; }
  .plan-row.completed .plan-text { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
  .plan-mark { flex: 0 0 auto; width: 14px; }

  /* --- Composer -------------------------------------------------------- */
  /* [CUSTOM- 底部栏 = **两列**：主列（输入卡）+ 预留功能区。用 flex 两列而不是
     135 那种"给左边补一段 padding"的算法，是因为主列的宽度天然等于"面板宽 − 预留区宽"，
     于是输入卡的中线与消息列的中线**自动**重合 —— 少维护一个等式（pitfall #24 的正解）。 */
  .composer {
    display: flex; align-items: stretch;
    /* [CUSTOM- **真悬浮**：脱离文档流、盖在消息区之上。139 时它还在文档流里，
       于是底部这一整条（含卡片两侧那两块空白）都不显示消息 —— 用户报"输入框两侧还是会盖住
       消息内容"。现在消息区占满整个高度、卡片浮在上面，内容也不会被压住：#messages 的
       padding-bottom 留出了 --vac-composer-h（composer.ts 的观察器写），滚到底时最后一条
       正好停在卡片上方。
       **背景必须透明** —— 有底色就等于把那两侧的消息蒙上一块。
       z-index 8：高于置顶卡片（6）与引导条（3）；消息内容本身不带 z-index。 */
    position: absolute; left: 0; right: 0; bottom: 0; z-index: 8;
    /* [CUSTOM- 空区不吞鼠标：底栏通栏，但**只有卡片那一块**该接事件 ——
       否则输入卡两侧、以及右侧大纲栏底部那块透明区域会把点击拦下来（实测大纲最后一条的
       elementFromPoint 命中的是 composer，而不是那条记录）。可见的部件各自把 events 打开。 */
    pointer-events: none;
    /* [CUSTOM- 悬浮观感：卡片自己的描边 + 阴影 + 四周留白（底部这 10px 就是它
       不贴着面板下缘的那点距离）。
       [CUSTOM- **左右 padding 必须是 0**：右侧任何 padding 都会让预留区的
       border-left（那根竖线）比钉住的大纲栏左边界靠左同样的像素数（实测 8px 就是这么来的）。
       输入卡自己的边距交给 .composer-main 的**对称** padding —— 对称的 padding 不改变主列的
       中心，所以卡片与消息列的中线仍然重合（实测 dxCardVsCol = 0）。 */
    padding: 6px 0 10px;
  }
  /* [CUSTOM- 没连上 agent 之前不显示底栏：那时输入框本来就是禁用的，露一个
     "看得见却打不了字"的框只会让人以为它坏了（用户反馈）。相位由 stateCard 写在
     body[data-phase] 上，与上面 Times 那条用的是同一个机制（disconnected / connecting）。
     顺带的好处：display: none 会让 ResizeObserver 把 --vac-composer-h 归零，消息区于是不再
     为一条并不存在的底栏留出底部空白。 */
  body[data-phase="disconnected"] .composer,
  body[data-phase="connecting"] .composer,
  /* [CUSTOM- 连上了但没有会话/草稿（真正的空态）也藏底栏：露一个灰置的框只会让人
     以为它坏了。data-composer 由 composer.refreshControls 按「有没有会话或草稿」写。 */
  body[data-composer="off"] .composer { display: none; }
  .composer-main { flex: 1; min-width: 0; display: flex; justify-content: center; padding-inline: 8px; }
  /* [CUSTOM- 限宽只加在这里（外墙照旧通栏），窄面板自动退化成满宽。
     它同时是 .slash-popup 的定位上下文 —— 弹层按输入卡对齐而不是按面板算
     （后者会在宽屏下横跨整屏）。 */
  /* [CUSTOM- 卡片与它的弹层要收事件（父级 .composer 关掉了 pointer-events）。 */
  .composer-inner {
    position: relative; width: 100%; max-width: var(--vac-composer-max); pointer-events: auto;
  }
  /* [CUSTOM- 右下角的预留功能区。宽度与大纲栏**同源**（JS 写的 --vac-aside-w，
     见 outline.ts 的 applyReserve）⇒ 可见时它的左边界与钉住的大纲栏左边界落在同一条竖线上，
     而那根竖线就是这里的 border-left。
     [143] **默认 0**：没有钉住的大纲栏就没有那根竖线，输入卡随之在面板里居中（用户要求）。
     下面几个 min() 是让"宽度为 0"这件事**彻底**：不然 border-left 会留一条 1px 的孤线、
     padding 也会撑出 8px —— 那时元素虽然宽 0，却仍然占着位置。
     max-width 是安全阀：面板窄到放不下时不让它把输入区挤没（那种宽度下竖线不再严格对齐，
     但那时也没有谁拿它当参照——大纲栏自己同样受 50% 上限约束）。 */
  .composer-aside {
    flex: 0 0 auto;
    width: var(--vac-aside-w, 0px); max-width: 40%;
    border-left: min(1px, var(--vac-aside-w, 0px)) solid var(--vscode-panel-border);
    display: flex; align-items: center; justify-content: center;
    padding-left: min(8px, var(--vac-aside-w, 0px));
  }
  /* [CUSTOM- 一体式输入卡：textarea 与按钮栏共用一层描边（原来是"带边框的
     textarea + 卡外一行按钮"，中间隔一条缝，看着像两个孤立控件）。
     这一层**绝不能写 overflow**：.picker-menu 与 .slash-popup 都向上弹出、会被裁掉；而且
     column flex 容器上的 overflow 会压缩子项而不是让容器滚动（pitfalls #17）。 */
  /* [CUSTOM- 引用栏里的「编辑器当前文件」那一格：'+'/'x' 开关 + 文件 tag。
     与普通附件 chip 的区别是"**它还没被加进来**"这个状态：未引用时描边虚一点、标签暗一点，
     一眼能看出"点 + 就能加"。两个面（侧边栏/编辑区）都有输入框，所以样式挂在 .ref-chip 上。 */
  /* [ / 208] 一整格**一个 chip**：外壳描边 + 底色，里面 tag 与开关平级。
     [CUSTOM- 只剩**预选**一态（还没引用）：强调色底 + 虚线描边 —— "点 + 就加进来"；
     已引用时这一格**根本不渲染**（附件行里有它自己的 chip，两处都显示就是重复 tag），
     所以 208 那条 .ref-on（实线 + 代码块底色）随之删除 —— 别留没有写者的死 CSS（pitfall #20）。
     颜色一律走主题 token（不写死色值）。 */
  .ref-chip {
    display: inline-flex; align-items: center; gap: 2px;
    padding: 1px 4px 1px 2px; border-radius: 3px; max-width: 100%;
    border: 1px dashed var(--vscode-focusBorder, var(--vscode-panel-border));
    /* 预选态的底色 = 中性的 chip 底色**混入**主题强调色：两态必然看得出不同，又不写死任何色值
       （直接拿 badge 底色会在有些主题里与代码块底色撞成同一个灰 —— 预览里就撞过一次）。 */
    background: color-mix(in srgb, var(--vscode-focusBorder, var(--vscode-panel-border)) 30%,
      var(--vscode-textCodeBlock-background));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    font-family: var(--vscode-editor-font-family); font-size: 0.88em;
  }
  /* 里层的两个都是真按钮，但外观交给外壳：自己不要描边/底色。 */
  .ref-tag, .ref-toggle {
    display: inline-flex; align-items: center; gap: 4px;
    border: none; background: transparent; color: inherit;
    font-family: inherit; font-size: inherit; cursor: pointer; padding: 1px 2px;
  }
  .ref-tag:hover, .ref-toggle:hover { background: var(--vscode-list-hoverBackground); border-radius: 2px; }
  .ref-toggle { justify-content: center; min-width: 12px; opacity: 0.85; }
  .ref-toggle:hover { opacity: 1; }
  .ref-label { max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .composer-card {
    display: flex; flex-direction: column;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 8px;
    padding: 4px 8px 6px;
    /* [CUSTOM- 悬浮感来自这层阴影（与 .state-card / .picker-menu 同一档），
       配合上面去掉的通栏分隔线与四周留白。 */
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
  }
  .composer-bar { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  /* [CUSTOM- 2026-10-29：容器吃掉剩余宽度（原来用 margin-right:auto 吃在容器外），
     这样容器内部的 mode picker 才能用 margin-left:auto 落到最右缘 = 上下文进度左侧。 */
  .config-pickers { display: flex; flex-wrap: wrap; gap: 4px; flex: 1 1 auto; min-width: 0; }
  .picker { position: relative; }
  /* [CUSTOM- mode 独占容器内剩余空间，靠右；模型/Effort 仍在左侧。 */
  .picker[data-category="mode"] { margin-left: auto; }
  .picker-btn {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 3px; padding: 1px 6px; cursor: pointer;
    font-family: inherit; font-size: 0.88em; max-width: 220px;
  }
  .picker-btn:hover { background: var(--vscode-list-hoverBackground); }
  .picker-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 14px; height: 14px; opacity: .8; }
  .picker-icon svg { display: block; width: 14px; height: 14px; }
  .picker-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker-menu {
    position: absolute; bottom: 100%; left: 0; z-index: 20;
    min-width: 240px; max-width: 380px; max-height: 320px; overflow-y: auto;
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border); border-radius: 3px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
    padding: 2px 0; display: none;
  }
  .picker-menu.open { display: block; }
  /* [CUSTOM- 右缘的 mode picker：菜单向左展开，否则 240–380px 的菜单会冲出面板右边。 */
  .picker[data-category="mode"] .picker-menu { left: auto; right: 0; }
  .picker-title { padding: 5px 8px 3px; font-size: 0.82em; color: var(--vscode-descriptionForeground); }
  .picker-group { padding: 3px 8px 1px; font-size: 0.82em; color: var(--vscode-descriptionForeground); }
  /* [CUSTOM- 选项行是「名称 + 说明」两行（2026-10-27，参考 Claude Code 的 Modes / Model 菜单）：
     名称正常字号、说明小号次要色；选中项右侧一枚对勾。flex 布局让长说明自然折行。 */
  .picker-item {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 5px 8px; cursor: pointer; white-space: normal; text-align: left;
  }
  .picker-item-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .picker-item:hover { background: var(--vscode-list-hoverBackground); }
  .picker-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .picker-item.active .picker-item-desc { color: inherit; opacity: .85; }
  .picker-check { flex: none; margin-left: auto; display: inline-flex; align-items: center; opacity: .9; }
  .picker-check svg { display: block; }
  /* [CUSTOM- '+' 菜单里灰置的项（已有会话的 Workspace directories）。 */
  .picker-item:disabled { opacity: 0.45; cursor: default; }
  /* [CUSTOM- '+' 菜单项：图标与文字之间留一点间距（图标是 .chip-icon 12px inline-flex）。
     2026-10-27 起 .picker-item 已是 flex + gap: 8px，这里不再额外加 margin。 */
  .picker-item .add-menu-label { margin-left: 0; }
  /* [CUSTOM- 历史列表的目录过滤 chip + 菜单：**复用** composer 那套
     .picker-btn / .picker-menu / .picker-item（同一个"选一个值"的控件，观感应当一致），
     只补三件它没有的东西：
       · .down —— composer 的 picker 在面板底部、菜单向上弹；这个在 header 上、向下弹；
       · 右对齐 —— chip 在 header 右侧，菜单该从它这一侧展开；
       · .filter-item / .picker-count —— 行内有"名称 + 条数"，名称要能被省略号截断。 */
  .picker-menu.down { top: 100%; bottom: auto; left: auto; right: 0; min-width: 240px; }
  .filter-chip { max-width: 170px; font-size: 0.82em; padding: 0 5px; }
  /* 过滤生效时给边框上色：与 .outline-item.active 同一套"当前项"语义。**不用环**——
     环在这个面板里是键盘焦点（062 的教训）。 */
  .filter-chip.on { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
  /* [CUSTOM- 目录过滤菜单与历史列表的底色/边框/圆角几乎同值（两者都吃
     --vscode-dropdown-* 那套 token），叠在一起分不清哪个是哪个 —— 用户要求区分开。
     借 .filter-chip.on 已有的那套语义（--vscode-focusBorder 表示"当前项"）：**不是画环**
     （环在这个面板里是键盘焦点，062 的教训），只是把边框换成高亮色。 */
  .filter-menu { border-color: var(--vscode-focusBorder); }
  /* [CUSTOM- 筛选 chip 现在排在头部**最左**（计数在它右边），菜单也要跟着从左展开；
     '.picker-menu.down' 的 'right: 0' 是 chip 在右端时的锚点。 */
  #historyFilterMenu.picker-menu.down { left: 0; right: auto; }
  .filter-icon { display: inline-flex; align-items: center; flex: none; opacity: .7; }
  .filter-icon svg { display: block; }
  .filter-caret { flex: none; opacity: .7; }
  .filter-item { display: flex; align-items: center; gap: 8px; }
  .filter-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .picker-count { flex: none; opacity: .7; font-size: 0.9em; }

  .attachments { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .attachment {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 3px;
    padding: 0 5px; font-size: 0.88em; max-width: 100%;
  }
  .attachment-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .attachment-x {
    border: none; background: transparent; color: inherit; cursor: pointer;
    padding: 0 1px; opacity: .7;
  }
  .attachment-x:hover { opacity: 1; color: var(--vscode-errorForeground); }

  /* [CUSTOM- .input-row 这一层删掉了：它唯一的子节点就是 textarea，而 133 起
     textarea 是 .composer-card（flex 列）的子项 —— 那层 flex 行不再有任何作用，原文里的
     flex:1 在纵轴上的含义也完全不同（下面是 width:100%）。 */
  .prompt-input {
    width: 100%; box-sizing: border-box; resize: none; overflow-y: auto;
    background: transparent;
    color: var(--vscode-input-foreground);
    border: none; border-radius: 0; padding: 4px 0 0;
    font-family: inherit; font-size: inherit; line-height: 1.4;
    /* [CUSTOM- 默认占**两行**：autoGrow 里那个 60px 的下限已放开，正常情况
       下高度就是内容的自然高度；这条 min-height 是"JS 还没跑 / 内容为空"时的保底，
       数字与上面那条 1.4 的行高同源（两行 + padding-top 的 4px）。 */
    min-height: calc(1.4em * 2 + 4px);
    /* [CUSTOM- 视口上限；内容上限仍是 autoGrow 的 320，两者取小。 */
    max-height: var(--vac-input-max-h);
  }
  /* [CUSTOM- 焦点环改由卡片承担（见下面的 :focus-within）。只抑制这一个元素的
     outline，全局的 :focus-visible 不动 —— "环 = 键盘焦点"的语义（062）不变。 */
  .prompt-input:focus, .prompt-input:focus-visible { outline: none; }
  .prompt-input:disabled { opacity: .55; }
  .composer-card:focus-within { border-color: var(--vscode-focusBorder); }
  /* 禁用态让整张卡片跟着退场，否则是"鲜活的框里一行灰字"。:has() 需 Chromium ≥105
     （VS Code 1.85+ / Electron 25 起满足）；删掉也只损失一点观感。 */
  .composer-card:has(.prompt-input:disabled) { opacity: .7; }
  .send-stop {
    flex: 0 0 auto; width: 26px; height: 26px; padding: 0; border-radius: 4px; cursor: pointer;
    border: none; font-family: inherit; font-size: inherit;
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .send-stop:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .send-stop:disabled { opacity: .5; cursor: default; }
  .send-stop.stop { background: var(--vscode-inputValidation-errorBorder, #be1100); color: #fff; }
  .send-stop .send-icon { display: inline-flex; align-items: center; }
  .send-stop .send-icon svg { display: block; width: 14px; height: 14px; }

  /* [CUSTOM- 置底栏的上下文用量：**圆环 + 圆心数字**（取代 096 的细条 + 百分比）。
     选圆环的理由是按钮栏里横向空间稀缺；顺带它多挂得下一个"正在跑"的外圈。
     数据与阈值都没变，仍然是 meta.usage 与 0.7 / 0.9 两档。 */
  .context-meter {
    position: relative; flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px;
    color: var(--vscode-descriptionForeground); cursor: default;
  }
  .context-meter svg { display: block; }
  .gauge-track { fill: none; stroke: var(--vscode-panel-border); stroke-width: 2.5; }
  .gauge-fill {
    fill: none; stroke: var(--vscode-progressBar-background); stroke-width: 2.5;
    stroke-linecap: round;
    /* 起点从 3 点方向挪到 12 点方向，否则进度看起来是"从右边开始长"的。 */
    transform: rotate(-90deg); transform-origin: 50% 50%;
  }
  .context-meter.warn .gauge-fill { stroke: var(--vscode-charts-yellow); }
  .context-meter.hot .gauge-fill { stroke: var(--vscode-charts-red); }
  .gauge-text {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 8.5px; font-variant-numeric: tabular-nums;
    color: var(--vscode-foreground); pointer-events: none;
  }
  /* 外圈：一段 1/4 弧。只在**有轮次在跑**时出现并绕圈转——"它在干活"。
     半径比进度环大 2.5，两环之间才留得出缝（贴在一起时外弧读不出是"另一圈"）。
     周长 2π×11.5 ≈ 72.3，所以 dasharray 的 18.1 + 54.2 恰好绕满一圈。
     减少动效偏好由文件末尾那条全局规则兜住（animation: none !important）。 */
  .gauge-spin {
    /* currentColor (= the .context-meter's descriptionForeground), NOT the progress blue:
       same colour as the progress ring made the two read as two different progress bars.
       A neutral arc says "activity", and the blue ring keeps saying "how much". */
    fill: none; stroke: currentColor; stroke-width: 1.5;
    stroke-linecap: round; stroke-dasharray: 18.1 54.2;
    opacity: 0; transform-origin: 50% 50%;
  }
  .context-meter.running .gauge-spin { opacity: .9; animation: gauge-spin 1.5s linear infinite; }
  @keyframes gauge-spin { to { transform: rotate(360deg); } }

  .attachment-thumb { height: 20px; width: 20px; object-fit: cover; border-radius: 2px; flex: 0 0 auto; cursor: zoom-in; }

  /* Slash popup */
  .slash-popup {
    /* [CUSTOM- left/right 从 6px 改成 0：定位祖先已从 .composer 换成
       .composer-inner —— 那 6px 原本是抵消 .composer 的左右内边距、让弹层与 textarea 的
       边框盒对齐；现在祖先本身就是版心，0 就是卡片的那条边。留着 6px 会缩进一圈，
       而如果把它放在 .composer 里，宽屏下它会横跨整屏（与 820 的版心错位）。 */
    position: absolute; bottom: 100%; left: 0; right: 0; z-index: 30;
    max-height: 220px; overflow-y: auto;
    background: var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background));
    border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-dropdown-border));
    border-radius: 3px; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.3));
    margin-bottom: 4px;
  }
  .slash-item { padding: 3px 8px; cursor: pointer; }
  .slash-item.active { background: var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-list-activeSelectionBackground)); }
  .slash-name { font-family: var(--vscode-editor-font-family); }
  .slash-desc { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-left: 8px; }

  /* --- 自定义右键菜单（）------------------------------
     取代 Chromium 的原生菜单：它提供的 Cut/Paste 在这里没有意义，而 Copy 复制的是
     **选区**（右键时通常没有选区）⇒ 表现为"点了没反应"。位置由 JS 按光标与视口边界算。 */
  .ctx-menu {
    position: fixed; z-index: 60;
    min-width: 150px; padding: 3px 0;
    background: var(--vscode-menu-background, var(--vscode-dropdown-background));
    color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border));
    border-radius: 4px;
    box-shadow: 0 3px 12px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
  }
  .ctx-item {
    display: block; width: 100%; text-align: left;
    padding: 3px 12px; cursor: pointer;
    background: transparent; border: none; color: inherit;
    font-family: inherit; font-size: inherit;
  }
  .ctx-item:hover:not(:disabled) {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, inherit);
  }
  /* 禁用态是有意义的："Copy" 在没有选区时禁用，而不是点了什么都不发生。 */
  .ctx-item:disabled { opacity: 0.5; cursor: default; }

  /* [CUSTOM- 通用浮层（确认 / 输入）：非模态，没有背景遮罩。
     z-index 95 高于设置面板（80 / 子面板 85）与图片放大（90），低于任何未来的系统级提示。
     定位由 client/popover.ts 按锚点算；这里只负责长相。 */
  .popover {
    position: fixed; z-index: 95;
    min-width: 210px; max-width: min(360px, calc(100vw - 16px));
    padding: 10px 12px;
    background: var(--vscode-menu-background, var(--vscode-dropdown-background));
    color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-dropdown-border));
    border-radius: 6px;
    box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.35));
  }
  .popover-title {
    margin-bottom: 4px; font-weight: 600;
    overflow-wrap: anywhere;
  }
  .popover-message {
    font-size: 0.92em; line-height: 1.45; white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .popover-input-wrap { margin-top: 8px; }
  .popover-input {
    width: 100%; box-sizing: border-box;
    padding: 4px 6px; border-radius: 3px; font-family: inherit; font-size: inherit;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    outline: none;
  }
  .popover-input:focus { border-color: var(--vscode-focusBorder); }
  .popover-actions {
    display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px;
  }
  .popover-btn {
    padding: 3px 10px; border-radius: 3px; cursor: pointer; font-family: inherit;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-panel-border);
  }
  .popover-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .popover-btn.danger {
    background: var(--vscode-inputValidation-errorBorder, var(--vscode-button-background, #0e639c));
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }

  /* Load overlay */
  /* [CUSTOM- Scoped to the message area (its parent is
     '.message-area', which is already 'position: relative') — it used to be
     'position: fixed', which covered the tab strip, header and composer too. */
  .load-overlay {
    position: absolute; inset: 0; z-index: 40;
    display: flex; align-items: center; justify-content: center;
    background: var(--vscode-sideBar-background);
    opacity: .92;
  }
  .load-box { display: flex; align-items: center; gap: 8px; color: var(--vscode-descriptionForeground); }
  .spinner {
    width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid var(--vscode-panel-border);
    border-top-color: var(--vscode-progressBar-background);
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* --- 图片放大查看（）--------------------------------- */
  /* [hidden] 靠文件顶部的 [hidden]{display:none!important} 生效（pitfall #13）。 */
  .image-lightbox {
    position: fixed; inset: 0; z-index: 90;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.75);
    cursor: zoom-out;
  }
  .image-lightbox-img {
    max-width: 92%; max-height: 92%;
    border-radius: 4px; box-shadow: 0 6px 28px rgba(0, 0, 0, 0.55);
  }
  .image-lightbox-close {
    position: absolute; top: 14px; right: 14px;
    width: 32px; height: 32px; padding: 0;
    border: none; border-radius: 4px; cursor: pointer;
    background: rgba(255, 255, 255, 0.16); color: #fff;
    font-size: 16px; line-height: 1;
  }
  .image-lightbox-close:hover { background: rgba(255, 255, 255, 0.32); }

  /* --- Settings panel -------------------------------------------------- */
  /* [CUSTOM- 设置面板：遮罩 + 居中面板；左侧竖排分组、右侧设置行。
     窄面板退化为顶部横排分组（用户明确要求"Tab 按钮放左侧"，只在宽度不够时才换向）。 */
  .settings-overlay {
    position: fixed; inset: 0; z-index: 80;
    display: flex; align-items: center; justify-content: center;
    padding: 16px; background: rgba(0, 0, 0, 0.45);
  }
  .settings-panel {
    display: flex; flex-direction: column;
    width: min(720px, 100%);
    /* [CUSTOM- 固定尺寸（2026-10-21）：高度不随内容自适应 —— 换分组、改值时面板不跳。
       视口太矮时 max-height 兜底，内容在内层滚动。 */
    height: clamp(320px, 80vh, 640px);
    max-height: calc(100vh - 32px);
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    border-radius: 8px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    overflow: hidden;
  }
  .settings-head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .settings-title { font-weight: 600; }
  .settings-close {
    padding: 2px 6px; border: none; border-radius: 3px; cursor: pointer;
    background: transparent; color: inherit; font-size: 14px; line-height: 1;
  }
  .settings-close:hover { background: var(--vscode-list-hoverBackground); }
  .settings-main { display: flex; flex: 1 1 auto; min-height: 0; }
  .settings-nav {
    display: flex; flex-direction: column; gap: 2px;
    flex: 0 0 132px; padding: 8px;
    border-right: 1px solid var(--vscode-panel-border); overflow-y: auto;
  }
  .settings-tab {
    padding: 6px 8px; border: none; border-radius: 4px; cursor: pointer;
    background: transparent; color: inherit; text-align: left;
    font-family: inherit; font-size: 0.95em;
  }
  .settings-tab:hover { background: var(--vscode-list-hoverBackground); }
  .settings-tab.active {
    background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }
  .settings-body { flex: 1 1 auto; min-width: 0; padding: 12px 16px; overflow-y: auto; }
  .settings-row {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
    padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .settings-row:last-child { border-bottom: none; }
  .settings-row.indent { padding-left: 16px; }
  .settings-text { min-width: 0; }
  .settings-label { font-size: 0.95em; }
  .settings-desc { margin-top: 2px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  /* [CUSTOM- 设置项的存储作用域（All IDEs / This IDE / Workspace / Default）。 */
  .settings-label-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .settings-scope {
    padding: 0 7px; border-radius: 999px; cursor: pointer; font-family: inherit;
    font-size: 0.72em; line-height: 1.7; white-space: nowrap;
    border: 1px solid var(--vscode-panel-border);
    background: transparent; color: var(--vscode-descriptionForeground);
  }
  .settings-scope:hover { background: var(--vscode-list-hoverBackground); }
  .settings-scope-global { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
  .settings-scope-workspace {
    border-color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground));
    color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground));
  }
  .settings-scope-default { opacity: 0.75; }
  .settings-override {
    display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 0.82em;
    color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground));
  }
  .settings-link {
    padding: 0; border: none; background: transparent; cursor: pointer; font: inherit;
    color: var(--vscode-textLink-foreground); text-decoration: underline;
  }
  .settings-link:hover { color: var(--vscode-textLink-activeForeground); }
  .settings-inspect { display: flex; flex-direction: column; gap: 6px; flex: 0 1 auto; min-height: 0; overflow-y: auto; }
  .settings-inspect-row {
    display: grid; grid-template-columns: 1.1fr 1.2fr 0.8fr auto; gap: 8px; align-items: center;
    padding: 6px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 4px;
  }
  .settings-inspect-row.active {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-activeSelectionBackground, transparent);
  }
  .settings-inspect-layer { font-size: 0.9em; }
  .settings-inspect-file, .settings-inspect-value {
    font-size: 0.8em; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere;
  }
  .settings-inspect-actions { display: flex; gap: 10px; }
  .settings-inspect-promote { align-self: flex-start; }
  .settings-inspect-note { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .settings-warning {
    margin-top: 4px; font-size: 0.82em;
    color: var(--vscode-editorWarning-foreground, var(--vscode-errorForeground));
  }
  .settings-control { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding-top: 2px; }
  .settings-check { width: 14px; height: 14px; accent-color: var(--vscode-button-background); }
  .settings-select, .settings-number, .settings-text-input {
    padding: 2px 4px; border-radius: 3px; font-family: inherit;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  }
  .settings-number { width: 76px; }
  .settings-text-input { width: 220px; max-width: 100%; }
  .settings-action {
    padding: 2px 10px; border-radius: 3px; cursor: pointer; font-family: inherit;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: 1px solid var(--vscode-panel-border);
  }
  .settings-action:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .settings-value {
    max-width: 280px; text-align: right; font-size: 0.85em;
    color: var(--vscode-descriptionForeground); overflow-wrap: anywhere;
  }
  /* [CUSTOM- 设置子面板（模型列表 / JSON 编辑器）：盖在主面板之上、尺寸更小。
     内容区是纵向 flex：编辑器自己占满，底部按钮靠右下。 */
  .settings-sub-overlay { z-index: 85; }
  .settings-sub-panel { width: min(640px, 100%); height: clamp(320px, 65vh, 560px); }
  #settingsSubBody { display: flex; flex-direction: column; overflow: hidden; }
  .settings-editor { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; gap: 8px; }
  .settings-editor-intro { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .settings-editor-footer {
    margin-top: auto; padding-top: 8px;
    display: flex; justify-content: flex-end; gap: 8px;
  }
  .settings-json {
    flex: 1 1 auto; min-height: 80px; width: 100%; resize: none; box-sizing: border-box;
    padding: 6px 8px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  }
  .settings-json-error { margin-top: 4px; font-size: 0.8em; color: var(--vscode-errorForeground); }
  .settings-model-head, .settings-model-row {
    display: grid; grid-template-columns: 1.5fr 1fr 1.2fr 24px; gap: 6px; align-items: center;
  }
  .settings-model-head { padding: 0 2px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  .settings-models {
    display: flex; flex-direction: column; gap: 6px;
    flex: 0 1 auto; min-height: 60px; overflow-y: auto;
  }
  .settings-model-row .settings-text-input { width: 100%; }
  .settings-model-add { align-self: flex-end; }
  .settings-model-remove {
    padding: 2px 6px; border: none; border-radius: 3px; cursor: pointer;
    background: transparent; color: inherit;
  }
  .settings-model-remove:hover {
    background: var(--vscode-list-hoverBackground); color: var(--vscode-errorForeground);
  }
  @media (max-width: 520px) {
    .settings-main { flex-direction: column; }
    .settings-nav {
      flex: 0 0 auto; flex-direction: row; overflow-x: auto;
      border-right: none; border-bottom: 1px solid var(--vscode-panel-border);
    }
    .settings-body { padding: 8px 12px; }
  }
</style>`;
}
