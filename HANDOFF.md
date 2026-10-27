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

- **最近更新**：2026-10-27
- **整体状态**：✅ **v1.6.0 已发布**（会话操作 / 选择器 / Markdown 预设等两批用户反馈）；
  v1.5.0 的 Codex 支持仍在等真机验证（P1-1）。发布内容见 `CHANGELOG [1.6.0]`。
- **当前分支（必填）**：`main`（已提交并推送，与 `origin/main` 同步）。
- **最后验证状态**（2026-10-27）：`lint` ✅ · `typecheck` ✅ · `test:unit` ✅（114 项）·
  `npm test`（真实宿主）✅ **508 项** · `check-webview-client` ✅ · `check-docs` ✅。
  ⚠️ 发布前**未做** `npm run dev:host` 真机验收（验收项见「下一步」1）。

---

## 当前任务（In Progress）

- **v1.6.0 真机验收（待做）**：`npm run dev:host` 后按「下一步」1 的清单逐条确认；
  发布前只跑了自动检查。
- **P1-1 Codex 真机验证**（代码已就绪）：步骤见「下一步」2。
- **「滚动条到底、消息仍被截断」待复现**（用户 2026-10-26 报，现场已消失）：日志里 2300+ 条
  `scroll#` 全部自洽（`cov=0`、末条底边在输入卡上方 27px），现有判据打不到这种形态。
  **下次出现时先别关面板**，直接读 `~/.vac/vac.log` 抓现场。

---

## 待归档暂存区（仅本轮未归档的完成项）

- （无。v1.6.0 成果已写入 `CHANGELOG [1.6.0]`。）

## 进行中（半成品 / 未提交）

- （无。v1.6.0 已提交并发布。）

## 阻塞 / 待决策（Blockers）

- **上架前的截图**：README 与 Marketplace 列表都还没有截图（`ROADMAP.md` P2-5 待办项之一）。

---

## 下一步（Next Steps）

1. **v1.6.0 真机验收（最高优先）**：`npm run dev:host` 后确认：
   ① tab 右键两条新项；同目录新建落在源会话 cwd；Duplicate 派生成功且历史可见（失败有提示）。
   ② 设置 → Chat 的默认 Effort / Recently used（3–16）落盘且生效。
   ③ 单行内选中几个字 → 引用 tag 显示 `文件名:N`，发送后 agent 收到 `#LN`。
   ④ 地址栏 Times / 自动展开 / Sub-agents / ☰：关=灰无底框，开=变色有底框（两种主题）。
   ⑤ 模式/模型/Effort/Agent 四个选择器的图标清晰；菜单项两行、选中项打勾；Agent 选择器可切换。
   ⑥ hover 会话 tab / 目录图标：SessionId 与 State 为灰色，目录提示无 `Dir:` 前缀。
   ⑦ 设置 → Appearance 的 Markdown style 四档即时生效（editor 档与改动前一致）。
2. **P1-1 Codex 真机验证**：`npm run dev:host` → 连 Codex CLI → 发一条会跑命令的消息
   （如「列出当前目录文件」），确认：① 工具卡里直接显示命令输出（console 文本），失败时有「Exited with code N」；
   ② 模式 / 模型 / 推理强度选择器可切换；③ 未登录机器上选 API Key → 输入 key → 重启后不再询问；
   ④ `VAC: Log Out of Agent` 后再发消息会重新要求认证；⑤ Dashboard 的 Codex 用量与 `~/.codex/sessions` 对得上；
   ⑥ `vac.agents` 里仍是旧包 `@zed-industries/codex-acp` 时，激活弹迁移提示。
   顺带回归 Claude：Bash 输出、子 agent 嵌套、历史补全（按 kind 改造后）不变。
3. **v1.4.0 真机验收（M4+M5）**：`npm run dev:host` 后确认：
   ① 齿轮面板：四组、固定尺寸、`+` 紧跟最后一个 tab、齿轮固定右侧；Browse… 弹系统目录选择器；
   ② 设置改动落盘并与 VS Code Settings 同步；子面板里的自定义模型 / Agent JSON 编辑器；
   ③ 地址栏自动展开：新输出展开、历史回放不展开；卡片类型与高度在 **Appearance** 里调（0 = 不限）；
   ④ 中键关闭（运行中弹确认；草稿/待恢复各自语义）；打开面板即连接；首帧 `Starting VAC…`；
   ⑤ v1.4.1 排版：Agent JSON 铺满 + Cancel/Save 右下；Custom models 说明行/表头/Add 右对齐/Done 右下；
      Custom models 与 Agent configuration 的 Edit… 与其它控件右缘对齐。
4. **其中 M4 遗留项**：
   ① 新建草稿页选 `<custom-model>` → 发送 → 模型不再弹回 opus（看日志 `SessionManager: model ... (source)`）；
   ② 会话 tab 右键出现 **Copy Session ID** 且内容正确；
   ③ 关闭窗口再打开 → 恢复卡片能显示 `(VS Code Insiders)` 之类的跨环境标注（用共享 user-data 复现）；
   ④ 首次连接：日志出现 `prewarm connected in ...ms`；首次连接后约 15s 起看
   `Agent runtime cached for "Claude Code" in ...ms`，**下一次启动**应变成
   `Spawning agent ... (cached runtime v0.91.0)`，连接降到 ~1s；
   ⑤ 滚动问题复现时抓 `~/.vac/vac.log` 的 `scroll#` 行：`cov=1` 即定案，`heal-skip:` 说明自愈为何没出手。
      **2026-10-26 补充**：这条会话的采样全是 `cov=0`，说明还有第三种形态没被现有判据覆盖
      （`cov` 只比「末条底边 vs 输入卡顶边」，没管表单/权限抽屉）。复现时优先看：末条 `last`/`comp`、
      `#messages` 自己的 rect 与 `window.innerHeight` 的关系、以及抽屉变量（`ev=` / `pv=`）。
5. **v1.3.1 真机验收（遗留）**：见 `CHANGELOG [1.3.1]` 的 9 条（markdown / Copy / 图标 / 置顶卡 / 历史弹窗 /
   Times / tab 高亮与涟漪）。
6. **P1-2 宿主实测验收（v1.3.0 遗留）**：Dashboard、聊天面板、树/历史弹窗 Delete、Fork、sub-agent 卡等。
7. **之后按 ROADMAP**：P1-7 终端与写文件健壮性 → P1-8 连接健壮性 → P1-9 SDK 新更新类型 → P1-3 打包瘦身 → P2-*。

---

## 如何运行 / 测试（Quick Verify）

- 运行（开发宿主）：`npm run dev:host`（宿主窗口内 `Ctrl+R` 重载生效）
- 构建：`npm run compile`；生产打包：`npm run package`；打 `.vsix`：`npm run vsix`（产物落 `release/`）
- **图标**：`npm run icon`（改 `scripts/make-icon.mjs` 顶部的 `MARKS` 几何后重跑；
  `--preview` 另出多尺寸预览图到系统临时目录）。`resources/icon.*` 是生成物，不要手改。
- 校验/测试：`npm run test:unit`（vitest，秒级）· `npm test`（编译 + lint + 真实宿主测试）
- 只跑部分宿主测试：`npm run pretest` 后 `npx vscode-test --grep "session manager"`
- lint / 类型：`npm run lint` · `npm run typecheck`
- 文档体检：`sh check-docs.sh`
- agent 能力探针：`node scripts/probe-agent-init.mjs --agent "npx -y @agentclientprotocol/codex-acp" --session`
  （每次 `--session` 会在该 agent 的历史里留一个空会话；输出含本机模型配置，别提交）
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
- **agent 差异集中**：新增 agent 只动 `agents/AgentProfile.ts` 与配置，**不往 UI 加分支**；UI 需要的差异
  从 profile 按 kind 取（`transcriptStore` / `nesting`），**不按配置名判断**。
- **不声明 `_meta.terminal_output(_delta)`**（2026-10-25）：Codex 不声明也会发 `terminal_output_delta`；
  Claude 适配器却会因这个声明改走 `_meta` 终端输出，改变现有 Bash 渲染。
- **构建换成 esbuild**、**测试分两层**（vitest 纯逻辑 + mocha 真实宿主）。
- **单价是估值**：Dashboard 的成本按等价 API 价格估算，未知模型计入 `unpriced`。

---

## 待解问题 / 给用户的提问（Open Questions）

- Dashboard 的价格表（`PRICING_AS_OF = '2026-01'`）需要按官方口径复核。
- 是否要在首个发布版本里保留 `vac.restoreSessionsOnOpen` 的默认 `ask` 行为。
- `doc-audit` skill 的扫描范围仍是「5 份根文档 + `docs/00-目录.md`」，**未覆盖 `arch/*.md`**——
  上次分册的漂移正是靠人工扫出来的（此前用户选择先不改 skill）。
- `vac.logTraffic` 默认 `true` 会把提示词与文件内容落盘到 `~/.vac/vac.log`（key 类字段已脱敏）——是否改默认关闭（P1-8）。
