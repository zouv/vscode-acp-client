# Chat 面板历史审计 · 代码链路分册

> 从 [`chat-panel.md`](./chat-panel.md) 拆出；§5.12 编号保持不变。历史风险需按当前源码核验。

### 5.12 面板审计与阶段 1 修复（CUSTOM-20260925-038..041）

对整套面板（侧边栏 + 编辑区）做过一次系统审计，四面（逻辑 / 性能 / 交互 / 无障碍）都有实质发现。
**038-041 只落地了「正确性」这一档**，性能与交互档的做法见下方"待办"，别当成已经安全。

**四条已落地的规则（改动时不要破坏）**

1. **`EntryPatch` 的键名 = 记录字段名，逐字相同**（`entries` / `blocks`，见 `transcript/types.ts`）。
   曾经的 `plan` / `content` 与记录层的 `entries` / `blocks` 错位，客户端 `PATCH_KEYS` 抄了协议层的
   名字 ⇒ patch 写进 `entry.plan`、渲染读 `entry.entries`，**更新静默丢弃**（`patch()` 对未知键不报错）。
   表现是 plan 卡永远停在第一次快照、切走再切回才对。**编译器看不见这类错位**（pitfall #18）。
2. **`resource_link` 的点击通道在宿主侧决定**：`contentBlocks.localPathOf(uri)` 判本地文件 → 填 `path`
   → 客户端写 `data-path`（走 `openFile`，相对路径按会话 cwd 解析）；http/https/mailto → `data-href`；
   `fileLinkTarget` 同时从 `#L12-L30` 解析出 `line` / `endLine`，客户端再写 `data-line` / `data-end-line`。
   **两者都不是 → 静态 chip**（不得长成可点的样子，否则点一次吃一个 `Blocked link` 警告）。
   注意 Windows 盘符（`C:\x`）符合 URI scheme 语法，**必须先于 scheme 判定**。
   **同一个解析器用于 markdown 正文链接**（184）：`markdown.ts` 的 `link()` 调
   `contentBlocks.fileLinkTarget`（先剥行号后缀 `path:12` / `path#L12` / `path#L12-L30`，再 `localPathOf`），
   命中就写 `data-path` + `data-line` + `data-end-line`。此前它只放行 http/https/mailto，
   agent 写的 `[GOAL.md:74](GOAL.md:74)` 全被渲染成带删除线的 `link-blocked` 灰字 —— 看着能点、点了没反应。
   **剥行号必须早于 scheme 判定**：`GOAL.md:74` 里 `GOAL.md` 本身就是合法 scheme 语法。
3. **工具卡的 body 只有一个构建入口 `fillToolBody(body, tool)`**，`render()` 与 `update()` 共用。
   两条路径各写一遍是「locations 时有时无」与「展开的 diff 被下一次更新合上」的共同根因
   （pitfall #15 的第二次复发）。重建前 `captureExpansion` / 重建后 `applyExpansion`，按
   `data-expand-key` 搬运展开态。`bodySignature` 命中则连重建都跳过；签名**刻意不序列化 payload**，
   遇 image block 返回 `null`（不可缓存 → 无条件重建），宁可多建一次也不冒陈旧渲染的风险。
4. **`ChatPanelHost.dispose()` 必须注销 `SessionUpdateHandler` 监听器**。
   此前只是碰巧被 `SessionUpdateHandler.dispose()` 兜住。
   `Outbox.stats()` 是**单轮**语义（`finalizeTurn` 打印后 `resetStats()`）——累计会让 `merged/sent`
   漂向长期均值，那行诊断就失去意义。

**两条不变式（破了不会有自动检查报错）**

- **INV-G 替换型 patch 的键名不得改名。** 改 `EntryPatch` 或 `PATCH_KEYS` 任一侧，必须 `grep` 出全部
  消费点对照：`transcript/types.ts` ↔ `TranscriptStore.patch` ↔ `ChatPanelHost` 的调用点 ↔
  客户端 `PATCH_KEYS`。**四处**，少一处就是静默失效。
- **INV-H 工具卡 body 的字段覆盖要跟着渲染函数走。** `bodySignature` 必须涵盖渲染函数读的**每一个**
  字段；漏一个 ⇒ 该字段变化时签名不变 ⇒ **卡片永久陈旧**。加字段到 `renderContentItem` 时，
  同步加进签名（image 例外：它返回 `null` 走无条件重建）。

**审计查到的其余问题（阶段 1 时"查到但未修"；阶段 2-4 的 043-052 已全部落地，见下）**

| 档 | 问题 | 位置 |
|---|---|---|
| 性能 | **嵌套推断在每次 `tool_call_update` 全量重算**，且每个候选 `JSON.stringify` 父输出（上限 200KB） | `ChatPanelHost.onSessionUpdate` 的 `tool_call_update` 分支 + `ClaudeCodeNesting.payloadContains` |
| 性能 | `toolCallView.update` 末尾**同步**跑 `refreshGrouping` 的 `querySelectorAll`，绕过 022 的 rAF 合帧 | 对照 `transcriptView.refreshGroupingSoon` |
| 性能 | `outline.invalidate()` 每个 append/revise 至少走一遍全量锚点扫描（rail 已用签名降到 O(1)，抽屉没做） | `html/client/outline.ts` |
| 性能 | **TEMP 诊断常驻**：每次新增条目后 4 秒全量 `getBoundingClientRect` 走查（白条根因已在 037 修掉） | `html/client/transcriptView.ts` 的 `checkTextless` 整块 |
| 交互 | **键盘完全不可达**：标签 / 抽屉行 / 菜单项 / 斜杠项 / chip / 卡头都是 div+click，无 `tabindex` | 各 client 模块 |
| 交互 | 无 `aria-selected`（标签已有 `role=tab`）、无 `aria-live`（流式不播报）；`composer.focusInput()` 写了从未被调用 | `tabs.ts` / `body.ts` / `composer.ts` |
| 交互 | **webview 内零拖拽/粘贴处理**，附件只能走命令与资源管理器右键 | 全量 grep 为空 |
| 界面 | `SafeMarkdown.code` 已输出 `data-lang`，界面完全没用（无语言标签） | `markdown.ts` 产出，无消费 |
| 界面 | 编辑区面仍用 `--vscode-sideBar-background`（`body` / `.composer` / `.load-overlay`），与周围编辑器底色不一致 | `styles.ts` |
| 登记 | ~~`.tab-dot.attention` 是从未被任何 JS 使用的死 CSS~~ —— **2026-10-29 起已由 unread 状态使用**（`tabs.ts` 的 `dotClass` 加 `attention`），不再是死代码 | `styles.ts` / `tabs.ts` |
| 登记 | 无 sessionId 的 `error` notice 只进当前 DOM、不进 store，切走再切回消失（**注释已声明是刻意的**） | `boot.ts` 的 `error` 分支 |

**阶段 2-4 的落地结果（CUSTOM-20260925-043..052）**

| # | 做了什么 | 关键约束（改动时别破） |
|---|---|---|
| 043 | 嵌套推断去重复序列化；`ToolInvocationStore.list()` 去掉无谓排序 | 两个缓存都**按对象引用**失效（`upsert*` 整体替换字段，引用变化即失效信号）。**不要给工具索引加独立 LRU 上限**；2026-11-01 起 TranscriptStore.onRemove 会回收无剩余可见引用的工具和 toolEntryIds（重复引用保留）——`snapshotOf` 靠它补水视图模型，淘汰会渲染出 027 消灭掉的空壳卡（理由写在类注释里） |
| 044 | 工具路径并入 rAF 合帧；`bodySignature` 用**哈希**而非长度 | **INV-H 加强**：长度不是变化信号（同长度改写会永久陈旧）。指纹化不可便宜完成时返回 `null` → 无条件重建，语义永不退化。**2026-11-08 改**：签名指纹改为有界形式（`signatureText`，>64K 取首尾 + 采样 + 长度，不再返回 null），并拆成 layout/内容两部分，内容变化走 `patchBodyContent` 就地补（见 `arch/chat-performance.md`） |
| 045 | 抽屉"要不要显示 ☰"降到 O(1) | `place()` 是唯一的新增入口（`patch` 从不改 `kind`），计数器才不会漂 |
| 046 | 删掉 TEMP 诊断（约 98 行） | 白条根因在 037 的 `.messages > * { flex: 0 0 auto }`。**复发时先量高度**（036 的教训），需要时再按显式开关装轻量版，别让它常驻 |
| 047 | 键盘可达性：真 `<button>` + `:focus-visible` + roving tabindex | 委托式 click 覆盖了键盘（**Enter/Space 由浏览器原生触发 click**）——所以**不要再补一套 keydown 分支**，两套会漂。按钮样式重置块**必须放在各 class 规则之前** |
| 048 | `aria-busy` 驱动流式播报 | 计数器由 `place()` / `patch()` 的 `wasStreaming` 对比维护；`lastBusy` 守卫避免每片写 DOM |
| 049 | 附件拖拽（`attachPath`）；粘贴图片明确提示暂不支持 | 消息**会话作用域**，在守卫**之后**处理。拖拽路径**不 reveal surface**（拖拽本就在可见面上）。取不到路径必须报出来 |
| 050 | 草稿按会话记忆；编辑区面用编辑器底色；`prefers-reduced-motion` | `stashDraft()` **必须在 `state.sessionId` 改写之前**调用。CSS 里**只有** `.surface-editor` 的覆盖规则——侧边栏面不能加 |
| 051 | 代码块语言标签 | 标签在左上角（右上角归 Copy），`pointer-events: none`；只有带语言的块才让出顶部内边距。**不引入高亮器**（要改 CSP） |
| 052 | 清死代码；两处"刻意保留"写明理由 | `dom.esc` **删除处写了"不要补回来"**——通用转义助手是"用字符串拼 HTML"的邀请函。`statusGlyph` 组保留但必须带"为什么在这"的注释；`.tab-dot.attention` 后来已由 unread 状态接上 |

**仍刻意不改的（登记在案，别当 bug 修）**

- ~~`.tab-dot.attention`（死 CSS，设计预留）~~（2026-10-29 起由 unread 使用，不再是死 CSS）与
  无 sessionId 的 `error` notice（只进当前 DOM、不进 store）
  ——后者在代码注释与 `pitfalls.md` #20 里写明了理由。
- `sanitize()` 放行整个 `data-*` 家族，而点击委托信任其中几个属性 —— 当前不可利用
  （`SafeMarkdown.html()` 把原始 HTML 转义成文本，无注入路径），但作为"将来 marked 新增钩子"的
  兜底时形同虚设。见 `pitfalls.md` #21。
- `'Claude Code'` 字面量剩 2 处（语义各不相同）——见 `pitfalls.md` #19 的处置原则：
  跨宿主/客户端或跨语义的重复，要么注释互指，要么让一侧成为唯一真源（走协议下发）。

**其他值得知道的风险**

- `'Claude Code'` 这个字面量还剩 **2 个语义不同的地方**：`agents/AgentProfile.ts` 的 `label`（配置默认名）、
  `stateCard.ts` 的空态文案（客户端硬编码，123 从 `sessionMenu.ts`/`boot.ts` 收拢到这里）。
  转录目录（`diskSessions`）与嵌套策略（`NestingStrategy`）2026-10-25 起都改为按 **kind**（`AgentProfile.transcriptStore` / `nesting`）——
  此前它们按名字判断，用户在 `vac.agents` 里改个名就悄悄失效。排序（`AgentConfig.getAgentNames`）一直按 kind。
- `sanitize()` 的 `ATTR_ALLOWLIST` **放行全部 `data-*`**，而点击委托偏偏信任 `data-href` / `data-path` /
  `data-terminal`——这层兜底实际没约束住它最该约束的几个属性。当前不可利用（`SafeMarkdown.html()`
  把原始 HTML 转义成文本，没有注入路径），但将来若 marked 新增没人覆盖的钩子，这层就形同虚设。



| **收缩控件 = 原生 details（171）** | 卡片里的折叠三角是唯一控件，点它**走原生**：不 `preventDefault`，浏览器开合克隆体自己的 `<details>`（与界面里的折叠**字面同逻辑** —— 字形、收成一行、图片/文件与文字同行全部复用），`toggle` 事件把状态按会话记进 `collapsedBySession`。166/167 自造的 `.collapsed` 类与其 CSS 已整体删除（169 的权重坑就是自造一套的代价）。左侧通道的小方块按钮 169 已按用户要求删除 |
| **收缩状态按会话（166）** | 用户报"切一次 tab 就弹回展开"。`collapsed` 原先是个模块级布尔：会串会话、切回来又丢。现在 `collapsedBySession[sessionId]`，会话 id 由 boot 在 `applyFocus` 的咽喉点同步进来（`setSession`，与 `elicitationView.setSession` 同一形态）。**同类问题见 §5.38 的清单**，本轮还顺手修了表单抽屉的同一处（换一张表单要从展开态开始） |
