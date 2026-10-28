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

- **最近更新**：2026-10-28
- **整体状态**：✅ v1.8.0 已发布（消息面板交互：滚轮门控 / 一张卡一条滚动条 / Tail / 会话级开关 /
  最近目录去重与删除）。v1.5.0 的 Codex 支持仍在等真机验证（P1-1）。
- **当前分支（必填）**：`main`（v1.8.0 发布提交；远端 `origin/main` 应与之同步）。
- **最后验证状态**（2026-10-28）：`lint` ✅ · `typecheck` ✅ · `test:unit` ✅（120 项）·
  `npm test`（真实宿主）✅ **533 项**（滚轮门控 7 条 + 面板交互 11 条）· `check-webview-client` ✅ · `check-docs` ✅。
  滚动条层数用真 Chromium 量过：自动展开 / 手动展开卡各 **1 条**；把旧限高加回去是 3 条 / 2 条。
  ⚠️ v1.8.0 的改动**都未做** `npm run dev:host` 真机验收（验收项见「当前任务」与「下一步」1–3）。

---

## 当前任务（In Progress）

- **滚轮：内层卡片焦点门控 + 自动追尾（已随 v1.8.0 发布 / 待真机验收）**：滚轮默认滚面板；**点进**卡片
  （`.scroll-active` 焦点环）才滚卡片内部，指针在卡片内只滚卡片、面板原地不动；流式卡片的内层
  滚动区自动跟到最后一行（用户上滚即停）。顺带修掉「一张卡叠 2–3 条纵向滚动条」。代码在
  `html/client/scroll.ts` + `styles.ts`；不变量与诊断见 `arch/chat-panel-state.md` §5.53。
- **Tail / 会话级开关 / 最近目录删除（已随 v1.8.0 发布 / 待真机验收）**：新增 `client/tail.ts`（地址栏
  Tail 按钮 = 自动追尾，滚动即取消）；Times / 自动展开 / 大纲 / Tail 改为「已开启会话落定」
  （拨开关只影响当前会话，新会话才继承新值）；地址栏两图标对调（Tail = 同向下尖角、
  自动展开 = 朝外尖角）；目录抽屉「Recently used」行加删除并按目录同一性去重。细节见 §5.54。
  **待真机：`docs/03-验收清单.md` 246–252。**
- **v1.7.0 真机验收（待做）**：配置作用域与 markdown 补渲染都已随 v1.7.0 发布、自动检查全绿；
  具体项见「下一步」3–4。
- **P1-1 Codex 真机验证**（代码已就绪）：步骤见「下一步」5。
- **「滚动条到底、消息仍被截断」待复现**（用户 2026-10-26 报，现场已消失）：日志里 2300+ 条
  `scroll#` 全部自洽（`cov=0`），现有判据打不到这种形态。**下次出现时先别关面板**，直接读
  `~/.vac/vac.log` 抓现场。

---

## 待归档暂存区（仅本轮未归档的完成项）

- （无。v1.8.0 成果已写入 `CHANGELOG [1.8.0]`。）

## 进行中（半成品 / 未提交）

- （无。v1.8.0 已提交并发布。）

## 阻塞 / 待决策（Blockers）

- **上架前的截图**：README 与 Marketplace 列表都还没有截图（`ROADMAP.md` P2-5 待办项之一）。

---

## 下一步（Next Steps）

1. **面板交互真机验收（本轮改动，最高优先）**：`npm run dev:host` → 按 `docs/03-验收清单.md`
   **246–252** 逐条确认（滚轮门控与一张卡一条滚动条；Tail 打开即跟随、一滚就取消；四个开关
   只影响当前会话而新会话继承；自动展开的新图标；最近目录的删除）。
   日志关键字：`focus:` / `wheel-card:` / `wheel-gate:` / `tail:`。
2. **markdown 补渲染真机验收**：`npm run dev:host` →
   ① 历史会话（如 `94e2fb8a`）打开 ≥3 次，全部记录都是渲染后的样子（含思考块）；
   ② **普通对话里不再出现"最后一条卡片停在原文"**：轮次结束约 0.6s 内自动渲染，
   日志见 `settled markdown for N record(s)`；回放路径见 `pre-rendering markdown for N …`；
   ③ 回归：正在流的回复收尾后仍完整渲染（186 的"只认自己那段文本"不能被放宽）。
3. **v1.7.0 真机验收**：`npm run dev:host` 后确认：
   ① tab 右键两条新项；同目录新建落在源会话 cwd；Duplicate 派生成功且历史可见（失败有提示）。
   ② 设置 → Chat 的默认 Effort / Recently used（3–16）落盘且生效。
   ③ 单行内选中几个字 → 引用 tag 显示 `文件名:N`，发送后 agent 收到 `#LN`。
   ④ 地址栏 Times / 自动展开 / Sub-agents / ☰：关=灰无底框，开=变色有底框（两种主题）。
   ⑤ 模式/模型/Effort/Agent 四个选择器的图标清晰；菜单项两行、选中项打勾；Agent 选择器可切换。
   ⑥ hover 会话 tab / 目录图标：SessionId 与 State 为灰色，目录提示无 `Dir:` 前缀。
   ⑦ 设置 → Appearance 的 Markdown style 四档即时生效（editor 档与改动前一致）。
   ⑧ 设置作用域：Custom models 胶囊 = `All IDEs`，改描述后输入卡菜单立即变；
      有工作区覆盖时显示 `Workspace` + `Overridden by workspace settings`；Inspect 的
      Open / Remove / Make this the default for all IDEs 可用。
4. **P1-1 Codex 真机验证**：`npm run dev:host` → 连 Codex CLI → 发一条会跑命令的消息
   （如「列出当前目录文件」），确认：① 工具卡里直接显示命令输出（console 文本），失败时有「Exited with code N」；
   ② 模式 / 模型 / 推理强度选择器可切换；③ 未登录机器上选 API Key → 输入 key → 重启后不再询问；
   ④ `VAC: Log Out of Agent` 后再发消息会重新要求认证；⑤ Dashboard 的 Codex 用量与 `~/.codex/sessions` 对得上；
   ⑥ `vac.agents` 里仍是旧包 `@zed-industries/codex-acp` 时，激活弹迁移提示。
   顺带回归 Claude：Bash 输出、子 agent 嵌套、历史补全（按 kind 改造后）不变。
5. **滚动问题复现时抓现场**：`~/.vac/vac.log` 的 `scroll#` 行——`cov=1` 即定案；全是 `cov=0` 时优先看
   末条 `last`/`comp`、`#messages` 的 rect 与 `window.innerHeight`、以及抽屉变量（`ev=` / `pv=`）。
6. **历史遗留验收（低优先）**：v1.4.0/M4、v1.3.1、v1.3.0 的验收清单仍挂着，明细见
   `CHANGELOG [1.4.0]/[1.4.1]/[1.3.1]`；这些条目长期未执行，先按 1–4 走。
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

- **v1.0.3 已发布**：GitHub Release 附 `vscode-acp-client-1.0.3.vsix`；`.vsix` 不进 git（`.gitignore`），
  打包产物固定落 `release/`（`npm run vsix`）。
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
