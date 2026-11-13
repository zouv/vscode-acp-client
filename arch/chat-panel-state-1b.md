（续 1b）

> 接上篇：[chat-panel-state.md](chat-panel-state.md)

### 5.52 设置面板与「新输出自动展开」（2026-10-21）

**为什么有它**：面板里散落的开关（自动连接、Times、大纲、协议日志）各自藏在不同控件/VS Code Settings 里，
用户要求一个集中的设置入口；同时新增「新输出自动展开」，它的卡片类型需要一个可勾选的地方。

**结构**：`body.ts` 的 `#settingsOverlay > #settingsPanel`（遮罩 + 居中面板），左侧 `#settingsNav`
（role=tablist）右侧 `#settingsBody`；`settingsPanel.ts` 只渲染，宿主是唯一写者。
Tab 栏：`#settingsBtn` 用 `margin-left: auto` 固定在条带最右；`#newTab` 紧跟在最后一个 tab 右侧
（`.tabs` 先按内容宽，tab 多到放不下才自己横向滚动）。

| 关注点 | 规则 |
|---|---|
| 数据与写入 | `ChatPanelHost.settingsItems()` 生成 `SettingItem[]`；`handleSetSetting(key,value)` 按 key 决定写 **VS Code 配置**（`vac.autoConnectOnOpen` / `restoreSessionsOnOpen` / `defaultWorkingDirectory` / `autoAddWorkspaceFolders` / `autoApprovePermissions` / `logTraffic` / `customModels` / `agents`）还是 **面板 UiPrefs**（`panel.autoExpandDefault` / `panel.autoExpandKinds.*` / `panel.autoExpand.toolHeight` / `panel.autoExpand.thoughtHeight` / `panel.flatTools` / `panel.sendKey` / `panel.composerMaxWidth` / `panel.inputMaxHeight` / `panel.defaultModel.<agent>` / `panel.defaultEffort.<agent>` / `panel.recentDirectoryLimit` / `panel.markdownStyle` / `panel.timesDefault` / `panel.outlineMode` / `panel.outlineWidth`）；`handleSettingAction` 处理 `pickDefaultWorkingDirectory`（系统 `showOpenDialog`）/ `openAgentCache` / `clearAgentCache`（`rmSync`，Linux/Windows 上运行中的模块可能被锁）/ `resetPanelPrefs` / `openLog` / `copyBuildInfo`。写完**重发整张表**，被夹紧的值（宽度 160–480、展开高度 0 或 80–2000、输入卡 360–1200 / 80–800）会回显真实值。 |
| 默认模型 / 默认推理强度 | `UiPrefs.defaultModelByAgent` / `defaultEffortByAgent`（agent → 值）。`session-created('new')` 时 `applyRememberedModel` 与记住的模式并行应用，按会话挂在 `modelApply` 上；`applyRememberedEffort` 排在模型之后（模型切换可能级联出新的 effort 候选），挂在 `effortApply` 上。草稿页的显式选择先 `await` 这三者再落地（后到的赢）。打开历史会话不套用。`defaultAgentItems` 对每个 agent 各给两行：有候选就渲染下拉（来自 `draftOptions` 快照），没候选退化成文本输入。推理强度按 ACP 的 `category === 'thought_level'` 识别（Claude 的 Effort、Codex 的 reasoning_effort 同一类目），应用前逐项校验。 |
| Recently used 目录条数 | `UiPrefs.recentDirectoryLimit`（0–30，默认 8；**0 = 不显示「Recently used」分组**，设置面板清空输入框回落 8）。`ChatPanelHost.recentLimit()` 是唯一读取口，`recentDirectories()` 按它截断（0 时直接返回，不问 agent）；`setUiPref` 合并、`settingsItems()` 回显与 `handleSetSetting` 写入都经 `ChatPanelHost.clampRecentDirectories` 夹紧。改动在下一次打开目录抽屉时生效（`directoryChoices` 是即时计算的）。 |
| 历史显示上限 | `UiPrefs.historyDisplayLimit`（0–10000，0=不限）由 `ChatPanelHost.clampHistoryDisplayLimit` 夹紧，Main/Side 共享；`boot` → `sessionMenu.applyPrefs` 在抽屉非加载态即时刷新；`visibleRows` 先目录/搜索过滤，`limitRows` 再截显示，保留已加载数据与正确计数。 |
| Markdown 渲染预设 | `UiPrefs.markdownStyle`（`editor` / `github` / `obsidian` / `typora` / `atom` / `minimal` / `things`，默认 `editor`）。宿主 `resolveMarkdownStyle` 是白名单（旧值 `compact` / `reading` 回落 `editor`）；该全局字段变化时 `uiPrefs` 分别投影到 Main 双面与 Side，`boot.applyMarkdownStyle` 只写 `body[data-md-style]`，具体排版与配色在 `styles.ts` 里按属性选择器覆盖：每套预设各定义一组 `--vac-md-*` 变量（`vscode-light` / `vscode-dark` 下取硬值，其余主题回落 token），规则统一作用于 `.md`。`editor` 不写任何覆盖 = 原有跟随主题的行为。 |
| 发送快捷键 / 输入卡尺寸 | `UiPrefs.sendKey` 由 `composer.applyUiPrefs` 消费（`onKeyDown` 决定 Enter 是否发送；另一种组合留给 textarea 换行）；`composerMaxWidth` / `inputMaxHeight` 写 body 的 `--vac-composer-max` / `--vac-input-max-h`。`flatTools` 同时由标题栏的 Sub-agents 按钮写（两个写者都落到同一份 UiPrefs）。 |
| 面板尺寸 | **固定**：`height: clamp(320px, 80vh, 640px)` + `max-height: calc(100vh - 32px)`，切换分组/改值不跳动；内容在 `#settingsBody` 内滚动。窄面板（<520px）左侧导航变成顶部横排。 |
| 协议 | `getSettings` → `settings`（ExtToChat）；`setSetting` / `settingAction`（ChatToExt）。三者都在 `verifySession` 守卫**之前**处理（非会话作用域）。 |
| 双向同步 | `onDidChangeConfiguration` 里 `affectsConfiguration('vac')` → `postSettings()`；面板 scoped 偏好经 `projectUiPrefs` 定向投影（主双面同域，Side 独立），真正全局字段变化才三面同步，见 §5.55。 |
| 分组 | general / chat / appearance / shortcuts / advanced；**没有条目的分组不显示**（客户端 `groupsWithItems`）。窄面板（<520px）左侧导航自动变成顶部横排。 |
| Chat 快捷键 | `shortcuts.ts` 的 `DEFAULT_SHORTCUTS` / `canonicalizeShortcut` / `normalizeShortcutMap` / `applyShortcutSetting` 是宿主规则；`ChatPanelHost.handleShortcutSetting` 逐项写入并拒绝重复，`UiPrefs.shortcuts` 是共享字段，经 `projectUiPrefs` / `postUiPrefs` 投影三面。客户端 `settingsPanel.ts` 的 `renderShortcutControl` / `onRecordingKeyDown` 负责录制、禁用、重置及冲突提示；`client/shortcuts.ts` 的 `fromEvent` / `onKeyDown` 只消费本 webview 按键（IME/AltGr/死键与浮层优先、匹配后停止冒泡给宿主），`tabs.activateRelative` 按显示顺序切换并给懒恢复加单飞闸门；宿主按 `trackRestore` 向发起面回 `restoreFinished` 成败，`boot` → `tabs.finishRestore` 解除闸门。`scroll.jumpToTop` / `jumpToLatest` 复用 Tail 与滚动状态机。键位用物理 code，跨布局和系统快捷键可能冲突。**2026-11-08**：新增 `closeSession`（默认 `Alt+KeyW`，`tabs.closeActive` → 既有 `closeModel`，草稿丢弃 / 待恢复遗忘 / 运行中确认全部继承）；**2026-11-09**：新增 `restoreClosed`（默认 `Alt+KeyT`，客户端只发面板级 `restoreLastClosed`；宿主 `recentlyClosed` 栈在 `closeSession` **关闭之前**从活会话取描述符（side chat 不入栈、同 id 去重、上限 20），还原走 `handleOpenHistorySession(..., keepOthers)` 并写回 `additionalDirectories`，空栈时回一条 error）；`fromEvent` 在字母 code 上比较 `event.key` 与物理字母，若不一致（macOS Option 产出 å / π 等真实字符）就不匹配，避免默认 Alt 快捷键吞掉输入 |
| tab 条横向滚轮（2026-11-08） | `tabs.installWheel`（挂在 `#tabStrip`）：纯纵向 `wheel` 转成内层 `#tabs.scrollLeft`，`deltaMode` 按行 16px / 页 clientWidth 归一；横向触控板手势（`deltaX`）、Shift/Ctrl/Meta 组合、无溢出或已到边界都**不 preventDefault**（与 `scroll.ts` 的滚轮门控同一取舍）。#tabStrip 自己仍是 `overflow: hidden`（+ / 设置按钮固定右侧），真正的滚动容器是 `.tabs` |
| 自动展开的范围 | 有效值 = `autoExpandBySession[sessionId] ?? autoExpandDefault`（与 Times 同一条"按会话 + 默认值"模型）。卡片类型是**全局** `autoExpandKinds`（`tool` / `thought` / `diff`），默认 `thought + tool`；写过空数组才是"全不展开"（类型在 Chat 分组）。**展开后的限高**在 Appearance 分组：`autoExpandToolHeight`（默认 360）/ `autoExpandThoughtHeight`（默认 240），0 = 不限，夹在 80–2000；只作用于自动展开时打了 `.auto-expanded` 的卡（手动点开的不受限），超出部分在卡片内部滚动。 |
| 长编辑器（子面板） | `vac.customModels`（`type:'models'`）与 `vac.agents`（`type:'json'`）在主面板只显示摘要 + `Edit…`（摘要放文字列，按钮与其它控件右缘对齐）；点击打开 `#settingsSubOverlay` 子面板。自定义模型：说明行 + 表头（Model id / Alias / Description）+ 可滚动列表，Add model 靠右紧跟列表、Done 靠右下；Agent JSON：文本框铺满剩余高度，Cancel 在左、Save 在右。模型改动即时提交（每个 input 的 change），JSON 是 Save/Cancel（Save 先本地 `JSON.parse`，非法就在子面板里报错、不发送）。Esc 先收子面板、再收主面板。 |
| 模型排序与并发 | `settingsPanel.modelRow/installModelDrag/moveModelRow/queueModelCommit` 沿 DOM 顺序采集；拖拽手柄（聚焦后按 ↑/↓ 也能排序，行内不再放上下按钮）、落点线和 live 播报共用一条提交链。`setModelList` 请求经 `ChatPanelHost.handleSetModelList` 和 `SerialTaskQueue` 按生效层+写目标+值做 CAS、写后核对，回 `SettingItem.modelSync`；冲突保留草稿供 Reload / Overwrite（重新校验），错误可 Retry / 确认 Discard。`composer.renderMenu` 用 `modelOrder.orderOption` 仅重排 agent 已有模型：内置候选保持 agent 顺序在前，自定义模型按设置顺序排在后面，分组内同样适用。进程内串行不是跨 IDE 原子锁。 |
| 自定义模型的 description | 存进 `vac.customModels` 后，`composer.menuItem` 用它作为模型菜单项的**副标题 + 悬停 tooltip**（`name` 覆盖 agent 返回的裸 id 标签）。此前只存不用。 |
| 自动展开的作用面 | **只作用于 live 路径**（`transcriptView.append` / `patch` / `updateTool`）；`hydrate`（历史回放）刻意不展开 —— 大会话整屏展开既卡又抢滚动位置。展开后 `append` 的 `scroll.follow()` 按最终高度贴底；`patch` 里推理块定稿的"自动折叠"在勾了 `thought` 时不生效。 |
| 运行中会话的关闭确认 | 宿主 `closeSessionWithConfirm`：`isSessionRunning` 为真时 `showWarningMessage(..., {modal:true}, 'Close')`；确认后仍走 `SessionManager.closeSession`（内部先 `cancelTurn` 并回答待决请求）。× / Delete / 右键 / 中键四条入口共用。 |
| 中键关闭 | `tabs.ts` 每个 tab 的 `mousedown`（button==1 → `preventDefault`，压住 WebView 的自动滚动）与 `auxclick`（button==1 → `closeModel`）。中键回调直接闭包捕获 model；`modelIndexOf` 同时识别 live、draft、restore，供 tab 方向键和 Delete 使用。 |

> 续：[chat-panel-state-2.md](chat-panel-state-2.md)
