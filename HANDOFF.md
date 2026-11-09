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

## 状态快照

- **最近更新**：2026-11-09
- **整体状态**：v1.14.0 已发布为 GitHub Latest（tag `v1.14.0`）。本次为「Agent map（子代理地图）与右侧栏 Details（工具卡详情）」，并把内置 Claude 适配器基线同步到上游 v0.101.0（适配器侧新增 agent-map 元数据扩展）；代码与自动验证全部完成，待真机验收。
- **当前分支（必填）**：`main`；发布提交已推送至 `origin/main`。
- **最后验证状态**（2026-11-09）：typecheck / lint / webview 语法 / 生产构建 ✅；unit **393 / 48 文件**、真实宿主 **799 passing** ✅；VSIX 已打包并上传至 GitHub Release（见发布记录）。

## 当前任务（In Progress）

- **v1.13.0 待真机验收**：长回复流式增量（文本完整不重复、代码块/表格稳定块不闪烁、切走再切回增量对齐）；链接引用定义 `[x]: url` 渲染；Bash 卡输出追加不打断选中/滚动、diff 展开保持；Task 嵌套分组（Task 结束后子调用仍输出）；大纲固定侧栏时流式悬停/键盘焦点不丢；长历史会话最新 30 条立即渲染、更早按需补齐；自动追尾运行卡片跟到最后；**加载中切换页签立即生效、加载完成不抢焦点、切回快照完整**；Windows 四种 agent 启动路径（npx / npx.cmd / 全局 .cmd / 缓存直启）；权限按钮 20s 超时兜底；macOS Option+字母默认快捷键预期失效（需改绑 Ctrl/Meta）；粘贴文本优先策略；UNC / `file://host` 链接拦截；多根会话历史重开 `additionalDirectories` 恢复；被取消 Task 卡片仍显示「进行中」（SDK v1 无 cancelled 状态）。

- **卡片渲染与设置增强待真机验收**：重载开发宿主后验证 Read 的 Markdown/C++ 黑块与高亮、复制；自定义模型拖拽/上下按钮及选择器顺序、冲突提示；历史上限 0/有限值、筛选与重载。
- **VAC Chat 快捷键待真机验收**：扩展开发宿主已发出启动请求；在侧边栏、编辑区和 Side Chat 分别验证 Alt+A/E/I/P/N、焦点不在 Chat 时不生效、设置录制/禁用/重置/冲突提示、重载和 IME/系统快捷键。快捷键懒恢复单飞，成功/失败回执解除；其他点击恢复的焦点竞态沿用既有语义。
- **2026-11-05 第二轮交互修复（已随 v1.11.0 发布 / 待真机验收）**：滚动条拖拽、Tail、Mermaid 缩放与下拉高度；下一步按 `docs/03-验收清单.md` 264–266 真机验收。
- **2026-11-05 面板五项增强（代码与自动验证完成 / 待真机验收）**：Mermaid 图表与原文切换、代码高亮、双列表搜索、大纲 Messages/Cards、Tail 初始视觉；自动验证 unit 183、宿主 717 通过，真机 259–263 待做。

- **Side Chat 真实验收（已随 v1.10.0 发布 / 待做）**：按「下一步」第一条执行 `npm run dev:host`，覆盖主/Side 工具栏隔离、主双面同步、全局设置共享、来源标题、Side 关闭/重载/Reset，以及真实 agent fork、权限/表单、通知与关闭清理。

- **Jump / Tail 语义修正（已随 v1.9.2 发布 / 待真机验收）**：Jump 置底并恢复当前会话追尾、不改 `tailDefault`；无会话焦点与 `uiPrefs → boot` 顺序已修，真实 Jump click / follow / 草稿与关闭会话 / 偏好顺序回归已补。lint/typecheck ✅、unit **175 / 27 文件** ✅、完整宿主 **657 passing** ✅、完整 Chromium preview ✅、check-docs ✅。下一步 `npm run dev:host` 按 `docs/03-验收清单.md` 257–258 验证持续跟随、新会话默认值、草稿/关闭会话归属与重载偏好。以下为既有待真机验收项。

- **原生弹框改造（2026-10-29 完成 / 待真机验收）**：弹框/确认/重命名已改为面板内浮层，命令 modal 改非模态通知；见「下一步」1。
- **Markdown style 预设重做（已随 v1.8.1 发布 / 待真机验收）**：Follow editor + GitHub / Obsidian / Typora / Atom / Minimal / Things 六套（排版 + `--vac-md-*` 明暗配色）；真 Chromium 已核，下一步见「下一步」4⑦。
- **输入卡交互（已随 v1.8.2 发布 / 待真机验收）**：空输入 / 纯空白时 Send 灰置、`/` 命令面板点空白收起、Effort 图标换形；见「下一步」2 的补充项。
- **滚轮 / 中键：内层卡片焦点门控 + 自动追尾（2026-11-03 代码与自动验证完成）**：横向-only 内容与原生横条上的纵向 wheel 已显式路由到面板；聚焦内层、双轴输入、完整中键候选链、滚动条焦点隔离与直接 diff 单视口均已修复。宿主 650、unit 175、真实 wheel/middle 探针通过；待真机按 `docs/03-验收清单.md` 246–249、256 验收。
- **压缩会话完整历史（2026-11-03，已纳入 v1.9.1 / 待真机验收）**：VAC compact 行改动完成；根因在 `claude-agent-acp` 0.91.0 只用 `getSessionMessages()`（压缩后链），已在 fork 实现完整显示链回放并推送 `dfcefd3`（`src/transcript-chain.ts` + `acp-agent.ts`，适配器单测 11 + 集成 2 通过）。VAC 默认 spec 用 `#main`（commit pin 会触发 npm 10.8.2 的 `GitFetcher requires an Arborist constructor` bug），`AgentMigration` 会把裸 spec 迁到它；下一步 `npm run dev:host` 打开本机一个已压缩的历史会话，验证首条真实提问。
- **Tail / 会话级开关 / 最近目录删除（已随 v1.8.0 发布 / 待真机验收）**：新增 `client/tail.ts`（地址栏
  Tail 按钮 = 自动追尾，滚动即取消）；Times / 自动展开 / 大纲 / Tail 改为「已开启会话落定」
  （拨开关只影响当前会话，新会话才继承新值）；地址栏两图标对调（Tail = 同向下尖角、
  自动展开 = 朝外尖角）；目录抽屉「Recently used」行加删除并按目录同一性去重。细节见 §5.54。
  **2026-11-03 遮挡修复代码完成**：follow/reflow 不再被布局滚动留下的 `pinned=false` 锁死，stream/tool Markdown 每片收尾补 follow；宿主 650、unit 175、完整 Chromium preview 与双遮挡层聚焦探针通过（末条 382 < 顶边 536）。**待真机：`docs/03-验收清单.md` 246–249 + 最后一片 Markdown 撑高、composer/抽屉变高不遮末条。**
- **v1.7.0 真机验收（待做）**：自动检查全绿，具体项见「下一步」4–5。
- **目录抽屉三项 + 本轮三项（已随 v1.8.5 发布 / 待真机验收）**：Recently used 0–30（0 隐藏分组、清空回 8）、已开始会话抽屉去说明、地址栏目录 tip 只留路径；New Session in This Folder 的新 tab 落在源 tab 右侧；恢复提示 Start fresh → New session（进入草稿页）；输入框附件 chip 悬停反馈 + 消息卡片文件引用框选行区间。见「下一步」1。
- **P1-1 Codex 真机验证**（代码已就绪）：步骤见「下一步」5。
- **「滚动条到底、消息仍被截断」待复现**（用户 2026-10-26 报，现场已消失）：日志 2300+ 条 `scroll#` 全部自洽（`cov=0`），现有判据打不到这种形态。**下次出现时先别关面板**，直接读 `~/.vac/vac.log` 抓现场。

## 待归档暂存区（仅本轮未归档的完成项）

- （无。）

## 进行中（半成品 / 未提交）

- （无。）

## 阻塞 / 待决策（Blockers）

- **上架前的截图**：README 与 Marketplace 列表都还没有截图（`ROADMAP.md` P2-5 待办项之一）。

## 下一步（Next Steps）

- **2026-11-05 第二轮真机验收（最高优先）**：`npm run dev:host` → 按 `docs/03-验收清单.md` 264–266 确认：Tail 两角/淡渐隐/无滚动条隐藏/右角让位；流式时慢速拖滚动条 thumb 跟手、仅按下不取消；底部中键/滚轮无位移不取消；Mermaid 大图限高、±10% 缩放与 Reset；两个下拉按面板剩余高度滚动。

- **2026-11-05 五项增强真机验收**：`npm run dev:host` → 按清单 259–263 确认 Mermaid 流式/切换/坏语法、代码高亮、两个搜索框、Cards 大纲定位与重载记忆。

- **Side Chat 第一条动作（真实验收）**：`npm run dev:host` 验证主 A/B 与 Side S/T 的 Tail/Times/Expand/Outline 互不联动、主双面同步、全局设置共享、新会话分别继承本 scope 默认值，以及来源无标题/晚到标题/父改名/长标题 tooltip、Side 关闭/Reload Window/Reset 和无设置齿轮。既有真实 agent 验收继续覆盖同源多个、跨源并存、上下文继承、引用/草稿/附件、后台权限/通知、关闭清理与能力边界。

- **审查修复验收（无需继续编码）**：真实 Claude/Codex 认证、崩溃后 resume/离线手动恢复、多会话草稿/焦点与权限/表单结算；确认远程 CI 结果。P2-4 已按原生正文渲染窗口方案完成（保留 DOM，不是卸载式虚拟列表）。

1. **v1.8.5 真机验收（最高优先）**：`npm run dev:host` → 原生弹框批（Delete/关闭/Rename 浮层、sub-agent 抽屉、设置 Clear/Reset 确认、命令变非模态通知）+ 四项交互（mode picker 靠右；运行中 Esc/标题栏 Stop 出确认；无滚动条卡片滚轮滚面板；引用标签跳转并框选）+ Tail（流式/折叠时不动鼠标按钮不灭；真实滚轮/中键/拖条才关；Tail 关闭后 Jump 自动出现；布局滚动后最后一片 stream/tool Markdown 长高、composer/抽屉变高仍不遮末条）+ 中键（未聚焦长卡片内启动后持续越过卡片滚面板；聚焦后只滚内层；普通区域仍滚面板）+ 卡片聚焦（只认左键；再次左键取消；框选文本/拖动不取消）+ Tab（固定五色；右键 Rename 置顶 / Close 置底 / Mark as unread / Copy working directory）。
   回归：无 chat surface 时权限仍弹原生 QuickPick；`autoAcceptPermissions=allowAll` 仍自动允许；Esc 焦点在输入框与卡片各试一次；Tail 日志看 `tail:off scroll` 是否只出现在真实滚动之后；**目录抽屉**：条数 30/0/越界/清空回显、0 时无「Recently used」分组、已开始会话无说明、地址栏 tip 只留路径；**本轮三项**：新会话 tab 紧贴源 tab 右侧、New session 进草稿页且双面恢复卡片退场、附件 chip 有 hover、卡片文件引用（气泡/回放/markdown/locations）框选正确行区间。
2. **面板交互真机验收（本轮改动，最高优先）**：`npm run dev:host` → 按 `docs/03-验收清单.md`
   **246–256** 逐条确认（滚轮门控、横向/中键嵌套与一张卡一条滚动条；Tail 打开即跟随、一滚就取消；四个开关
   只影响当前会话而新会话继承；自动展开的新图标；最近目录删除及后续面板交互）。
   日志关键字：`focus:` / `wheel-card:` / `wheel-gate:` / `tail:`。
   **v1.8.2 补充**：空输入时 Send 灰、打字即亮；输入纯空白/换行仍灰；带附件可发；轮次中 Stop 可点。
   `/` 面板点面板空白处收起、点输入框不收起；Effort 按钮图标是三根递增信号条且与同排图标对齐。
3. **markdown 补渲染真机验收**：`npm run dev:host` →
   ① 历史会话（如 `94e2fb8a`）打开 ≥3 次，全部记录都是渲染后的样子（含思考块）；
   ② **普通对话里不再出现"最后一条卡片停在原文"**：轮次结束约 0.6s 内自动渲染，
   日志见 `settled markdown for N record(s)`；回放路径见 `pre-rendering markdown for N …`；
   ③ 回归：正在流的回复收尾后仍完整渲染（186 的"只认自己那段文本"不能被放宽）。
4. **v1.7.0 真机验收**：`npm run dev:host` 后确认：
   ① tab 右键两条新项；同目录新建落在源会话 cwd；Duplicate 派生成功且历史可见（失败有提示）。
   ② 设置 → Chat 的默认 Effort / Recently used（0–30，默认 8；0 隐藏该分组）落盘且生效。
   ③ 单行内选中几个字 → 引用 tag 显示 `文件名:N`，发送后 agent 收到 `#LN`。
   ④ 地址栏 Times / 自动展开 / Sub-agents / ☰：关=灰无底框，开=变色有底框（两种主题）。
   ⑤ 模式/模型/Effort/Agent 四个选择器的图标清晰；菜单项两行、选中项打勾；Agent 选择器可切换。
   ⑥ hover 会话 tab / 目录图标：SessionId 与 State 为灰色，目录提示无 `Dir:` 前缀。
   ⑦ 设置 → Appearance 的 Markdown style 即时生效：Follow editor 与改动前一致；
      GitHub / Obsidian / Typora / Atom / Minimal / Things 六套在明暗主题下各有排版与配色差异。
   ⑧ 设置作用域：Custom models 胶囊 = `All IDEs`，改描述后输入卡菜单立即变；
      有工作区覆盖时显示 `Workspace` + `Overridden by workspace settings`；Inspect 的
      Open / Remove / Make this the default for all IDEs 可用。
5. **P1-1 Codex 真机验证**：`npm run dev:host` → 连 Codex CLI → 发一条会跑命令的消息
   （如「列出当前目录文件」），确认：① 工具卡里直接显示命令输出（console 文本），失败时有「Exited with code N」；
   ② 模式 / 模型 / 推理强度选择器可切换；③ 未登录机器上选 API Key → 输入 key → 重启后不再询问；
   ④ `VAC: Log Out of Agent` 后再发消息会重新要求认证；⑤ Dashboard 的 Codex 用量与 `~/.codex/sessions` 对得上；
   ⑥ `vac.agents` 里仍是旧包 `@zed-industries/codex-acp` 时，激活弹迁移提示。
   顺带回归 Claude：Bash 输出、子 agent 嵌套、历史补全（按 kind 改造后）不变。
6. **滚动问题复现时抓现场**：`~/.vac/vac.log` 的 `scroll#` 行——`cov=1` 即定案；全是 `cov=0` 时优先看
   末条 `last`/`comp`、`#messages` 的 rect 与 `window.innerHeight`、以及抽屉变量（`ev=` / `pv=`）。
7. **历史遗留验收（低优先）**：v1.4.0/M4、v1.3.1、v1.3.0 的验收清单仍挂着，先按 1–5 走。
8. **之后按 ROADMAP**：P1-8 连接健壮性 → P1-9 SDK 新更新类型 → P1-3 打包瘦身 → P2-*。

## 如何运行 / 测试（Quick Verify）

- 运行（开发宿主）：`npm run dev:host`（宿主窗口内 `Ctrl+R` 重载生效）
- 构建：`npm run compile`；生产打包：`npm run package`；打 `.vsix`：`npm run vsix`（产物落 `release/`）
- **图标**：`npm run icon`（改 `scripts/make-icon.mjs` 顶部的 `MARKS` 几何后重跑；
  `--preview` 另出多尺寸预览图到系统临时目录）。`resources/icon.*` 是生成物，不要手改。
- 校验/测试：`npm run test:unit`（vitest，秒级）· `npm test`（编译 + lint + 真实宿主测试；若 shell 带 `ELECTRON_RUN_AS_NODE=1`，用 `env -u ELECTRON_RUN_AS_NODE npm test`；最低宿主可用 `VSCODE_TEST_VERSION=1.85.0`，本机剪贴板用例偶发失败时可换 1.144.1）
- lint / 类型：`npm run lint` · `npm run typecheck`
- 文档体检：`sh check-docs.sh`
- agent 能力探针：`node scripts/probe-agent-init.mjs --agent "npx -y @agentclientprotocol/codex-acp" --session`
  （每次 `--session` 会在该 agent 的历史里留一个空会话；输出含本机模型配置，别提交）
- 端到端：需本机可执行 `npx`（默认 agent 经 `npx` 拉起 Claude Code / Codex 的 ACP 适配器）

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

## 待解问题 / 给用户的提问（Open Questions）

- Dashboard 的价格表（`PRICING_AS_OF = '2026-01'`）需要按官方口径复核。
- 是否要在首个发布版本里保留 `vac.restoreSessionsOnOpen` 的默认 `ask` 行为。
- `doc-audit` skill 的扫描范围仍是「5 份根文档 + `docs/00-目录.md`」，**未覆盖 `arch/*.md`**——
  上次分册的漂移正是靠人工扫出来的（此前用户选择先不改 skill）。
- 活跃会话豁免 LRU；工具的 agentTerminal ID 总数仍无硬限。真实 agent 验收重点核对大结果截断与 Windows batch 保守参数限制。
