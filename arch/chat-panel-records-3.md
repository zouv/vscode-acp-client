# Chat 面板 · 记录区（折叠 / 时间 / 内容渲染 / 右键菜单）（续 3）

> 接上篇：[chat-panel-records-2.md](chat-panel-records-2.md)

### 5.51 会话 tab 的目录标识（CUSTOM-20261009-225，修订 226/227/228/229）

状态圆点（7px 圆点）改造成 16px **方形**圆角块，里面写目录缩写（最多 4 个字母，按非字母数字 + 驼峰边界拆词取首字母，大写）。

**取最底层目录名（227 修订，用户报"DGAD 不对"）**：首版 `cwd.split(/[\\/]/)` 在模板串里求值后客户端拿到 `/[\/]/`（只匹配正斜杠），Windows 路径（`D:\Git\…`）整条不拆 ⇒ 整条路径进拆词 ⇒ DGAD。修法：模板串里写**四个**反斜杠（`/[\\\\/]/`），客户端拿到 `/[\\/]/`（同时匹配两种分隔符）⇒ 取到最后一段目录名再拆词。

**布局分档（227 → 228 → 229 三次修订）**：`NS.dom.el(tag, cls, text)` 把缩写当一个文本节点，一行排不下才换行 ⇒ 4 个字母挤一行。227 改成每个字母一个 `<span class="dir-letter">`、宽度 50%，让 4 字母排成 2x2。228 让 1~3 个字母走单行居中（宽度 auto）、只有 4 个才折 2x2，并改由 dot 上的 **`data-len`** 分档（选择器不再靠猜元素位置）。
**229（用户报"3 字母并排挤、4 字母中间空"）**：`width: 50%` 的等分格把每个字母居中在自己的 8px 格里 —— 4 字母的墨迹因此被推到方块四角、中缝 3.5px；3 个字母挤成单行时墨迹占满 **15/16px**、首尾贴到圆角上。现在 **3/4 两档共用一套紧凑两列网格**（`grid-template-columns: repeat(2, auto)` + `justify-content`/`align-content: center` + `column-gap: 1px`）：4 个自然排成 2x2（中缝 1.0px、整块 11.0px 居中），3 个是「上 2 下 1」（第 3 个 `grid-column: 1 / -1` 跨两列居中）。1/2 个字母不变，仍走弹性单行。

**字号分档与圆角（228，229 修订）**：字号原先是写死的 `0.42em`，真机（`--vscode-font-size` 默认 13px）只有 **≈5.5px**。228 起按字母数分档；**229 起两行档同字号**：1 个 `min(0.7em, 9.1px)` / 2 个 `min(0.6em, 7.8px)` / **3、4 个 `min(0.54em, 7px)`**（229 把 4 个从 `min(0.5em, 6.5px)` 提上来：网格收紧后两行的行盒 2×7 = 14px，方块里还剩 2px 余量；6.5px 是旧布局为"被等分格浪费掉的空间"付的代价）。圆角 `4px` → `6px`；6px 是四档的共同上限 —— 2x2 的角格里有字，再圆就削到笔画。写成 `min(em, px)` 是因为**方块固定 16px 而字号是相对的**：不封顶的话用户把工作区字号调到 16px 以上，两行会顶破方块、被 `overflow: hidden` 削掉。

**dot 的 tooltip（228，229 补状态）**：`title` = **两行、各带标签**：`Dir: <完整 cwd>` + `State: <会话状态>`
（228 只有 cwd；229 加状态与标签 —— 标签是必要的，两行裸值悬停时分不清哪行是路径哪行是状态）。229 的依据：dot 同时用**颜色**表达状态，而颜色没有名字、标签栏也没有图例 —— 悬停是唯一能"问出来"的地方。状态文案与 `dotClass` 的优先级**逐条对齐**（`tabs.ts:dotStatusText`：等人回答 > 轮次在跑 > 载入历史 > 后台有新输出 > Idle）；两处一旦漂移，颜色与文字就会对同一个会话各说各话。没有 cwd 的会话只有 `State:` 那一行。

**颜色分工（226 修订，用户报"完成态看不见"）**：首版把状态色写在 `color:` 上，而 `background: currentColor` 会把 color 当背景用 —— 完成态（无状态类）时 color 是 `descriptionForeground`（灰）、背景灰、文字近黑 ⇒ 看不见。现在**状态色只给 background-color，文字色固定在 color 上**（不再吃状态类）；外圈单独读 `--tab-dot-state` 自定义属性（background-color 不能给 currentColor 用）。

缩写规则：'alpha-beta-gamma' → 'ABG'，'AbcDeFg' → 'ADF'，'abc-de-fg' → 'ADF'。

**踩坑**：拆词不用正则 lookbehind（本文件要走 check-webview-client.mjs 的 new Function 解析，lookbehind 在它的目标解析里会报 Unexpected token）—— 用两轮拆分（先按非字母数字切，再按驼峰边界切）。2026-10-29 起状态色改成固定 hex，预览不再依赖 `--vscode-charts-orange/yellow/blue` 这几个 token（旧版缺 token 时 waiting/loading/attention 会算成透明，探针才验不出对比色）。

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

### 5.55 上下文压缩记录（compact，2026-11-02）

**为什么需要**：Claude Code 压缩上下文后，转录里会留下一条 `isCompactSummary` 的 user 记录
（`This session is being continued from a previous conversation…`）。它是给模型的续接摘要，
**不是用户说过的话**。旧实现没有识别它：`session/load` 回放时它被当成 `user_message_chunk`，
于是 Chat 顶部出现一条巨大的蓝色用户气泡、对话大纲首条也变成这段摘要。

| 关注点 | 规则 |
|---|---|
| 三条来源 | ① ACP `compaction_update`（声明 `session.compaction` 的适配器）；② `compaction_summary_chunk`（实时 `/compact` 的流式摘要）；③ 旧适配器的 `user_message_chunk`（预读 `isCompactSummary` 标记 / 文本前缀 / 同一 messageId 的后续分片）。三条都汇到 `TranscriptStore.upsertCompact`，按 `compactionId` 幂等 |
| 完整历史来源 | `session/load` 的压缩前历史由 `claude-agent-acp` 适配器从原始 JSONL 重建完整显示链后回放；VAC 只消费回放更新。0.91.0 的 `getSessionMessages()` 只返回压缩后链（首条是 summary），会让首条真实提问缺失 |
| 记录形状 | `CompactEntry`：`compactionId` / `text` / `html?` / `trigger?` / `preTokens?` / `error?` / `status?`。`status` 只给宿主去重（终态后忽略迟到的 fallback 文本），不下发客户端 |
| 元数据 | `diskSessions.readTranscriptCompactions` 从 `system/compact_boundary` 的 `compactMetadata.preservedSegment.anchorUuid` 取 summary uuid，映射 `{ trigger, preTokens }`；ACP 的非 AIR 客户端拿不到这两个字段 |
| 渲染 | `transcriptView.buildCompact` → `<details class="compact">`，默认收起；summary 文案 `Compacted chat · auto · 176k tokens freed`；正文走与 assistant/thought 同一条 markdown 回填（`html`）；错误单独放 `.compact-error` |
| 排除面 | 大纲只收 user/assistant、置顶条只收 user —— compact 自动排除；`place()` 的 `messageAnchorCount` 不把它算作消息锚点；rail 显式返回 `Compacted conversation`，不再 fallback 到摘要首行 |
| 时序坑 | `replayCompactions` 在 `openExistingSession` 之前预读，**`session-load-start` 不能清它**；只清 `compactionSummaries` / `compactReplayIds` / `compactReplayOpen` |
| 文本坑 | `summary: null` / `[]` 是显式清空，不能被累计分片复活；分片追加或 `text` 变化必须清 `html`；终态 text 没变时不要把 `text` 放进 revise（否则客户端会作废已渲染 html） |
| 兜底边界 | 预读标记是可靠信号；前缀只认第一片；没有 messageId 时用 `compactReplayOpen` 续接，收到真实用户消息 / `session-load-end` 立即清除 |

### 5.56 代码块高亮与 Mermaid 图（2026-11-05）

**代码高亮是宿主侧的事**：`markdown.ts` 的 `renderer.code()` 用 `highlight.js/lib/common` 同步高亮，
只输出 `hljs-*` class（客户端白名单保留 `SPAN`/`class`，不需要放开 `style`）；未知语言、超长代码
（>100KB）回退为转义原文。流式 token 渲染与完整渲染共用同一 renderer，`MarkdownStream.spec.ts`
的逐字符一致性测试继续兜住两条路径。

**Read 文件补全**：`ChatPanelHost.readLanguageForMarkdown` 从会话的权威 ToolInvocation 验证 read / 单一 location / 原文后，用 `content/readHighlight.ts` 按后缀推断；`SafeMarkdown.renderReadCode` 仅处理整个无语言围栏，行号/Tab 拆分后整块高亮再还原，复制文本不变；`toolCallView.readContextKey` 随路径变化重请求，`mdActive` 防旧回包盖新节点。`styles.ts` 显式清 `pre code` 的 webview 默认背景，解决逐行黑块；`.tool-text.md` 回到正常空白排版。

**Mermaid 是客户端的事**：宿主只把 fence 渲染成 `<pre data-lang="mermaid" data-mermaid="1">`；
`client/mermaid.ts` 在记录定稿后把它包成 `.mermaid-block`（toolbar + chart + source + error）。
库是 `@mermaid-js/tiny`，构建时复制到 `dist/media/mermaid.tiny.js`，通过 `body[data-mermaid-src]`
**首次出现 Mermaid 块时**才插入带 nonce 的外部 `<script>`；CSP 仍是 `script-src 'nonce-…'`。

| 关注点 | 规则 |
|---|---|
| 触发时机 | `transcriptView` 的 `hydrate` / `append` / `patch` 末尾调用 `decorateMermaid`；tool 条目按 `toolView.status` 判定 running。`applyStreamBody` 的稳定块/tail **不触发**（`MarkdownStream` 遇到链接引用定义 `]:` 时整篇 tail 每 120ms 重建，渲染会抖动） |
| 定稿兜底 | `patch()` 在写 `data-streaming` **之后**再调一次，覆盖 `preserveCompletedStream()` 保留 DOM、没有重新 sanitize 的路径 |
| 工具输出 | `toolCallView.applyRendered` 在 `decorateScrollables` 后调用；running 中跳过，`updateTool` 结束时补触发 |
| 安全 | 只有 `mermaid.render()` 的 SVG 直接写 `.mermaid-chart`（唯一绕过 `NS.dom.sanitize` 的位置）；源码取 `code.textContent`，`securityLevel:'strict'`、`flowchart.htmlLabels:false`、不调 `bindFunctions`；错误信息只用 `textContent` |
| 切换 | 每个块两个真按钮（Diagram / Source），只切 `hidden` + `aria-pressed`；用户手动选的视图在主题重渲染后保持 |
| 尺寸 | `.mermaid-chart` 设 `max-height: min(60vh, 560px)` + `overflow:auto`，长图在图表内滚动而不是撑高消息列；SVG 用 `width: calc(100% * var(--vac-mermaid-zoom, 1))`、`height:auto`、`max-width:none !important` 覆盖 mermaid 的内联 `max-width:Npx`，默认按 1:1 宽高比贴合面板宽度 |
| 缩放 | 每个块独立 `mermaidZoom`（50–200，步进 10）；toolbar 左组 `− / N% / +`，百分比按钮 Reset 100%；缩放只改 `.mermaid-chart` 的 CSS 变量，主题重渲染后 `renderOne` 重新应用；`data-mermaid-zoom` 记录块状态，`data-mermaid-zoom-action` 只挂在按钮上（避免与 `data-mermaid-view` 的 aria 循环冲突） |
| 内层滚动 | `.mermaid-chart` 加入 `scroll.ts` 的 `INNER_SCROLL_SELECTOR` 与 overscroll/thin-scrollbar 列表：点击图表后滚图不滚面板，未聚焦时仍滚面板。焦点门控的标题栏兜底（`firstInnerScroller`）**跳过** `.mermaid-chart`：点消息正文不会把焦点交给图表，只有点中图表本身才聚焦 |
| 渲染隔离 | `mermaid.render(id, source, stage)` 的第三个参数把临时容器建在 `.mermaid-stage`（`fixed` / 离屏 / `visibility:hidden`，保留布局供量字）里，渲染结束立刻摘掉。绝不能让临时容器落回 `document.body`：面板 body 是 100vh 的 flex 列，渲染慢或卡住时它会参与布局、把整块面板挤成一片背景（用户报的「全灰屏」）。`suppressErrorRendering:true` 让失败只抛错、不往页面画错误图 |
| 切换与选区 | 「图表 / 原文」切换前，先折叠落在**将被隐藏**的节点里的文本选区（`clearSelectionInside`）；`.mermaid-chart` 与 `.mermaid-toolbar` 都不参与文本选择（`user-select:none`），工具栏的第二次按下（`detail>1`）还会 `preventDefault`；重写 `chart.innerHTML` 前同样先折叠旧 SVG 里的选区。这是为了避开 VS Code webview 渲染进程在「隐藏子树仍带选区 / 双击选词 / SVG 样式表」路径上的原生崩溃（用户实测：双击工具栏空白处即灰屏；日志里没有任何 mermaid 渲染失败；崩溃转储是 `vscode-webview` renderer 的 `EXCEPTION_BREAKPOINT`，栈上有 `SelectionController::handleMousePressEventDoubleClick`） |
| 工具栏 | Diagram / Source 永远靠右：`.mermaid-view { margin-left:auto }`（Source 视图里缩放组 `display:none`，只靠 `space-between` 会让它跳到左边） |
| SVG 样式归属 | mermaid 把主题 CSS 写在 SVG 内的 `<style>`（SVGStyleElement）。`renderOne` 用 `splitSvgStyle` 把它摘出来，改挂到 `.mermaid-block` 上的普通 HTML `<style>`（`applySvgStyle`）：规则本来就全部带 `#vac-mermaid-N` 前缀，作用域不变，同时避开 SVG 样式表的原生生命周期路径 |
| 主题 | `MutationObserver(body.class)` 变化后重新 `initialize` 并重渲染 `state=ready` 的块；颜色从 `--vscode-*` 读取 |
| 失败 | 脚本加载失败 / 语法错误 / 超过 `maxTextSize`（30000）或 `maxEdges`（200）/ 单图 15s 超时 → `data-mermaid-state="error"`，自动切 Source、显示固定错误文案、禁用 Diagram；失败不逐块重试；原因写一行 `console.warn('[vac] mermaid render failed: …')` |
| 安全边界 | 带 nonce 的外部脚本仍是 nonce-only CSP；**不要**为了 Mermaid 把 `cspSource` 加进 `script-src` |