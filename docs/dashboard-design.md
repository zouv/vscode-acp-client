# Dashboard（侧边栏 webview）· 设计

功能落点：在既有的 `vac-client` 容器里放一个视图 id 为 `vac-dashboard` 的 webview——用量统计 + 快捷操作。
**不用** `retainContextWhenHidden`、**不给 webview 代码上打包器**、**不加新依赖**。

## 数据源

| Agent | 根目录 | 状态 |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl`（可覆盖：设置 `vac.dashboard.claudeProjectsDir`） | 已对真机文件核过 |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 已对真机文件核过 |

**Claude 的行形状**（实测）：每行一个 JSON 对象，`type: "assistant"`，带 `message.model`、`message.id`、
`message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`，
外加 `timestamp`、`cwd`、`sessionId`，以及可选的 `requestId`、`isSidechain`。
同时还有 `type: "user"` / `"attachment"` / `"queue-operation"` 记录——**跳过**。有些记录的 `usage`
是空或近乎空的；token 全零的条目不计数。很多转录里**没有** `requestId`，所以去重键必须在它缺失时也成立。
子 agent 的转录在 `<session>/subagents/*.jsonl`，必须一起走。

**Codex 的行形状**（实测）：`session_meta`（含 `payload.id` / `session_id`、`cwd`、`forked_from_id`）、
`turn_context`（`payload.model`、`payload.turn_id`），以及 `event_msg` 里 `payload.type = "token_count"`
的那条，带 `info.total_token_usage` + `info.last_token_usage`，两者都是**累计**计数；会话早期 `info`
可能是 `null`。**模型只出现在 `turn_context` 里**，token 记录里没有。

## 去重规则

- **Claude 键**：`c|<message.id>|<requestId ?? ''>`。流式写入会让同一个 id 的 `output_tokens` 增长，
  所以解析器用一个以 id 为键的 `Map`，**后写覆盖先写**；后一次扫描再见到同一个键就替换掉早先那条。
- **Codex 键**：`x|<session id>|n<ordinal>`（ordinal 每行唯一，重放行会跳过）。
- **fork 出来的 Codex rollout 会重记更早的回合**：当当前回合的 UUIDv7 时间戳早于 `session_meta.forked_from_id`
  自己的时间戳时，解析器把该文件标为 *replay*，不产出这些样本（它们本就属于父会话）。
- 每个事件都带自己的键，`UsageIndex` 按键 upsert，所以重读一个文件（截断/替换后重扫、进程重启丢掉游标）
  **绝不会重复计数**。

## 增量索引

- **逐文件游标** `{size, mtimeMs, offset, extra?}`，可 JSON 序列化并持久化；`extra` 存 Codex 的
  session / model / cwd 上下文，这样追加的尾巴仍保持身份。
- `(size, mtimeMs)` 都没变 → **整个文件不读**。变长了 → 只读 `[offset, EOF)`，用 `FileHandle` 读循环、
  每块 1 MB；末尾没有 `\n` 的残片留到下次扫描再接。变小了、大小相同但 mtime 变了（原地重写）、
  或 offset > size → **从 0 重扫**。
- 文件按**有界并发（4）**扫描，每个文件之后、以及连续解析每满 8 ms 就让一次 `setImmediate`，
  保证扩展宿主不被阻塞。本机实测：2 148 个文件 / 2.2 GB → 首扫约 5 秒、重扫约 0.2 秒，无全量历史卡顿。
- `UsageIndex` **从不存原始事件**。它聚合进 `(day, agent, model, project)` 行，外加一张有界的
  最近键表（默认 20 000 条）用于后写覆盖的 upsert。超过 60 天的日子折进单个 `0000-00-00` 归档桶——
  这样"全部时间"的总数仍然精确，而行数保持平坦（也顺带解决了某一天活过 30 天窗口后的分桶问题）。
- **持久化**：单个 JSON 文件（`usage-index.json`），内容 `{version, savedAt, states, index}`，
  原子写（临时文件 + rename，Windows 共享冲突重试 3 次），扫描期间每 5 秒最多写一次、结束时再写一次。
  文件缺失/损坏/版本不匹配 → **从头重建，绝不抛错**。

## 成本口径的注意事项

`estimateCost` 按**等效 API 列表价**计价（每百万 token），按最长匹配的模型前缀（`opus`/`sonnet`/`haiku`）选档，
缓存写 ×1.25 输入价、缓存读 ×0.1 输入价。**订阅（Pro/Max）用户并不按此计费**——所以 UI 给每个数字标 `est.`
并带一条说明此事的 tooltip。`PRICING_AS_OF` 是导出的，价格表就是普通数组，改价不用碰逻辑。
表里没有的模型按 0 成本、标 `priced: false`，其 token 计入 `unpriced` 桶（在脚注里呈现）——
**宁可低估，也不给一个悄悄算错的数**。供应商前缀（`anthropic/…`）与后缀（`[1m]`、`-YYYYMMDD`）会先剥掉。

## UI 分区

1. **快捷操作**：页面上只有**两颗文字按钮**，各带一条悬停说明 —— New conversation
   （`vac.newConversation`）、Connect agent（`vac.connectAgent`）。另外两条命令**不在页面上，
   只在视图标题栏**：
   - **Open chat in editor area**（`vac.openChatInEditor`，图标 `$(open-preview)`）——
     标题栏里 **↻ 左侧**那颗，与 Agents 面板（`vac-sessions`）是同一颗；由 `package.json` 的
     `view/title` 贡献，`navigation@0` 因此排在 ↻ 的 `navigation@1` 左边。
   - **Refresh** —— 只有标题栏那颗 ↻：面板每次变为可见又会自己重扫一遍
     （`DashboardViewProvider.setVisible`），页面上再放一颗就是第三个入口。

   所以 `DASHBOARD_COMMANDS`（webview → 宿主的命令白名单）**就是这页面上的两颗按钮**：
   `vac.refreshDashboard` 与 `vac.openChatInEditor` 都不在里面 —— 白名单是"页面",不是"扩展能做的全部"。
2. **Connections**：每个 agent 一行，带状态点与已开会话数。
3. **用量卡片**：Today / 7d / 30d / all-time——in/out/cache token，`est. $` 带 tooltip。
4. **30 天趋势图**：内联 SVG 柱，`currentColor` + VS Code 图表变量，带 `<title>`/`<desc>`。
5. **Top models / top projects**（30 天）：token 条，未定价模型显示 `n/a`。
6. **Recent sessions**：点击发 `{type:'openSession', agentName, sessionId}` → `vac.openSession`。
7. **状态行**：首扫期间显示 "scanning…"，否则显示文件计数或最近一次数据源错误；一个转录都没找到时给友好的空态。

**webview → 宿主**的消息：`{type:'command', id}`（id 按两个命令 id 白名单校验，其它一律丢弃）、
`{type:'openSession', …}`、`{type:'refresh'}`。**宿主 → webview**：`{type:'snapshot', usage, connections, sessions}`，
**只在视图可见时投递**；视图变为可见会触发一次新扫描并投递。严格 CSP（`default-src 'none'`、
内联脚本带 nonce、`style-src` 限定到 webview 源），**不用远程资源，只用 VS Code 变量**。

## 扩展点

- **加一个 agent**：实现 `UsageSource`（`agent` / `scan(state, options)` / `watchRoots()`），
  塞进 `UsageService.sources` —— 索引、持久化与 UI **都不用改**。
- **Codex 真机支持**：`CodexUsageSource` 已经能解析实测到的 rollout 格式；把 `codexSessionsDir`
  指向 `~/.codex/sessions` 即可启用（默认已如此）。
- **加分区**：扩展 `DashboardSnapshot` 与 `renderDashboardHtml` 里的 `render()`。
- 测试用：`UsageService` 接受 `now` / `debounceMs` / `pollMs` / `persistIntervalMs` / `indexOptions`
  与 `watchFactory`；生产入口是 `createUsageService({storageDir, claudeProjectsDir?, now?})`。
