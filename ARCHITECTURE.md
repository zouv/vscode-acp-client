# 代码链路图谱 · vscode-acp-client

> **本文件的目的**：给 AI（及人类）一份「读这一份就能定位代码」的导航地图，
> 避免每次改动/排查都全量扫描源码，节省上下文与 token。
>
> **维护铁律**：**改了代码结构（新增函数 / 移动逻辑 / 改数据流 / 改接口），必须同步更新本文件。**
>
> **体量铁律**：本文件超过 ~400 行即拆分——保留总览 + §0.5 路由 + §1 文件职责总表，各模块 §2/§3 拆到 `arch/<module>.md`，由 §0.5 路由指向（详见 `AGENTS.md` §1.1）。

---

## 0. 一句话架构

VS Code 扩展，作为 **ACP（Agent Client Protocol）客户端**：把 agent CLI 拉成子进程，
用 `@agentclientprotocol/sdk` 走 stdio 上的 JSON-RPC，把会话渲染进 VS Code
（侧边栏 Dashboard webview + Agents 树 + Chat webview，另有编辑区 Chat 标签页）。

```
侧边栏容器 vac-client                          编辑区标签页
  ├── vac-dashboard (webview)  DashboardViewProvider        vac-chat-editor
  ├── vac-sessions  (tree)     SessionTreeProvider          ChatEditorPanel
  └── vac-chat      (webview)  ChatViewProvider ────┬───────────────┘
                                                    │ 两个 surface 共享
                                      ChatPanelHost（记录/状态/协议，唯一真源）
                                                    │ postMessage
                                                    ▼
                                          SessionManager（N 进程 × M 会话编排）
                                                    │
                    ┌───────────────────────────────┼──────────────────────────┐
                    ▼                               ▼                          ▼
             AgentConnector                 SessionHistoryStore         （事件扇出到 UI）
       spawn/握手去重/能力缓存/控制面串行      workspaceState 会话缓存
                    │
                    ▼
        ClientSideConnection（ACP SDK）→ AcpClientImpl → handlers/*
                                          fs / terminal / permission / elicitation / session update
```

技术栈 / 关键约束：npm（禁 pnpm/yarn）；**esbuild** 打包成单文件 `dist/extension.js`；
ESLint flat config（`--max-warnings 0`）；**vitest** 跑纯逻辑（`src/**/*.spec.ts`，禁 import `vscode`）、
`@vscode/test-cli` + mocha 跑真实宿主（`src/**/*.test.ts`）；全局标识符命名空间 `vac.*`。

---

## 0.5 任务作用域路由（先定范围，避免污染上下文）

> **怎么用**：动手前先在下表找到你的任务类型，**只读「该读」列的文件/小节，明确不碰「忽略」列**。

| 任务类型 | 该读（仅限） | 可忽略 | 入口小节 |
|---|---|---|---|
| 连接/拉起 agent 失败（ENOENT、退出码、stderr、进程泄漏） | `core/AgentManager.ts` + `core/AgentConnector.ts` + `config/AgentConfig.ts` | UI、webview | §2.1 |
| ACP 握手 / 协议抓包 / SDK 升级 / 能力协商 | `core/ConnectionManager.ts` + `core/AcpClientImpl.ts` + `utils/Logger.ts(logTraffic)` | tree、webview | §2.2 |
| 会话生命周期（新建/恢复/切换/关闭、认证 -32000） | `core/SessionManager.ts` + `core/auth.ts` + `core/SessionStore.ts` | handlers、webview | §2.3 |
| 发消息 / 取消 / 轮次中补发 / 轮次状态 | `core/SessionManager.ts`(sendPrompt/cancelTurn/steerPrompt) + `handlers/SessionUpdateHandler.ts` | tree | §2.4 |
| 聊天 UI（面板行为 / 记录 / 标签页） | `src/ui/chat/**`（入口 `index.ts`；**先读 `arch/chat-panel.md` 顶部的分册导航表**，再按主题只读那一份分册） | core、dashboard | §2.5 |
| 编辑区面 / 双面同步 / 焦点 | `ui/chat/ChatViewProvider.ts` + `ChatEditorPanel.ts` + `ChatSurface.ts` | core 内部 | §2.5 |
| 权限弹窗 / 表单（AskUserQuestion） | `handlers/PermissionBridge.ts`、`ElicitationBridge.ts` + 客户端 `html/client/{permissionView,permissionDrawer,elicitationView}.ts` | core 编排 | §2.6 |
| 文件读写 / 终端 / 工具卡片数据 | `handlers/FileSystemHandler.ts`、`TerminalHandler.ts`、`utils/TailBuffer.ts` | 会话编排 | §2.6 |
| 侧边栏 Agents 树 / 会话分页 | `ui/SessionTreeProvider.ts` + `core/SessionHistoryStore.ts` | webview | §2.7 |
| agent 默认列表 / 设置项 schema / 新 agent 接入 / 适配器换包 | `package.json(contributes.configuration)` + `config/AgentConfig.ts` + `config/GlobalSettings.ts` + `config/SettingScope.ts` + `agents/AgentProfile.ts` + `agents/AgentMigration.ts`（接新 agent 先跑 `scripts/probe-agent-init.mjs`） | 全部业务代码 | §2.8 |
| Dashboard 用量统计 / 指标 | `src/dashboard/**`（数据层在 `usage/`） | 聊天面板 | §2.9 |
| 打包 / 发布 | `scripts/build.mjs`、`.vscodeignore`、`package.json(scripts)` | 全部业务代码 | §6 |
| 图标 / 品牌资源（侧边栏、插件徽标、编辑区标签页） | `scripts/make-icon.mjs`（唯一几何源）+ `resources/` + `package.json(icon, viewsContainers)` + `ui/chat/ChatEditorPanel.ts(iconPath)` | 全部业务代码 | §6 |
| 记录区滚轮被卡片内的滚动条打断 / 流式卡片不跟到最后一行 | `html/client/scroll.ts` 的 `setActive`（焦点门控）+ document `wheel`（capture / 非 passive）+ `flushTails` / `isLiveCard`（自动追尾）；样式 `.messages .scroll-active`（`styles.ts`） | core、协议 | §2.5 → `arch/chat-panel-state.md` §5.53 |
| **记录区布局 / 观感**（折叠形状、占几行、有没有重复内容） | `scripts/preview-records.mjs`（真 Chromium 无头截图，**自己看，别推理**）＋ `html/styles.ts` | core、tree、协议代码 | §5 |

> 定位优先级：**函数名 grep > 本表**。表过期时以代码为准并顺手订正本表。

---

## 1. 文件职责速查（先看这张表）

| 文件 | 职责 | 何时改它 |
|---|---|---|
| `src/extension.ts` | 激活入口：装配全部服务与视图、把 SessionManager 事件接到 UI、dispose 编排；驱动 `vac.turnInProgress` 上下文键 | 新增服务 / 新增事件转发 / 改装配顺序 |
| `src/commands.ts` | `vac.*` 命令注册表（一个 `handlers` 对象，命令 id → 处理函数，末尾统一 register） | 新增/改命令行为（同时改 `package.json`） |
| `src/agents/AgentProfile.ts` | 按 `kind`（claude / codex / generic）分化的 agent 专有行为：会话请求的 `_meta`（自定义模型）、`transcriptStore`（能否读它的磁盘转录补全历史/回放）、`nesting`（工具调用嵌套策略 id）。**UI 侧的 agent 差异一律从这里按 kind 取，不按配置名** | 新增 agent 专有差异 |
| `src/agents/AgentMigration.ts` | 已废弃适配器包的替换表 + `migrateAgents`（纯逻辑）；`AgentConfig.offerAgentMigration` 在激活时提示改写用户自己的 `vac.agents` | 上游适配器换包名 |
| `src/config/AgentConfig.ts` | 读 `vac.agents`；`getAgentNames` 把第一个 Claude 排最前；`getAgentKind`；`offerAgentMigration`（旧包迁移提示，可“不再询问”） | agent 列表读取/排序 / 配置迁移 |
| `src/config/CustomModels.ts` | `vac.customModels` 的读取（工作区 > 用户 > 跨 IDE 全局 > 默认）与规整；`resolveCustomModels()` 同时给出作用域信息 | 自定义模型配置 |
| `src/config/GlobalSettings.ts` | **跨 IDE 全局配置** `VAC_HOME/config.json`（默认 `~/.vac`）：原子写、白名单（首期仅 `vac.customModels`）、`firstSetLayer` 解析；纯逻辑，禁 import vscode | 新增/改动全局层配置键 |
| `src/config/SettingScope.ts` | VS Code 三层 + 全局层的解析（`resolveSetting`）与写入（`writeSetting` 写当前生效层）、移除覆盖、打开对应配置文件；`SettingIO` 是可注入的测试缝 | 设置作用域 / 覆盖提示 / 写入层 |
| `src/core/AgentManager.ts` | agent 子进程生命周期：`spawnAgent`/`killAgent`/`killAll`；Windows 走 `cmd.exe`，类 Unix 走 login shell（修 npx ENOENT）；进程组 + `taskkill /T /F` 一并收子孙；**npx 启动的 agent 命中本地缓存时直接 `node <entry>`**（`scheduleInstall` 在首次连接 15s 后后台缓存） | agent 起不来 / 平台差异 / 进程泄漏 |
| `src/core/AgentInstall.ts` | **agent 运行时本地缓存**（纯逻辑 + node fs）：`npxSpecOf` 拆 spec、`installDirFor`/`readInstalled`（7 天 TTL）、`entryFromInstall` 从 `package.json`+`bin` 找回入口。绕过 `npm exec` 每次 11–17s 的 reify；缓存目录 `globalStorage/agents/<agent>`（约 320MB/个） | 首次连接慢 / npx 启动开销 |
| `src/core/ConnectionManager.ts` | stdio → Web Streams → `ndJsonStream`；建 `ClientSideConnection`；`initialize`（含 `clientCapabilities`）；解析 `_meta.steering`；traffic tap | 协议握手 / 抓包 / SDK 升级 |
| `src/core/AgentConnector.ts` | agent 名 ↔ 进程 id 索引、`ensure()` 合并并发连接、能力摘要缓存、**每连接控制面串行队列** `enqueue()` | 连接去重 / 能力协商 / RPC 排队 |
| `src/core/SessionManager.ts` | 编排器：`connectToAgent`/`createSession`/`newConversation`/`closeSession`/`disconnectAgent`/`ensureConnected`/`sendPrompt`/`steerPrompt`/`cancelTurn`/`setMode`/`setModel`/`setConfigOption`/`listSessions`/`openExistingSession`/`loadSession`/`resumeSession`；**订阅 `SessionUpdateHandler`**，把 `available_commands_update` / `config_option_update` / `current_mode_update` 落成状态（`applyAvailableCommands`/`applyConfigOptions`/`applyCurrentMode`，会话未注册时进 `PendingSessionState`） | 会话状态机 / 新事件 / 能力协商 |
| `src/core/SessionStore.ts` | 会话索引与焦点（`focusOrder`/`mostRecentLiveId`）+ `PendingSessionState`（早到通知缓冲）。**纯逻辑，禁 import vscode** | 索引语义 / 焦点后继规则 |
| `src/core/cwd.ts` | `pickDefaultCwd`：每会话工作目录三级链（配置→工作区→进程），配置非法则拒绝并回退。**纯函数** | 默认目录策略 |
| `src/core/auth.ts` | `-32000` 判定 + 交互式认证流程（每连接单飞；过滤 `type:'terminal'`；`_meta['api-key']` 标记的方法由客户端提供 key，存 **SecretStorage**、下次静默重试）；`forgetApiKey` | 认证行为 |
| `src/core/SessionHistoryStore.ts` | `workspaceState` 会话缓存：按 agent 分桶、容量上限（活跃会话豁免）、`reconcileFromAgent`、目录候选、touch 限频落盘 | 会话列表丢失 / 缓存策略 |
| `src/core/AcpClientImpl.ts` | ACP `Client` 接口门面，把方法转发给各 handler | 新增 ACP 客户端能力 |
| `src/handlers/FileSystemHandler.ts` | `fs/read_text_file`（优先未保存缓冲区，支持 `line`/`limit`）、`write_text_file` | 文件读写异常 |
| `src/handlers/TerminalHandler.ts` | `terminal/*`：托管终端、`TailBuffer` 限长、映射到 VS Code 终端；`killAll` 保留终端、`dispose` 一并拆除 | 终端输出卡住 / 乱码 / 泄漏 |
| `src/utils/TailBuffer.ts` | 限长尾部缓冲（增量计字节，读取时才拼字符串）。**纯逻辑** | 终端输出裁剪 |
| `src/handlers/PermissionHandler.ts` | 自动批准分支（`vac.autoApprovePermissions`）+ 交给 `PermissionBridge` | 权限弹窗策略 |
| `src/handlers/PermissionBridge.ts` | 权限请求的唯一出口：面板卡片 vs 弹框、FIFO、`cancelSession`/`cancelAll` 保证每个请求恰好被回答一次 | 权限策略 / 并发 / 超时 |
| `src/handlers/ElicitationBridge.ts` | 表单请求（AskUserQuestion）的唯一出口，与权限桥同构；`fieldsOf()` 把 JSON Schema 扁平化成五种字段，`optionOf()` 保留选项的 description 与 preview；结算时写回 `summary` + **结构化的 `answers`**（回执卡据此标出所选） | 表单行为 / schema 形状 |
| `src/handlers/ElicitationHandler.ts` | 表单策略层 + 逐字段弹框兜底 | 弹框兜底行为 |
| `src/handlers/SessionUpdateHandler.ts` | `session/update` 通知扇出（单订阅者异常隔离） | 流式更新丢事件 |
| `src/ui/chat/` | Chat 面板子系统（宿主侧 host/surface/transcript + webview 客户端脚本）；入口 `index.ts` 只导出 `ChatViewProvider`/`ChatPanelHost` | 聊天 UI / 渲染 |
| `src/ui/chat/ChatPanelHost.ts` | 面板核心（**本仓库最大的文件，用 grep 定位、勿整读**）：记录、协议、标签、权限/表单呈现 | 面板行为 |
| `src/ui/chat/ChatViewProvider.ts` | 侧边栏 `vac-chat` 视图 + 编辑区面板的归属与焦点同步（视图上唯一的消息监听器） | 视图注册 / 双面同步 |
| `src/ui/chat/ChatEditorPanel.ts` | 编辑区标签页（第二个 surface） | 编辑区面行为 |
| `src/ui/SessionTreeProvider.ts` | Agents 树：agent → 会话（来源 `session/list` 或本地缓存）；刷新已合并节流（50ms） | 树结构 / 右键菜单 |
| `src/ui/StatusBarManager.ts` | 状态栏 `$(hubot) VAC: <status>` | 状态显示 |
| `src/dashboard/` | Dashboard 视图与用量统计（数据层纯逻辑，见 `docs/dashboard-design.md`） | 统计指标 / 数据源 |
| `src/utils/Logger.ts` | 双输出通道（`VAC` / `VAC Traffic`）+ 落盘 `~/.vac/vac.log`（5MB 轮转、批量刷写）；`logTraffic` 有字符串截断 | 日志格式 / 排查「改动没生效」 |
| `src/utils/BuildInfo.ts` | 构建指纹（版本·git sha·打包时间·bundle 哈希）；`readPackageVersion()` 也被 `ConnectionManager` 用作 `clientInfo.version` | 日志身份标识 |
| `src/test/*.test.ts` | 真实 Extension Host 的 mocha 测试（**用 Tab 缩进**） | 改扩展 id / 命令前缀 / 面板协议 |
| `src/**/*.spec.ts` | vitest 纯逻辑测试（2 空格，禁 import `vscode`） | 改对应纯逻辑模块 |
| `resources/icon.svg` | 活动栏容器图标（24×24 单色 `currentColor`，`viewsContainers.activitybar`） | 改侧边栏图标外观 |
| `resources/icon-editor-color.svg` | 编辑区标签栏按钮的图标（全彩徽标：蓝→紫渐变底 + 白色标记，与 `icon.png` 同一几何/配色） | 改那颗按钮外观（同经 `make-icon.mjs` 生成，别手改） |
| `resources/icon.png` | 128×128 插件徽标（`package.json` 的 `icon`）＋编辑区标签页图标（`ChatEditorPanel` 的 `iconPath`） | 改徽标外观 |
| `scripts/make-icon.mjs` | **图标的唯一几何源**：一份几何同时产出 `icon.svg` 与 `icon.png`（SDF 光栅化 + zlib 手写 PNG，零依赖）；`npm run icon`，`--preview` 另出多尺寸预览图到系统临时目录 | 改图标外观 |

---

## 2. 按「我要做什么」反查代码位置（任务 → 入口）

> 行号会随改动漂移；**优先按「函数名 / 注释锚点」搜索**，行号仅作初始定位。
>
> **自愈规则（铁律）**：若按本表的函数名搜不到 / 对不上（已改名或删除）→ **以 grep/代码为准**，
> 完成任务后**顺手把本表这一行订正**。宁可信代码、修本表，也不要迁就一张过期的表。

### 2.1 进程与连接（`src/core/AgentManager.ts`、`AgentConnector.ts`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 改启动命令 / 环境变量 / cwd | `launch()`、`spawnAgent()` | Windows 与类 Unix 分支不同 |
| 修「npx/tool 找不到」 | `resolveUnixShell()` | 类 Unix 走 login shell 以加载 nvm/Homebrew |
| 修进程残留 / 关不干净 | `terminateTree()` | 类 Unix 杀进程组，Windows 用 `taskkill /T /F` |
| 改 agent 是否已连接的判定 | `AgentConnector.isConnected` / `agentIdOf` | 以**进程索引**为准，不是「有没有会话」 |
| 避免一个 agent 被并发拉起两个进程 | `AgentConnector.ensure()` | 单飞（single-flight）合并 |
| 首次连接慢 / npx 启动开销 | `AgentManager.spawnAgent`（缓存命中走 `node <entry>`）+ `scheduleInstall`/`runInstall`；纯逻辑在 `AgentInstall.ts` | 实测 npx 11–17s vs 直启 0.6s；缓存目录 `globalStorage/agents/`，7 天过期 |
| 控制面 RPC 排队 | `AgentConnector.enqueue()` | 只排 new/load/resume/close，**prompt 不排** |

### 2.2 协议与握手（`src/core/ConnectionManager.ts`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 声明/收回客户端能力 | `connect()` 里的 `clientCapabilities` | 含 `fs`、`terminal`、`elicitation.form`、`subagents`、`session.configOptions.boolean`。**别声明 `_meta.terminal_output(_delta)`**：Claude 适配器会因此改走 `_meta` 终端输出 |
| 声明 `clientInfo` | 同上，`clientInfo` | 版本取自 `BuildInfo.readPackageVersion()` |
| 读 agent 扩展能力（steering 等） | `connect()` 里的 `_meta` 解析 | `InitializeResponse._meta.steering.supported` |
| 抓协议流水 | `tapStream()` | 双向 TransformStream，落 `VAC Traffic` 通道 + 日志文件 |

### 2.3 会话生命周期（`src/core/SessionManager.ts`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 新建会话 / 复用已有会话 | `createSession()` / `connectToAgent()` | `connectToAgent` 有活会话就复用；`session/new` 失败**只抛错、不杀进程**（同进程的其它会话要活着） |
| 打开历史会话 | `openExistingSession()` | **唯一决策点**：live → focus，否则 load，再否则 resume |
| 重放历史 / 轻量恢复 | `loadSession()` / `resumeSession()` | load 走 `session-load-start/end`，面板显示覆盖层 |
| 关闭单个会话 / 断开整个 agent | `closeSession()` / `disconnectAgent()` | 关会话前会先 `cancelTurn` |
| 删除会话（真删） | `deleteSession()` | 先 cancel/close 活会话 → `session/delete`（能力 `delete`）→ 清本地缓存 |
| 分叉会话 | `forkSession()` | `session/fork`（能力 `fork`）；带 `messageId` 时在 `_meta.jetbrains.air.fork` 指定分叉点；建好后走 `openExistingSession` 重放 |
| 认证失败（-32000） | `auth.ts`：`isAuthRequiredError` / `runAuthFlow`；`SessionManager.withAuthRetry` | new / list / load / resume / prompt 都经 `withAuthRetry` 认证后重试一次 |
| API key 认证 / 登出 | `auth.ts`：`takesApiKey` / `setAuthSecrets` / `forgetApiKey`；`SessionManager.logout` + 命令 `vac.logoutAgent` | key 走 `authenticate._meta['api-key'].apiKey`（codex-acp 约定），**流量日志里按键名脱敏**（`Logger.clip`）；`logout` 需能力 `auth.logout` |
| 焦点切换 | `focusSession()` | `active-session-changed` 的唯一出口 |
| 每会话工作目录 | `resolveDefaultCwd()` / `sessionCwd()` / `cwd.ts:pickDefaultCwd` | 会话级属性，与进程 cwd 无关 |
| 自定义模型注入 | `metaFor()` | 经 `AgentProfile` 按 kind 分化 |
| 设配置项（含布尔） | `setConfigOption()` | UI 一律传字符串；选项 `type==='boolean'` 时按 `{type:'boolean', value}` 上线（SDK 契约） |

### 2.4 发消息与轮次（`src/core/SessionManager.ts`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 发一轮 prompt | `sendPrompt()` | 有在途轮次则抛错；进出分别 emit `turn-state-changed` |
| 取消当前轮次 | `cancelTurn()` | **先回答待决权限/表单**，再发 `session/cancel` |
| 轮次中补发消息 | `steerPrompt()` / `supportsSteering()` | 走 `extMethod('_session/steering')`；返回 `'idle'` 表示要回落成普通 prompt |
| 轮次是否进行中 | `hasRunningTurn()` / `isTurnInFlight()` | UI 的 Stop 按钮与 `vac.turnInProgress` 靠它 |
| 流式更新分发 | `handlers/SessionUpdateHandler.ts:handleUpdate` | 单订阅者抛错不影响其它 |

### 2.5 聊天 UI（`src/ui/chat/**`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 面板整体行为 / 消息协议 | `ChatPanelHost.ts`（文件表见 `arch/chat-panel.md` §5.1；主题细节按该文顶部的分册导航表分流） | **勿整读**，用 grep 定位 |
| 侧边栏视图注册 / 双面焦点 | `ChatViewProvider.ts:resolveWebviewView` / `syncFocus` | 视图上**只能有一个** `onDidReceiveMessage` |
| 编辑区面板 | `ChatEditorPanel.ts:open` / `focusMostRecentSession` | 与侧边栏共享同一个 host |
| 记录区渲染 | `transcript/TranscriptStore.ts`、`content/*`、`html/client/transcriptView.ts` | 布局类问题见 §5 |
| 进场 / 收尾时 markdown 没渲染 | `ChatPanelHost.prefillReplayMarkdown`（`session-load-end`）/ `prefillSnapshotMarkdown`（`snapshotOf`）/ `armSettlePrefill` → `settlePrefillMarkdown`（会话安静 600ms）+ 客户端 `transcriptView.patch` 的「带 text 的 html 照收」规则 | 宿主自己补渲染，不再依赖客户端那条往返（见 `arch/chat-panel.md` §5.7） |
| 权限卡片 / 抽屉 | `html/client/permissionView.ts`、`permissionDrawer.ts` | 与 `PermissionBridge` 配对 |
| 表单卡片 | `html/client/elicitationView.ts` | 与 `ElicitationBridge` 配对 |
| 从记录 fork 会话 | `ChatPanelHost` 的 `forkFromMessage` 分支 + `html/client/contextMenu.ts` | 面板只报 entryId，宿主查该条 ACP `messageId` → `SessionManager.forkSession` |
| sub-agent 子会话卡 | `html/client/transcriptView.ts` 的 `buildSubagent` / `patchSubagent`（记录类型 `subagent`） | 状态/标题走 `revise` 就地补丁；Cancel 发 `cancelSubagent` |
| 编辑区标签栏右侧入口 | `package.json(menus.editor/title)` → `vac.openChatFromEditorTab`（动作同 `vac.openChatInEditor`） | 图标用 `resources/icon-editor-color.svg`（全彩徽标）—— 路径图标按**图片**渲染，颜色按 SVG 自己的来；Chat 面板已在编辑区激活时隐藏 |
| 历史列表行的悬停动作 | `html/client/sessionMenu.ts` 的 `buildRowActions` + `applyAction` | Archive 只写本地标签；**Delete 走 `deleteSession`（真删除，宿主先弹确认）**，两条同走 `sessionAction` 回执对账 |
| 会话 tab 右键菜单 | `html/client/contextMenu.ts` 的 `itemsFor`（`.tab` 分支） | **New Session in This Folder**（沿用该会话 cwd + 额外根目录，`newSessionInDirectory`）/ **Duplicate Session**（`session/fork` 不带 messageId，保留上下文与消息记录）/ Close / Rename / **Copy Session ID**；草稿与待恢复 tab 没有 `data-session-id`，只有 Close |
| 会话 tab 中键关闭 | `html/client/tabs.ts` `renderTabs`（`mousedown` button==1 + `auxclick`） | 与 × / Delete / 右键 Close 汇入 `closeModel`；运行中会话的确认在宿主 `closeSessionWithConfirm`（原生模态） |
| 设置面板 | `html/client/settingsPanel.ts`（渲染）+ `ChatPanelHost.settingsItems` / `handleSetSetting` / `handleSettingAction` | 左侧分组导航、右侧行；宿主是唯一写者（`vac.*` 按 `resolveSetting` 写当前生效层，`panel.*` 写 UiPrefs）。每行带 `scope`/`source`：客户端画 `All IDEs / This IDE / Workspace / Default` 胶囊，点开 Inspect 可看各层值、打开文件、移除覆盖、提升为跨 IDE 全局。**每个 agent 的默认模型 / 默认推理强度**（`panel.defaultModel.<agent>` / `panel.defaultEffort.<agent>`）在 `session-created('new')` 由 `applyRememberedModel` → `applyRememberedEffort` 依次落地（草稿页的显式选择排在其后）。自定义模型是结构化列表编辑器，Agent 配置是 JSON 编辑器，二者都在**子面板**里打开（主面板只显示摘要 + Edit…）；操作项含打开/清除运行时缓存与重置面板偏好 |
| 输入卡选择器（模式 / 模型 / Effort） | `html/client/composer.ts` 的 `buildPicker` / `renderMenu` / `menuItem` | 按钮图标来自 `icons.ts`（`mode` / `model` / `effort`），菜单项是**名称 + 说明两行**、选中项打勾；说明优先取 agent/自定义模型的 `description`。Effort 按 `category === 'thought_level'` 识别 |
| Agent 选择器 | `html/client/tabs.ts` 的 `renderAgentBar` / `renderAgentMenu` | 从原生 `<select>` 改为与输入卡同一套 `.picker` 控件（图标 + 名称 + 说明 + 勾选）；说明来自 `SessionSummary.agentKind`（`ChatPanelHost.toSummary` 填），只在**多个 agent 都有会话**时显示 |
| 会话 tab / 目录图标悬停提示 | `html/client/tabs.ts` 的 `showTip` / `hideTip` | 自绘 `.tab-tip` 浮层（原生 `title` 不能分段着色）：tab = 标题 + 灰色 SessionId；目录图标 = 路径（无 `Dir:` 前缀）+ 灰色 State |
| Markdown 渲染预设 | `UiPrefs.markdownStyle` + `boot.ts` 的 `applyMarkdownStyle` + `styles.ts` 的 `body[data-md-style]` 规则 | `editor`（默认，跟随主题）/ `github` / `compact` / `reading`；只改排版与主题 token 的使用，不改渲染链路 |
| 新输出自动展开 | `html/client/autoExpand.ts`（状态 + 地址栏按钮）+ `transcriptView.setAutoExpand` / `expandEntry` | 按会话（`autoExpandBySession` + 默认值）与全局卡片类型（`autoExpandKinds`：tool / thought / diff）；只作用于 live append/patch/updateTool，hydrate 不碰 |
| 消息面板自动追尾（Tail 按钮） | `html/client/tail.ts`（状态 + 地址栏按钮）+ `scroll.setTail` / `follow` / `cancelTail` | 与 Times 同一形态：`tailBySession` + `tailDefault`（默认 true）；用户滚动或恢复中间位置即取消（只改会话那条）；§5.54 |
| 目录抽屉「Recently used」删一条 / 同路径重复 | `html/client/directoryMenu.ts` 的 `makeRow(..., removable)` / `removeRecent` + 宿主 `handleRemoveRecentDirectory` + `SessionHistoryStore.dismissRecentDirectory` + `historyDirs.recentDirectoryList` | 列表是派生的 ⇒ 记 `vac.recentCwdDismissed.v1` 并在合并时过滤；**去重按 `directoryKey`**（`F:/x` 与 `f:/x` 是同一条）；同目录再建会话即恢复 |
| 首屏连接预热 / 连接耗时 | `ChatPanelHost.prewarm`（由 `ChatViewProvider.resolveWebviewView` / `openEditorChat` 调用） | 只预热 `ensureConnected`、不建会话；日志里有 `prewarm connected in Nms` 与 `initialized in Nms` / `session ready in Nms` |
| webview 样式 | `html/styles.ts` | 按 §5 的锚点搜 |

### 2.6 能力实现（`src/handlers/`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 读文件（含未保存内容） | `FileSystemHandler.readTextFile` | 优先 `workspace.textDocuments` |
| 写文件 | `FileSystemHandler.writeTextFile` | 写完以 preview 打开 |
| 终端创建/输出/结束 | `TerminalHandler.createTerminal` / `readOutput` / `waitForTerminalExit` | `readOutput` 不抛异常，供面板调用 |
| 权限自动批准 | `PermissionHandler.requestPermission` | 读 `vac.autoApprovePermissions` |
| 权限面板/弹框分流 | `PermissionBridge.request` / `canPresent` | presenter 只对「屏幕上的会话」返回 true |
| 表单字段扁平化 | `ElicitationBridge.fieldsOf` / `optionOf` | JSON Schema → 五种字段；选项的 description 与 preview 都保留 |
| sub-agent 子会话 / 取消子会话 | `ChatPanelHost.onSessionUpdate` 的 `subagent_update` 分支 + `subagentParents`（别名回父会话）、`SessionManager.cancelSubagent` | draft 能力；卡片由 `TranscriptStore.upsertSubagent` 建 |

### 2.7 侧边栏树（`src/ui/SessionTreeProvider.ts`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 树的一级/二级节点 | `agentNodes` / `agentChildren` | 二级来源见下两行 |
| agent 侧会话列表 | `agentSourced` / `fetchList` / `loadMore` | 需要 `session/list` 能力 |
| 本地缓存会话列表 | `localSourced` / `localItem` | 需要 load/resume 能力 |
| 能力探测 | `probe()` | 探测前会 `ensureConnected` |
| 刷新节流 | `refresh()` | 50ms 合并，避免风暴 |

### 2.8 配置与 agent 接入（`src/agents/`、`src/config/`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 加一个 agent | `inferAgentKind()` + `AgentProfile.ts` + `package.json(contributes.configuration.vac.agents)` | 先跑 `scripts/probe-agent-init.mjs --agent "<命令>" --session` 看它声明的能力/认证方式/配置项，再判断有没有 **专有 `_meta` 需求** |
| 改 agent 排序 | `AgentConfig.getAgentNames` | 只把第一个 Claude 提前，不全排序 |
| 适配器换包 / 旧配置迁移 | `AgentMigration.ts` 的 `REPLACEMENTS` + `AgentConfig.offerAgentMigration` | 只改写用户显式配置的 scope（全局 / 工作区）；默认值直接改 `package.json` |
| 改设置项 | `package.json(contributes.configuration)` | 前缀必须 `vac.` |
| 改设置项的作用域 / 覆盖提示 | `SettingScope.ts` 的 `resolveSetting` / `writeSetting`；面板侧 `ChatPanelHost.settingsItems` 的 `scope`/`source` + `html/client/settingsPanel.ts` | 顺序：工作区 > 用户 > `~/.vac/config.json` > `package.json` 默认；面板写**当前生效层** |
| 新增跨 IDE 全局配置键 | `GlobalSettings.ts` 的 `GLOBAL_SETTING_KEYS` + `setGlobalValue`；再在 `SettingScope.CONFIG_SETTING_KEYS` 登记 | 白名单之外的键不落 `~/.vac`；密钥永不进这里 |

### 2.9 Dashboard（`src/dashboard/`）

| 我要改的东西 | 关键函数 / 锚点 | 备注 |
|---|---|---|
| 统计口径 / 窗口 / 聚合 | `usage/UsageIndex.ts` | 纯逻辑，配 `.spec.ts` |
| 转录根目录 | `defaultClaudeProjectsDir` / `defaultCodexSessionsDir` | 分别认 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，否则 `~/.claude` / `~/.codex` |
| Claude 转录解析 | `usage/ClaudeUsageSource.ts`、`usage/JsonlUsageSource.ts` | 增量只读新增字节 |
| Codex 转录解析 | `usage/CodexUsageSource.ts` | 按回合 `token_count` 差值 |
| 价格与成本估算 | `usage/pricing.ts`（`PRICING_AS_OF`） | 是**估值**，UI 标 "est." |
| 扫描编排 / 文件监听 | `usage/UsageService.ts`（`refresh` / `startWatching`） | 单飞 + 防抖 |
| HTML / 客户端脚本 | `DashboardHtml.ts` + `DashboardHtml.spec.ts` / `DashboardClient.spec.ts` | 无外部依赖，手写脚本 |
| 视图与消息 | `DashboardViewProvider.ts` | 无 `retainContextWhenHidden` |

---

## 3. 重点链路详解（高频改动区 / 容易写错的地方）

### 3.1 「打开一个已存在的会话」链路

- **需求语义**：用户点历史会话 → 能看就恢复、看不到就重放，且**已活的会话不再重复打开**。
- **关键坑**：能力（`load`/`resume`）来自 `initialize` 握手，**没连过的 agent 没有缓存能力**，
  直接读会误判成「不支持」而抛错。
- **正确实现**：一切收敛到 `SessionManager.openExistingSession()`：先 `ensureConnected`，
  再按 live → load → resume 决策（涉及函数：`openExistingSession`）。
- **调用链**：`commands.ts(vac.openSession)` / 面板历史选择器 → `openExistingSession` → `loadSession|resumeSession`。

### 3.2 权限/表单请求的「恰好回答一次」

- **需求语义**：agent 阻塞等答复；客户端要么在面板画卡片，要么弹 QuickPick，**不能两边都答、也不能都不答**。
- **关键坑**：面板不可见（被编辑器挡住 / 视图未打开）时若仍判给面板，请求会永久挂着。
- **正确实现**：`PermissionBridge.request` 用 `presenter.canPresent(sessionId)` 决定归属；
  `canPresent` 必须同时满足「有可见 surface」+「该 surface 正在显示这个会话」；
  会话取消/关闭时 `cancelSession` 把待决项答成 cancelled。
- **调用链**：`ConnectionManager` → `AcpClientImpl.requestPermission` → `PermissionHandler` → `PermissionBridge` → `ChatPanelHost` 或 QuickPick。

### 3.3 轮次状态与 `vac.turnInProgress`

- **需求语义**：Esc 取消、标题栏 Stop 按钮只在**有轮次在跑**时可用。
- **关键坑**：这个上下文键历史上从未被 `setContext`，导致键位是死绑定。
- **正确实现**：`sendPrompt` 进出分别 emit `turn-state-changed`；
  `extension.ts:updateTurnContext` 据此 `setContext('vac.turnInProgress', …)`；
  Escape 键位的 `when` 收敛在聊天界面内（`focusedView == 'vac-chat'` 或编辑区面板）。
- **调用链**：`sendPrompt` → `turn-state-changed` → `updateTurnContext` → `setContext`。

---

## 4. 数据流 / 接口契约

| 调用方 | 路由 / 入口 | 鉴权 | 关键字段 / 约定 |
|---|---|---|---|
| 扩展 ↔ agent 进程 | ACP over stdio JSON-RPC（`ClientSideConnection`） | `initialize` + `authenticate`（-32000） | 每个请求带 `sessionId`；`session/new\|load\|resume\|close` 串行，`prompt` 并发 |
| 宿主 ↔ Chat webview | `postMessage`（协议见 `ui/chat/protocol.ts`） | CSP + nonce，`localResourceRoots` 限定 | 一个视图只有一个 `onDidReceiveMessage` 监听器 |
| 宿主 ↔ Dashboard webview | `postMessage`（见 `dashboard/DashboardModel.ts`） | CSP + nonce；命令走白名单 | 只投递 `snapshot`；不可见时不投 |
| 会话缓存 | `workspaceState`（`SessionHistoryStore`） | —— | key `vac.sessionHistory.v1`，**改名即丢历史** |
| 跨 IDE 全局配置 | `VAC_HOME/config.json`（默认 `~/.vac`，`GlobalSettings.ts`） | —— | 白名单键（首期 `vac.customModels`）；原子写（临时文件 + rename）；读取顺序：工作区 > 用户 > 全局 > `package.json` 默认 |
| 「Recently used」的删除 | `workspaceState`（`SessionHistoryStore`） | —— | key `vac.recentCwdDismissed.v1`（路径数组）；同一目录新建会话即自动移除 |
| 会话恢复快照 | `globalState`（`ChatPanelHost.saveOpenSessions`） | —— | key `vac.openSessions.v1`；每条 `RecoverableSession` 可带 `app`（写入时的 IDE 标签），与当前环境相同的会在下发前剥掉，只用于标注 |
| 模型切换诊断 | `SessionManager.noteModelChange` | —— | `model <旧> -> <新> (<source>)`，source = `session-response` / `set-response` / `notification`；只在值真的变化时写 |
| 用量索引 | `globalStorageUri` 下 `usage-index.json` | —— | 原子写（临时文件 + rename），损坏则重建 |
| agent API key | `SecretStorage`（`auth.ts`） | —— | key `vac.apiKey.<agent 名>`；登出（`vac.logoutAgent`）或被拒时删除；**绝不进 settings.json / 日志** |
| 迁移提示“不再询问” | `globalState` | —— | key `vac.agentMigrationDismissed.v1` |

**数据/单位铁律**：

- 会话的 `cwd` 是**会话级**属性，与 agent 进程的 cwd 无关。
- 终端输出按字节限长（`TailBuffer`），截断按 UTF-8 边界，不切半个字符。
- Dashboard 的成本是**等价 API 成本估算**，订阅用户并不按此付费；未知模型计入 `unpriced` 而非 0 成本。

### 4.1 `SessionManager` 事件契约

订阅点集中在 `src/extension.ts`、`src/ui/**` 与 `src/dashboard` 的 host 适配。**改事件签名 = 改契约**，同步更新本表。

> `available-commands-changed` / `config-options-changed` / `mode-changed` 这三条**由 core 直接消费 agent 推送产生**
> （`SessionManager` 订阅 `SessionUpdateHandler`）——即"谁 emit 它们"不是面板的职责。UI 只订阅事件。
> 早于 `session/new|load|resume` 响应到达的推送会先缓冲（`PendingSessionState`），随会话注册时落盘。

| 事件 | 参数 | 说明 |
|---|---|---|
| `agent-connected` | (agentName) | 握手成功（此时可能还没有会话） |
| `agent-disconnected` | (agentName) | 进程与它的全部会话都没了 |
| `agent-error` / `agent-stderr` / `agent-closed` | (agentId, …) | 进程级事件，由 `AgentManager` 转发 |
| `active-session-changed` | (sessionId \| null, agentName \| null) | **焦点**变化；唯一出口是 `focusSession()` |
| `session-created` | (sessionId, agentName, origin: `'new'` \| `'load'` \| `'resume'`) | `origin` 为追加参数，老订阅者不受影响 |
| `session-closed` | (sessionId, agentName, reason: `'user'` \| `'agent-disconnected'`) | 关闭会话 / 断开 agent |
| `turn-state-changed` | (sessionId, running) | 驱动 `vac.turnInProgress` 上下文键 |
| `session-load-start` / `session-load-end` | (sessionId, agentName, ok) | 重放历史时的覆盖层 |
| `mode-changed` / `model-changed` | (sessionId, id) | 旧 API 路径（无 configOptions 的 agent） |
| `config-options-changed` | (sessionId, options \| null) | 新 API 路径，优先 |
| `available-commands-changed` | (sessionId, commands) | 斜杠命令 |
| `session-info-changed` | (sessionId, { title?, updatedAt? }) | 标题更新 |

---

## 5. 样式 / 资源分段地图

聊天面板客户端脚本与样式都在 `src/ui/chat/html/`（手写、无打包）。改布局类问题**先无头截图自己看**：

| 区段 | 注释锚点（搜这个） | 内容 |
|---|---|---|
| 整体外壳 | `renderChatHtml`（`html/shell.ts`）、`html/body.ts` | CSP、nonce、`data-vac-build` 指纹 |
| 样式总表 | `html/styles.ts` | 面板全部 CSS；按 `.section` / 变量名搜 |
| 布局变量 | `--vac-aside-w`、`--vac-composer-h`、`--vac-perm-h`、`--vac-elic-h` | 抽屉与输入卡的高度让位关系 |
| 记录区渲染 | `html/client/transcriptView.ts`、`toolCallView.ts` | 折叠、markdown、时间、右键 |
| 无头验收 | `scripts/preview-records.mjs` | 真 Chromium 截图，**别靠推理** |

---

## 6. 运维 / 脚本（构建 / 发布 / 校验）

> 做运维任务只读本节 + `scripts/`，不用打开业务代码。
>
> **与 docs/02 分工**：本节只留**脚本位置指针**；具体**操作步骤/参数/坑**以 [`docs/02-使用说明.md`](docs/02-使用说明.md) 为准。

- **构建单一源**：`scripts/build.mjs`（esbuild 配置、构建指纹注入都在这一处）。
  产物 `dist/extension.js`，**唯一入口** `src/extension.ts`（`package.json` 的 `main`）。
- 统一管理脚本：`sh manager.sh help`。
- 文档体检：`sh check-docs.sh`。
- agent 握手探针：`node scripts/probe-agent-init.mjs --agent "<命令>" [--session] [--out f.json]`（只握手 / 建空会话，不发 prompt、不花额度；输出可能含本机模型配置，**别提交**）。
- 开发宿主：`npm run dev:host`（`scripts/dev-host.mjs`，不挂调试器）；断点调试走 `.vscode/launch.json`。
- 无头截图验收：`npm run compile-tests` 后 `node scripts/preview-records.mjs`。
- **图标**：`npm run icon`（`scripts/make-icon.mjs`）。`resources/icon.svg` 与 `resources/icon.png`
  **都是生成物，不要手改**——几何写在脚本顶部的 `MARKS`，改那里再重跑。
  自动生成的图标必须按 `.gitattributes` 的 `*.png binary` 走，否则换行符转换会把 PNG 洗坏
  （v1.0.2 之前的 `icon.png` 就是这么废掉的：0x0D 被剥掉、头部尺寸读成 32768）。

---

## 7. 易踩的坑 / 设计取舍

- **不要往 UI 层加 agent 专有分支**：agent 差异一律经 `agents/AgentProfile.ts` 按 `kind` 分化。
- **`ChatPanelHost.ts` 很大**：先 grep 函数名再读片段，整读会吃掉大量上下文。
- **纯逻辑模块禁止 import `vscode`**：否则 vitest 无法在裸 node 下加载，纯逻辑测试就跑不起来。
- **webview 视图上只有一个消息监听器**：多注册会收到重复消息；`boot` 消息必须**先注册监听再写 HTML**。
- **取消会话前必须先回答挂起请求**，否则 agent 永久挂起（ACP 契约）。
- **会话早到的通知要缓冲**：`session/new` 响应解析与通知派发之间存在微任务竞态（`PendingSessionState`）。
- **换行符一律 LF**：`.gitattributes` 已钉住；写入 CRLF 会让整文件产生伪差异。
- **`vac.turnInProgress` 必须与 `isTurnInFlight` 同步**，否则 Escape 要么失效要么常亮。
- **webview 的字号/布局改动要先确认预览基准，再谈结论**：`preview-records.mjs` 的预览主题
  缺 `--vscode-font-size` 这类**非配色** token 时，页内 `em` 的解析基准会静默跑偏
  （实测放大 ~1.79×），真机的问题在截图里复现不出来、"看着挺好"是假绿。
  `#tabsprobe` 读数里的 `baseFont` 必须是 13px —— 见 `docs/pitfalls.md` #66。
