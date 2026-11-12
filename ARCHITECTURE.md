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
（侧边栏 Dashboard webview + Agents 树 + Chat webview，另有编辑区 Chat 标签页与临时 Side Chat 面板）。

```
侧边栏容器 vac-client                          编辑区标签页
  ├── vac-dashboard (webview)  DashboardViewProvider        vac-chat-editor / ChatEditorPanel
  ├── vac-sessions  (tree)     SessionTreeProvider          vac-side-chat  / SideChatPanel（临时）
  └── vac-chat      (webview)  ChatViewProvider ────┬───────────────┘
                                                    │ 三个 surface 共享
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
`@vscode/test-electron` + Mocha API 跑真实宿主（`src/**/*.test.ts`）；全局标识符命名空间 `vac.*`。
---
## 0.5 任务作用域路由（先定范围，避免污染上下文）
> **怎么用**：动手前先在下表找到你的任务类型，**只读「该读」列的文件/小节，明确不碰「忽略」列**。

| 任务类型 | 该读（仅限） | 可忽略 | 入口小节 |
|---|---|---|---|
| 连接/拉起 agent 失败（ENOENT、退出码、stderr、进程泄漏） | `core/AgentManager.ts` + `core/AgentConnector.ts` + `config/AgentConfig.ts` | UI、webview | §2.1 |
| ACP 握手 / 协议抓包 / SDK 升级 / 能力协商 | `core/ConnectionManager.ts` + `core/AcpClientImpl.ts` + `utils/Logger.ts(logTraffic)` | tree、webview | §2.2 |
| 会话生命周期（新建/恢复/切换/关闭、认证 -32000） | `core/SessionManager.ts` + `core/AgentRecovery.ts` + `core/auth.ts` + `core/SessionStore.ts` | handlers、webview | §2.3；`arch/connection-lifecycle.md` |
| 发消息 / 取消 / 轮次中补发 / 轮次状态 | `core/SessionManager.ts`(sendPrompt/cancelTurn/steerPrompt) + `handlers/SessionUpdateHandler.ts` | tree | §2.4 |
| 聊天 UI（面板行为 / 记录 / 标签页 / 快捷键设置） | `src/ui/chat/**`（入口 `index.ts`；**先读 `arch/chat-panel.md` 顶部的分册导航表**，再按主题只读那一份分册；快捷键见 §2.5；Agent map 见 §5.57；右栏 Details 见 §5.58） | core、dashboard | §2.5 |
| 编辑区面 / 主双面同步 / 焦点 | `ui/chat/ChatViewProvider.ts` + `ChatEditorPanel.ts` + `ChatSurface.ts` | Side、core 内部 | §2.5 |
| Side Chat 入口 / fork / 临时生命周期 / 来源标题 / Main-Side 工具栏偏好 | `ui/chat/SideChatPanel.ts` + `ChatPanelHost.ts`(openSide/canSurfaceAccess/projectUiPrefs/commitUiPrefs/postUiPrefs) + `core/SessionManager.ts`(forkSideSession/requestFork) + `html/client/{composer,contextMenu,boot,times,tail,autoExpand,outline}.ts` | 普通历史恢复、Dashboard、Core 会话存储 | §2.3、§2.5、§4；`arch/chat-panel.md` §5.7、`arch/chat-panel-state.md` §5.55、`arch/connection-lifecycle.md` |
| 权限弹窗 / 表单（AskUserQuestion） | `handlers/PermissionBridge.ts`、`ElicitationBridge.ts` + 客户端 `html/client/{permissionView,permissionDrawer,elicitationView}.ts` | core 编排 | §2.6 |
| 文件读写 / 终端 / 工具卡片数据 | `handlers/FileSystemHandler.ts`、`TerminalHandler.ts`、`utils/TailBuffer.ts` | 会话编排 | §2.6 |
| 侧边栏 Agents 树 / 会话分页 | `ui/SessionTreeProvider.ts` + `core/SessionHistoryStore.ts` | webview | §2.7 |
| agent 默认列表 / 设置项 schema / 新 agent 接入 / 适配器换包 | `package.json(contributes.configuration)` + `config/AgentConfig.ts` + `config/GlobalSettings.ts` + `config/SettingScope.ts` + `agents/AgentProfile.ts` + `agents/AgentMigration.ts`（接新 agent 先跑 `scripts/probe-agent-init.mjs`） | 全部业务代码 | §2.8 |
| Dashboard 用量统计 / 指标 | `src/dashboard/**`（数据层在 `usage/`） | 聊天面板 | §2.9 |
| 打包 / 发布 | `scripts/build.mjs`、`.vscodeignore`、`package.json(scripts)` | 全部业务代码 | §6 |
| 图标 / 品牌资源（侧边栏、插件徽标、编辑区标签页） | `scripts/make-icon.mjs`（唯一几何源）+ `resources/` + `package.json(icon, viewsContainers)` + `ui/chat/ChatEditorPanel.ts(iconPath)` | 全部业务代码 | §6 |
| 记录区滚轮 / 中键被卡片内的滚动条打断 / 流式卡片不跟到最后一行 | `html/client/scroll.ts` 的 `setActive` / `reclaimActive`（左键焦点门控与失效回收）+ `nearestVertScroller`（只认 `INNER_SCROLL_SELECTOR`）/ `firstInnerScroller(card, skipCharts)`（标题栏兜底，跳过正文内嵌的 `.mermaid-chart`；只有点中滚动区本身才聚焦）/ `nearestHorizScroller`（独立横向几何）+ document `wheel`（capture / 非 passive；纵向按焦点路由、斜向按轴分流，纯横向 / Shift 放行）+ `pressLabel`（原生滚动条不参与聚焦）+ `guardMiddleAutoScroll` / `restoreMiddleGuard`（完整纵横候选链临时 `overflow:clip`）+ `flushTails` / `isLiveCard`（自动追尾）；样式 `.messages .scroll-active` 与自动展开单纵向视口（`styles.ts`） | core、协议 | §2.5 → `arch/chat-panel-state.md` §5.53 |
| **记录区布局 / 观感**（折叠形状、占几行、有没有重复内容） | `scripts/preview-records.mjs`（真 Chromium 无头截图，**自己看，别推理**）＋ `html/styles.ts` | core、tree、协议代码 | §5 |

> 定位优先级：**函数名 grep > 本表**。表过期时以代码为准并顺手订正本表。
---
## 1. 文件职责速查（先看这张表）

| 文件 | 职责 | 何时改它 |
|---|---|---|
| `src/extension.ts` | 激活入口：装配全部服务与视图、把 SessionManager 事件接到 UI、dispose 编排；驱动 `vac.turnInProgress` 上下文键 | 新增服务 / 新增事件转发 / 改装配顺序 |
| `src/commands.ts` | `vac.*` 命令注册表（一个 `handlers` 对象，命令 id → 处理函数，末尾统一 register） | 新增/改命令行为（同时改 `package.json`） |
| `src/agents/AgentProfile.ts` | 按 `kind`（claude / codex / generic）分化的 agent 专有行为：会话请求的 `_meta`（自定义模型）、`transcriptStore`（能否读它的磁盘转录补全历史/回放）、`nesting`（工具调用嵌套策略 id）。**UI 侧的 agent 差异一律从这里按 kind 取，不按配置名** | 新增 agent 专有差异 |
| `src/agents/AgentMigration.ts` | 适配器包 / 版本表示的替换表 + `migrateAgents`（纯逻辑）；`AgentConfig.offerAgentMigration` 在激活时提示改写用户自己的 `vac.agents`（Codex 旧包、Claude 裸 spec → `#main`） | 上游适配器换包名 / 需要固定到修复分支 |
| `src/config/AgentConfig.ts` | 读 `vac.agents`；`getAgentNames` 把第一个 Claude 排最前；`getAgentKind`；`offerAgentMigration`（旧包迁移提示，可“不再询问”） | agent 列表读取/排序 / 配置迁移 |
| `src/config/CustomModels.ts` / `CustomModelList.ts` / `ModelListSync.ts` | 自定义模型读取/规整、顺序签名、设置层 CAS 与串行任务；后两者纯逻辑 | 模型排序、冲突与设置作用域 |
| `src/config/GlobalSettings.ts` | **跨 IDE 全局配置** `VAC_HOME/config.json`（默认 `~/.vac`）：原子写、白名单（首期仅 `vac.customModels`）、`firstSetLayer` 解析；纯逻辑，禁 import vscode | 新增/改动全局层配置键 |
| `src/config/SettingScope.ts` | VS Code 三层 + 全局层的解析（`resolveSetting`）与写入（`writeSetting` 写当前生效层）、移除覆盖、打开对应配置文件；`SettingIO` 是可注入的测试缝 | 设置作用域 / 覆盖提示 / 写入层 |
| `src/core/AgentManager.ts` | agent 子进程生命周期：`spawnAgent`/`killAgent`/`killAll`；Windows 不用 `shell:true`：`resolveWindowsCommand` 查 PATH×PATHEXT，exe 直启、`.cmd` 垫片经 `cmd /d /s /v:off /c` + `cmdShimCommandLine`（拒 `%`/引号/换行），类 Unix 走 login shell（修 npx ENOENT）；env 用 `mergeEnv`（win32 键大小写不敏感）；stderr 经 `LineSplitter`；`killAgent` 后 `trackDying` 在宿主 `exit` 时同步 SIGKILL 未退出的进程组；进程组 + `taskkill /T /F` 一并收子孙；**npx 启动的 agent 命中本地缓存时直接 `node <entry>`**（`scheduleInstall` 在首次连接 15s 后后台缓存） | agent 起不来 / 平台差异 / 进程泄漏 |
| `src/core/AgentInstall.ts` | agent 本地缓存：`npxSpecOf` 只优化简单 `npx [-y/--yes] package`，复杂选项保留 npx 语义；`installDirFor` 用安全 slug + 名称 SHA256 前 16 位，目录为 `globalStorage/agents/<slug-hash>`；`readInstalled` 7 天 TTL，`entryFromInstall` 找入口。旧目录不自动迁移/删除 | 首次连接慢 / 安装路径与参数 |
| `src/core/ConnectionManager.ts` | stdio → Web Streams → `ndJsonStream`；`initialize` + steering 协商 + traffic tap；握手期间 `pendingTerminals`；所有连接共享一个 `retainedTerminals` 池（上限 `RETAINED_TERMINAL_CAP`），移除连接 `retire` 其终端；`watchClose`/`onConnectionLost`：SDK 自行关闭仍登记的连接（流错误/超 32MB 消息）时宽限 `CONNECTION_LOST_GRACE_MS` 后通知 SessionManager；最终 `dispose` 全清 | 协议握手 / 抓包 / 终端生命周期 |
| `src/core/AgentConnector.ts` | agent 名 ↔ 进程 id；`ensure` 单飞 + AbortController、`cancel` 中止握手并拒绝晚到成功；`enqueue` 每连接控制面串行、执行前检查连接是否仍有效，每个任务有截止（`CONTROL_PLANE_TIMEOUT_MS` 60s / `SESSION_LOAD_TIMEOUT_MS` 300s / `SESSION_CLOSE_TIMEOUT_MS` 15s），超时调用方收到 `DeadlineExceededError`、队列前进，任务拿到的 `expired` 信号用于跳过晚到副作用 | 连接去重 / 取消 / RPC 排队 |
| `src/core/SessionManager.ts` | 编排器：`connectToAgent`/`createSession`/`newConversation`/`closeSession`/`disconnectAgent`/`ensureConnected`/`sendPrompt`/`steerPrompt`/`cancelTurn`/`setMode`/`setModel`/`setConfigOption`/`listSessions`/`openExistingSession`/`loadSession`/`resumeSession`；`requestFork` 共用 ACP fork，`forkSession` 走普通重放，`forkSideSession` 只注册不聚焦/不写历史；`getMainLiveSessions` 与 `getSessionIdsForAgent` 默认排除 Side。**订阅 `SessionUpdateHandler`**，把 `available_commands_update` / `config_option_update` / `current_mode_update` 落成状态（`applyAvailableCommands`/`applyConfigOptions`/`applyCurrentMode`，会话未注册时进 `PendingSessionState`） | 会话状态机 / Side fork / 新事件 / 能力协商 |
| `src/core/SessionStore.ts` | 会话索引与焦点；`add` 拒绝不同 agent/连接占用相同 sessionId；`focus` 拒绝 Side，`mostRecentLiveId` 跳过 Side；`PendingSessionState.remove/clear` 清早到缓冲。纯逻辑，禁 import vscode | 索引隔离 / 焦点后继规则 |
| `src/core/cwd.ts` | `pickDefaultCwd`：每会话工作目录三级链（配置→工作区→进程），配置非法则拒绝并回退。**纯函数** | 默认目录策略 |
| `src/core/auth.ts` / `authError.ts` | `-32000` 判定（`authError.isAuthRequiredError` 只认 code，不匹配消息文本；纯逻辑）+ 交互式认证流程（每连接单飞；过滤 `type:'terminal'`；`_meta['api-key']` 标记的方法由客户端提供 key，存 **SecretStorage**、下次静默重试）；`forgetApiKey` | 认证行为 |
| `src/core/SessionHistoryStore.ts` | `workspaceState` 会话缓存：按 agent 分桶、容量上限（活跃会话豁免）、`reconcileFromAgent`、目录候选、touch 限频落盘；`additionalDirectories` 随行持久化（`upsertNew(..., dirs)` / `setAdditionalDirectories`），供历史重开时传给 `session/load` | 会话列表丢失 / 缓存策略 / 多根会话重开丢额外根 |
| `src/core/AcpClientImpl.ts` | ACP Client 门面；携带 sourceAgentId，更新和 fs/terminal/权限/带 sessionId 的表单请求先验证归属再转发 | 客户端能力 / 跨连接隔离 |
| `src/handlers/FileSystemHandler.ts` / `FileSlice.ts` | 路径必须绝对；只匹配 `file:` scheme 的打开文档（排除 `git:` 等同 fsPath 的虚拟文档）；read 优先编辑器缓冲、`FileSlice.sliceLines` 处理 line/limit（limit 0 = 空）；write 对 dirty 文档明确拒绝，clean 文档 WorkspaceEdit + save 并检查结果，未打开文件写磁盘后展示 | 文件读写一致性 / 草稿保护 |
| `src/handlers/TerminalHandler.ts` | terminal/*：shell-free launcher、stdout/stderr 独立 StringDecoder、TailBuffer；spawn error 结算退出；release/killAll 清进程与活跃索引，显示终端进 `RetainedPool`（`RetainedPool.ts`，超上限销毁最旧）；`retire` 拒绝晚到 create；杀 pid 前同时查 exitCode/signalCode | argv / 乱码 / 泄漏 |
| `src/utils/TerminalCommand.ts` / `ProcessTree.ts` / `LineSplitter.ts` | terminal 默认不经过 shell；`mergeEnv` + `resolveWindowsCommand`（agent 启动与终端共用）；Windows batch 受限 argv（终端 `batchCommandLine` 严格，agent 启动 `cmdShimCommandLine`）；公共进程树终止（Windows taskkill / Unix 进程组）；`LineSplitter` 跨 chunk 行/UTF-8 拼接 | 参数边界 / 子孙进程回收 |
| `src/utils/Abortable.ts` / `CancellationToken.ts` | fallback 取消 race 与 VS Code UI CancellationToken 适配 | 取消后 FIFO 不被旧弹框阻塞 |
| `src/utils/BoundedPayload.ts` | 非可信工具 JSON 的深度、节点数、集合大小与文本预算；不修改输入 | 大数据 / 内存上限 |
| `src/utils/TailBuffer.ts` | 限长尾部缓冲（增量计字节，读取时才拼字符串）。**纯逻辑** | 终端输出裁剪 |
| `src/handlers/PermissionHandler.ts` | 自动批准分支（`vac.autoApprovePermissions`）+ 交给 `PermissionBridge` | 权限弹窗策略 |
| `src/handlers/PermissionBridge.ts` | 权限请求的唯一出口：面板卡片 vs 弹框、FIFO、`answer` 校验 expected session，`cancelSession`/`cancelAll` 保证每个请求恰好被回答一次 | 权限策略 / 并发 / 超时 |
| `src/handlers/ElicitationBridge.ts` | 表单请求（AskUserQuestion）的唯一出口，与权限桥同构；`submit` 校验 expected session；`fieldsOf()` 把 JSON Schema 扁平化成五种字段，`optionOf()` 保留选项的 description 与 preview；结算时写回 `summary` + **结构化的 `answers`**（回执卡据此标出所选） | 表单行为 / schema 形状 |
| `src/handlers/ElicitationHandler.ts` | 表单策略层 + 逐字段弹框兜底 | 弹框兜底行为 |
| `src/handlers/SessionUpdateHandler.ts` | `session/update` 通知扇出（单订阅者异常隔离） | 流式更新丢事件 |
| `src/ui/chat/` | Chat 面板子系统（host/surface/transcript + webview）；`markdown.ts` / `content/readHighlight.ts` 管安全渲染与 Read 文件语言推断（后者纯逻辑）；`agentmap/AgentMapStore.ts` 是子 agent 注册表（纯逻辑，禁 import vscode）；`usage/ContextStats.ts` 是上下文圆环 / Tip 的统计（纯逻辑，禁 import vscode，见 `arch/chat-panel-input.md` §5.59）；webview 右栏 Details 由 `html/client/detailPane.ts` 驱动（§5.58） | 聊天 UI / 渲染 / Agent map / 上下文用量 / 右栏 Details |
| `src/ui/chat/shortcuts.ts` | Chat 快捷键默认值、物理键规范化、旧值修复与重复绑定校验；纯逻辑 | 改快捷键格式 / 默认值 / 冲突规则 |
| `src/ui/chat/ChatPanelHost.ts` | 面板核心（**本仓库最大的文件，用 grep 定位、勿整读**）：记录、协议、标签、权限/表单呈现 | 面板行为 |
| `src/ui/chat/ChatViewProvider.ts` | 侧边栏 `vac-chat`、编辑区主面板与单面板多标签 Side 的装配/销毁及主双面焦点同步（视图上唯一的消息监听器） | 视图注册 / surface 归属 |
| `src/ui/chat/ChatEditorPanel.ts` | 编辑区主标签页（第二个 surface） | 编辑区面行为 |
| `src/ui/chat/SideChatPanel.ts` | `vac-side-chat` 临时面板：每次打开新建 Side tab，成员/引用按 sessionId 隔离，异常只回滚本次 fork；活动 tab 右邻优先后继，源关闭批量清理其子 Side，不注册 serializer | Side 生命周期 |
| `src/ui/SessionTreeProvider.ts` | Agents 树：agent → 会话（来源 `session/list` 或本地缓存）；刷新已合并节流（50ms） | 树结构 / 右键菜单 |
| `src/ui/StatusBarManager.ts` | 状态栏 `$(hubot) VAC: <status>` | 状态显示 |
| `src/dashboard/` | Dashboard 视图与用量统计（数据层纯逻辑，见 `docs/dashboard-design.md`） | 统计指标 / 数据源 |
| `src/utils/Logger.ts` | VAC / VAC Traffic 双通道；traffic 默认关闭，`LogPrivacy.redactTraffic` 脱敏内容/凭证；`FileLog` 1MB 排队、运行中 5MB 轮转、串行 flush；deactivate 等待刷盘 | 隐私 / 轮转 / 退出刷盘 |
| `src/utils/BuildInfo.ts` | 构建指纹（版本·git sha·打包时间·bundle 哈希）；`readPackageVersion()` 也被 `ConnectionManager` 用作 `clientInfo.version` | 日志身份标识 |
| `src/test/*.test.ts` | 真实 Extension Host 的 mocha 测试（**用 Tab 缩进**） | 改扩展 id / 命令前缀 / 面板协议 |
| `src/**/*.spec.ts` | vitest 纯逻辑测试（2 空格，禁 import `vscode`） | 改对应纯逻辑模块 |
| `resources/icon.svg` | 活动栏容器图标（24×24 单色 `currentColor`，`viewsContainers.activitybar`） | 改侧边栏图标外观 |
| `resources/icon-editor-color.svg` | 编辑区标签栏按钮的图标（全彩徽标：蓝→紫渐变底 + 白色标记，与 `icon.png` 同一几何/配色） | 改那颗按钮外观（同经 `make-icon.mjs` 生成，别手改） |
| `resources/icon.png` | 128×128 插件徽标（`package.json` 的 `icon`）＋编辑区标签页图标（`ChatEditorPanel` 的 `iconPath`） | 改徽标外观 |
| `scripts/make-icon.mjs` | **图标的唯一几何源**：一份几何同时产出 `icon.svg` 与 `icon.png`（SDF 光栅化 + zlib 手写 PNG，零依赖）；`npm run icon`，`--preview` 另出多尺寸预览图到系统临时目录 | 改图标外观 |

---
## 2. 按「我要做什么」反查代码位置（任务 → 入口）

分册：[`arch/task-index.md`](arch/task-index.md)（进程 / 连接 / 会话 / 发消息 / 聊天 UI / 能力 / 侧边栏 / 配置 / Dashboard）。

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
  **子会话 id 先经 `setSessionResolver` 解析到父会话**（`ChatPanelHost.subagentParents`），
  否则未注册的子会话会被判成"无处可画"而弹到窗口顶部 QuickPick；
  会话取消/关闭/断开时，两桥的 `cancelSession` 把待决项答成 cancelled（原始 id 与父 id 双匹配）；
  每个 pending 有 AbortController，fallback 经 `abortable` 竞速，旧弹框即使不配合取消也不堵后续 FIFO；
  QuickPick/InputBox 使用真实 CancellationToken，晚到答案不二次结算。
- **调用链**：`ConnectionManager` → `AcpClientImpl.requestPermission` → `PermissionHandler` → `PermissionBridge` → `ChatPanelHost` 或 QuickPick。
### 3.3 轮次状态与 `vac.turnInProgress`

- **需求语义**：Esc 与标题栏 Stop 只在**有轮次在跑**时可用，且都必须先出 `#stopConfirm`（停止不可逆）。
- **关键坑**：这个上下文键历史上从未被 `setContext`，导致键位是死绑定。
- **正确实现**：`sendPrompt` 进出分别 emit `turn-state-changed`；
  `extension.ts:updateTurnContext` 据此 `setContext('vac.turnInProgress', …)`（现在主要驱动标题栏菜单）。
  **2026-10-29 起 Escape 不再走 workbench keybinding**：webview 的 document 级 Escape（bubble、
  `defaultPrevented` 守卫、IME `isComposing` 跳过）先让浮层/菜单消费，剩下的才显示 `#stopConfirm`。
  标题栏 Stop 与命令面板的 `vac.cancelTurn` 先 `chat.requestStop(id)` → 宿主发 `stopAsk`；
  无可见 surface 时才用非模态通知兜底。只有确认条上的 `data-stop-confirm="stop"` 才发 `cancelTurn`。
- **调用链**：`sendPrompt` → `turn-state-changed` → `updateTurnContext` → `setContext`；
  取消：Esc/Stop → `#stopConfirm` → `cancelTurn` 消息 → `SessionManager.cancelTurn`。

---
### 3.4 生命周期、隔离与工具回收（2026-11-01）

- disconnect 先取消握手/自动恢复，再移除会话并结算两桥；意外退出仅对 resume-capable agent 有界恢复，保留 tab/草稿、不重发 prompt；详见 `arch/connection-lifecycle.md`。
- SessionUpdateHandler 的 sourceAgentId ownership 覆盖早到更新；releaseAgent 清归属且拒绝旧连接晚到数据。SessionStore、openExisting/load/resume 遇跨 agent 同 sessionId 明确拒绝，不静默覆盖（尚未改复合键）。
- TranscriptStore 的 onRemove 在条目限长、会话 LRU、drop/dropAgent 时通知 host；host 只回收已经没有可见引用的 toolCallId 及 entry-id 索引，重复引用保留。
- ToolInvocationStore 的单次消息 JSON 有 128K 字符预算（深度 10、2048 节点、集合 128 项、单字符串 32K）；保留身份字段与显式集合替换语义，contentBlocks 拒绝必需字段缺失的块。活跃会话仍豁免 LRU；agent terminal 的 ID 数量还不是硬上限。
- 轮次结束（`finalizeTurn`）与 `session-load-end` 都会 `ToolInvocationStore.finalizeOpen` 给没有终态的通告盖上 `endedAt`：被取消/中断的 Task 区间不再一直开到 `now`，因而不会把之后所有工具调用吞进它的嵌套窗口。
- `session/load` 回放期间（`SessionManager.isLoading`）记录的 `append/appendText/revise/toolUpdate/markdownRendered` **不下发** webview：加载遮罩已覆盖内容，逐条推送只会灌满 webview 的 FIFO，把用户在加载中切换 tab 的 `focus` 回包压到加载结束之后。回放仍完整落进宿主 store；`session-load-end` 只在**该会话仍是焦点**时补一份 `focus` 快照，绝不把焦点抢回到已切走的会话。

## 4. 数据流 / 接口契约

| 调用方 | 路由 / 入口 | 鉴权 | 关键字段 / 约定 |
|---|---|---|---|
| 扩展 ↔ agent 进程 | ACP over stdio JSON-RPC（`ClientSideConnection`） | `initialize` + `authenticate`（-32000） | 每个请求带 `sessionId`；`session/new\|load\|resume\|fork\|close\|delete` 等控制面调用串行，`prompt` 并发；声明 `session.compaction` 后压缩摘要/实时压缩走 `compaction_update` 并渲染为 compact 记录 |
| 宿主 ↔ Chat webview / 工具栏偏好 | `postMessage`（协议见 `ui/chat/protocol.ts`）+ `workspaceState` + `ChatPanelHost.projectUiPrefs/commitUiPrefs/postUiPrefs` | CSP + nonce，`localResourceRoots` 限定；`canSurfaceAccess` 限定 session；以来源 surface 判定 `main\|side`，不信任客户端自报 scope | 一个视图只有一个 `onDidReceiveMessage`；`SurfaceKey = view\|editor\|side`，Side 消息与 summary 元数据见 `arch/chat-panel.md` §5.7。`vac.outlinePrefs.v1` = Main scoped + 全局字段 + 主 `tabOrder`；`vac.sideUiPrefs.v1` 只存 Side scoped。Tail/Times/Expand/Outline 四组 `BySession/Default` 与大纲布局分域；主 view/editor 共享，Side 独立，真正的全局字段仍共享。scoped 更新定向投影，全局更新分别投三面；boot 保持 `uiPrefs → boot`，详见 `arch/chat-panel-state.md` §5.55 |
| 宿主 ↔ Chat 快捷键 | `UiPrefs.shortcuts` → `uiPrefs`；设置面板 `setSetting(panel.shortcut.<action>)`；懒恢复 `trackRestore` → `restoreFinished` | 宿主校验、webview 仅在本面消费键盘事件 | action 为 scrollTop/scrollBottom/focusInput/previousSession/nextSession/closeSession/restoreClosed；值为规范组合键或 `null`（禁用），仅宿主逐项校验写入；Main/Side 共用，恢复结果定向回复来源面 |
| 宿主 ↔ 自定义模型排序 / Dashboard | Chat：`setModelList` → `SettingItem.modelSync`；Dashboard：`postMessage` | Chat 宿主串行 CAS；Dashboard CSP + 命令白名单 | Chat `requestId` 匹配回执、基线含生效层/目标层/数组签名；Dashboard 见 `dashboard/DashboardModel.ts`，只投 `snapshot` |
| 会话缓存 | `workspaceState`（`SessionHistoryStore`） | —— | key `vac.sessionHistory.v1`，**改名即丢历史**；每条可带 `additionalDirectories`（可选字段，旧记录无需迁移） |
| 跨 IDE 全局配置 | `VAC_HOME/config.json`（默认 `~/.vac`，`GlobalSettings.ts`） | —— | 白名单键（首期 `vac.customModels`）；原子写（临时文件 + rename）；读取顺序：工作区 > 用户 > 全局 > `package.json` 默认 |
| 「Recently used」的删除 | `workspaceState`（`SessionHistoryStore`） | —— | key `vac.recentCwdDismissed.v1`（路径数组）；同一目录新建会话即自动移除 |
| 会话恢复快照 | `globalState`（`ChatPanelHost.saveOpenSessions`） | —— | key `vac.openSessions.v1`；每条 `RecoverableSession` 可带 `app`（写入时的 IDE 标签），与当前环境相同的会在下发前剥掉，只用于标注 |
| 模型切换诊断 | `SessionManager.noteModelChange` | —— | `model <旧> -> <新> (<source>)`，source = `session-response` / `set-response` / `notification`；只在值真的变化时写 |
| 用量索引 | `globalStorageUri` 下 `usage-index.json` | —— | 原子写（临时文件 + rename），损坏则重建 |
| 上下文用量（圆环 / Tip） | 宿主内存 `ChatPanelHost.contextStats` → `meta.usage` → webview | —— | **`used` 只由 `usage_update` 写**；`PromptResponse.usage` 是**本轮**累计（适配器轮次激活时重置），直接记成 `lastTurn`（本轮构成），并给 `history` 追加一个每轮采样点，绝不回写 `used`。`usage.parts`（最近一次调用的 input/output/cache 拆分）来自适配器 `_meta["_claude/usage"]`，圆环据此画「提示 / 输出」双色，缺失退回单色；`rateLimits` 取 `_meta["_claude/rateLimit"]` 每种 type 的最新一份；`subagentCostUsd` 来自 `AgentMapStore.totalCostUsd`；重启 / 重开历史后从 0 重新观察 |
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
| `session-created` | (sessionId, agentName, origin: `'new'` \| `'load'` \| `'resume'` \| `'side'`) | `origin` 为追加参数，老订阅者不受影响；Side 不套用主会话默认配置与恢复快照 |
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
| 记录区渲染 | `html/client/transcriptView.ts`、`toolCallView.ts`、`MarkdownStream.ts`、`scroll.ts` | 折叠、markdown、时间、右键；流式尾块、原生正文窗口与会话锚点恢复见 `arch/chat-performance.md` |
| 无头验收 | `scripts/preview-records.mjs` | 真 Chromium 截图，**别靠推理** |

---

## 6. 运维 / 脚本（构建 / 发布 / 校验）

> 做运维任务只读本节 + `scripts/`，不用打开业务代码。
>
> **与 docs/02 分工**：本节只留**脚本位置指针**；具体**操作步骤/参数/坑**以 [`docs/02-使用说明.md`](docs/02-使用说明.md) 为准。

- CI：`.github/workflows/ci.yml`，Windows/Ubuntu × VS Code 1.85.0/stable，全量 audit 闸门；`scripts/run-tests.mjs` 经 `VSCODE_TEST_VERSION` 选宿主，`src/test/index.ts` 用 Mocha API 串行运行。开发工具要求 Node≥22.13；扩展 bundle target=node18，VS Code 最低仍为 1.85。
- 测试编译：`scripts/compile-tests.mjs` 为 out 的 CJS 测试打包 ESM-only SDK 与 Mocha 串行 API，再 tsc；不依赖新宿主的 require(ESM)，不加载现代 CLI/并行 worker。最低宿主的真实进程夹具各代都传 `--ms-enable-electron-run-as-node`（不只 Windows）；终端测试超时带 PID 计数与 stderr。
- **构建单一源**：`scripts/build.mjs`（esbuild 配置、构建指纹注入都在这一处）。
  产物 `dist/extension.js`，**唯一入口** `src/extension.ts`（`package.json` 的 `main`）；同一脚本把
  `@mermaid-js/tiny` 的 `dist/mermaid.tiny.js` 复制到 `dist/media/`，由 webview 通过 `data-mermaid-src` 懒加载。
- 统一管理脚本：`sh manager.sh help`；文档体检：`sh check-docs.sh`；agent 握手探针：`node scripts/probe-agent-init.mjs --agent "<命令>" [--session] [--out f.json]`（只握手 / 建空会话，输出可能含本机配置，别提交）。
- 开发宿主：`npm run dev:host`（`scripts/dev-host.mjs`，不挂调试器）；断点调试走 `.vscode/launch.json`。无头截图验收：`npm run compile-tests` 后 `node scripts/preview-records.mjs`。
- **图标**：`npm run icon`（`scripts/make-icon.mjs`）。`resources/icon.svg` 与 `resources/icon.png`
  **都是生成物，不要手改**——几何写在脚本顶部的 `MARKS`，改那里再重跑。
  自动生成的图标必须按 `.gitattributes` 的 `*.png binary` 走，否则换行符转换会把 PNG 洗坏
  （v1.0.2 之前的 `icon.png` 就是这么废掉的：0x0D 被剥掉、头部尺寸读成 32768）。

---

## 7. 易踩的坑 / 设计取舍

- **不要往 UI 层加 agent 专有分支**：agent 差异一律经 `agents/AgentProfile.ts` 按 `kind` 分化。
- **纯逻辑模块禁止 import `vscode`**：否则 vitest 无法在裸 node 下加载，纯逻辑测试就跑不起来。
- **webview 视图上只有一个消息监听器**：多注册会收到重复消息；`boot` 消息必须**先注册监听再写 HTML**。
- **取消会话前必须先回答挂起请求**，否则 agent 永久挂起（ACP 契约）。
- **会话早到的通知要缓冲**：`session/new` 响应解析与通知派发之间存在微任务竞态（`PendingSessionState`）。
- **换行符一律 LF**：`.gitattributes` 已钉住；写入 CRLF 会让整文件产生伪差异。
- **webview 的字号/布局改动要先确认预览基准，再谈结论**：`preview-records.mjs` 的预览主题
  缺 `--vscode-font-size` 这类**非配色** token 时，页内 `em` 的解析基准会静默跑偏
  （实测放大 ~1.79×），真机的问题在截图里复现不出来、"看着挺好"是假绿。
  `#tabsprobe` 读数里的 `baseFont` 必须是 13px —— 见 `docs/pitfalls.md` #66。
