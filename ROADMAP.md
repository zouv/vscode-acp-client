# 开发路线图 / Roadmap · vscode-acp-client

> **这是什么**：本项目**总体开发计划**的单一事实源——要做什么、做到哪了、还剩什么。
>
> **三文档分工（别重复存放同一内容）**：
> - **本文件（ROADMAP）**= 计划与完成度：条目粒度，✅ + 日期 + 一句话结论；**不堆实现细节**。
> - **`CHANGELOG.md`** = 发布变更记录：面向使用者、按版本组织（Keep a Changelog），细节归这里。
> - **`HANDOFF.md`** = 会话接力：只留「还在路上」的活（当前状态/待验证/下一步），不放已完成清单。
>
> **维护铁律（见 AGENTS.md §5.2）**：任务/里程碑完成 → 对应条目打 ✅ + 日期；新规划/优先级调整 → 更新大纲表；已完成的实现细节写 CHANGELOG，本文件只留条目级摘要。

---

## 总进度（2026-10-25 更新）

**M1 独立化重构已交付 ✅ + v1.0.1 已发布 ✅（2026-10-12）**；此后 M2/M3/M4/M5 均已完成，
**v1.4.0 已发布（2026-10-21）**：设置面板、新输出自动展开、连接预热 + 本地运行时缓存、
会话中键关闭、首帧提示，以及仓库内个人/本机信息清理。**v1.4.1（2026-10-22）**：设置子面板排版、
Edit 对齐，以及 `docs/dev-workflow.md` 的「隐私与个人信息」检查指南。下一阶段：Marketplace 上架、
Codex 端到端、宿主实测验收与打包瘦身。**2026-10-25**：项目体检后完成底层 P0 修复（P1-5）与 agent 差异收敛（P1-6），
Codex 支持（P1-1）只剩真机验证；体检出的其余缺口记为 P1-7～P1-9、P2-6～P2-9。

---

## ✅ 已交付里程碑

### M5 · 设置面板与交互（2026-10-21，v1.4.0）

Tab 栏右侧**设置面板**（General/Chat/Appearance/Advanced，左侧分组导航；固定尺寸；配置项与面板偏好双向同步；
默认目录带系统选择器；第二批补齐子代理分组、输入卡尺寸、每个 agent 默认模型、发送快捷键、自定义模型列表
与 Agent 配置编辑器、运行时缓存操作）、**新输出自动展开**（地址栏开关，按会话记忆 + 卡片类型白名单 +
展开限高，历史回放不展开）、会话 tab **中键关闭**（运行中会话弹原生二次确认）、打开面板即自动连接、
`+` 紧跟最后一个 tab、首帧 `Starting VAC…` 占位，以及仓库内个人/本机信息清理。
细节见 `CHANGELOG [1.4.0]`。

### M4 · 体验修复与诊断（2026-10-21，v1.4.0）

用户一轮 5 项反馈：滚动疑难问题的定向埋点（`cov`/`gap`/`wheel`/`heal-skip`）、**连接预热 + npx 本地运行时缓存**
（实测 11–17s → ~0.6s）、恢复会话的 IDE 环境标注、会话 tab **Copy Session ID**、草稿页模型选择先落位与模型变更诊断。
细节见 `CHANGELOG [1.4.0]`；真机验收步骤见 `HANDOFF.md`。

### M3 · ACP 能力补齐（2026-10-16）

`session/delete`（真删除会话）、`session/fork`（从助手消息分叉）与 **sub-agent 子会话**（声明 draft
`subagents` 能力 + 卡片/取消）三项落地；fork 适配器升级到上游 **v0.91.0**（保留自研 `_meta.extraModels`）。
另产出 [`docs/acp-protocol.md`](docs/acp-protocol.md) —— ACP 协议接口 + claude-agent-acp 功能对照表
（逐条标「已用 / 值得补 / 暂不用」）。细节见 `CHANGELOG [1.3.0]`。

### M2 · 上架前打磨（2026-10-13）

v1.0.3：修「目录筛选菜单被会话行盖住」（绘制顺序）、插件正式图标（侧边栏 / 徽标 / 编辑区标签页
三处，此前 `resources/icon.png` 是坏文件）、README 重写为开源项目门面。细节见 `CHANGELOG [1.0.3]`。

v1.0.4：会话 tab 目录徽标的字号分档与圆角（含「3 个字母被挤成两行」的修复）、默认 Claude Code
适配器换源、README 与全仓库文档去除前身 fork 痕迹。细节见 `CHANGELOG [1.0.4]`。

v1.1.0：对齐 Claude Code 的 AskUserQuestion 面板 —— 表单选项的 **preview 就地展开**、回答后的
**回执卡标出所选**（可折叠 + `Answered · N questions`）、宿主侧**结构化答案落库**；另修订会话 tab
目录徽标的排版（3 字母「上 2 下 1」、4 字母 2x2 贴紧、悬停补状态）并把 Dashboard 的「在编辑区打开
聊天」搬进视图标题栏。细节见 `CHANGELOG [1.1.0]`。

### M1 · 独立仓库 + 底层重构 + Dashboard 骨架（2026-10-12）

重建为自主演进的仓库：底层按性能与扩展性重写，双渲染路径合并为单一
Chat 面板子系统，新增侧边栏 Dashboard（用量统计）。细节见 `CHANGELOG [1.0.1]`。

- 版权：仓库只保留本项目自己的 MIT 版权。
- 构建：webpack → esbuild；新增 vitest 纯逻辑测试层。
- 命名空间：`acpc.*` → `vac.*`（命令 / 配置 / 视图 / 上下文键 / Memento key）。

---

## 📋 总体开发大纲（按优先级）

### 🔴 阻塞项（等外部条件）

| # | 任务 | 说明 |
|---|------|------|
| - | （暂无） | - |

### 🟡 近期规划

| # | 任务 | 说明 |
|---|------|------|
| P1-1 | Codex 链路端到端验证 | 🚧 2026-10-25：换新包 `@agentclientprotocol/codex-acp`、握手探针实测能力、API Key 认证 + 登出、`_meta` 终端输出渲染已完成；**剩真机跑一轮带命令的会话**，并核对 `CodexUsageSource` 口径 |
| P1-2 | 宿主实测验收 | `npm run dev:host` 目视验收 Dashboard 与聊天面板的渲染、统计数字是否对得上 |
| P1-3 | 打包体积瘦身 | `dist/extension.js` 1.42 MB（压缩后），主要来自 ACP SDK 全量引入；评估按需引入或裁剪 |
| ~~P1-4~~ | ~~首次发布~~ | ✅ 已完成（2026-10-12）：v1.0.1 已打 GitHub Release 并附 `.vsix`；市场发布见 P2-5 |
| ~~P1-5~~ | ~~底层 P0 修复~~ | ✅ 2026-10-25：`session/new` 失败不再杀进程、布尔配置项按协议上线、认证重试覆盖 load/resume/prompt |
| ~~P1-6~~ | ~~agent 差异收进 `AgentProfile`~~ | ✅ 2026-10-25：转录补全与嵌套策略按 kind（`transcriptStore` / `nesting`），不再按名字 |
| P1-7 | 终端与写文件健壮性 | `TerminalHandler`：参数转义、`taskkill /T` 收子孙进程、release 后清 VS Code 终端、UTF-8 分片解码；`writeTextFile` 对已打开且有未保存修改的文档走 `WorkspaceEdit` |
| P1-8 | 连接健壮性 | `initialize` 超时；agent 崩溃后自动重连并 resume 已打开会话；`vac.agents` 变更时提示重启；`logTraffic` 默认值复议 |
| P1-9 | SDK 新更新类型 | `plan_update` / `plan_removed`（声明 `plan`，Codex 才发结构化计划）、`notice`、`compaction_*`；评估 SDK 2.x 升级 |

### 🟢 远期 / 增强

| # | 任务 | 说明 |
|---|------|------|
| P2-1 | Dashboard 第二轮 | 按 `docs/dashboard-design.md` 的扩展点补：按项目/模型的时间趋势、导出、更细的成本拆分 |
| P2-2 | 价格表校验 | `dashboard/usage/pricing.ts` 的 `PRICING_AS_OF` 与各档价格需按官方口径复核 |
| P2-3 | 更多 agent 接入 | 保持「加 agent 只动 `agents/AgentProfile.ts` + 配置」这一约束不被破坏 |
| P2-4 | 记录区长对话性能 | 虚拟列表 / 流式 markdown 只重绘尾块（当前依赖合并 postMessage 缓解） |
| P2-5 | 上架 VS Code Marketplace | 注册 publisher、准备图标与截图、按 vsce publish 流程发布。**图标已就绪**（2026-10-13，`resources/icon.{svg,png}` 由 `npm run icon` 生成）；截图待补 |
| P2-6 | Diff 审阅 | 工具卡的 diff 用 VS Code diff 编辑器打开；接受 / 拒绝；按轮次回滚 |
| P2-7 | 会话级 MCP 注入 | `vac.mcpServers` 配置 → `session/new` 的 `mcpServers`（按 agent 的 `mcpCapabilities` 过滤） |
| P2-8 | 编辑器上下文 | 发送选区 / 当前文件 / Problems 诊断到聊天；评估 `document/did*`（UNSTABLE） |
| P2-9 | 拆分 `ChatPanelHost` | 4.4k 行：按设置 / 历史 / 恢复 / 草稿 / 更新投影拆控制器，host 只做路由 |
