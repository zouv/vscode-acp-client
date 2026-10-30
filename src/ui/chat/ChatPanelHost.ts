// 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 新面板的扩展侧实现：把 SessionManager / SessionUpdateHandler 的事件翻译成会话记录，
// 再通过 postMessage 推给 webview。
//
// 设计要点：
// · transcript 存在扩展宿主（TranscriptStore），因此切标签、切面板、重新 attach 都不丢内容——
// 不需要重新 session/load。
// · 记录在 panel 未 attach 时也照常累积（后台会话继续跑），只是 postMessage 被守卫丢弃。
// · 所有发出的消息都带 sessionId；所有收到的消息都先校验 sessionId 与 SessionManager 匹配，
// 不匹配一律丢弃并记日志，绝不静默落到「当前聚焦会话」上。
// · 两个 surface（侧边栏视图 / 编辑区面板）共享本实例：`post()` 广播、`boot` 只回给发起者
// （，见 ChatSurface.ts）。
import * as vscode from 'vscode';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { ContentBlock, SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';

import type { SessionManager, SessionInfo } from '../../core/SessionManager';
import type { SessionUpdateHandler, SessionUpdateListener } from '../../handlers/SessionUpdateHandler';
import { log, logFilePath } from '../../utils/Logger';
import { buildStamp, readPackageVersion } from '../../utils/BuildInfo';
import { renderChatHtml, createNonce } from './html';
import { SafeMarkdown } from './markdown';
// [CUSTOM- 回放里文件引用是一段文本（`[@名](file:///…)`），得先认出来。
import { fileMentionViews } from './markdown';
import { Outbox } from './Outbox';
import type {
  Attachment,
  ChatToExt,
  CloseReason,
  ExtToChat,
  ExtToChatMessage,
  MarkdownRendered,
  RecoverableSession,
  RestoreChoice,
  SessionMeta,
  SessionSummary,
  SettingItem,
  SettingOption,
  TranscriptSnapshotWire,
  UiPrefs,
} from './protocol';
// [CUSTOM- 自定义模型读取迁到 config 层（SessionManager 也要读同一份）。
import { normalizeCustomModels, type CustomModel } from '../../config/CustomModels';
// [CUSTOM- 设置项的作用域：工作区 > 用户 > 跨 IDE 全局文件 > 内置默认。
import { GLOBAL_SETTING_KEYS } from '../../config/GlobalSettings';
import {
  CONFIG_SETTING_KEYS, vscodeSettingIO, type SettingIO,
} from '../../config/SettingScope';
// [CUSTOM- 回放结束时的 markdown 预渲染（见 prefillReplayMarkdown）。
import type { TranscriptEntry } from './transcript/types';
import type { IChatPanel, PanelContext } from './panelContract';
import { primaryAgentName, getAgentNames, getAgentConfig, getAgentKind } from '../../config/AgentConfig';
import { profileFor } from '../../agents/AgentProfile';
import { viewSurface, type ChatSurface, type SurfaceKey } from './ChatSurface';
// [CUSTOM- 会话状态通知（等待权限 / 等待表单 / 轮次完成）。宿主只认这个类型，
// 测试塞假 channel；真实的 vscode 通知调用在下面（vscodeNoticeChannel —— 本文件不 import 它
// 到 SessionNotifier 里去，那边必须保持不依赖 vscode）。
import { SessionNotifier } from './SessionNotifier';
import type { NoticeChannel } from './SessionNotifier';
import type { PermissionPresenter, PermissionState } from '../../handlers/PermissionBridge';
// [CUSTOM- 表单（elicitation）presenter —— 与权限卡同构。
import type {
  ElicitationPresenter,
  ElicitationState,
  ElicitationAction,
  ElicitationContent,
} from '../../handlers/ElicitationBridge';
import { PermissionBridge } from '../../handlers/PermissionBridge';
import { ElicitationBridge } from '../../handlers/ElicitationBridge';
import { TranscriptStore } from './transcript/TranscriptStore';
import { ToolInvocationStore } from './transcript/ToolInvocationStore';
import { toToolCallView } from './content/toolCalls';
import { toContentView, hasVisibleContent } from './content/contentBlocks';
import type { ContentBlockView } from './content/contentBlocks';
import type { SubagentEntry } from './transcript/types';
import { resolveNestingStrategy } from './nesting/NestingStrategy';
import {
  choiceChanges,
  choiceSnapshotFromState,
  choiceSnapshotPatched,
  selectValues,
  type ChoiceSnapshot,
} from './sessionChoices';
// [CUSTOM- The history picker's directory filter: `directoryKey` /
// `directoryOptions` are pure and unit-tested; `folderName` replaces the local
// `basename` (same "last path segment" idea the client's folderName implements, and
// two copies of it here is exactly how they drift — pitfalls #19).
import { directoryKey, directoryOptions, folderName as basename, recentDirectoryList } from './historyDirs';
import { claudeTranscriptDir, readDiskSessions, readTranscriptTimes, readTranscriptUserAttachments } from './diskSessions';
import type { TranscriptUserParts } from './diskSessions';
import type { HistorySessionSummary } from './protocol';

/** Prefix of the output channel used for panel-level diagnostics. */
const LOG_PREFIX = 'chat-panel';

/**
 * [CUSTOM- Message types that must NEVER be delayed or merged.
 *
 * INV-C: `sessionsChanged` drives the Send/Stop button — a late one leaves a
 * stale `Send` after the turn already started.
 * INV-D: `sessionClosed` must remove its tab immediately.
 * `boot`/`focus` are full snapshots and are always preceded by a flush, so they
 * can never arrive before an append they already contain (INV-E).
 */
const STRUCTURAL_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'boot', 'focus', 'sessionsChanged', 'sessionClosed', 'meta', 'attachments', 'error',
  // [CUSTOM- 连接相位必须立即发：它会被 `focus`（连接成功且有会话时紧随其后）
  // 语义性覆盖，排进合帧队列就可能反过来、让客户端多开一张草稿。
  'connection',
  // [CUSTOM- 自定义模型是整表状态（不是流式增量），且输入卡菜单要立刻换描述；
  // 排进合帧队列只会让"保存后看起来没生效"多一个 16ms 的窗口。
  'customModels',
]);

/** [CUSTOM- globalState key for the outline pin/width prefs. */
const UI_PREFS_KEY = 'vac.outlinePrefs.v1';

// 草稿页的配置项/命令快照，按 agent 存。
// 为什么要持久化：VS Code 重载后宿主内存里的活动会话**全没了**，而"全新窗口点 + 时输入卡
// 还是只有输入框"正是用户报的那个现象——只存内存等于默认路径上不生效。
const DRAFT_OPTIONS_KEY = 'vac.draftOptions.v1';

/** One agent's last-seen composer options (see ChatPanelHost.rememberAgentOptions). */
interface AgentOptionSnapshot {
  configOptions: SessionConfigOption[];
  availableCommands: SessionMeta['availableCommands'];
}

/** The persisted shape: agent name → snapshot. */
type DraftOptionsStore = Record<string, AgentOptionSnapshot>;

// 记住用户手动选过的模式，新建会话时套用。
//
// 为什么要**按 agent** 分开：模式是各 agent 自己的词表（Claude Code 的
// `bypassPermissions` 对别的 agent 毫无意义），按会话记则等于没记（新建会话正是要跨会话）。
//
// 为什么存在 globalState 而不是内存：重载窗口后内存里什么都不剩，而"新开会话又回到默认模式"
// 正是这个功能要消灭的现象（与 `vac.draftOptions.v1` 同一条理由）。
const LAST_MODE_KEY = 'vac.lastMode.v1';

/** One agent's remembered mode: the config option id and the value the user picked. */
interface RememberedMode {
  configId: string;
  value: string;
}

/** The persisted shape: agent name → remembered mode. */
type LastModeStore = Record<string, RememberedMode>;

/**
 * [CUSTOM- The setting behind the start card's auto-connect switch.
 * Declared in package.json, rendered as a checkbox by the panel — so a change made
 * in either place has to reach the other (see the configuration listener below).
 */
const AUTO_CONNECT_KEY = 'vac.autoConnectOnOpen';
// [CUSTOM- 「上次打开过的会话」快照（globalState）：重载/关闭重开后问一句要不要恢复它们。
const OPEN_SESSIONS_KEY = 'vac.openSessions.v1';
const RESTORE_KEY = 'vac.restoreSessionsOnOpen';
/** [CUSTOM- 快照写入的防抖：它挂在 created/closed/focus 三个事件上。 */
const SNAPSHOT_DEBOUNCE_MS = 300;

// 历史列表的本地覆盖（改名 / 归档）。
// 一份按 sessionId 记的账（globalState）：**任何来源**的行都能被改 —— agent 列的 / 本地
// 缓存的 / 转录目录补出来的。不写进 SessionHistoryStore 有两个理由：它只覆盖本地那一段
// （agent / disk 行不在里面），而且它的 memento key 是冻结的（architecture §4 铁律 2）。
// 归档 = 历史列表里不再出现；改名 = 列表 / tab / 树上的标题换成这个名字（覆盖优先于
// agent 的 session_info_update）。
const SESSION_LABELS_KEY = 'vac.sessionLabels.v1';
interface SessionLabelOverride {
  title?: string;
  archived?: boolean;
}

export class ChatPanelHost implements IChatPanel, PermissionPresenter, ElicitationPresenter {

  // 单视图 → 多 surface（侧边栏 + 编辑区）。
  // 状态仍然只有这一份，两个面读同一个 store；`post()` 默认广播，两边自动同源。
  // `lastActive` 只用于「把某个面提到前面」（附件 chip），不参与路由决策。
  private readonly surfaces = new Map<SurfaceKey, ChatSurface>();
  private lastActive: SurfaceKey | null = null;
  /** Which session each surface is showing. The two surfaces focus independently. */
  private readonly surfaceFocused = new Map<SurfaceKey, string | null>();
  /**
   * [CUSTOM- 正在连接中（postConnection('connecting') 之后、'connected'/'failed' 之前）。
   * 只用来决定"agent 的 stderr 要不要往卡片上送" —— 连接好了以后的 stderr 是噪声。
   */
  private connecting = false;

  private readonly transcripts = new TranscriptStore();
  private readonly tools = new ToolInvocationStore();
  private readonly markdown = new SafeMarkdown();

  /** sessionId → pending attachments (resource_link blocks for the next prompt). */
  private readonly attachments: Map<string, Attachment[]> = new Map();
  // [CUSTOM- sessionId → attachmentId → image 字节（base64 + mimeType）。
  // 字节只留宿主内存、不进 meta（否则每次 boot/focus 都重发整张图）；发送时据此拼
  // ACP `image` ContentBlock。
  private readonly imageData: Map<string, Map<string, { data: string; mimeType: string }>> = new Map();
  /**
   * [CUSTOM- sessionId → 上下文占用，渲染成输入卡右下角那颗圆环。
   *
   * **只有一个写入者：`usage_update`**（`used` = 当前上下文 token 数，`size` = 窗口大小）。
   * 曾经还有一个 `applyResponseUsage` 把 `PromptResponse.usage.totalTokens` 折进 `used` ——
   * 那是**单位张冠李戴**：协议里 `Usage.totalTokens` 是 *Sum of all token types across session*
   * （claude-agent-acp 实现为每轮 `+= input/output/cache_read/cache_write`，cache read 每轮都重算），
   * 是个只增不减的累计量，而 `size` 是窗口大小 ⇒ 长会话必然出现 `1841k / 1000k`。
   * 它当初的理由是"没发 usage_update 的 agent 也能有读数"，但那**不成立**：没有 usage_update
   * 就没有 `size`，`renderContext` 在 `!size` 时直接隐藏 —— 那个分支唯一能做到的事就是把
   * 已经正确的读数改坏。要再引入"会话累计 token"，请**另开字段**，别复用 `used`。
   */
  private readonly usage: Map<string, SessionMeta['usage']> = new Map();
  /** `${sessionId}::${toolCallId}` → transcript entry id. */
  private readonly toolEntryIds: Map<string, string> = new Map();
  /**
   * [CUSTOM- sub-agent 子会话 id → 它的父会话 id（ACP draft `subagent_update`）。
   *
   * 声明 `clientCapabilities.subagents` 后，适配器把子会话自己的流量**改路由到子 sessionId**。
   * 子会话不是注册过的会话，所以这里把它**别名回父会话**再走渲染原路 —— 现有行为（含已有的
   * 子 agent 分组）因此原样生效，卡片只承担身份、状态与取消。
   */
  private readonly subagentParents: Map<string, string> = new Map();
  /** sessionId → entry id of the single plan card (ACP replaces the list). */
  private readonly planEntryIds: Map<string, string> = new Map();
  // [CUSTOM- Sessions that produced output while they were NOT the
  // focused one. Surfaced as the tab-strip "attention" dot, which is a HINT and
  // never a notification: no dialog, no focus stealing.
  private readonly unread: Set<string> = new Set();
  // [CUSTOM- sessionId → last known switchable state (mode + config
  // options), for the "Switched to <model>" notice. The cache is written ONLY here
  // (never read back from SessionManager at diff time), because the two paths that
  // report a change — our own setter and the agent's `*_update` notification — race
  // against SessionManager's listener order. Whatever lands first announces, and
  // the other one diffs to nothing: that is the de-duplication, by construction.
  private readonly choices: Map<string, ChoiceSnapshot> = new Map();
  // [CUSTOM- sessionId → last known title, for the rename notice.
  // Same "the cache is ours" rule as `choices`: SessionManager may already have
  // applied the new title by the time our listener runs, so its copy cannot tell us
  // what the OLD one was.
  private readonly sessionTitles: Map<string, string> = new Map();
  // [CUSTOM- sessionId → (replay messageId → real epoch ms), read from the
  // agent's transcript BEFORE a replay starts. ACP carries no per-message time, so
  // without this every record of a reopened conversation is stamped `Date.now()` and
  // the outline shows one identical second for a conversation spanning an hour.
  private readonly replayTimes: Map<string, Map<string, number>> = new Map();
  // [CUSTOM- sessionId → (messageId → 图片视图)。replay 把图片并回用户气泡
  // （100 的教训：文本与非文本块分成两条 chunk 到达，气泡里没有可合并的东西）。
  // [CUSTOM- 文件引用一并收在这里（它们连到同一批块），外加"这条消息有没有正文"
  // ——附件 chunk 该丢还是该自己渲染，判据是它（见 diskSessions.TranscriptUserParts）。
  private readonly replayUserParts: Map<string, Map<string, TranscriptUserParts>> = new Map();
  /**
   * [CUSTOM- IDE 上下文块（`<ide_opened_file>`）按「会话::messageId」暂存，
   * 等**同一条消息**的正文 chunk 到了再挂到那个气泡上（回放里两条 chunk 同 messageId，
   * 而代码顺序不保证 —— 用 messageId 配对就不必赌顺序）。见 user_message_chunk 分支。
   */
  private readonly ideFilesByMessage: Map<string, ContentBlockView> = new Map();
  /** [CUSTOM- 上一次推给客户端的"编辑器当前文件"签名（选区每次移动都会回调）。 */
  private activeFileSignature: string | null = null;
  // [CUSTOM- 会话恢复：上次退出时开着的会话（globalState 里的快照）+ 本次是否已经答复过。
  private openSessions: OpenSessionsSnapshot | null = null;
  private restoreDismissed = false;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** 本生命周期里出现过会话吗 —— 只有出现过，才允许把快照写成空表（启动时的空态会把它抹掉）。 */
  private sawLiveSession = false;

  private focused: PanelContext = { agentName: null, sessionId: null };
  // [CUSTOM- 会话状态通知（等待权限 / 等待表单 / 轮次完成）。默认实现打到
  // vscode 通知；测试注入假的。分配放在 ctor 体内而不是参数属性：默认值要用 `this`
  // （点击回调 = revealSession）。
  private readonly notifier: SessionNotifier;
  /** [CUSTOM- 每会话的轮次序号，只用来给 turn-done 通知一个稳定去重键。 */
  private readonly turnSeq: Map<string, number> = new Map();
  /** [CUSTOM- Outline pin/width prefs, cached from globalState. */
  private uiPrefs: UiPrefs | null = null;
  // [CUSTOM- agent → 它最后一次会话的配置项/命令快照（草稿页拿它渲染输入卡）。
  // 只由 rememberAgentOptions 写；**不是**可写状态——用户真正生效的那份永远在 SessionManager。
  private readonly draftOptions: Map<string, AgentOptionSnapshot> = new Map();

  // [CUSTOM- agent → 用户最后一次**手动**选的模式（新建会话时套用）。
  // 只由 rememberUserMode 写（三个用户动作的落点），从不读 agent 自己的切换。
  private readonly lastMode: Map<string, RememberedMode> = new Map();
  // [CUSTOM- `session-created('new')` 启动的那次应用，按会话挂着：
  // 草稿页在自己的显式选择之前要先 `await` 它落地，否则两个 setConfigOption 谁后到谁赢
  // （用户刚选的模式可能被"默认模式"盖回去）。
  private readonly modeApply: Map<string, Promise<void>> = new Map();
  // [CUSTOM- 每个 agent 的默认模型（设置面板）也只在**新建**会话时套用；
  // 与 modeApply 同一形态：草稿页的显式选择要排在它之后。
  private readonly modelApply: Map<string, Promise<void>> = new Map();
  // [CUSTOM- 每个 agent 的默认推理强度（设置面板）：与 modelApply 同一形态，
  // 但它排在默认模型之后（模型切换可能级联出新的 effort 候选）。
  private readonly effortApply: Map<string, Promise<void>> = new Map();

  // [CUSTOM- 轮次之外还在干活的后台子任务（见 noteBackgroundTask）。
  // 存在的理由：`running` 原本只看"轮次请求还没返回"，而 Claude Code 的后台子任务（Task 工具
  // 带 run_in_background）**在轮次结束后继续干活**——它一停，面板就把发送按钮变回普通状态，
  // 用户看到的就是"活还在跑，按钮却复原了"。
  private readonly backgroundTasks: Map<string, NodeJS.Timeout> = new Map();

  // [CUSTOM- 会话"安静下来"之后补渲染 markdown 的计时器（见 armSettlePrefill）。
  // 每个会话一个：客户端那条"请求 → 回填"往返会静默断掉，这条是宿主侧的兜底。
  private readonly settleTimers: Map<string, NodeJS.Timeout> = new Map();

  // [CUSTOM- 会话标题在"第二次发言"时冻结（见 trackTitle）。
  // 为什么不是"最新那个"：adapter 每轮结束去拉 SDK 标题（`maybeUpdateSessionTitle`），而 SDK
  // 的后台生成可能几轮之后才落盘 ⇒ 那些标题描述的是"聊了几轮之后的主题"，不是这次会话的名字。
  private readonly titleFrozen = new Set<string>();
  /** 已经跑完过至少一轮的会话 —— 冻结的判据（第二次发言时它一定在里面）。 */
  private readonly turnsDone = new Set<string>();

  // 合帧队列 + 标签栏快照签名（见 refreshSessions）。
  private readonly outbox: Outbox;
  private lastSessionsSignature: string | null = null;

  private readonly updateListener: SessionUpdateListener;
  private readonly subscriptions: vscode.Disposable[] = [];
  // Held so dispose() can UNREGISTER the listener; the session update handler
  // sweeps up whatever is left when it is disposed.
  private readonly sessionUpdateHandler: SessionUpdateHandler;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    sessionUpdateHandler: SessionUpdateHandler,
    private readonly permissionBridge?: PermissionBridge,
    // [CUSTOM- globalState for UI prefs that survive webview disposal.
    private readonly globalState?: vscode.Memento,
    // [CUSTOM- 表单桥（晚绑定失败时的兜底同权限桥）。
    private readonly elicitationBridge?: ElicitationBridge,
    // [CUSTOM- settings 读写缝。注入而不是直接调 vscode.workspace：
    // 测试 harness 刻意不碰真实用户设置（见 chat-panel.test.ts 的 FakeMemento 注释），
    // 而写 ConfigurationTarget.Global 会改掉开发者的 settings.json。
    private readonly prefs: PanelPrefsIO = vscodePanelPrefs(),
    // [CUSTOM- 通知渠道（默认 = vscode 通知）。注入缝的理由与 prefs 相同：
    // 测试不该真的弹系统通知（会被测试宿主吞掉且无法断言）。注入的是 channel 而不是
    // SessionNotifier——这样"点击通知 → 聚焦会话"这条真路径（revealSession）也在被测范围里。
    private readonly noticeChannel: NoticeChannel = vscodeNoticeChannel(),
    // [CUSTOM- 后台子任务"多久没动静就不再等"（见 noteBackgroundTask）。
    // 测试会把它调到毫秒级；默认两分钟——比实测看到的最长静默间隔（57s）宽裕一倍。
    private readonly backgroundQuietMs: number = 120_000,
    // [CUSTOM- 设置面板的配置读写缝（与 prefs 同理：测试不能碰开发者的 settings.json /
    // ~/.vac/config.json）。默认走真实 VS Code 配置与跨 IDE 全局文件。
    private readonly settingsIO: SettingIO = vscodeSettingIO(),
  ) {
    this.notifier = new SessionNotifier(this.noticeChannel,
      // 显式用户动作（点了通知）：可以抢焦点、把面板抬到前台。
      notice => this.revealSession(notice.sessionId, notice.label),
    );
    this.sessionUpdateHandler = sessionUpdateHandler;
    this.uiPrefs = this.globalState?.get<UiPrefs>(UI_PREFS_KEY) ?? null;
    // [CUSTOM- 上一次退出时开着的会话（可能是上一次进程留下的 —— 本次还没人写它）。
    this.openSessions = this.globalState?.get<OpenSessionsSnapshot>(OPEN_SESSIONS_KEY) ?? null;
    // [CUSTOM- 草稿页的配置项/命令快照（重载窗口后仍可用）。
    const storedOptions = this.globalState?.get<DraftOptionsStore>(DRAFT_OPTIONS_KEY) ?? {};
    for (const agentName of Object.keys(storedOptions)) {
      const snapshot = storedOptions[agentName];
      if (!snapshot) { continue; }
      this.draftOptions.set(agentName, {
        configOptions: snapshot.configOptions ?? [],
        availableCommands: snapshot.availableCommands ?? [],
      });
    }
    // [CUSTOM- 记住的模式（重载窗口后仍然生效）。
    const storedModes = this.globalState?.get<LastModeStore>(LAST_MODE_KEY) ?? {};
    for (const agentName of Object.keys(storedModes)) {
      const entry = storedModes[agentName];
      if (entry && typeof entry.configId === 'string' && typeof entry.value === 'string') {
        this.lastMode.set(agentName, { configId: entry.configId, value: entry.value });
      }
    }
    // The host IS the permission presenter for the modern panel: no other
    // object knows whether a surface is on screen and which session is focused.
    this.permissionBridge?.setPresenter(this);
    this.elicitationBridge?.setPresenter(this);
    // [CUSTOM-20261029] Sub-agent traffic arrives under the child's own session id,
    // which is not a registered session. Resolve it to the parent so a permission/form
    // request is drawn in the parent's transcript instead of falling through to the
    // window-level QuickPick (the user's screenshot). Unknown ids stay as-is.
    const resolvePanelSession = (sessionId: string) => this.subagentParents.get(sessionId) ?? sessionId;
    this.permissionBridge?.setSessionResolver(resolvePanelSession);
    this.elicitationBridge?.setSessionResolver(resolvePanelSession);
    // [CUSTOM- One frame of coalescing for order-coupled messages.
    this.outbox = new Outbox({
      send: message => this.postNow(message),
      log: message => log(`${LOG_PREFIX}: ${message}`),
    });
    this.updateListener = (update: SessionNotification) => this.onSessionUpdate(update);
    this.sessionUpdateHandler.addListener(this.updateListener);

    const refresh = () => this.refreshSessions();
    const on = (event: string, handler: (...args: any[]) => void) => {
      this.sessionManager.on(event, handler);
      this.subscriptions.push({ dispose: () => this.sessionManager.off(event, handler) });
    };

    // [CUSTOM- agent 的 stderr → 连接卡片（只在连接中显示，见 noteAgentStderr）。
    on('agent-stderr', (evt: { line?: string }) => this.noteAgentStderr(evt?.line ?? ''));

    on('session-created', (sessionId: string, _agentName: string, origin?: string) => {
      // [CUSTOM- 会话一建好就把它的配置项/命令收进草稿页快照——下一次点「+」用的
      // 就是这一份。
      this.rememberAgentOptions(sessionId);
      // [CUSTOM- 快照跟着"开着哪些会话"变（重载后要按它恢复）。
      this.sawLiveSession = true;
      this.saveOpenSessions();
      refresh();
      // [CUSTOM- 只有**新建**的会话套用记住的模式。打开历史（load）/恢复（resume）
      // 走的是同一个事件：那个会话有自己的模式，那是"重新打开它"的一部分，覆盖掉就是改坏它。
      // `undefined`（更老的调用方、测试直接 emit）按"不是新建"处理——宁可不动，也别在该不动时动。
      if (origin === 'new') {
        const applied = this.applyRememberedMode(sessionId);
        this.modeApply.set(sessionId, applied);
        // [CUSTOM- 默认模型（设置面板）同样只套用到新建会话；草稿页的选择排在它后面。
        const model = this.applyRememberedModel(sessionId);
        this.modelApply.set(sessionId, model);
        // [CUSTOM- 默认推理强度排在默认模型之后：模型切换可能级联出新的 effort 候选，
        // 先让模型落定、再套用一个仍然有效的值。草稿页的显式选择同样排在它们之后。
        this.effortApply.set(sessionId, model.then(() => this.applyRememberedEffort(sessionId)));
      }
    });
    on('session-closed', (sessionId: string, _agentName: string, reason: CloseReason) => {
      // Release everything keyed by this session, then tell the client so a
      // closed tab disappears immediately rather than waiting for the focus
      // change that follows.
      this.saveOpenSessions();
      const settle = this.settleTimers.get(sessionId);
      if (settle) { clearTimeout(settle); this.settleTimers.delete(sessionId); }
      this.transcripts.drop(sessionId);
      this.tools.drop(sessionId);
      this.attachments.delete(sessionId);
      this.imageData.delete(sessionId);
      this.replayTimes.delete(sessionId);
      this.replayUserParts.delete(sessionId);
      for (const key of Array.from(this.ideFilesByMessage.keys())) {
        if (key.startsWith(`${sessionId}::`)) { this.ideFilesByMessage.delete(key); }
      }
      this.usage.delete(sessionId);
      this.planEntryIds.delete(sessionId);
      // [CUSTOM- Session ids are never reused, so a stale switch
      // baseline could only ever suppress the first notice of a new session.
      this.choices.delete(sessionId);
      this.sessionTitles.delete(sessionId);
      // [CUSTOM-20261029] The child→parent aliases only exist to route sub-agent
      // prompts; a closed parent can never render them again.
      for (const [child, parent] of Array.from(this.subagentParents.entries())) {
        if (parent === sessionId) { this.subagentParents.delete(child); }
      }
      // [CUSTOM- Its notification keys can never fire again.
      this.notifier.forget(sessionId);
      this.turnSeq.delete(sessionId);
      // [CUSTOM- …and a mode application that never got awaited.
      this.modeApply.delete(sessionId);
      this.modelApply.delete(sessionId);
      this.effortApply.delete(sessionId);
      // [CUSTOM- …and any wait on a background task of this session.
      this.endBackgroundTask(sessionId, 'closed');
      // [CUSTOM- Session ids are never reused: drop the title bookkeeping too.
      this.titleFrozen.delete(sessionId);
      this.turnsDone.delete(sessionId);
      for (const key of Array.from(this.toolEntryIds.keys())) {
        if (key.startsWith(`${sessionId}::`)) { this.toolEntryIds.delete(key); }
      }
      this.post({ type: 'sessionClosed', sessionId, reason });
      refresh();
    });
    on('agent-connected', refresh);
    on('agent-disconnected', refresh);
    on('session-info-changed', refresh);
    on('session-load-start', (sessionId: string, agentName: string) => {
      // [CUSTOM- 回放开始：本会话 append 的记录改成 0 起的相对时刻（拿不到转录
      // 真实时刻时不再用 Date.now() 冒充墙钟），命中真实时刻的由 stampReplayTime 覆盖。
      this.transcripts.beginReplay(sessionId, agentName);
      refresh();
    });
    on('session-load-end', (sessionId: string) => {
      // [CUSTOM- 回放结束：之后的记录回到墙钟。
      this.transcripts.endReplay(sessionId);
      // [CUSTOM- A replay is a FINITE recorded stream, so once it
      // ends nothing can still be streaming — but nothing else closes the
      // entries it created: `finalizeTurn` only runs for a prompt WE sent, and a
      // `session/load` is not one. Left open, the trailing assistant entry keeps
      // the client in its streaming state forever and pins `aria-busy` to true,
      // which silently mutes the screen reader. (Found by
      // src/test/chat-panel.test.ts against a real captured replay.)
      this.finalizeEntries(sessionId);
      // [CUSTOM- 回放结束 ⇒ 宿主自己把 markdown 补齐（见 prefillReplayMarkdown）。
      // 放在 finalizeEntries 之后：只有**已收尾**的记录才该被渲染。
      this.prefillReplayMarkdown(sessionId);
      // [CUSTOM- `loadSession` 把 configOptions 写进 placeholder 是在
      // `session-created` **之后**（而且不走 applyConfigOptions）—— 不在这儿再记一次的话，
      // 打开一个历史会话会把草稿页快照的配置项清成空，用户点「+」就又看不到模式/模型了。
      this.rememberAgentOptions(sessionId);
      refresh();
    });
    on('active-session-changed', (sessionId: string | null, agentName: string | null) => {
      // The router owns focus decisions, but a focus change originating from
      // elsewhere (e.g. the tree) must still reach an attached panel.
      this.focused = { agentName, sessionId };
      // [CUSTOM- Focusing a session consumes its unread marker, and
      // the strip has to be told — otherwise the attention dot lingers.
      if (sessionId) { this.unread.delete(sessionId); }
      this.saveOpenSessions();
      this.pushFocus();
      this.refreshSessions();
    });

    // [CUSTOM- 配置项 / 可用命令一变就刷新草稿页快照。挂在 SessionManager 的
    // 事件上而不是 pushMeta 里：pushMeta 在"没有 surface attach"或"不是聚焦会话"时会提前
    // return，后台会话的变化就进不了快照——而那正是下一次草稿页要用的那份。
    //
    // 隐藏依赖（查过才敢写）：这两个事件由 **core** 产生——`SessionManager` 订阅了
    // `SessionUpdateHandler`，把 agent 推送的 `config_option_update` / `available_commands_update`
    // 落成会话状态后 emit。哪天那条订阅被摘掉，快照会**静默停止更新**（斜杠补全一起坏），
    // 而"某个事件没人 emit"这类缺口测试抓不到（见 pitfalls #65）。
    on('config-options-changed', (sessionId: string) => this.rememberAgentOptions(sessionId));
    on('available-commands-changed', (sessionId: string) => this.rememberAgentOptions(sessionId));

    // [CUSTOM- 本仓库第一次用 onDidChangeConfiguration。理由不是"同步方便"：
    // 面板把这个配置项**渲染成了一个控件**，控件显示过期值就是在撒谎（与 pitfalls #29 同族）。
    // 只认一个 key，disposable 进 subscriptions —— dispose() 已经统一释放它们。
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(AUTO_CONNECT_KEY)) { this.postAutoConnectPref(); }
        if (e.affectsConfiguration(RESTORE_KEY)) { this.postRestorePref(); }
        // [CUSTOM- 设置面板里的配置项（自动批准 / 协议日志 / 默认目录）也可能在
        // VS Code 的 Settings UI 里被改：面板上的控件不能显示过期值。
        if (e.affectsConfiguration('vac')) { this.postSettings(); }
        if (e.affectsConfiguration('vac.customModels')) { this.postCustomModels(); }
        if (e.affectsConfiguration('vac.agents')) {
          this.agentKindCache.clear();
          this.refreshSessions();
        }
      }),
    );
    // [CUSTOM- 编辑器里"当前打开的文件/选区"→ 输入框的引用栏（见 pushActiveFile）。
    // 选中变化**每次光标移动都会回调**，所以推送那边按签名去重（叠成行区间之后，同一行里动就不发）。
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.pushActiveFile()),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor === vscode.window.activeTextEditor) { this.pushActiveFile(); }
      }),
    );
  }

  // --- IChatPanel ----------------------------------------------------------

  attach(view: vscode.WebviewView, ctx: PanelContext): void {
    this.attachSurface(viewSurface(view), ctx);
  }

  /**
   * [CUSTOM- Attach (or re-attach) one surface. The same entry
   * point serves the sidebar view and the editor panel, so the HTML is rendered
   * per document — each webview needs its own CSP nonce and its own
   * `cspSource`, which is why the html string is never shared between surfaces.
   */
  attachSurface(surface: ChatSurface, ctx: PanelContext): void {
    this.surfaces.set(surface.key, surface);
    // [CUSTOM- 新面立刻拿到编辑器当前文件（签名是全局的，这里必须 force）。
    this.pushActiveFile(true);
    this.lastActive = surface.key;
    this.focused = ctx;
    this.surfaceFocused.set(surface.key, ctx.sessionId);
    surface.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    surface.setHtml(renderChatHtml(surface.webview, createNonce(), surface.key));
    // Targeted: a broadcast boot would force the OTHER document to reset and
    // re-hydrate (losing its scroll position) every time a surface attaches.
    this.pushBoot(surface.key);
  }

  detach(): void {
    this.detachSurface('view');
  }

  detachSurface(key: SurfaceKey): void {
    this.surfaces.delete(key);
    this.surfaceFocused.delete(key);
    if (this.lastActive === key) {
      this.lastActive = this.surfaces.keys().next().value ?? null;
    }
    // [CUSTOM- Last surface gone: any permission card still
    // waiting for a click is now unreachable, and the agent is blocked on it.
    // The bridge moves those prompts to the dialog instead of hanging.
    if (this.attachedCount === 0) {
      this.permissionBridge?.onPresenterLost();
      // [CUSTOM- 表单同理：没有面能画，就退回弹框，别让 agent 干等。
      this.elicitationBridge?.onPresenterLost();
    }
  }

  /** Zero means there is nowhere to render; every push must bail out. */
  private get attachedCount(): number {
    return this.surfaces.size;
  }

  onFocusChanged(ctx: PanelContext): void {
    this.focused = ctx;
    if (this.lastActive) { this.surfaceFocused.set(this.lastActive, ctx.sessionId); }
    this.pushFocus();
  }

  hasContent(): boolean {
    return this.transcripts.hasContent(this.focused.agentName);
  }

  attachFile(uri: vscode.Uri): void {
    const sessionId = this.focused.sessionId;
    if (!sessionId) {
      void vscode.window.showWarningMessage('Attach File: no session is focused.');
      return;
    }
    this.addAttachments(sessionId, [{ path: uri.fsPath, name: basename(uri.fsPath) }]);
    // 提到「最近交互过的面」而不是固定的侧边栏视图。
    // 旧写法 `view?.show?.(true)` 对 WebviewPanel 会静默失效（面板没有 `show`），
    // 表现为附件 chip 不显示也不报错。
    const surface = this.surfaces.get(this.lastActive ?? 'view') ?? this.surfaces.values().next().value;
    surface?.reveal(true);
  }

  /**
   * [CUSTOM-20261029] Ask the visible panel to show `#stopConfirm` instead of
   * cancelling directly. Used by the view-title Stop button and the command
   * palette (both used to call `SessionManager.cancelTurn` straight away).
   *
   * Returns false when no surface is showing this session — the caller then
   * falls back to a non-modal native warning. Returns true when there is
   * nothing to stop (the turn already ended), so the caller does nothing.
   */
  requestStop(sessionId: string): boolean {
    if (!this.sessionManager.isTurnInFlight(sessionId)) { return true; }
    let sent = false;
    for (const surface of this.surfaces.values()) {
      if (!this.isSurfaceShowing(surface, sessionId)) { continue; }
      // Targeted + immediate: a confirmation bar must not wait for the outbox frame.
      this.post({ type: 'stopAsk', sessionId }, surface.key);
      sent = true;
    }
    return sent;
  }

  /**
   * [CUSTOM- Add attachments to a session's pending list.
   *
   * Extracted from `attachFile` so the drag-and-drop path can share it — that
   * path must NOT reveal a surface, because the drop already happened on a
   * visible one and raising another panel would steal focus for no reason.
   */
  private addAttachments(sessionId: string, incoming: Attachment[]): void {
    const list = this.attachments.get(sessionId) ?? [];
    for (const attachment of incoming) {
      // [CUSTOM- 去重按**引用**而不是按路径：同一个文件可以引用**多段**
      // （`foo.cs:12-40` 与 `foo.cs:5-9` 是两条引用，用户明确要求）。拖拽/粘贴没有区间，
      // 于是它们仍然按路径去重（同一条路径拖两次只留一份）。
      if (!list.some(existing => sameReference(existing, attachment))) { list.push(attachment); }
    }
    this.attachments.set(sessionId, list);
    this.post({ type: 'attachments', sessionId, attachments: list });
  }

  /** Files dropped onto (or pasted into) the panel. */
  private handleAttachPaths(sessionId: string, paths: unknown, meta?: unknown): void {
    if (!Array.isArray(paths)) { return; }
    const labels = Array.isArray(meta) ? (meta as Array<{ name?: unknown; lineStart?: unknown; lineEnd?: unknown }>) : [];
    const incoming: Attachment[] = [];
    for (let i = 0; i < paths.length; i++) {
      const raw = paths[i];
      if (typeof raw !== 'string' || raw.length === 0) { continue; }
      const m = labels[i] ?? {};
      const lineStart = typeof m.lineStart === 'number' ? m.lineStart : undefined;
      const lineEnd = typeof m.lineEnd === 'number' ? m.lineEnd : undefined;
      // [CUSTOM- 显示名优先用调用方给的（编辑器那条带行区间），否则 basename。
      const name = typeof m.name === 'string' && m.name.length > 0 ? m.name : basename(raw);
      incoming.push({ path: raw, name, ...(lineStart ? { lineStart, lineEnd } : {}) });
    }
    if (incoming.length === 0) { return; }
    this.addAttachments(sessionId, incoming);
    log(`${LOG_PREFIX}: attached ${incoming.length} dropped/pasted file(s) to ${sessionId}`);
  }

  // [CUSTOM- 剪贴板/拖入的位图：剥离 data URL 前缀后把 base64 存进 imageData，
  // 附件列表里只放轻量 chip（path=合成 id）。发送时由 handleSendPrompt 拼成 image 块。
  private handleAttachImage(sessionId: string, id: string, name: string, mimeType: string, dataUrl: string): void {
    if (!id) { return; }
    const data = stripDataUrlPrefix(dataUrl);
    if (!data) {
      log(`${LOG_PREFIX}: attachImage dropped ${id}: no base64 payload`);
      return;
    }
    let map = this.imageData.get(sessionId);
    if (!map) { map = new Map(); this.imageData.set(sessionId, map); }
    map.set(id, { data, mimeType });
    this.addAttachments(sessionId, [{ path: id, name, kind: 'image', mimeType }]);
    log(`${LOG_PREFIX}: attached image ${id} to ${sessionId}`);
  }

  onMessage(message: unknown, from: SurfaceKey = 'view'): void {
    const msg = message as Partial<ChatToExt> & { type?: string };
    if (!msg || typeof msg.type !== 'string') { return; }
    this.lastActive = from;

    switch (msg.type) {
      case 'ready':
        this.pushBoot(from);
        return;
      case 'newSession': {
        // 修「+ 按钮点了没反应」。
        // 原先这里调 `connectToAgent(agentName)`，而它的语义是**已有会话就复用**
        // （SessionManager.connectToAgent：liveIds.length > 0 时只 focusSession），
        // 于是「开新会话」在有会话时退化成「聚焦已有会话」。开新会话必须走
        // newConversation → createSession —— 那才是 010 引入的原子操作。
        const agentName = (msg as { agentName?: string }).agentName ?? this.focused.agentName;
        if (!agentName) {
          this.reportError(null, new Error(
            'No agent to start a session with. Connect one in the Agents view first.'));
          return;
        }
        void this.sessionManager.newConversation(agentName).catch(e => this.reportError(null, e));
        return;
      }
      case 'focusAgent': {
        const agentName = (msg as { agentName?: string }).agentName;
        if (!agentName) { return; }
        const ids = this.sessionManager.getSessionIdsForAgent(agentName);
        const next = ids[ids.length - 1];
        if (next) { this.sessionManager.focusSession(next); }
        return;
      }

      // 面板内的「连接」与「历史会话」。
      // 都按设计不带 sessionId（要用它们时往往根本没有聚焦会话），所以在守卫之前处理。
      case 'connectAgent': {
        this.handleConnectAgent((msg as { agentName?: string }).agentName);
        return;
      }
      case 'listHistory': {
        void this.handleListHistory(
          (msg as { agentName?: string }).agentName,
          // [CUSTOM- The directory the CLIENT's address bar is showing —
          // the only correct source for a draft page (drafts are client-local, 058).
          (msg as { cwd?: string }).cwd,
        );
        return;
      }
      // 按过滤目录补扫磁盘（非会话作用域，守卫前）。
      case 'supplementHistory': {
        void this.handleSupplementHistory(
          (msg as { agentName?: string }).agentName,
          (msg as { cwd?: string }).cwd ?? '',
        );
        return;
      }
      // [CUSTOM- 会话恢复的三条（都非会话作用域：快照里的会话此刻都还没活）。
      case 'startRestore': {
        // 「开始恢复」：快照**留着**（下一次重载还要用），本次不再问了 —— 客户端负责建那些"未加载"的
        // 本地 tab（懒恢复：点开才 load）。宿主这边只做一件事：把**上次聚焦的那条**现在就加载起来，
        // 好让面板一恢复就有内容（那也正是用户刚刚在看的那个会话）。
        const snapshot = this.openSessions;
        const sessions = snapshot?.sessions ?? [];
        const target = snapshot?.focused && sessions.some(s => s.sessionId === snapshot.focused)
          ? snapshot.focused
          : sessions[0]?.sessionId;
        this.restoreDismissed = true;
        log(`${LOG_PREFIX}: restoring the open-session snapshot (${sessions.length} tab(s), loading ${target ?? 'none'} now)`);
        if (target) {
          const entry = sessions.find(s => s.sessionId === target);
          if (entry) { void this.openSnapshotSession(entry); }
        }
        return;
      }
      case 'dismissSessions':
        // 「开始新的」：用户不要这些 tab 了 —— 清掉快照，别再拿它问。
        this.restoreDismissed = true;
        this.openSessions = null;
        // 排队中的防抖写入可能在清空后再把旧快照写回来（New session 不建会话，没有后续
        // session-created 去覆盖它），先取消。
        if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
        this.globalState?.update(OPEN_SESSIONS_KEY, undefined);
        // 另一个已打开的面也要把恢复卡片撤掉（它靠随后的 connectAgent/focus 间接退场的旧路径
        // 已被 New session 的草稿页取代）。
        this.post({ type: 'sessionsDismissed' });
        log(`${LOG_PREFIX}: open-session snapshot dismissed`);
        return;
      case 'forgetRestorable': {
        const sessionId = (msg as { sessionId?: unknown }).sessionId;
        if (typeof sessionId === 'string' && this.openSessions) {
          this.openSessions = {
            ...this.openSessions,
            sessions: this.openSessions.sessions.filter(s => s.sessionId !== sessionId),
          };
          this.globalState?.update(OPEN_SESSIONS_KEY, this.openSessions);
        }
        return;
      }
      // 历史列表的归档 / 改名（会话 tab 右键菜单的 Rename
      // 走同一条 `renameSession`）。两条都**必须**在会话守卫之前：列表里的行大多不是活会话，
      // verifySession 只认 live 的，放在守卫后会整条丢掉。
      // 动作由宿主做（改名走原生输入框 —— webview 里没有等价控件），做完回一条 `sessionAction`
      // 让客户端**就地**更新列表；不重发整份 history，因为那会重置用户选的目录过滤。
      case 'archiveSession': {
        const id = (msg as { sessionId?: unknown }).sessionId;
        if (typeof id !== 'string' || !id) { return; }
        void this.updateSessionLabel(id, { archived: true }).then(() => {
          this.post({ type: 'sessionAction', action: 'archive', sessionId: id });
        });
        return;
      }
      case 'renameSession': {
        const id = (msg as { sessionId?: unknown }).sessionId;
        if (typeof id !== 'string' || !id) { return; }
        const current = (msg as { currentTitle?: unknown }).currentTitle;
        const title = (msg as { title?: unknown }).title;
        void this.handleRenameSession(
          id,
          typeof current === 'string' ? current : '',
          typeof title === 'string' ? title : undefined,
        );
        return;
      }
      // [CUSTOM- 真删除一条会话（历史列表行）。与 archiveSession 同区：**在 verifySession 守卫
      // 之前处理** —— 历史行大多不是活会话，守卫会把它整条丢掉。
      case 'deleteSession': {
        const id = (msg as { sessionId?: unknown }).sessionId;
        if (typeof id !== 'string' || !id) { return; }
        const requested = (msg as { agentName?: unknown }).agentName;
        const agentName = this.panelAgent(typeof requested === 'string' && requested ? requested : undefined);
        if (!agentName) { return; }
        void this.handleDeleteSession(agentName, id);
        return;
      }
      case 'setRestorePref':
        void this.handleSetRestorePref((msg as { value?: unknown }).value);
        return;
      case 'openHistorySession': {
        void this.handleOpenHistorySession(
          (msg as { agentName?: string }).agentName ?? '',
          (msg as { sessionId?: string }).sessionId ?? '',
          // [CUSTOM- The row carries the session's own directory;
          // see handleOpenHistorySession for why it matters.
          (msg as { cwd?: string }).cwd || undefined,
          // [CUSTOM- And its title, so the tab matches the list.
          (msg as { title?: string }).title || undefined,
          // [CUSTOM- The CLIENT was on a draft page: that draft is what
          // steps aside, not the session the host still has focused.
          !!(msg as { fromDraft?: boolean }).fromDraft,
          // [CUSTOM- 恢复多个会话时：**别**关掉当前聚焦的那个（099 的替换语义不适用）。
          !!(msg as { keepOthers?: boolean }).keepOthers,
        );
        return;
      }

      // 草稿页：同样按设计不带 sessionId
      // （草稿就是"还没有会话"），所以在守卫之前处理。
      case 'listDirectoryChoices':
        void this.handleListDirectoryChoices((msg as { agentName?: string }).agentName, from);
        return;
      // [CUSTOM- 目录抽屉「Recently used」的删除（2026-10-28）。非会话作用域（草稿页也要能删）：
      // 记下这条路径并重发候选，客户端那边点完立刻把行拿掉、这里只是让它在下次也消失。
      case 'removeRecentDirectory':
        void this.handleRemoveRecentDirectory((msg as { path?: string }).path, from);
        return;
      case 'pickDirectory':
        // [CUSTOM- purpose 区分「选 cwd」还是「选 additionalDirectories」，随应答回传。
        void this.handlePickDirectory(from, (msg as { purpose?: 'cwd' | 'additionalDirectories' }).purpose);
        return;
      case 'pickFiles':
        // [CUSTOM- 'Files or folders'：打开文件选择器（多选文件）。
        void this.handlePickFiles(from);
        return;
      case 'createDraftAndSend':
        void this.handleCreateDraftAndSend(
          (msg as { draftId?: string }).draftId ?? '',
          (msg as { agentName?: string }).agentName,
          (msg as { cwd?: string }).cwd,
          (msg as { text?: string }).text ?? '',
          (msg as { configSelections?: Array<{ configId: string; value: string }> }).configSelections ?? [],
          // [CUSTOM- 草稿页攒下的附件（草稿还没有会话，客户端先本地拿着）。
          (msg as { images?: Array<{ id: string; name: string; mimeType: string; dataUrl: string }> }).images ?? [],
          (msg as { paths?: string[] }).paths ?? [],
          // [CUSTOM- 草稿页显式勾选的额外根目录（多根工作区）。
          (msg as { additionalDirectories?: string[] }).additionalDirectories ?? [],
          from,
        );
        return;
      // [CUSTOM- 草稿页的输入卡该显示什么（模式/模型/命令）。同区、同样不带
      // sessionId —— 放守卫之后会被静默丢弃（§5.4 规则二）。
      case 'listDraftOptions':
        this.handleListDraftOptions(
          (msg as { agentName?: string }).agentName,
          (msg as { draftId?: string }).draftId ?? '',
          from,
        );
        return;

      // --- NOT session-scoped: must be handled BEFORE the guard below -----
      // These carry no top-level `sessionId` by design, so routing them
      // through `verifySession` dropped every one of them — which is what made
      // markdown rendering (and therefore code blocks, Copy buttons and links)
      // dead on arrival.
      case 'renderMarkdown':
        // Per-item session ids are validated inside handleRenderMarkdown.
        this.handleRenderMarkdown(
          (msg as { items: Array<{ entryId: string; sessionId: string; text: string }> }).items,
        );
        return;
      case 'copy': {
        // [CUSTOM- 复制是用户动作、频率低，但**失败必须留痕**：此前是裸 `void writeText`，
        // 剪贴板拒绝/超时只在渲染进程里变成一个没人看的 unhandled rejection ⇒ 界面表现
        // 就是"点了 Copy 没反应"，两进程都没有一行日志。
        const raw = (msg as { text?: unknown }).text;
        const text = typeof raw === 'string' ? raw : '';
        void vscode.env.clipboard.writeText(text).then(undefined, (e: unknown) => {
          log(`${LOG_PREFIX}: clipboard write failed (${text.length} chars): ${String(e)}`);
        });
        log(`${LOG_PREFIX}: copied ${text.length} char(s) to the clipboard`);
        return;
      }
      // [CUSTOM- NOT session-scoped: forward to the output channel.
      case 'clientLog': {
        const level = (msg as { level?: string }).level ?? 'info';
        const text = (msg as { message?: string }).message ?? '';
        log(`${LOG_PREFIX}: client(${level}): ${text}`);
        return;
      }
      // [CUSTOM- Outline pin/width prefs: NOT session-scoped, persist
      // to globalState so they survive webview disposal (window reload / editor panel).
      case 'setUiPref': {
        // [CUSTOM- **合并**而不是重建。原先这里按消息里的字段重建整个对象 ——
        // 那时只有一个写者（大纲）。现在有了第二个（tab 手工顺序），重建会把对方那一半抹掉
        // （同一条记录两个写者 = 后到的赢，而"赢"的代价是另一项被重置）。
        const previous = this.uiPrefs ?? { outlineMode: 'popup' as const, outlineWidth: 240 };
        const mode = (msg as { outlineMode?: unknown }).outlineMode;
        const outlineWidth = Number((msg as { outlineWidth?: unknown }).outlineWidth);
        const tabOrder = (msg as { tabOrder?: unknown }).tabOrder;
        // [CUSTOM- Times（第三个写者，同一条记录）：整份表 + 一个默认值。
        const timesBySession = (msg as { timesBySession?: unknown }).timesBySession;
        const timesDefault = (msg as { timesDefault?: unknown }).timesDefault;
        // [CUSTOM- Tail（消息面板自动追尾，第六个写者）：与 Times 完全同一形态。
        const tailBySession = (msg as { tailBySession?: unknown }).tailBySession;
        const tailDefault = (msg as { tailDefault?: unknown }).tailDefault;
        // [CUSTOM- 大纲侧栏的"按会话开/关"（第四个写者，同一形状）。
        const outlineOpenBySession = (msg as { outlineOpenBySession?: unknown }).outlineOpenBySession;
        const outlineOpenDefault = (msg as { outlineOpenDefault?: unknown }).outlineOpenDefault;
        // [CUSTOM- 新输出自动展开（第五个写者，同一形状：按会话 + 默认值 + 全局卡片类型）。
        const autoExpandBySession = (msg as { autoExpandBySession?: unknown }).autoExpandBySession;
        const autoExpandDefault = (msg as { autoExpandDefault?: unknown }).autoExpandDefault;
        const autoExpandKinds = (msg as { autoExpandKinds?: unknown }).autoExpandKinds;
        const autoExpandToolHeight = (msg as { autoExpandToolHeight?: unknown }).autoExpandToolHeight;
        const autoExpandThoughtHeight = (msg as { autoExpandThoughtHeight?: unknown }).autoExpandThoughtHeight;
        // [CUSTOM- 2026-10-21 第二批设置：子代理分组、输入卡尺寸、发送键、默认模型。
        const flatTools = (msg as { flatTools?: unknown }).flatTools;
        const composerMaxWidth = (msg as { composerMaxWidth?: unknown }).composerMaxWidth;
        const inputMaxHeight = (msg as { inputMaxHeight?: unknown }).inputMaxHeight;
        const sendKey = (msg as { sendKey?: unknown }).sendKey;
        const defaultModelByAgent = (msg as { defaultModelByAgent?: unknown }).defaultModelByAgent;
        const defaultEffortByAgent = (msg as { defaultEffortByAgent?: unknown }).defaultEffortByAgent;
        // [CUSTOM- **先整份继承，再逐项覆盖**。原先这里只列了"这一轮认识的字段"，
        // 于是消息里没带的项（设置面板写的 markdownStyle / flatTools / sendKey /
        // recentDirectoryLimit）会被静默抹掉 —— 用户现象：改完 Markdown style 再点
        // 地址栏 Tail，样式退回默认。以后新增字段也不用再回来补一行。
        const next: UiPrefs = {
          ...previous,
          outlineMode: mode === undefined
            ? previous.outlineMode
            : (mode === 'sidebar' ? 'sidebar' : 'popup'),
          outlineWidth: Number.isFinite(outlineWidth) ? outlineWidth : previous.outlineWidth,
        };
        // 缺的字段 = 这一轮没改它 ⇒ 保留上一次的值。**从没写过的**那一项不落进记录里
        // （undefined 键会让 globalState 里那条记录读起来像"写过但没值"，也会让断言多出一堆噪声）。
        const order = tabOrder === undefined ? previous.tabOrder : sanitizeTabOrder(tabOrder);
        if (order !== undefined) { next.tabOrder = order; }
        const times = timesBySession === undefined ? previous.timesBySession : sanitizeSessionFlags(timesBySession);
        if (times !== undefined) { next.timesBySession = times; }
        const def = timesDefault === undefined ? previous.timesDefault : timesDefault === true;
        if (def !== undefined) { next.timesDefault = def; }
        const tailMap = tailBySession === undefined ? previous.tailBySession : sanitizeSessionFlags(tailBySession);
        if (tailMap !== undefined) { next.tailBySession = tailMap; }
        const tailDef = tailDefault === undefined ? previous.tailDefault : tailDefault === true;
        if (tailDef !== undefined) { next.tailDefault = tailDef; }
        const openMap = outlineOpenBySession === undefined
          ? previous.outlineOpenBySession
          : sanitizeSessionFlags(outlineOpenBySession);
        if (openMap !== undefined) { next.outlineOpenBySession = openMap; }
        const openDef = outlineOpenDefault === undefined ? previous.outlineOpenDefault : outlineOpenDefault === true;
        if (openDef !== undefined) { next.outlineOpenDefault = openDef; }
        const expandMap = autoExpandBySession === undefined
          ? previous.autoExpandBySession
          : sanitizeSessionFlags(autoExpandBySession);
        if (expandMap !== undefined) { next.autoExpandBySession = expandMap; }
        const expandDef = autoExpandDefault === undefined ? previous.autoExpandDefault : autoExpandDefault === true;
        if (expandDef !== undefined) { next.autoExpandDefault = expandDef; }
        const kinds = autoExpandKinds === undefined
          ? previous.autoExpandKinds
          : sanitizeAutoExpandKinds(autoExpandKinds);
        if (kinds !== undefined) { next.autoExpandKinds = kinds; }
        const toolHeight = autoExpandToolHeight === undefined
          ? previous.autoExpandToolHeight
          : clampExpandHeight(autoExpandToolHeight, 360);
        if (toolHeight !== undefined) { next.autoExpandToolHeight = toolHeight; }
        const thoughtHeight = autoExpandThoughtHeight === undefined
          ? previous.autoExpandThoughtHeight
          : clampExpandHeight(autoExpandThoughtHeight, 240);
        if (thoughtHeight !== undefined) { next.autoExpandThoughtHeight = thoughtHeight; }
        if (flatTools !== undefined) { next.flatTools = flatTools === true; }
        const width = composerMaxWidth === undefined
          ? previous.composerMaxWidth
          : clampNumber(composerMaxWidth, 360, 1200, 720);
        if (width !== undefined) { next.composerMaxWidth = width; }
        const height = inputMaxHeight === undefined
          ? previous.inputMaxHeight
          : clampNumber(inputMaxHeight, 80, 800, 320);
        if (height !== undefined) { next.inputMaxHeight = height; }
        if (sendKey !== undefined) { next.sendKey = sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter'; }
        const models = defaultModelByAgent === undefined
          ? previous.defaultModelByAgent
          : sanitizeStringMap(defaultModelByAgent);
        if (models !== undefined) { next.defaultModelByAgent = models; }
        const efforts = defaultEffortByAgent === undefined
          ? previous.defaultEffortByAgent
          : sanitizeStringMap(defaultEffortByAgent);
        if (efforts !== undefined) { next.defaultEffortByAgent = efforts; }
        const recentLimit = (msg as { recentDirectoryLimit?: unknown }).recentDirectoryLimit;
        if (recentLimit !== undefined) {
          next.recentDirectoryLimit = ChatPanelHost.clampRecentDirectories(recentLimit);
        }
        const markdownStyle = (msg as { markdownStyle?: unknown }).markdownStyle;
        if (markdownStyle !== undefined) { next.markdownStyle = resolveMarkdownStyle(markdownStyle); }
        this.uiPrefs = next;
        this.globalState?.update(UI_PREFS_KEY, this.uiPrefs);
        // [CUSTOM- 另外那个面（侧边栏 / 编辑区）也要跟着换序，否则它下次被重开
        // 之前会一直用旧顺序 —— 同一份偏好，两个写者，必须回话（pitfall #29 的老规矩）。
        this.post({ type: 'uiPrefs', ...this.uiPrefs });
        return;
      }
      // [CUSTOM- 设置面板（2026-10-21）：与 setUiPref 一样**非会话作用域**，放在
      // verifySession 守卫之前。宿主是唯一写者：配置项写 VS Code 设置，面板项写 UiPrefs；
      // 每次写完都把整张表重发一遍，两个面看到的是同一份真值。
      case 'getSettings': {
        this.postSettings();
        return;
      }
      case 'setSetting': {
        const key = String((msg as { key?: unknown }).key ?? '');
        void this.handleSetSetting(key, (msg as { value?: unknown }).value).catch(e => this.reportError(null, e));
        return;
      }
      case 'settingAction': {
        const action = String((msg as { action?: unknown }).action ?? '');
        const key = (msg as { key?: unknown }).key;
        const layer = (msg as { layer?: unknown }).layer;
        void this.handleSettingAction(
          action,
          typeof key === 'string' ? key : undefined,
          layer === 'workspace' || layer === 'user' || layer === 'global' ? layer : undefined,
        ).catch(e => this.reportError(null, e));
        return;
      }
      // [CUSTOM- The start card's auto-connect switch. NOT session-scoped
      // (the switch is exactly what you reach for when there is no session), so it is
      // handled here, before the verifySession guard (§5.4 rule 2).
      case 'setAutoConnect': {
        void this.handleSetAutoConnect((msg as { value?: unknown }).value === true);
        return;
      }
      case 'openLink':
        void this.handleOpenLink((msg as { href?: string }).href ?? '');
        return;
      // [CUSTOM-20261029] 引用标签在草稿页也能点（还没有会话），所以放在守卫之前。
      // 带 sessionId 的消息仍按旧语义校验：会话已不存在就丢弃，避免按错目录解析相对路径。
      case 'openFile': {
        const requested = (msg as { sessionId?: unknown }).sessionId;
        const requestedSession = typeof requested === 'string' && requested ? requested : undefined;
        if (requestedSession && !sessionOf(this.sessionManager, requestedSession)) {
          log(`${LOG_PREFIX}: dropped openFile for unknown session ${requestedSession}`);
          return;
        }
        void this.handleOpenFile(
          requestedSession,
          (msg as { path?: string }).path ?? '',
          (msg as { line?: number }).line,
          (msg as { endLine?: number }).endLine,
        );
        return;
      }
      case 'executeCommand':
        log(`${LOG_PREFIX}: ignoring webview executeCommand (no allowlist yet)`);
        return;

      default:
        break;
    }

    // Everything below is session-scoped and must name a live session.
    const sessionId = verifySession(this.sessionManager, msg as { sessionId?: string });
    if (!sessionId) {
      log(`${LOG_PREFIX}: dropped ${msg.type} for unknown session ${String((msg as { sessionId?: string }).sessionId)}`);
      return;
    }

    switch (msg.type) {
      case 'sendPrompt':
        void this.handleSendPrompt(sessionId, (msg as { text?: string }).text ?? '');
        return;
      case 'cancelTurn':
        void this.sessionManager.cancelTurn(sessionId).catch(e => this.reportError(sessionId, e));
        this.refreshSessions();
        return;
      // [CUSTOM- 2026-10-29] 会话 tab 右键 "Mark as unread"：直接点亮 attention 圆点。
      // 聚焦到该会话时 active-session-changed 会清掉它（与后台输出同一条规则）。
      case 'markUnread':
        this.unread.add(sessionId);
        this.refreshSessions();
        return;
      case 'closeSession': {
        const agentName = sessionOf(this.sessionManager, sessionId)?.agentName;
        if (!agentName) { return; }
        // [CUSTOM- 运行中会话的确认在客户端（见 closeSession 的注释）：×、Delete、
        // 右键 Close、中键四条入口都汇到客户端的 closeModel，一次覆盖全部。
        void this.closeSession(agentName, sessionId);
        return;
      }
      // [CUSTOM- 取消一个 sub-agent 子会话（子会话 id 走 `subagentSessionId`，不是 sessionId）。
      case 'cancelSubagent': {
        const subagentSessionId = (msg as { subagentSessionId?: string }).subagentSessionId ?? '';
        if (!subagentSessionId) { return; }
        void this.sessionManager.cancelSubagent(sessionId, subagentSessionId)
          .catch(e => this.reportError(sessionId, e));
        return;
      }
      case 'focusSession':
        // [CUSTOM- `force` — an explicit request from the client must
        // ALWAYS be answered.
        //
        // `SessionManager.focusSession` early-returns when the id is already active
        // (it emits only on a CHANGE), and the host's `focused` is not what the
        // client is showing: **drafts are client-local** (058), so the panel can be
        // sitting on a draft page while our `focused` already names this very
        // session. Without `force` the click produced no event, hence no `focus`
        // reply — and the panel stayed on the draft with a tab that "does nothing".
        // (Same idiom the manager itself uses for the user-visible focus changes of
        // newConversation / loadSession / resume.)
        this.sessionManager.focusSession(sessionId, { force: true });
        return;
      // [CUSTOM- Fork the session at the assistant message the user right-clicked.
      // The panel only sends an entry id; the ACP `messageId` is looked up here so the
      // record wire format does not have to carry it.
      case 'forkFromMessage': {
        const agentName = sessionOf(this.sessionManager, sessionId)?.agentName;
        const entryId = (msg as { entryId?: string }).entryId ?? '';
        const entry = entryId ? this.transcripts.getEntry(sessionId, entryId) : undefined;
        if (!agentName || !entry) { return; }
        const messageId = entry.kind === 'assistant' ? entry.messageId : undefined;
        log(`${LOG_PREFIX}: fork session ${sessionId} at entry ${entryId} (messageId=${messageId ?? 'end'})`);
        void this.sessionManager.forkSession(agentName, sessionId, messageId ? { messageId } : {})
          .then(() => this.refreshSessions())
          .catch(e => this.reportError(sessionId, e));
        return;
      }
      // [CUSTOM- 会话 tab 右键：在同一个目录里再开一个新会话（目录取源会话的，
      // 额外根目录也一并继承）。新会话照常套用记住的模式/默认模型/默认强度。
      case 'newSessionInDirectory': {
        const source = sessionOf(this.sessionManager, sessionId);
        if (!source) { return; }
        log(`${LOG_PREFIX}: new session beside ${sessionId} in ${source.cwd} (agent ${source.agentName})`);
        void this.sessionManager.createSession(source.agentName, {
          cwd: source.cwd,
          additionalDirectories: source.additionalDirectories,
          focus: true,
        })
          .then(created => {
            this.placeSessionAfterInTabOrder(sessionId, created.sessionId);
            this.refreshSessions();
          })
          .catch(e => this.reportError(sessionId, e));
        return;
      }
      // [CUSTOM- 复制会话 = 在末尾 fork（不带 messageId）：新会话继承源会话的
      // 上下文与消息记录，随后由 `openExistingSession` 重放并聚焦。
      case 'duplicateSession': {
        const source = sessionOf(this.sessionManager, sessionId);
        if (!source) { return; }
        log(`${LOG_PREFIX}: duplicating session ${sessionId} (agent ${source.agentName})`);
        void this.sessionManager.forkSession(source.agentName, sessionId)
          .then(() => this.refreshSessions())
          .catch(e => this.reportError(sessionId, e));
        return;
      }
      case 'detachFile': {
        const path = (msg as { path?: string }).path;
        // [CUSTOM- 带区间 = 只摘那一段（同一个文件的多段引用各自能删）；不带 = 整条路径
        // 全摘（拖拽/粘贴的 chip 没有区间，行为不变）。
        const start = (msg as { lineStart?: unknown }).lineStart;
        const end = (msg as { lineEnd?: unknown }).lineEnd;
        const ranged = typeof start === 'number';
        const list = (this.attachments.get(sessionId) ?? []).filter(a => ranged
          ? !(a.path === path && (a.lineStart ?? 0) === start && (a.lineEnd ?? 0) === (typeof end === 'number' ? end : start))
          : a.path !== path);
        this.attachments.set(sessionId, list);
        if (path) { this.imageData.get(sessionId)?.delete(path); }
        this.post({ type: 'attachments', sessionId, attachments: list });
        return;
      }
      // [CUSTOM- Session-scoped: sits AFTER the guard above.
      case 'attachPath':
        this.handleAttachPaths(
          sessionId,
          (msg as { paths?: unknown }).paths,
          // [CUSTOM- 与 paths 平行的显示名/行区间（只有"编辑器当前文件"那条带）。
          (msg as { meta?: unknown }).meta,
        );
        return;
      // 输入框图片：会话作用域，守卫之后（同 attachPath）。
      case 'attachImage':
        this.handleAttachImage(
          sessionId,
          (msg as { id?: string }).id ?? '',
          (msg as { name?: string }).name ?? 'image',
          (msg as { mimeType?: string }).mimeType ?? 'image/png',
          (msg as { dataUrl?: string }).dataUrl ?? '',
        );
        return;
      case 'setMode':
        void this.sessionManager.setMode(sessionId, (msg as { modeId: string }).modeId)
          // [CUSTOM- Announce the switch in the transcript, not just in
          // the picker: the record is what a reader scrolls back through.
          // [CUSTOM- …and remember it as the user's choice (this is a
          // user action by construction: the message only comes from the panel).
          .then(() => { this.rememberUserMode(sessionId); this.syncChoices(sessionId); this.pushMeta(sessionId); })
          .catch(e => this.reportError(sessionId, e));
        return;
      case 'setModel':
        void this.sessionManager.setModel(sessionId, (msg as { modelId: string }).modelId)
          .then(() => { this.syncChoices(sessionId); this.pushMeta(sessionId); })
          .catch(e => this.reportError(sessionId, e));
        return;
      case 'setConfigOption':
        void this.sessionManager.setConfigOption(
          sessionId,
          (msg as { configId: string }).configId,
          (msg as { value: string }).value,
        )
          // [CUSTOM- Remember only when the option that changed IS the mode
          // (this one message carries model, mode, effort and anything else the agent adds).
          .then(() => {
            const session = sessionOf(this.sessionManager, sessionId);
            const mode = modeOptionOf(session?.configOptions);
            if (mode && mode.id === (msg as { configId: string }).configId) { this.rememberUserMode(sessionId); }
            this.syncChoices(sessionId);
            this.pushMeta(sessionId);
          })
          .catch(e => this.reportError(sessionId, e));
        return;
      // [CUSTOM- Session-scoped: it must sit AFTER the guard above.
      case 'needToolView': {
        this.resendToolView(
          sessionId,
          (msg as { entryId?: string }).entryId ?? '',
          (msg as { toolCallId?: string }).toolCallId ?? '',
          from,
        );
        return;
      }
      case 'openTerminal':
        this.handleOpenTerminal(sessionId, (msg as { terminalId?: string }).terminalId ?? '');
        return;
      // [CUSTOM- Session-scoped: it must sit AFTER the guard above.
      // [CUSTOM- 表单回答：与会话作用域守卫之后的位置要求一致。
      case 'elicitationAnswer': {
        const answer = msg as {
          promptId?: string;
          action?: ElicitationAction;
          content?: ElicitationContent;
        };
        if (answer.promptId && answer.action) {
          this.elicitationBridge?.submit(answer.promptId, answer.action, answer.content);
        }
        return;
      }
      case 'permissionAnswer': {
        const promptId = (msg as { promptId?: string }).promptId;
        if (promptId) {
          this.permissionBridge?.answer(promptId, (msg as { optionId?: string }).optionId);
        }
        return;
      }
      default:
        break;
    }
  }

  dispose(): void {
    // [CUSTOM- Unregister first: an update arriving while the
    // rest of this method runs would otherwise index into state that is being
    // torn down.
    this.sessionUpdateHandler.removeListener(this.updateListener);
    this.outbox.dispose();
    for (const d of this.subscriptions) { d.dispose(); }
    this.subscriptions.length = 0;
    this.surfaces.clear();
    this.surfaceFocused.clear();
    this.lastActive = null;
    this.unread.clear();
    // [CUSTOM- No timers may outlive the host (they would refresh a
    // torn-down panel and keep the extension host awake for nothing).
    for (const timer of this.backgroundTasks.values()) { clearTimeout(timer); }
    this.backgroundTasks.clear();
    for (const timer of this.settleTimers.values()) { clearTimeout(timer); }
    this.settleTimers.clear();
    // setPresenter(null) also cancels every prompt still awaiting an answer:
    // nothing can render or answer them once the host is gone.
    this.permissionBridge?.setPresenter(null);
    this.elicitationBridge?.setPresenter(null);
  }

  // --- Prompt handling -----------------------------------------------------

  private async handleSendPrompt(sessionId: string, text: string): Promise<void> {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }

    // [CUSTOM- 第二次发言 = 第一次对话已经结束：此刻的标题就是它的名字，冻住。
    // 放在这里而不是"第一轮结束时"：adapter 是在 idle（轮次结束）那一刻才去推标题的，两者几乎
    // 同时到达 —— 在轮次结束处冻结会把刚刚生成的自动命名一起挡在门外（那是它唯一该被采纳的时机）。
    // 等到下一条消息发出时再判，既不抢跑也不迟到。
    if (this.turnsDone.has(sessionId) && !this.titleFrozen.has(sessionId)) {
      this.titleFrozen.add(sessionId);
      log(`${LOG_PREFIX}: session ${sessionId} keeps the title it had after the first exchange`);
    }

    // [CUSTOM- 注入块（<task-notification> 等）虽然是从输入框发出去的，
    // 但仍然是注入块——渲染成蓝色用户气泡一样会误导。发送路径与 replay 路径用同一个
    // 判据（isInjectedChunk）。
    if (isInjectedChunk(text)) {
      const preview = firstLineOf(stripInjectionWrapper(text));
      const entry = this.transcripts.appendNotice(sessionId, 'meta', preview);
      if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
      // 仍然要真的发出去（agent 期待收到这条注入），只是不把它当用户消息渲染。
      // 复用下面的发送逻辑：把 text 原样作为唯一 text block。
    }

    const attachments = this.attachments.get(sessionId) ?? [];
    const images = this.imageData.get(sessionId) ?? new Map();

    // The transcript is the panel's own record; the extension-side store keeps
    // it so the bubble survives a panel switch.
    this.transcripts.ensureSession(sessionId, session.agentName);
    // A new user turn ends any prose the agent was still streaming.
    this.finalizeEntries(sessionId, { only: 'assistant' });
    // [CUSTOM- 图片附件进用户气泡（不再独立成行）——它们是这次提问的
    // 一部分，不是另一条记录。
    // [CUSTOM- **文件引用**同样要进气泡（用户报："引用了文件的消息发出去后，
    // 消息面板里这条用户消息卡片里看不到引用的文件"——它只进了发给 agent 的 blocks，
    // 气泡里没有对应视图）。两处产出一遍算：气泡视图与 blocks 在**同一个循环**里砌出来，
    // uri / `#L` 片段 / name 各只有一个来源（pitfall #19），不会出现"发出去带区间、
    // 气泡里不带"这类两边漂移。
    const blocks: ContentBlock[] = [];
    const attachmentViews: ContentBlockView[] = [];
    if (text.trim().length > 0) { blocks.push({ type: 'text', text }); }
    for (const a of attachments) {
      if (a.kind === 'image') {
        const img = images.get(a.path);
        if (!img) {
          log(`${LOG_PREFIX}: image attachment ${a.path} has no stored bytes`);
          continue;
        }
        blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType });
        const view = toContentView({ type: 'image', data: img.data, mimeType: img.mimeType });
        if (view && view.type === 'image') {
          if (a.name) { view.name = a.name; }
          attachmentViews.push(view);
        }
      } else {
        // ACP `ResourceLink.uri` is a plain string (file:// URI per convention).
        // [CUSTOM- 带选区行区间时挂一个 `#L12-40` 片段：`name` 里已经有它是给人看的，
        // 片段则是让 agent 也能看到"引用的是哪几行"（不认识片段的实现会照旧忽略它）。
        const range = a.lineStart ? `#L${a.lineStart}-${a.lineEnd ?? a.lineStart}` : '';
        const uri = fileUri(a.path).toString() + range;
        blocks.push({ type: 'resource_link', uri, name: a.name });
        // 视图走同一条 uri（toContentView 会认出本地文件并给出 `path`）⇒ 气泡里的 chip
        // 点击走 openFile 通道（039/205 的既有约定）。
        const view = toContentView({ type: 'resource_link', uri, name: a.name });
        if (view && view.type === 'resource_link') { attachmentViews.push(view); }
      }
    }
    // [CUSTOM- 空文字 + 附件时跳过空的气泡。
    // [CUSTOM- 注入块已在上面作为 meta notice 落账，这里不再产生用户气泡。
    if (!isInjectedChunk(text) && text.trim().length > 0) {
      const userEntry = this.transcripts.appendUser(
        sessionId, text, attachmentViews.length > 0 ? attachmentViews : undefined);
      if (userEntry) { this.post({ type: 'append', sessionId, entries: [userEntry] }); }
    } else if (attachmentViews.length > 0) {
      const entry = this.transcripts.appendContent(sessionId, attachmentViews);
      if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
    }

    this.sessionManager.recordFirstPrompt(sessionId, text);
    this.attachments.set(sessionId, []);
    this.imageData.delete(sessionId);
    this.post({ type: 'attachments', sessionId, attachments: [] });

    // 轮次进行中：把这条消息**注入**正在跑的那一轮
    // （Claude Code 的 steering），而不是当第二个 `session/prompt` 发出去。
    //
    // 为什么要单独一条路：steering 是在**同一个**轮次里追加内容，它**不会**产生第二个
    // PromptResponse。走下面的正常路径要么被 SessionManager 的"已有轮次在跑"守卫拒掉
    // （那正是用户报的"任务进行中按回车没反应"），要么 await 一个永远不来的响应
    // （Stop 按钮永不熄灭、finalizeTurn 永不执行）。所以这里把用户气泡落账后**原样返回**：
    // 轮次状态一个都不动，让原来那一轮自己收尾。
    if (this.sessionManager.hasRunningTurn(sessionId) && this.sessionManager.supportsSteering(sessionId)) {
      try {
        const how = await this.sessionManager.steerPrompt(sessionId, blocks);
        if (how === 'steered') { return; }
        // 'idle'：agent 说它没在跑（我们这边的标记陈旧了，例如后台任务）⇒ 落回普通路径。
      } catch (e: any) {
        this.reportError(sessionId, e);
        return;
      }
    }

    // [CUSTOM- How this turn ended, for the turn-done notification
    // (filled in below; `finalizeTurn` runs in the finally, so it has to be declared
    // out here).
    let outcome: TurnOutcome = {};

    try {
      // Start the turn and only THEN refresh: `sendPrompt` registers the
      // in-flight turn synchronously before its first await, so refreshing
      // beforehand would always report `running: false` (no Stop button).
      // [CUSTOM- 新轮次开始：不必再替后台任务"占着"运行中（轮次自己就会报告）。
      this.endBackgroundTask(sessionId, 'turn');
      const pending = this.sessionManager.sendPrompt(sessionId, blocks);
      this.finalizeEntries(sessionId, { only: 'thought' });
      this.refreshSessions();
      this.pushMeta(sessionId);

      const response = await pending;
      this.applyStopReason(sessionId, response.stopReason);
      // [CUSTOM- 这里原来还有一次 `applyResponseUsage`（把 PromptResponse 的
      // totalTokens 折进圆环）—— 那是单位张冠李戴，已删除；圆环只认 usage_update。
      // [CUSTOM- 这一轮怎么结束的，决定要不要（以及怎么）通知。
      outcome = turnOutcome(response.stopReason);
    } catch (e: any) {
      this.reportError(sessionId, e);
      outcome = { failed: true, detail: e?.message ?? String(e) };
    } finally {
      this.finalizeTurn(sessionId, outcome);
    }
  }

  /**
   * Surface a non-normal turn ending. The ACP spec is explicit that a
   * `refusal` turn's content is excluded from the next prompt, so the UI must
   * show it rather than ending silently.
   */
  private applyStopReason(sessionId: string, stopReason: string | undefined): void {
    // [CUSTOM- The wording lives in `stopReasonText` (shared with the
    // turn-done notification) so the record and the toast cannot tell two stories.
    const message = stopReasonText(stopReason);
    if (!message) { return; }
    const entry = this.transcripts.appendNotice(sessionId, 'warn', message);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  // --- Switch notices () --------------------------------

  /** The session's switchable state right now, or null when it has no session. */
  private choiceState(sessionId: string): ChoiceSnapshot | null {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return null; }
    return choiceSnapshotFromState(session.modes, session.configOptions);
  }

  /**
   * Diff a session's switchable state against the cached snapshot and announce
   * whatever moved (model / mode / any other config option).
   *
   * The FIRST snapshot of a session is a BASELINE, not a change: opening a session
   * must not print "Switched to <the model it already had>". That also covers the
   * two racing reporters of the same change — whichever arrives first announces,
   * the second diffs to nothing.
   *
   * `next` lets a caller pass a state built from a NOTIFICATION payload (see
   * onSessionUpdate); omitted, the state is read from SessionManager.
   */
  private syncChoices(sessionId: string, next?: ChoiceSnapshot | null): void {
    const state = next === undefined ? this.choiceState(sessionId) : next;
    if (!state) { return; }
    const previous = this.choices.get(sessionId);
    this.choices.set(sessionId, state);
    if (!previous) { return; }
    const labels = choiceChanges(previous, state);
    if (labels.length === 0) { return; }
    const entry = this.transcripts.appendNotice(sessionId, 'switch', labels.join(' · '));
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  /**
   * [CUSTOM- Keep the session's title map in step with the agent.
   *
   * [CUSTOM- …but **without announcing the change in the transcript**
   * (user report: 会话进行中会自己改名，跳出一行 `Session renamed to “…”`).
   *
   * [CUSTOM- …and (user rule) **only until the first exchange is over**:
   * the name is decided by the first exchange — the auto-title if it landed by then,
   * otherwise the first user message — and NOTHING may rename the session afterwards.
   *
   * Why: the adapter pulls the SDK title at every turn end (`maybeUpdateSessionTitle`)
   * and the SDK generates it in a background task, so it can land several turns later —
   * by which time it describes what the conversation drifted INTO, not what it is
   * (user's words: 这时候对话信息已经脱离第一次对话内容了). Late is not "an update",
   * it is a different name for a different thing.
   */
  private trackTitle(sessionId: string, title: string): boolean {
    if (!title) { return false; }
    if (this.titleFrozen.has(sessionId)) {
      log(`${LOG_PREFIX}: ignoring a late title for ${sessionId} (the name is fixed by the first exchange)`);
      return false;
    }
    this.sessionTitles.set(sessionId, title);
    return true;
  }

  /**
   * Close streaming entries and tell the webview, so its copy of the entry
   * learns `streaming: false` (and, for thoughts, the elapsed time).
   */
  private finalizeEntries(sessionId: string, opts: { only?: 'assistant' | 'thought' } = {}): void {
    for (const entryId of this.transcripts.finalizeStreaming(sessionId, opts)) {
      const entry = this.transcripts.getEntry(sessionId, entryId);
      if (!entry) { continue; }
      this.post({
        type: 'revise',
        sessionId,
        entryId,
        patch: { streaming: false, elapsedMs: (entry as { elapsedMs?: number }).elapsedMs },
      });
    }
  }

  /** Close streaming entries and ask the webview to render markdown. */
  private finalizeTurn(sessionId: string, outcome: TurnOutcome = {}): void {
    // [CUSTOM- 一轮跑完 ⇒ 下一次发言到来时标题就该冻住了。
    this.turnsDone.add(sessionId);
    this.finalizeEntries(sessionId);
    this.sessionManager.touchHistory(sessionId);
    this.refreshSessions();
    this.pushTurnState(sessionId);
    // [CUSTOM- Batching health check: a high merged/queued ratio
    // means the coalescing is doing its job; if `queued` stays large at turn
    // end something is bypassing the outbox.
    // [CUSTOM- Per-turn, not cumulative (see Outbox.resetStats).
    // `queued` here is normally 0-2 (the frame still in flight); a value that
    // stays large across turns is the real signal.
    const stats = this.outbox.stats();
    log(`${LOG_PREFIX}: outbox sent=${stats.sent} merged=${stats.merged} queued=${stats.queued}`);
    this.outbox.resetStats();
    // [CUSTOM- 后台会话跑完一轮就通知一声。这里是**唯一**的轮次结束收敛点
    // （finalizeTurn 全仓只有 handleSendPrompt 的 finally 一处调用），所以"这一轮结束了吗"
    // 不需要第二份状态（pitfall #34）。
    if (!outcome.silent) {
      const turn = (this.turnSeq.get(sessionId) ?? 0) + 1;
      this.turnSeq.set(sessionId, turn);
      this.notifySession({
        kind: 'turn-done',
        sessionId,
        token: String(turn),
        detail: outcome.detail,
        failed: outcome.failed,
      });
    }
  }

  // --- Session update → transcript ----------------------------------------

  private onSessionUpdate(update: SessionNotification): void {
    // [CUSTOM- 子会话别名（见 subagentParents 的注释）：子会话自己的流量并回父会话再渲染。
    const parentOfChild = this.subagentParents.get(update.sessionId);
    if (parentOfChild) { update = { ...update, sessionId: parentOfChild }; }
    const sessionId = update.sessionId;
    const data = update.update as any;
    const session = sessionOf(this.sessionManager, sessionId);
    if (!data || !session) { return; }

    this.transcripts.ensureSession(sessionId, session.agentName);
    // [CUSTOM- 每次更新都重新计一次"安静"窗口：窗口到了就把还没渲染的记录补齐
    // （见 settlePrefillMarkdown）。它覆盖的是"客户端那条往返没送到"的所有形态。
    this.armSettlePrefill(sessionId);

    // [CUSTOM- Take the switch baseline here, at the top, because this
    // runs for every update of every session regardless of whether a surface is
    // attached — so a baseline exists before any switch can be reported.
    if (!this.choices.has(sessionId)) { this.syncChoices(sessionId); }
    // [CUSTOM- ...and the rename baseline, for the same reason.
    if (!this.sessionTitles.has(sessionId)) { this.sessionTitles.set(sessionId, session.title ?? ''); }

    // [CUSTOM- 后台子任务：进入 / 续期"轮次之外仍在工作"（见 noteBackgroundTask）。
    // 放在 switch 之前：这两条判据只看通告本身，与具体分支无关。
    if (isBackgroundLaunch(data.rawInput)) {
      this.noteBackgroundTask(sessionId, 'a background task was launched');
    } else if (this.backgroundTasks.has(sessionId) && isWorkUpdate(data)) {
      this.noteBackgroundTask(sessionId, 'still producing output');
    }

    switch (data.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(data.content);
        if (text.length === 0) {
          this.postContentNotice(sessionId, data.content);
          return;
        }
        // Close ONLY the thought block: prose beginning means the reasoning is
        // done. Closing the assistant entry here too was the bug that turned
        // one reply into one bubble per chunk.
        this.finalizeEntries(sessionId, { only: 'thought' });
        const entry = this.transcripts.appendAssistantChunk(sessionId, text, data.messageId ?? undefined);
        if (entry) {
          this.stampReplayTime(sessionId, entry, data.messageId);
          this.post({ type: 'append', sessionId, entries: [entry] });
        }
        // A chunk means a turn is in flight even if we did not start it.
        this.refreshSessions();
        return;
      }

      case 'agent_thought_chunk': {
        const text = textOf(data.content);
        if (text.length === 0) {
          // [CUSTOM- Non-text content inside a THOUGHT chunk (an image
          // the agent pasted into its reasoning, a resource link) used to be dropped
          // on the floor. It becomes a content record like any other.
          //
          // The thought is closed first, and that is not cosmetic: entries only
          // merge into the LAST one, so a thought left open here would be stranded
          // with a permanent "Thinking…" spinner while the next thought chunk opens
          // a second block.
          this.finalizeEntries(sessionId, { only: 'thought' });
          this.postContentNotice(sessionId, data.content);
          return;
        }
        const entry = this.transcripts.appendThoughtChunk(sessionId, text, data.messageId ?? undefined);
        if (entry) {
          this.stampReplayTime(sessionId, entry, data.messageId);
          this.post({ type: 'append', sessionId, entries: [entry] });
        }
        return;
      }

      case 'user_message_chunk': {
        // Replay path (`session/load`).
        const text = textOf(data.content);
        // [CUSTOM- IDE 上下文块：**不建记录**，挂到同一条消息的用户气泡上。
        // 放在注入块判据之前 —— 它也是 `<ide_` 开头，但这里认得出来该做成 chip。
        const idePath = ideOpenedFilePath(text);
        if (idePath) {
          this.rememberIdeFile(sessionId, data.messageId, ideFileChip(idePath));
          return;
        }
        // [CUSTOM- Images of this user message (and, since 216, its FILE
        // REFERENCES) were read from the transcript BEFORE replay started
        // (preloadTranscriptTimes); merge them into the bubble. The separate chunks that
        // follow (100) are dropped below so they do not become second rows.
        const parts = this.replayPartsFor(sessionId, data.messageId);
        // [CUSTOM- 文件引用：agent 把 `resource_link` 块序列化成一段文本回放回来。
        // 这里必须**先于**注入块与正文判据认出它（它也长得像普通文本），否则它会变成一条
        // 蓝色气泡、把 `[@名](file:///…)` 原样显示出来（用户报的正是这个）。
        const mentions = fileMentionViews(text);
        if (mentions) {
          // 这条记录有正文 ⇒ 引用已经（或马上会）随正文 chunk 并进那个气泡，这条只丢不建。
          if (parts?.hasProse) { return; }
          // 没有正文的记录（只引用文件就发送）自己渲染 —— 与发送路径同形（215：落成 content 条目）。
          // 读不到转录时也走这里：无论如何都不把这段 markdown 当正文显示。
          const mentionEntry = this.transcripts.appendContent(sessionId, mentions);
          if (mentionEntry) { this.post({ type: 'append', sessionId, entries: [mentionEntry] }); }
          return;
        }
        if (text.length === 0) {
          // [CUSTOM- Non-text blocks of a USER message were dropped here
          // (a pasted image, a resource link), so a reopened conversation showed the
          // prompt without the picture it carried. Same treatment as the thought chunk
          // below (075): it becomes a content record like any other.
          // [CUSTOM- 丢弃的判据是"这条记录**有正文**"（那它已经随正文 chunk 进气泡了），
          // 不再是"转录里知道这条消息"：只有附件、没有正文的消息（111 起就存在）此前被无条件丢掉，
          // 于是重开后连图片一起消失。没有正文时这里就是它唯一的承载者，自己渲染。
          if (parts?.hasProse) { return; }
          if (parts && (parts.images.length > 0 || parts.files.length > 0)) {
            const ownEntry = this.transcripts.appendContent(sessionId, [...parts.images, ...parts.files]);
            if (ownEntry) { this.post({ type: 'append', sessionId, entries: [ownEntry] }); }
            return;
          }
          this.postContentNotice(sessionId, data.content);
          return;
        }
        // [CUSTOM- 注入块（<task-notification> 等）不是用户输入，
        // 却走同一个 user chunk 通道 —— 渲染成蓝色用户气泡会把"agent 的回报"误读成
        // "我说过这句话"。分流成 meta 提示条，正文截断一行。
        if (isInjectedChunk(text)) {
          // [CUSTOM- 后台任务汇报完毕：等的就是它（见 noteBackgroundTask）。
          if (isTaskNotification(text)) { this.endBackgroundTask(sessionId, 'reported'); }
          const preview = firstLineOf(stripInjectionWrapper(text));
          const entry = this.transcripts.appendNotice(sessionId, 'meta', preview);
          if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
          return;
        }
        // [CUSTOM- A user chunk IS a turn boundary, so it must
        // close any assistant prose still marked as streaming. Nothing else
        // does it on the replay path: `finalizeTurn` only runs for a prompt we
        // sent, and the tool_call branch only fires when a tool follows. An
        // entry left `streaming: true` forever keeps the client's copy in the
        // streaming state — which among other things pins `aria-busy` to true
        // () and silently mutes the screen reader for the
        // rest of the session. The legacy panel finalizes the pending assistant
        // turn here too ("finalizes pending assistant turn", its
        // user_message_chunk branch).
        this.finalizeEntries(sessionId, { only: 'assistant' });
        // [CUSTOM- 同一条消息的 IDE 上下文（若到过）与附件一起进气泡：chip 在前、正文在下。
        // [CUSTOM- 附件 = IDE 上下文 + 图片 + 文件引用（三者各只有一个来源）。
        const ideChip = this.takeIdeFile(sessionId, data.messageId);
        const views = (ideChip ? [ideChip] : []).concat(parts?.images ?? [], parts?.files ?? []);
        const entry = this.transcripts.appendUser(sessionId, text, views.length > 0 ? views : undefined);
        if (entry) {
          this.stampReplayTime(sessionId, entry, data.messageId);
          this.post({ type: 'append', sessionId, entries: [entry] });
        }
        return;
      }

      // [CUSTOM- sub-agent 子会话的通知（ACP draft，agent-client-protocol #1992）。
      // 通知**外层**的 sessionId 是父会话（已由上面的别名与守卫处理），update **里面**的
      // `sessionId` 才是子会话 —— 两者不要看错。
      case 'subagent_update': {
        const childId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (!childId) { return; }
        const caps = data.capabilities as { cancel?: unknown } | null | undefined;
        const rawState = data.state as { state?: unknown } | null | undefined;
        const state: SubagentEntry['state'] =
          rawState && typeof rawState.state === 'string'
            ? (rawState.state as SubagentEntry['state'])
            : 'unknown';
        // Remember the parent BEFORE the card exists: the child's own output can arrive first.
        this.subagentParents.set(childId, sessionId);
        const result = this.transcripts.upsertSubagent(sessionId, {
          subagentSessionId: childId,
          title: typeof data.title === 'string' ? data.title : undefined,
          description: typeof data.description === 'string' ? data.description : undefined,
          state,
          canCancel: !!caps && typeof caps === 'object' && caps.cancel !== undefined && caps.cancel !== null,
        });
        if (!result) { return; }
        if (result.created) {
          this.post({ type: 'append', sessionId, entries: [result.entry] });
        } else {
          this.post({
            type: 'revise', sessionId, entryId: result.entry.id,
            patch: {
              title: result.entry.title,
              description: result.entry.description,
              state: result.entry.state,
              canCancel: result.entry.canCancel,
            },
          });
        }
        return;
      }

      case 'tool_call': {
        // Prose that continues after a tool call belongs in a new bubble, so
        // the transcript reads text → tool → text. (Only the assistant entry:
        // the thought block was already closed by the first prose chunk.)
        this.finalizeEntries(sessionId, { only: 'assistant' });
        const inv = this.tools.upsertCall(sessionId, data);
        const entry = this.transcripts.appendTool(sessionId, inv.toolCallId);
        if (entry) {
          this.toolEntryIds.set(toolKey(sessionId, inv.toolCallId), entry.id);
          // Nesting must run BEFORE rendering this card so it carries its
          // parent link on first paint.
          const changed = this.applyNesting(sessionId, session.agentName);
          this.post({ type: 'append', sessionId, entries: [{ ...entry, toolView: toToolCallView(inv) }] });
          this.pushNestingUpdates(sessionId, changed, inv.toolCallId);
        }
        return;
      }

      case 'tool_call_update': {
        const inv = this.tools.upsertUpdate(sessionId, data);
        if (!inv) { return; }
        // A Task's output often arrives only at the END of the call, which is
        // when an explicit parent link becomes discoverable — so re-run the
        // strategy on every update, not just on first sight.
        const changed = this.applyNesting(sessionId, session.agentName);
        const entryId = this.toolEntryIds.get(toolKey(sessionId, inv.toolCallId));
        if (entryId) {
          this.post({ type: 'toolUpdate', sessionId, entryId, tool: toToolCallView(inv) });
        }
        this.pushNestingUpdates(sessionId, changed, inv.toolCallId);
        return;
      }

      case 'plan': {
        // ACP replaces the whole plan on every update, so consecutive
        // notifications must update ONE card rather than stack up.
        const previousId = this.planEntryIds.get(sessionId);
        const existing = previousId ? this.transcripts.getEntry(sessionId, previousId) : undefined;
        if (existing && existing.kind === 'plan') {
          existing.entries = data.entries ?? [];
          // [CUSTOM- 键名是 `entries`（= 记录字段名），不是 `plan`。
          // 曾用 `plan` 导致客户端的 patch 写进 entry.plan 而渲染读 entry.entries，
          // 于是 Todo 列表永远停在第一次快照且没有任何报错。
          this.post({ type: 'revise', sessionId, entryId: existing.id, patch: { entries: existing.entries } });
          return;
        }
        const entry = this.transcripts.appendPlan(sessionId, data.entries ?? []);
        if (entry) {
          this.planEntryIds.set(sessionId, entry.id);
          this.post({ type: 'append', sessionId, entries: [entry] });
        }
        return;
      }

      case 'usage_update': {
        this.usage.set(sessionId, {
          used: Number(data.used ?? 0),
          size: Number(data.size ?? 0),
          costAmount: data.cost?.amount,
          costCurrency: data.cost?.currency,
          // [CUSTOM- 思考 token：ACP 的 Usage 里有这个字段，但实测当前适配器没发过来
          // （`used`/`size`/`_meta._claude/model` 之外什么都没有）。有就带上，没有就是 undefined。
          thoughtTokens: typeof (data as { thoughtTokens?: unknown }).thoughtTokens === 'number'
            ? (data as { thoughtTokens?: number }).thoughtTokens
            : undefined,
        });
        this.pushMeta(sessionId);
        return;
      }

      default: {
        // [CUSTOM- 标题的**单一判定点**：`trackTitle` 说收下，SessionManager 才写。
        // 拆成两处会漏 —— 第一版只挡了宿主那份 map，而 tab 的标题读的是 `session.title`
        // （`applySessionInfoUpdate` 写的），于是"迟到几轮的自动命名"照样改掉了名字。
        const titleAccepted = data.sessionUpdate === 'session_info_update'
          ? this.trackTitle(sessionId, typeof data.title === 'string' ? data.title : '')
          : false;
        if (titleAccepted) {
          this.sessionManager.applySessionInfoUpdate(sessionId, {
            title: data.title as string,
            updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
          });
        }
        // available_commands_update / config_option_update / current_mode_update /
        // session_info_update need the host to re-read state after they land.
        if (data.sessionUpdate === 'available_commands_update'
          || data.sessionUpdate === 'config_option_update'
          || data.sessionUpdate === 'current_mode_update'
          || data.sessionUpdate === 'session_info_update') {
          this.pushMeta(sessionId);
          this.refreshSessions();
        }
        // [CUSTOM- 标题的记账已经在上面的 default 分支里做完（163/164 起静默、
        // 且只认第一次对话里的那一条），这里不再重复。
        // [CUSTOM- A switch the agent pushed (or that another surface
        // triggered). The PAYLOAD is used rather than SessionManager's copy: our
        // listener may run before SessionManager's, in which case its state is still
        // the old one and the diff would come out empty. If our own setter already
        // reported this change, the diff here is empty and nothing prints twice.
        const previous = this.choices.get(sessionId);
        if (!previous) { return; }
        if (data.sessionUpdate === 'config_option_update') {
          this.syncChoices(sessionId, choiceSnapshotPatched(previous, { configOptions: data.configOptions }));
        } else if (data.sessionUpdate === 'current_mode_update') {
          this.syncChoices(sessionId, choiceSnapshotPatched(previous, { modeId: data.currentModeId }));
        }
        return;
      }
    }
  }

  /**
   * [CUSTOM- Read a session's real message times BEFORE replaying it.
   *
   * Done up front rather than on `session-load-start` (an event): the replay notifications
   * arrive synchronously once the agent starts streaming, so a table still being read
   * would be too late for the first chunks — and those are exactly the rows a reader
   * scrolls to the top of the outline to find.
   */
  private async preloadTranscriptTimes(agent: string, sessionId: string, cwd?: string): Promise<void> {
    if (this.replayTimes.has(sessionId)) { return; }
    const dirCwd = cwd || this.workspaceCwd();
    if (!dirCwd) { return; }
    const dir = transcriptDirFor(agent, dirCwd);
    if (!dir) { return; }
    try {
      const times = await readTranscriptTimes(dir, sessionId);
      if (times.size > 0) {
        this.replayTimes.set(sessionId, times);
        log(`${LOG_PREFIX}: replayed times available for ${sessionId} (${times.size} messages)`);
      }
    } catch (e) {
      // Best effort: no times means the records keep the host clock, as before.
      log(`${LOG_PREFIX}: transcript times unavailable (${(e as Error)?.message ?? e})`);
    }
    // [CUSTOM- Images of user messages too: the replay delivers them as
    // separate chunks (100), so the bubble has nothing to merge with unless we read
    // the transcript. Any failure is "no images", never an error.
    // [CUSTOM- …and the message's FILE REFERENCES ride the same way (the agent
    // serialises a `resource_link` block as a `[@name](file:///…)` text block). One scan now
    // serves both, and it also reports whether each record has prose of its own — the
    // discriminator that tells an attachment chunk "this already rode on the text chunk"
    // from "you are the only carrier this message has".
    try {
      const parts = await readTranscriptUserAttachments(dir, sessionId);
      if (parts.size > 0) {
        this.replayUserParts.set(sessionId, parts);
        log(`${LOG_PREFIX}: replayed user attachments available for ${sessionId} (${parts.size} messages)`);
      }
    } catch (e) {
      log(`${LOG_PREFIX}: transcript user attachments unavailable (${(e as Error)?.message ?? e})`);
    }
  }

  /** Real parts (images / file references / prose) of a replayed user message, or undefined. */
  private replayPartsFor(sessionId: string, messageId: unknown): TranscriptUserParts | undefined {
    if (typeof messageId !== 'string' || messageId.length === 0) { return undefined; }
    return this.replayUserParts.get(sessionId)?.get(messageId);
  }

  /**
   * [CUSTOM- 存一个"这条消息的 IDE 上下文文件"，等同一条消息的正文 chunk 来取。
   * 认不出 messageId 的 chunk 直接丢掉 —— 没有配对的键，挂到别人身上比不显示更糟。
   */
  private rememberIdeFile(sessionId: string, messageId: unknown, chip: ContentBlockView): void {
    if (typeof messageId !== 'string' || messageId.length === 0) {
      log(`${LOG_PREFIX}: IDE context block without a messageId (dropped)`);
      return;
    }
    this.ideFilesByMessage.set(ideKey(sessionId, messageId), chip);
    // 只留最近 20 条：若用户只是"打开了个文件"而没有下文，这条就永远没人来取。
    while (this.ideFilesByMessage.size > 20) {
      const oldest = this.ideFilesByMessage.keys().next().value;
      if (oldest === undefined) { break; }
      this.ideFilesByMessage.delete(oldest);
    }
  }

  /** [CUSTOM- 取走这条消息的 IDE 上下文（取过即删，不会挂到第二条消息上）。 */
  private takeIdeFile(sessionId: string, messageId: unknown): ContentBlockView | undefined {
    if (typeof messageId !== 'string' || messageId.length === 0) { return undefined; }
    const key = ideKey(sessionId, messageId);
    const chip = this.ideFilesByMessage.get(key);
    if (chip) { this.ideFilesByMessage.delete(key); }
    return chip;
  }

  /** Real epoch ms for a replay chunk's message, or undefined when the agent gave none. */
  private replayTimeFor(sessionId: string, messageId: unknown): number | undefined {
    if (typeof messageId !== 'string' || messageId.length === 0) { return undefined; }
    return this.replayTimes.get(sessionId)?.get(messageId);
  }

  /**
   * Stamp a replay entry with its real time when the transcript knows it. The entry is
   * the store's OWN object (`append*` returns a live reference), so correcting `at` here
   * also fixes every later snapshot — the client is handed the same object.
   */
  private stampReplayTime(sessionId: string, entry: { at: number; atIsElapsed?: boolean } | null, messageId: unknown): void {
    if (!entry) { return; }
    const at = this.replayTimeFor(sessionId, messageId);
    if (at !== undefined) { entry.at = at; entry.atIsElapsed = false; }
  }

  /**
   * Non-text content in a message chunk becomes a real transcript entry so the
   * webview renders it (image inline, resource as a chip, …) instead of a
   * `[image content]` placeholder.
   *
   * [CUSTOM- An **empty text block** reaches here whenever the
   * agent uses one as a chunk separator (`textOf` returns '' so the caller
   * treats it as non-text). `toContentView` maps it to a perfectly valid
   * `{type:'text', text:''}` view, and rendering that produced a blank strip in
   * the transcript — that was the source of the "empty bars" between real
   * blocks. A block nobody can see is not content: drop it.
   */
  private postContentNotice(sessionId: string, block: unknown): void {
    const view = toContentView(block as ContentBlock | null);
    if (!hasVisibleContent(view)) { return; }
    const entry = this.transcripts.appendContent(sessionId, [view!]);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  // --- Sub-agent nesting ---------------------------------------------------

  /**
   * Recompute parent links for a session's tool calls.
   *
   * ACP has no nesting concept, so this is inference — see `nesting/`. The
   * strategy is per-agent and the default is a no-op, which is why the flat
   * list is the guaranteed-correct baseline rather than a fallback branch.
   */
  private applyNesting(sessionId: string, agentName: string): string[] {
    const strategy = resolveNestingStrategy(agentName);
    return strategy.apply(this.tools.list(sessionId));
  }

  /** Push fresh views for cards whose nesting changed since they were sent. */
  private pushNestingUpdates(sessionId: string, changed: readonly string[], skip?: string): void {
    for (const toolCallId of changed) {
      if (toolCallId === skip) { continue; }
      const inv = this.tools.get(sessionId, toolCallId);
      const entryId = this.toolEntryIds.get(toolKey(sessionId, toolCallId));
      if (!inv || !entryId) { continue; }
      this.post({ type: 'toolUpdate', sessionId, entryId, tool: toToolCallView(inv) });
    }
  }

  // --- Markdown round-trip -------------------------------------------------

  private handleRenderMarkdown(items: Array<{ entryId: string; sessionId: string; text: string; key?: string }>): void {
    // [CUSTOM- A malformed item must never take the whole batch with it.
    //
    // 这条请求是一条**批**：客户端把"所有还缺 html 的记录"一次发来（大会话回放时
    // 几百条）。旧实现在 `item.entryId` / `item.sessionId` 上直接取值，只要数组里混进
    // 一个 null/非对象，模板字符串就先抛了 —— 整批不渲染、不回包，而且一行日志都没有。
    // 排在批尾的正好是最后一条消息，表现就是"只有最后一条停在原文"。
    // 现在逐项校验 + 逐项 try/catch：坏项跳过并记账，其余照常渲染、照常回包。
    if (!Array.isArray(items)) {
      log(`${LOG_PREFIX}: renderMarkdown without an items array ignored`);
      return;
    }
    const rendered: Array<{ entryId: string; sessionId: string; html: string; key?: string }> = [];
    let skipped = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item.entryId !== 'string' || typeof item.text !== 'string') {
        skipped++;
        continue;
      }
      try {
        const sessionId = verifySession(this.sessionManager, item);
        if (!sessionId) {
          // [CUSTOM- Do not drop it silently: a dropped item means that record
          // stays raw markdown forever, and this line is the only place that can say so
          // (pitfall #33's lesson — the 120 bug was invisible for exactly this reason).
          log(`${LOG_PREFIX}: dropped markdown item ${item.entryId} (unknown session ${item.sessionId})`);
          continue;
        }
        const html = this.markdown.render(item.text);
        // [CUSTOM- A render only applies to the text it was made from.
        //
        // `item.text` is a snapshot of the record as it looked when the client asked;
        // the record can have grown since (prose streams, and the ask goes out the
        // moment the record lands — 128). Storing that html anyway leaves the STORE
        // holding a rendering of a prefix, which the next snapshot (session switch,
        // reopen, tab focus) hands to the client as if it were current — the record
        // then shows its first few lines and nothing else. Dropping it is not a loss:
        // the record still has no html, so the client's settle-time request renders
        // the text it actually has.
        // [CUSTOM- A KEYED item is a sub-block of a tool card, not a
        // transcript record: there is nothing in the store to patch, the HTML goes
        // back to the element that asked for it. Skipping the patch also avoids a
        // pointless lookup for an id that can never be found.
        if (!item.key) {
          const current = this.transcripts.getEntry(sessionId, item.entryId);
          const renderedFrom = (current as { text?: string } | undefined)?.text;
          if (current && renderedFrom !== undefined && renderedFrom !== item.text) {
            log(`${LOG_PREFIX}: stale markdown reply dropped for ${item.entryId} (asked ${item.text.length} chars, now ${renderedFrom.length})`);
            continue;
          }
          this.transcripts.patch(sessionId, item.entryId, { html });
        }
        rendered.push({ entryId: item.entryId, sessionId, html, key: item.key });
      } catch (e) {
        skipped++;
        log(`${LOG_PREFIX}: markdown item ${item.entryId} failed: ${String(e)}`);
      }
    }
    if (rendered.length > 0) {
      this.post({ type: 'markdownRendered', items: rendered });
    }
    if (skipped > 0) {
      log(`${LOG_PREFIX}: skipped ${skipped} malformed markdown item(s) (rendered ${rendered.length})`);
    }
  }

  /**
   * [CUSTOM- 回放结束时由**宿主自己**把 markdown 补齐（2026-10-27 用户报
   * 「进场时消息没有渲染成 markdown」）。
   *
   * 正常路径是客户端来要：记录落地 / 定稿时发 `renderMarkdown`，宿主渲染后回填。
   * 真机日志里出现过一次 37 条记录的回放 —— 客户端**只**为最后一条发过请求，其余全部
   * 停在原文，而且两端都没有一条报错（客户端的请求计数、宿主的丢弃计数都是干净的）。
   * 也就是说这条往返会静默断在客户端那侧，而从那侧的日志看不出断在哪一步。
   *
   * 宿主手上有渲染器与权威文本，所以回放这种**有限且已经收尾**的流不该依赖那条往返：
   * 这里直接渲染一遍并推给客户端（补丁带 text 与 streaming:false，见客户端 patch 的
   * 「与文本一起到的 html 才作数」规则）。它同时修好另一种形态：客户端若丢了收尾的
   * revise，记录会永远停在 streaming，看起来像永远"正在输入"。
   *
   * 只处理已收尾的 assistant / thought（流式中的正文不能冻结在某一段上，见 pitfalls #49）。
   */
  private prefillReplayMarkdown(sessionId: string): void {
    const entries = this.collectMissingMarkdown(sessionId);
    if (entries.length === 0) { return; }
    log(`${LOG_PREFIX}: pre-rendering markdown for ${entries.length} replayed record(s) in ${sessionId}`);
    for (let at = 0; at < entries.length; at += ChatPanelHost.PREFILL_BATCH) {
      const batch = entries.slice(at, at + ChatPanelHost.PREFILL_BATCH);
      if (at === 0) {
        this.renderMarkdownBatch(sessionId, batch, true);
      } else {
        // [CUSTOM- 大回放分片跑：一次渲染几百条会在宿主线程上造成一段可见的长任务。
        setTimeout(() => this.renderMarkdownBatch(sessionId, batch, true), 0);
      }
    }
  }

  /** 快照路径同样补齐：切回一个会话时不该再出现"先原文、后 markdown"。 */
  private prefillSnapshotMarkdown(sessionId: string): void {
    const entries = this.collectMissingMarkdown(sessionId);
    if (entries.length > 0) { this.renderMarkdownBatch(sessionId, entries, false); }
  }

  /**
   * [CUSTOM- 会话安静下来之后把还缺 html 的记录补齐（2026-10-27 用户报
   * 「对话中的会话，最后一条消息卡片经常没有渲染，关掉重开就正常」）。
   *
   * 需要这一条的理由是"请求 → 回填"那条往返并不总是成立：
   * · 一轮结束后**轮次之外**还有输出（后台子任务、收尾晚到的分片）⇒ 这条记录再也收不到
   *   `streaming:false`，客户端的"定稿重试点"因此永远不触发（思考块连落地时都不入队）；
   * · 请求本身也会在客户端侧静默丢掉（回放取证：37 条记录只有最后一条被要过）。
   * 两种形态的后果一样：卡片停在原文，关掉重开会话（走快照）才恢复。
   *
   * 做法保守：会话**安静**了 SETTLE_PREFILL_MS 才动手；轮次仍在跑时**跳过还在 stream 的
   * 记录**（半截正文渲染出来，下一片又会变回原文）。轮次已结束则连 stream 的一起渲染 ——
   * 那正是"最后一条"的形状。
   */
  private armSettlePrefill(sessionId: string): void {
    const previous = this.settleTimers.get(sessionId);
    if (previous) { clearTimeout(previous); }
    const timer = setTimeout(() => {
      this.settleTimers.delete(sessionId);
      this.settlePrefillMarkdown(sessionId);
    }, ChatPanelHost.SETTLE_PREFILL_MS);
    this.settleTimers.set(sessionId, timer);
  }

  private settlePrefillMarkdown(sessionId: string): void {
    if (!this.sessionManager.getSession(sessionId)) { return; }
    const running = this.sessionManager.hasRunningTurn(sessionId);
    const entries = this.collectMissingMarkdown(sessionId, { includeStreaming: !running });
    if (entries.length === 0) { return; }
    log(`${LOG_PREFIX}: settled markdown for ${entries.length} record(s) in ${sessionId}`);
    this.renderMarkdownBatch(sessionId, entries, true);
  }

  /** 已收尾、有正文、还没有 html 的 assistant / thought 记录。 */
  private collectMissingMarkdown(
    sessionId: string,
    opts: { includeStreaming?: boolean } = {},
  ): TranscriptEntry[] {
    const entries = this.transcripts.snapshot(sessionId)?.entries ?? [];
    const out: TranscriptEntry[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'assistant' && entry.kind !== 'thought') { continue; }
      const prose = entry as { text?: string; html?: string; streaming?: boolean };
      if (prose.streaming && !opts.includeStreaming) { continue; }
      // 空白正文渲染出来是空串（客户端也当"没有 html"），会让安静窗口每 600ms 重试一次。
      if (!prose.text || prose.text.trim().length === 0 || prose.html) { continue; }
      out.push(entry);
    }
    return out;
  }

  /** 渲染一批并落盘；`notify` 时逐条推给客户端（携带 text，客户端据此认领这份 html）。 */
  private renderMarkdownBatch(sessionId: string, entries: readonly TranscriptEntry[], notify: boolean): void {
    for (const entry of entries) {
      const prose = entry as { text?: string; html?: string };
      if (!prose.text || prose.html) { continue; }
      let html: string;
      try {
        html = this.markdown.render(prose.text);
      } catch (e) {
        log(`${LOG_PREFIX}: markdown pre-render failed for ${entry.id}: ${String(e)}`);
        continue;
      }
      if (!html) { continue; }
      // [CUSTOM- 只对**还在 store 里**的记录下发：分片跑的时候会话可能已经被关掉了。
      const updated = this.transcripts.patch(sessionId, entry.id, { html });
      if (notify && updated) {
        this.post({
          type: 'revise',
          sessionId,
          entryId: entry.id,
          patch: { text: prose.text, html, streaming: false },
        });
      }
    }
  }

  // --- Links / files -------------------------------------------------------

  private async handleOpenLink(href: string): Promise<void> {
    // Scheme allowlist. `command:` would turn agent output into IDE command
    // execution; javascript:/data:/file: are equally unacceptable here.
    let parsed: vscode.Uri;
    try {
      parsed = vscode.Uri.parse(href, true);
    } catch {
      return;
    }
    if (parsed.scheme !== 'http' && parsed.scheme !== 'https' && parsed.scheme !== 'mailto') {
      void vscode.window.showWarningMessage(`Blocked link with unsupported scheme: ${parsed.scheme}`);
      return;
    }
    await vscode.env.openExternal(parsed);
  }

  private async handleOpenFile(
    sessionId: string | undefined,
    rawPath: string,
    line?: number,
    endLine?: number,
  ): Promise<void> {
    if (!rawPath) { return; }
    // [CUSTOM- Resolve relative paths against the session that OWNS
    // the chip rather than whatever happens to be focused. The `verifySession`
    // guard already validated this id, so there is one source of truth for the
    // working directory (previously this read `this.focused.sessionId`, which
    // was equivalent only because the client filters by the focused session).
    // [CUSTOM-20261029] `sessionId` may be absent on the draft page; `fileUri`
    // then falls back to the first workspace folder.
    const session = sessionId ? sessionOf(this.sessionManager, sessionId) : undefined;
    const uri = fileUri(rawPath, session?.cwd);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line && line > 0) {
        const lastRow = Math.max(0, doc.lineCount - 1);
        const startRow = Math.min(Math.max(0, line - 1), lastRow);
        if (endLine && endLine > 0) {
          // [CUSTOM-20261029] Reference chips carry an inclusive 1-based range:
          // select the whole range, ending at the end of the last line (not at
          // the start of the next one, so the trailing newline is not included).
          const endRow = Math.min(Math.max(startRow, endLine - 1), lastRow);
          const end = doc.lineAt(endRow).range.end;
          const start = new vscode.Position(startRow, 0);
          editor.selection = new vscode.Selection(start, end);
          editor.revealRange(
            new vscode.Range(start, end),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
          );
        } else {
          const position = new vscode.Position(startRow, 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenterIfOutsideViewport,
          );
        }
      }
    } catch (e: any) {
      void vscode.window.showWarningMessage(`Could not open ${rawPath}: ${e?.message ?? e}`);
    }
  }

  /**
   * Show a tool call's terminal output.
   *
   * ACP's `Terminal` tool-content is only a *reference* (`{terminalId}`) — the
   * client owns the terminal and must render it. Until now the chip was a dead
   * control because there was no path to the handler at all.
   */
  private handleOpenTerminal(sessionId: string, terminalId: string): void {
    if (!terminalId) { return; }
    const handlers = this.sessionManager.getConnectionForSession(sessionId)?.terminals;
    const snapshot = handlers?.readOutput(terminalId) ?? null;
    if (!snapshot) {
      this.reportError(sessionId, new Error(`Terminal ${terminalId} is no longer available.`));
      return;
    }
    const status = snapshot.exited
      ? `exited: ${snapshot.exitCode ?? 'signal ' + (snapshot.exitSignal ?? 'unknown')}`
      : 'still running';
    const text = [
      `$ terminal ${terminalId} (${status})${snapshot.truncated ? ' — output truncated' : ''}`,
      '',
      snapshot.output || '(no output yet)',
    ].join('\n');
    const entry = this.transcripts.appendContent(sessionId, [{ type: 'text', text }]);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }

  // --- Permission presenter () --------------------------

  /**
   * Whether this prompt belongs to the modern panel — i.e. whether the panel can
   * eventually render it and the user can answer it there.
   *
   * [CUSTOM- This used to require the prompt's session to be the
   * FOCUSED one, which handed every background session's request to the window-level
   * QuickPick. That is wrong for a multi-session panel: the user's screenshot shows
   * the result — a modal question at the top of the window about a session they were
   * not looking at. A record is now created for any modern session (the client
   * filters by focused session, and the focus/boot snapshot brings it back), and when
   * it is NOT on screen the host sends a notification instead (see notifySession).
   *
   * Three conditions, all required: the session exists and its OWN agent is a modern
   * one (matching the focused agent's name was a latent bug — with only one modern
   * agent configured it never showed), and some surface exists to draw on. A hidden
   * surface is raised only for the FOCUSED session — the agent is blocked until this
   * is answered, and that is the session the user is working in. A background
   * session never steals the view; its notification does the telling.
   *
   * "No surface" still returns false on purpose: nothing can render, so the bridge's
   * dialog fallback stays the exit that cannot hang the agent (pitfall #14).
   */
  canPresent(sessionId: string): boolean {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return false; }
    const surface = this.surfaceShowing(sessionId) ?? this.activeSurface();
    if (!surface) { return false; }
    if (this.focused.sessionId === sessionId && !surface.visible) { surface.reveal(true); }
    return true;
  }

  /** The surface a prompt would be drawn on (last active, else any). */
  private activeSurface(): ChatSurface | undefined {
    return this.surfaces.get(this.lastActive ?? 'view') ?? this.surfaces.values().next().value;
  }

  /**
   * The surface a permission card for `sessionId` may be drawn on. A surface other
   * than the focused one can be showing that session (the two chat surfaces focus
   * independently), so the focused/active fast path comes first and the rest are
   * consulted as a fallback.
   */
  private surfaceShowing(sessionId: string): ChatSurface | undefined {
    const active = this.activeSurface();
    if (active && this.isSurfaceShowing(active, sessionId)) { return active; }
    for (const surface of this.surfaces.values()) {
      if (this.isSurfaceShowing(surface, sessionId)) { return surface; }
    }
    return undefined;
  }

  /** True when the surface is on screen and its focused session is `sessionId`. */
  private isSurfaceShowing(surface: ChatSurface, sessionId: string): boolean {
    if (!surface.visible) { return false; }
    const shown = surface.key === this.lastActive ? this.focused.sessionId : this.surfaceFocused.get(surface.key);
    return shown === sessionId;
  }

  /**
   * [CUSTOM- True when the user is actually looking at this session:
   * it is the focused one AND a visible surface shows it. Everything else gets a
   * notification instead (the panel may be closed, hidden behind an editor, or
   * showing a different session entirely).
   */
  private isSessionOnScreen(sessionId: string): boolean {
    if (this.focused.sessionId !== sessionId) { return false; }
    const surface = this.activeSurface();
    return !!surface && surface.visible;
  }

  /**
   * [CUSTOM- Tell the user about a session they are not looking at.
   * The on-screen check lives HERE rather than inside SessionNotifier: the host owns
   * `focused`/`surfaces`, and keeping the notifier free of host state is what makes
   * it testable with two lines (see SessionNotifier).
   */
  private notifySession(input: {
    kind: 'waiting-permission' | 'waiting-form' | 'turn-done' | 'background-stalled';
    sessionId: string;
    token: string;
    detail?: string;
    failed?: boolean;
  }): void {
    if (this.isSessionOnScreen(input.sessionId)) { return; }
    const label = this.sessionLabel(input.sessionId);
    const sent = this.notifier.notify({ ...input, label });
    // The persisted log is the debugging entry point (docs/dev-workflow.md): "did we
    // notify, and about what" must be answerable without a screenshot. The wording
    // itself is `composeNotice`'s; this line carries the identity.
    log(`${LOG_PREFIX}: notify ${input.kind} ${input.sessionId} ${sent ? 'sent' : 'duplicate'} (${label})`);
  }

  /**
   * "Claude Code · 修复登录 bug" — the same fallback chain `toSummary` uses for the tab
   * title, so a session named after its first message is called the same thing in a
   * notification as in the strip (078/164).
   */
  private sessionLabel(sessionId: string): string {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return sessionId.slice(0, 8); }
    const title = this.sessionTitles.get(sessionId)
      || session.title
      || this.sessionManager.getHistoryStore()?.get(session.agentName, sessionId)?.firstPrompt
      || '';
    return title ? `${session.agentDisplayName} · ${title}` : session.agentDisplayName;
  }

  // 轮次之外的 agent 工作（后台子任务）。
  //
  // 现象（用户报）：任务还在跑（在等子 agent），发送按钮却已经变回普通状态。
  // 根因：`running` 只由"`session/prompt` 请求还没返回"决定，而后台子任务**在轮次结束后继续
  // 干活**——轮次一结束，面板就让它看起来"空闲"了。
  //
  // 状态机（三条进出条件都要求**有证据**，不猜）：
  // · 进入：某个 tool call 的 `rawInput.run_in_background` 为真 —— 这是 agent 明说"我在后台
  // 起了个任务"，也是唯一能提前知道的信号（轮次还在飞时就要记下来，因为任务会比轮次活得久）；
  // · 保持：该会话还有**产出型**通知（助手/思考分片、工具调用/更新）⇒ 看门狗重新武装；
  // · 退出：① 收到 `<task-notification>` 注入块（后台任务汇报完毕，109 已经在处理这类块）
  // ② 新轮次开始（轮次自己就报告 running）③ 看门狗超时 —— 此刻**发一条通知**再恢复：
  // 静默地变回"可以发消息"正是用户看到的那种"没人告诉我发生了什么"。

  /**
   * [CUSTOM- This session keeps working outside the turn: stay "running"
   * until it reports back or goes quiet (see the block above).
   */
  private noteBackgroundTask(sessionId: string, reason: string): void {
    const existing = this.backgroundTasks.get(sessionId);
    if (existing) { clearTimeout(existing); }
    this.backgroundTasks.set(sessionId, setTimeout(
      () => this.endBackgroundTask(sessionId, 'quiet'),
      this.backgroundQuietMs,
    ));
    if (existing) { return; }
    log(`${LOG_PREFIX}: session ${sessionId} keeps running outside the turn (${reason})`);
    this.refreshSessions();
  }

  /** Stop waiting on background work (cause is for the log; `quiet` also notifies). */
  private endBackgroundTask(sessionId: string, cause: 'reported' | 'quiet' | 'turn' | 'closed'): void {
    const timer = this.backgroundTasks.get(sessionId);
    if (!timer) { return; }
    clearTimeout(timer);
    this.backgroundTasks.delete(sessionId);
    log(`${LOG_PREFIX}: session ${sessionId} is no longer waiting on background work (${cause})`);
    this.refreshSessions();
    if (cause === 'quiet') {
      // The wait is over, but not silently: "the button came back and nobody said why"
      // is exactly the experience this whole state exists to remove.
      this.notifySession({
        kind: 'background-stalled',
        sessionId,
        token: String(Date.now()),
        detail: `已 ${Math.round(this.backgroundQuietMs / 1000)} 秒没有输出`,
      });
    }
  }

  /** [CUSTOM- "running" for the summary: a turn in flight OR background work. */
  private isSessionRunning(sessionId: string): boolean {
    return this.sessionManager.isTurnInFlight(sessionId) || this.backgroundTasks.has(sessionId);
  }

  /**
   * [CUSTOM- 关闭一个会话。2026-10-29：运行中会话的二次确认改由客户端负责
   * （`html/client/tabs.ts` 的 closeModel → NS.popover.confirm）——触发点是面板里的
   * ×/中键/右键/Delete，不需要宿主 modal 挡住整个窗口。这里仍走 closeSession：
   * 它在 `session/close` 之前先 `cancelTurn`，并保证待决的权限/表单请求被回答（ACP 契约）。
   */
  private async closeSession(agentName: string, sessionId: string): Promise<void> {
    try {
      await this.sessionManager.closeSession(agentName, sessionId);
    } catch (e) {
      this.reportError(sessionId, e);
    }
  }

  /**
   * [CUSTOM- Clicking a notification: bring that session up.
   *
   * `force` is the established way to focus a session the host already considers
   * active (080/087) — without it the focus event never fires and the panel would
   * stay where it was. A visible surface is raised WITH focus (this is an explicit
   * user action, unlike canPresent's reveal); with no surface at all, the sidebar
   * is opened through the same command extension.ts already uses.
   */
  private revealSession(sessionId: string, label: string): void {
    if (!this.sessionManager.getSession(sessionId)) {
      // The notification outlived its session (it was closed meanwhile). Silence
      // here would look like a dead button (pitfall #29).
      log(`${LOG_PREFIX}: notification clicked for a session that is gone (${sessionId})`);
      return;
    }
    log(`${LOG_PREFIX}: notification clicked — revealing ${label} (${sessionId})`);
    this.sessionManager.focusSession(sessionId, { force: true });
    const surface = this.activeSurface();
    if (surface) { surface.reveal(false); return; }
    void vscode.commands.executeCommand('vac-chat.focus');
  }

  // PermissionPresenter + ElicitationPresenter 共用
  // 这一对方法（两个接口的方法名相同，所以实现必须收一个联合类型再按形状分派；
  // 写两个同名方法在 TS 里是重复实现，编译不过）。canPresent 也共用同一套判据。
  show(state: PermissionState | ElicitationState): void {
    // [CUSTOM- This session goes from "the agent is working" to "nothing
    // moves until you answer", and the tab dot has to say so. The bridge has already put
    // the request in its pending list by the time it calls this (see PermissionBridge.show).
    this.refreshSessions();
    if (isElicitationState(state)) { this.showElicitation(state); return; }
    const session = sessionOf(this.sessionManager, state.sessionId);
    if (!session) {
      // [CUSTOM- Reachable for a request whose session went away in the
      // same tick; silence here would be a request nobody ever heard about (#29).
      log(`${LOG_PREFIX}: permission prompt for unknown session ${state.sessionId} (dropped)`);
      return;
    }
    this.transcripts.ensureSession(state.sessionId, session.agentName);
    const entry = this.transcripts.appendPermission(state.sessionId, state);
    if (entry) { this.post({ type: 'append', sessionId: state.sessionId, entries: [entry] }); }
    // [CUSTOM- Not on screen ⇒ tell the user (the record is there for
    // when they jump over; the notification is the way they learn about it).
    this.notifySession({ kind: 'waiting-permission', sessionId: state.sessionId, token: state.promptId, detail: state.title });
  }

  update(state: PermissionState | ElicitationState): void {
    // [CUSTOM- …and here it may go back (the bridge removes the request from
    // its pending list BEFORE calling this — see settleWith). A mere state change on a
    // card leaves the pending list alone, and the signature check makes this free.
    this.refreshSessions();
    if (isElicitationState(state)) { this.updateElicitation(state); return; }
    // appendPermission returns the existing entry for this promptId (after
    // applying the new state), so `patch` below only needs to tell the webview.
    const entry = this.transcripts.appendPermission(state.sessionId, state);
    if (!entry) { return; }
    this.post({ type: 'revise', sessionId: state.sessionId, entryId: entry.id, patch: { permission: state } });
  }

  // 表单卡的 presenter。与权限卡逐条同构：
  // 卡是 transcript 的一条记录（所以 boot/focus 的全量快照天然能把它带回来——重开面板、
  // 切走再切回、两个 surface 切换都不需要额外机制），回答走 elicitationAnswer 消息。
  showElicitation(state: ElicitationState): void {
    const session = sessionOf(this.sessionManager, state.sessionId);
    if (!session) {
      // [CUSTOM- Same reasoning as the permission branch above.
      log(`${LOG_PREFIX}: form for unknown session ${state.sessionId} (dropped)`);
      return;
    }
    this.transcripts.ensureSession(state.sessionId, session.agentName);
    const entry = this.transcripts.appendElicitation(state.sessionId, state);
    if (entry) { this.post({ type: 'append', sessionId: state.sessionId, entries: [entry] }); }
    // [CUSTOM- "会话等待选项确认" —— 与权限同一条通知纪律。
    this.notifySession({ kind: 'waiting-form', sessionId: state.sessionId, token: state.promptId, detail: state.message });
  }

  updateElicitation(state: ElicitationState): void {
    const entry = this.transcripts.appendElicitation(state.sessionId, state);
    if (!entry) { return; }
    this.post({ type: 'revise', sessionId: state.sessionId, entryId: entry.id, patch: { elicitation: state } });
  }

  // --- Tool views () ------------------------------------

  /**
   * The client reported a tool card with no view model.
   *
   * This is the recovery path for a card that was placed before its view model
   * existed (a bare `.tool` shell that `updateTool` used to be unable to repair).
   * If the invocation is genuinely gone there is nothing to send — but the log
   * line is the answer to "why is this card empty", which used to be invisible
   * (it only produced a `console.warn` inside the webview console).
   */
  private resendToolView(sessionId: string, entryId: string, toolCallId: string, to: SurfaceKey): void {
    const inv = toolCallId ? this.tools.get(sessionId, toolCallId) : undefined;
    if (!inv) {
      log(`${LOG_PREFIX}: client asked for the view of tool ${toolCallId || '(no id)'} in ${sessionId} but the invocation is not in the store (entry ${entryId})`);
      return;
    }
    log(`${LOG_PREFIX}: resending view for tool ${toolCallId} (client had none for entry ${entryId})`);
    // Targeted at the surface that asked: the other one already has it, and an
    // unnecessary toolUpdate would be a visual no-op anyway.
    this.post({ type: 'toolUpdate', sessionId, entryId, tool: toToolCallView(inv) }, to);
  }

  // --- Panel entry points: connect + history () ------

  /** Falls back to the panel's own agent when nothing is focused. */
  /**
   * [CUSTOM- Is the panel's agent connected right now?
   *
   * The empty state has to know. "No session yet — connect an agent" is WRONG once the
   * agent is already running: the panel can be sessionless with a live process (closing
   * the last session keeps the process; only `disconnectAgent` stops it), and its Connect
   * button then offers to do something that has already been done. Sent with every message
   * that can change what the empty state shows (boot / focus / sessionsChanged).
   */
  private panelAgentConnected(): boolean {
    const agent = this.panelAgent();
    return !!agent && this.sessionManager.isAgentConnected(agent);
  }

  private panelAgent(preferred?: string): string | null {
    if (preferred) { return preferred; }
    if (this.focused.agentName) { return this.focused.agentName; }
    return primaryAgentName() ?? null;
  }

  /** Workspace folder used to scope the local history cache, when there is one. */
  private workspaceCwd(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /**
   * [CUSTOM- 面板一出现就把 agent 拉起来，不等 webview 渲染完再回一句 connectAgent。
   *
   * 首次连接慢在 npx 冷启动（真机日志里 initialize 花了 36s），而面板打开到发 connectAgent
   * 之间还隔着一整轮 HTML 渲染 + 1s 自动连接延时 —— 这段时间完全可以和 npx 重叠。
   * 只预热连接、**不建会话**：有可恢复会话时仍由空态卡片先问用户（同 handleConnectAgent）。
   * 失败不在这里报错：真正的连接流程会重试一次，并把原因显示在状态卡上。
   */
  prewarm(): void {
    if (!this.prefs.getAutoConnect()) { return; }
    const agent = this.panelAgent();
    if (!agent) { return; }
    // 已经有活的会话/连接 ⇒ ensureConnected 会直接命中缓存，这里只是省一次日志噪声。
    if (this.sessionManager.getSessionIdsForAgent(agent).length > 0) { return; }
    const startedAt = Date.now();
    log(`${LOG_PREFIX}: prewarming ${agent} while the panel renders`);
    void this.sessionManager.ensureConnected(agent)
      .then(() => log(`${LOG_PREFIX}: prewarm connected in ${Date.now() - startedAt}ms`))
      .catch(e => log(`${LOG_PREFIX}: prewarm failed after ${Date.now() - startedAt}ms: ${(e as any)?.message ?? String(e)}`));
  }

  /**
   * [CUSTOM- "Connect" button.
   *
   * [CUSTOM- Now means "make sure the process is up, then hand back
   * to the client": the client opens a DRAFT, and the session is created on the
   * first message. Creating one here (as `connectToAgent` does when none exists)
   * would leave an empty session in the agent's history for a user who only
   * wanted to check that the agent starts — and `session/close` does not remove
   * it again. The connectivity feedback the button exists for is preserved
   * because `ensureConnected` still throws when the process will not start.
   *
   * If sessions already exist, the newest is focused (reuse, not pile up).
   *
   * [CUSTOM- Every outcome now answers with a `connection` phase.
   * The client's "Connecting…" is driven by it, and it is the ONLY signal that
   * can end that phase: `refreshSessions` de-dups on a signature whose `conn:` bit
   * is already 1 when the process is up, and `ensureConnected` emits nothing in
   * that case — so a user with a live process and no session would otherwise be
   * stuck on "Connecting…" forever (pitfall #29).
   */
  private handleConnectAgent(agentName?: string): void {
    const agent = this.panelAgent(agentName);
    if (!agent) {
      // Answer anyway: without it the client never leaves the connecting phase.
      this.postConnection('failed', 'No agent available to connect.');
      this.reportError(null, new Error('No agent available to connect.'));
      return;
    }
    log(`${LOG_PREFIX}: connect requested for ${agent}`);
    const startedAt = Date.now();
    this.postConnection('connecting');
    void this.sessionManager.ensureConnected(agent)
      .then(async () => {
        // [CUSTOM- 把"慢在哪一段"写进日志：spawn+npx+initialize 与 session/new 分开计时。
        log(`${LOG_PREFIX}: ${agent} initialized in ${Date.now() - startedAt}ms`);
        const ids = this.sessionManager.getSessionIdsForAgent(agent);
        const newest = ids[ids.length - 1];
        if (newest) {
          this.sessionManager.focusSession(newest);
        } else {
          // [CUSTOM- 有可恢复的会话就先别建新的：面板停在空态卡片上问一句
          // 「要不要恢复上次那几个」。用户选「开始新的」时会再发一次 connectAgent
          // （那时快照已被丢弃），于是照旧走到下面 createSession —— 也就是"保持现在的逻辑"。
          const recoverable = this.recoverableSessions();
          if (recoverable.length > 0) {
            log(`${LOG_PREFIX}: ${recoverable.length} session(s) are restorable — asking before creating a new one`);
          } else {
            // [CUSTOM- No session yet: CREATE one, and do it before reporting
            // the phase. A draft page can never be "the same as a normal session" — images
            // need a session to attach to, and the mode/model pickers come from the
            // `session/new` response, so without a session there is nothing to show. The
            // cost is a session left in the agent's history if the user connects and walks
            // away; `session/close` does not remove it from history (058), and that is the
            // trade the user chose over a half-usable composer.
            await this.sessionManager.createSession(agent, { focus: true });
            log(`${LOG_PREFIX}: ${agent} session ready in ${Date.now() - startedAt}ms`);
          }
        }
        // [CUSTOM- 'connected' goes out AFTER the focus/creation above, and the
        // order is load-bearing: the client opens a draft on 'connected' only when no
        // session is focused, so an inversion would hand the user a spare tab next to the
        // session that was just opened.
        this.postConnection('connected');
      })
      .catch(e => {
        this.postConnection('failed', (e as any)?.message ?? String(e));
        this.reportError(null, e);
      });
  }

  /** [CUSTOM- Broadcast one connection attempt's phase. */
  private postConnection(state: 'connecting' | 'connected' | 'failed', message?: string, detail?: string): void {
    // [CUSTOM- `connecting` 期间 agent 的 stderr 会以 detail 的形式跟着这条消息下发
    // （见 noteAgentStderr）—— 用户卡在连接界面时，那几行才是"为什么"。
    this.connecting = state === 'connecting';
    const payload: Record<string, unknown> = { type: 'connection', state };
    if (message) { payload.message = message; }
    if (detail) { payload.detail = detail; }
    this.post(payload as never);
  }

  /**
   * [CUSTOM- agent 进程的 stderr：**只在连接中**转发给面板。
   *
   * 起因：用户报"一直卡在连接界面"。日志里真相很清楚 —— npx 在下载新版本适配器
   * （`The following package was not found and will be installed: …`），而 `initialize` 要等它；
   * 可那几行只进了日志，卡片上永远只有一句 "Connecting…"，用户无从判断是在下载还是死了。
   * 连接建立之后 stderr 就是噪声（各种无关 warn），所以那时不再往卡片上灌。
   */
  private noteAgentStderr(line: string): void {
    if (!this.connecting) { return; }
    const text = String(line ?? '').trim().slice(0, 160);
    if (!text) { return; }
    this.postConnection('connecting', undefined, text);
  }

  /**
   * [CUSTOM- Persist the start card's switch, then answer with whatever the
   * setting ACTUALLY holds — including when the write failed. Echoing the requested value
   * back would leave the checkbox showing something settings.json does not say, which is
   * the same lie the configuration listener exists to prevent.
   */
  private async handleSetAutoConnect(value: boolean): Promise<void> {
    try {
      await this.prefs.setAutoConnect(value);
    } catch (e) {
      log(`${LOG_PREFIX}: could not write ${AUTO_CONNECT_KEY}: ${String(e)}`);
    }
    this.postAutoConnectPref();
  }

  /** [CUSTOM- Tell every surface what the setting currently says. */
  /** [CUSTOM- 卡片上那个「记住我的选择」写回来的值（走 prefs 注入缝，同 autoConnect）。 */
  private async handleSetRestorePref(value: unknown): Promise<void> {
    const choice = resolveRestoreChoice(value);
    try {
      await this.prefs.setRestore(choice);
    } catch (e) {
      log(`${LOG_PREFIX}: could not write ${RESTORE_KEY}: ${String(e)}`);
    }
    this.postRestorePref();
  }

  private postAutoConnectPref(): void {
    this.post({ type: 'autoConnectPref', value: this.prefs.getAutoConnect() });
  }

  /**
   * [CUSTOM- History picker contents for one agent.
   *
   * Source order matters: **the local cache first when the agent is not
   * connected**, because `sessionManager.listSessions` calls `ensureConnected`
   * and would spawn an agent process just to render a menu. Once it IS connected
   * the agent-side list wins: it is authoritative and includes sessions this
   * window never saw.
   */
  private async handleListHistory(agentName?: string, cwd?: string): Promise<void> {
    const agent = this.panelAgent(agentName);
    // [CUSTOM- The client's address-bar directory, when it sent one. It is
    // what the filter's default is derived from (see postHistory); an empty or missing
    // value falls back to the host-side guess, which keeps older clients working.
    const askedCwd = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : undefined;
    if (!agent) {
      this.post({ type: 'history', agentName: '', sessions: [], source: 'local', error: 'No agent selected.' });
      return;
    }

    const connected = this.sessionManager.isAgentConnected(agent);
    const caps = this.sessionManager.getCachedCapabilities(agent);
    const local = (): Array<Omit<HistorySessionSummary, 'dirKey'>> => {
      const entries = this.sessionManager.getHistoryStore()?.list(agent, this.workspaceCwd()) ?? [];
      // [CUSTOM- Live sessions are no longer hidden — the current
      // session should appear in the picker too (clicking it just re-focuses).
      return entries
        .map(e => ({
          sessionId: e.sessionId,
          title: e.title ?? e.firstPrompt ?? null,
          cwd: e.cwd,
          updatedAt: e.lastActiveAt,
          // [CUSTOM- Marked here (the merge no longer invents the mark): a
          // row only the cache knows about may be gone agent-side, and the client says so.
          fromCache: true,
        }));
    };

    try {
      if (connected && caps?.list) {
        const response = await this.sessionManager.listSessions(agent);
        const fromAgent = response.sessions
          .map(s => {
            const info = s as { sessionId?: unknown; title?: unknown; cwd?: unknown; updatedAt?: unknown };
            const sessionId = String(info.sessionId ?? '');
            // 历史列表 agent 侧缺 title 时回退本地缓存的 title/firstPrompt。
            const stored = this.sessionManager.getHistoryStore()?.get(agent, sessionId);
            const title = typeof info.title === 'string'
              ? info.title
              : (stored?.title ?? stored?.firstPrompt ?? null);
            return {
              sessionId,
              title,
              cwd: typeof info.cwd === 'string' ? info.cwd : undefined,
              updatedAt: typeof info.updatedAt === 'string' ? info.updatedAt : undefined,
            };
          });
        // [CUSTOM- UNION with the local cache instead of replacing it.
        // The agent's `session/list` is not the whole truth: it omits sessions that are
        // still OPEN in another Claude Code window (measured — see
        // scripts/probe-session-list.mjs: 227 sessions listed, none
        // without a cwd, and two of this workspace's eight absent). A session this
        // workspace opened earlier lives in OUR cache regardless, so the union is what
        // makes "the list I saw before" and "the list I see now" agree.
        // [CUSTOM- …and with the agent's own transcript directory, which is
        // the only source that also covers sessions this workspace never opened (the
        // official Claude Code panel reads exactly that directory).
        this.postHistory(agent, 'merged', mergeHistoryRows(fromAgent, await this.readDiskHistory(agent), local()), askedCwd);
        return;
      }
      // Not connected: the cache plus (for Claude Code) the transcripts on disk.
      this.postHistory(agent, 'merged', mergeHistoryRows(await this.readDiskHistory(agent), local()), askedCwd);
    } catch (e: any) {
      // An agent-side failure still has the cache as a usable answer.
      this.postHistory(agent, 'local', local(), askedCwd,
        `Could not query the agent (${e?.message ?? e}); showing the local cache.`);
    }
  }

  /**
   * [CUSTOM- Rows recovered from the agent's OWN transcript directory.
   *
   * Only for Claude Code (that storage is a vendor detail — see diskSessions.ts), only for
   * the current workspace folder (the same scope the local cache uses), and never fatal:
   * every failure degrades to "no supplement", because this is an addition to the agent's
   * list, not a replacement for it.
   *
   * [CUSTOM- `cwd` overrides the scan directory — the history picker's
   * directory filter asks for the folder it is showing, which may be any folder the
   * agent lists (not just `workspaceFolders[0]`).
   */
  private async readDiskHistory(agent: string, cwd?: string): Promise<Array<Omit<HistorySessionSummary, 'dirKey'>>> {
    const dirCwd = cwd ?? this.workspaceCwd();
    if (!dirCwd) { return []; }
    const dir = transcriptDirFor(agent, dirCwd);
    if (!dir) { return []; }
    try {
      const rows = await readDiskSessions(dir, dirCwd);
      log(`${LOG_PREFIX}: transcript supplement ${rows.length} rows from ${dir}`);
      return rows
        // [CUSTOM- Keep live sessions in the list (deduped by the merge);
        // still drop rows without a cwd — they cannot be filtered or reopened.
        .filter(r => !!r.cwd)
        .map(r => ({
          sessionId: r.sessionId,
          title: r.title ?? null,
          cwd: r.cwd,
          updatedAt: r.updatedAt,
          fromDisk: true,
        }));
    } catch (e) {
      log(`${LOG_PREFIX}: transcript supplement failed (ignored): ${(e as Error)?.message ?? e}`);
      return [];
    }
  }

  /**
   * [CUSTOM- Scan the transcript directory of ONE folder the picker's
   * filter selected, and hand back only the disk rows — as an INCREMENT, so the client
   * merges them without a full `history` replacement (which would reset the filter).
   */
  private async handleSupplementHistory(agentName: string | undefined, cwd: string): Promise<void> {
    const agent = this.panelAgent(agentName);
    if (!agent || !cwd) { return; }
    const rows = await this.readDiskHistory(agent, cwd);
    if (rows.length === 0) { return; }
    // [CUSTOM- 补扫也会带回归档过的行（磁盘转录不认我们的账）——同一个出口
    // 同一套过滤/覆盖，别让归档在"补扫"这条路上漏回来。
    const supplementLabels = this.sessionLabels();
    const sessions: HistorySessionSummary[] = rows
      .filter(s => !supplementLabels[s.sessionId]?.archived)
      .map(s => {
        const dirKey = directoryKey(s.cwd);
        const titled = supplementLabels[s.sessionId]?.title
          ? { ...s, title: supplementLabels[s.sessionId].title } : s;
        return dirKey ? { ...titled, dirKey } : titled;
      });
    this.post({ type: 'historySupplement', agentName: agent, cwd, sessions });
  }

  // 会话的本地覆盖（改名 / 归档）——读、写、改名流程。
  private sessionLabels(): Record<string, SessionLabelOverride> {
    return this.globalState?.get<Record<string, SessionLabelOverride>>(SESSION_LABELS_KEY) ?? {};
  }

  /** 覆盖标题；没有覆盖时返回 undefined，调用方继续走原来的回退链。 */
  private sessionLabelTitle(sessionId: string): string | undefined {
    const t = this.sessionLabels()[sessionId]?.title;
    return t ? t : undefined;
  }

  private async updateSessionLabel(sessionId: string, patch: SessionLabelOverride): Promise<void> {
    if (!this.globalState) { return; }
    const all = this.sessionLabels();
    await this.globalState.update(SESSION_LABELS_KEY, {
      ...all,
      [sessionId]: { ...(all[sessionId] ?? {}), ...patch },
    });
  }

  /**
   * 真删除一条会话（历史列表行的 Delete）。比 Archive 重：Archive 只是本地收起，这一步
   * 会向 agent 发 `session/delete` 并清掉本地缓存，**不可撤销**。
   *
   * 2026-10-29：二次确认改由客户端负责（`html/client/popover.ts` 的非模态浮层）——
   * 触发点就在历史列表里，不必用宿主 modal 挡住整个 IDE。宿主收到这条消息时用户已经确认过。
   * 做完回一条 `sessionAction {action:'delete'}`，列表据此摘掉那行（与 Archive 同一对账路径）。
   */
  private async handleDeleteSession(agentName: string, sessionId: string): Promise<void> {
    try {
      await this.sessionManager.deleteSession(agentName, sessionId);
      this.post({ type: 'sessionAction', action: 'delete', sessionId });
    } catch (e) {
      this.reportError(sessionId, e);
    }
  }

  /**
   * 改名：客户端带 `title` 时直接应用（2026-10-29：面板内输入浮层，不再弹宿主
   * InputBox）；缺省时保留原生输入框兜底。做完回一条 `sessionAction`。
   * 清空 / 取消都当"没改"——清空意味着"回到原始标题"，而那需要知道这条行的底层标题
   * （agent 的 / 缓存的 / 磁盘的都可能），列表这边拿不到它。宁可不动，也不猜。
   */
  private async handleRenameSession(sessionId: string, currentTitle: string, title?: string): Promise<void> {
    let next = title;
    if (next === undefined) {
      next = await vscode.window.showInputBox({
        title: 'Rename Session',
        prompt: 'New name for this session',
        value: currentTitle,
      });
    }
    if (next === undefined || next.trim() === '') { return; }
    const clean = next.trim();
    await this.updateSessionLabel(sessionId, { title: clean });
    this.post({ type: 'sessionAction', action: 'rename', sessionId, title: clean });
    // 开着这条会话的 tab / 树也要换名字：toSummary 的 title 链已插了覆盖，推一把让
    // 客户端拿到新的 sessionsChanged（签名里含 title，所以不会被去重掉）。
    this.refreshSessions();
  }

  /**
   * [CUSTOM- The ONE place a `history` reply is assembled.
   *
   * It exists because a reply now carries derived data as well as the rows: the
   * directory identity of every row and the filter's candidate directories. Three
   * reply paths (agent list, local cache, cache-after-error) each building that by
   * hand is how one of them ends up without a `dirKey` — the failure mode would be
   * rows that silently vanish from a filtered list.
   */
  private postHistory(
    agent: string,
    source: 'agent' | 'local' | 'merged',
    sessions: Array<Omit<HistorySessionSummary, 'dirKey'>>,
    currentCwd?: string,
    error?: string,
  ): void {
    // [CUSTOM- 本地覆盖在**唯一装配点**落地：归档的整行滤掉，改过名的换标题
    // （覆盖优先于任何来源的标题）。
    const labels = this.sessionLabels();
    const rows: HistorySessionSummary[] = sessions
      .filter(s => !labels[s.sessionId]?.archived)
      .map(s => {
        const dirKey = directoryKey(s.cwd);
        const titled = labels[s.sessionId]?.title ? { ...s, title: labels[s.sessionId].title } : s;
        return dirKey ? { ...titled, dirKey } : titled;
      });
    this.post({
      type: 'history',
      agentName: agent,
      source,
      sessions: rows,
      // [CUSTOM- `currentCwd` is the CLIENT's address-bar directory when it
      // sent one; the host-side guess is the fallback.
      directories: directoryOptions(rows, currentCwd ?? this.historyFilterCwd(agent)),
      ...(error ? { error } : {}),
    });
  }

  /**
   * [CUSTOM- The directory the history filter defaults to.
   *
   * [CUSTOM- Now only the FALLBACK (see postHistory): the panel's client
   * sends the directory its address bar is showing, which is the correct answer on a
   * draft page (drafts are client-local, 058) and is what the user actually sees. This
   * guess stays for callers that send none.
   *
   * The focused session's OWN directory, when that session belongs to the agent
   * being listed — the picker is per-agent and the focused session may belong to a
   * different one. Otherwise the first workspace folder. Undefined means "no
   * default": the client then opens the list unfiltered, which is the honest answer
   * for a session that has no directory yet (a draft).
   */
  private historyFilterCwd(agent: string): string | undefined {
    const focused = this.focused.sessionId
      ? sessionOf(this.sessionManager, this.focused.sessionId)
      : undefined;
    if (focused && focused.agentName === agent && focused.cwd) { return focused.cwd; }
    return this.workspaceCwd();
  }

  /** [CUSTOM- Open a session from the picker (load, else resume). */
  private async handleOpenHistorySession(
    agentName: string,
    sessionId: string,
    cwd?: string,
    title?: string,
    fromDraft = false,
    // [CUSTOM- 恢复上次的会话：**保留**其它已打开的会话（099 的"替换语义"是给历史
    // 选择器用的 —— 那是导航，不该越点越多；恢复则相反，它就是要多开）。
    keepOthers = false,
  ): Promise<void> {
    const agent = this.panelAgent(agentName);
    if (!agent || !sessionId) { return; }
    log(`${LOG_PREFIX}: opening history session ${sessionId} of ${agent}${cwd ? ` (cwd ${cwd})` : ''}`);
    try {
      // [CUSTOM- Picking from the history list SWITCHES the panel, it does
      // not pile up another tab: the currently focused session steps aside so the picked
      // one takes its place. Reported as "每次选历史都多开一个 tab" — the strip grew by
      // one on every visit, which is not what a history list means.
      //
      // Nothing is destroyed by this: the session stepping aside is still in the agent's
      // own history AND on disk, so the very same list reopens it later (that is the whole
      // point of §5.14/§5.24). A session that is ALREADY live keeps its tab — there is
      // nothing to replace, the pick is just a focus change.
      //
      // [CUSTOM- `fromDraft`: the CLIENT asked while sitting on a draft page.
      // That draft is what should step aside — not the focused SESSION, which the host
      // still holds (a draft is client-local, 058, so the host's `focused` names some
      // other session). The client discards its draft itself.
      const alreadyLive = !!this.sessionManager.getSession(sessionId);
      const current = this.focused.sessionId ? this.sessionManager.getSession(this.focused.sessionId) : undefined;
      if (!alreadyLive && !fromDraft && !keepOthers && current && current.sessionId !== sessionId) {
        try {
          await this.sessionManager.closeSession(current.agentName, current.sessionId);
        } catch (e) {
          // A failed teardown must not block the session the user asked for.
          log(`${LOG_PREFIX}: could not close ${current.sessionId} before switch (${String(e)})`);
        }
      }
      // [CUSTOM- Real per-message times, read before the replay starts
      // (the notifications arrive synchronously once it does).
      await this.preloadTranscriptTimes(agent, sessionId, cwd);
      // [CUSTOM- Pass the session's OWN directory. The picker shows
      // sessions from other directories (the agent-side list spans them), and
      // without this the agent was told the current workspace instead — so a
      // session belonging elsewhere was reopened as if it lived here.
      // [CUSTOM- The title too: the replay does not always re-send
      // session_info_update, so without it the tab would show the id prefix.
      const how = await this.sessionManager.openExistingSession(agent, sessionId, { cwd, title });
      if (how === 'resume') {
        const entry = this.transcripts.appendNotice(sessionId, 'info',
          'Resumed without replaying history (this agent does not support session/load).');
        if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
      }
    } catch (e) {
      this.reportError(null, e);
    }
  }

  // --- Draft page: directory choices + create-on-first-send (058) ----------

  /** How many recent directories the picker offers (user-configurable; keeps the drawer scannable). */
  private static readonly DEFAULT_RECENT_DIRECTORIES = 8;

  /** 「Recently used」的条数范围；0 = 不显示该分组。 */
  private static readonly RECENT_DIRECTORIES_MIN = 0;
  private static readonly RECENT_DIRECTORIES_MAX = 30;

  /**
   * 条数的唯一夹紧口（读取 / 回显 / 写入共用）。空串与空白视为「没填」→ 默认值：
   * `Number('') === 0`，直接交给 clampNumber 会把清空输入框静默解释成 0（隐藏分组）。
   */
  private static clampRecentDirectories(value: unknown): number {
    if (value === undefined || value === null
      || (typeof value === 'string' && value.trim() === '')) {
      return ChatPanelHost.DEFAULT_RECENT_DIRECTORIES;
    }
    return clampNumber(value, ChatPanelHost.RECENT_DIRECTORIES_MIN,
      ChatPanelHost.RECENT_DIRECTORIES_MAX, ChatPanelHost.DEFAULT_RECENT_DIRECTORIES);
  }

  /** 回放预渲染 markdown 的每片条数（一次几百条会变成宿主线程上的长任务）。 */
  private static readonly PREFILL_BATCH = 40;

  /** 会话安静多久之后补渲染 markdown（见 armSettlePrefill）。 */
  private static readonly SETTLE_PREFILL_MS = 600;

  private recentLimit(): number {
    return ChatPanelHost.clampRecentDirectories(this.uiPrefs?.recentDirectoryLimit);
  }

  // 草稿页的输入卡要"显示完整"（模式/模型/命令）。
  // 数据只能来自**该 agent 上一次会话**：模式/模型/可用命令在 ACP 里都是会话级的，而
  // `session/new` 没有 mode/model 入参（已核对 SDK 的 NewSessionRequest），草稿又还没有会话。
  // 所以这里按 agent 留一份"上次见到的快照"，草稿页拿它渲染、创建会话时再逐项校验后应用。
  /**
   * 记下某个会话当前的配置项与可用命令，作为该 agent 的草稿页快照。
   *
   * 调用点都挂在 SessionManager 的事件上（session-created / session-load-end /
   * config-options-changed / available-commands-changed），**不**挂 pushMeta —— 那个在
   * "没 surface attach"或"不是聚焦会话"时提前 return，后台会话的变化就进不来（而那正是下次
   * 点「+」要用的那份）。
   *
   * **空值不覆盖**：三条创建路径的时序并不一致，`[]` 常常只表示"这条路径还没填"而不是"这个
   * agent 没有"：
   * · `loadSession` 在建好 placeholder 后才把 `configOptions` 写回去（`session-created`
   * 早于它，且不走 `applyConfigOptions`）—— 所以这里还额外订阅了 `session-load-end`；
   * · `resumeSession` 的 `availableCommands` 恒为 `[]`（不重放），会把上一次好快照里的
   * 斜杠命令**清空**。
   * 一个陈旧的选项列表是无害的（应用时会逐项校验后跳过），而"快照退化"会让草稿页又变得不完整
   * —— 那正是这个功能要修的东西。空数组的代价则只是显示一个用不上、用不上就跳过的选项。
   */
  private rememberAgentOptions(sessionId: string): void {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }
    const previous = this.draftOptions.get(session.agentName);
    const configOptions = session.configOptions ?? [];
    const availableCommands = wireCommands(session);
    const next: AgentOptionSnapshot = {
      configOptions: configOptions.length > 0 ? configOptions : (previous?.configOptions ?? []),
      availableCommands: availableCommands.length > 0 ? availableCommands : (previous?.availableCommands ?? []),
    };
    const signature = JSON.stringify(next);
    if (previous && JSON.stringify(previous) === signature) { return; }
    this.draftOptions.set(session.agentName, next);
    // globalState 只在真的变了才写：这个函数会跟着会话的每一次配置项变化跑。
    const store: DraftOptionsStore = {};
    for (const [agentName, snapshot] of this.draftOptions) { store[agentName] = snapshot; }
    void this.globalState?.update(DRAFT_OPTIONS_KEY, store);
    log(`${LOG_PREFIX}: draft options for ${session.agentName}: ${next.configOptions.length} option(s), ${next.availableCommands.length} command(s)`);
  }

  /**
   * [CUSTOM- The mode the user just picked, remembered per agent.
   *
   * Only USER actions call this (the three setters below) — never an agent-reported
   * change: a mode the agent switched to on its own (plan mode activating itself) is
   * not a preference, and letting those in would make the "default" silently follow
   * whatever the last session happened to do.
   *
   * The value is read from the config option (`category === 'mode'`), never from
   * `session.modes.currentModeId` — 128's rule: the option is the authoritative copy,
   * the other is a mirror only `applyConfigOptions` writes.
   */
  private rememberUserMode(sessionId: string): void {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }
    const option = modeOptionOf(session.configOptions);
    if (!option) { return; }
    const value = String((option as { currentValue?: unknown }).currentValue ?? '');
    if (!value) { return; }
    const previous = this.lastMode.get(session.agentName);
    if (previous && previous.configId === option.id && previous.value === value) { return; }
    this.lastMode.set(session.agentName, { configId: option.id, value });
    const store: LastModeStore = {};
    for (const [agentName, mode] of this.lastMode) { store[agentName] = mode; }
    void this.globalState?.update(LAST_MODE_KEY, store);
    log(`${LOG_PREFIX}: remembered mode ${option.id}=${value} for ${session.agentName}`);
  }

  /**
   * [CUSTOM- Apply the remembered mode to a BRAND NEW session.
   *
   * Same three gates as a draft selection (the shape is deliberately the same — this
   * IS "the value the user chose, applied to a session that did not exist yet"):
   * the option must still be offered, the value must still be a candidate, and an
   * equal current value is skipped (no round trip, no chance for a spurious notice).
   *
   * Unlike a draft selection, a failure is logged and NOT announced in the record: a
   * default is not a request. The user never asked for this particular value here, so
   * a line about it failing would be noise about something they cannot see.
   */
  private async applyRememberedMode(sessionId: string): Promise<void> {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }
    const remembered = this.lastMode.get(session.agentName);
    if (!remembered) { return; }
    const option = (session.configOptions ?? []).find(o => o.id === remembered.configId);
    if (!option || (option as { category?: string }).category !== 'mode') {
      log(`${LOG_PREFIX}: remembered mode ${remembered.configId} is not offered by ${sessionId} (agent ${session.agentName}); skipped`);
      return;
    }
    if (String((option as { currentValue?: unknown }).currentValue ?? '') === remembered.value) { return; }
    const valid = option.type === 'boolean'
      ? remembered.value === 'true' || remembered.value === 'false'
      : selectValues(option).includes(remembered.value);
    if (!valid) {
      log(`${LOG_PREFIX}: remembered mode value ${remembered.value} is no longer a candidate; skipped`);
      return;
    }
    try {
      await this.sessionManager.setConfigOption(sessionId, remembered.configId, remembered.value);
      // Seed the switch baseline: our own setter has already written the authoritative
      // copy, so the agent's next notification about the same state diffs to nothing.
      // Without it the application would be announced as a switch the user never made
      // (the same trap applyDraftSelections documents at length).
      const state = this.choiceState(sessionId);
      if (state) { this.choices.set(sessionId, state); }
      this.pushMeta(sessionId);
      log(`${LOG_PREFIX}: applied remembered mode ${remembered.configId}=${remembered.value} to ${sessionId}`);
    } catch (e: any) {
      log(`${LOG_PREFIX}: applying the remembered mode failed (ignored): ${e?.message ?? e}`);
    }
  }

  /**
   * [CUSTOM- Wait for the mode application `session-created` kicked off.
   *
   * The draft page must run its OWN selections after the default: both land as
   * `session/set_config_option` on one connection, and the one that arrives last wins
   * — the user's explicit pick may not be overwritten by a default.
   */
  private async awaitModeApply(sessionId: string): Promise<void> {
    const pending = this.modeApply.get(sessionId);
    this.modeApply.delete(sessionId);
    if (pending) { await pending; }
  }

  /**
   * [CUSTOM- 把设置面板里的「默认模型」套用到新建会话（2026-10-21）。
   * 与记住的模式同一组门槛：选项还在、值仍是候选、相同就跳过；失败只记日志，不打扰用户。
   */
  private async applyRememberedModel(sessionId: string): Promise<void> {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }
    const modelId = this.uiPrefs?.defaultModelByAgent?.[session.agentName];
    if (!modelId) { return; }
    const option = (session.configOptions ?? []).find(
      o => (o as { category?: string }).category === 'model',
    ) as { id?: string; currentValue?: unknown; options?: unknown } | undefined;
    if (!option || typeof option.id !== 'string') {
      log(`${LOG_PREFIX}: default model ${modelId} is not offered by ${sessionId} (agent ${session.agentName}); skipped`);
      return;
    }
    if (String(option.currentValue ?? '') === modelId) { return; }
    const values = selectValues(option as SessionConfigOption);
    const custom = this.customModels().some(model => model.modelId === modelId);
    if (!values.includes(modelId) && !custom) {
      log(`${LOG_PREFIX}: default model ${modelId} is no longer a candidate; skipped`);
      return;
    }
    try {
      await this.sessionManager.setConfigOption(sessionId, option.id, modelId);
      const state = this.choiceState(sessionId);
      if (state) { this.choices.set(sessionId, state); }
      this.pushMeta(sessionId);
      log(`${LOG_PREFIX}: applied default model ${option.id}=${modelId} to ${sessionId}`);
    } catch (e: any) {
      log(`${LOG_PREFIX}: applying the default model failed (ignored): ${e?.message ?? e}`);
    }
  }

  /**
   * [CUSTOM- 把设置面板里的「默认推理强度」套用到新建会话（2026-10-27）。
   * 推理强度在 ACP 里就是 category === 'thought_level' 的 config option
   * （Claude 的 Effort / Codex 的 reasoning_effort 都是这个类目），所以与默认模型同一组门槛：
   * 选项还在、值仍是候选、相同就跳过；失败只记日志，不打扰用户。
   */
  private async applyRememberedEffort(sessionId: string): Promise<void> {
    const session = sessionOf(this.sessionManager, sessionId);
    if (!session) { return; }
    const effort = this.uiPrefs?.defaultEffortByAgent?.[session.agentName];
    if (!effort) { return; }
    const option = (session.configOptions ?? []).find(
      o => (o as { category?: string }).category === 'thought_level',
    ) as { id?: string; currentValue?: unknown; options?: unknown } | undefined;
    if (!option || typeof option.id !== 'string') {
      log(`${LOG_PREFIX}: default effort ${effort} is not offered by ${sessionId} (agent ${session.agentName}); skipped`);
      return;
    }
    if (String(option.currentValue ?? '') === effort) { return; }
    if (!selectValues(option as SessionConfigOption).includes(effort)) {
      log(`${LOG_PREFIX}: default effort ${effort} is no longer a candidate; skipped`);
      return;
    }
    try {
      await this.sessionManager.setConfigOption(sessionId, option.id, effort);
      const state = this.choiceState(sessionId);
      if (state) { this.choices.set(sessionId, state); }
      this.pushMeta(sessionId);
      log(`${LOG_PREFIX}: applied default effort ${option.id}=${effort} to ${sessionId}`);
    } catch (e: any) {
      log(`${LOG_PREFIX}: applying the default effort failed (ignored): ${e?.message ?? e}`);
    }
  }

  private async awaitEffortApply(sessionId: string): Promise<void> {
    const pending = this.effortApply.get(sessionId);
    this.effortApply.delete(sessionId);
    if (pending) { await pending; }
  }

  private async awaitModelApply(sessionId: string): Promise<void> {
    const pending = this.modelApply.get(sessionId);
    this.modelApply.delete(sessionId);
    if (pending) { await pending; }
  }

  /**
   * [CUSTOM- 草稿页问"这个 agent 的输入卡该显示什么"。
   *
   * 必须**无条件回话**（哪怕是空的）：客户端要靠这条应答才把选择器/斜杠列表布置好，让它在
   * 没有快照时静默等，正是 pitfalls #29 的形态（"效果上没变化 ≠ 可以不回话"）。
   * 定向发给发起请求的那个面，理由同 058 那四条：这是"某个文档正在编辑的草稿"。
   */
  private handleListDraftOptions(agentName: string | undefined, draftId: string, to: SurfaceKey): void {
    const agent = this.panelAgent(agentName);
    const snapshot = agent ? this.draftOptions.get(agent) : undefined;
    this.post({
      type: 'draftOptions',
      draftId,
      agentName: agent,
      // [CUSTOM- 模式那一项显示**记住的值**而不是上一条会话快照里的值：草稿页
      // 显示的就是"你不改的话会建成什么样"，而新建会话套用的正是记住的那个（159）。两处读的
      // 是同一条记录 —— 不是两份真相（pitfall #19）。
      configOptions: withRememberedMode(snapshot?.configOptions ?? [], agent ? this.lastMode.get(agent) : undefined),
      availableCommands: snapshot?.availableCommands ?? [],
      // [CUSTOM- 自定义模型别名——草稿页的模型下拉也显示这份，随草稿选项下发。
      customModels: this.customModels(),
    }, to);
  }

  /**
   * [CUSTOM- Candidate directories for the draft page.
   *
   * Targeted at the asking surface: it is that document's draft being edited.
   */
  private async handleListDirectoryChoices(agentName: string | undefined, to: SurfaceKey): Promise<void> {
    const agent = this.panelAgent(agentName);
    this.post({
      type: 'directoryChoices',
      agentName: agent,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
      recent: await this.recentDirectories(agent),
      defaultCwd: this.sessionManager.resolveDefaultCwd(),
    }, to);
  }

  /**
   * [CUSTOM- 「Recently used」删一条（2026-10-28）。列表是**派生**的（会话条目的 cwd +
   * agent 的 session/list），所以删的是"不想再看到"的标记，随后重发候选让两处收敛。
   */
  private async handleRemoveRecentDirectory(path: string | undefined, to: SurfaceKey): Promise<void> {
    if (typeof path === 'string' && path.length > 0) {
      this.sessionManager.getHistoryStore()?.dismissRecentDirectory(path);
    }
    await this.handleListDirectoryChoices(undefined, to);
  }

  /**
   * Directories this agent has used, most recent first.
   *
   * Two sources, merged: the local history cache (durable, but `workspaceState`
   * scoped — a fresh workspace knows nothing) and the AGENT's own
   * `session/list`, which spans directories (it is what the "open previous
   * session" picker shows). The agent side needs a live connection and the
   * `list` capability, so it is only consulted when both are present — a
   * directory list is never worth spawning a process for.
   */
  private async recentDirectories(agent: string | null): Promise<string[]> {
    if (!agent) { return []; }
    const limit = this.recentLimit();
    // 0 = 分组关掉：连 agent 的 session/list 都不必问。
    if (limit <= 0) { return []; }
    const store = this.sessionManager.getHistoryStore();
    // [CUSTOM- 同一目录的不同写法只留一条（2026-10-28）。Windows 上同一个文件夹会被写成
    // 大写盘符与小写盘符两种（本地缓存与 agent 的 session/list 各记一种），原来按**原字符串**
    // 去重 ⇒ 下拉里出现两条一模一样的路径。身份归一在 historyDirs.recentDirectoryList 里
    // （与历史筛选器同一个 directoryKey，不另造一份）。
    const candidates: unknown[] = [];
    for (const cwd of store?.recentDirectories(agent) ?? []) { candidates.push(cwd); }
    if (this.sessionManager.isAgentConnected(agent)
      && this.sessionManager.getCachedCapabilities(agent)?.list) {
      try {
        const response = await this.sessionManager.listSessions(agent);
        for (const session of response.sessions) { candidates.push((session as { cwd?: unknown }).cwd); }
      } catch (e) {
        // A failed agent query is not worth failing the picker over: the local
        // cache is still a usable answer.
        log(`${LOG_PREFIX}: directory choices: agent list failed (${String(e)})`);
      }
    }
    return recentDirectoryList(candidates, limit, store?.dismissedRecentDirectories() ?? []);
  }

  /** Native folder picker — the webview cannot open one itself. */
  private async handlePickDirectory(to: SurfaceKey, purpose?: 'cwd' | 'additionalDirectories'): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use this directory',
      defaultUri: vscode.Uri.file(this.sessionManager.resolveDefaultCwd()),
    });
    this.post({ type: 'directoryPicked', path: picked?.[0]?.fsPath ?? null, purpose }, to);
  }

  /** [CUSTOM- Native file picker — 'Files or folders' 菜单项（多选文件）。 */
  private async handlePickFiles(to: SurfaceKey): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: 'Add files',
      defaultUri: vscode.Uri.file(this.sessionManager.resolveDefaultCwd()),
    });
    this.post({ type: 'filesPicked', paths: (picked ?? []).map(uri => uri.fsPath) }, to);
  }

  /**
   * [CUSTOM- The draft's first message: create the session **with
   * the chosen directory**, then send.
   *
   * This is the whole point of the draft page. Creating the session earlier (on
   * `+`) and recreating it when the directory changes would be simpler code, but
   * `session/close` does NOT remove a session from the agent's history — so every
   * directory change would leave another empty session behind (my own two
   * capture sessions are visible in that list as evidence).
   *
   * On failure the draft is left alone: the client keeps the tab AND the typed
   * text, and shows the message.
   */
  private async handleCreateDraftAndSend(
    draftId: string,
    agentName: string | undefined,
    cwd: string | undefined,
    text: string,
    selections: Array<{ configId: string; value: string }>,
    // [CUSTOM- 草稿页攒的附件：客户端本地拿着（草稿没有会话），随这条消息一起交上来。
    images: Array<{ id: string; name: string; mimeType: string; dataUrl: string }> = [],
    paths: string[] = [],
    // [CUSTOM- 草稿页显式勾选的额外根目录（多根工作区）。
    additionalDirectories: string[] = [],
    to: SurfaceKey = 'view',
  ): Promise<void> {
    const agent = this.panelAgent(agentName);
    if (!agent) {
      this.post({ type: 'draftFailed', draftId, message: 'No agent to start a session with.' }, to);
      return;
    }
    // [CUSTOM- 有附件就该能发（客户端那条"空文字 + 有附件也可以发"的判据同义）。
    if (text.trim().length === 0 && images.length === 0 && paths.length === 0) {
      this.post({ type: 'draftFailed', draftId, message: 'Nothing to send.' }, to);
      return;
    }
    const target = cwd?.trim() || this.sessionManager.resolveDefaultCwd();
    log(`${LOG_PREFIX}: draft ${draftId}: creating a session for ${agent} in ${target}`);

    try {
      const session = await this.sessionManager.createSession(agent, { cwd: target, focus: true, additionalDirectories });
      // [CUSTOM- 草稿页选过的模式/模型先落到位，再让客户端把草稿换成真会话。
      // 顺序反了的话，客户端会先收到 `focus` 里那份**会话创建时**的选项（如 opus），
      // 再等一条 `meta` 把用户选的模型推回去 —— 用户看到的就是"选好的模型自己弹回内置模型"。
      // 先等"记住的默认模式"落地（session-created 那次应用），再应用用户显式选过的值：
      // 两个都是同一条连接上的 setConfigOption，后到的赢。
      await this.awaitModeApply(session.sessionId);
      // [CUSTOM- 默认模型也要先落地，避免和草稿页的显式模型选择抢同一条连接（后到的赢）。
      await this.awaitModelApply(session.sessionId);
      // [CUSTOM- 默认推理强度排在默认模型之后（见 session-created 那处注释）。
      await this.awaitEffortApply(session.sessionId);
      await this.applyDraftSelections(session, selections);
      this.post({ type: 'draftResolved', draftId, sessionId: session.sessionId }, to);
      // [CUSTOM- 草稿页攒的附件：会话已经有了，**走与普通附件完全相同的那条路**
      // （handleAttachImage / handleAttachPaths），于是 handleSendPrompt 读 this.attachments /
      // imageData 时自然就带上了 —— 这里不另存一份，避免两份账（pitfall #19）。
      for (const image of images) {
        this.handleAttachImage(session.sessionId, image.id, image.name, image.mimeType, image.dataUrl);
      }
      if (paths.length > 0) { this.handleAttachPaths(session.sessionId, paths); }
      void this.handleSendPrompt(session.sessionId, text)
        .catch(e => this.reportError(session.sessionId, e));
    } catch (e: any) {
      this.post({ type: 'draftFailed', draftId, message: errorDetail(e) }, to);
    }
  }

  /**
   * [CUSTOM- 把草稿页选好的配置项应用到刚建出来的这个会话上。
   *
   * 三道闸门，缺一不可：
   * · 按**新会话**的 configOptions 校验（id 存在 + 取值仍在候选里）——快照可能来自 agent
   * 的旧版本，这正是"陈旧无害"这句话兑现的地方；
   * · 与当前值相同的直接跳过：省一次往返，也少一次让 agent 推通知的机会；
   * · 单项失败**不阻断**首条消息（一个坏值不该让用户发不出话），但也不许静默（pitfalls #29）：
   * 记日志 + 在记录区留一行，否则用户只会看到选择器自己弹回默认值。
   */
  private async applyDraftSelections(
    session: SessionInfo,
    selections: Array<{ configId: string; value: string }>,
  ): Promise<void> {
    if (selections.length === 0) { return; }
    // 记录区可能还没有这个会话的桶：`ensureSession` 平时由 `onSessionUpdate` 负责，而这里跑的时候
    // 首条消息还没发出去。少了这一句，下面那条"没能应用"的提示会被 `append` **静默丢掉**
    // （没有桶就返回 null）—— 正好复现它要避免的那个坑（这条是测试发现的）。
    this.transcripts.ensureSession(session.sessionId, session.agentName);
    const options = session.configOptions ?? [];
    // [CUSTOM- 自定义模型（`vac.customModels`）不在 agent 的候选列表里，但用户
    // 在草稿页显式选过它 —— 放行并照常转发给 agent（agent 最终裁决），否则会被当成坏值跳过。
    const customModelIds = new Set(this.customModels().map(m => m.modelId));
    let applied = 0;
    for (const { configId, value } of selections) {
      const option = options.find(o => o.id === configId);
      if (!option) {
        log(`${LOG_PREFIX}: draft selection ${configId} is not offered by session ${session.sessionId}; skipped`);
        continue;
      }
      if (String((option as { currentValue?: unknown }).currentValue) === value) { continue; }
      const valid = option.type === 'boolean'
        ? value === 'true' || value === 'false'
        : selectValues(option).includes(value)
          || ((option as { category?: string }).category === 'model' && customModelIds.has(value));
      if (!valid) {
        log(`${LOG_PREFIX}: draft selection ${configId}=${value} is no longer a valid value; skipped`);
        continue;
      }
      try {
        await this.sessionManager.setConfigOption(session.sessionId, configId, value);
        applied += 1;
        // [CUSTOM- 用户在草稿页显式选过的模式，也算"用户的选择"——下次新建会话
        // 的默认值就是它（否则这里选一次、下个会话又弹回旧值，看起来就是没记住）。
        if ((option as { category?: string }).category === 'mode') {
          this.rememberUserMode(session.sessionId);
        }
      } catch (e: any) {
        const message = errorDetail(e);
        log(`${LOG_PREFIX}: draft selection ${configId}=${value} failed: ${message}`);
        const entry = this.transcripts.appendNotice(
          session.sessionId, 'info',
          `Could not apply the ${option.name || configId} chosen on the new-session page. ${message}`,
        );
        if (entry) { this.post({ type: 'append', sessionId: session.sessionId, entries: [entry] }); }
      }
    }
    // 播种切换基线：我们自己的 setter 已经把权威那份写对了，所以 agent 随后推来的同状态通知
    // diff 为空（pitfall #34 那套"两份副本 + 去重"的既定前提）。不播种的话，只要 agent 在应用
    // 之前已经推过一次 session/update（onSessionUpdate 会拿**默认值**当基线），应用后的通知就
    // 会被当成一次用户从未做过的"切换"播报出来。
    if (applied > 0) {
      const state = this.choiceState(session.sessionId);
      if (state) { this.choices.set(session.sessionId, state); }
      this.pushMeta(session.sessionId);
      log(`${LOG_PREFIX}: draft applied ${applied} selection(s) to ${session.sessionId}`);
    }
  }

  // --- Outbound messages ---------------------------------------------------

  // 单目标 → 广播（可定向）。
  // 两个面同时存在时，除 `boot` 外的一切都必须两端一致：客户端本来就按
  // `currentSessionId` 过滤，所以广播既安全又是让两侧保持同步的最简做法。
  //
  // [CUSTOM- 这里同时是**合帧队列的入口**：按消息类型决定走
  // 「攒一帧再发」（可按条目合并）还是「立即发」（结构性）。路由表放在这一处，
  // 而不是散在每个调用点——漏改一个调用点就会静默破坏 INV-A（revise 越过 append）
  // 或 INV-C（sessionsChanged 被延迟，Send/Stop 按钮状态错）。
  private post(message: ExtToChat | MarkdownRendered, to?: SurfaceKey): void {
    const type = (message as { type?: string }).type ?? '';
    // [CUSTOM- One choke point for "a session produced output": every
    // transcript-bearing message goes through here, so the unread marker cannot be
    // remembered on some append paths and forgotten on others (which is what a
    // per-call-site approach would eventually do).
    if (type === 'append' || type === 'revise' || type === 'toolUpdate') {
      const sessionId = (message as { sessionId?: string }).sessionId;
      if (sessionId && this.focused.sessionId !== sessionId && !this.unread.has(sessionId)) {
        this.unread.add(sessionId);
        // Tell the strip immediately. Without this the dot could wait for the next
        // unrelated refresh — some append paths (a notice, terminal output) never
        // call refreshSessions themselves.
        this.refreshSessions();
      }
    }
    if (!to && !STRUCTURAL_MESSAGE_TYPES.has(type)) {
      this.outbox.enqueue(message as ExtToChatMessage);
      return;
    }
    this.postNow(message, to);
  }

  /** Broadcast (or target) immediately, bypassing the coalescing queue. */
  private postNow(message: ExtToChat | MarkdownRendered, to?: SurfaceKey): void {
    if (to) {
      const only = this.surfaces.get(to);
      if (only) { this.send(only, message); }
      return;
    }
    for (const surface of this.surfaces.values()) { this.send(surface, message); }
  }

  private send(surface: ChatSurface, message: ExtToChat | MarkdownRendered): void {
    // Watch the returned promise: a payload that fails structured clone rejects,
    // and a bare `void` would swallow that. Silent send failures are exactly
    // what makes "the UI just shows nothing" impossible to diagnose.
    const sent = surface.webview.postMessage(message);
    void sent?.then(undefined, (e: unknown) => {
      log(`${LOG_PREFIX}: postMessage failed for "${(message as { type?: string }).type}" on "${surface.key}": ${String(e)}`);
    });
  }

  /**
   * [CUSTOM- 编辑器里「当前打开的文件」（含多行选区的行区间）→ 输入框的引用栏。
   *
   * 它让「把正在看的这个文件加进这条消息」从「找文件 + Attach File」变成点一下 `+`（与官方插件同一件事）。
   * 只在**签名变化**时推：`onDidChangeTextEditorSelection` 每次光标移动都会回调，而区间叠成「行号」之后，
   * 同一行里移动是不该发的（否则光标一动就是一条消息）。
   * `force` 用于面刚挂上来的那一刻 —— 签名是全局的，第二个面挂上来时不该因为「另一个面拿过了」而拿不到。
   */
  private pushActiveFile(force = false): void {
    if (this.attachedCount === 0) { return; }
    const info = readActiveFileFrom(vscode.window.activeTextEditor as ActiveEditorLike | undefined);
    const signature = info
      ? info.path + '|' + (info.lineStart ?? '') + '|' + (info.lineEnd ?? '')
      : '';
    if (!force && signature === this.activeFileSignature) { return; }
    this.activeFileSignature = signature;
    this.post({ type: 'activeFile', file: info });
  }

  /**
   * [CUSTOM- 记下「此刻开着哪些会话、聚焦哪一个」，供下次重开面板时恢复。
   *
   * - **顺序按 uiPrefs.tabOrder**：那正是客户端的手工顺序，恢复出来的 tab 才会回到原位。
   * - **只有本生命周期出现过会话之后，才允许写空表** —— 否则重载后刚启动、一个会话都还没有的
   * 那一瞬间就会把上一次的快照抹掉（而那正是要读它的时刻）。
   * - **防抖**：它挂在 created / closed / focus 三个事件上，而 focus 会因为"切标签"频繁发生。
   */
  private saveOpenSessions(): void {
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); }
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      const live = this.liveSessionsInTabOrder();
      if (live.length === 0 && !this.sawLiveSession) { return; }
      const snapshot: OpenSessionsSnapshot = { sessions: live, focused: this.focused.sessionId };
      this.openSessions = snapshot;
      const write = this.globalState?.update(OPEN_SESSIONS_KEY, snapshot);
      if (write) { void Promise.resolve(write).catch(() => undefined); }
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  /**
   * [CUSTOM- 恢复时把一条快照会话真正加载回来。
   *
   * 与历史选择器走**同一个决策点**（`openExistingSession`：load 优先、否则 resume），差别只有两点：
   * · 它**不动**其它已打开的会话（历史选择器有"替换语义"，恢复是"多开"）；
   * · 失败（会话在 agent 侧已经没了/转录被删）时把这一条从快照里摘掉，别下次再拿它问用户。
   */
  private async openSnapshotSession(entry: RecoverableSession): Promise<void> {
    const agent = this.panelAgent(entry.agentName);
    if (!agent) { return; }
    try {
      await this.preloadTranscriptTimes(agent, entry.sessionId, entry.cwd);
      await this.sessionManager.openExistingSession(agent, entry.sessionId, { cwd: entry.cwd, title: entry.title });
    } catch (e) {
      log(`${LOG_PREFIX}: could not restore ${entry.sessionId}: ${(e as Error)?.message ?? String(e)}`);
      this.openSessions = {
        sessions: (this.openSessions?.sessions ?? []).filter(s => s.sessionId !== entry.sessionId),
        focused: this.openSessions?.focused ?? null,
      };
      this.globalState?.update(OPEN_SESSIONS_KEY, this.openSessions);
      this.reportError(null, e);
    }
  }

  /** 活着的会话，按客户端那份手工顺序排（不在表里的按 SessionManager 的顺序接在后面）。 */
  private liveSessionsInTabOrder(): RecoverableSession[] {
    const app = ideLabel();
    const out: RecoverableSession[] = this.sessionManager.getLiveSessions().map(session => ({
      agentName: session.agentName,
      sessionId: session.sessionId,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.title ? { title: session.title } : {}),
      ...(app ? { app } : {}),
    }));
    const rank = new Map<string, number>();
    (this.uiPrefs?.tabOrder ?? []).forEach((id, index) => rank.set(id, index));
    const known = out.filter(s => rank.has(s.sessionId));
    const unknown = out.filter(s => !rank.has(s.sessionId));
    known.sort((a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0));
    return known.concat(unknown);
  }

  /** [CUSTOM- 新会话 tab 落在源会话右边：把完整顺序写回 `uiPrefs.tabOrder` 并广播。 */
  private placeSessionAfterInTabOrder(sourceId: string, newSessionId: string): void {
    const liveIds = this.sessionManager.getLiveSessions().map(session => session.sessionId);
    const order = sanitizeTabOrder(
      insertSessionAfter(this.uiPrefs?.tabOrder ?? [], liveIds, sourceId, newSessionId),
    );
    const next: UiPrefs = {
      ...(this.uiPrefs ?? { outlineMode: 'popup' as const, outlineWidth: 240 }),
      tabOrder: order,
    };
    this.uiPrefs = next;
    this.globalState?.update(UI_PREFS_KEY, next);
    this.post({ type: 'uiPrefs', ...next });
  }

  /**
   * [CUSTOM- 可以恢复的会话：快照里**现在不活的**那些（活着的已经是 tab 了）。
   *
   * 已被答复（选过"开始新的"）或设置是 `never` 时返回空 —— 上层据此决定"问不问"，
   * `handleConnectAgent` 也据此决定"要不要当场建一个新会话"。
   */
  private recoverableSessions(): RecoverableSession[] {
    if (this.restoreDismissed) { return []; }
    if (this.prefs.getRestore() === 'never') { return []; }
    const snapshot = this.openSessions;
    if (!snapshot || snapshot.sessions.length === 0) { return []; }
    // [CUSTOM- 与当前 IDE 相同的 app 就不必送到面板上：只有"跨环境"的那几条才需要标注。
    const self = ideLabel();
    return snapshot.sessions
      .filter(s => !this.sessionManager.getSession(s.sessionId))
      .map(({ app, ...rest }) => (app && self && app === self ? rest : { ...rest, app }));
  }

  /**
   * [CUSTOM- 设置面板的数据源（2026-10-21）。宿主是唯一写者：
   * · `vac.*` 键 → VS Code 配置 / 跨 IDE 全局文件（写当前生效层，见 writeSetting）；
   * · `panel.*` 键 → 面板 UiPrefs（globalState，跨窗口/两个面共享）；
   * · `action.*` / `about.*` → 按钮与只读信息。
   * 新增一项设置 = 这里加一行 + `handleSetSetting` 加一个 case。
   */
  private settingsItems(): SettingItem[] {
    const config = vscode.workspace.getConfiguration('vac');
    const prefs = this.uiPrefs ?? { outlineMode: 'popup' as const, outlineWidth: 240 };
    const customSource = this.settingsIO.resolve('vac.customModels', 'global');
    const customModels = normalizeCustomModels(
      customSource.layers.find(entry => entry.layer === customSource.effective)?.value,
    );
    // [CUSTOM- 从未写过时与客户端同一份默认（推理块 + 工具卡）；写过空数组就是"全不展开"。
    const kinds = prefs.autoExpandKinds === undefined
      ? ['thought', 'tool']
      : sanitizeAutoExpandKinds(prefs.autoExpandKinds);
    const logPath = logFilePath();
    return [
      {
        key: 'vac.autoConnectOnOpen', group: 'general', type: 'boolean',
        label: 'Connect automatically',
        description: 'Start the agent as soon as the chat panel opens.',
        value: this.prefs.getAutoConnect(),
        ...this.configScope('vac.autoConnectOnOpen', 'ide'),
      },
      {
        key: 'vac.restoreSessionsOnOpen', group: 'general', type: 'select',
        label: 'Restore sessions on open',
        description: 'What to do with the sessions that were open when the window closed.',
        value: this.prefs.getRestore(),
        options: [
          { value: 'ask', label: 'Ask me' },
          { value: 'always', label: 'Always restore' },
          { value: 'never', label: 'Never restore' },
        ],
        ...this.configScope('vac.restoreSessionsOnOpen', 'ide'),
      },
      {
        key: 'vac.defaultWorkingDirectory', group: 'general', type: 'text',
        label: 'Default working directory',
        description: 'Leave empty to use the current workspace folder.',
        value: config.get<string>('defaultWorkingDirectory') ?? '',
        ...this.configScope('vac.defaultWorkingDirectory', 'ide'),
      },
      {
        key: 'panel.autoExpandDefault', group: 'chat', type: 'boolean', scope: 'panel',
        label: 'Auto-expand new output',
        description: 'Expand cards as new output arrives (sessions without their own setting).',
        value: prefs.autoExpandDefault === true,
      },
      {
        key: 'panel.autoExpandKinds.tool', group: 'chat', type: 'boolean', indent: true, scope: 'panel',
        label: 'Tool calls', value: kinds.includes('tool'),
      },
      {
        key: 'panel.autoExpandKinds.thought', group: 'chat', type: 'boolean', indent: true, scope: 'panel',
        label: 'Reasoning blocks', value: kinds.includes('thought'),
      },
      {
        key: 'panel.autoExpandKinds.diff', group: 'chat', type: 'boolean', indent: true, scope: 'panel',
        label: 'Diffs inside tool calls', value: kinds.includes('diff'),
      },
      {
        key: 'panel.flatTools', group: 'chat', type: 'boolean', scope: 'panel',
        label: 'Group sub-agent tool calls',
        description: 'Show a sub-agent’s tool calls under the call that started it.',
        value: prefs.flatTools !== true,
      },
      {
        key: 'panel.sendKey', group: 'chat', type: 'select', scope: 'panel',
        label: 'Send with',
        description: 'Shift+Enter always inserts a newline.',
        value: prefs.sendKey === 'ctrlEnter' ? 'ctrlEnter' : 'enter',
        options: [
          { value: 'enter', label: 'Enter' },
          { value: 'ctrlEnter', label: 'Ctrl/Cmd+Enter' },
        ],
      },
      {
        key: 'panel.recentDirectoryLimit', group: 'chat', type: 'number', scope: 'panel',
        label: 'Recently used directories',
        description: `How many recent directories the picker offers (${ChatPanelHost.RECENT_DIRECTORIES_MIN}–${ChatPanelHost.RECENT_DIRECTORIES_MAX}; 0 hides the group).`,
        value: ChatPanelHost.clampRecentDirectories(prefs.recentDirectoryLimit),
        min: ChatPanelHost.RECENT_DIRECTORIES_MIN,
        max: ChatPanelHost.RECENT_DIRECTORIES_MAX,
      },
      ...this.defaultAgentItems(prefs),
      {
        key: 'vac.autoApprovePermissions', group: 'chat', type: 'select',
        label: 'Permission requests',
        description: 'How permission requests from the agent are answered.',
        value: config.get<string>('autoApprovePermissions') ?? 'ask',
        options: [
          { value: 'ask', label: 'Ask me' },
          { value: 'allowAll', label: 'Approve everything' },
        ],
        warning: 'Approving everything lets the agent edit files and run tools without asking.',
        ...this.configScope('vac.autoApprovePermissions', 'ide'),
      },
      {
        key: 'panel.timesDefault', group: 'appearance', type: 'boolean', scope: 'panel',
        label: 'Show record times',
        description: 'Default for sessions that have no per-session value.',
        value: prefs.timesDefault === true,
      },
      {
        key: 'panel.markdownStyle', group: 'appearance', type: 'select', scope: 'panel',
        label: 'Markdown style',
        description: 'Typeface and accent colors for rendered messages. “Follow editor” uses the current theme as-is.',
        value: resolveMarkdownStyle(prefs.markdownStyle),
        options: [
          { value: 'editor', label: 'Follow editor' },
          { value: 'github', label: 'GitHub' },
          { value: 'obsidian', label: 'Obsidian' },
          { value: 'typora', label: 'Typora' },
          { value: 'atom', label: 'Atom' },
          { value: 'minimal', label: 'Minimal' },
          { value: 'things', label: 'Things' },
        ],
      },
      {
        key: 'panel.outlineMode', group: 'appearance', type: 'select', scope: 'panel',
        label: 'Outline layout',
        description: 'Where the conversation outline lives.',
        value: prefs.outlineMode === 'sidebar' ? 'sidebar' : 'popup',
        options: [
          { value: 'popup', label: 'Dropdown' },
          { value: 'sidebar', label: 'Pinned sidebar' },
        ],
      },
      {
        key: 'panel.outlineWidth', group: 'appearance', type: 'number', scope: 'panel',
        label: 'Outline width (px)',
        description: 'Pinned sidebar width, between 160 and 480.',
        value: prefs.outlineWidth,
      },
      {
        key: 'panel.composerMaxWidth', group: 'appearance', type: 'number', scope: 'panel',
        label: 'Composer width (px)',
        description: 'Maximum width of the input card, between 360 and 1200.',
        value: prefs.composerMaxWidth ?? 720,
      },
      {
        key: 'panel.inputMaxHeight', group: 'appearance', type: 'number', scope: 'panel',
        label: 'Input box max height (px)',
        description: 'Between 80 and 800; also capped at 38% of the panel height.',
        value: prefs.inputMaxHeight ?? 320,
      },
      {
        key: 'panel.autoExpand.toolHeight', group: 'appearance', type: 'number', scope: 'panel',
        label: 'Expanded tool card height (px)',
        description: 'For auto-expanded cards; 0 = no limit, taller output scrolls inside the card.',
        value: prefs.autoExpandToolHeight ?? 360,
      },
      {
        key: 'panel.autoExpand.thoughtHeight', group: 'appearance', type: 'number', scope: 'panel',
        label: 'Expanded reasoning height (px)',
        description: 'For auto-expanded cards; 0 = no limit, taller reasoning scrolls inside the block.',
        value: prefs.autoExpandThoughtHeight ?? 240,
      },
      {
        key: 'vac.logTraffic', group: 'advanced', type: 'boolean',
        label: 'Log ACP traffic',
        description: 'Write the JSON-RPC stream to the VAC Traffic channel and the log file.',
        value: config.get<boolean>('logTraffic') !== false,
        ...this.configScope('vac.logTraffic', 'ide'),
      },
      {
        key: 'vac.customModels', group: 'advanced', type: 'models',
        label: 'Custom models',
        description: 'Injected into the agent as extra model choices (per agent support). Stored in the cross-IDE global config unless overridden here.',
        value: customModels,
        ...this.configScope('vac.customModels', 'global', customSource),
      },
      {
        key: 'vac.agents', group: 'advanced', type: 'json',
        label: 'Agent configuration',
        description: 'JSON object: name → { command, args, env, kind }. Saved per IDE.',
        value: config.get('agents') ?? {},
        ...this.configScope('vac.agents', 'ide'),
      },
      {
        key: 'action.openAgentCache', group: 'advanced', type: 'action', actionLabel: 'Open',
        label: 'Open agent cache folder',
        description: this.agentCacheDir() ?? 'No cached runtime yet.',
      },
      {
        key: 'action.clearAgentCache', group: 'advanced', type: 'action', actionLabel: 'Clear',
        label: 'Clear agent runtime cache',
        description: 'Deletes the local agent install; the next start re-creates it with npm.',
        confirm: 'Delete the local agent runtime cache? The next start will re-create it with npm.',
      },
      {
        key: 'action.resetPanelPrefs', group: 'advanced', type: 'action', actionLabel: 'Reset',
        label: 'Reset panel preferences',
        description: 'Restore the panel UI defaults (outline, Times, auto-expand, composer size).',
        confirm: 'Reset the panel UI preferences to their defaults?',
      },
      {
        key: 'action.openLog', group: 'advanced', type: 'action', actionLabel: 'Open',
        label: 'Open log file',
        description: logPath ?? 'Not available yet.',
      },
      {
        key: 'action.copyBuildInfo', group: 'advanced', type: 'action', actionLabel: 'Copy',
        label: 'Copy build info',
        description: buildStamp(),
      },
      { key: 'about.version', group: 'advanced', type: 'info', label: 'Version', value: readPackageVersion() || '—' },
      { key: 'about.agent', group: 'advanced', type: 'info', label: 'Agent', value: this.panelAgent() ?? '—' },
    ];
  }

  /** [CUSTOM- 设置面板每行的作用域：默认层 + 当前生效层/各层取值。 */
  private configScope(
    key: string,
    scope: 'global' | 'ide',
    source = this.settingsIO.resolve(key, scope),
  ): Pick<SettingItem, 'scope' | 'source'> {
    return { scope, source };
  }

  // [CUSTOM- 扩展的 globalStorage 根目录：设置面板里的「打开/清除 agent 运行时缓存」
  // 需要它（缓存位于 `<root>/agents/<agent>`，见 core/AgentInstall.ts）。
  private storageRoot?: string;

  /** [CUSTOM- 由 ChatViewProvider 在构造后注入（避免把 9 个位置参数的顺序耦合进测试桩）。 */
  setStorageRoot(root: string | undefined): void {
    this.storageRoot = root;
  }

  private agentCacheDir(): string | undefined {
    return this.storageRoot ? join(this.storageRoot, 'agents') : undefined;
  }

  /**
   * [CUSTOM- 每个 agent 两行「默认模型 / 默认推理强度」（新建会话时套用）：
   * 有候选就下拉，没候选就退化成文本输入（值在应用时仍会逐项校验）。
   */
  private defaultAgentItems(prefs: UiPrefs): SettingItem[] {
    const rows: SettingItem[] = [];
    for (const agent of getAgentNames()) {
      const modelKey = `panel.defaultModel.${agent}`;
      const modelValue = prefs.defaultModelByAgent?.[agent] ?? '';
      const modelChoices = this.agentChoicesFor(agent, 'model');
      rows.push(modelChoices
        ? {
          key: modelKey, group: 'chat', type: 'select', indent: true,
          label: `${agent} default model`,
          value: modelValue,
          options: modelChoices,
        }
        : {
          key: modelKey, group: 'chat', type: 'text', indent: true,
          label: `${agent} default model`,
          description: 'Empty = the agent default. Enter a model id.',
          value: modelValue,
        });
      const effortKey = `panel.defaultEffort.${agent}`;
      const effortValue = prefs.defaultEffortByAgent?.[agent] ?? '';
      const effortChoices = this.agentChoicesFor(agent, 'thought_level');
      rows.push(effortChoices
        ? {
          key: effortKey, group: 'chat', type: 'select', indent: true,
          label: `${agent} default effort`,
          value: effortValue,
          options: effortChoices,
        }
        : {
          key: effortKey, group: 'chat', type: 'text', indent: true,
          label: `${agent} default effort`,
          description: 'Empty = the agent default. Enter an effort id.',
          value: effortValue,
        });
    }
    // 这一族都是面板 UiPrefs（globalState），不是 VS Code 配置。
    for (const row of rows) { row.scope = 'panel'; }
    return rows;
  }

  /**
   * [CUSTOM- 某个 agent 最后一次见到的某类配置项的候选值（用于设置面板的下拉）。
   * `category` 是 ACP 的类目：`model` / `thought_level` / `mode`…
   * 自定义模型（`vac.customModels`）不在 agent 的候选里，但用户显式配置过，所以一并列出。
   */
  private agentChoicesFor(agent: string, category: string): SettingOption[] | null {
    const snapshot = this.draftOptions.get(agent);
    const option = (snapshot?.configOptions ?? []).find(
      o => (o as { category?: string }).category === category,
    ) as { options?: unknown } | undefined;
    if (!option || !Array.isArray(option.options)) { return null; }
    const names = new Map<string, string>();
    if (category === 'model') {
      for (const model of this.customModels()) { names.set(model.modelId, model.name || model.modelId); }
    }
    const out: SettingOption[] = [{ value: '', label: 'Agent default' }];
    for (const entry of option.options as Array<{ value?: unknown; name?: unknown; options?: unknown }>) {
      if (entry && Array.isArray(entry.options)) {
        for (const grouped of entry.options as Array<{ value?: unknown; name?: unknown }>) {
          if (grouped?.value === undefined) { continue; }
          const id = String(grouped.value);
          out.push({ value: id, label: names.get(id) || String(grouped.name ?? id) });
        }
      } else if (entry && entry.value !== undefined) {
        const id = String(entry.value);
        out.push({ value: id, label: names.get(id) || String(entry.name ?? id) });
      }
    }
    return out.length > 1 ? out : null;
  }

  private postSettings(): void {
    if (this.attachedCount === 0) { return; }
    this.post({ type: 'settings', items: this.settingsItems() });
  }

  private postCustomModels(): void {
    if (this.attachedCount === 0) { return; }
    this.post({ type: 'customModels', customModels: this.customModels() });
  }

  /** 写进当前生效层：工作区覆盖存在时改工作区，否则改用户层/全局层。 */
  private async writeConfigSetting(key: string, value: unknown, scope: 'global' | 'ide'): Promise<void> {
    const source = this.settingsIO.resolve(key, scope);
    await this.settingsIO.write(key, value, source.writeTarget);
  }

  private async handleSetSetting(key: string, value: unknown): Promise<void> {
    switch (key) {
      case 'vac.autoConnectOnOpen':
        await this.writeConfigSetting('vac.autoConnectOnOpen', value === true, 'ide');
        this.postAutoConnectPref();
        break;
      case 'vac.restoreSessionsOnOpen':
        await this.writeConfigSetting('vac.restoreSessionsOnOpen', resolveRestoreChoice(value), 'ide');
        this.postRestorePref();
        break;
      case 'vac.defaultWorkingDirectory':
        await this.writeConfigSetting('vac.defaultWorkingDirectory', String(value ?? '').trim(), 'ide');
        break;
      case 'vac.autoApprovePermissions':
        await this.writeConfigSetting(
          'vac.autoApprovePermissions', value === 'allowAll' ? 'allowAll' : 'ask', 'ide',
        );
        break;
      case 'vac.logTraffic':
        await this.writeConfigSetting('vac.logTraffic', value === true, 'ide');
        break;
      case 'panel.autoExpandDefault':
        this.patchUiPrefs({ autoExpandDefault: value === true });
        break;
      case 'panel.autoExpandKinds.tool':
        this.patchUiPrefs({ autoExpandKinds: this.toggledKind('tool', value === true) });
        break;
      case 'panel.autoExpandKinds.thought':
        this.patchUiPrefs({ autoExpandKinds: this.toggledKind('thought', value === true) });
        break;
      case 'panel.autoExpandKinds.diff':
        this.patchUiPrefs({ autoExpandKinds: this.toggledKind('diff', value === true) });
        break;
      case 'panel.autoExpand.toolHeight':
        this.patchUiPrefs({ autoExpandToolHeight: clampExpandHeight(value, 360) });
        break;
      case 'panel.autoExpand.thoughtHeight':
        this.patchUiPrefs({ autoExpandThoughtHeight: clampExpandHeight(value, 240) });
        break;
      case 'panel.flatTools':
        // 复选框语义是"分组显示"；存储的是相反值（flatTools）。
        this.patchUiPrefs({ flatTools: value !== true });
        break;
      case 'panel.sendKey':
        this.patchUiPrefs({ sendKey: value === 'ctrlEnter' ? 'ctrlEnter' : 'enter' });
        break;
      case 'panel.composerMaxWidth':
        this.patchUiPrefs({ composerMaxWidth: clampNumber(value, 360, 1200, 720) });
        break;
      case 'panel.inputMaxHeight':
        this.patchUiPrefs({ inputMaxHeight: clampNumber(value, 80, 800, 320) });
        break;
      case 'panel.recentDirectoryLimit':
        this.patchUiPrefs({
          recentDirectoryLimit: ChatPanelHost.clampRecentDirectories(value),
        });
        break;
      case 'panel.markdownStyle':
        this.patchUiPrefs({ markdownStyle: resolveMarkdownStyle(value) });
        break;
      case 'vac.customModels':
        await this.writeConfigSetting('vac.customModels', normalizeCustomModels(value), 'global');
        this.postCustomModels();
        break;
      case 'vac.agents':
        await this.writeConfigSetting('vac.agents', sanitizeAgentsConfig(value), 'ide');
        break;
      case 'panel.timesDefault':
        this.patchUiPrefs({ timesDefault: value === true });
        break;
      case 'panel.outlineMode':
        this.patchUiPrefs({ outlineMode: value === 'sidebar' ? 'sidebar' : 'popup' });
        break;
      case 'panel.outlineWidth': {
        const width = Math.max(160, Math.min(480, Number(value) || 240));
        this.patchUiPrefs({ outlineWidth: width });
        break;
      }
      default:
        // [CUSTOM- 每个 agent 的默认模型/默认推理强度走同一族 key
        // （`panel.defaultModel.<agent>` / `panel.defaultEffort.<agent>`）。
        if (key.startsWith('panel.defaultModel.')) {
          const agent = key.slice('panel.defaultModel.'.length);
          const map = { ...(this.uiPrefs?.defaultModelByAgent ?? {}) };
          const modelId = typeof value === 'string' ? value.trim() : '';
          if (modelId) { map[agent] = modelId; } else { delete map[agent]; }
          this.patchUiPrefs({ defaultModelByAgent: sanitizeStringMap(map) });
          break;
        }
        if (key.startsWith('panel.defaultEffort.')) {
          const agent = key.slice('panel.defaultEffort.'.length);
          const map = { ...(this.uiPrefs?.defaultEffortByAgent ?? {}) };
          const effortId = typeof value === 'string' ? value.trim() : '';
          if (effortId) { map[agent] = effortId; } else { delete map[agent]; }
          this.patchUiPrefs({ defaultEffortByAgent: sanitizeStringMap(map) });
          break;
        }
        log(`${LOG_PREFIX}: unknown setting ${key}`);
        return;
    }
    // 值可能被夹紧/规整过（宽度、枚举），回发整张表让控件显示真实值。
    this.postSettings();
  }

  /** [CUSTOM- 设置面板 + 地址栏开关共用的一条写路径：合并、落盘、广播给两个面。 */
  private patchUiPrefs(patch: Partial<UiPrefs>): void {
    const next: UiPrefs = { ...(this.uiPrefs ?? { outlineMode: 'popup' as const, outlineWidth: 240 }), ...patch };
    this.uiPrefs = next;
    void this.globalState?.update(UI_PREFS_KEY, next);
    this.post({ type: 'uiPrefs', ...next });
  }

  private toggledKind(kind: string, on: boolean): string[] {
    const current = this.uiPrefs?.autoExpandKinds === undefined
      ? ['thought', 'tool']
      : sanitizeAutoExpandKinds(this.uiPrefs.autoExpandKinds);
    return on
      ? sanitizeAutoExpandKinds([...current, kind])
      : current.filter(entry => entry !== kind);
  }

  private async handleSettingAction(
    action: string,
    key?: string,
    layer?: 'workspace' | 'user' | 'global',
  ): Promise<void> {
    if (action === 'openSettingFile') {
      if (layer) { await this.settingsIO.open(layer); }
      return;
    }
    if (action === 'removeSettingLayer' || action === 'makeSettingGlobal') {
      const allowed = !!key && (GLOBAL_SETTING_KEYS.has(key) || CONFIG_SETTING_KEYS.has(key));
      if (!key || !allowed) { return; }
      if (action === 'removeSettingLayer') {
        if (!layer) { return; }
        await this.settingsIO.clear(key, layer);
      } else {
        if (!GLOBAL_SETTING_KEYS.has(key)) { return; }
        const source = this.settingsIO.resolve(key, 'global');
        const value = source.layers.find(entry => entry.layer === source.effective)?.value;
        await this.settingsIO.write(key, value, 'global');
        if (source.effective === 'workspace') { await this.settingsIO.clear(key, 'workspace'); }
        if (source.effective === 'user') { await this.settingsIO.clear(key, 'user'); }
      }
      if (key === 'vac.customModels') { this.postCustomModels(); }
      this.postSettings();
      return;
    }
    if (action === 'openAgentCache') {
      const dir = this.agentCacheDir();
      if (!dir || !existsSync(dir)) {
        void vscode.window.showInformationMessage('No cached agent runtime yet.');
        return;
      }
      mkdirSync(dir, { recursive: true });
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
      return;
    }
    if (action === 'clearAgentCache') {
      const dir = this.agentCacheDir();
      if (!dir || !existsSync(dir)) {
        void vscode.window.showInformationMessage('No cached agent runtime to clear.');
        return;
      }
      try {
        rmSync(dir, { recursive: true, force: true });
        log(`${LOG_PREFIX}: cleared the agent runtime cache at ${dir}`);
        void vscode.window.showInformationMessage('Agent runtime cache cleared. It will be re-created on the next start.');
      } catch (e) {
        // Windows 上正在运行的 node 可能锁住已加载的模块文件。
        void vscode.window.showWarningMessage(
          `Could not clear the agent runtime cache: ${(e as Error)?.message ?? String(e)}`,
        );
      }
      this.postSettings();
      return;
    }
    if (action === 'resetPanelPrefs') {
      // [CUSTOM- 一键恢复面板 UI 默认值；不动 VS Code 配置项（那些在 General/Advanced 里）。
      // 广播时必须**显式带上每一项的默认值**：客户端的契约是"缺字段 = 这一项没改"，
      // 只发大纲两项的话，Times / 自动展开 / 输入卡尺寸会保留旧值（直到窗口重开）。
      this.uiPrefs = { outlineMode: 'popup', outlineWidth: 240 };
      void this.globalState?.update(UI_PREFS_KEY, this.uiPrefs);
      this.post({
        type: 'uiPrefs',
        outlineMode: 'popup',
        outlineWidth: 240,
        timesBySession: {},
        timesDefault: false,
        // Tail 的默认值是 true（不开按钮时也照旧自动跟到最后一条）。
        tailBySession: {},
        tailDefault: true,
        outlineOpenBySession: {},
        outlineOpenDefault: false,
        autoExpandBySession: {},
        autoExpandDefault: false,
        autoExpandKinds: ['thought', 'tool'],
        autoExpandToolHeight: 360,
        autoExpandThoughtHeight: 240,
        flatTools: false,
        composerMaxWidth: 720,
        inputMaxHeight: 320,
        sendKey: 'enter',
        defaultModelByAgent: {},
      });
      this.postSettings();
      void vscode.window.showInformationMessage('Panel preferences reset.');
      return;
    }
    if (action === 'pickDefaultWorkingDirectory') {
      // [CUSTOM- 系统目录选择器（2026-10-21）：与输入框并排的 Browse… 按钮。
      const config = vscode.workspace.getConfiguration('vac');
      const current = (config.get<string>('defaultWorkingDirectory') ?? '').trim();
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Use this folder',
        ...(current ? { defaultUri: vscode.Uri.file(current) } : {}),
      });
      if (picked && picked[0]) {
        await config.update('defaultWorkingDirectory', picked[0].fsPath, vscode.ConfigurationTarget.Global);
        this.postSettings();
      }
      return;
    }
    if (action === 'openLog') {
      const path = logFilePath();
      if (!path) {
        void vscode.window.showInformationMessage('The VAC log file is not available yet.');
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path));
      return;
    }
    if (action === 'copyBuildInfo') {
      await vscode.env.clipboard.writeText(buildStamp());
      void vscode.window.showInformationMessage('VAC build info copied.');
      return;
    }
    log(`${LOG_PREFIX}: unknown settings action ${action}`);
  }

  private postRestorePref(): void {
    this.post({ type: 'restorePref', value: this.prefs.getRestore() });
  }

  private pushBoot(to?: SurfaceKey): void {
    if (this.attachedCount === 0) { return; }
    // INV-E: the snapshot must not overtake anything still sitting in the queue.
    this.outbox.flush();
    this.refreshLiveSessionIds();
    const recoverable = this.recoverableSessions();
    const sessions = this.buildSummaries();
    const focused = this.focused.sessionId ? this.buildSummary(this.focused.sessionId) : null;
    this.post({
      type: 'boot',
      focused,
      sessions,
      snapshot: focused ? this.snapshotOf(focused.sessionId) : null,
      meta: focused ? this.metaOf(focused.sessionId) : null,
      agentConnected: this.panelAgentConnected(),
      // [CUSTOM- 首屏值随 boot 一起走：客户端的自动连接布防需要
      // {agentConnected, focused, autoConnect} 三者同时成立。
      autoConnect: this.prefs.getAutoConnect(),
      // [CUSTOM- 没有聚焦会话时地址栏显示它：连接适配器（npx 下载）那几十秒里
      // 面板就是"已连接、还没有会话"，那时地址栏空着会看着像坏了（090 当初把这一格整个隐藏）。
      // 与草稿页显示的是**同一份**语义（下次会话建在这里），所以也复用宿主这一个解析器。
      defaultCwd: this.sessionManager.resolveDefaultCwd(),
      // [CUSTOM- 上次退出时开着的会话（现在都不活）→ 空态卡片据此问一句要不要恢复。
      // 只给 modern agent 的（legacy 交给旧面板会换文档）；一条都没有时不带这个字段。
      ...(recoverable.length > 0 ? { recoverable } : {}),
      restorePref: this.prefs.getRestore(),
    }, to);
    // [CUSTOM- Bring the outline pin/width prefs along with the boot,
    // so a recreated webview (editor panel reopen / window reload) restores them.
    if (this.uiPrefs) {
      this.post({ type: 'uiPrefs', ...this.uiPrefs }, to);
    }
  }

  private pushFocus(): void {
    if (this.attachedCount === 0) { return; }
    this.outbox.flush();
    const sessionId = this.focused.sessionId;
    const summary = sessionId ? this.buildSummary(sessionId) : null;
    this.post({
      type: 'focus',
      summary,
      snapshot: summary ? this.snapshotOf(sessionId!) : null,
      meta: summary ? this.metaOf(sessionId!) : null,
      agentConnected: this.panelAgentConnected(),
    });
  }

  private pushMeta(sessionId: string): void {
    if (this.attachedCount === 0) { return; }
    if (this.focused.sessionId !== sessionId) { return; }
    this.post({ type: 'meta', sessionId, meta: this.metaOf(sessionId) });
  }

  private pushTurnState(sessionId: string): void {
    this.refreshSessions();
    this.pushMeta(sessionId);
  }

  private refreshSessions(): void {
    if (this.attachedCount === 0) { return; }
    this.refreshLiveSessionIds();
    const sessions = this.buildSummaries();
    // [CUSTOM- This runs on EVERY agent message chunk, so without
    // the signature check each streamed token rebuilt the whole tab strip and
    // agent dropdown on the client. Skipping the no-op case is also what keeps
    // `flushThenPost` from flushing the coalescing queue on every chunk.
    // [CUSTOM- The connection flag is part of the signature: an agent
    // connecting or disconnecting changes what the empty state must say, and a signature
    // that missed it would never refresh the strip — the same trap 022 documented for
    // `unread`.
    const agentConnected = this.panelAgentConnected();
    const signature = `conn:${agentConnected ? 1 : 0}\n` + sessions
      .map(s => `${s.sessionId}|${s.agentName}|${s.agentKind ?? ''}|${s.title ?? ''}|${s.loading ? 1 : 0}|${s.running ? 1 : 0}|${s.unread ? 1 : 0}|${s.waiting ? 1 : 0}`)
      .join('\n');
    if (signature === this.lastSessionsSignature) { return; }
    this.lastSessionsSignature = signature;
    this.outbox.flushThenPost({ type: 'sessionsChanged', sessions, agentConnected });
  }

  // --- State assembly ------------------------------------------------------

  private refreshLiveSessionIds(): void {
    this.transcripts.setLiveSessionIds(this.sessionManager.getLiveSessions().map(s => s.sessionId));
  }

  private buildSummaries(): SessionSummary[] {
    return this.sessionManager.getLiveSessions().map(s => this.toSummary(s));
  }

  private buildSummary(sessionId: string): SessionSummary | null {
    const session = sessionOf(this.sessionManager, sessionId);
    return session ? this.toSummary(session) : null;
  }

  private toSummary(session: SessionInfo): SessionSummary {
    const stored = this.sessionManager.getHistoryStore()?.get(session.agentName, session.sessionId);
    return {
      sessionId: session.sessionId,
      agentName: session.agentName,
      // [CUSTOM- Title first, then the cached title, then the first
      // prompt — matching the history picker's fallback chain (078), not just
      // firstPrompt (which left a reopened session showing its id prefix).
      // [CUSTOM- 本地改名排在最前：覆盖就是覆盖（tab / 树跟着换名字靠这条）。
      title: this.sessionLabelTitle(session.sessionId)
        ?? session.title ?? stored?.title ?? stored?.firstPrompt ?? null,
      cwd: session.cwd,
      createdAt: session.createdAt,
      loading: this.sessionManager.isLoading(session.sessionId),
      // [CUSTOM- A turn in flight OR background work still reporting (see
      // noteBackgroundTask) — the composer's Send/Stop follows this.
      running: this.isSessionRunning(session.sessionId),
      // [CUSTOM- Drives the tab-strip "attention" dot. NOTE:
      // refreshSessions()'s signature string must include it too, or the strip
      // would never be told this changed (022's signature de-dup trap).
      unread: this.unread.has(session.sessionId),
      // [CUSTOM- A prompt or a form is parked on this session. Read from the
      // bridges — they own the pending lists, so there is exactly one copy of "who is
      // waiting" (pitfalls #19).
      waiting: (this.permissionBridge?.hasPendingFor(session.sessionId) ?? false)
        || (this.elicitationBridge?.hasPendingFor(session.sessionId) ?? false),
      // [CUSTOM- agent 选择器的第二行说明用它（2026-10-27）。
      agentKind: this.agentKindOf(session.agentName),
    };
  }

  /** [CUSTOM- summary 会在每条流式 chunk 上重建，所以 agent kind 按名字缓存。 */
  private readonly agentKindCache = new Map<string, string>();

  private agentKindOf(agentName: string): string {
    const cached = this.agentKindCache.get(agentName);
    if (cached) { return cached; }
    const kind = getAgentKind(agentName);
    this.agentKindCache.set(agentName, kind);
    return kind;
  }

  /**
   * Snapshot for the webview. Tool entries are hydrated with their view model
   * here — the raw entry only knows a `toolCallId`, so without this step a
   * session switch (or a panel re-attach) renders an empty tool card that a
   * later `tool_call_update` cannot repair.
   */
  private snapshotOf(sessionId: string): TranscriptSnapshotWire | null {
    // [CUSTOM- 快照自带 html：客户端 hydrate 之后不必再为"缺 html"跑一轮往返，
    // 那条往返正是会静默断掉的地方（见 prefillReplayMarkdown）。
    this.prefillSnapshotMarkdown(sessionId);
    const snapshot = this.transcripts.snapshot(sessionId);
    if (!snapshot) { return null; }
    return {
      sessionId: snapshot.sessionId,
      agentName: snapshot.agentName,
      entries: snapshot.entries.map(entry => {
        if (entry.kind !== 'tool') { return entry; }
        const inv = this.tools.get(sessionId, entry.toolCallId);
        if (!inv) {
          // NOT temporary (the earlier label said otherwise): a tool entry whose
          // invocation cannot be found is sent WITHOUT a view model, so the client
          // renders it as an empty shell — and this log line is the only place
          // that says WHY. 027's lesson was that the reason must be visible in the
          // output channel rather than in a webview console nobody opens, and it
          // costs one line only when the invocation is genuinely gone.
          log(`${LOG_PREFIX}: snapshot missing invocation ${entry.toolCallId} in ${sessionId}`);
          return entry;
        }
        return { ...entry, toolView: toToolCallView(inv) };
      }),
    };
  }

  /**
   * [CUSTOM- 用户自定义模型别名（`vac.customModels`），随 meta / 草稿选项下发。
   * 全局共享，读自 config 层（`readCustomModels`）。
   */
  private customModels(): CustomModel[] {
    const source = this.settingsIO.resolve('vac.customModels', 'global');
    const value = source.layers.find(entry => entry.layer === source.effective)?.value;
    return normalizeCustomModels(value);
  }

  private metaOf(sessionId: string): SessionMeta {
    const session = sessionOf(this.sessionManager, sessionId);
    return {
      sessionId,
      modes: session?.modes ?? null,
      models: session?.models ?? null,
      configOptions: session?.configOptions ?? null,
      availableCommands: wireCommands(session),
      usage: this.usage.get(sessionId) ?? null,
      // [CUSTOM- Whether Enter may send while a turn is running.
      steering: this.sessionManager.supportsSteering(sessionId),
      // Attachments live here so they survive a focus/boot round-trip; the
      // standalone `attachments` message is only for immediate feedback.
      attachments: this.attachments.get(sessionId) ?? [],
      // [CUSTOM- 额外根目录（多根工作区）——只读展示，随 focus/boot 下发。
      additionalDirectories: session?.additionalDirectories ?? [],
      // [CUSTOM- 自定义模型别名——全局共享，随 meta 下发。
      customModels: this.customModels(),
    };
  }

  /**
   * Record a failure.
   *
   * For a known session the notice goes into the transcript store and is
   * delivered as a normal `append` — the same path as every other entry, so it
   * survives a session switch and is not duplicated on the client. The
   * standalone `error` message is reserved for failures with no session to
   * attach to.
   */
  private reportError(sessionId: string | null, e: unknown): void {
    const message = errorDetail(e);
    log(`${LOG_PREFIX}: error ${message}`);
    if (!sessionId) {
      this.post({ type: 'error', message });
      return;
    }
    const entry = this.transcripts.appendNotice(sessionId, 'error', message);
    if (entry) { this.post({ type: 'append', sessionId, entries: [entry] }); }
  }
}

// --- helpers ---------------------------------------------------------------

/**
 * [CUSTOM- globalState 里的「上次打开过的会话」：条目的顺序就是 tab 的顺序。
 */
interface OpenSessionsSnapshot {
  sessions: RecoverableSession[];
  focused: string | null;
}

/**
 * [CUSTOM- 设置值的消毒：手改过的 settings.json 不该把客户端的相位机带进未知状态
 * （同 `resolveAutoConnect` 的理由）。抽成**导出的纯函数**是为了可测。
 */
export function resolveRestoreChoice(value: unknown): RestoreChoice {
  return value === 'always' || value === 'never' ? value : 'ask';
}

/**
 * [CUSTOM- The one settings interaction this host has, behind an interface
 * so tests can hand it a stub instead of writing the developer's settings.json.
 */
export interface PanelPrefsIO {
  getAutoConnect(): boolean;
  setAutoConnect(value: boolean): Promise<void>;
  // [CUSTOM- 「重开面板要不要恢复上次的会话」：ask / always / never。
  getRestore(): RestoreChoice;
  setRestore(value: RestoreChoice): Promise<void>;
}

/** [CUSTOM- Default implementation: the real VS Code configuration. */
export function vscodePanelPrefs(): PanelPrefsIO {
  const config = () => vscode.workspace.getConfiguration('vac');
  return {
    // Through the resolver: `get<boolean>` is a cast, not a runtime check, and a
    // hand-edited settings.json must not be able to feed a non-boolean to a checkbox.
    getAutoConnect: () => resolveAutoConnect(config().get<unknown>('autoConnectOnOpen')),
    setAutoConnect: async value => {
      await config().update('autoConnectOnOpen', value, vscode.ConfigurationTarget.Global);
    },
    getRestore: () => resolveRestoreChoice(config().get<unknown>('restoreSessionsOnOpen')),
    setRestore: async value => {
      await config().update('restoreSessionsOnOpen', value, vscode.ConfigurationTarget.Global);
    },
  };
}

/**
 * [CUSTOM- Default implementation: a real VS Code notification.
 *
 * Lives here rather than in SessionNotifier for the same reason `vscodePanelPrefs`
 * lives here: that module must not import vscode, or its unit test could not run
 * outside the Extension Host. `Promise.resolve` adopts the extension API's own
 * thenable, so the seam stays a plain Promise.
 */
export function vscodeNoticeChannel(): NoticeChannel {
  return {
    show: (level, message, action) => Promise.resolve(
      level === 'warning'
        ? vscode.window.showWarningMessage(message, action)
        : vscode.window.showInformationMessage(message, action),
    ),
  };
}

/** [CUSTOM- Exported for its table test: only the boolean true is true. */
export function resolveAutoConnect(raw: unknown): boolean {
  return raw === true;
}

/**
 * [CUSTOM- Which presenter interface this state belongs to. The two
 * states share `promptId` / `sessionId` / `status` but nothing else: a permission
 * prompt carries `options`, a form carries `fields`.
 */
function isElicitationState(state: PermissionState | ElicitationState): state is ElicitationState {
  return Array.isArray((state as ElicitationState).fields);
}

/**
 * [CUSTOM- How a turn ended, for the turn-done notification.
 * `silent` is the third state on purpose: a turn the USER cancelled needs no toast
 * ("你可真行，你按的 Stop 你自己知道") — but it also must not read as "已完成".
 */
interface TurnOutcome {
  silent?: boolean;
  failed?: boolean;
  detail?: string;
}

/**
 * The agent's own transcript directory for `cwd`, or null when its profile does not
 * opt into reading one. The agent's configured env wins (e.g. its `CLAUDE_CONFIG_DIR`).
 */
function transcriptDirFor(agent: string, cwd: string): string | null {
  if (profileFor(getAgentKind(agent)).transcriptStore !== 'claude') { return null; }
  return claudeTranscriptDir(cwd, { ...process.env, ...(getAgentConfig(agent)?.env ?? {}) });
}

/**
 * [CUSTOM- The one wording for a non-normal stop reason, or null when
 * there is nothing to say (`end_turn` = normal, `cancelled` = the user did it).
 *
 * Two consumers render it — the transcript notice (`applyStopReason`) and the
 * turn-done notification — so it lives in exactly one place; two hand-written
 * copies is precisely how the record and the toast end up disagreeing (#19).
 */
export function stopReasonText(stopReason: string | undefined): string | null {
  if (!stopReason || stopReason === 'end_turn' || stopReason === 'cancelled') { return null; }
  return stopReason === 'refusal'
    ? 'The agent refused to continue. This turn will not be included in the next prompt.'
    : stopReason === 'max_tokens'
      ? 'The turn was cut short by the token limit.'
      : stopReason === 'max_turn_requests'
        ? 'The turn was cut short by the agent-request limit.'
        : `Turn ended with reason: ${stopReason}`;
}

/** [CUSTOM- A finished turn → what (if anything) the notification says. */
export function turnOutcome(stopReason: string | undefined): TurnOutcome {
  if (stopReason === 'cancelled') { return { silent: true }; }
  const detail = stopReasonText(stopReason);
  return detail ? { failed: true, detail } : {};
}

/**
 * [CUSTOM- 把 agent 报的错翻译成人话：ACP 的 `RequestError` 常把真实原因藏在
 * `data.details`（`message` 只是个笼统的 "Internal error"，见 2026-10-10 用户报「切自定义模型
 * 报 Internal error」，agent 实际说的是 `Invalid value for config option model: grok-4.6`）。
 * 优先取 details，否则回落 message，再否则 String(e)。
 */
export function errorDetail(e: unknown): string {
  const err = e as { message?: unknown; data?: unknown } | null | undefined;
  const data = err?.data;
  if (data && typeof data === 'object') {
    const details = (data as { details?: unknown }).details;
    if (typeof details === 'string' && details.trim()) { return details; }
  }
  return typeof err?.message === 'string' && err.message ? err.message : String(e);
}

/**
 * [CUSTOM- The session's mode, as the config option list spells it
 * (`category === 'mode'`), or undefined when this agent does not offer one.
 *
 * One place answers "which option is the mode": the picker, the remember step and
 * the apply step all ask this, and three copies of the predicate is how they drift
 * (pitfall #19). Note it is the OPTION's own id that is returned — never the literal
 * string 'mode' — because that id is what `setConfigOption` needs.
 */
export function modeOptionOf(
  options: readonly SessionConfigOption[] | null | undefined,
): SessionConfigOption | undefined {
  return (options ?? []).find(o => (o as { category?: string }).category === 'mode');
}

/**
 * [CUSTOM- The draft page's option list, with the remembered mode shown
 * as the current value (see handleListDraftOptions).
 *
 * A pure copy: the snapshot in `draftOptions` is the agent's own last-seen state and
 * must not be rewritten with a preference — the next session's real configOptions
 * (not this display copy) is what `applyRememberedMode` validates against.
 */
export function withRememberedMode(
  options: readonly SessionConfigOption[],
  remembered: RememberedMode | undefined,
): SessionConfigOption[] {
  if (!remembered) { return options as SessionConfigOption[]; }
  return options.map(option => (option.id === remembered.configId
    // The union (select | boolean) does not survive a spread — the cast is the shape
    // the spread cannot express, not a lie about the value.
    ? { ...option, currentValue: remembered.value } as SessionConfigOption
    : option));
}

function sessionOf(manager: SessionManager, sessionId: string): SessionInfo | undefined {
  return manager.getSession(sessionId);
}

/**
 * [CUSTOM- ACP 的 `AvailableCommand` → 协议里的命令视图。
 *
 * 宿主里只有这一份映射：`metaOf`（会话）与草稿页快照（还没有会话）必须给出同一个形状，
 * 否则客户端要按来源分两套读法——那正是 pitfalls #19 说的"跨边界的重复知识"。
 */
function wireCommands(session: SessionInfo | undefined): SessionMeta['availableCommands'] {
  return (session?.availableCommands ?? []).map(c => ({
    name: c.name,
    description: c.description,
    inputHint: (c.input as any)?.hint ?? null,
  }));
}

/**
 * [CUSTOM- Tab 顺序来自 webview，只信它是个字符串数组，并且有上限：
 * 一个坏掉的客户端（或手改过的 state）不该让这条偏好无限长，也不该把非字符串写进 globalState。
 */
function sanitizeTabOrder(value: unknown): string[] {
  if (!Array.isArray(value)) { return []; }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || out.includes(entry)) { continue; }
    out.push(entry);
    if (out.length >= 200) { break; }
  }
  return out;
}

/**
 * [CUSTOM- 把新会话插到源会话右边。`tabOrder` 里可能留着已关闭 / 待恢复的 id
 * （客户端会忽略不存在的），所以先原样保留，再把不在表里的 live 会话按宿主顺序补齐 ——
 * 这正是客户端 `tabModels()` 的排序规则；只 push 新 id 会让源会话不在表里时新 tab 排到末尾。
 */
export function insertSessionAfter(
  tabOrder: readonly string[],
  liveIds: readonly string[],
  sourceId: string,
  newSessionId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of tabOrder) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) { continue; }
    seen.add(id);
    out.push(id);
  }
  for (const id of liveIds) {
    if (typeof id !== 'string' || id.length === 0 || id === newSessionId || seen.has(id)) { continue; }
    seen.add(id);
    out.push(id);
  }
  const existing = out.indexOf(newSessionId);
  if (existing >= 0) { out.splice(existing, 1); }
  const source = out.indexOf(sourceId);
  if (source >= 0) { out.splice(source + 1, 0, newSessionId); }
  else { out.push(newSessionId); }
  return out;
}

/**
 * [CUSTOM- 「会话 id → 开/关」这张表的消毒器（Times 与大纲侧栏的开/关共用）。
 *
 * 来源是 webview，所以只信它的**形状**：键必须是非空短字符串（会话 id 的实际字符集，防手改过的
 * state 塞进来一整篇文本）、值只收布尔、条数有上限（同 `sanitizeTabOrder`：这两张表都随用户动作
 * 增长，客户端已经在写之前裁过，上限是第二道闸）。非对象 = 什么都没留下 ⇒ 空表 —— 与
 * `sanitizeTabOrder` 对"不是数组"的处理**同形**。"这一轮没改它"是另一件事，由调用方按
 * "字段缺不缺"判断，不靠这里的返回值。
 *
 * [CUSTOM- 从 `sanitizeTimesMap` 改名而来：大纲侧栏的按会话开关与它**同一形状**，
 * 共用一份比抄第二份强（两份迟早漂移 —— pitfalls #19）。
 */
function sanitizeSessionFlags(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
  const out: Record<string, boolean> = {};
  let count = 0;
  for (const [key, on] of Object.entries(value as Record<string, unknown>)) {
    if (typeof on !== 'boolean' || !/^[A-Za-z0-9._-]{1,80}$/.test(key)) { continue; }
    out[key] = on;
    count += 1;
    if (count >= 200) { break; }
  }
  return out;
}

/** Validate that a message's sessionId names a live session; else return null. */
function verifySession(manager: SessionManager, msg: { sessionId?: string }): string | null {
  const sessionId = msg?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) { return null; }
  return manager.getSession(sessionId) ? sessionId : null;
}

/** 自动展开的类型白名单：只有这三种卡片有可展开的折叠面。 */
const AUTO_EXPAND_KINDS = ['tool', 'thought', 'diff'] as const;

function sanitizeAutoExpandKinds(value: unknown): string[] {
  if (!Array.isArray(value)) { return []; }
  const out: string[] = [];
  for (const entry of value) {
    const kind = String(entry);
    if ((AUTO_EXPAND_KINDS as readonly string[]).includes(kind) && !out.includes(kind)) { out.push(kind); }
    if (out.length >= AUTO_EXPAND_KINDS.length) { break; }
  }
  return out;
}

/** 自动展开卡片的限高：0 = 不限；其余夹到 80–2000px（亚像素取整到整数）。 */
function clampExpandHeight(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) { return fallback; }
  if (n <= 0) { return 0; }
  return Math.max(80, Math.min(2000, Math.round(n)));
}

/** 通用数值夹紧：非数字落回默认值，整数取整。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) { return fallback; }
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** [CUSTOM- Markdown 渲染预设的合法值（设置面板与 setUiPref 共用一处白名单）。 */
export function resolveMarkdownStyle(value: unknown): 'editor' | 'github' | 'obsidian' | 'typora' | 'atom' | 'minimal' | 'things' {
  return value === 'github' || value === 'obsidian' || value === 'typora'
    || value === 'atom' || value === 'minimal' || value === 'things' ? value : 'editor';
}

/** agent → 默认模型 id 的小表（键/值都有长度上限，最多 20 条）。 */
function sanitizeStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object') { return out; }
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 20) { break; }
    const name = String(key).trim().slice(0, 80);
    const modelId = typeof raw === 'string' ? raw.trim().slice(0, 120) : '';
    if (!name) { continue; }
    if (!modelId) { continue; }
    out[name] = modelId;
    count += 1;
  }
  return out;
}

/** `vac.agents` 的形状校验：必须是 name → { command: string, ... } 的对象。 */
function sanitizeAgentsConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent configuration must be a JSON object.');
  }
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Agent "${name}" must be a JSON object.`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.command !== 'string' || !entry.command.trim()) {
      throw new Error(`Agent "${name}" needs a non-empty "command".`);
    }
    out[name] = entry;
  }
  return out;
}

/**
 * [CUSTOM- 快照里那条会话是在哪个 IDE 里开着的（VS Code / Insiders / VSCodium / Cursor…）。
 * 各 fork 默认各用各的 userData，快照本来不会串；portable 或共享 `--user-data-dir` 时会，
 * 所以按条记下来、只用于标注，不参与任何筛选。
 */
function ideLabel(): string | undefined {
  const name = vscode.env.appName?.trim();
  if (!name) { return undefined; }
  if (/insiders/i.test(name)) { return 'VS Code Insiders'; }
  if (/vscodium/i.test(name)) { return 'VSCodium'; }
  if (/cursor/i.test(name)) { return 'Cursor'; }
  if (/visual studio code/i.test(name)) { return 'VS Code'; }
  return name;
}

function toolKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}::${toolCallId}`;
}

/**
 * [CUSTOM- Union the agent's history rows with the local cache's.
 *
 * The agent's row wins field by field (it is the authority on what still exists), and a
 * session only the cache knows about is marked `fromCache` so the client can say where it
 * came from — such a row may have been deleted agent-side, and pretending otherwise would
 * make the picker look authoritative when it is not. Sorted newest first, because the
 * picker's whole point is "the sessions I was just in".
 */
function mergeHistoryRows(
  ...sources: Array<Array<Omit<HistorySessionSummary, 'dirKey'>>>
): Array<Omit<HistorySessionSummary, 'dirKey'>> {
  // First source wins per field ('agent' beats 'transcripts' beats 'cache'), and a row
  // only a later source knows about keeps that source's mark so the client can say where
  // it came from — such a row may no longer exist agent-side, and pretending otherwise
  // would make the picker look authoritative when it is not.
  const byId = new Map<string, Omit<HistorySessionSummary, 'dirKey'>>();
  for (let i = sources.length - 1; i >= 0; i--) {
    for (const row of sources[i]) { byId.set(row.sessionId, row); }
  }
  return Array.from(byId.values()).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

function textOf(content: unknown): string {
  if (!content || typeof content !== 'object') { return ''; }
  const block = content as { type?: string; text?: unknown };
  return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

// [CUSTOM- 注入块（<task-notification> 等）不是用户输入，却走同一个
// user chunk 通道 —— 渲染成蓝色用户气泡会把"agent 的回报"误读成"我说过这句话"。
// 判据是前缀（与 diskSessions.ts:66 的 <local-command 先例同一类）。
const INJECTED_PREFIXES = [
  '<task-notification', '<system-reminder', '<local-command', '<command-name', '<command-message',
  // [CUSTOM- 其它 IDE 上下文块（`<ide_selection>` / `<ide_diagnostics>` …）也不是
  // 用户说过的话：认不出形状时至少别渲染成蓝色气泡。认得出来的那个（`<ide_opened_file>`）走下面
  // 的专用通道，变成消息上的文件 chip。
  '<ide_',
];

// [CUSTOM- IDE 注入的"当前打开的文件"上下文。
const IDE_OPENED_FILE_BLOCK = /^\s*<ide_opened_file>([\s\S]*?)<\/ide_opened_file>\s*$/;

/**
 * [CUSTOM- 从 IDE 上下文块里取出文件路径；不是这个块就返回 null。
 *
 * 它是**上下文**，不是用户说过的话 —— 用户报的"附加的文件被拆成了两条对话"就是它：这个块以前按
 * 普通 user chunk 走，于是同一条消息渲染成**两个**蓝色气泡（一个只有 `<ide_opened_file>…` 的原文，
 * 一个才是正文）。官方插件把它渲染成消息上的一个**文件 chip**（同一气泡里、正文在下），这里照做 ——
 * 块本身不建记录，文件挂到同一条消息的用户气泡上（见 user_message_chunk 分支）。
 */
function ideOpenedFilePath(text: string): string | null {
  const m = IDE_OPENED_FILE_BLOCK.exec(text);
  if (!m) { return null; }
  const named = /opened the file\s+(.+?)\s+in the IDE/i.exec(m[1]);
  if (named) { return named[1].trim(); }
  // 措辞若变了也不能把它变回蓝色气泡：退一步找第一个像路径的片段（盘符，或以 / 开头）。
  const guess = /([A-Za-z]:[\\/][^\s<>"']+|\/[^\s<>"']+)/.exec(m[1]);
  return guess ? guess[1].trim() : null;
}

/** [CUSTOM- 路径 → 用户气泡上那个文件 chip 的视图（点它走 openFile，见 039）。 */
function ideFileChip(filePath: string): ContentBlockView {
  const name = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
  return { type: 'resource_link', uri: filePath, name, title: name, path: filePath };
}

/**
 * [CUSTOM- `readActiveFileFrom` 要的那几样（**结构子集**，不是 vscode.TextEditor 全量）
 * —— 抽出来是为了**可测**：真 `vscode.window.activeTextEditor` 在测试宿主里造不出来，而"1 基行号 /
 * 停在下一行行首不算"这类判据值得钉住（同 `pickDefaultCwd` 的既有做法：把 vscode 外壳与纯函数分开）。
 */
export interface ActiveEditorLike {
  document: { uri: { scheme: string; fsPath: string } };
  selection: {
    isEmpty: boolean;
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/**
 * [CUSTOM- 编辑器里当前打开的文件 + 选区的行区间（1 基、含两端），喂给输入框的引用栏。
 *
 * **行号是 0 基、界面上是 1 基**：这里统一换成 1 基。选区若停在下一行的行首（character 0），那一行
 * 不算选中 —— 与编辑器自己的显示一致（否则从第 3 行拖到第 5 行开头会显示成 3-5，而编辑器显示 3-4）。
 * **单行选区也算行选择**（2026-10-27 用户报：选中一行里的几个字时识别不出行号）：返回
 * `lineStart === lineEnd` 的单行区间，而不是退化成整个文件。只有**空选区**（光标停留）才引用整个文件。
 * 没有可见编辑器、或不是本地文件（`untitled:` / 虚拟文档）时返回 null。
 */
export function readActiveFileFrom(
  editor: ActiveEditorLike | undefined,
): { path: string; name: string; lineStart?: number; lineEnd?: number } | null {
  if (!editor || editor.document.uri.scheme !== 'file') { return null; }
  const path = editor.document.uri.fsPath;
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const sel = editor.selection;
  if (!sel || sel.isEmpty) { return { path, name }; }
  let endLine = sel.end.line;
  if (sel.end.character === 0 && endLine > sel.start.line) { endLine -= 1; }
  return { path, name, lineStart: sel.start.line + 1, lineEnd: endLine + 1 };
}

/** [CUSTOM- IDE 上下文的暂存键：会话 + messageId（回放里同一消息的两条 chunk 靠它配对）。 */
function ideKey(sessionId: string, messageId: string): string {
  return `${sessionId}::${messageId}`;
}

/**
 * [CUSTOM- 两条引用是不是**同一条**：路径 + 行区间。
 *
 * 同一个文件的不同段是**不同的引用**（用户可以引用 foo.cs 的 12-40 行和 5-9 行两次，207 的要求）；
 * 没有区间的（拖拽/粘贴进来的文件、图片）按路径比 —— 与它们原来的行为一致。
 */
function sameReference(a: Attachment, b: Attachment): boolean {
  if (a.path !== b.path) { return false; }
  return (a.lineStart ?? 0) === (b.lineStart ?? 0) && (a.lineEnd ?? 0) === (b.lineEnd ?? 0);
}

function isInjectedChunk(text: string): boolean {
  const t = text.trimStart();
  for (const p of INJECTED_PREFIXES) { if (t.startsWith(p)) { return true; } }
  return false;
}

/**
 * [CUSTOM- A background task reporting back (Claude Code injects these
 * into the session when a `run_in_background` sub-agent finishes).
 *
 * Separate from `isInjectedChunk` on purpose: that one answers "is this the user
 * speaking" (five prefixes), this one answers "did the work we were waiting for
 * finish" (one). Reusing the wider predicate would end the wait on any injection.
 */
function isTaskNotification(text: string): boolean {
  return text.trimStart().startsWith('<task-notification');
}

/** [CUSTOM- The agent just launched a background task (Task 工具的 run_in_background)。 */
function isBackgroundLaunch(rawInput: unknown): boolean {
  if (!rawInput || typeof rawInput !== 'object') { return false; }
  const flag = (rawInput as Record<string, unknown>).run_in_background;
  return flag === true || flag === 'true';
}

/**
 * [CUSTOM- Which updates count as "still working".
 *
 * Deliberately NOT every notification: `session_info_update` / `available_commands_update` /
 * `current_mode_update` / `usage_update` are housekeeping and can arrive while the agent
 * is idle — counting them would pin a Stop button onto a session with nothing running.
 */
function isWorkUpdate(update: { sessionUpdate?: string }): boolean {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'tool_call':
    case 'tool_call_update':
      return true;
    default:
      return false;
  }
}

/** 剥掉外层 <tag>…</tag>，取第一行可见内容。 */
function stripInjectionWrapper(text: string): string {
  const t = text.trim();
  const m = t.match(/^<[a-z][\w-]*>/);
  if (!m) { return t; }
  const closeTag = '</' + m[0].slice(1);
  const inner = t.endsWith(closeTag) ? t.slice(m[0].length, -closeTag.length) : t.slice(m[0].length);
  return inner.trim();
}

function firstLineOf(text: string): string {
  const nl = text.indexOf('\n');
  const line = nl >= 0 ? text.slice(0, nl) : text;
  return line.trim() || '(no content)';
}

function fileUri(path: string, cwd?: string): vscode.Uri {
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')) {
    return vscode.Uri.file(path);
  }
  // Relative paths resolve against the session's working directory.
  const base = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  return vscode.Uri.file(base ? `${base}/${path}` : path);
}

/** [CUSTOM- Strip `data:image/png;base64,` from a data URL (ACP `image.data` wants raw base64). */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
