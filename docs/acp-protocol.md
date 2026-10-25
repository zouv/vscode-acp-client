# ACP 协议接口 · 插件使用情况对照

> **这份文档是什么**：把 **ACP 协议接口全貌** 与 **claude-agent-acp 适配器功能全貌**
> 各盘一遍，并逐条标注「本插件已用 / 未用但值得补 / 未用可暂不使用」。
> 它是**维护者视角的对照表**——决定「下一步补哪个能力」时先读它，不必再去翻 SDK 的 `.d.ts` 或抓包。
>
> **面向人**（维护者），与面向 AI 的 [`ARCHITECTURE.md`](../ARCHITECTURE.md)（代码在哪）分工不同：
> 这里回答「协议/适配器**有什么**、我们**用没用**、**要不要补**」。

## 记录元信息（更新时请改这里）

| 项 | 值 |
|---|---|
| **记录时间** | 2026-10-16 |
| **本插件版本** | `1.3.0` |
| **插件侧 ACP SDK** | `@agentclientprotocol/sdk` **1.8.0**（`package.json` 声明 `^1.7.0`，实际解析到 1.8.0） |
| **claude-agent-acp（官方）** | **0.91.0**（本文档编写时官方最新 tag `v0.91.0`） |
| **claude-agent-acp（本仓 fork）** | `zouv/claude-agent-acp`，基点 **0.91.0** + 1 个自研提交（`_meta.extraModels`）；2026-10-16 由 0.89.1 升级并推送 |
| **证据来源** | ① SDK `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts`（`methods` 常量 + `Agent`/`Client` 接口）② 插件代码 `src/**`（grep 方法名）③ 真实抓包夹具 `src/test/fixtures/claude-code-*.json`、`session-cwd-probe.json`（由 `scripts/capture-acp-replay.mjs` / `scripts/probe-session-cwd.mjs` 生成） |

### 下次怎么更新这份文档（≈10 分钟）

1. **ACP 接口面变了吗**：看 SDK 的 `acp.d.ts` 里 `export declare const methods`（agent/client 两侧方法常量）与 `interface Agent` / `interface Client` 有无新增方法；比对本表 §1。
2. **插件用了哪些**：`grep -rn "connection\.\(newSession\|loadSession\|…\)" src/` 与 `AcpClientImpl.ts`（客户端能力门面）；比对本表 §1 的「已用」列。
3. **适配器功能面变了吗**：重跑 `scripts/capture-acp-replay.mjs` 刷新 `src/test/fixtures/*.json`，看 `agentCapabilities` 与 `notificationCounts`；或读适配器仓库 `src/` 目录名（每个扩展能力基本一个文件）；比对本表 §2。
4. 改完把上面「记录时间 / 各版本号」一并更新。

---

# 第一部分 · ACP 协议接口全貌

> 方法名 → 本插件使用情况。**能力门槛**指 agent 需在 `initialize` 响应里声明对应能力，否则不可用。
> 图例：**✅ 已用** · **🟡 未用但值得补** · **⚪ 未用可暂不使用**。

## 1.1 Agent 侧请求（插件作为 Client 发起，`Agent` 接口上的方法）

| 方法 | 说明 | 能力门槛 | 插件使用情况 |
|---|---|---|---|
| `initialize` | 握手 / 版本与能力协商 | 必须 | **✅** `ConnectionManager.connect()` |
| `authenticate` | 交互式认证（`-32000` 后重试） | `auth` | **✅** [`core/auth.ts`](../src/core/auth.ts) `runAuthFlow` |
| `logout` | 登出当前认证方式 / 清理凭证 | `auth.logout` | **✅** `SessionManager.logout` + 命令 `vac.logoutAgent`（2026-10-25 接入；同时清掉本客户端存的 API key） |
| `session/new` | 新建会话 | 必须 | **✅** `SessionManager.newAcpSession` |
| `session/load` | 载入历史（**重放全部消息**） | `loadSession` | **✅** `SessionManager.loadSession` |
| `session/resume` | 恢复会话（**不重放**） | `session.resume` | **✅** `SessionManager.resumeSession` |
| `session/list` | 列出会话（分页 / 按目录过滤） | `session.list` | **✅** `SessionManager.listSessions` |
| `session/close` | 关闭会话 | `session.close` | **✅** `SessionManager.closeSession` |
| `session/delete` | 删除会话 | `session.delete` | **✅** `SessionManager.deleteSession`（2026-10-16 接入） |
| `session/fork` | 分叉会话（**UNSTABLE**） | `session.fork` | **✅** `SessionManager.forkSession`（2026-10-16 接入；消息右键 "Fork from here"） |
| `session/prompt` | 发一轮提示词 | 必须 | **✅** `SessionManager.sendPrompt` |
| `session/set_mode` | 切换模式（Plan/Code/…） | — | **✅** `SessionManager.setMode` |
| `session/set_config_option` | 设配置项（model/effort/…） | — | **✅** `SessionManager.setConfigOption` |
| `providers/list` `providers/set` `providers/disable` | provider 配置（**UNSTABLE**） | `providers` | **⚪** 多 provider 动态配置；插件固定两个 agent，用不上 |
| `nes/start` `nes/suggest` `nes/close` | Next Edit Suggestions（**UNSTABLE**） | — | **⚪** 编辑器内联补全，与聊天面板形态不搭 |

## 1.2 Agent 侧通知（插件 → agent）

| 方法 | 说明 | 插件使用情况 |
|---|---|---|
| `session/cancel` | 取消当前轮次 | **✅** `SessionManager.cancelTurn`（**先回答待决权限/表单再发**） |
| `document/didOpen` `didChange` `didClose` `didSave` `didFocus` | 编辑器文档状态同步（**UNSTABLE**） | **🟡** 让「当前文件上下文」更准；现有 attachFile 覆盖部分，接口可能变 |
| `nes/accept` `nes/reject` | 采纳/拒绝建议（**UNSTABLE**） | **⚪** 同 NES，方向不搭 |

## 1.3 Client 侧请求（agent → 插件；插件需实现的能力）

> 本插件集中在 [`core/AcpClientImpl.ts`](../src/core/AcpClientImpl.ts)（门面）与 `src/handlers/*`。

| 方法 | 说明 | 能力门槛 | 插件使用情况 |
|---|---|---|---|
| `session/request_permission` | 权限请求 | — | **✅** `PermissionHandler` → `PermissionBridge` |
| `fs/read_text_file` | 读文件 | `fs.readTextFile` | **✅** `FileSystemHandler.readTextFile` |
| `fs/write_text_file` | 写文件 | `fs.writeTextFile` | **✅** `FileSystemHandler.writeTextFile` |
| `terminal/create` `output` `wait_for_exit` `kill` `release` | 终端五连 | `terminal` | **✅** 五个全实现（`TerminalHandler`） |
| `elicitation/create` | 发起表单 | `elicitation.form` / `.url` | **✅ 仅 form 模式**；`url` 模式刻意未声明（见 [`ConnectionManager.ts`](../src/core/ConnectionManager.ts) 注释） |

**插件在 `initialize` 里声明的 `clientCapabilities`**（[`ConnectionManager.ts`](../src/core/ConnectionManager.ts)）：
`fs.{readTextFile,writeTextFile}` · `terminal:true` · `elicitation:{form:{}}` · `subagents:{}` · `session.configOptions.boolean:{}`（2026-10-25 起，布尔配置项按 `{type:'boolean', value}` 设置）。

## 1.4 Client 侧通知（agent → 插件）

| 方法 | 说明 | 插件使用情况 |
|---|---|---|
| `session/update` | **核心流式通道**（消息块 / 工具调用 / plan / 用量 / 命令 / 配置…全走它） | **✅** `SessionUpdateHandler` → 面板 |
| `elicitation/complete` | url 模式表单回执 | **⚪** 仅当支持网页表单才需要；当前刻意只声明 form |

## 1.5 协议级

| 方法 | 说明 | 插件使用情况 |
|---|---|---|
| `$/cancel_request` | SDK 层取消**单个在途请求** | **⚪** SDK 机制；插件用 `session/cancel` 已满足需求 |

## 1.6 `session/update` 的更新类型（`SessionUpdate` 联合）

| 更新类型 | 说明 | 插件使用情况 |
|---|---|---|
| `agent_message_chunk` | 助手正文流 | **✅** |
| `agent_thought_chunk` | 思考流（折叠） | **✅** |
| `user_message_chunk` | 用户消息（重放时回放） | **✅** |
| `tool_call` / `tool_call_update` | 工具调用与状态更新 | **✅** |
| `plan` | 计划块（整体替换） | **✅** |
| `available_commands_update` | 斜杠命令 / skills 列表 | **✅** |
| `current_mode_update` | agent 自主切模式 | **✅** |
| `config_option_update` | 配置项变化 | **✅** |
| `usage_update` | token 用量 / 模型 | **✅** |
| `session_info_update` | 会话标题等元信息 | **✅** |
| `subagent_spawned` / `subagent_state_update` | **子会话**派生与状态（draft，PR #1992） | **🟡** 见 §2.5 |
| `async_task_spawned` / `async_task_progress` / `async_task_state` | 后台异步任务 | **🟡** 面板已有「后台子任务」呈现；可对照补 |

---

# 第二部分 · claude-agent-acp 功能全貌

> **它是什么**：Claude Code CLI 的 ACP 适配器（npm `@agentclientprotocol/claude-agent-acp`，作者 Zed Industries，
> 原 `@zed-industries/claude-code-acp`），把 Claude Code 包装成标准 ACP agent，供任意 ACP 客户端拉起。
> 声明版本见抓包 `agentInfo`（本仓夹具抓到 0.84.0；fork 基点 0.89.1；官方最新 0.91.0）。

## 2.1 握手 / 能力（抓包 `agentCapabilities` 实录）

```jsonc
{
  "loadSession": true,
  "sessionCapabilities": { "additionalDirectories": {}, "close": {}, "delete": {},
                           "fork": {}, "list": {}, "resume": {}, "subagents": {} },
  "promptCapabilities": { "image": true, "embeddedContext": true },
  "mcpCapabilities": { "http": true, "sse": true },
  "auth": { "logout": {} },
  "providers": {},
  "_meta": { "claudeCode": { "promptQueueing": true }, "authStatus": {} }
}
```

| 能力 | 含义 | 插件使用情况 |
|---|---|---|
| `loadSession` | 支持 `session/load` 重放 | **✅** |
| `sessionCapabilities.list/close/resume/new` | 会话生命周期 | **✅** |
| `sessionCapabilities.delete` | 支持 `session/delete` | **✅** 已接（Agents 树右键 Delete Session） |
| `sessionCapabilities.fork` | 支持 `session/fork` | **✅** 已接（助手消息右键 Fork from here） |
| `sessionCapabilities.additionalDirectories` | 支持额外根目录 | **✅** 输入框 `+` 菜单 → Workspace directories |
| `sessionCapabilities.subagents` | **子会话**（把每个子 agent 暴露成子 ACP 会话） | **✅** 已接（卡片 + 取消）；子会话输出内联在父会话，见 §2.5 |
| `promptCapabilities.image` | 支持图片输入 | **✅** 输入框粘贴/拖图 → ACP `image` 块 |
| `promptCapabilities.embeddedContext` | 支持内嵌上下文（文件/选区引用） | **✅（部分映射）** 见 §2.4 |
| `mcpCapabilities.http/sse` | 会话可注入 MCP server | **🟡** 未接，见 §2.6 |
| `auth.logout` | 可登出 | **✅** 已接（`vac.logoutAgent`） |
| `providers` | 多 provider（UNSTABLE，当前空） | **⚪** |
| `_meta.claudeCode.promptQueueing` | Claude Code 侧提示词排队 | **⚪** 与 steering 语义重叠，暂不用 |

## 2.2 会话 / 轮次

| 功能 | 插件使用情况 |
|---|---|
| `session/new` 返回 `modes` + `configOptions` | **✅** 模式/模型下拉 |
| 遵守**会话级 `cwd`**（`session-cwd-probe` 实测 `honours-session-cwd`） | **✅** |
| 流式：`agent_message_chunk` / `agent_thought_chunk` / `tool_call(_update)` / `plan` / `usage_update` / `available_commands_update` / `current_mode_update` / `session_info_update` | **✅** 全接 |
| 权限请求带 `_meta.claudeCode`（command / file_path / toolName…） | **✅** |
| 表单 `AskUserQuestion`：`_meta._askUserQuestionCustomAnswer` 自由文本 + 选项 `description`/`preview` | **✅** |
| 工具集 Bash / Read / Write / Edit / Glob / Grep / **Agent（子代理）** + `_meta.claudeCode.toolResponse` | **✅** 渲染 |
| `_meta.extraModels`（客户端注入自定义模型） | **✅** 本仓 fork 的自研扩展 |

## 2.3 值得补的（汇总）

| 功能 | 价值 | 备注 |
|---|---|---|
| `session/delete` | **高** — 真删 agent 侧会话，成本最低 | ✅ 已完成（2026-10-16） |
| `logout` | **高** — 账号切换 / 清 OAuth 凭证 | ✅ 已完成（2026-10-25） |
| `session/fork` | **中高** — 从某条消息分叉出新会话 | ✅ 已完成（2026-10-16）；UNSTABLE |
| 图片输入 | — | **已实现**（§2.4 逐条核实） |
| `additionalDirectories` | — | **已实现** |
| `embeddedContext` | — | **已实现（部分映射）** |
| `subagents`（session 级） | **中** — 子 agent 可观察/可取消 | ✅ 已完成（2026-10-16）；见 §2.5 |
| `mcpCapabilities` | **中** — 会话级 MCP server 配置 | 需 UI |
| `document/did*` | **低** — 当前文件上下文更准 | UNSTABLE |

## 2.4 「已实现」三项的逐条核实（2026-10-16）

| 项 | 结论 | 证据 |
|---|---|---|
| **图片输入（image）** | ✅ **已实现** | 输入框粘贴/拖拽图片 → [`ChatPanelHost.ts`](../src/ui/chat/ChatPanelHost.ts) `attachImage` 存字节 → 发送时转 ACP `image` ContentBlock（`{type:'image',data,mimeType}`）；草稿页 `addDraftImage`；单测 `chat-panel.test.ts:1937`「image attachments」整套 |
| **additionalDirectories** | ✅ **已实现** | 输入框 `+` 菜单 → `pickDirectory`(`purpose:'additionalDirectories'`) → 草稿 chips 行 `#additionalDirectories`；建会话时经 `SessionManager.newAcpSession` 的 `additionalDirectories` 传入（**先按能力校验**再发）；已有会话只读 |
| **embeddedContext** | ✅ **已实现（部分映射）** | 文件引用 → ACP `resource_link` 块（`ChatPanelHost.ts:1091`）；编辑器「当前打开文件 + 选区行区间」经 `readActiveFileFrom` 进引用栏；IDE 注入的 `<ide_opened_file>` 渲染成消息上的文件 chip。**注意**：`embeddedContext` 是 agent 的 `promptCapabilities`（它**能收**内嵌上下文），客户端侧我们用的正是 `resource_link`/文本块这一路，属正确映射 |

## 2.5 `subagents`（session 级）是什么

**一句话**：把 Claude Code 的**子 agent**（Task/Agent 工具派生的子代理）提升为**子 ACP 会话**——
宿主不再只看到「父会话里一个 tool_call」，而是能收到 `subagent_spawned`（带 `subagentSessionId`、名称、任务、prompt）
与 `subagent_state_update`（completed / failed / cancelled / disconnected），从而**单独观察、甚至取消/关闭**某个子会话。

- **触发**：客户端需在 `initialize` 的 `clientCapabilities` 里声明 `subagents`（或 AIR 扩展 `nativeSubagentSessions`），
  适配器才 `clientSupportsSubagents(...) === true` 并开始推送子会话通知（见适配器 `src/acp-subagents.ts`）。
- **协议状态**：还是 **draft**（对应 agent-client-protocol PR #1992），SDK 尚未导出类型，适配器用临时类型兜着。
- **与现有「子 agent 分组」的区别**：本插件面板现在把子 agent 的 tool_call **折叠进父工具卡**（按 `rawInput.subagent_type` 判据），
  这是**纯前端分组**；session 级 subagents 是**协议级子会话**，能做前者做不到的事（子会话级取消/独立生命周期）。
- **结论**：**中价值**——如果希望「子 agent 可单独中止 / 有独立记录流」，值得接；否则现有折叠已够用。

### 本插件怎么接的（2026-10-16）

- 在 `initialize` 的 `clientCapabilities` 声明 `subagents: {}`。适配器据此走 **rfd 形态**，发
  SDK 已类型化的 **`subagent_update`**（`sessionId`=子、`title`/`description`/`capabilities`(含
  `cancel`)/`state`）。**注意**：不声明则适配器一条子会话通知都不发；而一旦声明，它会把子会话
  **自己的流量改路由到子 sessionId**（适配器 `if (!this.enabled) return notification`）。
- 落法：宿主把子会话 **别名回父会话**再照原样渲染（现有渲染与子 agent 分组因此不受影响），另外在父
  会话里加一张「身份 + 工作状态 + **Cancel**」的卡。取消 = 对**子会话 id** 发 `session/cancel`。
- 卡片**不**重复子会话的输出（它内联在父会话里），也**不是**可折叠容器。
- **易踩**：适配器另有一个更老的 `subagent_spawned` / `subagent_state_update` 形态（它自带的临时类型）；
  客户端声明 `subagents` 后走的是 `subagent_update`，**两者别混**。

## 2.6 `mcpCapabilities` / `document/did*`（补充说明）

- **`mcpCapabilities`（http/sse）**：`session/new` 的请求可带 `mcpServers`，让用户为某会话挂 MCP server。
  现在插件没暴露入口（agent 侧用 Claude Code 自己的 MCP 配置）。要「客户端管 MCP」才有价值。
- **`document/did*`（UNSTABLE）**：把编辑器打开的文档/改动/保存/焦点推给 agent。现在靠 attachFile 手动附加，
  自动同步能让「当前文件」上下文更准，但接口未稳定。

---

# 第三部分 · codex-acp 对照（2026-10-25，`@agentclientprotocol/codex-acp` 2.2.2）

> 旧包 `@zed-industries/codex-acp` 已于 2026-07 归档，npm 标 deprecated、冻结在 0.16.0；新包基于 Codex App Server。
> 证据：`node scripts/probe-agent-init.mjs --session` 实测握手 + 适配器 `dist/index.js` 源码。

| 项 | 实测 / 源码 | 插件处理 |
|---|---|---|
| 能力 | `loadSession`；`sessionCapabilities` 含 list / resume / close / delete / fork / additionalDirectories / subagents；`promptCapabilities` image + embeddedContext；`mcpCapabilities.http`；`auth.logout`；`_meta.steering.supported` | 全部走通用路径，无需 Codex 分支 |
| 认证方式 | `api-key`（`_meta['api-key'].provider`）、`chat-gpt`；`NO_BROWSER` 时为 `chat-gpt-device-code`；客户端声明 `auth._meta.gateway` 才有 `gateway` | **✅** api-key：客户端输入 key → `authenticate._meta['api-key'].apiKey`，存 SecretStorage；留空则用 agent 环境里的 `CODEX_API_KEY` / `OPENAI_API_KEY`。gateway 未接 |
| 会话配置项 | `mode`（read-only / workspace-write / agent / agent-full-access）、`collaboration_mode`、`model`、`reasoning_effort`（category `thought_level`）；同时给旧式 `modes` / `models` | 输入卡按 configOptions 通用渲染 |
| 命令输出 | 不走客户端 `terminal/create`：工具卡 content 放 `{type:'terminal', terminalId:<toolCallId>}`，输出分片在 `_meta.terminal_output_delta`，结束在 `_meta.terminal_exit`；无终端的命令 `rawOutput` 只有 `{exit_code}`、输出进 content 文本 | **✅** `transcript/agentTerminals.ts` 累加并渲染成 console 文本。**不要**为此声明 `_meta.terminal_output_delta`：Claude 适配器也认这个键，会改变它的 Bash 输出形态 |
| plan | 客户端没声明 `plan` 能力时，计划以**助手消息文本**下发 | 🟡 声明 `plan` + 渲染 `plan_update` 后可得结构化计划 |
| AIR 扩展 | 声明 `_meta.jetbrains.air` 才启用 diff patch / goal / 后台终端任务 / session failure | ⚪ 暂不接 |
| 自定义模型 | 不认 `_meta.extraModels`（本仓 Claude fork 的扩展）；Codex 走自己的 `config.toml` / `CODEX_CONFIG` / `MODEL_PROVIDER` | profile 对 codex 不注入 |

