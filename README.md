# vscode-acp-client

在 VS Code 里通过 **ACP（Agent Client Protocol）** 与 AI 编码 agent 对话：
已配置的 agent（Claude Code、Codex CLI）以聊天会话的形式出现，带流式记录、工具调用渲染、
权限卡片、表单、多会话标签页与用量统计面板。

## 技术栈

TypeScript + VS Code Extension API；ACP 客户端（`@agentclientprotocol/sdk`，stdio 上的 JSON-RPC）；
esbuild 打包；vitest（纯逻辑）+ `@vscode/test-cli`/mocha（真实宿主）。
> 选型理由与各组件职责分工见 [`docs/01-技术栈说明.md`](docs/01-技术栈说明.md)（单一信息源，勿在此重复维护）。

## 主要功能

- **多 agent、多会话**：可同时连接多个 agent，每个承载多个会话标签页；切换标签不会重新向 agent 拉历史。
- **双视图聊天**：侧边栏与编辑区标签页并存，共享同一份记录。
- **工具调用渲染**：diff、文件读取、终端输出、嵌套子任务调用、图片。
- **面板内权限与表单**：权限请求与 ACP 表单渲染成会话内的卡片；面板不可见时回退到弹框。
- **会话历史**：重开历史会话（可重放历史，或轻量恢复），支持跨工作目录。
- **用量 Dashboard**：token 与等价成本估算，按模型/项目拆分，30 天趋势，最近会话与快捷操作。
- **自定义模型**：`vac.customModels` 经 ACP `_meta.extraModels` 注入 agent 的模型列表。

## 快速开始

```bash
# 1. 安装依赖（首次）
npm install

# 2. 启动开发宿主（编译 + 打开一个新窗口）
npm run dev:host
```

在宿主窗口里打开活动栏的 **VAC** 容器，选择 agent 连接即可。默认配置经 `npx` 拉起
`@agentclientprotocol/claude-agent-acp`（Claude Code）或 `@zed-industries/codex-acp`（Codex CLI）。

## 常用命令

```bash
npm run compile        # esbuild 打包（dist/extension.js）
npm run watch          # 增量构建
npm run dev:host       # 编译 + 启动 Extension Development Host
npm run typecheck      # tsc --noEmit
npm run lint           # eslint --max-warnings 0
npm run test:unit      # vitest（纯逻辑，秒级）
npm test               # 编译 + lint + 真实 Extension Host 测试
npm run package        # 生产打包
sh manager.sh help     # 查看统一管理脚本的全部命令
sh check-docs.sh       # 文档体系机械体检
```

## 项目结构

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
docs/                   使用/维护文档（面向人）
AGENTS.md               AI 工作铁律（AI 开工先读）
ARCHITECTURE.md         代码链路图谱（面向 AI）
ROADMAP.md              开发路线图（总体计划与完成度）
CHANGELOG.md            发布变更记录（按版本）
HANDOFF.md              会话接力（进行中状态）
manager.sh              统一管理脚本
```

## 许可证

MIT — 见 [LICENSE](LICENSE)。

> AI 协作说明：本项目采用一套「AI 协作文档体系」，AI 代理开工请先读 [`AGENTS.md`](./AGENTS.md)。
