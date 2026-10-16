<div align="center">

<img src="resources/icon.png" width="120" alt="VAC icon" />

<h1>VAC · Agent Client for VS Code</h1>

<p><b>在 VS Code 里和 AI 编码 agent 聊天 —— 一个不绑定模型厂商的 ACP 客户端。</b></p>

[![Release](https://img.shields.io/github/v/release/zouv/vscode-acp-client?label=release&color=3b82f6&style=flat-square)](https://github.com/zouv/vscode-acp-client/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC?style=flat-square)](https://code.visualstudio.com/)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933?style=flat-square)](https://nodejs.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](#贡献)

[特性](#特性) · [安装](#安装) · [快速开始](#快速开始) · [配置](#配置) · [命令与快捷键](#命令与快捷键) · [数据与隐私](#数据与隐私) · [常见问题](#常见问题) · [开发](#开发) · [贡献](#贡献)

</div>

---

VAC 是一个 [ACP（Agent Client Protocol）](https://agentclientprotocol.com/) 客户端：它把你已经配好的 agent CLI（Claude Code、Codex CLI…）**拉成子进程**，用 stdio 上的 JSON-RPC 通信，再把会话渲染进 VS Code 的侧边栏与编辑区 —— 流式输出、工具调用、diff、权限卡片、表单、多会话标签页、用量统计面板。

> **只实现协议，不绑定厂商。** 与「把某个 agent 焊死在一个扩展里」不同，任何说 ACP 的 agent 都能接进来：新增一个 agent 通常只需要在设置里加一条 `vac.agents` 配置。

> 项目状态：v1.3.0，早期阶段，接口与设置项仍可能变动。VS Code Marketplace 上架中，目前请从 [Releases](https://github.com/zouv/vscode-acp-client/releases) 安装 VSIX。

## 目录

- [特性](#特性)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [命令与快捷键](#命令与快捷键)
- [数据与隐私](#数据与隐私)
- [常见问题](#常见问题)
- [路线图](#路线图)
- [开发](#开发)
- [贡献](#贡献)
- [致谢](#致谢)
- [许可证](#许可证)

## 特性

**多 agent、多会话**

- 同时连接多个 agent，每个 agent 各带自己的会话列表；断开/重启某个 agent 不影响其它 agent。
- 每个 agent 可承载多个会话标签页，切标签**不会**重新向 agent 拉历史。
- 会话历史可重开：agent 支持 `session/list` 就以 agent 为准，否则用本机缓存，支持跨工作目录打开。
- **Fork from here** —— 在助手的任意一条消息上右键，以它为分叉点派生一个新会话。
- **Delete Session** —— 真删除：先取消/关闭活会话，再向 agent 发 `session/delete`，最后清掉本地缓存。

**聊天与交互**

- **双聊天面并存**：侧边栏 Chat 视图与编辑区标签页共享同一份记录，关掉再打开不丢内容，两个面各记各的焦点会话。
- **工具调用渲染**：diff、文件读取、终端输出、嵌套子任务调用、图片，都在记录里按类型渲染。
- **权限与表单**：ACP 的权限请求与表单（如 Claude Code 的 AskUserQuestion）渲染成会话内的卡片；面板不可见时自动回退到 VS Code 弹框。带预览的选项会就地展开示意内容。
- **轮次中补发**：agent 声明支持 steering 时，轮次进行中再发一条消息会追加进当前轮次，而不是排成新一轮。
- **sub-agent 子会话卡**：agent 声明 `subagents` 能力后，它派生的每个子 agent 在父会话里显示为一张卡（名字 + 工作状态 + Cancel）。
- `/` **命令按钮**：一键弹出 agent 提供的斜杠命令列表，选中后写入 `/命令`。

**用量与统计**

- **Dashboard**：token 与等价成本估算，按模型 / 项目拆分，30 天趋势，连接状态与最近会话。
- **自定义模型**：`vac.customModels` 经 ACP `_meta.extraModels` 注入 agent 的模型列表。

**隐私**

- **无遥测** —— 不联网上报任何东西，所有数据都留在你本机（见[数据与隐私](#数据与隐私)）。

## 安装

### 从 VSIX 安装（当前推荐）

到 [Releases](https://github.com/zouv/vscode-acp-client/releases) 下载最新的 `vscode-acp-client-<version>.vsix`，然后：

- **图形界面**：扩展面板 → 右上角 `…` → *从 VSIX 安装…* → 选中刚下载的文件；或
- **命令行**：

  ```bash
  code --install-extension vscode-acp-client-<version>.vsix
  ```

### 从源码运行（开发）

```bash
git clone https://github.com/zouv/vscode-acp-client.git
cd vscode-acp-client
npm install
npm run dev:host      # 编译 + 打开 Extension Development Host
```

宿主窗口里打开活动栏的 **VAC** 图标即可看到三个视图；改完代码按 `Ctrl+R` 重载生效。完整开发流程见 [`docs/dev-workflow.md`](docs/dev-workflow.md)。

## 快速开始

### 1. 前置条件

| 依赖 | 用途 | 是否必须 |
|---|---|---|
| VS Code ≥ 1.85 | 宿主 | 必须 |
| Node.js ≥ 20（含 `npx`） | 默认 agent 经 `npx` 拉起 ACP 适配器 | 必须 |
| 可用的 agent CLI | 真正干活的 agent（Claude Code / Codex CLI） | 必须 |
| `git` | 构建指纹取提交号 | 可选 |

### 2. 连接你的第一个 agent

1. 打开活动栏 **VAC** → **Agents** 视图，点某个 agent 行的插头图标（或命令面板 `VAC: Connect to Agent`）。
2. 展开该 agent 可以看到它的会话；点一条即打开。
3. 在 **Chat** 视图里输入并发送。工具调用、权限卡片、表单都会渲染在记录里。

> **首次连接会慢一些**：默认配置走 `npx` 拉起适配器，第一次要先下载安装包。这段时间日志里会有 `[<agent> stderr]` 的下载输出、面板显示「Connecting…」，都属正常。

默认已经配好两个 agent：

| 名称 | `kind` | 命令 |
|---|---|---|
| Claude Code | `claude` | `npx -y github:zouv/claude-agent-acp` |
| Codex CLI | `codex` | `npx @zed-industries/codex-acp@latest` |

要接别的 agent，加一条 `vac.agents` 配置即可（`kind` 可省略，会按名称/命令自动推断）；详见[配置](#配置)。

### 3. 界面导览

| 入口 | 是什么 |
|---|---|
| **Dashboard**（侧边栏） | 用量统计：今日 / 7 天 / 30 天的 token 与成本估算、30 天趋势、按模型与项目拆分、最近会话 |
| **Agents**（侧边栏） | agent 与它们的会话树；连接 / 断开 / 重启 / 删除会话都在这里 |
| **Chat**（侧边栏） | 主聊天面板：记录、输入卡、权限与表单卡片、会话标签页 |
| **VAC Chat**（编辑区标签页） | 同一个聊天面板的编辑区形态，适合大屏边写边聊（`Ctrl+Alt+A`，或点编辑区标签栏右侧的插件图标） |

## 配置

全部在 VS Code 设置里（前缀 `vac.`），搜 `vac` 即可看到。

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `vac.agents` | object | Claude Code / Codex CLI | agent 列表：名称 → `{ kind, command, args, env }` |
| `vac.autoApprovePermissions` | `ask` \| `allowAll` | `ask` | 是否自动批准 agent 的权限请求 |
| `vac.autoConnectOnOpen` | boolean | `true` | 打开聊天面板 0.5 秒后自动连接 |
| `vac.restoreSessionsOnOpen` | `ask` \| `always` \| `never` | `ask` | 上次窗口关闭时开着的会话怎么处理 |
| `vac.defaultWorkingDirectory` | string | 空 | 新会话的默认工作目录；留空 = 工作区第一个文件夹 |
| `vac.logTraffic` | boolean | `true` | 是否记录 ACP 协议流水（落到 `VAC Traffic` 通道与日志文件） |
| `vac.customModels` | array | `[]` | 追加进 agent 模型列表的模型（经 `_meta.extraModels` 注入） |
| `vac.dashboard.enabled` | boolean | `true` | 是否扫描本机转录构建用量面板；关掉即停止一切后台扫描 |
| `vac.dashboard.claudeProjectsDir` | string | 空 | 覆盖 Claude 转录目录（默认 `~/.claude/projects`） |

### 接入一个新 agent

```jsonc
{
  "vac.agents": {
    "Claude Code": {
      "kind": "claude",                    // claude | codex | generic（可省略，自动推断）
      "command": "claude-agent-acp",
      "args": [],
      "env": { "ANTHROPIC_API_KEY": "…" }  // 密钥放这里
    }
  }
}
```

- `kind` 决定使用哪个 agent profile（少量按 agent 差异化的行为），未知 agent 用 `generic` 即可。
- `command` / `args` 就是一条普通的子进程命令；只要能说 ACP，任何 CLI 都能接。

> ⚠️ **密钥不要写进仓库文件。** 设置（尤其是用户级设置）是用户本地的，不会进版本库；agent 的凭证请放进 `vac.agents.<名称>.env`。

## 命令与快捷键

| 快捷键 | Windows / Linux | macOS | 作用 |
|---|---|---|---|
| 打开聊天面板 | `Ctrl+Shift+A` | `Cmd+Shift+A` | `VAC: Open Chat Panel` |
| 在编辑区打开聊天 | `Ctrl+Alt+A` | `Cmd+Alt+A` | `VAC: Open Chat in Editor Area` |
| 取消当前轮次 | `Esc` | `Esc` | 仅在轮次进行中且焦点在聊天界面内时生效 |

<details>
<summary>完整命令列表（命令面板里搜 <code>VAC</code>）</summary>

| 命令 | 说明 |
|---|---|
| `VAC: Connect to Agent` / `VAC: Disconnect Agent` / `VAC: Restart Agent` | 连接 / 断开 / 重启 agent 子进程 |
| `VAC: New Conversation` | 新建会话 |
| `VAC: Send Prompt` | 发送输入卡里的内容 |
| `VAC: Cancel Current Turn` | 取消进行中的轮次 |
| `VAC: Attach File to Prompt` | 把文件作为附件加进输入卡 |
| `VAC: Set Agent Mode` / `VAC: Set Agent Model` | 切换 agent 的模式 / 模型 |
| `VAC: Open Chat Panel` / `VAC: Open Chat in Editor Area` | 打开两个聊天面 |
| `VAC: Add Agent Configuration` / `VAC: Remove Agent` | 增删 `vac.agents` 条目 |
| `VAC: Refresh` / `VAC: Refresh Sessions` / `VAC: Refresh Dashboard` | 刷新各视图 |
| `VAC: Show Log` / `VAC: Show Protocol Traffic` | 打开 `VAC` / `VAC Traffic` 输出通道 |

</details>

另有若干不在命令面板、只出现在右键菜单里的命令：会话树的行内菜单（`Open Session` / `Load More Sessions` / `Copy Session ID` / `Delete Session`）、聊天面板里对**助手消息**右键的 `Fork from here`，以及会话**历史弹窗**每一行右端悬停的 `Archive` / `Delete` / `Rename` 三颗图标按钮（Delete 为真删除）。

## 数据与隐私

VAC **不采集、不上报任何数据，没有遥测**。它读写的东西都在你本机：

| 文件 | 内容 | 位置 |
|---|---|---|
| 扩展日志 | 全部宿主日志（含协议流水的镜像，超 5 MB 轮转） | `~/.vac/vac.log` |
| 用量索引 | Dashboard 的聚合结果与文件游标 | `<globalStorage>/usage-index.json` |
| 会话历史缓存 | 本机客户端侧的会话列表（按 agent + 目录分桶） | 扩展 `workspaceState`，key `vac.sessionHistory.v1` |
| 面板偏好 | 标签顺序、大纲宽度、自动连接开关等 | 扩展 `globalState` |
| agent 转录（只读） | Dashboard 的用量来源 | `~/.claude/projects/**`、`~/.codex/sessions/**` |

- `~/.vac` 可用环境变量 `VAC_HOME` 改到别处。
- 真正的会话内容存在 agent 自己的目录里；VAC 只缓存「有哪些会话」。
- `vac.dashboard.enabled` 设为 `false` 可以彻底停掉本机转录的扫描。
- 排查问题时先把日志里的密钥/凭证摘掉再贴到 issue 里。

## 常见问题

**点了连接没反应，或一直停在「Connecting…」？**
看 `VAC` 输出通道与 `[<agent> stderr]`。最常见的原因是 `npx` 正在下载适配器（等它跑完），或 `vac.agents` 里配的命令在本机 PATH 上不存在 —— 类 Unix 下会走 login shell，IDE 的环境变量可能不含 nvm 装的 node。

**按 Escape 不能取消当前轮次？**
取消需要两个条件同时成立：确实有轮次在跑，且焦点在聊天界面内（侧边栏 Chat 视图或编辑区聊天标签页）。焦点在别的编辑器里时 Escape 不会触发取消。

**Dashboard 显示「未定价」？**
该模型不在内置价格表里。补价格见 [`src/dashboard/usage/pricing.ts`](src/dashboard/usage/pricing.ts)（`PRICING_AS_OF` 标注了数据口径）。另外提醒：**成本是估算** —— 按等价 API 价格计算，订阅用户并不按此付费。

**会话列表里看不到某个历史会话？**
agent 支持 `session/list` 时以 agent 为准；否则用本机缓存，而缓存是 `workspaceState` 作用域的，**换工作区就看不到**在别的工作区产生的记录。跨目录打开请从记录区的历史选择器走。

**怎么从头重建统计？**
删掉 `<globalStorage>/usage-index.json` 再刷新 Dashboard。单条会话可在 Agents 树里右键 **Delete Session** 删除（真删除：agent 侧与本地缓存一并清掉）。

**行为不对，怎么自查？**
先确认窗口跑的是当前构建：`VAC` 通道第一行与聊天面板客户端日志里都有构建指纹（版本 · git sha · 打包时间 · bundle 哈希），两处哈希一致才算命中；然后读 `~/.vac/vac.log`。更多排查手法见 [`docs/02-使用说明.md`](docs/02-使用说明.md) 与 [`docs/pitfalls.md`](docs/pitfalls.md)。

## 路线图

计划与完成度以 [`ROADMAP.md`](ROADMAP.md) 为准，发布历史见 [`CHANGELOG.md`](CHANGELOG.md)。近期在做：

- 宿主实测验收（渲染、统计数字与真实运行对账）
- Codex 链路的端到端验证
- 打包体积瘦身
- 上架 VS Code Marketplace（图标已就绪，截图待补）

## 开发

### 技术栈

TypeScript + VS Code Extension API，作为 ACP 客户端用 [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) 走 stdio 上的 JSON-RPC；esbuild 打包成单文件 `dist/extension.js`。测试分两层：vitest 跑纯逻辑，`@vscode/test-cli` + mocha 跑真实 Extension Host。选型理由与组件分工见 [`docs/01-技术栈说明.md`](docs/01-技术栈说明.md)。

### 常用脚本

```bash
npm run compile        # esbuild 打包 → dist/extension.js
npm run watch          # 增量构建
npm run dev:host       # 编译 + 启动 Extension Development Host
npm run typecheck      # tsc --noEmit
npm run lint           # eslint --max-warnings 0
npm run test:unit      # vitest：纯逻辑，秒级
npm test               # 编译 + lint + 真实 Extension Host 测试
npm run package        # 生产打包（压缩，外置 sourcemap）
npm run vsix           # 打 .vsix → release/
npm run icon           # 重新生成 resources/icon.{svg,png}
sh check-docs.sh       # 文档体系机械体检
sh manager.sh help     # 统一管理脚本的全部命令
```

改了纯逻辑模块（`core/SessionStore`、`core/cwd`、`agents/`、`utils/TailBuffer`、`dashboard/usage/`）跑 `npm run test:unit`；改了激活、命令、设置或面板协议跑 `npm test`。

### 项目结构

```
src/extension.ts        激活入口：装配服务、注册视图与命令
src/commands.ts         vac.* 命令注册表
src/agents/             AgentProfile：按 kind 分化的 agent 专有行为
src/config/             AgentConfig（vac.agents）、CustomModels（vac.customModels）
src/core/               传输与编排：AgentManager / ConnectionManager / AgentConnector /
                        SessionManager / SessionStore / SessionHistoryStore / auth / cwd
src/handlers/           ACP 客户端能力：fs / terminal / permission / elicitation / session update
src/ui/                 SessionTreeProvider / StatusBarManager / chat/（聊天面板子系统）
src/dashboard/          Dashboard 视图 + usage/（用量统计的数据层与聚合）
src/test/               真实 Extension Host 的 mocha 测试
resources/              图标（icon.svg 侧边栏 / icon.png 插件徽标）
scripts/                构建、打包、图标生成、无头截图等工具脚本
docs/                   使用与维护文档（面向人）
arch/                   ARCHITECTURE 分册（面向 AI，按模块拆分）
```

### 仓库里的其它文档

| 文档 | 内容 |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 代码链路图谱：文件职责、任务 → 代码位置、数据流与重点链路 |
| [`docs/`](docs/) | 面向人：技术栈说明、使用说明、验收清单、开发流程、踩坑记录、Dashboard 设计、ACP 协议对照表 |
| [`ROADMAP.md`](ROADMAP.md) | 总体开发计划与完成度 |
| [`CHANGELOG.md`](CHANGELOG.md) | 发布变更记录（[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)） |
| [`HANDOFF.md`](HANDOFF.md) | 会话接力：进行中的状态与下一步 |

## 贡献

欢迎 issue 与 PR！

- **提交前请确保全绿**：`npm run lint` + `npm run typecheck` + `npm run test:unit` + `npm test`。
- **提交信息以类别前缀开头**，与 [`CHANGELOG.md`](CHANGELOG.md) 的分类一一对应：
  `新增：` / `变更：` / `修复：` / `移除：` / `废弃：` / `安全：`。
- **代码风格**：2 空格缩进（`src/test/extension.test.ts` 用 Tab）、单引号 + 分号、TypeScript 严格模式、**一律 LF**。
- **不要提交密钥**；包管理器只用 npm；新增顶层目录请同步 `.vscodeignore`，否则会被打进 `.vsix` 发给用户。
- **改了代码结构请同步更新链路图谱** [`ARCHITECTURE.md`](ARCHITECTURE.md) —— 它是后续所有迭代的导航。
- 用 AI 代理参与开发的话，让它**先读 [`AGENTS.md`](AGENTS.md)**。

## 致谢

- [Agent Client Protocol](https://agentclientprotocol.com/) —— VAC 实现的协议本身；ACP 把「编辑器」与「agent」解耦，VAC 是这个约定下的一枚客户端。
- [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) —— 客户端侧的协议类型与连接实现。
- [`zouv/claude-agent-acp`](https://github.com/zouv/claude-agent-acp) —— Claude Code 的 ACP 适配器，本项目默认配置使用的就是它。
- [`@zed-industries/codex-acp`](https://www.npmjs.com/package/@zed-industries/codex-acp) —— Codex CLI 的 ACP 适配器。

## 许可证

[MIT](LICENSE) © 2026 zouv
