# Chat 面板子系统 · 代码链路图谱（`src/ui/chat/`）（续 2）

> 接上篇：[chat-panel-1b.md](chat-panel-1b.md)

### 5.10 长会话性能（已拆出）

见 [`chat-performance.md`](./chat-performance.md)：outbox/增量文本/rAF/滚动记忆与 INV-A..F、流式 Markdown 稳定块/尾块、原生正文渲染窗口及回归入口。

### 5.11 左侧引导条（CUSTOM-20260924-023）

**职责与 5.9 不同**：抽屉（§5.9）管「跨轮次回看某句话」，引导条管「这一轮干到哪一步了」。
形态照 Claude Code 官方扩展：轮次大实心点 + 步骤小空心点 + 一条竖线，可点跳转、当前项高亮。

| 关注点 | 规则 |
|---|---|
| DOM 位置 | `#rail`/`#railTrack` 与 `#messages` 同属 **`.messages-column`**（`#messages` 之外）。**不要**放进 `#messages`：那里的三档间距阶梯（`.messages > * + *` 的 `margin-top`）会位移它，它也会被当成一个"条目"参与 flex 排版。**132 起它是该列的绝对定位子元素**（原为 `.message-area` 的兄弟节点）：横向位置全靠 CSS 的 `.rail{left:0}`、JS 只测纵向，所以**锚在哪一层就贴哪条左缘**。137 撤销了消息列的限宽（列恢复满宽，与改动前逐像素一致），搬迁仍然保留 —— 列才是消息内容的定位容器，将来若再限宽也不必重做（见 §5.31）。**别挪回去** |
| 随内容滚动 | track 做 `translateY(-scrollTop)`（同一个 rAF tick 里，且值未变则不写） |
| 布局读取分档 | **`invalidate()`**（条目集合/状态变化）先比标记签名，签名没动就**不读布局**——流式 chunk 走的就是这条；**`reflow()`**（布局变化、resize）只测量不重建。500 个标记全量测 `offsetTop` 是毫秒级的，分档就是为了避开它 |
| **布局变化后重对齐（070）** | **不枚举触发事件，而是观察布局本身**：一个 `ResizeObserver` 观察**每条记录节点**（`watch()`，由 `transcriptView` 在"节点进 `#messages`"与"节点被替换"的**全部 6 处**调用——漏一处 = 那条记录的圆点从此不再动，且完全静默），回调 → `reflow()`。此前只有"标记集变化 / window resize / markdown 回填"三个时机，`<details>` 展开、工具卡正文展开（`links.toggleBody` 改的是 `hidden` 属性，**没有任何事件**）、图片加载完都不在其中 ⇒ 展开后圆点停在旧高度。**回调跳过 `streaming` 的记录**：流式条目每个 chunk 都在长，测量它们会毁掉上面那条"流式期间零布局读取"（streaming 条目的首行不可能移动，圆点本来就对）。**只观察记录节点**，观察 rail/track 自己就是观察自己的输出（回环）。不做 `toggle` 兜底——它只覆盖 `<details>`，是"半个修复且没有信号"（完整教训见 `pitfalls.md` #27）。`reset()` 要 `resetNodes()`：ResizeObserver **强引用**被观察元素 |
| 隐藏面板 | `measure()` 在 `#messages` 高度为 0 时**直接返回并保留 `needMeasure`**：否则每个点都被钉到 `top: 0`、而且这个错误位置会被当成真相缓存下来（后台编辑器组、还没 reveal 的 webview 都会碰上）。恢复可见时 ResizeObserver 会重新报尺寸，测量自然发生 |
| 点尺寸 | 尺寸与左偏移在 CSS（`.rail-dot.turn/.step`），用 `margin-top: -半高` 抵消，**所以 JS 写的 `top` 是圆心**（读 JS 时别以为它是顶边——这一条曾经让"对齐"修错方向） |
| **圆心怎么定（061）** | **锚到条目里的类型图标**：`node.querySelector('.rec-icon, .tool-icon')`，它的几何中心就是要对的中心（`icons.attach()` 本来就把它放在首行上）——**按构造对齐，没有常量、不按类型分支**。此前的 `top = y + 6` 是量出来的常量，而工具卡（3px 内边距）与用户气泡（6px）的首行中心不在一处，**统一偏上 6–9px**。`points[]` 里 `y`（条目顶边，供 `syncActive` 二分）与 `centre`（圆心）**必须分开**；`rail-line` 的两端用 `centre` |
| 命中区（062） | `.rail-dot::after { inset: -5px }` 把可点范围扩到约 17px（`step` 只有 7px），**外观不变**、不参与布局 |
| **当前项指示（062）** | **刻意不用环**：环在这个面板里已经是**键盘焦点**的语义（047 的全局 `:focus-visible`），再用 `--vscode-focusBorder` 画环就是"一个颜色两种意思"。改用**尺寸**：`.rail-dot.active { transform: scale(1.4) }`（scale 以中心为基准，所以不影响上面的圆心对齐） |
| 状态着色 | `running`（工具 `in_progress`/`pending`、文本 `streaming`、待决权限卡）蓝 / `failed` 红 / 其余灰 |
| 工具状态来源 | `transcriptView.updateTool` 会把新 view model 存回 `objects[]`——**`status` 不在 `PATCH_KEYS` 里**，不存回工具跑完了点还是蓝的 |
| 点击穿透 | `.rail` 整体 `pointer-events: none`（别挡住左侧文字选区），只有 `.rail-dot` 是 `auto` |
| `hidden` | `.rail` **不能写 `display`**（pitfall #13，靠文件顶部的 `[hidden]{display:none!important}` 兜底） |

### 5.12 面板审计与阶段 1 修复（已拆出）

历史结论与风险见 [`chat-panel-audit.md`](./chat-panel-audit.md)；编号不变，结论需以当前源码核验。

### 5.57 Agent map（2026-11-09）

底栏徽标 `N Agents` 打开**焦点会话**的子 agent 树。数据来自三条通道：`subagent_update`
（身份/状态/能力）、子会话自己的 `usage_update`（上下文/成本/模型）与 `tool_call(_update)`
（最后工具）。后两者**只喂注册表，不并回父会话转录** —— §5.6 的过滤规则一处未改。

| 关注点 | 规则 |
|---|---|
| 注册表 | `agentmap/AgentMapStore.ts` 纯逻辑（禁 import vscode）：按根会话分桶、键是子会话 id；`upsert` 局部合并，`noteUsage` / `noteTool` 补用量与最后工具，`snapshot` 按 `parentId` 嵌套，`signature` 做变更检测 |
| 状态映射 | RFD `state.state` 原样取 running / requires_action / idle / unknown；`idle` + `stopReason:'error'`（或 `error.message`）→ failed，`idle` + `'cancelled'` → cancelled。running 计数只算 running / requires_action |
| 层级 | 节点 `parentId` 是**别名之前**的 ACP 外层 sessionId：孙 agent 挂在子会话下。`subagentParents` 仍只负责把记录别名回根，两者不要合并 |
| 推送 | `agentMapSoon` 先比签名、再 200ms 合并（与 `refreshSessionsSoon` 同形）；`requestAgentMap` 按需 force 回；只发给 `surfaceFocused` 等于该会话的面。**绝不 per chunk 发** |
| 停止 | `stopAgent` 先查注册表 `canCancel` 且仍在跑，再调 `SessionManager.cancelSubagent(根会话, 子会话)` |
| 时间 | 只用 `_meta["vac/agentMap"]` 的 epoch 毫秒；缺就不发明（UI 显示 "—"）。running 的 elapsed 由客户端每 1s 从 `startedAt` 重算 |
| 客户端 | `html/client/agentMap.ts`：徽标 + 面板；关闭时不渲染、不读布局；Escape / 点外面 / 再点徽标关闭；详情与 Stop 全部 `textContent`（无 innerHTML）。徽标是 `#configPickers` 里的非 `.picker` 子节点，`composer.renderPickers` 重建选择器时保留它并插回 **model picker 右侧**（2026-11-10） |

### 5.58 右侧栏的 Details 模式（2026-11-09）

右栏 `#outlineSidebar` 有两种内容模式：Outline（既有 Messages/Cards 大纲）与 Details（单张工具卡的完整副本）。头部是 `[Outline][Details]` 分段控件，✕ 仍是关栏。

| 关注点 | 规则 |
|---|---|
| 入口 | 工具卡头的 `.tool-open-detail`（真 `<button>`，在 `.tool-head-row` 里与 `.tool-head` 并列——head 本身是 button，嵌套按钮非法）+ 右键记录的 "Open in details"；两者都调 `NS.detailPane.open(entryId)`。Phase 1 只支持 tool 记录且必须已有视图模型 |
| 渲染 | **再渲染一份**，不搬 DOM。`detailPane.ts` 用 `NS.toolCallView.render(tool, entryId, { slotPrefix: 'detail:' })`；`toolUpdate` → `detailPane.onEntryUpdated` 用同一视图模型 `update()`。内联卡不折叠、不搬正文；详情副本首次渲染展开自己的 body（独立的展开/滚动状态） |
| markdown 双宿主 | `toolCallView.mdPending[key]` 的宿主是**数组**；key 只由文本 + Read 上下文决定（不再含 slot），同一段文本只发一次请求，回填应用到所有仍连接的宿主。`mdActive` 仍按 slot 记，某个 slot 换文本只摘掉它自己的宿主 |
| 会话记忆 | 按会话记 `entryId`（客户端 `vscode.setState`）。焦点切换 / hydrate 后该条仍在就恢复详情，否则空态；transcript reset、会话关闭或条目消失时清空。Esc 只在 Details 模式且无 popover/抽屉/输入焦点/IME 合成时生效：回到 Outline 并聚焦记录区 |
| 宽度 | 大纲宽度仍归宿主 `uiPrefs`；详情宽度客户端本地持久化（`detailPaneWidth`），首次进入默认 `max(大纲宽度, 420px)`。`outline.ts` 用 width-owner 区分，拖动只写当前所有者；`setPane` / `openRail` / `getWidth` / `setDetailWidth` 是详情控制器用的最小 API |
| 样式 | 卡片全局类照常生效；详情容器补父卡缩进的等价规则，并取消卡内限高（右栏只留一条纵向滚动）。窄至 320px 不产生横向溢出 |

### 5.13–5.15 已拆出：会话目录与重开路径

> **§5.13（replay 怎么测）、§5.14（每会话工作目录）、§5.15（草稿页与目录选择）、
> §5.24（历史选择器的目录过滤）**
> 已移到 **[`chat-panel-sessions.md`](./chat-panel-sessions.md)**（CUSTOM-20260925-060、079）。
>
> **为什么是这三节一起走**：它们是同一个主题的三面——**会话生命周期**。
> 建会话时选目录（5.15）、已存在会话的目录从哪来（5.14）、重开会话那条 replay 链怎么测（5.13），
> 共享同一个前提：**cwd 是会话级属性、且由协议固定在创建时**。
>
> **§5.x 的编号原样保留**，所以各处引用只需换文件名，不必重编号（理由同 042）。
>
> 本文件保留的是**面板本体**：文件职责（§5.1）、客户端三条纪律（§5.2）、在途状态（§5.3）、
> 消息纪律（§5.4）、安全约定（§5.5）、子 agent 分组推断（§5.6）、主双面与 Side surface（§5.7）、
> 权限卡（§5.8）、会话大纲（§5.9）、长会话性能与 INV-A..F（§5.10）、引导条（§5.11）、
> 面板审计结论表入口（§5.12）；性能细节与审计正文见顶部对应分册。

> **记录区（§5.16 起）另见 [`chat-panel-records.md`](./chat-panel-records.md)**：折叠与 INV-J、
> 每条记录的时间显示、工具输出的 markdown 渲染、思考块的 markdown（§5.21）、切换模型/模式的提示（§5.22）、
> 自定义右键菜单、置顶本轮提问（§5.25）、文件引用的三种呈现（§5.47）、以及客户端逻辑测试的边界。
>
> **输入侧（§5.27、§5.31 起）另见 [`chat-panel-input.md`](./chat-panel-input.md)**：表单与权限抽屉、
> 悬浮输入卡与底部栏、草稿页、回车语义、停止的二次确认、轮次中补发消息（steering）。
>
> **会话状态与诊断（§5.28、§5.34、§5.37 起）另见 [`chat-panel-state.md`](./chat-panel-state.md)**：
> 连接状态卡与自动连接、会话状态通知、后台子任务、按会话状态的收尾、构建指纹与日志桥、
> 几何变化后的重算、空态地址栏与 Times 的按会话记忆、回填分帧与长任务看门狗。
>
> **编号不连续是正常的**：章节号是**稳定的引用地址**，不是阅读顺序——`§5.24` 在 sessions、
> `§5.16–§5.23` 在 records、`§5.32` 在 input、`§5.39` 在 state，等等。按上面那张导航表找。