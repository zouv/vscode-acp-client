（续 1b）

> 接上篇：[chat-panel-records.md](chat-panel-records.md)

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

> 续：[chat-panel-records-2.md](chat-panel-records-2.md)
