（续 1b）

> 接上篇：[chat-panel.md](chat-panel.md)

### 5.9 会话大纲（CUSTOM-20260924-021，076 加钉住式右侧栏，077 二次优化）

**纯客户端**：不动协议、不加命令、不改 `package.json`。锚点来自 `transcriptView.ordered()`，
**不是** `Object.keys(objects)` —— 后者的顺序保证只覆盖整数样式的键，错了的表现是"跳转到不相干的消息"。
076 起锚点从「只收 `user`」扩到「`user` + `assistant`」（其它 kind 仍排除），每项带类型图标 + hover 全文。

| 关注点 | 规则 |
|---|---|
| DOM 锚 | 每个节点在 `place()` 里打 `data-entry-id`；`node(id)` / `entry(id)` 是唯一查找入口 |
| 布局读取 | **只在 rAF 回调里**（`NS.dom.schedule`）。scroll 事件只置脏位，否则每帧强制重排 |
| 高亮 | 缓存的 `[{id, top}]` 上二分；`invalidate()`（transcript 变更）后重建；重建只在抽屉打开时做 |
| 跳转 | `scroll.jumpTo(node)` 先置 `pinned = false` 再写 `scrollTop`，随后 scroll 事件按真实距离重算 |
| Escape | **捕获阶段**监听 + `stopPropagation`：composer 在 textarea 上监听 Escape 取消轮次，不拦会误取消 |
| 上限 | 200 条锚点，多出的折叠成一行「… N earlier hidden」 |
| **两类行的区分度（191）** | 锚点既有 `user` 也有 `assistant`，而在此之前两者**只有一小格图标**不同（076/077 只给图标带了 kind 类），文字颜色/字重/缩进完全一样 —— 整排读起来是同质列表（用户报"用户消息区分度不明显"）。现在 **kind 类挂在行上**（`outline.ts` 的 `row.className = 'outline-item kind-' + entry.kind`），按两级拉开：**用户行 = 骨架**（正常前景色 + `font-weight: 600` + 图标 `opacity: 1`）、**助手行 = 补充**（`descriptionForeground` + `font-size: .95em` + 图标 `.45`）。**刻意不用左竖条/背景色**做这个区分 —— 那两条通道已被"当前项"占用（`.outline-item.active` 的 border-left 与背景），一个颜色两种意思是 047 的教训。另一条分工：**kind 决定字重/字号/图标浓淡，只有"颜色"让位给选中态**（写成整条 `:not(.active)` 会让选中一个用户行时字重从 600 掉回 400 —— 选中一个东西不该改变它是什么）。**缩进那一档试过又撤了**：助手行 `padding-left` 读起来像子项，但侧栏默认只有 240px，缩进直接吃掉可读宽度、长标题更早被省略号截断（实测同一行少显示一个字）；三档（颜色/字重/字号）已经够分辨 —— 别再顺手加回来 |
| **有没有东西可导航（081）** | **这条判据管所有形态**：没有锚点（无会话 / 新会话 / 全是工具记录）时，☰ 按钮、下拉浮层、**钉住的右侧栏****一律不显示**。045 当年只把它加在 ☰ 按钮上——那时下拉是唯一形态，"没有按钮就没有大纲"成立；076 让它可钉住之后，钉住的那一栏**没走这条判据**，于是空态旁边会摊着一列 "OUTLINE / No messages yet"，把空态挤出面板正中（用户截图）。判据只有一处（`outline.ts` 的 `anchorsPresent`，由 `syncButton()` 唯一写入、`renderVisibility()` 读取），**mode 只是偏好、不决定可不可见**：钉住状态留着，第一条消息一到那栏自己回来。副作用：空对话时没法点 ✕ 取消钉住（等第一条消息即可）——因为此时它本来也没有内容可导航 |
| **Messages / Cards 两个 tab** | `outline.ts` 的 `setTab` / `cardAnchors` / `noteToolUpdate` + `transcriptView.cardInfo` / `cardCount` / `reveal` | Messages 仍只收 user/assistant；Cards 遍历 `ordered()` **全部记录**（含消息），行显示类型徽标 + 工具名/标题；点击前 `reveal` 展开被父工具卡折叠的子卡。`syncButton` 的判据改为 `messageAnchorCount()>0 || cardCount()>0`，所以只有工具卡的会话也有大纲。Cards tab 打开时 `toolUpdate` 用 `NS.dom.schedule` 合并刷新（`cardsPending` 去重）；tab 选择走 `UiPrefs.outlineTab`（Main/Side scoped，缺省 messages），`applyPrefs` 的 `prefsKey` 必须包含它 |

**`invalidate()` 的调用点**在 `boot.ts` 的 `append` / `revise` / `focus` / `boot` / `sessionClosed` / `error`
分支里——**不要**放进 `meta` / `attachments`，那会让抽屉在流式期间被反复重建。

**钉住式右侧栏（CUSTOM-20260926-076，077 二次优化）**：下拉与侧栏两种形态并存，`mode ∈ {popup, sidebar}`
+ 瞬态 `isOpen`。下拉头部「固定到右侧」并进 `.outline-head`（"N messages" 同一行，`#outlinePin` 是
`.outline-head-info` 计数容器的兄弟、静态），把大纲钉成常驻右栏（`#outlineSidebar`，`#messages` 的 flex
兄弟、定宽，宽度由 JS 写 inline）。

| 关注点 | 规则 |
|---|---|
| 持久化 | `mode` / `width`（180px~50%）走**宿主 `globalState`**（077）：`setUiPref`（webview→ext）按 Main/Side scope 分别存 `vac.outlinePrefs.v1` / `vac.sideUiPrefs.v1`，`uiPrefs`（ext→webview）随目标面 boot 带回、`applyPrefs()` 恢复——跨窗口重载/编辑器面板重开存活（webview 本地 `vscode.setState` 只活在同一实例 reload）。主 view/editor 共享 Main 布局，Side 独立；Side 重载保留布局但清 per-session map，详见 `arch/chat-panel-state.md` §5.55 |
| **开/关按会话记（204）** | `mode` 是**布局**偏好（"允不允许出现侧栏"），而"这个会话里它开着吗"是**另一件事**，按会话记：`outlineOpenBySession` + `outlineOpenDefault`（与 Times 200 同一套语义：有效值 = 表里的记录 ?? 默认值；拨一次两处都写）。焦点咽喉点同步（`boot.applyFocus` → `NS.outline.setSession`，与 `stickyUser.setSession` 同形）。**两个 bug 的公共根因就在这一行**：以前关侧栏只改瞬态 `isOpen`（`mode` 仍是 sidebar），于是 ①重启后 `applyPrefs` 把它重新算成 `mode === 'sidebar'` ⇒ 自己回来；②当时 `uiPrefs` 是**广播**的（宿主在**任何** `setUiPref` 之后都回一次），客户端收到就走 `applyPrefs` ⇒ **点一下 Times（200 起它会发 setUiPref）或拖一下 tab（198）就能让刚关掉的侧栏弹回来**（用户报的两条）。现在 `isOpen` 一律由那两份持久状态推出来，**回话只是收敛、不是命令**；关（☰ / Escape / ✕）一律落盘。旧记录（没有这两项）按老行为补一次 `openDefault = true`（钉住过的人升级后侧栏不该无声消失） |
| 跳转 | 侧栏模式**不关**（常驻导航）；下拉模式维持「跳完收起」 |
| `close()` 语义 | **只关下拉**：`boot.ts` 会话切换调 `close()`，侧栏模式 no-op——否则刚恢复的侧栏会被 boot 的 close 关掉 |
| 点击外部 | 只关下拉；侧栏是常驻面板，在 transcript 里点来点去不关 |
| 调宽 | `#outlineResize` pointer 事件：`width = clamp(start - dx, 180, area*0.5)`（拖左变宽）；`pointerup` 持久化 + `NS.rail.reflow()`（`#messages` 变窄改折行 → 左 rail 圆点重对齐） |
| 图标着色 | `NS.icons.icon(kind, 'outline-kind outline-kind-<kind>')`；`.outline-kind-user` 蓝（`--vscode-button-background`）、`.outline-kind-assistant` 灰（`--vscode-descriptionForeground`），与 transcript 气泡同色系 |
| 时间 | 移到每项最右（正文 `flex:1` 占满左侧），`HH:MM:SS` |
| 计数 | `transcriptView.messageAnchorCount()`（user+assistant，O(1)）驱动 ☰ 显隐 |

> 续：[chat-panel-2.md](chat-panel-2.md)
