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

- **最近更新**：2026-10-21
- **整体状态**：✅ **无进行中任务。v1.4.0 已发布**（GitHub Release 附
  `vscode-acp-client-1.4.0.vsix`）。本轮 = M4（5 项反馈）+ M5（设置面板 / 自动展开 / 中键关闭 / 首帧）
  + 隐私清理，已归档到 `CHANGELOG [1.4.0]`。
- **当前分支（必填）**：`main`（已提交并推送，与 `origin/main` 同步）。
- **最后验证状态**（2026-10-21，v1.4.0 发布）：`lint` ✅ · `typecheck` ✅ · `test:unit` ✅（101 项）·
  `check-webview-client` ✅（24 个客户端模块）· `npm test`（真实宿主）✅ **503 项** ·
  `check-docs.sh` ✅ · `npm run vsix` ✅（`release/vscode-acp-client-1.4.0.vsix`）。
  ⚠️ 仍未做 `npm run dev:host` 真机验收（见「下一步」）。

---

## 当前任务（In Progress）

- （无。v1.4.0 已发布并归档；剩下的只有真机验收与 Marketplace。）

---

## 待归档暂存区（仅本轮未归档的完成项）

- （无。已写入 `CHANGELOG [1.4.0]`。）

## 进行中（半成品 / 未提交）

- （无。）

## 阻塞 / 待决策（Blockers）

- **上架前的截图**：README 与 Marketplace 列表都还没有截图（`ROADMAP.md` P2-5 待办项之一）。

---

## 下一步（Next Steps）

1. **v1.4.0 真机验收（M4+M5）**（最高优先）：`npm run dev:host` 后确认：
   ① 齿轮面板：四组、固定尺寸、`+` 紧跟最后一个 tab、齿轮固定右侧；Browse… 弹系统目录选择器；
   ② 设置改动落盘并与 VS Code Settings 同步；子面板里的自定义模型 / Agent JSON 编辑器；
   ③ 地址栏自动展开：新输出展开、历史回放不展开；卡片类型与高度在 **Appearance** 里调（0 = 不限）；
   ④ 中键关闭（运行中弹确认；草稿/待恢复各自语义）；打开面板即连接；首帧 `Starting VAC…`。
2. **其中 M4 遗留项**：
   ① 新建草稿页选 `<custom-model>` → 发送 → 模型不再弹回 opus（看日志 `SessionManager: model ... (source)`）；
   ② 会话 tab 右键出现 **Copy Session ID** 且内容正确；
   ③ 关闭窗口再打开 → 恢复卡片能显示 `(VS Code Insiders)` 之类的跨环境标注（用共享 user-data 复现）；
   ④ 首次连接：日志出现 `prewarm connected in ...ms`；首次连接后约 15s 起看
   `Agent runtime cached for "Claude Code" in ...ms`，**下一次启动**应变成
   `Spawning agent ... (cached runtime v0.91.0)`，连接降到 ~1s；
   ⑤ 滚动问题复现时抓 `~/.vac/vac.log` 的 `scroll#` 行：`cov=1` 即定案，`heal-skip:` 说明自愈为何没出手。
2. **v1.3.1 真机验收（遗留）**：见 `CHANGELOG [1.3.1]` 的 9 条（markdown / Copy / 图标 / 置顶卡 / 历史弹窗 /
   Times / tab 高亮与涟漪）。
3. **P1-2 宿主实测验收（v1.3.0 遗留）**：Dashboard、聊天面板、树/历史弹窗 Delete、Fork、sub-agent 卡等。
4. **P1-1 Codex 端到端**：用真实 `codex-acp` 跑通连接与一次会话；核对 `CodexUsageSource.ts` 的用量口径。
5. **P1-3 打包瘦身**：`dist/extension.js` 主要来自 ACP SDK 全量引入。
6. **P2-5 上架 Marketplace**：注册 publisher、准备截图、发布。

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
