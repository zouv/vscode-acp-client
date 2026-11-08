# Chat 长会话性能 · 代码链路分册

> 入口：[`chat-panel.md`](./chat-panel.md)。§5.10 编号保留，定位代码以函数名为准。

### 5.10 长会话性能：outbox / 增量文本 / rAF / 滚动记忆（CUSTOM-20260924-022）

**四个病灶**（改之前先确认还在不在）：① 扩展侧每个 chunk 一次 postMessage；② 客户端每次整段重设
`textContent`（累积全文，O(n²)）+ 读 `scrollHeight` 强制重排；③ `refreshSessions()` 每个 chunk 都跑，
于是每片重建整条标签栏；④ 工具分组的整容器 `querySelectorAll` 在每次工具更新时都跑。

| 手段 | 位置 |
|---|---|
| 合帧队列（队尾单条同 id 的 append 替换；`appendText` 首尾相接拼接、已含于队尾 append 则丢弃；`toolUpdate` 同条目后者胜） | `ChatPanelHost.post()` 按类型路由 → `Outbox.enqueue/mergeText/dropStaleToolUpdate` |
| 标签栏快照签名（没变就不发） | `ChatPanelHost.refreshSessions()` |
| 增量文本追加（前缀成立才 `appendData`）；流式预览只截前 240 字符；相同 prose HTML 不重建 | `transcriptView.setStreamingText` / `refreshPreview` / `applyAssistant` / `applyThoughtBody`；WeakMap 缓存不阻止 DOM 淘汰 |
| rAF 合帧：滚动跟随 + 工具分组重排 | `dom.schedule` ← `scroll.follow()` / `refreshGroupingSoon()` |
| 每会话滚动记忆（含贴底状态）+ 持久化 | `scroll.remember/restore/reassert/forget` + `boot.applyFocus` |

**INV-A..F（顺序不变式，破了**没有任何自动检查会报错**）**

- **INV-A** 某条 entry 的 `revise` 不得越过创建它的 `append`。客户端 `patch()` 对未知 id 是
  **静默 no-op**（`transcriptView.patch` 的前两行），越过 = 那条更新凭空消失。
  靠 FIFO + 只合并队尾保证。
- **INV-B** `markdownRendered` 同样只能按 FIFO 走，不得被"提前冲刷"。
- **INV-C** `sessionsChanged` 不得延迟/合并——它驱动 Send/Stop 按钮（`boot.syncFocusedState`），
  晚了按钮状态就是错的。它走 `flushThenPost`，且**只在签名变化时**才调（否则会顺带把队列冲掉，
  等于取消合帧）。
- **INV-D** `sessionClosed` 不得延迟。
- **INV-E** 每次 `boot`/`focus` 快照前必须先 `flush()`（`pushBoot`/`pushFocus` 的第一句）。
- **INV-F** **只延后**滚动、大纲 tick、工具分组重排。`hydrate` / `append` / `patch` / `updateTool` /
  `pending` 表 / `requestMarkdown` **一律同步**——`applyFocus` 里 `hydrate()` 之后立刻
  `requestMarkdown()`，一旦延后 `pendingMarkdown()` 就是空的，markdown 整条链静默失效（P0 #1 那个 bug）。

**滚动记忆的两个陷阱**：
1. `hydrate()` 里**不能**留无条件的 `toBottom()`——决策在 `applyFocus`（切走前 `remember`、
   hydrate 后 `restore`），留着会把刚恢复的位置立刻冲掉，表现为"功能做了但没生效"。
2. markdown 回填会改变高度 → `markdownRendered` 后要 `reassert()` 再对齐；
   用户一旦以滚轮/拖条/中键/翻页接管视口就放弃恢复；浏览器原生布局锚定不算用户意图。

**诊断**：每轮结束打一行 `chat-panel: outbox sent=N merged=M queued=K`。`merged` 占比高 = 合帧在工作。
**043 起这三个数字是「单轮」语义**（`finalizeTurn` 打印后 `resetStats()`）——此前是累计值，
`merged/sent` 会漂向长期均值、那行诊断随时间失去意义。轮末的 `queued` 正常是 0–2（还在飞行中的那一帧），
**跨轮持续偏大**才是"有东西绕过 outbox"的真信号。

## 流式 Markdown：稳定块与可变尾块（2026-11-02）

| 层 | 定位 | 契约 |
|---|---|---|
| 安全渲染 | `markdown.ts` 的 `SafeMarkdown.lex/renderTokens/render` | 复用同一白名单 renderer 与 GFM 配置；定稿仍全量渲染 |
| 增量解析 | `MarkdownStream.ts` 的 `MarkdownStream.render` | 保留已完成的顶层 token；最后一个非空白 token 连同尾随空白继续解析，避免列表/围栏/表格/setext 标题过早定稿 |
| 有界状态 | `MarkdownStreamCache` | 按 session + entry 建键；LRU 上限 32，定稿请求释放 |
| 宿主 | `ChatPanelHost.handleRenderMarkdown` + `MarkdownStream.streamSourceOf` | 仅当前流式 assistant/thought 接受匹配的文本前缀（按长度 + 末尾校验串，或旧式全文前缀）；临时 HTML 不写 TranscriptStore |
| 客户端 | `transcriptView.applyStreamItem/applyStreamBody`、`pendingMarkdown` | 每 entry 一个流式 in-flight；120ms 节流；请求只带长度/校验串/已持有的稳定块；回复按 generation 拼接稳定块；稳定块只 sanitize/decorate 一次，只重建可变尾块 |
| 定稿 | `trackMarkdown/preserveCompletedStream` | 定稿请求按完整文本校验；等待最终 HTML 时保留临时 DOM，最终 HTML 与当前块一致时不重建稳定 DOM |

`renderMarkdown.items[].streaming` 是可选请求字段。**2026-11-08 起流式请求不再上传全文**：`text` 为空，
`textLength` = 客户端正文长度、`check` = 末尾 ≤16 字符，`streamGeneration/streamBlocks` = 已持有的稳定块
（`protocol.RenderMarkdownItem`）。流式回复为 `markdownRendered.items[].stream`（`MarkdownStreamFrame`）：
`sourceLength`、`generation`、`start`、`blocks`（只含 `start` 之后的新稳定块）与 `tailHtml`（`html` 为空）。
客户端在同一 generation 下保留 `[0,start)`、拼上新块；generation 对不上就丢掉本地帧、下次请求拿全量。
generation 进程级单调（LRU 淘汰后重建的解析器不会复用旧号）。客户端仍接受旧式 `source` 全文帧（start 0）。
普通定稿/工具 key 请求仍走原契约。
旧前缀回复可以显示，但新到字符始终以 text node 接在 raw extra 中，不截断、不丢内容；
替换源、其它会话和定稿后晚到的流式回复都拒收，旧流式回复不得解除新定稿请求的 in-flight。
正在选择可变尾块时保持旧尾块，后续内容先进 raw extra；选择释放后的下一次更新恢复解析。

**安全回退**：链接引用定义（`[label]: url`）会改变**更早**块的渲染，所以只要正文里出现 `]:`
（定义语法的线性超集判据，只扫新增后缀）就整篇全量解析；普通 `[链接](url)`、`[ ]` 任务框、`a[0]` 不再触发回退。
非前缀替换重置稳定块并换 generation。
CRLF 规范化只用于解析，回复 source 仍为原文本。正文超过 262144 字符时全量解析且不缓存全文状态，
这是解析缓存边界，**不是**正文显示截断。无论分块还是回退都经过 SafeMarkdown 与客户端 sanitize。

## 长会话卡顿第二轮：增量传输与去全表扫描（2026-11-08）

| 病灶 | 手段 | 位置 |
|---|---|---|
| 每个正文 chunk 把整条活记录（≤64KB）重发 | 合并 chunk 若只是**追加**就发 `appendText { entryId, offset, text }`；新记录或 64KB 截断改写仍发整条 `append`。客户端 offset 对不上（缺口/分叉）→ `resyncEntry` → 宿主 flush 后定向回整条 `append`（客户端每条记录 1s 限一次） | `ChatPanelHost.postProse`；`boot` 的 `appendText` 分支；`transcriptView.appendText`（隐含 `streaming:true`，与整条 append 的 patch 效果一致） |
| 每个 chunk `refreshSessions()` | 新气泡打开时立即；其余走 `refreshSessionsSoon`（200ms 尾随合并）。签名去重与 INV-C 不变 | `ChatPanelHost.refreshSessionsSoon` |
| 每个 chunk `finalizeStreaming({only:'thought'})` 扫全表 | 每会话维护仍在流式的 assistant/thought 集合（append/patch/裁剪同步维护），空集直接返回 | `TranscriptStore.finalizeStreaming` / `trackOpen` |
| 每个 `tool_call_update` 跑嵌套全对比 | 无 Task 类调用（也无旧链接）直接跳过；候选只在 Task 类调用里找；父输出“是否提到子 id”按 payload 身份缓存；`needsPass`：本次更新没改 kind/title/rawInput/rawOutput/meta/status/起止时刻，且没有开放区间的 Task 或已挂链接的运行中子调用 ⇒ 跳过 | `ClaudeCodeNesting.apply/needsPass`、`nestingInputsOf`；`ChatPanelHost.applyToolCallUpdate/applyNesting` |
| `toolUpdate` 不合帧 | Outbox 同条目后者胜（删旧、新的排队尾，INV-A 不变） | `Outbox.dropStaleToolUpdate` |
| 快照同步预渲染全部缺 html 的记录 | 只同步补最新 30 条，其余走客户端 markPending 往返；`collectMissingMarkdown` / `onRemove` 改读 `peekEntries`（不拷贝快照） | `ChatPanelHost.prefillSnapshotMarkdown`、`TranscriptStore.peekEntries` |
| 回放侧表常驻 | `session-load-end` 清 `replayTimes` / `replayUserParts`（下次重开会重读） | `ChatPanelHost` 的 `session-load-end` 监听 |
| rail 每次 invalidate 为全部记录算标签 | 签名直接由 id/kind/state 拼（`currentSignature`），标签只在 `rebuild` 里算；`firstLine` 先截 280 字符再折空白（截后 ≤70 才回退全文，结果不变） | `rail.currentSignature/firstLine` |
| 大纲侧栏每个 chunk 同步重建 200 行 | `invalidate` → `renderSoon`（每帧一次）→ `renderInto(…, onlyIfChanged)`：行签名（id/kind/标签/title/时刻，或卡片信息）不变就不动 DOM（保住 hover/焦点）；`collapsed()` 有界折空白；`transcriptView.cardInfo` 同法 | `outline.renderSoon/renderInto/rowSignature/collapsed` |
| 工具卡每个输出 chunk 整块重建 body | 签名拆成 `layout`（结构）+ 内容；layout 不变只走 `patchBodyContent`：markdown 文本宿主重新 `markdownText`（旧 HTML 保留到新回填）、`pre.tool-raw` 只追加新后缀；签名指纹有界（≤64K 全哈希，超出取首尾 16K + 步长采样 + 长度），**不再返回 null 强制重建**（图片卡也能命中缓存）。markdown 缓存 key 仍用精确的 `fingerprintText` | `toolCallView.bodySignature/signatureText/patchBodyContent/update`；节点属性 `data-body-sig` / `data-body-layout`、文本宿主 `data-tool-item` / `data-text-sig` |
| 追尾 MutationObserver 回调里量布局 | 回调只记变化点与新增节点；展开祖先链、`isVertScrollable`、新增子树 `querySelectorAll` 全挪到 `flushTails`（帧内读阶段），且只处理 `isLiveCard` 的卡片（与原先 flush 的过滤一致） | `scroll.collectTailCandidates/liveCardOf/flushTails` |

**未做**：用户气泡里的图片 dataUri 仍随每次 boot/focus 快照下发（改传输通道风险大）；`toolUpdate` 仍带整份
`ToolCallView`（只做了合帧与客户端增量应用）。回归：`Outbox.spec.ts`、`MarkdownStream.spec.ts`（增量帧/generation/
引用定义/`streamSourceOf`）、`nesting/ClaudeCodeNesting.spec.ts`；宿主 `chat-panel.test.ts` 的长度式流式请求与 `appendText` 用例。

## 原生正文渲染窗口（2026-11-02）

`transcriptView.syncNodeMetadata` 统一首次放置与 plan/content/tool 重建的记录 id、类型、流式状态与图标；
为 assistant/thought/tool 标记 `data-render-window`。`patch` 对当前节点更新流式状态。
`styles.ts` 的 `@supports(content-visibility:auto)` 只对非流式的 `.bubble-body/.thought-body/.tool-body`
启用 `content-visibility:auto` 与 `contain-intrinsic-size:auto 80px`，`:focus-within` 强制正文可见。
用户记录、权限表单、subagent 以及流式正文不进入窗口。不支持该 CSS 的宿主自然回退常规渲染。

**不是 DOM 卸载式虚拟列表**：节点、折叠状态、大纲锚点、选区和双 surface 状态仍保留，
只让浏览器跳过离屏正文布局/绘制；不承诺减少 DOM 数量。不要把 containment 加到整条记录：
rail 每次量图标几何，会强迫整行离屏布局，抵消渲染窗口收益。空壳工具重建仍保留渲染窗口与记录锚点，
plan/content 重建同样保留锚点。滚动记忆与 markdown 回填后的 reassert 仍沿用 §5.10。

## 会话切换的可见记录锚点（2026-11-02）

`scroll.remember` 在非贴底状态通过 `elementsFromPoint` 获取可见记录 id 与相对视口偏移，
不扫描/测量全部离屏正文；仍保存旧版 `top/pinned`，锚点丢失或旧状态没有锚点时兼容回退。
`restore/reassert` 按当前节点位置还原同一条记录与偏移，而不是强行还原绝对 scrollTop。
因为 `contain-intrinsic-size:auto` 的实测尺寸属于 DOM 实例，hydrate 后会丢失，原先只存
scrollTop 会在长会话切回时漂到其它记录。恢复阶段最多六帧校准；原生
`contentvisibilityautostatechange` 按帧合并再校准，避免正文逐步进入视口时漂移。
新会话恢复用 epoch 取消旧帧；大纲跳转/贴底/Tail 与真实用户滚动均能接管，布局引起的 scroll 不取消恢复。
实测 Chromium 151 与兼容性探针 Chrome 110：1000 条记录，窄屏连续三次切换后同一记录偏移不变。

## 回归入口与验收边界

- `MarkdownStream.spec.ts`：逐字符对照完整渲染（列表、围栏、表格、引用、HTML、CRLF 等，按增量帧在接收端拼接），长稳定前缀仅 lex 短尾块，只发新块、generation 失配回全量，替换/引用定义回退与 LRU 释放。
- `chat-client.test.ts`：可见锚点恢复、原生尺寸变化、用户接管/新会话取消与丢失回退；稳定 DOM/清洗次数、旧前缀 raw extra、会话/源校验、晚到回复与定稿等待、最终稳定 DOM 保留、权限表单排除。
- `chat-panel.test.ts`：宿主接受旧前缀且不存临时 HTML、替换源拒收。
- 真实 Chromium 长记录预览覆盖离屏正文跳过、锚点跳转、追加流稳定块与选区；该预览使用桥接替身，**不代替真实 agent 账号或远程 CI 验收**。
