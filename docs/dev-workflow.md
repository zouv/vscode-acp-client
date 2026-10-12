# 本地开发与验收流程

> **这是什么**：怎么把扩展跑起来、怎么改完立刻看到效果、手动验收时该看哪几个地方。
> 属于**按需查阅**文档——`AGENTS.md` 只留一行指针，避免给每个会话都加这个上下文。
>
> **配套**：代码位置查 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)；历史坑点查 [`pitfalls.md`](./pitfalls.md)；
> 面板的手动验收清单（编号 1~241）见 [`03-验收清单.md`](03-验收清单.md)。

---

## 启动 Extension Development Host

### 方式一：`npm run dev:host`（推荐）

```bash
npm run dev:host                     # 先编译，再启动宿主窗口
npm run dev:host -- --no-build       # 跳过编译，直接启动
npm run dev:host -- "F:\path\to\xxx"                  # 指定目录（默认本仓库）
npm run dev:host -- "F:\path\to\xxx.code-workspace"   # 指定 .code-workspace 文件（多根工作区）
```

> 用**项目自己的工作区**做真机验收（比如对着实际要用的多根工作区跑）就走最后一条：宿主窗口用你
> 日常的配置与已装扩展启动，只是多加载了本仓库这份开发中的扩展（命名空间 `vac.*`，与上游同装不冲突）。
> 路径含空格时整体加引号。

默认**先编译再启动**是有意的：忘了编译就会测到旧产物，那是"改了半天没生效"最常见的来源。

实现见 `scripts/dev-host.mjs`。用 Node 而不是把命令直接写进 `package.json` 的 `scripts`，
是因为 npm 在 Windows 默认走 cmd.exe、macOS/Linux 走 sh，`%CD%` 与 `$PWD` 互不通用，
而 `--extensionDevelopmentPath` 需要**绝对路径**（同 pitfalls #8 里"自检脚本从 bash 移植到 Node"的理由）。

### 方式二：直接敲 code 命令

```powershell
# PowerShell / CMD（code 已在 PATH 上）
code --new-window --extensionDevelopmentPath="D:\Git\zgithub\custom-vscode-acp" "D:\Git\zgithub\custom-vscode-acp"

# Git Bash：编译 + 启动一步到位
npm run compile && code --new-window --extensionDevelopmentPath="D:/Git/zgithub/custom-vscode-acp" "D:/Git/zgithub/custom-vscode-acp"
```

`code` 不在 PATH 时用全路径：`& "D:\Program Files\Microsoft VS Code\bin\code.cmd" --new-window ...`

> `code` 不在 PATH 的永久解法：VS Code 命令面板 → `Shell Command: Install 'code' command in PATH`。

### 方式三：在仓库窗口按 F5

`.vscode/launch.json` 的 "Run Extension"，`preLaunchTask` 是 `npm: watch`（会持续重建）。

### 三种方式的区别

| | `npm run dev:host` | 直接敲 `code` | 仓库窗口按 F5 |
|---|---|---|---|
| 加载扩展 | ✅ | ✅ | ✅ |
| 自动编译 | ✅（可用 `--no-build` 关掉） | ❌ | ✅（watch 任务） |
| **附加调试器**（断点、`launch.json`） | ❌ | ❌ | ✅ |
| 需要先打开仓库窗口 | 不需要 | 不需要 | 必须 |
| 适合 | 手工点击验收 | 脚本里调用 | 断点排查逻辑 |

---

## 改了代码之后怎么重载

在**宿主窗口**（标题带 `[扩展开发宿主]`）按 **`Ctrl+R`** 重载扩展宿主，即可加载新的 `dist/extension.js`。
**不需要关掉重开。**

完整循环：

```
改代码  →  npm run compile  →  宿主窗口 Ctrl+R  →  重新操作验证
```

> **不能**只按保存就生效——宿主加载的是 `dist/extension.js`（esbuild 产物），不是 `src/`。
> 这也是 `npm run dev:host` 默认先编译的原因。

---

## 排查入口：日志已经落盘（先读文件，别让用户手工拷）

宿主 `src/utils/Logger.ts` 的 `log()` / `logTraffic()` 除了写输出通道，还会**异步追加**到：

```
~/.claude/acp-client-custom.log        # Windows: %USERPROFILE%\.claude\acp-client-custom.log
```

- **webview 客户端的 `console.warn` / `console.error` 也在里面**（经 `clientLog` 消息转发给宿主的 `log()`），前缀是 `chat-panel: client(warn):`。所以面板里的运行时问题（markdown 不渲染、布局改动没生效、消息被丢弃……）**都能在这里找到证据**。
- 排查姿势：`grep -n "vac\]" <file> | tail -40`，或按会话 id / 关键词过滤。文件超过 5MB 会**轮转**（旧文件改名成 `<file>.1`，只留一份备份，新日志从空文件开始）——排查"刚刚那次"的现场时，若当前文件是刚轮转过的空壳，**上一段会话在 `.1` 里**（pitfall #61：这里原先是"截断清零"，恰好会毁掉要查的那一段）。
- 需要新证据时，在 `src/ui/chat/html/client/*.ts` 里加一行 `console.warn('[vac] …')` 就会自动进文件（⚠️ 模板体内禁用反引号，见 pitfalls #11）。
- **先确认"这个窗口跑的是哪份代码"**（CUSTOM-20261002-173）：日志首行是
  `ACP Client extension activating... [build v0.2.0-custom.6·2819d85·2026-10-02T13:45:07.598Z·9f3e1a2b4c5d(2110432B)]`，
  客户端每次加载还会报一条 `chat-panel: client(info): build …`。
  · 两行都有且**等于当前 `dist` 的指纹** ⇒ 这个窗口跑的就是当前代码；
  · 客户端报的是**旧值**（或只有宿主那行、客户端那行是旧的）⇒ webview 是旧的，重开面板/重载窗口；
  · **两行都没有** ⇒ 这个窗口压根没重载过（改了代码要先 `npm run compile` 再 `Ctrl+R`）。
  这条是"我改了但没生效"类问题的第一道判据，别再靠"应该重载了吧"来猜。
- **客户端日志有配额**：转发是**滚动窗口**（每 10 秒最多 30 条，超出丢弃），
  所以"日志里没有某条诊断"要先确认配额没被别的噪声吃满（markdown 那条诊断已限流，见 pitfalls #42）。
- **不要请用户从输出面板手工拷贝日志** —— 这个文件存在的唯一目的就是省掉那一步（见 pitfalls #35）。

## 记录区布局：自己截图看（`preview-records.mjs`）

```bash
node scripts/preview-records.mjs            # 生成 + 截图，打印 PNG 路径
node scripts/preview-records.mjs --keep     # 保留中间 HTML，便于改 CSS 后手动刷新
node scripts/preview-records.mjs --print    # 只生成 HTML 不截图
```

- **它是什么**：把 `styles.ts`（CSS）、`body.ts`（标记）、`client/index.ts` 里的全部客户端模块
  抽出来拼成一个独立 HTML，用本机 Chrome/Edge 无头渲染，截 `#expanded` 与 `#collapsed` 两张图。
  夹具（`FIXTURES`）在脚本里，改它就能摆出你想看的那几条记录。
- **为什么不直接 F5**：F5 要编译、要启动宿主、要会话说得上话；布局问题**大多与协议无关**，
  这个脚本 2 秒出图，而且**AI 可以直接读图**（`Read` 一个 PNG）——所以它既能给人看，也能给 AI 自查。
- **量对齐用 `#probe`**（`CUSTOM-20260929-122`）：`records.html#tools-probe` 会把每个 `.tool-seg` 的
  **实测几何**（标签/内容/内层元素的 `left` 与内边距）写进一个 `<pre id="probe">`，
  配合 `chrome --dump-dom … | grep -o '{"seg":[^}]*}'` 读回坐标。**对齐这类问题肉眼经常骗人**
  （字体度量、内边距、UA 默认样式各差几像素），量一次就定位。
- **边界**：它验证的是"**这套 CSS + 这套 DOM 会长成什么样**"，不是"VS Code 里长成什么样"。
  主题色/字体度量/真实宽度、以及所有交互（键盘、滚动、悬停、点击）都还在人工那一侧（见上表）。

---

## 自动化能覆盖到哪、哪些必须人工

**这张表存在的理由**：这个面板的 bug 有两大类，**一类能自动测，一类不能**。
知道分界线在哪，才不会把时间花在重跑 `npm test` 去等一个它看不见的问题。

| 层面 | 自动化？ | 靠什么 / 为什么不能 |
|---|---|---|
| 类型、未使用符号、构建 | ✅ | `npm run compile` / `tsc` / `eslint` |
| 客户端脚本能不能解析（模板字符串里的反引号、转义） | ✅ | `npm run compile` 的 **`precompile` 钩子**直接跑 `check-webview-client.mjs`（CUSTOM-20260928-102） |
| 源码卫生（换行符、控制字符） | ✅ | `check-docs.sh`（文档侧）；`check-webview-client.mjs` 按原始模板文本解析客户端脚本 |
| 嵌套推断的护栏行为 | ✅ | `src/test/nesting.test.ts`（11 条） |
| **ACP 表单请求（elicitation / AskUserQuestion）** | ⚠️ 桥可单测，协议面须探针 | 桥的逻辑（FIFO/三态/降级）由 `src/test/elicitation-bridge.test.ts` 覆盖；客户端表单由桩 DOM 覆盖；**"adapter 到底发不发、发的形状对不对"只能实跑**：`node scripts/probe-elicitation.mjs`（真 agent、一轮额度、会在会话历史留一条）。它支持 `--no-answer` / `--reopen <id>` 复现"会话停在提问上"，**实测重开不会重抛提问**（pitfalls #32） |
| **宿主发给 webview 的协议流**（记录有没有建出来、有没有永远 streaming、快照与增量是否一致） | ✅ | `src/test/chat-panel.test.ts`（`CUSTOM-20260925-054`），由**真实抓包的 replay 夹具**驱动 |
| **布局与观感**（空白条、条目被压扁、diff 被折叠、按钮化后外观错位、焦点环、滚动跟随） | ⚠️ **记录区可自动截图；其余仍须人工** | `preview-records.mjs`（`CUSTOM-20260929-116`）把 webview **真正用的** CSS/标记/客户端模块拼成一个独立 HTML，交给本机 Chrome/Edge **无头截图**（`#expanded` / `#collapsed` 各一张）⇒ 记录区的折/展形状、占几行、有没有重复的首行，**在 F5 之前就能看到**（这一条是 `114/115/116` 连续两次翻车换来的，见 `docs/pitfalls.md` #31）。它**测不了**：真实主题色与字体度量、VS Code 自己的布局（气泡宽度、侧边栏宽度是脚本自己选的）、以及**交互本身**。**jsdom 不是 Chromium**，用它测布局只会给出假信心。
**但"点击"是可以在这里量的**（`#stickynarrowstickyclickprobe`、`#linkclickprobe`）：驱动脚本在真页面上派发一次真 `MouseEvent`，把**桥的出口**（`NS.bridge.post`）拦下来记一笔就得到"这次点击到底发了什么消息"——不需要人去看 Output。前提是那条链**同步**走完（CLICK → 委托 → post）；要等异步回填的（如 `window.postMessage` 那类）就得按 `#bootround` 的姿势挂定时器晚采样。键盘 / 悬停 / 读屏仍然只能人工 |
| **键盘与读屏**（Tab 顺序、`aria-busy` 的播报时机、焦点落点） | ❌ **必须人工** | 需要真交互与辅助技术 |
| **需要真实 agent 的行为**（replay 内容、权限弹窗、工具卡内容） | ⚠️ 夹具化后✅ | 协议形状变了要**重抓**夹具（见下）；抓包本身要花额度 |

**重抓 replay 夹具**（只在协议形状变化时才需要）：

```bash
node scripts/capture-acp-replay.mjs --out src/test/fixtures/claude-code-session-load.json
```

**它真的会拉起 agent、花额度、并在该 agent 的会话历史里留下一个新会话。**
它抓 live 与 replay 两段流写进同一个文件（测试靠这一点做"实时 vs 重开"对比），
在一次性临时目录里跑（绝不在仓库内跑，因为 agent 会读写文件）。

**报告"重开了但内容不对"时的第一步**：不要先看截图，先看 `npm test` 里
`chat-panel: real session/load replay` 那条**诊断**输出——它打印 live 与 replay 的**通知类型直方图**。
`replay:` 里有 `agent_message_chunk` / `agent_thought_chunk` ⇒ **是我们丢了**；
没有 ⇒ agent 没回放，那时该改的是渲染方式，而不是去修丢内容。
（这条判据是 `CUSTOM-20260925-055` 用一整天换来的，见 `docs/pitfalls.md` #22。）

---

## 手动验收时该看哪几个地方

按排查效率排序：

| 位置 | 看什么 |
|---|---|
| **`Developer: Open Webview Developer Tools`** | **webview 客户端 JS 的唯一报错出口**。`src/ui/chat/html/client/*.ts` 是内联脚本，tsc/lint 看不到运行时问题。命令面板里搜 `webview` 即可找到 |
| 输出通道 **`VAC`** | 扩展侧日志。聊天面板相关搜前缀 `chat-router:`（面板路由决策）与 `chat-panel:`（面板收到的消息与错误）。**性能相关搜 `chat-panel: outbox`**——每轮结束时打一行 `sent=N merged=M queued=K`，`merged` 高说明流式合帧在工作 |
| 输出通道 **`VAC Traffic`** | ACP 协议**原始报文**（受 `vac.logTraffic` 控制，默认开）。很多时候是 agent 没发某条通知，而不是面板没渲染 |
| 命令面板搜 `VAC` | 应该列出 22 个 `vac.*` 命令。少于 22 个说明扩展没完整激活 |

**两个 surface**（同一套实现，共享同一个面板宿主 `ChatPanelHost`）：

- 侧边栏 `vac-chat` 视图 / 编辑区标签页 `VAC Chat`（`vac.openChatInEditor` 或 `Ctrl+Alt+A` 打开）
- 两者共享同一份会话记录：同一会话在两边会同步收到相同的流式更新
- DevTools Console 里敲 `window.__vac` 可确认客户端脚本已启动

---

## 手动验收清单

> 已独立成篇：[`03-验收清单.md`](03-验收清单.md)——编号 1~241、按日期分批（2026-09-26 起）。
> **布局与观感类问题只能人工验收**，改面板前后按那份清单抽查。

---

## 常见问题

**窗口没出现 / 很快消失**
`code --version` 是否可用？不可用见上面「方式二」的全路径写法与永久解法。

**改了代码但界面没变**
漏了 `npm run compile`，或忘了在宿主窗口按 `Ctrl+R`。两者都要。

**扩展没激活 / 命令数不对**
命令面板搜 `VAC` 应见 22 个 `vac.*` 命令。若侧边栏没有图标，确认启动参数里 `--extensionDevelopmentPath`
指向的是**仓库根目录**（不是 `src/`）。

**webview 一片空白**
先看 Webview Developer Tools 的 Console——白屏几乎总是客户端 JS 抛异常，而异常**不会**出现在扩展侧输出通道里。
