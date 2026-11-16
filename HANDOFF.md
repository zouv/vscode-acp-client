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

- **最近更新**：2026-11-16
- **整体状态**：v1.17.0 已发布（GitHub Release 附 `vscode-acp-client-1.17.0.vsix`）。本轮包含记录区搜索、页签 Open working directory、草稿页签位置继承、图片右键复制、两个搜索框自动聚焦、斜杠命令 token 规则，以及草稿首条消息行区间修复；自动验证已过，**真机验收待做**。
- **当前分支（必填）**：`main`（工作区改动未提交）。
- **最后验证状态**（2026-11-17）：`typecheck` / `lint` / `check-webview-client`（40 个客户端模块）✅；unit **412 / 49 文件** ✅；真实宿主 **842 passing / 0 failing** ✅。另用真 Chromium（`preview-records` 生成的页面）验证了：Ctrl+F 打开/聚焦、默认范围 3 条 / All cards 4 条、CSS 高亮注册成功、两个抽屉打开即聚焦搜索框、图片放大层右键菜单在浮层之上（z-index 100）且 Copy image 能走到 ClipboardItem 写入。

## 当前任务（In Progress）

- **本轮 6 项交互改进的真机验收**（改动与自动验证见下）：
  1. 会话页签右键 **Open working directory**：在系统文件管理器中打开 cwd；无 cwd 时置灰。
  2. 拖拽 **New Session** 草稿页签后发送首条消息，新会话页签留在草稿原位置，不再跳到最后。
  3. 记录区 **Ctrl/Cmd+F** 搜索：只搜消息卡片；Enter / Shift+Enter 前后跳；命中滚动到视口并高亮；**All cards** 勾选状态持久化（新会话沿用）。默认仅对话正文。
  4. 图片放大层右键 **Copy image**：写入 PNG 到剪贴板（Clipboard API，失败有 clientLog）。
  5. 打开工作目录抽屉 / 会话历史列表时自动聚焦搜索框。
  6. 斜杠命令列表按第一个空格截断 token；命令 token 右侧 / 空格后的文字不干扰过滤；选中命令只替换 token、保留行内其它文字。
- **待验收（最多 5 条）**：
  1. 真机 webview 里 Ctrl+F 是否被 VS Code 自身快捷键截走；高亮在流式输出期间是否自动跟随。
  2. Windows 剪贴板右键复制图片在真实面板里是否成功（浏览器需要文档焦点 + Clipboard 权限）。
  3. 页签拖拽 + 首条消息的组合（含“新建到右侧”入口）位置是否正确。
  4. 目录抽屉 / 历史列表打开后直接打字是否能过滤（焦点是否真的落在输入框）。
  5. 斜杠命令：行首 `/c` + 右侧旧正文、以及光标进入参数区后列表收起。
- 历史验收细节见 `docs/03-验收清单.md`；更早的会话记录查 git log。

## 待归档暂存区（仅本轮未归档的完成项）

- （无。）

## 多根工作区（已实现）

- 默认 cwd：`vac.defaultWorkingDirectory` → 活动编辑器所在 workspace folder → 最后编辑过的目录（编辑器区聊天面板激活时兜底）→ 第一个根。见 `SessionManager.resolveDefaultCwd` / `cwd.ts:preferredWorkspaceFolder`。
- 新设置 `vac.autoAddWorkspaceFolders`（默认关）：草稿创建时把其它 workspace 文件夹种进 `additionalDirectories`，显示为可删除 chips；只种一次，用户删掉后不再回填。走的是既有 `--add-dir` 通道（与官方 Claude 扩展一致）。
- 仍未做：历史缓存 / 磁盘补扫 / Agents 树仍只按第一个根扫描；如需聚合全部根，另做（见 ROADMAP/下一步）。

## 进行中（半成品 / 未提交）

- （无。）

## 阻塞 / 待决策（Blockers）

- **上架前的截图**：README 与 Marketplace 列表都还没有截图（`ROADMAP.md` P2-5 待办项之一）。

## 下一步（Next Steps）

1. `npm run dev:host`，按「当前任务」的 5 条重点做真机验收。
2. 验收发现问题时在 `CHANGELOG.md` 的 `[未发布]` 记录修复并补测试。
3. 继续 `ROADMAP.md` 的 P1-8 连接健壮性 → P1-9 SDK 更新类型 → P1-3 打包瘦身。

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
