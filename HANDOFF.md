# 接力进度 / Handoff

> **这是什么**：AI 断点续作的「交接包」。一次对话没干完，**下一个 AI 会话先读本文件**，
> 就知道「做到哪、还剩什么、卡在哪、下一步从哪开始」，无需从零重新理解。
>
> **给接手的 AI（冷启动按这 4 步走）**：
> 1. 先读 `AGENTS.md`（工作铁律）；据「当前任务」范围，按 `ARCHITECTURE.md` §0.5 路由表**只读相关文件**。
> 2. 读本文件「当前任务 / 进行中（半成品位置）/ 下一步 / 完成定义」，从「下一步」第一条动作开始。
> 3. 每完成一个子步骤就**即时勾选并更新本文件**（不要攒到最后）。
> 4. 任务真正完结：计划条目在 `ROADMAP.md` 打 ✅，发布细节记入 `CHANGELOG.md`，并把本文件里**开工时写下的整套计划痕迹一并清掉**，状态改回「无进行中任务」。
>
> **维护约定**：本文件只留「**进行中**的临时状态」。**本文件超过 150 行即视为堆积超标。**

---

## 状态快照

- **最近更新**：2026-10-12
- **整体状态**：✅ 无进行中的开发任务（M1 已交付并发布 v1.0.1，等待下一个需求）
- **当前分支（必填）**：`main`，已与 `origin/main` 同步（`fe15283` 初始化 → `9a96770` 打包修复）。
  **未经用户明确指示不要 commit / push。**
- **最后验证状态**：`npm run lint` ✅ · `npm run typecheck` ✅ · `npm run test:unit` ✅（88 项）
  · `npm test`（真实宿主）✅ 454 项通过 · `sh check-docs.sh` ✅ 0 警告
  · `npx vsce package` ✅ 生成 `vscode-acp-client-1.0.1.vsix`（392 KB，已剔除 sourcemap）

---

## 当前任务（In Progress）

- **目标**：无进行中的开发任务。
- **范围 / 涉及文件**：—
- **完成定义（Definition of Done）**：—

> 当前：无进行中的任务，等待下一个开发需求。

---

## 待归档暂存区（仅本轮未归档的完成项）

- （无。）

## 进行中（半成品 / 未提交）

- （无。）

## 阻塞 / 待决策（Blockers）

- （无。）

---

## 下一步（Next Steps）

> 均来自 `ROADMAP.md` 的近期规划；接手时按用户实际指定挑一条，先按 §0.5 定范围再动手。

1. **P1-2 宿主实测验收**：`npm run dev:host` 打开宿主，目视确认 Dashboard 的统计数字与
   连接状态、以及聊天面板（发消息 → 流式 → 工具调用 → 权限卡片）的实际表现。
   这是目前**唯一没有做过**的验收环节（其余都是类型/单测/集成测试的结论）。
2. **P1-1 Codex 端到端**：用真实 `codex-acp` 跑通连接与一次会话；核对
   `src/dashboard/usage/CodexUsageSource.ts` 的用量口径。
3. **P1-3 打包瘦身**：`dist/extension.js` 1.42 MB（压缩后），主要来自 ACP SDK 全量引入；
   注意 `.vscodeignore` 的忽略**不支持通配嵌套路径**，排除 dist 下的文件要写精确路径。
4. **P2-5 上架 Marketplace**：注册 publisher、准备图标（`resources/icon.png` 已有）与截图。
5. 用户若指定新需求：按 `ARCHITECTURE.md` §0.5 定范围 → 定位函数 → 实施 → 文档同步。

---

## 如何运行 / 测试（Quick Verify）

- 运行（开发宿主）：`npm run dev:host`（宿主窗口内 `Ctrl+R` 重载生效）
- 构建：`npm run compile`；生产打包：`npm run package`
- 校验/测试：`npm run test:unit`（vitest，秒级）· `npm test`（编译 + lint + 真实宿主测试）
- lint / 类型：`npm run lint` · `npm run typecheck`
- 文档体检：`sh check-docs.sh`
- 端到端：需本机可执行 `npx`（默认 agent 经 `npx` 拉起 Claude Code / Codex 的 ACP 适配器）

---

## 关键决策记录（Key Decisions）

- **v1.0.1 已发布**：GitHub Release <https://github.com/zouv/vscode-acp-client/releases/tag/v1.0.1>
  附 `vscode-acp-client-1.0.1.vsix`。`.vsix` 不进 git（`.gitignore` 已忽略），只作为 Release 资产。

- **出处处理**：前身基线（`vendor/main`）中存在过的文件一律**重写**，不搬运原文；
  基线中不存在的自写文件（Chat 面板子系统、两个桥、`CustomModels`、`BuildInfo`、Dashboard 设计）直接沿用。
  这样仓库只保留本项目自己的 MIT 版权，不需要保留上游署名。
- **继续走 ACP**：不用 Anthropic 专有 SDK，保持通用 ACP 客户端；当前只接 Claude 与 Codex。
- **agent 差异集中**：新增 agent 只动 `agents/AgentProfile.ts` 与配置，**不往 UI 加分支**。
- **构建换成 esbuild**、**测试分两层**（vitest 纯逻辑 + mocha 真实宿主）。
- **单价是估值**：Dashboard 的成本按等价 API 价格估算，未知模型计入 `unpriced`。

---

## 待解问题 / 给用户的提问（Open Questions）

- Dashboard 的价格表（`PRICING_AS_OF = '2026-01'`）需要按官方口径复核。
- 是否要在首个发布版本里保留 `vac.restoreSessionsOnOpen` 的默认 `ask` 行为。
