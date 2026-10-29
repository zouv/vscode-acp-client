// 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// postMessage 协议：**从第一天起就是 session 作用域的**——每一条会话相关的消息都同时携带
// agentName 与 sessionId，接收端校验二者匹配后才生效，绝不静默落到「当前聚焦会话」上。
import type { SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk';
// [CUSTOM- ACP SDK 1.x 删掉了 models API（说明见 core/SessionManager.ts 的同名注释）。
import type { SessionModelState } from '../../core/SessionManager';
// [CUSTOM- 自定义模型类型从共享的 config 模块引入（SessionManager 也要读同一份）。
import type { CustomModel } from '../../config/CustomModels';
// [CUSTOM- 设置项的存储作用域（All IDEs / This IDE / Workspace）由宿主算好再下发。
import type { SettingScope, SettingSource } from '../../config/GlobalSettings';

import type { EntryPatch, TranscriptEntry, TranscriptSnapshot } from './transcript/types';
import type { ToolCallView } from './content/toolCalls';
import type { HistoryDirOption } from './historyDirs';

/** Why a session left the live set (mirrors SessionManager.SessionCloseReason). */
export type CloseReason = 'user' | 'agent-disconnected';

/** Compact per-session summary used to render tabs without a full snapshot. */
export interface SessionSummary {
  sessionId: string;
  agentName: string;
  title: string | null;
  cwd: string;
  createdAt: string;
  /** Replay-in-progress flag (`session/load`). */
  loading: boolean;
  /** A prompt turn is running. */
  running: boolean;
  /**
   * [CUSTOM- The session produced output while it was NOT the
   * focused one — drives the tab-strip attention dot. A hint, never a
   * notification: nothing pops up and focus is never stolen.
   */
  unread: boolean;
  /**
   * [CUSTOM- 2026-10-27：agent 的类型（claude / codex / generic）。只用于 agent 选择器
   * 的第二行说明与图标；老调用方不传也不影响。
   */
  agentKind?: string;
  /**
   * [CUSTOM- A permission prompt or a form is parked on this session, so
   * nothing moves until the reader answers. Distinct from `running`: both are usually
   * true at once, and the tab dot paints them with two independent signals (colour vs.
   * the pulsing ring).
   */
  waiting: boolean;
}

/** Everything the panel needs to render one session's header + composer. */
export interface SessionMeta {
  sessionId: string;
  modes: SessionModeState | null;
  models: SessionModelState | null;
  configOptions: SessionConfigOption[] | null;
  availableCommands: Array<{ name: string; description: string; inputHint?: string | null }>;
  usage: {
    used: number;
    size: number;
    costAmount?: number;
    costCurrency?: string;
    /**
     * [CUSTOM- 思考/推理 token 数（`usage_update.thoughtTokens`）。
     * ACP 的 Usage 类型里有这个字段，但实测当前适配器没发过来 —— 有就显示，没有就不显示。
     */
    thoughtTokens?: number;
  } | null;
  /**
   * Pending attachments for this session. Carried on `meta` (and therefore on
   * `boot`/`focus`) so the chips survive a session switch rather than being
   * cleared client-side while the extension still holds them.
   */
  attachments: Attachment[];
  /**
   * [CUSTOM- The session's agent takes messages **mid-turn**
   * (`_session/steering`, advertised at handshake). The composer reads it to decide what
   * Enter does while a turn is running: send, or (unsupported) stay put and say so —
   * a silent no-op is what the user reported as "the input can't be sent any more".
   *
   * Optional, and **absent means unsupported**: the field is a capability the host may
   * not know yet (no connection, an older extension host), and guessing "supported"
   * would send a message into a hole.
   */
  steering?: boolean;
  /**
   * [CUSTOM- 会话的额外根目录（多根工作区）。随 meta/focus/boot 下发，客户端只读
   * 展示 —— additionalDirectories 创建后锁死不可改。缺省 = 没有额外根。
   */
  additionalDirectories?: string[];
  /**
   * [CUSTOM- 全局共享的自定义模型别名（`vac.customModels`）。随 meta/focus/boot 下发，
   * 客户端只在 model 下拉里追加一个「自定义」分组展示，不与 agent 的 configOptions 合并。
   */
  customModels?: CustomModel[];
}

/** Incremental patch for an existing transcript entry (streaming text, status). */
export type { EntryPatch };

export interface Attachment {
  path: string;
  name: string;
  // 输入框图片：image 附件把字节留在宿主内存，
  // 只有 `path`（合成 id）+ `kind`/`mimeType` 走协议；base64 绝不进 meta（否则每次
  // boot/focus 都重发整张图）。
  kind?: 'file' | 'image';
  mimeType?: string;
  // [CUSTOM- 引用一个**正在编辑器里看着的文件**时带上选区行区间（1 基、含两端）——
  // 它进 `name`（人看的 tag 上写出来）与资源链接的 `#L12-40` 片段（agent 也看得到）。
  lineStart?: number;
  lineEnd?: number;
}

/**
 * [CUSTOM- 一条「上次打开过的会话」：够恢复它（agent + id + cwd），也够在 tab 上写出名字。
 * `cwd` 决定 agent 侧从哪个目录找它（057/083 —— 不传就会当成当前工作区的会话）。
 */
export interface RecoverableSession {
  agentName: string;
  sessionId: string;
  cwd?: string;
  title?: string;
  /** [CUSTOM- 写下这条快照时所在的 IDE（VS Code / Insiders / VSCodium…）。
   * 各 fork 默认各有 userData 目录，快照不会串；但 portable / 共享 --user-data-dir 时会，
   * 所以每条自带环境名，卡片上标出来。 */
  app?: string;
}

/** [CUSTOM- 重开面板时的策略：每次问 / 直接恢复 / 不问也不恢复。 */
export type RestoreChoice = 'ask' | 'always' | 'never';
/** Webview UI prefs that must survive webview disposal (window reload / editor-panel
 * recreation). Persisted in the extension host's `globalState`. */
export interface UiPrefs {
  outlineMode: 'popup' | 'sidebar';
  outlineWidth: number;
  // [CUSTOM- Tab 栏的手工顺序（会话 id 数组）。与大纲偏好共用**同一条**
  // globalState 记录：顺序是工作区级的事（两个面、两个窗口看到的是同一条），
  // 而 **不是**会话作用域的（`setUiPref` 因此仍在 verifySession 守卫之前处理）。
  tabOrder?: string[];
  // [CUSTOM- 记录区「Times」（每条记录的时刻）开关。**不是**一个布尔：
  // · timesBySession 记用户**在那个会话里**最后一次拨动的值；
  // · timesDefault 是用户最后一次在**任何地方**拨动的值 —— 没有记录的会话与草稿页用它。
  // 有效值 = timesBySession[id] ?? timesDefault。存在宿主而不是 webview 本地：关掉编辑器面板、
  // 重载窗口之后它还该在（vscode.setState 会随文档一起没），两个面也该看到同一条。
  timesBySession?: Record<string, boolean>;
  timesDefault?: boolean;
  // [CUSTOM- 右侧大纲栏的**开/关**：同样"按会话记 + 一个默认值"（与 Times 同一形态）。
  // `outlineMode` 仍是"要不要允许出现侧栏"这个**布局**偏好；这里记的是"这个会话里它开着吗"——
  // 侧栏里是**这个会话**的对话大纲，A 开着不代表 B 要开着（用户明确要求）。空表 = 还没有任何记录。
  outlineOpenBySession?: Record<string, boolean>;
  outlineOpenDefault?: boolean;
  // [CUSTOM- 「新输出自动展开」（2026-10-21）：与 Times 同一形态 ——
  // autoExpandBySession 记用户在那个会话里拨的值，autoExpandDefault 是没有记录的会话的默认。
  // autoExpandKinds 是**全局**的卡片类型白名单（tool / thought / diff），来自设置面板。
  autoExpandBySession?: Record<string, boolean>;
  autoExpandDefault?: boolean;
  autoExpandKinds?: string[];
  // [CUSTOM- 自动展开后的卡片**最大高度**（px，0 = 不限）。超出部分在卡片内部滚动。
  // 只作用于"自动展开"的那几张卡；用户手动点开的卡不受限。
  autoExpandToolHeight?: number;
  autoExpandThoughtHeight?: number;
  // [CUSTOM- 子代理工具卡紧跟父卡分组显示（true = 平铺）。默认 undefined = 分组。
  flatTools?: boolean;
  // [CUSTOM- 输入卡最大宽度 / 输入框最大高度（px）。0/undefined = 用 CSS 默认值。
  composerMaxWidth?: number;
  inputMaxHeight?: number;
  // [CUSTOM- 发送快捷键：enter（默认）或 ctrlEnter。
  sendKey?: 'enter' | 'ctrlEnter';
  // [CUSTOM- 每个 agent 的默认模型（新建会话时套用）；空串/缺省 = 由 agent 决定。
  defaultModelByAgent?: Record<string, string>;
  // [CUSTOM- 每个 agent 的默认推理强度（config option `category === 'thought_level'`，
  // 新建会话时套用）；空串/缺省 = 由 agent 决定。与默认模型同一形态、同一族设置 key。
  defaultEffortByAgent?: Record<string, string>;
  // [CUSTOM- 目录选择抽屉里「Recently used」最多列几条（3–16，默认 8）。
  recentDirectoryLimit?: number;
  // [CUSTOM- 「Tail」（消息面板自动追尾，2026-10-28）：与 Times 同一形态 ——
  // tailBySession 记用户在那个会话里最后的开关状态，tailDefault 是没有记录的会话的默认值
  // （默认 **true**：不开按钮时也照旧自动跟到最后一条）。滚轮/滚动条一旦改变用户阅读进度，
  // 客户端会把它就地关掉（只改这个会话那一条，不动默认值）。
  tailBySession?: Record<string, boolean>;
  tailDefault?: boolean;
  // [CUSTOM- Markdown 渲染预设。`editor` = 跟随编辑器（现有逻辑，默认）。
  markdownStyle?: 'editor' | 'github' | 'obsidian' | 'typora' | 'atom' | 'minimal' | 'things';
}

/** [CUSTOM- 设置面板的分组。左侧导航按这个顺序排；没有条目的分组不显示。 */
export type SettingsGroup = 'general' | 'chat' | 'appearance' | 'advanced';

export interface SettingOption {
  value: string;
  label: string;
}

/**
 * [CUSTOM- 设置面板的一行。宿主是**唯一写者**：它按 key 决定写 VS Code 配置还是面板 UiPrefs；
 * 客户端只渲染与回传。`type: 'action' | 'info'` 的行没有 value（按钮 / 只读信息）。
 */
export interface SettingItem {
  key: string;
  group: SettingsGroup;
  label: string;
  description?: string;
  type: 'boolean' | 'select' | 'number' | 'text' | 'action' | 'info' | 'json' | 'models';
  /** [CUSTOM- boolean / string / number；`json` 是对象、`models` 是数组。客户端按 type 解释。 */
  value?: unknown;
  options?: SettingOption[];
  warning?: string;
  /** `action` 行的按钮文案（缺省 = "Run"）。 */
  actionLabel?: string;
  /**
   * [CUSTOM-20261029] `action` 行的二次确认文案（有值时客户端先弹面板内浮层，
   * 确认后才发 `settingAction`）。破坏性动作（清缓存 / 重置偏好）用它，
   * 避免直接把不可逆操作挂在一次点击上。
   */
  confirm?: string;
  /** 子项：卡片类型复选框缩进显示在主开关下面。 */
  indent?: boolean;
  /** [CUSTOM- number 行的输入范围（缺省沿用各调用点原来的 0/2000 与 160/480 规则）。 */
  min?: number;
  max?: number;
  /** [CUSTOM- 这一项默认属于哪一层；`source` 给出当前实际生效层与各层取值。 */
  scope?: SettingScope;
  source?: SettingSource;
}

/**
 * A transcript entry as sent over the wire. Tool entries carry no payload of
 * their own (the transcript only knows the `toolCallId`), so the extension
 * attaches the rendered view model alongside.
 */
export type WireEntry = TranscriptEntry & { toolView?: ToolCallView };

/** One entry of the panel's history picker (agent-side list or local cache). */
export interface HistorySessionSummary {
  sessionId: string;
  title?: string | null;
  cwd?: string;
  /**
   * [CUSTOM- Normalized identity of `cwd` (see historyDirs.directoryKey).
   * Computed by the HOST because the identity depends on the platform (Windows and
   * macOS fold case, Linux does not) — the client only ever compares two keys, so
   * "are these the same folder" is answered in exactly one place.
   */
  dirKey?: string;
  /** ISO timestamp of the last activity, when the source reports one. */
  updatedAt?: string;
  /**
   * [CUSTOM- True for a row that came from the LOCAL CACHE alone — the
   * agent's `session/list` did not mention it (it omits sessions still open elsewhere,
   * measured). Rendered as an honest hint: such a row may no longer exist agent-side.
   */
  fromCache?: boolean;
  /**
   * [CUSTOM- True for a row recovered from the agent's OWN transcript
   * directory (Claude Code storage) — the agent's `session/list` did not report it, which
   * is exactly what the official panel reads instead. Same honesty rule as `fromCache`:
   * say where it came from, because it may still be open elsewhere.
   */
  fromDisk?: boolean;
}

/** extension → webview */
export type ExtToChat =
  // [CUSTOM- `agentConnected` drives the empty state's copy (and whether
  // its button is "Connect Claude Code" or "New session"): a sessionless panel can have
  // a live agent process — closing the last session does not stop it. Optional so an
  // older surface simply keeps the old copy.
  // [CUSTOM- `defaultCwd` 是「没有聚焦会话时地址栏该显示什么」的那份内容
  // （宿主 `resolveDefaultCwd()`：下次会话将建在这里）。随 boot 走而不是客户端自己猜：
  // 默认目录的三级回退（配置 → 第一个工作区文件夹 → cwd）只有宿主知道，且 058 的草稿页
  // 展示的是**同一份**值（pitfalls #19：同一份知识不要存两份）。
  | { type: 'boot'; focused: SessionSummary | null; sessions: SessionSummary[]; snapshot: TranscriptSnapshotWire | null; meta: SessionMeta | null; agentConnected?: boolean; autoConnect?: boolean; defaultCwd?: string; recoverable?: RecoverableSession[]; restorePref?: RestoreChoice }
  | { type: 'focus'; summary: SessionSummary | null; snapshot: TranscriptSnapshotWire | null; meta: SessionMeta | null; agentConnected?: boolean }
  | { type: 'sessionsChanged'; sessions: SessionSummary[]; agentConnected?: boolean }
  // [CUSTOM- 2026-10-29：宿主请求弹出"停止本轮"确认条（侧边栏标题栏 Stop / 命令面板）。
  // 客户端只负责显示；真正的 cancelTurn 仍由用户在 #stopConfirm 上点 Stop 后发出。
  | { type: 'stopAsk'; sessionId: string }
  // [CUSTOM- 编辑器里**当前打开的文件**（含多行选区的行区间），喂给输入框的引用栏：
  // 那条 chip 上有个 `+`（还没引用）/`x`（已引用），点一下就把路径加进这条消息的引用。
  // **非会话作用域**（面板空着时也要显示），而且两个面都要（各自有自己的输入框）。
  | { type: 'activeFile'; file: { path: string; name: string; lineStart?: number; lineEnd?: number } | null }
  // [CUSTOM- 大纲钉住/宽度偏好，随 boot 一起带回（跨窗口重载存活）。
  // [CUSTOM- 外加 tab 栏的手工顺序（同一条记录）。
  // [CUSTOM- 外加 Times 的按会话记录 + 默认值（同一条记录）。
  | { type: 'uiPrefs'; outlineMode: 'popup' | 'sidebar'; outlineWidth: number; tabOrder?: string[]; timesBySession?: Record<string, boolean>; timesDefault?: boolean; tailBySession?: Record<string, boolean>; tailDefault?: boolean; outlineOpenBySession?: Record<string, boolean>; outlineOpenDefault?: boolean; autoExpandBySession?: Record<string, boolean>; autoExpandDefault?: boolean; autoExpandKinds?: string[]; autoExpandToolHeight?: number; autoExpandThoughtHeight?: number; flatTools?: boolean; composerMaxWidth?: number; inputMaxHeight?: number; sendKey?: 'enter' | 'ctrlEnter'; defaultModelByAgent?: Record<string, string>; defaultEffortByAgent?: Record<string, string>; recentDirectoryLimit?: number; markdownStyle?: 'editor' | 'github' | 'obsidian' | 'typora' | 'atom' | 'minimal' | 'things' }
  // [CUSTOM- 设置面板的数据（回复 getSettings，也在每次 setSetting 之后重发）。宿主是唯一写者。
  | { type: 'settings'; items: SettingItem[] }
  // [CUSTOM- 自定义模型变了（设置面板保存 / VS Code 设置里改）：输入卡的模型菜单要立刻换
  // 描述与别名，不能等下一次 meta/draftOptions —— 那正是「改完描述看起来没生效」的来源。
  | { type: 'customModels'; customModels: CustomModel[] }
  // 历史会话列表（回复 `listHistory`）。
  // `source` 说明这份列表从哪来：agent 侧 `session/list`，还是本地 workspaceState 缓存
  // （未连接时不去 spawn agent，见 ChatPanelHost.handleListHistory）。
  // [CUSTOM- `directories` 是过滤器的候选目录（宿主按列表算出来的，
  // **只含列表里真实出现过的目录 + 当前会话的目录**）。客户端据此渲染 header 的 chip，
  // 并在本地按 `dirKey` 过滤——列表本来就在客户端，换目录不该再问一次 agent。
  // 其中 `current: true` 的那条就是"开启过滤时的默认目录"，所以不需要另开一个字段。
  | { type: 'history'; agentName: string; sessions: HistorySessionSummary[]; source: 'agent' | 'local' | 'merged'; directories?: HistoryDirOption[]; error?: string }
  // 磁盘补充的增量应答（回复 `supplementHistory`）。
  // 客户端按 sessionId 合并进已有列表，不触发 setHistory 的全量替换（那会把 filterKey
  // 重置回 current 目录）。只回发起过滤的那个目录的磁盘会话。
  | { type: 'historySupplement'; agentName: string; cwd: string; sessions: HistorySessionSummary[] }
  // 归档/改名**做完**的回执（宿主是执行方）。
  // 客户端据此**就地**更新历史列表（改标题 / 摘掉行），不重发整份 history —— 那会把用户
  // 手选的目录过滤重置回默认（setHistory 用 askedCwd 重派生 filterKey）。广播：两个面
  // 都可能开着这份列表，谁开着谁更新（没开的 applyAction 会按 lastMessage 为空短路）。
  | { type: 'sessionAction'; action: 'rename' | 'archive' | 'delete'; sessionId: string; title?: string }
  // 草稿页与目录选择的应答。
  // 四条都**定向**发给发起请求的那个面（`post(msg, to)` 会绕开合帧队列），
  // 因为它们是"某个文档正在编辑的东西"，广播会让另一个面也长出同一个草稿。
  | { type: 'directoryChoices'; agentName: string | null; workspaceFolders: string[]; recent: string[]; defaultCwd: string }
  | { type: 'directoryPicked'; path: string | null; purpose?: 'cwd' | 'additionalDirectories' }
  // [CUSTOM- 'Files or folders' 文件选择器结果（多选文件）。
  | { type: 'filesPicked'; paths: string[] }
  // `draftId` 是**相关性 id，不能省**：`createSession` 会连带触发
  // `session-created → sessionsChanged → focus`，靠"收到一个新 focus 就删草稿"
  // 在慢路径/失败路径上会留下孤儿草稿或误删。
  | { type: 'draftResolved'; draftId: string; sessionId: string }
  | { type: 'draftFailed'; draftId: string; message: string }
  // 草稿页的输入卡要"显示完整"：模式/模型等配置项与
  // 斜杠命令在 ACP 里**都是会话级的**（`session/new` 只收 cwd/mcpServers，没有 mode/model
  // 入参），而草稿按定义还没有会话——所以回的是「该 agent 上一次会话的快照」（宿主缓存，
  // 见 ChatPanelHost.rememberAgentOptions）。快照只作候选与预选：创建会话时逐项按 id + 可选值
  // 校验后才下发，陈旧无害。
  // 定向发给发起请求的那个面（同 058 那四条——这是"某个文档正在编辑的草稿"）；
  // `draftId` 同样不能省：应答回来时用户可能已经换了草稿，客户端据它丢弃过期结果。
  | { type: 'draftOptions'; draftId: string; agentName: string | null; configOptions: SessionConfigOption[]; availableCommands: SessionMeta['availableCommands']; customModels: CustomModel[] }
  | { type: 'sessionClosed'; sessionId: string; reason: CloseReason }
  | { type: 'append'; sessionId: string; entries: WireEntry[] }
  | { type: 'revise'; sessionId: string; entryId: string; patch: EntryPatch }
  | { type: 'toolUpdate'; sessionId: string; entryId: string; tool: ToolCallView }
  | { type: 'meta'; sessionId: string; meta: SessionMeta }
  | { type: 'attachments'; sessionId: string; attachments: Attachment[] }
  // 一次连接尝试的相位（状态卡用）。
  // **必须无条件回话**，这不是锦上添花：`refreshSessions` 靠签名去重（1867 行的 `conn:` 位），
  // 而 `ensureConnected` 在进程已经起来时不发任何事件 ⇒「已连接 + 无会话 + 点 Connect」
  // 这条路上宿主一条消息都不会发，客户端的「连接中」会**永久卡死**（pitfall #29 的形态：
  // 效果上没变化 ≠ 可以不回话）。
  // 没有 'disconnected'：断开方向由 `agentConnected` 单独表达，不设第二条真相（pitfall #19）。
  /**
   * [CUSTOM- `detail` 只在 `connecting` 时出现：agent 进程的 stderr 里最近一行
   * （最典型的是 npx 的 "…will be installed: …"）。用户卡在连接界面时，那一行才说明**为什么**在等
   * —— 此前它只进日志，卡片上永远只有一句 "Connecting…"。
   */
  | { type: 'connection'; state: 'connecting' | 'connected' | 'failed'; message?: string; detail?: string }
  // 设置项 vac.autoConnectOnOpen 的当前值。
  // 走**广播**：两个面渲染的是同一个开关，不能各显示各的。
  // 带在 boot 里的是**首屏值**（客户端要靠 {agentConnected, focused, autoConnect} 三者
  // 同时成立才布防自动连接，拆成两条消息就会出现半状态窗口），
  // 这条消息则负责**运行期**的变更（另一个面改了 / 用户在 Settings 里改了）。
  | { type: 'autoConnectPref'; value: boolean }
  // [CUSTOM- 「重开面板要不要恢复上次的会话」的当前设置值（设置面板改了它也要跟上）。
  | { type: 'restorePref'; value: RestoreChoice }
  | { type: 'error'; sessionId?: string; message: string };

/** Snapshot variant carrying wire entries. */
export interface TranscriptSnapshotWire {
  sessionId: string;
  agentName: string;
  entries: WireEntry[];
}

/** webview → extension */
export type ChatToExt =
  | { type: 'ready' }
  // [CUSTOM- 大纲钉住/宽度偏好：非会话作用域，宿主存 globalState。
  // [CUSTOM- 字段**全部可选**：两个写者（大纲、tab 顺序）各发自己那几个，
  // 由宿主**合并**（重建会把对方那一半抹掉）。缺的字段 = 这一轮没改它。
  // [CUSTOM- Times 同样走这条（第三个写者）：timesBySession 整份发上来
  // （与 tabOrder 同一形态 —— 顺序与开关都是"一整张表"，逐条 delta 反而要宿主维护版本）。
  | { type: 'setUiPref'; outlineMode?: 'popup' | 'sidebar'; outlineWidth?: number; tabOrder?: string[]; timesBySession?: Record<string, boolean>; timesDefault?: boolean; tailBySession?: Record<string, boolean>; tailDefault?: boolean; outlineOpenBySession?: Record<string, boolean>; outlineOpenDefault?: boolean; autoExpandBySession?: Record<string, boolean>; autoExpandDefault?: boolean; autoExpandKinds?: string[]; autoExpandToolHeight?: number; autoExpandThoughtHeight?: number; flatTools?: boolean; composerMaxWidth?: number; inputMaxHeight?: number; sendKey?: 'enter' | 'ctrlEnter'; defaultModelByAgent?: Record<string, string>; defaultEffortByAgent?: Record<string, string>; recentDirectoryLimit?: number; markdownStyle?: 'editor' | 'github' | 'obsidian' | 'typora' | 'atom' | 'minimal' | 'things' }
  // [CUSTOM- 设置面板：宿主是唯一写者（配置项写 VS Code 设置，面板项写 UiPrefs）。
  | { type: 'getSettings' }
  | { type: 'setSetting'; key: string; value: unknown }
  | { type: 'settingAction'; action: string; key?: string; layer?: 'workspace' | 'user' | 'global' }
  // [CUSTOM- 状态卡上的自动连接开关。**非会话作用域**（正是没有会话时
  // 才需要它），所以必须放在 verifySession 守卫**之前**处理，与 setUiPref 同一位置。
  | { type: 'setAutoConnect'; value: boolean }
  // [CUSTOM- 会话恢复（重载/关闭后重开面板时问一句：要不要恢复上次那几个 tab）。
  // 三条都**非会话作用域** —— 快照里的会话此刻都还没活（那正是要恢复它们的意义），
  // 所以必须放在 verifySession 守卫**之前**（§5.4 规则二）。
  // 「开始恢复」：快照留着（下一次重载还要用），但**这一次**别再问了 —— 客户端已经在建本地 tab 了。
  | { type: 'startRestore' }
  | { type: 'dismissSessions' }
  | { type: 'forgetRestorable'; sessionId: string }
  | { type: 'setRestorePref'; value: RestoreChoice }
  | { type: 'sendPrompt'; sessionId: string; text: string }
  | { type: 'cancelTurn'; sessionId: string }
  | { type: 'newSession'; agentName: string }
  // /033 - 面板内的两个新入口。
  // 都**不是会话作用域**（可能根本没有聚焦会话——正是要用它们的时候），
  // 因此必须在 verifySession 守卫**之前**处理。
  | { type: 'connectAgent'; agentName?: string }
  // [CUSTOM- `cwd` = 客户端**地址栏当前显示**的目录（草稿的目录在客户端，
  // 宿主猜不到，058）。宿主用它标记 `directories` 里 `current: true` 的候选，客户端据此
  // 把过滤器的默认目录设成它。缺省时宿主仍按自己的规则猜（见 historyFilterCwd）。
  | { type: 'listHistory'; agentName?: string; cwd?: string }
  // 按过滤目录补扫磁盘转录目录。094 的磁盘补充只扫
  // workspaceFolders[0]，多根/跨目录场景下扫错目录。客户端过滤到具体目录时请求，宿主
  // 扫该目录并增量返回（非会话作用域，在 verifySession 守卫之前处理）。
  | { type: 'supplementHistory'; agentName?: string; cwd: string }
  // [CUSTOM- `title` rides along so the tab matches the list
  // immediately; `fromDraft` says the CLIENT was on a draft page (the host's
  // `focused` then names some other session, and it is the draft that must step
  // aside — a draft is client-local, 058).
  | { type: 'openHistorySession'; agentName: string; sessionId: string; cwd?: string; title?: string; fromDraft?: boolean; keepOthers?: boolean }
  // 草稿页与目录选择。
  // 三条都**不是**会话作用域：草稿按定义还没有 sessionId（那正是它存在的意义），
  // 所以它们必须和其他非会话作用域消息一样，在 `verifySession` 守卫**之前**处理（§5.4 规则二）。
  | { type: 'listDirectoryChoices'; agentName?: string }
  // [CUSTOM- 目录抽屉「Recently used」行右侧的删除：把这条目录从最近列表里移除（持久化）。
  // 非会话作用域（草稿页同样要能删），宿主处理完会重发一份 directoryChoices。
  | { type: 'removeRecentDirectory'; path: string }
  | { type: 'pickDirectory'; purpose?: 'cwd' | 'additionalDirectories' }
  // [CUSTOM- 'Files or folders'：打开文件选择器（多选文件）。
  | { type: 'pickFiles' }
  /**
   * [CUSTOM- 草稿页也可能带附件。
   *
   * 附件原本是**会话作用域**的（`attachPath`/`attachImage` 都带 sessionId，宿主按会话存），
   * 而草稿还没有会话 —— 于是"新建会话页粘一张图"在客户端就被拒了（`attachImage` 里那句
   * "no session is focused"），图片根本发不出去。做法是让**首条消息**把附件一起带上：
   * 客户端在草稿上先本地攒着（它展示 chip），发送时随这条消息交给宿主，宿主建完会话再按
   * 常规通道（`handleAttachImage` / `handleAttachPaths`）落账 —— 与已有会话走同一条路。
   */
  | {
    type: 'createDraftAndSend'; draftId: string; agentName?: string; cwd?: string; text: string;
    configSelections?: Array<{ configId: string; value: string }>;
    images?: Array<{ id: string; name: string; mimeType: string; dataUrl: string }>;
    paths?: string[];
    // [CUSTOM- 草稿页显式勾选的额外根目录（additionalDirectories，多根工作区）。
    additionalDirectories?: string[];
  }
  // 草稿页要"显示完整"：问宿主有没有该 agent 上一次会话
  // 的配置项/命令快照（草稿还没有 session，这些在 ACP 里只存在于会话上）。
  // 与 058 那三条同区：**不是**会话作用域（草稿按定义没有 sessionId），必须在
  // `verifySession` 守卫**之前**处理（§5.4 规则二）。
  | { type: 'listDraftOptions'; draftId: string; agentName?: string }
  // @remarks `agentName` 与 `createDraftAndSend` 的一样，是"可选的偏好"而不是必填：草稿是**纯
  // 客户端状态**，客户端其实不知道 agent。两条消息必须由宿主用**同一个** `panelAgent()` 解析
  // （草稿页出现在屏幕上时，宿主手上的聚焦会话往往是别的那个），否则会出现"显示 A 的模型、
  // 建的是 B 的会话"——而那种错配在应用阶段会被逐项校验静默丢掉。
  | { type: 'closeSession'; sessionId: string }
  // [CUSTOM- 取消**一个** sub-agent 子会话（`session/cancel` 打在子会话 id 上），父会话与兄弟
  // 子会话照常跑。会话作用域（守卫之后）：`sessionId` 是**父**会话，子会话 id 走 `subagentSessionId`。
  | { type: 'cancelSubagent'; sessionId: string; subagentSessionId: string }
  // 历史列表 / 会话 tab 的**改名**。**要在守卫之前处理**：
  // 历史列表里的行大多不是活会话（verifySession 只认 live 的）——会话 tab 那条是活的，但走同
  // 一条路更省心（见 ChatPanelHost 的分支注释）。`currentTitle` 只是给输入框的初值（客户端
  // 行/标签上有它就带上）。归档（历史行的另一个动作）见下行 `archiveSession`。
  | { type: 'archiveSession'; sessionId: string }
  // [CUSTOM- 真删除一条会话（历史列表行的悬停 Delete / 右键 Delete）：取消/关闭活会话 →
  // agent 侧 `session/delete` → 清本地缓存。历史行大多**不是**活会话（verifySession 只认 live 的），
  // 所以与 archiveSession 同区：**必须在 `verifySession` 守卫之前处理**。
  // `agentName` 来自行上的 `data-open-agent`（列表可能横跨多个 agent）。
  | { type: 'deleteSession'; sessionId: string; agentName?: string }
  // [CUSTOM- 2026-10-29：`title` 由客户端浮层输入框带上（面板内改名，不再弹宿主 InputBox）。
  // 缺省时宿主保留原生输入框兜底（其它调用方 / 旧客户端）。
  | { type: 'renameSession'; sessionId: string; currentTitle?: string; title?: string }
  | { type: 'focusSession'; sessionId: string }
  // [CUSTOM- 2026-10-29：会话 tab 右键 "Mark as unread" —— 与后台输出同一条 attention
  // 状态（浅绿点）；聚焦到该会话时由宿主清掉。会话作用域（守卫之后）。
  | { type: 'markUnread'; sessionId: string }
  // [CUSTOM- 从某条助手消息处 fork 出新会话（`session/fork` + 适配器的消息级 `_meta`）。
  // **会话作用域**（走 `verifySession` 守卫之后）。`entryId` 是面板记录 id —— 宿主据它取回
  // 那一条的 ACP `messageId`，所以记录序列化不必带 messageId。
  | { type: 'forkFromMessage'; sessionId: string; entryId: string }
  // [CUSTOM- 会话 tab 右键：在**这个会话的目录**里再开一个新会话。
  // 会话作用域（守卫之后）——目录/额外根目录都取源会话的，客户端不必知道。
  | { type: 'newSessionInDirectory'; sessionId: string }
  // [CUSTOM- 会话 tab 右键：复制会话（`session/fork` 不带 messageId = 在末尾分叉），
  // 新会话继承源会话的上下文与消息记录，然后自动聚焦。
  | { type: 'duplicateSession'; sessionId: string }
  | { type: 'focusAgent'; agentName: string }
  // [CUSTOM- 带上行区间 = 只摘那一段（同一个文件可以引用多段）；不带 = 整个路径全摘。
  | { type: 'detachFile'; sessionId: string; path: string; lineStart?: number; lineEnd?: number }
  // [CUSTOM- Files dropped onto / pasted into the panel. Session
  // scoped, so it MUST be handled after the `verifySession` guard (§5.4 rule 1).
  // [CUSTOM- `meta` 与 `paths` **按下标平行**：只有"从编辑器当前文件加进来的"那一条
  // 需要它（显示名带行区间）。拖拽/粘贴那条路照旧只发 paths（缺 = 用 basename）。
  | { type: 'attachPath'; sessionId: string; paths: string[]; meta?: Array<{ name?: string; lineStart?: number; lineEnd?: number }> }
  // 输入框图片：粘贴/拖入的位图无路径，只能把
  // base64 带上。会话作用域（verifySession 守卫之后，同 attachPath）。`id` 由客户端
  // 生成（合成附件 id），宿主用它作附件 `path` 并把字节存进 imageData。
  | { type: 'attachImage'; sessionId: string; id: string; name: string; mimeType: string; dataUrl: string }
  | { type: 'setMode'; sessionId: string; modeId: string }
  | { type: 'setModel'; sessionId: string; modelId: string }
  | { type: 'setConfigOption'; sessionId: string; configId: string; value: string }
  | { type: 'renderMarkdown'; items: Array<{ entryId: string; sessionId: string; text: string; key?: string }> }
  | { type: 'openLink'; href: string }
  // [CUSTOM- 2026-10-29：引用标签的跳转。`endLine` 有值时宿主框选整段行区间；
  // `sessionId` 可选 —— 草稿页还没有会话，点引用标签也要能打开文件（相对路径回退工作区）。
  | { type: 'openFile'; sessionId?: string; path: string; line?: number; endLine?: number }
  | { type: 'openTerminal'; sessionId: string; terminalId: string }
  | { type: 'copy'; text: string }
  // webview 控制台 → 扩展侧输出通道的日志桥。
  // **非会话作用域**（不带 sessionId），所以必须在 verifySession 守卫**之前**处理。
  // 存在理由：webview 的 console 只有打开 Webview DevTools 才看得到，而"界面为什么不对"
  // 的排查每次都卡在这上面（027 的空壳工具卡就是这样，线索只存在于没人看的 console 里）。
  | { type: 'clientLog'; level: 'info' | 'warn' | 'error'; message: string }
  // 面板内权限卡的回答。会话作用域：
  // 必须走 verifySession 守卫（在它**之后**处理），否则会被静默丢弃。
  // `optionId` 缺省表示取消/关闭。
  | { type: 'permissionAnswer'; sessionId: string; promptId: string; optionId?: string }
// [CUSTOM- 表单（elicitation）的回答。同样是**会话作用域**，必须放在 verifySession
// 守卫之后处理（放前面会被静默丢弃，那是 permission 踩过的坑）。
// `accept` 带收集到的字段值；`decline` = 用户跳过（轮次继续）；`cancel` = 放弃（工具调用中止）。
// 字段值的类型与 ACP 的 `ElicitationContentValue` 一致。
| {
    type: 'elicitationAnswer';
    sessionId: string;
    promptId: string;
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, string | number | boolean | string[]>;
  }
  // 客户端报告「这张工具卡没有 view model」，
  // 扩展侧收到后重发一次视图模型。会话作用域（走 verifySession 守卫之后）。
  // 存在的意义：卡片第一次落地时若没带上视图模型，会渲染成一个空壳，而 `updateTool`
  // 只能打补丁、修不了空壳——用户看到的就是"工具调用没有显示"。与其猜数据在哪一侧丢，
  // 不如让客户端主动要一次。
  | { type: 'needToolView'; sessionId: string; entryId: string; toolCallId: string }
  | { type: 'executeCommand'; command: string };

/** extension → webview reply to `renderMarkdown`. */
export interface MarkdownRendered {
  type: 'markdownRendered';
  items: Array<{ entryId: string; sessionId: string; html: string; key?: string }>;
}

/** Anything the extension may post to the webview. */
export type ExtToChatMessage = ExtToChat | MarkdownRendered;

export type { TranscriptEntry, TranscriptSnapshot };
