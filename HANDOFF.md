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

- **最近更新**：2026-10-19
- **整体状态**：✅ **无进行中的开发任务。v1.3.1 已发布**（GitHub Release 附
  `vscode-acp-client-1.3.1.vsix`，423.35 KB / 10 文件）。本轮 = 用户两轮反馈（共 11 条）：
  历史会话最后一条 markdown 渲染 + 复制双路径/诊断 + `Copy selection`；编辑区图标全彩、
  置顶卡框选不跳转、历史弹窗头部顺序、Times 图标化、tab 切换先本地高亮、tab 涟漪修复、
  tab 选中态区分度。已归档到 `CHANGELOG [1.3.1]`。
- **当前分支（必填）**：`main`，与 `origin/main` 同步。
- **最后验证状态**（2026-10-19，v1.3.1 发布）：`lint` ✅ · `typecheck` ✅ · `test:unit` ✅（91 项）·
  `npm test`（真实宿主）✅ **488 项** · `npm run vsix` ✅ 生成
  `release/vscode-acp-client-1.3.1.vsix`（10 文件，含 `resources/icon-editor-color.svg`）。
  ⚠️ 仍未做 `npm run dev:host` 真机验收（见「下一步」第 1 条）。

---

## 当前任务（In Progress）

- （无。v1.3.1 已发布并归档；剩下的只有真机验收，见「下一步」。）

---

## 待归档暂存区（仅本轮未归档的完成项）

- （无。）

## 进行中（半成品 / 未提交）

- （无。）

## 阻塞 / 待决策（Blockers）

- **上架前的截图**：README 与 Marketplace 列表都还没有截图（`ROADMAP.md` P2-5 待办项之一）。
  准备放 `docs/images/` 并在 README「特性」上方引用。

---

## 下一步（Next Steps）

> 均来自 `ROADMAP.md` 的近期规划；接手时按用户实际指定挑一条，先按 §0.5 定范围再动手。

1. **v1.3.1 真机验收（最高优先）**：`npm run dev:host` 后逐条确认：①大会话历史会话的
   **最后一条 markdown**；②地址栏/消息卡 Copy（判据：`[vac] copy` → `copied N char(s)`；
   失败看 `clipboard write failed`）；③编辑器标题栏图标为全彩徽标；④置顶卡内拖选文本松手不跳转；
   ⑤历史弹窗筛选在左、计数在右；⑥Times 为时钟图标 + tooltip；⑦切 tab 高亮立即切换
   （看 `[vac] focus: hydrate N entries in Xms`）；⑧运行中 tab 的颜色 + 外圈涟漪；
   ⑨当前 tab 的同色底 + 顶部强调线 + 加粗。
2. **P1-2 宿主实测验收（v1.3.0 遗留）**：`npm run dev:host` 目视确认 Dashboard 统计/连接状态、
   聊天面板（发消息 → 流式 → 工具调用 → 权限卡）、Agents 树/历史弹窗的 **Delete**、
   助手消息右键 **Fork from here**、**sub-agent 卡**的 Cancel、编辑区标签栏入口图标、
   会话 tab 的目录徽标（真机字号）、Dashboard 标题栏两颗按钮、表单（231）抽屉与回执卡、
   目录筛选菜单的层叠。
3. **P1-1 Codex 端到端**：用真实 `codex-acp` 跑通连接与一次会话；核对
   `src/dashboard/usage/CodexUsageSource.ts` 的用量口径。
4. **P1-3 打包瘦身**：`dist/extension.js` 1.48 MB（压缩后），主要来自 ACP SDK 全量引入；
   注意 `.vscodeignore` 的忽略**不支持通配嵌套路径**，排除 dist 下的文件要写精确路径。
5. **P2-5 上架 Marketplace**：已具备图标（`npm run icon` 生成）；剩余注册 publisher、准备截图、发布。
6. 用户若指定新需求：按 `ARCHITECTURE.md` §0.5 定范围 → 定位函数 → 实施 → 文档同步。

---

## 如何运行 / 测试（Quick Verify）

- 运行（开发宿主）：`npm run dev:host`（宿主窗口内 `Ctrl+R` 重载生效）
- 构建：`npm run compile`；生产打包：`npm run package`；打 `.vsix`：`npm run vsix`（产物落 `release/`）
- **图标**：`npm run icon`（改 `scripts/make-icon.mjs` 顶部的 `MARKS` 几何后重跑；
  `--preview` 另出多尺寸预览图到系统临时目录）。`resources/icon.*` 是生成物，不要手改。
- 校验/测试：`npm run test:unit`（vitest，秒级）· `npm test`（编译 + lint + 真实宿主测试）
- lint / 类型：`npm run lint` · `npm run typecheck`
- 文档体检：`sh check-docs.sh`
- 端到端：需本机可执行 `npx`（默认 agent 经 `npx` 拉起 Claude Code / Codex 的 ACP 适配器）

---

## 关键决策记录（Key Decisions）

- **v1.0.3 已发布**：GitHub Release <https://github.com/zouv/vscode-acp-client/releases/tag/v1.0.3>
  附 `vscode-acp-client-1.0.3.vsix`。版本号取 patch：本轮是「两个修复 + 图标 + README」的打磨，
  没有新增能力面（用户 2026-10-13 在 1.0.3 与 1.1.0 之间选了前者）。
  `.vsix` 不进 git（`.gitignore` 已忽略），只作为 Release 资产——打包产物固定落 `release/`，
  由 `npm run vsix` 生成（见 `scripts/package-vsix.mjs`）。
- **图标只有一个几何源**：`scripts/make-icon.mjs` 里的 `MARKS` 同时产出单色 SVG（活动栏，24×24，
  单色 `currentColor`）与 128×128 徽标 PNG（Marketplace + 编辑区标签页）。改外观改脚本、重跑，
  不手改产物。图形为「对话气泡 + 终端提示符 `>_`」。
- **列表里"谁画在上面"只能靠抬 head 那一层**：目录筛选菜单要压住历史行，就得给
  `#history .outline-head` 正的 `z-index`（`position: sticky` 让它自成层叠上下文，
  菜单自己的 `z-index: 20` 被它封住、抬到 999 也没用）。详见 `arch/chat-panel-sessions.md` §5.24
  的「谁画在上面」一行与 `styles.ts` 那条注释。
- **PNG 必须按二进制提交**：`.gitattributes` 的 `*.png binary` 是这道防线；1.0.3 之前的
  `resources/icon.png` 就是被换行符转换洗坏的（签名的 `0x0D` 被剥掉），务必别退回去。
- **命令的入口只在标题栏，不在 webview 页面里重复**（230）：Dashboard 的「在编辑区打开聊天」
  与「刷新」都只由 `package.json` 的 `view/title` 贡献（`navigation@0` 排在 `navigation@1` 的左边），
  页面里再放一颗就是同一个命令的第二个入口。`DASHBOARD_COMMANDS` 是**页面的白名单**
  （＝页面上那两颗按钮），不是"扩展能做的全部"—— spec 钉住两边一一对应，收紧白名单时要一起改。
- **继续走 ACP**：不用 Anthropic 专有 SDK，保持通用 ACP 客户端；当前只接 Claude 与 Codex。
- **agent 差异集中**：新增 agent 只动 `agents/AgentProfile.ts` 与配置，**不往 UI 加分支**。
- **构建换成 esbuild**、**测试分两层**（vitest 纯逻辑 + mocha 真实宿主）。
- **单价是估值**：Dashboard 的成本按等价 API 价格估算，未知模型计入 `unpriced`。

---

## 待解问题 / 给用户的提问（Open Questions）

- Dashboard 的价格表（`PRICING_AS_OF = '2026-01'`）需要按官方口径复核。
- 是否要在首个发布版本里保留 `vac.restoreSessionsOnOpen` 的默认 `ask` 行为。
- `doc-audit` skill 的扫描范围仍是「5 份根文档 + `docs/00-目录.md`」，**未覆盖 `arch/*.md`**——
  上次分册的漂移正是靠人工扫出来的（此前用户选择先不改 skill）。
