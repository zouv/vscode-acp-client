# 接力进度 / Handoff

> **这是什么**：AI 断点续作的「交接包」。只放**还在路上**的状态；计划归 `ROADMAP.md`，发布细节归 `CHANGELOG.md`。
> **冷启动 4 步**：读 `AGENTS.md` → 按 `ARCHITECTURE.md` §0.5 路由只读相关文件 → 读本文件「当前任务 / 下一步」→ 从下一步第一条动作开始。
> **维护约定**：每完成一个子步骤即时更新；本文件超过 150 行视为堆积超标。

## 状态快照

- **最近更新**：2026-11-23
- **整体状态**：**v1.19.2 已发布**（GitHub Release 附 `vscode-acp-client-1.19.2.vsix`）。本版含：长会话首条用户消息裁剪修复、会话目录地址栏色块与抽屉对齐、Tail / 自动展开 / Times 悬停底色统一。无未提交改动。
- **当前分支（必填）**：`main`。
- **最后验证状态**（2026-11-23）：`npm run typecheck` / `npm run lint` ✅；`npm run test:unit` **427 / 49 文件** ✅；真实宿主 **854 passing / 0 failing** ✅；`preview-records.mjs` 的 `#cwdmenuprobe` 实测 `dxLeft=0 / dxRight=0`、宽度一致、圆角 `5px`；`npm run vsix` 产出 `release/vscode-acp-client-1.19.2.vsix`（1.12 MB，sha256 `a25d621b…5ec343`）。

## 当前任务（In Progress）

- **v1.19.0 / v1.19.1 / v1.19.2 / v1.18.0 真机验收**（实现、自动验证与发布均已完成）：
  1. **草稿快照**：重载 → 默认 Agent 选 Codex → 点 `+`，模型 / 推理强度 / 模式选择器与 `/` 命令是否出现；若仍空，查 `~/.vac/vac.log` 的 `listDraftOptions for Codex CLI:` 行。
  2. **Agent 标识**：页签悬停时 ID 前有品牌图标；地址栏目录前有图标（草稿跟默认 agent）；历史抽屉标题行只有图标、悬停显示名称；Agents 树根节点有品牌图标。默认 Agent 下拉的图标/勾选是否居中对齐；浅色/深色主题各看一眼。
  3. **v1.19.0 遗留 7 条**：只配 Codex 的空态文案；Codex Fork/Rewind；模型菜单有自定义模型；Tip 模型名与 `/compact`；`codexSessionsDir` 重扫；默认 Agent 双向同步；下拉不被裁切。
  4. **v1.18.0 复验 4 条**：自定义模型新增后立即出现在草稿候选；目录抽屉前缀路径的 `Use this directory`；历史列表宽度 600 与面板收缩；历史目录菜单排序与「还原」。

> 更早的验收细节见 `docs/03-验收清单.md`；更早的会话记录查 git log。

## 阻塞 / 待决策

- **上架前的截图**：README 与 Marketplace 列表都还没有截图（`ROADMAP.md` P2-5）。

## 下一步（Next Steps）

1. 按「当前任务」四条做 v1.19.x 真机验收；发现问题在 `CHANGELOG.md` 的 `[未发布]` 记修复并补测试。
2. 验收通过后继续 `ROADMAP.md`：P1-8 连接健壮性 → P1-9 SDK 更新类型 → P1-3 打包瘦身。

## 如何运行 / 测试（Quick Verify）

- 运行：`npm run dev:host`（宿主内 `Ctrl+R` 重载）。
- 构建：`npm run compile`；生产打包 `npm run package`；`npm run vsix`（产物落 `release/`）。
- 图标：`npm run icon`（改 `scripts/make-icon.mjs` 的 `MARKS` 后重跑；`resources/icon.*` 是生成物）。
- 校验：`npm run test:unit`（vitest，秒级）· `npm test`（编译 + lint + 真实宿主；shell 带 `ELECTRON_RUN_AS_NODE=1` 时用 `env -u ELECTRON_RUN_AS_NODE npm test`；最低宿主 `VSCODE_TEST_VERSION=1.85.0`）。
- lint / 类型：`npm run lint` · `npm run typecheck`；文档体检：`sh check-docs.sh`。
- agent 探针：`node scripts/probe-agent-init.mjs --agent "npx -y github:zouv/codex-acp#main" --session --extra-model vac-probe-model`（会留一个空会话；输出含本机模型配置，别提交）。

## 关键决策记录（仍未过时）

- **继续走 ACP**：不用 Anthropic 专有 SDK；当前只接 Claude 与 Codex。
- **agent 差异集中在 `agents/AgentProfile.ts`**：UI 需要的差异按 kind 取（`transcriptStore` / `nesting` / `messageFork` / `customModels`），**不按配置名判断**；能力位随 `SessionMeta` 下发。
- **消息级 fork 是 ACP 的 AIR 扩展**：`_meta.jetbrains.air.fork`（`version: 1` + `messageId`），Claude 与 codex-acp 都认；`messageFork=false` 的 agent 保留菜单但提示不支持，宿主同时拒绝。
- **Codex 用量不是 `usage_update`**：只在 `PromptResponse.usage` 与 `_meta.quota` 给单轮 token，圆环/Tip 数据不完整；要完全对齐需适配器补 `usage_update`（优先上游 PR）。
- **两个适配器都走 fork 的 `#main`**：`zouv/claude-agent-acp` 与 `zouv/codex-acp` 的 main 跟踪上游，仅在上游未支持时保留定制；同步流程见 `docs/dev-workflow.md`。
- **Codex 自定义模型由 fork 承担**：`_meta.extraModels` 随 `session/new|load|resume` 下发，fork 追加进 model 配置项；官方 npm 包不支持，迁移表会换到 fork。
- **不声明 `_meta.terminal_output(_delta)`**：Codex 不声明也会发；Claude 会因此改走 `_meta` 终端输出、改变 Bash 渲染。
- **图标只有一个几何源**：`scripts/make-icon.mjs` 同时产出 SVG 与 PNG；PNG 必须以二进制提交（`.gitattributes` 已钉）。
- **列表浮层谁画在上面**：靠抬 `#history .outline-head` 的 `z-index`；详见 `arch/chat-panel-sessions.md` §5.24。
- **草稿快照以文件为准**（2026-11-21）：`globalState` 按窗口缓存，跨窗口不可靠；`<globalStorage>/draft-options.json` 是权威副本。

## 待解问题 / 给用户的提问（Open Questions）

- Dashboard 价格表（`PRICING_AS_OF = '2026-01'`）需按官方口径复核。
- 是否在首个发布版本保留 `vac.restoreSessionsOnOpen` 的默认 `ask` 行为。
- `doc-audit` skill 的扫描范围仍是「5 份根文档 + `docs/00-目录.md`」，**未覆盖 `arch/*.md`**。
- 活跃会话豁免 LRU；agent terminal ID 总数仍无硬限。真机验收重点核对大结果截断与 Windows batch 参数限制。
