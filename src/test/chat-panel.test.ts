// 聊天面板的宿主侧回归测试（真实 replay 夹具驱动）。
//
// **它存在的理由**：2026-09-25 用户报"重开会话看到的内容与实时不一样"，而这条链路
// （`session/load` → replay → 重建 transcript）此前**没有任何自动检查**——排查只能靠
// 人肉看截图 + 猜，一次迭代一个来回。这个文件把那类问题变成可自动复现的断言。
//
// **测什么（宿主侧协议流）**：用真实抓包的 `session/update` 流驱动 `ChatPanelHost`，
// 断言它**准备发给 webview 的每一条消息**。这样能判定的问题：
// · replay 里的正文有没有被静默丢掉；
// · 有没有记录永远停在 `streaming: true`（会导致客户端 aria-busy 卡住、读屏静默）；
// · 快照（boot/hydrate）与增量（append）是否一致。
//
// **为什么不测 DOM**：这一层不需要。上面三类问题全都能在协议流上判定，而这样测试不依赖
// webview、跑得快、也不会因为布局细节而脆。**布局类问题**（空白条、条目被压扁、diff 被
// 折叠、按钮化后外观错位）需要另一层"真 webview + 客户端回传 DOM dump"的测试——
// 那层没写，所以那类问题仍然只能人工验收（见 docs/03-验收清单.md）。
//
// **夹具从哪来**：`scripts/capture-acp-replay.mjs` 用真实 agent 抓的。
// 协议形状变了才需要重抓；抓包脚本的用法写在该文件头。
import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
// [CUSTOM- Builds a valid file: URI for whatever platform runs the tests.
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';

import type { SessionNotification } from '@agentclientprotocol/sdk';

import type { PromptResponse, SessionConfigOption } from '@agentclientprotocol/sdk';
// [CUSTOM- The background-form test builds a real AskUserQuestion request.
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk';

import { AgentManager } from '../core/AgentManager';
import { ConnectionManager, type ConnectionInfo } from '../core/ConnectionManager';
import { SessionHistoryStore } from '../core/SessionHistoryStore';
import { SessionManager, pickDefaultCwd, type SessionInfo } from '../core/SessionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
// [CUSTOM- The tab dot's "waiting" state is read from these two bridges.
import { PermissionBridge } from '../handlers/PermissionBridge';
import { ElicitationBridge } from '../handlers/ElicitationBridge';
import { fileLinkTarget, isBlankText, toContentView } from '../ui/chat/content/contentBlocks';
// [CUSTOM- The markdown link router under test.
import { SafeMarkdown } from '../ui/chat/markdown';
import { choiceChanges, choiceSnapshotFromState, choiceSnapshotPatched } from '../ui/chat/sessionChoices';
import { directoryKey, directoryOptions, recentDirectoryList } from '../ui/chat/historyDirs';
import { readDiskSessions, readTranscriptTimes } from '../ui/chat/diskSessions';
import { ToolInvocationStore } from '../ui/chat/transcript/ToolInvocationStore';
import { DEFAULT_SHORTCUTS, defaultShortcutMap } from '../ui/chat/shortcuts';
// [CUSTOM- 子 agent 身份要一路走到视图模型（卡片头那个 chip 的来源）。
import { toToolCallView } from '../ui/chat/content/toolCalls';
import type { ChatSurface, SurfaceKey } from '../ui/chat/ChatSurface';
// [CUSTOM- `resolveAutoConnect` / `PanelPrefsIO` are exported so this
// file can drive the settings seam with a stub instead of the developer's settings.json.
import { ChatPanelHost, insertSessionAfter, resolveAutoConnect, type PanelPrefsIO } from '../ui/chat/ChatPanelHost';
// [CUSTOM- The notification seam (see RecordingChannel).
import type { NoticeChannel } from '../ui/chat/SessionNotifier';
import {
  stopReasonText, turnOutcome, readActiveFileFrom,
  resolveRestoreChoice, errorDetail,
} from '../ui/chat/ChatPanelHost';
// [CUSTOM- 归一化迁到 config 层。
import { normalizeCustomModels } from '../config/CustomModels';
// [CUSTOM- 模型列表 CAS 基线（宿主写入测试用它构造"打开编辑器时"的基线）。
import { modelListBaseline } from '../config/ModelListSync';
// [CUSTOM- 设置面板的配置读写缝（测试桩走这里，不碰开发者的 settings.json / ~/.vac）。
import type { SettingIO } from '../config/SettingScope';
import type { SettingLayer, SettingSource, SettingWriteTarget } from '../config/GlobalSettings';
import type { RestoreChoice } from '../ui/chat/protocol';
import type { ActiveEditorLike } from '../ui/chat/ChatPanelHost';
import type { ExtToChatMessage, TranscriptSnapshotWire } from '../ui/chat/protocol';
import type { EntryPatch, TranscriptEntry } from '../ui/chat/transcript/types';

const FIXTURE_PATH = path.resolve(
  __dirname, '..', '..', 'src', 'test', 'fixtures', 'claude-code-session-load.json',
);

interface FixtureNotification {
  phase: string;
  turn: number;
  at: number;
  update: SessionNotification;
}

interface Fixture {
  capturedAt: string;
  agentInfo?: { name?: string; version?: string };
  sessionId: string | null;
  prompts?: string[];
  notifications: FixtureNotification[];
  error?: string | null;
}

function loadFixture(): Fixture | null {
  if (!fs.existsSync(FIXTURE_PATH)) { return null; }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
}

/**
 * Captures everything the host would have posted into a webview.
 *
 * A stub rather than a real `WebviewPanel` on purpose: the question here is
 * "what did the host decide to send", and a real panel would add a renderer
 * process to the loop without answering it. `ChatSurface` is a six-member
 * interface, so a faithful stub is cheap.
 */
class RecordingSurface implements ChatSurface {
  constructor(readonly key: SurfaceKey = 'view') {}
  readonly sent: ExtToChatMessage[] = [];
  html = '';
  reveals = 0;
  // [CUSTOM- Settable so a test can hide the panel behind an editor:
  // "the user is not looking at it" is now what decides card-vs-notification.
  visibleFlag = true;
  readonly webview = {
    options: {} as vscode.WebviewOptions,
    cspSource: 'vscode-webview://chat-panel-test',
    postMessage: (message: ExtToChatMessage) => {
      this.sent.push(message);
      return Promise.resolve(true);
    },
  } as unknown as vscode.Webview;

  get visible(): boolean { return this.visibleFlag; }
  setHtml(html: string): void { this.html = html; }
  reveal(): void { this.reveals++; }
  onDidDispose(): vscode.Disposable { return new vscode.Disposable(() => { /* nothing */ }); }
}

/**
 * Register a session as live without standing up an agent connection.
 *
 * `ChatPanelHost` resolves the session on every record (`getSession` for the agent
 * name, `getLiveSessions` for the tab strip). Spawning a real Claude Code process just
 * to satisfy that lookup would make this file credentialed, slow and flaky — so the
 * session is seeded through the manager's test seam instead of a real `session/new`.
 */
function registerFakeSession(
  manager: SessionManager,
  sessionId: string,
  agentName: string,
  seed: Record<string, unknown> = {},
): Record<string, unknown> {
  const session: Record<string, unknown> = {
    sessionId,
    agentId: 'fake-agent-id',
    agentName,
    agentDisplayName: agentName,
    cwd: '/tmp',
    createdAt: new Date().toISOString(),
    initResponse: {},
    modes: null,
    models: null,
    configOptions: null,
    availableCommands: [],
  };
  Object.assign(session, seed);
  manager.seedSession(session as unknown as Parameters<SessionManager['seedSession']>[0]);
  // Returned so callers can reproduce "registered first, fields written later"
  // (see the draft-page snapshot cases) on this very object.
  return session;
}

/** Minimal in-memory Memento — touches no real user or workspace settings. */
class FakeMemento {
  private readonly store = new Map<string, unknown>();
  keys(): readonly string[] { return Array.from(this.store.keys()); }
  get<T>(key: string, fallback?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : fallback;
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.store.delete(key); } else { this.store.set(key, value); }
    return Promise.resolve();
  }
}

interface Harness {
  host: ChatPanelHost;
  surface: RecordingSurface;
  handler: SessionUpdateHandler;
  sessionManager: SessionManager;
  sessionId: string;
  agentName: string;
  /** [CUSTOM- The settings seam the host was given. */
  prefs: StubPrefs;
  /** [CUSTOM- The notification seam the host was given. */
  notices: RecordingChannel;
  /** [CUSTOM- The settings read/write seam the host was given. */
  settingsIO: StubSettingIO;
}

/**
 * [CUSTOM- Captures the notifications the host decided to send.
 *
 * The same reason `StubPrefs`/`FakeMemento` exist: this suite must not pop real
 * VS Code notifications (the test host swallows them, so there would be nothing to
 * assert). Clicking is driven explicitly — `answer()` is what a user's click does.
 */
class RecordingChannel implements NoticeChannel {
  readonly shown: Array<{ level: string; message: string; action: string }> = [];
  private readonly resolvers: Array<(choice: string | undefined) => void> = [];

  show(level: 'info' | 'warning', message: string, action: string): Promise<string | undefined> {
    this.shown.push({ level, message, action });
    return new Promise(resolve => { this.resolvers.push(resolve); });
  }

  /** Press the action button on the n-th notification. */
  async click(index: number): Promise<void> {
    this.resolvers[index](this.shown[index].action);
    // The notifier's .then runs on a microtask; give it one turn to reach the host.
    await Promise.resolve();
  }
}

/**
 * [CUSTOM- Stands in for `vscode.workspace.getConfiguration`.
 *
 * The same reason `FakeMemento` exists: this suite must not read or write the developer's
 * real settings. It also makes the interesting failure reachable — a write that throws —
 * which a real configuration object will not do on demand.
 */
class StubPrefs implements PanelPrefsIO {
  readonly writes: boolean[] = [];
  failWith: Error | null = null;
  // [CUSTOM- 「重开面板要不要恢复上次的会话」也在这一条注入缝上。
  readonly restoreWrites: RestoreChoice[] = [];
  constructor(private value = false, private restore: RestoreChoice = 'ask') {}
  getAutoConnect(): boolean { return this.value; }
  async setAutoConnect(value: boolean): Promise<void> {
    this.writes.push(value);
    if (this.failWith) { throw this.failWith; }
    this.value = value;
  }
  getRestore(): RestoreChoice { return this.restore; }
  async setRestore(value: RestoreChoice): Promise<void> {
    this.restoreWrites.push(value);
    if (this.failWith) { throw this.failWith; }
    this.restore = value;
  }
}

/**
 * [CUSTOM- Stands in for the settings read/write seam (VS Code config + ~/.vac/config.json).
 * `globalValue` lets a test drive the cross-IDE layer; writes are recorded instead of applied.
 */
class StubSettingIO implements SettingIO {
  readonly writes: Array<{ key: string; value: unknown; target: SettingWriteTarget }> = [];
  readonly cleared: Array<{ key: string; layer: 'workspace' | 'user' | 'global' }> = [];
  readonly opened: string[] = [];
  failWrites = false;
  private globalValue: unknown;

  constructor(initial?: unknown) { this.globalValue = initial; }

  resolve(key: string, defaultScope: 'global' | 'ide'): SettingSource {
    const layers: Array<{ layer: Exclude<SettingLayer, 'panel'>; value?: unknown }> = [
      { layer: 'workspace' },
      { layer: 'user' },
      { layer: 'global', value: this.globalValue },
      { layer: 'default', value: [] },
    ];
    const effective = this.globalValue === undefined ? 'default' : 'global';
    const writeTarget: SettingWriteTarget = effective === 'default'
      ? (defaultScope === 'global' ? 'global' : 'user')
      : 'global';
    return { effective, writeTarget, layers };
  }

  async write(key: string, value: unknown, target: SettingWriteTarget): Promise<void> {
    if (this.failWrites) { throw new Error('settings write failed'); }
    this.writes.push({ key, value, target });
    if (target === 'global') { this.globalValue = value; }
  }

  async clear(key: string, layer: 'workspace' | 'user' | 'global'): Promise<void> {
    this.cleared.push({ key, layer });
    if (layer === 'global') { this.globalValue = undefined; }
  }

  async open(layer: 'workspace' | 'user' | 'global'): Promise<void> { this.opened.push(layer); }
}

function makeHarness(
  sessionId: string,
  agentName = 'Claude Code',
  managerFactory?: (handler: SessionUpdateHandler) => SessionManager,
  prefs = new StubPrefs(),
  // [CUSTOM- Optional bridges: the tab dot's "waiting" state is read from
  // them, and a test needs to be able to park a request on a session.
  bridges: { permission?: PermissionBridge; elicitation?: ElicitationBridge } = {},
  // [CUSTOM- Optional globalState: the draft page's option snapshot is
  // persisted there, and "survives a window reload" is only testable with one.
  globalState?: vscode.Memento,
  // [CUSTOM- How long a background task may stay quiet before the panel
  // stops waiting. Millisecond-scale in tests; the host's default is two minutes.
  backgroundQuietMs?: number,
  // [CUSTOM- 设置面板的配置读写缝；不传则用默认桩（不碰真实配置）。
  settingsIO = new StubSettingIO(),
): Harness {
  const handler = new SessionUpdateHandler();
  const sessionManager = managerFactory
    ? managerFactory(handler)
    : new SessionManager(new AgentManager(), new ConnectionManager(handler), handler);
  registerFakeSession(sessionManager, sessionId, agentName);
  // [CUSTOM- A recording notification channel: the host's default is
  // the real VS Code notification, which a test host swallows silently.
  const notices = new RecordingChannel();
  const host = new ChatPanelHost(
    vscode.Uri.file('/tmp/chat-panel-test'), sessionManager, handler,
    bridges.permission, globalState, bridges.elicitation, prefs, notices, backgroundQuietMs, settingsIO,
  );
  const surface = new RecordingSurface();
  host.attachSurface(surface, { agentName, sessionId });
  return { host, surface, handler, sessionManager, sessionId, agentName, prefs, notices, settingsIO };
}

function feed(harness: Harness, notifications: readonly FixtureNotification[]): void {
  for (const notification of notifications) {
    harness.handler.handleUpdate(notification.update);
  }
}

/**
 * Play a replay the way `SessionManager.loadSession` does: every notification,
 * then the `session-load-end` event.
 *
 * Emitting the event is part of the lifecycle, not decoration — it is what tells
 * the host the (finite) replay is over and anything still open must be closed.
 * Feeding only the notification stream would test a sequence that never happens
 * in the product.
 */
function feedReplay(harness: Harness, notifications: readonly FixtureNotification[]): void {
  // [CUSTOM- session-load-start 也是生命周期的一部分：它让宿主进入「回放计时」态，
  // 回放记录才按 0 起的相对时刻打 atIsElapsed（拿不到真实时刻时不再用 Date.now()）。
  harness.sessionManager.emit('session-load-start', harness.sessionId, harness.agentName);
  feed(harness, notifications);
  harness.sessionManager.emit('session-load-end', harness.sessionId, harness.agentName, true);
}

function phaseOf(fixture: Fixture, phase: string): FixtureNotification[] {
  return fixture.notifications.filter(n => n.phase === phase);
}

// --- 协议流 → 记录（判据用，不是渲染器的复制品）---------------------------
// 这是一个**极简**的归约：只为了把文本取出来做断言。它刻意不模仿任何布局或补丁细节，
// 所以它不会随客户端渲染逻辑漂移；如果哪天它需要"也处理一下样式"，那说明测错了层。

interface TranscriptState {
  entries: TranscriptEntry[];
  patched: Map<string, EntryPatch>;
}

function reduce(sent: readonly ExtToChatMessage[]): TranscriptState {
  let entries: TranscriptEntry[] = [];
  const patched = new Map<string, EntryPatch>();
  for (const message of sent) {
    if (message.type === 'boot' || message.type === 'focus') {
      // A snapshot REPLACES the transcript (the client hydrates), so the model
      // does too — including the `null` case, which resets to empty.
      const snapshot = (message as { snapshot: TranscriptSnapshotWire | null }).snapshot;
      entries = snapshot ? [...snapshot.entries] : [];
    } else if (message.type === 'append') {
      entries.push(...message.entries);
    } else if (message.type === 'revise') {
      patched.set(message.entryId, { ...(patched.get(message.entryId) ?? {}), ...message.patch });
    }
  }
  return { entries, patched };
}

/**
 * Flush the coalescing queue, then read the state a client would be showing.
 *
 * The host batches non-structural messages (`append` / `revise` / `toolUpdate`)
 * through `Outbox` and only flushes on a 16ms timer or right before a structural
 * message. A synchronous test therefore sees an EMPTY append stream unless it
 * forces a flush — which is a property of the test, not a bug in the host.
 *
 * `onFocusChanged` is used as the flush because it is public and, more
 * importantly, because it is **exactly what the path under test produces**: a
 * fresh `focus` snapshot is what re-opening or re-focusing a session gives the
 * client. So this asserts "what a re-open would show", which is the reported
 * symptom verbatim.
 */
function settle(harness: Harness, agentName: string, sessionId: string): TranscriptState {
  harness.host.onFocusChanged({ agentName, sessionId });
  return reduce(harness.surface.sent);
}

/** Entry text with any `revise` patches applied, as the client would show it. */
function visibleText(state: TranscriptState): string {
  return state.entries
    .map(entry => {
      const patch = state.patched.get(entry.id) as { text?: string } | undefined;
      return patch?.text ?? textOfEntry(entry);
    })
    .join('\n');
}

function textOfEntry(entry: TranscriptEntry): string {
  const withText = entry as { text?: string };
  return typeof withText.text === 'string' ? withText.text : '';
}

/** Non-blank prose the agent sent in one phase, in order. */
function proseChunks(notifications: readonly FixtureNotification[]): Array<{ kind: string; text: string }> {
  const out: Array<{ kind: string; text: string }> = [];
  for (const n of notifications) {
    const update = (n.update as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }).update;
    const kind = update?.sessionUpdate;
    if (kind !== 'agent_message_chunk' && kind !== 'user_message_chunk') { continue; }
    const content = update?.content;
    const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
    if (text.trim().length === 0) { continue; }
    out.push({ kind: kind === 'user_message_chunk' ? 'user' : 'assistant', text });
  }
  return out;
}

function kindHistogram(notifications: readonly FixtureNotification[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const n of notifications) {
    const kind = (n.update as { update?: { sessionUpdate?: string } }).update?.sessionUpdate ?? '?';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** Entries still marked as streaming — the client never gets a finalize for these. */
function danglingStreaming(state: TranscriptState): string[] {
  return state.entries
    .filter(e => (e as { streaming?: boolean }).streaming === true)
    .map(e => `${e.kind}:${e.id}`);
}

// --- 测试 ----------------------------------------------------------------

// Loaded once at module scope: both suites use it, and a missing fixture should
// produce one clear failure rather than a confusing one per test.
const fixture = loadFixture();

// --- 每会话工作目录（）---------------------------------

suite('chat panel: default working directory policy', () => {
  const WS = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
  const PROC = process.platform === 'win32' ? 'C:\\process' : '/process';
  const EXISTS = (p: string) => p === WS;
  const REL = process.platform === 'win32' ? 'relative\\dir' : 'relative/dir';

  // The chain exists because `vac.defaultWorkingDirectory` was declared in
  // package.json and read by NOTHING — the same "declared but never wired"
  // shape as `vac.turnInProgress` (pitfalls #5). These cases pin the policy.

  test('an unset setting falls through to the workspace folder', () => {
    assert.deepStrictEqual(pickDefaultCwd(undefined, WS, PROC, EXISTS), { cwd: WS, reason: 'workspace' });
    assert.deepStrictEqual(pickDefaultCwd('   ', WS, PROC, EXISTS), { cwd: WS, reason: 'workspace' });
  });

  test('no workspace folder at all falls through to process.cwd()', () => {
    assert.deepStrictEqual(pickDefaultCwd(undefined, undefined, PROC, EXISTS), { cwd: PROC, reason: 'process' });
  });

  test('a valid absolute directory wins', () => {
    assert.deepStrictEqual(pickDefaultCwd(WS, undefined, PROC, EXISTS), { cwd: WS, reason: 'configured' });
  });

  test('a RELATIVE setting is rejected rather than resolved by the extension host', () => {
    // A relative path would be resolved against the extension host's cwd, which
    // the user cannot see — so it must never reach session/new.
    const decision = pickDefaultCwd(REL, WS, PROC, EXISTS);
    assert.strictEqual(decision.cwd, WS);
    assert.strictEqual(decision.ignoredConfigured, 'relative');
  });

  test('a setting pointing at something that is not a directory is rejected', () => {
    const missing = pickDefaultCwd(`${WS}-nope`, WS, PROC, EXISTS);
    assert.strictEqual(missing.cwd, WS);
    assert.strictEqual(missing.ignoredConfigured, 'missing');
  });
});

suite('chat panel: recent directories for the picker', () => {
  const entry = (agentName: string, cwd: string, sessionId: string, lastActiveAt: string) => ({
    agentName, cwd, sessionId, createdAt: lastActiveAt, lastActiveAt,
  });

  function storeWith(entries: unknown[]): SessionHistoryStore {
    const memento = new FakeMemento();
    // Seeded through the store's own persisted shape (and its deliberate
    // Memento key, see pitfall #4) so we control the timestamps exactly —
    // `upsertNew` stamps "now", which would make ordering assertions flaky.
    void memento.update('vac.sessionHistory.v1', { version: 1, entries });
    return new SessionHistoryStore(memento as unknown as vscode.Memento);
  }

  test('directories are de-duplicated and most-recently-active first', () => {
    const store = storeWith([
      entry('Claude Code', '/a', 's1', '2026-01-01T00:00:00Z'),
      entry('Claude Code', '/b', 's2', '2026-03-01T00:00:00Z'),
      entry('Claude Code', '/a', 's3', '2026-02-01T00:00:00Z'),
    ]);
    assert.deepStrictEqual(store.recentDirectories('Claude Code'), ['/b', '/a']);
  });

  test('other agents and entries without a cwd are excluded', () => {
    const store = storeWith([
      entry('Claude Code', '/a', 's1', '2026-01-01T00:00:00Z'),
      entry('GitHub Copilot', '/elsewhere', 's2', '2026-09-01T00:00:00Z'),
      entry('Claude Code', '', 's3', '2026-09-01T00:00:00Z'),
    ]);
    assert.deepStrictEqual(store.recentDirectories('Claude Code'), ['/a']);
  });

  // [CUSTOM- 用户 2026-10-28 报：抽屉的「Recently used」里同一条路径出现两次，只有盘符大小写不同。
  // 原因是两个来源（本地缓存 / agent 的 session/list）各记一种写法，而去重比的是**原字符串**。
  test('同一目录只差大小写 ⇒ 只留一条（第一次出现的写法胜出）', () => {
    const list = recentDirectoryList([
      'D:/work/example-project',
      'd:/work/example-project',
      'D:/work/other-project',
    ], 8, [], 'win32');
    assert.deepStrictEqual(list, [
      'D:/work/example-project',
      'D:/work/other-project',
    ], '重复行消失，顺序不变');
  });

  test('反斜杠 / 尾斜杠也算同一个目录；删掉的那条按同一性一起过滤', () => {
    const list = recentDirectoryList([
      'D:\\Work\\Repo\\',
      'd:/work/repo',
      'D:/other',
    ], 8, ['d:\\work\\repo'], 'win32');
    assert.deepStrictEqual(list, ['D:/other'],
      '用户删的是 d:\\work\\repo ⇒ 它的其它写法也不能从另一条来源漏出来');
  });

  test('Linux 上大小写是两个目录（归一化只按平台规则来）', () => {
    assert.deepStrictEqual(recentDirectoryList(['/Home/Me', '/home/me'], 8, [], 'linux'),
      ['/Home/Me', '/home/me']);
  });

  test('limit 是去重之后再截断的', () => {
    assert.deepStrictEqual(recentDirectoryList(['/a', '/A', '/b', '/c'], 2, [], 'win32'), ['/a', '/b']);
  });

  // [CUSTOM- 2026-10-30：条数范围放宽到 0–30。0 是「不显示该分组」，不是 falsy 回落。
  test('limit 0 表示一条都不列（0 不会被当成"没设置"）', () => {
    assert.deepStrictEqual(recentDirectoryList(['/a', '/b'], 0, [], 'win32'), []);
  });

  test('limit 30 生效（旧的 16 上限已移除）', () => {
    const paths = Array.from({ length: 35 }, (_, i) => `/dir/${i}`);
    const list = recentDirectoryList(paths, 30, [], 'linux');
    assert.strictEqual(list.length, 30);
    assert.strictEqual(list[29], '/dir/29');
  });
});

suite('chat panel: isBlankText polarity', () => {
  // [CUSTOM- This one-line predicate shipped INVERTED for a day
  // ( → 055) and every automated check stayed green, because
  // nothing about a swapped `return true` / `return false` is visible to the
  // compiler — and its name made the wrong behaviour look right. These cases are
  // the cheapest possible guard against a repeat.
  //
  // Zero-width characters are built with String.fromCharCode on purpose: pasting
  // them into the source as literals makes the file unreadable and is exactly
  // what pitfalls #12 is about.
  const ZWSP = String.fromCharCode(0x200b);
  const BOM = String.fromCharCode(0xfeff);
  const WORD_JOINER = String.fromCharCode(0x2060);

  test('empty-ish input is blank', () => {
    assert.strictEqual(isBlankText(''), true);
    assert.strictEqual(isBlankText(undefined), true);
    assert.strictEqual(isBlankText(null), true);
  });

  test('whitespace-only is blank', () => {
    assert.strictEqual(isBlankText(' '), true);
    assert.strictEqual(isBlankText('\n\n'), true);
    assert.strictEqual(isBlankText('\t \r\n'), true);
  });

  test('zero-width characters alone are blank', () => {
    assert.strictEqual(isBlankText(ZWSP), true);
    assert.strictEqual(isBlankText(BOM), true);
    assert.strictEqual(isBlankText(WORD_JOINER), true);
    assert.strictEqual(isBlankText(ZWSP + BOM + WORD_JOINER + '\n'), true);
  });

  test('anything a reader can see is NOT blank', () => {
    assert.strictEqual(isBlankText('a'), false);
    assert.strictEqual(isBlankText(' a '), false);
    assert.strictEqual(isBlankText('| File | Lines |'), false);
    assert.strictEqual(isBlankText('\n\nThree files in this directory'), false);
    assert.strictEqual(isBlankText(ZWSP + 'x'), false);
  });

  test('every real prose chunk in the captured replay is NOT blank', function () {
    // Ground truth rather than invented cases: these are the exact strings whose
    // misclassification dropped assistant prose and thoughts from every
    // re-opened session.
    if (!fixture) { return this.skip(); }
    const chunks = proseChunks(fixture.notifications);
    assert.ok(chunks.length > 0, 'fixture carried no prose to check');
    for (const chunk of chunks) {
      assert.strictEqual(
        isBlankText(chunk.text), false,
        `a real ${chunk.kind} chunk was classified as blank: `
        + JSON.stringify(chunk.text.slice(0, 60)),
      );
    }
  });
});

suite('chat panel: history picker carries the session directory', () => {
  // [CUSTOM- The picker shows sessions from OTHER directories (it
  // is the agent's list, not this workspace's). Until this change the host had
  // nothing to hand the agent but the current workspace, so a session belonging
  // to `D:\some\other\project` was reopened as if it lived here.

  /** A recording subclass, not a hand-written double: everything else stays the
   * real implementation (and returns 'live' so nothing reaches the wire). */
  class RecordingSessionManager extends SessionManager {
    readonly opened: Array<{ agentName: string; sessionId: string; cwd?: string; title?: string }> = [];
    override async openExistingSession(
      agentName: string,
      sessionId: string,
      opts: { cwd?: string; title?: string } = {},
    ): Promise<'live' | 'load' | 'resume'> {
      this.opened.push({ agentName, sessionId, cwd: opts.cwd, ...(opts.title ? { title: opts.title } : {}) });
      return 'live';
    }
  }

  function harnessWithRecorder(): { harness: Harness; manager: RecordingSessionManager } {
    let manager!: RecordingSessionManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new RecordingSessionManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    return { harness, manager };
  }

  /** [CUSTOM- The open is no longer the handler's first await — the host
   * reads the transcript timeline before replaying — so a single microtask is not
   * enough: wait for the effect instead. */
  async function waitForOpen(manager: RecordingSessionManager): Promise<void> {
    for (let i = 0; i < 100 && manager.opened.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  test("a session's own directory is passed through to the open call", async function () {
    const { harness, manager } = harnessWithRecorder();
    harness.host.onMessage({
      type: 'openHistorySession',
      agentName: 'Claude Code',
      sessionId: 'other-session',
      cwd: 'D:\\other\\project',
    });
    await Promise.resolve();
    await waitForOpen(manager);
    assert.deepStrictEqual(manager.opened, [
      { agentName: 'Claude Code', sessionId: 'other-session', cwd: 'D:\\other\\project' },
    ]);
  });

  test('an omitted directory stays undefined, so loadSession can fall back to the cache', async function () {
    const { harness, manager } = harnessWithRecorder();
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 's' });
    await waitForOpen(manager);
    assert.strictEqual(manager.opened.length, 1);
    assert.strictEqual(manager.opened[0].cwd, undefined);
  });

  test('the title travels with the open call, so the tab matches the list', async function () {
    // [CUSTOM- The replay does not always re-send session_info_update,
    // so the title must ride along with the click — otherwise the tab shows the id
    // prefix while the picker showed the name.
    const { harness, manager } = harnessWithRecorder();
    harness.host.onMessage({
      type: 'openHistorySession',
      agentName: 'Claude Code',
      sessionId: 'other-session',
      title: 'The session name',
    });
    await waitForOpen(manager);
    assert.strictEqual(manager.opened.length, 1);
    assert.strictEqual(manager.opened[0].title, 'The session name');
  });

  test('tracked restore reports completion only to the requesting surface', async () => {
    const { harness } = harnessWithRecorder();
    const editor = new RecordingSurface('editor');
    harness.host.attachSurface(editor, { agentName: harness.agentName, sessionId: 'dummy-session' });
    harness.surface.sent.length = 0;
    editor.sent.length = 0;
    harness.host.onMessage({
      type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'replayed',
      keepOthers: true, trackRestore: true,
    }, 'editor');
    for (let i = 0; i < 100 && !editor.sent.some(m => m.type === 'restoreFinished'); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepStrictEqual(editor.sent.filter(m => m.type === 'restoreFinished'), [
      { type: 'restoreFinished', sessionId: 'replayed', ok: true },
    ]);
    assert.strictEqual(harness.surface.sent.some(m => m.type === 'restoreFinished'), false);
  });

  test('an invalid tracked restore still returns completion', async () => {
    const { harness } = harnessWithRecorder();
    harness.surface.sent.length = 0;
    harness.host.onMessage({
      type: 'openHistorySession', agentName: 'Claude Code', sessionId: '', trackRestore: true,
    }, 'view');
    await Promise.resolve();
    assert.deepStrictEqual(harness.surface.sent.filter(m => m.type === 'restoreFinished'), [
      { type: 'restoreFinished', sessionId: '', ok: false },
    ]);
  });

  test('picking a history session replaces the focused tab instead of adding one', async function () {
    // [CUSTOM- Reported: every visit to the history list added another
    // tab ("还是会自动新建并切换到新 session"). A history list is navigation — the
    // session being left steps aside so the picked one takes its place.
    class ReplacingManager extends SessionManager {
      readonly closed: string[] = [];
      override async closeSession(agentName: string, sessionId: string): Promise<void> {
        this.closed.push(sessionId);
        return super.closeSession(agentName, sessionId);
      }
      override async openExistingSession(): Promise<'live' | 'load' | 'resume'> { return 'live'; }
    }
    let manager!: ReplacingManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new ReplacingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'other-session' });

    for (let i = 0; i < 100 && manager.closed.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepStrictEqual(manager.closed, ['dummy-session'],
      'the focused session must step aside so the tab count does not grow');
  });

  test('a history session that is already a tab is focused, nothing closes', async function () {
    // The other half: there is nothing to replace when the pick is already live —
    // closing it would be destroying the tab the user just clicked.
    class ReplacingManager extends SessionManager {
      readonly closed: string[] = [];
      override async closeSession(agentName: string, sessionId: string): Promise<void> {
        this.closed.push(sessionId);
        return super.closeSession(agentName, sessionId);
      }
      override async openExistingSession(): Promise<'live' | 'load' | 'resume'> { return 'live'; }
    }
    let manager!: ReplacingManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new ReplacingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    registerFakeSession(harness.sessionManager, 'other-session', 'Claude Code');
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'other-session' });

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepStrictEqual(manager.closed, [], 'an already-live pick must not close anything');
  });
});

suite('chat panel: opening a history session while disconnected', () => {
  // [CUSTOM- Reported: before connecting anything, the history picker
  // listed sessions ("3 sessions · from the local cache" — by design, the cache is
  // readable offline) and every click answered
  // Agent "Claude Code" does not support loading or resuming sessions.
  // Capabilities come from the ACP `initialize` handshake, so an agent that was never
  // connected has NONE — and the old code read that as "unsupported".
  //
  // The REAL `openExistingSession` runs here (only the ACP boundary is faked): that is
  // where the decision lives, and both the panel's picker and the tree's
  // `vac.openSession` command go through it.

  /** Records the order of the calls; capabilities appear only after connecting. */
  class ConnectOnDemandManager extends SessionManager {
    readonly calls: string[] = [];
    private connected = false;

    override async ensureConnected(agentName: string): Promise<any> {
      this.calls.push(`ensureConnected:${agentName}`);
      this.connected = true;
      return {} as any;
    }

    override getCachedCapabilities(): any {
      return this.connected ? { load: true, resume: true } : undefined;
    }

    override async loadSession(agentName: string, sessionId: string, requestedCwd?: string): Promise<any> {
      this.calls.push(`loadSession:${sessionId}:${requestedCwd ?? ''}`);
      return {} as any;
    }
  }

  async function settle(manager: { calls: string[] }, expected: number): Promise<void> {
    for (let i = 0; i < 100 && manager.calls.length < expected; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  test('the click connects first, then loads the session with its own directory', async () => {
    let manager!: ConnectOnDemandManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new ConnectOnDemandManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;

    harness.host.onMessage({
      type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'old-session', cwd: 'D:\\old',
    });
    await settle(manager, 2);

    assert.deepStrictEqual(manager.calls, [
      'ensureConnected:Claude Code',       // capabilities are unknowable without this
      'loadSession:old-session:D:\\old',   // and the session's OWN directory is used
    ]);
    assert.strictEqual(
      harness.surface.sent.filter(m => m.type === 'error').length, 0,
      'no error notice: the agent supports session/load, we just had to ask it',
    );
  });

  test('an agent that genuinely cannot replay still reports the error, after connecting', async () => {
    // The guard that must survive: connecting must not turn a real capability gap into
    // a silent no-op.
    class UnsupportedManager extends ConnectOnDemandManager {
      override getCachedCapabilities(): any { return {}; }
    }
    let manager!: UnsupportedManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new UnsupportedManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'old-session' });
    await settle(manager, 1);
    for (let i = 0; i < 100 && harness.surface.sent.filter(m => m.type === 'error').length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.deepStrictEqual(manager.calls, ['ensureConnected:Claude Code'], 'no load was attempted');
    const errors = harness.surface.sent.filter(m => m.type === 'error') as Array<{ message?: string }>;
    assert.strictEqual(errors.length, 1);
    assert.ok(/does not support/.test(errors[0].message ?? ''), errors[0].message);
  });
});

suite('chat panel: draft page creates the session on first send', () => {
  // [CUSTOM- The draft page exists so that the directory is chosen
  // BEFORE a session exists. That has two host-side consequences worth pinning:
  // the chosen directory must reach `createSession`, and a failure must leave the
  // draft alone (the client keeps the tab and the typed text).

  class DraftSessionManager extends SessionManager {
    readonly created: Array<{ agentName: string; cwd?: string }> = [];
    readonly sent: Array<{ sessionId: string; prompt: unknown }> = [];
    readonly ensured: string[] = [];
    failCreateWith: string | null = null;
    // [CUSTOM- The session the draft creates carries a real config-option list
    // (the draft's picks are validated against it), and the applies are recorded in order with
    // the send — "before the first message" is the whole point of applying them there.
    configOptionsForNew: unknown[] | null = null;
    readonly applied: Array<{ configId: string; value: string }> = [];
    readonly order: string[] = [];
    failApplyWith: string | null = null;

    override async ensureConnected(agentName: string): Promise<ConnectionInfo> {
      this.ensured.push(agentName);
      return {} as ConnectionInfo;
    }

    override async createSession(
      agentName: string,
      opts: { focus?: boolean; cwd?: string } = {},
    ): Promise<SessionInfo> {
      if (this.failCreateWith) { throw new Error(this.failCreateWith); }
      this.created.push({ agentName, cwd: opts.cwd });
      const sessionId = `draft-session-${this.created.length}`;
      registerFakeSession(this, sessionId, agentName, { configOptions: this.configOptionsForNew });
      return {
        sessionId,
        agentId: 'fake-agent-id',
        agentName,
        agentDisplayName: agentName,
        cwd: opts.cwd ?? '',
        createdAt: new Date().toISOString(),
        initResponse: {},
        modes: null,
        models: null,
        configOptions: this.configOptionsForNew,
        availableCommands: [],
      } as unknown as SessionInfo;
    }

    override async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[] | null> {
      if (this.failApplyWith) { throw new Error(this.failApplyWith); }
      this.applied.push({ configId, value });
      this.order.push(`apply:${configId}=${value}`);
      // Mirror the real one: the agent's response IS the new option list, and the host's switch
      // baseline is read back from it. A stub that does not write it would make the "applying a
      // draft pick must not announce a switch" invariant untestable (and untrue in the test).
      const options = (this.getSession(sessionId)?.configOptions ?? []) as Array<Record<string, unknown>>;
      const next = options.map(option => (option.id === configId ? { ...option, currentValue: value } : option));
      this.applyConfigOptions(sessionId, next as unknown as SessionConfigOption[]);
      return next as unknown as SessionConfigOption[];
    }

    override async sendPrompt(sessionId: string, prompt: unknown): Promise<PromptResponse> {
      this.sent.push({ sessionId, prompt });
      this.order.push('send');
      return { stopReason: 'end_turn' } as PromptResponse;
    }
  }

  /** The host's handlers are async and fire-and-forget; wait for their effects. */
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  function draftHarness(memento?: FakeMemento): { harness: Harness; manager: DraftSessionManager } {
    let manager!: DraftSessionManager;
    const harness = makeHarness('placeholder-session', 'Claude Code', handler => {
      manager = new DraftSessionManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    }, new StubPrefs(), {}, memento as unknown as vscode.Memento | undefined);
    harness.surface.sent.length = 0;   // drop the attach-time boot noise
    return { harness, manager };
  }

  function messagesOf(harness: Harness, type: string): Array<Record<string, unknown>> {
    return harness.surface.sent.filter(m => m.type === type) as Array<Record<string, unknown>>;
  }

  test('the chosen directory reaches createSession, then the prompt is sent', async function () {
    const { harness, manager } = draftHarness();
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd1', cwd: '/chosen/dir', text: 'hello',
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    assert.deepStrictEqual(manager.created, [{ agentName: 'Claude Code', cwd: '/chosen/dir' }]);
    assert.strictEqual(manager.sent.length, 1, 'exactly one prompt');
    assert.strictEqual(manager.sent[0].sessionId, 'draft-session-1');

    const resolved = messagesOf(harness, 'draftResolved');
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].draftId, 'd1');
    assert.strictEqual(resolved[0].sessionId, 'draft-session-1');
    assert.strictEqual(messagesOf(harness, 'draftFailed').length, 0);
  });

  // [CUSTOM- 草稿页粘的图必须**跟着首条消息进 agent**。
  // 用户报的是"New Session 的输入框没法粘贴图片"—— 以前客户端在"没有会话"处就拒了，
  // 而现在图先本地攒着、随 createDraftAndSend 交上来，宿主建完会话再走**同一条**附件通道。
  test('an image pasted on the draft page rides into the first prompt', async () => {
    const { harness, manager } = draftHarness();
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd1', cwd: '/dir', text: '看看这张图',
      images: [{ id: 'img-1', name: 'pasted.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,QUJD' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    const blocks = manager.sent[0].prompt as Array<Record<string, unknown>>;
    assert.deepStrictEqual(blocks.map(b => b.type), ['text', 'image'],
      'the image rides with the very first prompt, not a second turn');
    assert.strictEqual(blocks[1].data, 'QUJD', 'the data URL prefix is stripped before the wire');
    assert.strictEqual(blocks[1].mimeType, 'image/png');
    // 面板要被通知到（与普通 attachImage 同一条通道）。注意会有两条：一条是落账、
    // 一条是 handleSendPrompt 发完把附件清空（`attachments: []`）—— 所以看第一条。
    const attachmentMsgs = messagesOf(harness, 'attachments');
    assert.ok(attachmentMsgs.length >= 1, 'the panel is told about the attachment');
    const listed = attachmentMsgs[0].attachments as Array<Record<string, unknown>>;
    assert.deepStrictEqual(listed.map(a => a.path), ['img-1'],
      'and it is the same shape a normal attachImage produces (path = the image id)');
  });

  test('an image with no text is a valid draft send', async () => {
    const { harness, manager } = draftHarness();
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd2', cwd: '/dir', text: '   ',
      images: [{ id: 'img-2', name: 'p.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,QUJD' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');
    assert.strictEqual(messagesOf(harness, 'draftFailed').length, 0,
      'an attachment alone is something to send (the client allows it too)');
  });

  test('an empty draft is refused without creating anything', async function () {
    const { harness, manager } = draftHarness();
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd2', cwd: '/dir', text: '   ',
    });
    await waitFor(() => messagesOf(harness, 'draftFailed').length > 0, 'draftFailed');
    assert.deepStrictEqual(manager.created, [], 'no session may be created for an empty draft');
    assert.strictEqual(messagesOf(harness, 'draftResolved').length, 0);
  });

  test('a failed creation reports back and does NOT resolve the draft', async function () {
    const { harness, manager } = draftHarness();
    manager.failCreateWith = 'agent would not start';
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd3', cwd: '/dir', text: 'hello',
    });
    await waitFor(() => messagesOf(harness, 'draftFailed').length > 0, 'draftFailed');

    const failed = messagesOf(harness, 'draftFailed')[0];
    assert.strictEqual(failed.draftId, 'd3');
    assert.match(String(failed.message), /agent would not start/);
    // The client keeps the draft AND its typed text on this path.
    assert.strictEqual(messagesOf(harness, 'draftResolved').length, 0);
  });

  test('directory choices carry the workspace folders, recents and the default', async function () {
    const { harness } = draftHarness();
    harness.host.onMessage({ type: 'listDirectoryChoices' });
    await waitFor(() => messagesOf(harness, 'directoryChoices').length > 0, 'directoryChoices');

    const reply = messagesOf(harness, 'directoryChoices')[0];
    assert.ok(Array.isArray(reply.workspaceFolders), 'workspaceFolders must be an array');
    assert.ok(Array.isArray(reply.recent), 'recent must be an array');
    assert.strictEqual(typeof reply.defaultCwd, 'string');
    assert.ok((reply.defaultCwd as string).length > 0, 'the default must never be empty');
    assert.strictEqual(reply.autoAddWorkspaceFolders, false, 'auto-add is off by default');
  });

  test('connect only ensures the process — it does not create a session', async function () {
    // Creating one here would leave an empty session in the agent's history for a
    // user who only wanted to check that the agent starts.
    const { harness, manager } = draftHarness();
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => manager.ensured.length > 0, 'ensureConnected');
    assert.deepStrictEqual(manager.ensured, ['Claude Code']);
    assert.deepStrictEqual(manager.created, [], 'connect must not create a session');
  });

  // [CUSTOM- 草稿页的输入卡要"显示完整"（模式/模型/斜杠命令）。这些在 ACP 里
  // 都是**会话级**的（`session/new` 没有 mode/model 入参），草稿按定义还没有会话 —— 所以宿主
  // 回的是「该 agent 上一次会话的快照」。钉住三条：没有快照也必须回话、快照跟着会话走、
  // 快照跨窗口重载存活（否则全新窗口点「+」时输入卡还是空的，那正是用户报的现象）。
  const SNAPSHOT_OPTIONS = [
    {
      id: 'mode', name: 'Mode', description: 'Session permission mode', category: 'mode',
      type: 'select', currentValue: 'plan',
      options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan' }],
    },
  ];

  function seedAgentOptions(manager: SessionManager, sessionId: string, options: unknown[]): void {
    registerFakeSession(manager, sessionId, 'Claude Code', {
      configOptions: options,
      availableCommands: [{ name: 'compact', description: 'Compact the conversation', input: { hint: 'what to keep' } }],
    });
    // The host learns the snapshot from these two events (it subscribes to both).
    manager.emit('config-options-changed', sessionId);
    manager.emit('available-commands-changed', sessionId);
  }

  test('with no known snapshot the reply is empty — but it IS a reply', function () {
    const { harness } = draftHarness();
    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd1' });

    const replies = messagesOf(harness, 'draftOptions');
    assert.strictEqual(replies.length, 1, 'the client waits for this reply (pitfall #29)');
    assert.strictEqual(replies[0].draftId, 'd1');
    assert.strictEqual(replies[0].agentName, 'Claude Code');
    assert.deepStrictEqual(replies[0].configOptions, []);
    assert.deepStrictEqual(replies[0].availableCommands, []);
  });

  test('the snapshot is the agent\'s last session, commands included', function () {
    const { harness, manager } = draftHarness();
    seedAgentOptions(manager, 'seeded-session', SNAPSHOT_OPTIONS);

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd2' });
    const reply = messagesOf(harness, 'draftOptions')[0];
    assert.deepStrictEqual(reply.configOptions, SNAPSHOT_OPTIONS);
    assert.deepStrictEqual(reply.availableCommands, [
      { name: 'compact', description: 'Compact the conversation', inputHint: 'what to keep' },
    ]);
  });

  test('the real notification chain fills the snapshot (nobody emits the event by hand)', function () {
    const { harness, manager } = draftHarness();
    registerFakeSession(manager, 'live-session', 'Claude Code');

    // Drive the notification the agent actually sends. `seedAgentOptions` above emits the
    // events by hand, which is exactly why the broken chain stayed invisible: nobody was
    // asking *who* emits them. This test asks.
    harness.handler.handleUpdate({
      sessionId: 'live-session',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact', description: 'Compact the conversation', input: { hint: 'what to keep' } }],
      } as unknown as SessionNotification['update'],
    });

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd-real' });
    assert.deepStrictEqual(messagesOf(harness, 'draftOptions')[0].availableCommands, [
      { name: 'compact', description: 'Compact the conversation', inputHint: 'what to keep' },
    ]);
  });

  test('a command notification that beats registration is parked, drained, and reaches the snapshot', function () {
    const { harness, manager } = draftHarness();
    // The agent starts pushing before the `session/new` response lands. The host's own
    // listener drops notifications for unknown sessions, so core has to park them
    // (PendingSessionState) and drain on registration.
    harness.handler.handleUpdate({
      sessionId: 'late-session',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'review', description: 'Review the diff' }],
      } as unknown as SessionNotification['update'],
    });
    registerFakeSession(manager, 'late-session', 'Claude Code');
    manager.emit('session-created', 'late-session', 'Claude Code');

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd-late' });
    assert.deepStrictEqual(messagesOf(harness, 'draftOptions')[0].availableCommands, [
      { name: 'review', description: 'Review the diff', inputHint: null },
    ]);
  });

  test('the snapshot survives a window reload (globalState)', function () {
    const memento = new FakeMemento();
    const first = draftHarness(memento);
    seedAgentOptions(first.manager, 'seeded-session', SNAPSHOT_OPTIONS);

    // A reloaded window: no live session carries these options any more, only globalState.
    const second = draftHarness(memento);
    second.harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd3' });
    assert.deepStrictEqual(
      messagesOf(second.harness, 'draftOptions')[0].configOptions, SNAPSHOT_OPTIONS,
      'a fresh window must still be able to render the full composer');
  });

  test('opening a history session does not empty the snapshot (load writes its options late)', function () {
    const { harness, manager } = draftHarness();
    // `loadSession` registers the placeholder FIRST, emits `session-created`, and only writes
    // the response's configOptions afterwards — and it does not go through
    // `applyConfigOptions`. Missing the second read leaves the draft page with no pickers right
    // after the user opened a history session, which is the reported symptom all over again.
    const placeholder = registerFakeSession(manager, 'loading-session', 'Claude Code');
    manager.emit('session-created', 'loading-session');
    placeholder.configOptions = SNAPSHOT_OPTIONS;
    manager.emit('session-load-end', 'loading-session', 'Claude Code', true);

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd-load' });
    assert.deepStrictEqual(messagesOf(harness, 'draftOptions')[0].configOptions, SNAPSHOT_OPTIONS);
  });

  test('an empty list does not displace a good snapshot (resume reports no commands)', function () {
    const { harness, manager } = draftHarness();
    seedAgentOptions(manager, 'with-options', SNAPSHOT_OPTIONS);
    // `resumeSession` returns `availableCommands: []` and never replays, so taking its empty
    // answer at face value would erase the slash list — a "degenerated" snapshot is worse than
    // a stale one, because stale only means "a value that gets skipped when the session exists".
    registerFakeSession(manager, 'resumed-session', 'Claude Code', { configOptions: SNAPSHOT_OPTIONS });
    manager.emit('session-created', 'resumed-session');

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd-resume' });
    const reply = messagesOf(harness, 'draftOptions')[0];
    assert.deepStrictEqual(reply.configOptions, SNAPSHOT_OPTIONS);
    assert.deepStrictEqual(reply.availableCommands, [
      { name: 'compact', description: 'Compact the conversation', inputHint: 'what to keep' },
    ]);
  });

  // --- 阶段 3：草稿上选的值怎么落到新建的会话上 ---------------------------------
  // [CUSTOM- 会话存在之前没有地方可下发，所以选择随 createDraftAndSend 一起走，
  // 并在首条消息**之前**应用。三条边界：陈旧的选项要跳过、单项失败不能挡住发消息、应用本身
  // 不能被当成一次"切换"播报出来。

  const NEW_SESSION_OPTIONS = [
    {
      id: 'mode', name: 'Mode', description: 'Session permission mode', category: 'mode',
      type: 'select', currentValue: 'default',
      options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan' }],
    },
    {
      id: 'model', name: 'Model', description: 'AI model to use', category: 'model',
      type: 'select', currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }],
    },
  ];

  /** Every notice text the host appended to a session (read through the coalescing queue). */
  function noticesOf(harness: Harness): string[] {
    const out: string[] = [];
    for (const message of messagesOf(harness, 'append')) {
      for (const entry of (message.entries as Array<Record<string, unknown>>) ?? []) {
        if (entry.kind === 'notice') { out.push(String(entry.text)); }
      }
    }
    return out;
  }

  test('the picks are applied to the new session BEFORE its first message', async function () {
    const { harness, manager } = draftHarness();
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd1', cwd: '/dir', text: 'hello',
      configSelections: [{ configId: 'mode', value: 'plan' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    assert.deepStrictEqual(manager.applied, [{ configId: 'mode', value: 'plan' }]);
    assert.deepStrictEqual(manager.order, ['apply:mode=plan', 'send'],
      'the first turn has to run with what the draft page showed');
  });

  // [CUSTOM- 用户报「发送第一个消息时先顿一下，输入框和消息面板才一起刷新」。
  // `session/new` 本身省不掉（agent 侧 sdk-initialize），但界面不必陪它等：
  // 会话一回来就发 draftResolved / 画用户气泡；配置落地只是发送前的闸门。
  test('the draft resolves and the bubble shows before the picks land; only the send waits', async function () {
    let releaseApply!: () => void;
    const applyGate = new Promise<void>(resolve => { releaseApply = resolve; });
    class GatedApplyManager extends DraftSessionManager {
      override async setConfigOption(sessionId: string, configId: string, value: string) {
        await applyGate;
        return super.setConfigOption(sessionId, configId, value);
      }
    }
    let manager!: GatedApplyManager;
    const harness = makeHarness('placeholder-session', 'Claude Code', handler => {
      manager = new GatedApplyManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;

    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd1', cwd: '/dir', text: 'hello',
      configSelections: [{ configId: 'mode', value: 'plan' }],
    });
    const appendedEntries = () => messagesOf(harness, 'append').flatMap(
      message => (message.entries as Array<Record<string, unknown>>) ?? []);
    await waitFor(
      () => messagesOf(harness, 'draftResolved').length === 1
        && appendedEntries().some(entry => entry.kind === 'user' && entry.text === 'hello'),
      'the draft to resolve and the bubble to show',
    );
    assert.strictEqual(manager.sent.length, 0,
      'the prompt itself is still behind the picks (first turn runs on them)');

    releaseApply();
    await waitFor(() => manager.sent.length === 1, 'the prompt after the picks');
    assert.deepStrictEqual(manager.order, ['apply:mode=plan', 'send']);
  });

  test('a model picked on the draft page is applied BEFORE the first message (and sticks)', async function () {
    // [CUSTOM- 用户报「草稿页选好自定义模型，发出消息后自己变回内置模型」。
    // 这条把顺序钉住：apply 必须在 send 之前，且会话最后那份 configOptions 就是用户选的。
    const { harness, manager } = draftHarness();
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd5', cwd: '/dir', text: 'hi',
      configSelections: [{ configId: 'model', value: 'opus' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    assert.deepStrictEqual(manager.applied, [{ configId: 'model', value: 'opus' }]);
    assert.deepStrictEqual(manager.order, ['apply:model=opus', 'send'],
      'the first turn has to run with the model the draft page showed');
    const model = (manager.getSession(manager.sent[0].sessionId)?.configOptions ?? [])
      .find(option => (option as { category?: string }).category === 'model') as { currentValue?: unknown };
    assert.strictEqual(String(model?.currentValue), 'opus',
      'the session must still carry the picked model after the turn starts');
    assert.strictEqual(messagesOf(harness, 'draftResolved').length, 1);
    assert.strictEqual(messagesOf(harness, 'draftFailed').length, 0);
  });

  test('a value this session no longer offers is skipped, and the message still goes out', async function () {
    const { harness, manager } = draftHarness();
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd2', cwd: '/dir', text: 'hi',
      configSelections: [
        { configId: 'mode', value: 'plan' },
        { configId: 'ghost', value: 'x' },
        { configId: 'model', value: 'haiku-9000' },
      ],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    assert.deepStrictEqual(manager.applied, [{ configId: 'mode', value: 'plan' }],
      'only the pick this session still recognises may be sent to the agent');
    assert.strictEqual(messagesOf(harness, 'draftFailed').length, 0);
  });

  test('a pick the agent rejects is reported, not silently snapped back', async function () {
    const { harness, manager } = draftHarness();
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;
    manager.failApplyWith = 'agent refused';
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd3', cwd: '/dir', text: 'hi',
      configSelections: [{ configId: 'mode', value: 'plan' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');
    await waitFor(() => noticesOf(harness).length > 0, 'the failure notice');

    assert.match(noticesOf(harness)[0], /Mode/);
    assert.strictEqual(manager.sent.length, 1, 'a failed pick must not block the message');
  });

  test('applying the picks is not announced as a switch the user never made', async function () {
    const { harness, manager } = draftHarness();
    manager.configOptionsForNew = NEW_SESSION_OPTIONS;
    harness.host.onMessage({
      type: 'createDraftAndSend', draftId: 'd4', cwd: '/dir', text: 'hi',
      configSelections: [{ configId: 'mode', value: 'plan' }],
    });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');
    const sessionId = manager.sent[0].sessionId;

    // The agent then reports the state we just applied — the usual `config_option_update`.
    harness.handler.handleUpdate({
      sessionId,
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: (manager.getSession(sessionId)?.configOptions ?? []),
      } as unknown as SessionNotification['update'],
    });
    await new Promise(resolve => setTimeout(resolve, 40));   // let the coalescing queue flush
    assert.deepStrictEqual(noticesOf(harness), [],
      'the session started in that mode; the user never switched to it');
  });
});

suite('chat panel: unread marker for background sessions', () => {
  // [CUSTOM- The marker lives on the HOST (it alone knows both "which
  // session got output" and "which one is focused"), so it is observable from the
  // protocol stream — no DOM needed.

  const chunk = (sessionId: string, text: string): FixtureNotification => ({
    phase: 'live',
    turn: 1,
    at: Date.now(),
    update: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    } as unknown as SessionNotification,
  });

  interface SummaryWire { sessionId: string; unread: boolean }

  function summaries(harness: Harness): SummaryWire[] {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as { type?: string; sessions?: SummaryWire[] };
      if (message.type === 'sessionsChanged') { return message.sessions ?? []; }
    }
    return [];
  }

  test('output on a BACKGROUND session marks it unread; focusing clears it', function () {
    const harness = makeHarness('session-A', 'Claude Code');
    registerFakeSession(harness.sessionManager, 'session-B', 'Claude Code');
    harness.surface.sent.length = 0;

    harness.handler.handleUpdate(chunk('session-B', 'output while you were away').update);

    const marked = summaries(harness).find(s => s.sessionId === 'session-B');
    assert.ok(marked, 'sessionsChanged must mention session B');
    assert.strictEqual(marked.unread, true,
      'output on a non-focused session must mark it unread — and the strip has to be '
      + 'told, which only happens if refreshSessions includes unread in its signature');

    // Focusing it consumes the marker.
    harness.sessionManager.emit('active-session-changed', 'session-B', 'Claude Code');
    const afterFocus = summaries(harness).find(s => s.sessionId === 'session-B');
    assert.strictEqual(afterFocus?.unread, false, 'focusing a session must clear its unread marker');
  });

  test('output on the FOCUSED session is never unread', function () {
    const harness = makeHarness('session-A', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate(chunk('session-A', 'this is the one you are watching').update);
    const focused = summaries(harness).find(s => s.sessionId === 'session-A');
    assert.strictEqual(focused?.unread, false);
  });
});

suite('chat panel: real session/load replay', () => {

  test('fixture exists and covers both phases', function () {
    if (!fixture) {
      // 夹具缺失时给出可操作的信息，而不是一个看不懂的失败。
      assert.fail(
        `missing fixture ${FIXTURE_PATH} — regenerate it with:\n`
        + '  node scripts/capture-acp-replay.mjs',
      );
    }
    if (fixture.error) {
      assert.fail(`fixture was captured with an error: ${fixture.error}`);
    }
    assert.ok(fixture.notifications.length > 0, 'fixture has no notifications');
    assert.ok(phaseOf(fixture, 'replay').length > 0, 'fixture has no replay notifications');
    assert.ok(
      fixture.agentInfo?.name !== undefined,
      'fixture does not name the agent it was captured from',
    );
  });

  test('replay: no prose from the agent is silently dropped', function () {
    if (!fixture?.sessionId) { this.skip(); }
    const replay = phaseOf(fixture, 'replay');
    const chunks = proseChunks(replay);
    assert.ok(chunks.length > 0, 'replayed stream carried no prose at all');

    const harness = makeHarness(fixture.sessionId);
    feedReplay(harness, replay);
    const state = settle(harness, 'Claude Code', fixture.sessionId);
    const transcript = visibleText(state);

    for (const chunk of chunks) {
      const needle = chunk.text.trim();
      assert.ok(
        transcript.includes(needle),
        `${chunk.kind} prose missing from a re-opened transcript: ${JSON.stringify(needle.slice(0, 90))}\n`
        + `the replay carried ${chunks.length} prose chunks; the transcript has `
        + `${state.entries.length} records: ${state.entries.map(e => e.kind).join(',')}`,
      );
    }
  });

  test('replay: no entry is left dangling as streaming', function () {
    if (!fixture?.sessionId) { this.skip(); }
    const harness = makeHarness(fixture.sessionId);
    feedReplay(harness, phaseOf(fixture, 'replay'));
    const dangling = danglingStreaming(settle(harness, 'Claude Code', fixture.sessionId));
    assert.deepStrictEqual(
      dangling, [],
      'records stayed streaming after the replay — the client keeps them in the '
      + 'streaming state (and aria-busy stays true, muting the screen reader)',
    );
  });

  // [CUSTOM- 回放结束由宿主自己补渲染（2026-10-27「进场时消息不渲染 markdown」）。
  //
  // 正常的往返是客户端来要、宿主回填；真机日志里出现过一次 37 条记录的回放只有最后一条
  // 被要过（其余停在原文，两端都没有报错）。所以这条链路现在**不依赖客户端的请求**：
  // `session-load-end` 之后每条已收尾的 assistant / thought 都要么在 store 里已经有 html，
  // 要么已经被作为 revise 下发（携带 text + streaming:false，客户端据此认领）。
  test('replay: the host itself renders markdown for every settled prose record', function () {
    if (!fixture?.sessionId) { this.skip(); }
    const harness = makeHarness(fixture.sessionId);
    feedReplay(harness, phaseOf(fixture, 'replay'));

    const state = settle(harness, 'Claude Code', fixture.sessionId);
    const missing = state.entries
      .filter(e => e.kind === 'assistant' || e.kind === 'thought')
      .filter(e => {
        const prose = e as { text?: string; html?: string; streaming?: boolean };
        if (!prose.text || prose.streaming) { return false; }
        const patch = state.patched.get(e.id) as { html?: string } | undefined;
        return !prose.html && !patch?.html;
      })
      .map(e => e.id);
    assert.deepStrictEqual(missing, [],
      'these settled prose records would render as literal markdown: ' + missing.join(','));

    const prefill = harness.surface.sent.filter(m => m.type === 'revise'
      && (m as { patch?: { html?: string; text?: string } }).patch?.html
      && (m as { patch?: { text?: string } }).patch?.text !== undefined);
    assert.ok(prefill.length > 0,
      'the host posted no self-rendered markdown — the replay still depends on a client round-trip');
  });

  // [CUSTOM- 轮次结束之后还有输出（后台子任务 / 收尾晚到的分片）：这条记录再也等不到
  // `streaming:false`，客户端的"定稿重试点"因此永远不触发 —— 真机表现就是"对话中的会话，
  // 最后一条消息卡片没有渲染，关掉重开就正常"。安静窗口到了由宿主补渲染。
  test('a trailing message that never finalizes still gets rendered (settle prefill)', async function () {
    const harness = makeHarness('settle-1');
    harness.handler.handleUpdate({
      sessionId: 'settle-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm-tail',
        content: { type: 'text', text: '结尾**重点**' },
      },
    } as unknown as Parameters<SessionUpdateHandler['handleUpdate']>[0]);
    // 不会再有 finalize（轮次之外的消息就是这样）。

    const selfRendered = () => harness.surface.sent.filter(m => m.type === 'revise'
      && (m as { patch?: { text?: string; html?: string } }).patch?.text === '结尾**重点**'
      && !!(m as { patch?: { html?: string } }).patch?.html);
    assert.strictEqual(selfRendered().length, 0, 'nothing to render before the quiet window');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.ok(selfRendered().length > 0,
      'the settled quiet window must render the trailing record — otherwise it stays literal markdown '
      + 'until the session is re-opened');
  });

  test('live: no prose is dropped either (control)', function () {
    if (!fixture?.sessionId) { this.skip(); }
    const live = phaseOf(fixture, 'live');
    const chunks = proseChunks(live);
    const harness = makeHarness(fixture.sessionId);
    feed(harness, live);
    const transcript = visibleText(settle(harness, 'Claude Code', fixture.sessionId));
    for (const chunk of chunks) {
      assert.ok(
        transcript.includes(chunk.text.trim()),
        `live prose missing: ${JSON.stringify(chunk.text.trim().slice(0, 90))}`,
      );
    }
  });

  test('snapshot agrees with the incremental stream', function () {
    if (!fixture?.sessionId) { this.skip(); }
    const harness = makeHarness(fixture.sessionId);
    feedReplay(harness, phaseOf(fixture, 'replay'));
    const appended = settle(harness, 'Claude Code', fixture.sessionId).entries.length;
    assert.ok(appended > 0, 'the replay produced no records at all');

    // A second surface attaching gets a fresh `boot` snapshot of the same
    // session: everything the incremental stream produced must be in it (INV-E
    // says the queue is flushed first, so the snapshot cannot be behind).
    const second = new RecordingSurface();
    harness.host.attachSurface(second, { agentName: 'Claude Code', sessionId: fixture.sessionId });
    const boot = second.sent.find(m => m.type === 'boot') as
      { snapshot: TranscriptSnapshotWire | null } | undefined;
    assert.ok(boot, 'attaching a second surface produced no boot message');
    const snapshotted = boot.snapshot?.entries.length ?? 0;
    assert.ok(
      snapshotted >= appended,
      `snapshot has ${snapshotted} entries but the stream delivered ${appended} `
      + '— a re-open would show less than the live view (the reported symptom)',
    );
  });

  test('diagnostic: live vs replay shape', function () {
    if (!fixture) { this.skip(); }
    const live = kindHistogram(phaseOf(fixture, 'live'));
    const replay = kindHistogram(phaseOf(fixture, 'replay'));
    // Printed unconditionally: when a "re-open looks different" report comes in,
    // this table is the first thing worth looking at — it says whether the AGENT
    // replayed the content or whether WE dropped it.
    console.log('[chat-panel-test] notification shapes');
    console.log('  live  :', JSON.stringify(live));
    console.log('  replay:', JSON.stringify(replay));
    console.log('  agent :', fixture.agentInfo?.name, fixture.agentInfo?.version);
    assert.ok(Object.keys(live).length > 0 && Object.keys(replay).length > 0);
  });
});

suite('chat panel: switch snapshot diff (model / mode / options)', () => {
  // [CUSTOM- All of the switch-notice judgement lives in
  // src/ui/chat/sessionChoices.ts; ChatPanelHost only caches snapshots and posts the
  // line (see syncChoices). These cases pin the diff against the REAL ACP payload
  // shapes, including the rule that is easiest to get wrong: one switch is reported
  // twice — once by our own setter, once by the agent's `config_option_update` — and
  // the second report must diff to nothing.
  const CONFIG_OPTIONS: any[] = [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select',
      currentValue: 'deepseek-v4-pro[1m]',
      options: [
        { value: 'deepseek-v4-pro[1m]', name: 'deepseek-v4-pro[1M]' },
        { value: 'sonnet', name: 'Sonnet' },
      ],
    },
    {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default',
      options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan' }],
    },
    {
      id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
      currentValue: 'high',
      // Grouped shape: ACP allows one level of grouping, and the label lives inside.
      options: [{ group: 'levels', name: 'Levels', options: [{ value: 'high', name: 'High' }, { value: 'low', name: 'Low' }] }],
    },
  ];
  const MODES = {
    currentModeId: 'default',
    availableModes: [{ id: 'default', name: 'Manual' }, { id: 'plan', name: 'Plan' }],
  };

  /** The same option list with one option's value replaced. */
  function withValue(id: string, value: string): any[] {
    return CONFIG_OPTIONS.map(option => (option.id === id ? { ...option, currentValue: value } : option));
  }

  test('a model switch reads like the reference implementation', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const after = choiceSnapshotFromState(MODES, withValue('model', 'sonnet'));
    assert.deepStrictEqual(choiceChanges(before, after), ['Switched to Sonnet']);
  });

  test('a mode switch is labelled the same way whether it arrives as a mode or as an option', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    // (a) An agent that expresses modes ONLY through `session.modes` (no mode option at
    // all): the fallback branch still has to work.
    const withoutModeOption = CONFIG_OPTIONS.filter(option => option.id !== 'mode');
    assert.deepStrictEqual(
      choiceChanges(
        choiceSnapshotFromState(MODES, withoutModeOption),
        choiceSnapshotFromState({ ...MODES, currentModeId: 'plan' }, withoutModeOption),
      ),
      ['Switched to Plan mode'],
    );
    // (b) Through a config option with category 'mode' — which is how Claude Code
    // reports it. The reader must not be able to tell which channel was used.
    assert.deepStrictEqual(
      choiceChanges(before, choiceSnapshotFromState(MODES, withValue('mode', 'plan'))),
      ['Switched to Plan mode'],
    );
  });

  test('an option with no model/mode meaning names itself', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const after = choiceSnapshotFromState(MODES, withValue('effort', 'low'));
    // The label comes out of the GROUPED options list, and a bare "Switched to Low"
    // would be a riddle — hence the option's own name.
    assert.deepStrictEqual(choiceChanges(before, after), ['Reasoning effort: Low']);
  });

  test('the primary fact comes first when a switch cascades', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const after = choiceSnapshotFromState(MODES, withValue('effort', 'low').map(o => (
      o.id === 'model' ? { ...o, currentValue: 'sonnet' } : o
    )));
    assert.deepStrictEqual(
      choiceChanges(before, after),
      ['Switched to Sonnet', 'Reasoning effort: Low'],
      'a model switch often adjusts a derived option in the same response; the reader wants the cause first',
    );
  });

  test('the second report of the same switch is silent', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const after = choiceSnapshotFromState(MODES, withValue('model', 'sonnet'));
    assert.strictEqual(choiceChanges(before, after).length, 1);
    // This is the de-duplication: whichever of the two reporters lands first
    // announces, and the other one diffs against the cache we just wrote.
    assert.deepStrictEqual(choiceChanges(after, after), []);
    // Nothing moved at all is also empty (e.g. re-opening a session).
    assert.deepStrictEqual(choiceChanges(before, before), []);
  });

  test('a notification payload patches the snapshot without losing the rest', () => {
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const fromConfig = choiceSnapshotPatched(before, { configOptions: withValue('model', 'sonnet') });
    assert.deepStrictEqual(choiceChanges(before, fromConfig), ['Switched to Sonnet']);
    // A mode payload carries an id and nothing else: the option map and the mode
    // NAME must both survive, or the line would read "Switched to plan mode".
    const fromMode = choiceSnapshotPatched(before, { modeId: 'plan' });
    assert.deepStrictEqual(choiceChanges(before, fromMode), ['Switched to Plan mode']);
    // [CUSTOM- A mode payload carries an id and nothing else, so every OTHER
    // option must survive — and the mode option itself is the same fact, so it is written
    // through (the setter path reads that copy; leaving it behind is what made one switch
    // print two lines).
    const { mode: patchedMode, ...patchedRest } = fromMode.options;
    const { mode: beforeMode, ...beforeRest } = before.options;
    assert.deepStrictEqual(patchedRest, beforeRest, 'every other option must survive');
    assert.strictEqual(patchedMode.value, 'plan');
    // The name comes from the mode list, since the payload does not carry one — otherwise
    // the line would read "Switched to plan mode".
    assert.strictEqual(patchedMode.valueName, 'Plan');
    assert.strictEqual(beforeMode.valueName, 'Manual');
  });

  test('one switch reported through both channels is announced once', () => {
    // [CUSTOM- The two reporters see different HALVES of the same change:
    // the notification path patches the mode id from its payload (leaving the option
    // behind), while the setter path reads SessionManager — where `modes.currentModeId`
    // is frozen, because `setMode` early-returns when the session has configOptions
    // (Claude Code's shape). Their snapshots used to disagree forever, so the
    // "the second report diffs to nothing" rule failed and the user saw two lines,
    // the second one naming a state that never existed ("Manual mode · Bypass
    // permissions mode").
    const before = choiceSnapshotFromState(MODES, CONFIG_OPTIONS);
    const fromNotification = choiceSnapshotPatched(before, { modeId: 'plan' });
    // MODES still says 'default' on purpose: that frozen copy IS the setter path's view.
    const fromSetter = choiceSnapshotFromState(MODES, withValue('mode', 'plan'));

    assert.deepStrictEqual(choiceChanges(before, fromNotification), ['Switched to Plan mode']);
    assert.deepStrictEqual(choiceChanges(fromNotification, fromSetter), [],
      'the second report of the same switch must be silent');
    // ...and the other arrival order has no silent gap either.
    assert.deepStrictEqual(choiceChanges(before, fromSetter), ['Switched to Plan mode']);
    assert.deepStrictEqual(choiceChanges(fromSetter, fromNotification), []);
  });

  test('a state that APPEARS is initialization, not a switch', () => {
    // The first snapshot of a session is empty (SessionManager has nothing yet) and
    // the option list lands a moment later. Announcing that would print a line full
    // of "Model: … · Mode: … · Reasoning effort: …" for every session.
    const empty = choiceSnapshotFromState(null, null);
    assert.deepStrictEqual(choiceChanges(empty, empty), []);
    assert.deepStrictEqual(choiceChanges(empty, choiceSnapshotFromState(MODES, CONFIG_OPTIONS)), []);
    // But once the state is KNOWN, a real change is announced as usual.
    assert.deepStrictEqual(
      choiceChanges(choiceSnapshotFromState(MODES, CONFIG_OPTIONS), choiceSnapshotFromState(MODES, withValue('model', 'sonnet'))),
      ['Switched to Sonnet'],
    );
  });
});

suite('chat panel: focusing a session the host already has', () => {
  // [CUSTOM- The reported bug: with a client-local **draft page** on
  // screen (058 — the host does not know drafts exist), clicking the tab of the very
  // session the host is already focused on did nothing at all. The click posts
  // `focusSession`; `SessionManager.focusSession` early-returns when the id is already
  // active (it emits only on a CHANGE), so no `focus` ever came back and the panel
  // stayed on the draft forever.
  //
  // The rule this pins: **an explicit focus request must always be answered.** What the
  // client is showing is not derivable from the host's state — the client can be on a
  // draft (or on nothing) while the host's `focused` already names this session.

  test('an explicit focus request is answered even when nothing changed', () => {
    const harness = makeHarness('session-a', 'Claude Code');
    // A first click establishes the host's focus (that one emits regardless).
    harness.host.onMessage({ type: 'focusSession', sessionId: 'session-a' });
    harness.surface.sent.length = 0;

    // The click that used to be silent: the host is already on 'session-a', and the
    // panel needs the reply to get back off a draft page.
    harness.host.onMessage({ type: 'focusSession', sessionId: 'session-a' });

    const focus = harness.surface.sent.filter(m => m.type === 'focus');
    assert.strictEqual(focus.length, 1, 'the request must be answered, not swallowed');
    assert.strictEqual((focus[0] as { summary?: { sessionId?: string } }).summary?.sessionId, 'session-a');
  });

  test('a request for a session the host does not know is still dropped', () => {
    // The guard that must survive the fix above: answering blindly would push a
    // snapshot for a session that no longer exists.
    const harness = makeHarness('session-a', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'focusSession', sessionId: 'never-existed' });
    assert.strictEqual(harness.surface.sent.filter(m => m.type === 'focus').length, 0);
  });
});

suite('chat panel: transcript-directory supplement', () => {
  // [CUSTOM- The agent's `session/list` is not the whole truth — the probe
  // (scripts/probe-session-list.mjs) reconciled disk vs agent for this very
  // project: 8 transcripts on disk, 6 reported, and the two missing ones are the sessions
  // still open in another window. The official Claude Code panel reads that directory
  // directly, which is why it shows them.

  test('transcripts are read line by line, and an oversized line does not defeat it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-disk-'));
    try {
      // One huge NON-user record first (a tool result): a character-slice reader would cut
      // inside it and parse nothing — the first version of the probe did exactly that.
      fs.writeFileSync(path.join(dir, 'aaaa1111-2222.jsonl'), [
        JSON.stringify({ type: 'queue-operation', payload: 'x'.repeat(300_000) }),
        JSON.stringify({ type: 'user', cwd: 'D:\\proj', message: { content: '第一个问题' } }),
      ].join('\n'));
      // A session that is being written right now: no cwd/title recorded yet.
      fs.writeFileSync(path.join(dir, 'bbbb3333-4444.jsonl'),
        JSON.stringify({ type: 'queue-operation' }) + '\n');
      fs.writeFileSync(path.join(dir, 'not-a-transcript.txt'), 'ignore me');

      const rows = await readDiskSessions(dir, 'D:\\fallback');
      assert.strictEqual(rows.length, 2, 'only .jsonl files count');
      const byId = new Map(rows.map(r => [r.sessionId, r]));
      assert.strictEqual(byId.get('aaaa1111-2222')!.cwd, 'D:\\proj');
      assert.strictEqual(byId.get('aaaa1111-2222')!.title, '第一个问题');
      assert.ok(byId.get('aaaa1111-2222')!.updatedAt, 'the mtime is the activity time');
      // The head-less one still gets a cwd: the bucket it lives in IS the directory.
      assert.strictEqual(byId.get('bbbb3333-4444')!.cwd, 'D:\\fallback');
      assert.strictEqual(byId.get('bbbb3333-4444')!.title, undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing directory is "no supplement", never an error', async () => {
    const rows = await readDiskSessions(path.join(os.tmpdir(), 'vac-does-not-exist-' + Date.now()));
    assert.deepStrictEqual(rows, []);
  });

  test('the summary title (ai-title) wins over the first prompt (095)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-aititle-'));
    try {
      fs.writeFileSync(path.join(dir, 'cccc1111-2222.jsonl'), [
        JSON.stringify({ type: 'user', cwd: 'D:\\proj', message: { content: 'a verbose first question about the parser' } }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the parser' }),
      ].join('\n'));
      const rows = await readDiskSessions(dir, 'D:\\fallback');
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].title, 'Fix the parser', 'the summary title wins over the first prompt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the reply includes sessions only the transcripts know about', async () => {
    // The supplement is driven by CLAUDE_CONFIG_DIR (the same override Claude Code
    // honours), so a temp root is all it takes to exercise it end to end.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }   // no workspace folder ⇒ there is no transcript bucket to read

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-claude-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const bucket = path.join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucket, { recursive: true });
      fs.writeFileSync(path.join(bucket, 'dddd5555-6666.jsonl'), [
        JSON.stringify({ type: 'user', cwd, message: { content: 'the session the agent hides' } }),
      ].join('\n'));

      class EmptyHistoryManager extends SessionManager {
        override isAgentConnected(): boolean { return true; }
        override getCachedCapabilities(): any { return { list: true }; }
        override async listSessions(): Promise<any> { return { sessions: [] }; }
      }
      const harness = makeHarness('dummy-session', 'Claude Code', handler =>
        new EmptyHistoryManager(new AgentManager(), new ConnectionManager(handler), handler));
      harness.surface.sent.length = 0;
      harness.host.onMessage({ type: 'listHistory' });

      let reply: any;
      for (let i = 0; i < 100 && !reply; i++) {
        reply = harness.surface.sent.find(m => m.type === 'history');
        if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
      }
      assert.ok(reply, 'the host must answer listHistory');
      const row = (reply.sessions as any[]).find(s => s.sessionId === 'dddd5555-6666');
      assert.ok(row, 'the transcript-only session is offered');
      assert.strictEqual(row.fromDisk, true, 'and it says where it came from');
      assert.strictEqual(row.cwd, cwd);
      assert.match(String(row.title), /the session the agent hides/);
      // The agent reported nothing, so every row here came from a local source.
      assert.strictEqual(reply.source, 'merged');
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the supplement scans the directory the filter selected, not the workspace', async () => {
    // [CUSTOM- The picker filter may point at any folder the agent lists —
    // NOT just workspaceFolders[0]. supplementHistory must scan THAT folder's transcripts.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-supplement-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const cwdA = 'D:\\proj-a';
      const cwdB = 'D:\\proj-b';
      const bucketA = path.join(root, 'projects', cwdA.replace(/[^A-Za-z0-9]/g, '-'));
      const bucketB = path.join(root, 'projects', cwdB.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucketA, { recursive: true });
      fs.mkdirSync(bucketB, { recursive: true });
      fs.writeFileSync(path.join(bucketA, 'aaaa1111-2222.jsonl'),
        JSON.stringify({ type: 'user', cwd: cwdA, message: { content: 'in folder a' } }) + '\n');
      fs.writeFileSync(path.join(bucketB, 'bbbb3333-4444.jsonl'),
        JSON.stringify({ type: 'user', cwd: cwdB, message: { content: 'in folder b' } }) + '\n');

      class EmptyHistoryManager extends SessionManager {
        override isAgentConnected(): boolean { return true; }
        override getCachedCapabilities(): any { return { list: true }; }
        override async listSessions(): Promise<any> { return { sessions: [] }; }
      }
      const harness = makeHarness('dummy-session', 'Claude Code', handler =>
        new EmptyHistoryManager(new AgentManager(), new ConnectionManager(handler), handler));
      harness.surface.sent.length = 0;
      harness.host.onMessage({ type: 'supplementHistory', cwd: cwdB });

      let reply: any;
      for (let i = 0; i < 100 && !reply; i++) {
        reply = harness.surface.sent.find(m => m.type === 'historySupplement');
        if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
      }
      assert.ok(reply, 'the host must answer supplementHistory');
      const ids = (reply.sessions as any[]).map(s => s.sessionId);
      assert.deepStrictEqual(ids, ['bbbb3333-4444'], 'only the selected folder is scanned');
      const row = (reply.sessions as any[])[0];
      assert.strictEqual(row.fromDisk, true, 'and it says where it came from');
      assert.strictEqual(row.dirKey, directoryKey(cwdB), 'and carries the folder identity');
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

suite('chat panel: audit round — routing, close, empty state', () => {
  // [..090] Four findings from the panel audit, all in the
  // "client-local state the host cannot see" family the repo keeps paying for.

  test('the reply is the UNION of the agent list and the local cache', async () => {
    // [CUSTOM- The agent's `session/list` is not the whole truth: it omits
    // sessions still open in another Claude Code window (measured with
    // scripts/probe-session-list.mjs). A session this workspace opened
    // earlier is in OUR cache regardless, so the union is what keeps "the list I saw
    // before" and "the list I see now" in agreement.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '/tmp';
    const memento = new FakeMemento();
    void memento.update('vac.sessionHistory.v1', {
      version: 1,
      entries: [
        // Shared with the agent's list (the agent's version of it wins).
        { agentName: 'Claude Code', cwd, sessionId: 'shared', createdAt: '2026-09-20T00:00:00Z', lastActiveAt: '2026-09-20T00:00:00Z', title: 'cached title' },
        // Cache-only: the agent did not mention it.
        { agentName: 'Claude Code', cwd, sessionId: 'cache-only', createdAt: '2026-09-19T00:00:00Z', lastActiveAt: '2026-09-19T00:00:00Z', title: 'only in the cache' },
      ],
    });
    const store = new SessionHistoryStore(memento as unknown as vscode.Memento);

    class UnionManager extends SessionManager {
      override isAgentConnected(): boolean { return true; }
      override getCachedCapabilities(): any { return { list: true }; }
      override async listSessions(): Promise<any> {
        return {
          sessions: [
            { sessionId: 'shared', title: 'agent title', cwd, updatedAt: '2026-09-21T00:00:00Z' },
            { sessionId: 'agent-only', title: 'only from the agent', cwd, updatedAt: '2026-09-22T00:00:00Z' },
          ],
        };
      }
    }

    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      const manager = new UnionManager(new AgentManager(), new ConnectionManager(handler), handler);
      manager.setHistoryStore(store);
      return manager;
    });
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'listHistory' });

    let reply: any;
    for (let i = 0; i < 100 && !reply; i++) {
      reply = harness.surface.sent.find(m => m.type === 'history');
      if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    assert.ok(reply, 'the host must answer listHistory');
    assert.strictEqual(reply.source, 'merged', 'both sources contributed');

    const byId = new Map<string, any>(reply.sessions.map((s: any) => [s.sessionId, s]));
    assert.deepStrictEqual(Array.from(byId.keys()).sort(), ['agent-only', 'cache-only', 'shared']);
    assert.strictEqual(byId.get('shared').title, 'agent title', 'the agent wins for a session it knows');
    assert.strictEqual(byId.get('shared').fromCache, undefined, 'and it is not marked as cache-only');
    assert.strictEqual(byId.get('cache-only').fromCache, true, 'a cache-only row says so');
    // Newest first — the picker is for "the session I was just in".
    assert.deepStrictEqual(reply.sessions.map((s: any) => s.sessionId),
      ['agent-only', 'shared', 'cache-only']);
  });

  /** Records the cancel; the in-flight state is ours to decide. */
  class RecordingCloseManager extends SessionManager {
    readonly cancelled: string[] = [];
    private readonly busy = new Set<string>();
    markBusy(sessionId: string): void { this.busy.add(sessionId); }
    override isTurnInFlight(sessionId: string): boolean { return this.busy.has(sessionId); }
    override async cancelTurn(sessionId: string): Promise<void> { this.cancelled.push(sessionId); }
  }

  test('closing a session cancels its in-flight turn first', async () => {
    // Dropping `inFlightTurns` without a cancel left the agent working on a turn nobody
    // would see — and, per the ACP contract honoured in cancelTurn, a pending
    // session/request_permission must be answered 'cancelled' or the agent hangs (pitfall #14).
    let manager!: RecordingCloseManager;
    const harness = makeHarness('busy-session', 'Claude Code', handler => {
      manager = new RecordingCloseManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    manager.markBusy('busy-session');
    await manager.closeSession('Claude Code', 'busy-session');
    assert.deepStrictEqual(manager.cancelled, ['busy-session']);
    assert.strictEqual(manager.getSession('busy-session'), undefined, 'and it is still closed');
    assert.strictEqual(harness.sessionManager.getSession('busy-session'), undefined);
  });

  test('idle sessions are closed without a spurious cancel', async () => {
    let manager!: RecordingCloseManager;
    makeHarness('idle-session', 'Claude Code', handler => {
      manager = new RecordingCloseManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    await manager.closeSession('Claude Code', 'idle-session');
    assert.deepStrictEqual(manager.cancelled, [], 'nothing was running');
  });

  test('every message that can change the empty state carries the connection flag', () => {
    // A sessionless panel can have a LIVE agent (closing the last session keeps the
    // process), so the empty state's copy must come from the host rather than assuming
    // "no session ⇒ not connected".
    const harness = makeHarness('dummy-session', 'Claude Code');
    const boot = harness.surface.sent.find(m => m.type === 'boot') as { agentConnected?: unknown };
    assert.strictEqual(boot.agentConnected, true, 'the harness registers a live agent process');

    harness.sessionManager.emit('active-session-changed', 'dummy-session', 'Claude Code');
    const focus = harness.surface.sent.filter(m => m.type === 'focus').pop() as { agentConnected?: unknown };
    assert.strictEqual(focus.agentConnected, true);
  });
});

suite('chat panel: history picker directory filter', () => {
  // [CUSTOM- The picker lists the AGENT's sessions, which span every
  // directory it has ever been used in (232 of them in the report) — unusable without
  // a filter. Two halves are covered here:
  // · the pure functions that decide "is this the same folder?" and "what is worth
  // offering" — the only place platform differences live;
  // · the reply the host builds, where EVERY row must carry a `dirKey` (a row
  // without one silently disappears from any filtered list).
  // The client half (chip, menu, placement, Escape layering) is layout/interaction:
  // it is verified by hand, see dev-workflow.md's split.

  test('directory identity folds case on Windows/macOS, not on Linux', () => {
    assert.strictEqual(directoryKey('D:\\work\\repo\\', 'win32'), 'd:/work/repo');
    assert.strictEqual(directoryKey('d:/work/repo', 'win32'), 'd:/work/repo');
    // The case rule is a property of the PLATFORM: on Linux these are two folders.
    assert.notStrictEqual(directoryKey('/Home/Me', 'linux'), directoryKey('/home/me', 'linux'));
    assert.strictEqual(directoryKey('/home/me/', 'linux'), '/home/me');
    // Roots: 'C:\' and 'C:' are the same place, so they must share ONE identity
    // ('c:'), while POSIX '/' survives because there is nothing to strip.
    assert.strictEqual(directoryKey('C:\\', 'win32'), 'c:');
    assert.strictEqual(directoryKey('C:', 'win32'), 'c:');
    assert.strictEqual(directoryKey('/', 'linux'), '/');
    // A session with no directory has no identity to compare.
    assert.strictEqual(directoryKey(undefined), undefined);
    assert.strictEqual(directoryKey('   '), undefined);
  });

  test('candidates come from the list; the current folder is always offered', () => {
    const options = directoryOptions(
      [
        { cwd: 'D:\\work\\alpha' },
        { cwd: 'D:\\work\\alpha\\' },   // same folder, different spelling → ONE option
        { cwd: 'D:\\work\\beta' },
        { cwd: undefined },            // nothing to filter by
      ],
      'D:/work/alpha',
      'win32',
    );
    assert.deepStrictEqual(options.map(o => [o.name, o.count, o.current]), [
      ['alpha', 2, true],   // 两种拼写合成一项（count=2）；顺序按名称（它恰好也在前面）
      ['beta', 1, false],
    ]);
  });

  test('the current folder is offered even with no sessions in it', () => {
    // Otherwise "the filter defaults to the current folder" would open onto an empty
    // list with no hint of why — the control would look broken.
    const options = directoryOptions([{ cwd: '/other' }], '/here');
    assert.deepStrictEqual(options.map(o => [o.name, o.count, o.current]), [
      ['here', 0, true],
      ['other', 1, false],
    ]);
    // No current directory (a draft, or a session the agent gave no cwd for): the
    // client is then told to open unfiltered, which is the honest answer.
    assert.deepStrictEqual(directoryOptions([{ cwd: '/other' }], undefined).map(o => o.current), [false]);
    assert.deepStrictEqual(directoryOptions([], undefined), []);
  });

  test('two candidates with the same folder name are told apart', () => {
    // The first real list had "Project" twice (two checkouts of one repo), and
    // two identical labels cannot be picked between — so the label grows leftwards.
    const options = directoryOptions([{ cwd: '/x/work/Project' }, { cwd: '/y/archive/Project' }]);
    assert.deepStrictEqual(options.map(o => [o.name, o.label]), [
      ['Project', 'work/Project'],
      ['Project', 'archive/Project'],
    ]);
    // A unique name stays as short as it was.
    assert.deepStrictEqual(
      directoryOptions([{ cwd: '/a/alpha' }, { cwd: '/a/beta' }]).map(o => o.label),
      ['alpha', 'beta'],
    );
  });

  test('ordering: by name ()', () => {
    // 用户要求"目录列表排下序（按字母顺序）"。原来是 current 优先 → 会话数降序 → 名称，
    // 前两个键把字母序盖住了 —— 看起来就像"根本没排序"。现在纯按名称；当前目录只保留
    // current 标记（客户端据此高亮），不再置顶。
    const options = directoryOptions(
      [{ cwd: '/b' }, { cwd: '/b' }, { cwd: '/a' }, { cwd: '/c' }, { cwd: '/c' }], '/z');
    assert.deepStrictEqual(options.map(o => o.name), ['a', 'b', 'c', 'z']);
    // 会话数（b 与 c 各 2）与 current（z）都不再影响顺序。
    assert.deepStrictEqual(options.map(o => o.current), [false, false, false, true]);
  });

  /** An agent whose history spans directories — the case the filter exists for. */
  class MultiDirSessionManager extends SessionManager {
    override isAgentConnected(): boolean { return true; }
    override getCachedCapabilities(): any { return { list: true }; }
    override async listSessions(): Promise<any> {
      return {
        sessions: [
          // The focused session's own directory ('/tmp', from the fake session).
          { sessionId: 'in-here', title: 'here one', cwd: '/tmp', updatedAt: '2026-09-20T00:00:00Z' },
          { sessionId: 'elsewhere-a', title: 'a', cwd: 'D:\\Git\\alpha', updatedAt: '2026-09-19T00:00:00Z' },
          // Same directory as the row above, spelled with a trailing separator: the
          // fixtures differ only in that way ON PURPOSE, so this test says the same
          // thing on every platform (case-only differences would not).
          { sessionId: 'elsewhere-b', title: 'b', cwd: 'D:\\Git\\alpha\\', updatedAt: '2026-09-18T00:00:00Z' },
          { sessionId: 'no-dir', title: 'c', updatedAt: '2026-09-17T00:00:00Z' },
        ],
      };
    }
  }

  test('the reply carries a per-row dirKey and the filter candidates', async function () {
    const harness = makeHarness('dummy-session', 'Claude Code', handler =>
      new MultiDirSessionManager(new AgentManager(), new ConnectionManager(handler), handler));
    harness.surface.sent.length = 0;   // drop the attach-time boot noise
    harness.host.onMessage({ type: 'listHistory' });

    let reply: any;
    for (let i = 0; i < 100 && !reply; i++) {
      reply = harness.surface.sent.find(m => m.type === 'history');
      if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    assert.ok(reply, 'the host must answer listHistory');

    const byId = new Map<string, any>(reply.sessions.map((s: any) => [s.sessionId, s]));
    assert.strictEqual(byId.get('in-here').dirKey, directoryKey('/tmp'));
    // Two spellings of one directory share an identity — and the ROWS keep their own
    // spelling, because that is what gets handed back to the agent on open.
    assert.strictEqual(byId.get('elsewhere-a').dirKey, byId.get('elsewhere-b').dirKey);
    assert.strictEqual(byId.get('elsewhere-b').cwd, 'D:\\Git\\alpha\\');
    // A row with no directory has no key: it can only ever show in an unfiltered list.
    assert.strictEqual(byId.get('no-dir').dirKey, undefined);

    // The two spellings of alpha are ONE candidate with a count of 2, and the order is
    // by name — '/tmp' is the current directory but no longer leads ().
    assert.deepStrictEqual(reply.directories.map((d: any) => [d.name, d.count, d.current]), [
      ['alpha', 2, false],
      ['tmp', 1, true],
    ]);
  });

  test('the current (live) session is offered in the history list', async function () {
    // [CUSTOM- Live sessions used to be hidden ("they are already
    // tabs"), but the current session should still appear — clicking it re-focuses.
    class LiveListManager extends SessionManager {
      override isAgentConnected(): boolean { return true; }
      override getCachedCapabilities(): any { return { list: true }; }
      override async listSessions(): Promise<any> {
        return {
          sessions: [
            { sessionId: 'dummy-session', title: 'the live one', cwd: '/tmp', updatedAt: '2026-09-20T00:00:00Z' },
          ],
        };
      }
    }
    const harness = makeHarness('dummy-session', 'Claude Code', handler =>
      new LiveListManager(new AgentManager(), new ConnectionManager(handler), handler));
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'listHistory' });
    let reply: any;
    for (let i = 0; i < 100 && !reply; i++) {
      reply = harness.surface.sent.find(m => m.type === 'history');
      if (!reply) { await new Promise(resolve => setTimeout(resolve, 5)); }
    }
    assert.ok(reply);
    assert.ok(reply.sessions.some((s: any) => s.sessionId === 'dummy-session'),
      'the live session must appear in the history list');
  });
});

// [CUSTOM- 输入区图片：宿主把 image 附件转成 ACP `image` ContentBlock、
// 字节只留宿主内存（不进 meta），file 附件仍转 resource_link，发送后清掉 image 字节。
suite('chat panel: image attachments ()', () => {
  class RecordingSendManager extends SessionManager {
    readonly sent: Array<{ sessionId: string; prompt: unknown }> = [];
    override async sendPrompt(
      sessionId: string, prompt: unknown, onDispatched?: () => void,
    ): Promise<PromptResponse> {
      onDispatched?.();
      this.sent.push({ sessionId, prompt });
      return { stopReason: 'end_turn' } as PromptResponse;
    }
  }

  function imageHarness(): { harness: Harness; manager: RecordingSendManager } {
    let manager!: RecordingSendManager;
    const harness = makeHarness('image-session', 'Claude Code', handler => {
      manager = new RecordingSendManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;   // drop the attach-time boot noise
    return { harness, manager };
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  function latestAttachments(harness: Harness): Array<Record<string, unknown>> {
    const msgs = harness.surface.sent.filter(m => m.type === 'attachments') as Array<Record<string, unknown>>;
    const last = msgs[msgs.length - 1];
    return (last && (last.attachments as Array<Record<string, unknown>>)) || [];
  }

  test('an image attachment is broadcast without its bytes on the wire', () => {
    const { harness } = imageHarness();
    harness.host.onMessage({
      type: 'attachImage', sessionId: 'image-session', id: 'img-1',
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    });

    const img = latestAttachments(harness).find(a => a.path === 'img-1');
    assert.ok(img, 'the image attachment is in the list');
    assert.strictEqual(img.kind, 'image');
    assert.strictEqual(img.mimeType, 'image/png');
    // The base64 lives host-side only — putting it on the wire would re-send the
    // whole image on every boot/focus.
    assert.strictEqual(img.dataUrl, undefined);
  });

  test('send turns an image into an image block and a file into a resource_link', async () => {
    const { harness, manager } = imageHarness();
    harness.host.onMessage({ type: 'attachPath', sessionId: 'image-session', paths: ['/tmp/notes.txt'] });
    harness.host.onMessage({
      type: 'attachImage', sessionId: 'image-session', id: 'img-1',
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'image-session', text: '' });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    const blocks = manager.sent[0].prompt as Array<Record<string, any>>;
    assert.deepStrictEqual(blocks.find(b => b.type === 'image'),
      { type: 'image', data: 'AAAA', mimeType: 'image/png' });
    const link = blocks.find(b => b.type === 'resource_link');
    assert.ok(link, 'the file attachment is still a resource_link');
    assert.ok(String(link.uri).indexOf('notes.txt') >= 0, 'the resource_link names the file');
    // Empty text ⇒ no text block.
    assert.strictEqual(blocks.find(b => b.type === 'text'), undefined, 'empty text yields no text block');
  });

  // [CUSTOM- 用户报「输入框引用的图片，消息发出后没有清空引用」。附件原先要等整轮
  // 结束才清（放在 `await pending` 之后），于是一轮跑几分钟、chip 也挂几分钟。现在
  // SessionManager 在 prompt **真正发出去**的那一刻回调，失败的发送（没连上）仍保留 chip。
  test('the chips are consumed at dispatch, while the turn is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    class SlowSendManager extends SessionManager {
      override async sendPrompt(
        _sessionId: string, _prompt: unknown, onDispatched?: () => void,
      ): Promise<PromptResponse> {
        onDispatched?.();
        await gate;
        return { stopReason: 'end_turn' } as PromptResponse;
      }
    }
    const harness = makeHarness('slow-session', 'Claude Code', handler =>
      new SlowSendManager(new AgentManager(), new ConnectionManager(handler), handler));
    harness.surface.sent.length = 0;
    harness.host.onMessage({
      type: 'attachImage', sessionId: 'slow-session', id: 'img-9', name: 'a.png',
      mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    });
    assert.strictEqual(latestAttachments(harness).length, 1);

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'slow-session', text: 'look' });
    await waitFor(() => latestAttachments(harness).length === 0, 'the attachments broadcast');
    assert.strictEqual(((harness.host as any).imageData as Map<string, unknown>).get('slow-session'),
      undefined, 'the image bytes are released too');
    release();
  });

  test('a send with text and an image records the image inside the user bubble (108)', async () => {
    const { harness, manager } = imageHarness();
    harness.host.onMessage({
      type: 'attachImage', sessionId: 'image-session', id: 'img-1',
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'image-session', text: '看看这张图' });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    const snap = (harness.host as any).transcripts.snapshot('image-session');
    assert.ok(snap);
    const users = snap.entries.filter((e: any) => e.kind === 'user');
    const contents = snap.entries.filter((e: any) => e.kind === 'content');
    assert.strictEqual(users.length, 1, 'one user entry');
    assert.strictEqual(contents.length, 0, 'no separate content entry: the image lives in the bubble');
    assert.ok(users[0].attachments, 'the user entry carries the attachments field');
    assert.strictEqual(users[0].attachments!.length, 1);
    assert.strictEqual(users[0].attachments![0].type, 'image');
    assert.strictEqual(users[0].attachments![0].name, 'shot.png', 'the attachment name survives');
  });

  // [CUSTOM- 文件引用也要进气泡（用户报："引用了文件的消息发出去后，消息面板里
  // 这条用户消息卡片里看不到引用的文件"——它此前只进了发给 agent 的 blocks）。两处一份构造：
  // 气泡视图的 uri 必须与发出去那条**逐字相同**（含 #L 片段）。
  test('带文件引用的发送把 chip 记进用户气泡，且与 blocks 同一条 uri（215）', async () => {
    const { harness, manager } = imageHarness();
    harness.host.onMessage({
      // 盘符绝对路径（真实场景的形状）：POSIX 风格 /tmp/... 在 Windows 测试宿主上会经 Uri.file
      // 变成 file:///tmp/... —— fileURLToPath 解不出盘符（ERR_INVALID_FILE_URL_PATH）⇒ path 为空。
      type: 'attachPath', sessionId: 'image-session', paths: ['d:/work/src/notes.txt'],
      meta: [{ name: 'notes.txt:12-40', lineStart: 12, lineEnd: 40 }],
    });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'image-session', text: '看下这个引用' });
    await waitFor(() => manager.sent.length > 0, 'the prompt to be sent');

    const snap = (harness.host as any).transcripts.snapshot('image-session');
    const users = snap.entries.filter((e: any) => e.kind === 'user');
    const contents = snap.entries.filter((e: any) => e.kind === 'content');
    assert.strictEqual(users.length, 1, 'one user entry');
    assert.strictEqual(contents.length, 0, 'the chip lives in the bubble, not a separate entry');
    const att = users[0].attachments;
    assert.ok(att && att.length === 1, 'the file reference rides in the bubble');
    assert.strictEqual(att[0].type, 'resource_link');
    assert.strictEqual(att[0].name, 'notes.txt:12-40', '显示名（含行区间）同源');
    assert.ok(String(att[0].uri).indexOf('#L12-40') >= 0, 'uri 带 #L 片段');
    assert.ok(att[0].path, 'toContentView 认出本地文件 ⇒ 气泡里的 chip 点击走 openFile: ' + JSON.stringify(att[0]));
    assert.strictEqual(att[0].line, 12, '气泡 chip 也带起始行');
    assert.strictEqual(att[0].endLine, 40, '以及结束行（点击框选整段）');

    const blocks = manager.sent[0].prompt as Array<Record<string, any>>;
    const link = blocks.find(b => b.type === 'resource_link');
    assert.ok(link, 'the sent blocks carry the resource_link');
    assert.strictEqual(link.uri, att[0].uri, '两个出口一份构造（pitfall #19）');
  });

  test('an image-only send records a content entry and no empty user bubble', async () => {
    const { harness, manager } = imageHarness();
    harness.host.onMessage({
      type: 'attachImage', sessionId: 'image-session', id: 'img-1',
      name: 'shot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'image-session', text: '' });
    await waitFor(() => manager.sent.length > 0, 'the prompt');

    const state = settle(harness, 'Claude Code', 'image-session');
    assert.strictEqual(state.entries.filter(e => e.kind === 'content').length, 1,
      'the image becomes one content entry');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0,
      'no empty user bubble for an image-only send');
  });
});

// [CUSTOM- 会话元数据：tab 标题落地、重开会话记录目录（Recently used）。
suite('chat panel: session metadata ()', () => {
  test('a session_info_update applies the title to the tab summary', () => {
    const harness = makeHarness('dummy-session', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: 'The session name', updatedAt: '2026-09-20T00:00:00Z' },
    } as any);

    const changed = harness.surface.sent.filter(m => m.type === 'sessionsChanged');
    const last = changed[changed.length - 1] as { sessions: Array<{ sessionId: string; title: string | null }> };
    assert.ok(last, 'a sessionsChanged must be emitted after the title lands');
    const s = last.sessions.find(x => x.sessionId === 'dummy-session');
    assert.strictEqual(s?.title, 'The session name');
  });

  // [CUSTOM- 标题跟随 agent，但**不再在对话里插一行"改名"提示**（用户报：
  // 会话进行中会自己改名并跳出一行 `Session renamed to “…”`）。adapter 每轮结束去读 SDK 的标题，
  // 而那个标题先是"第一条 prompt"、之后才被后台生成的摘要替换 —— 这次跃迁不是用户做的，
  // 也不在对话的语义里。
  test('a retitle follows the tab but never writes a record into the conversation (163)', () => {
    const harness = makeHarness('dummy-session', 'Claude Code');
    harness.surface.sent.length = 0;

    // The adapter's first title is the first prompt…
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: '检查一下文档', updatedAt: '2026-09-20T00:00:00Z' },
    } as any);
    // …and the generated summary replaces it a turn later.
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: 'Governance sync infrastructure analysis', updatedAt: '2026-09-20T00:01:00Z' },
    } as any);

    const appends = harness.surface.sent.filter(m => m.type === 'append') as Array<{ entries?: Array<{ kind?: string; text?: string }> }>;
    const notices = appends.flatMap(m => m.entries ?? []).filter(e => e.kind === 'notice');
    assert.deepStrictEqual(notices, [], 'a rename the user did not make is not a record in their conversation');

    const changed = harness.surface.sent.filter(m => m.type === 'sessionsChanged');
    const last = changed[changed.length - 1] as { sessions: Array<{ sessionId: string; title: string | null }> };
    assert.strictEqual(last.sessions.find(x => x.sessionId === 'dummy-session')?.title,
      'Governance sync infrastructure analysis',
      'but the tab still follows the newest title — that is where a name belongs');
  });

  // [CUSTOM- 标题由**第一次对话**定：那一刻已经拿到的自动命名就是它的名字；
  // 没拿到就用第一条消息（`toSummary` 的回退链），之后**任何**标题都不再改 —— 包括几轮之后
  // 才生成的那个"第一个自动命名"（用户规则：那时对话内容已经脱离第一次对话了）。
  async function settleFor(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)); }

  function titleOf(harness: Harness): string | null | undefined {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as {
        type?: string; sessions?: Array<{ sessionId: string; title: string | null }>;
      };
      if (message.type !== 'sessionsChanged') { continue; }
      const row = (message.sessions ?? []).find(s => s.sessionId === 'dummy-session');
      if (row) { return row.title; }
    }
    return undefined;
  }

  test('a title that lands with the first exchange IS the name (164)', async () => {
    const harness = makeHarness('dummy-session', 'Claude Code');
    Object.assign(harness.sessionManager, { sendPrompt: () => Promise.resolve({ stopReason: 'end_turn' }) });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'dummy-session', text: '第一条消息' });
    await settleFor(20);
    // The adapter polls the SDK title at turn end, so this one belongs to the first exchange.
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: '自动命名 A' },
    } as any);
    assert.strictEqual(titleOf(harness), '自动命名 A');
  });

  test('a title generated several exchanges later never renames the session (164)', async () => {
    const harness = makeHarness('dummy-session', 'Claude Code');
    Object.assign(harness.sessionManager, { sendPrompt: () => Promise.resolve({ stopReason: 'end_turn' }) });

    // Turn 1, and no title by the time it ends.
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'dummy-session', text: '第一条消息' });
    await settleFor(20);
    assert.strictEqual(titleOf(harness), null, 'nothing named it yet');

    // Turn 2: the name is now fixed (in production the tab falls back to the stored
    // first prompt — the harness has no history store, so the title simply stays unset).
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'dummy-session', text: '第二条消息' });
    await settleFor(20);
    harness.handler.handleUpdate({
      sessionId: 'dummy-session',
      update: { sessionUpdate: 'session_info_update', title: '几轮之后才生成的标题' },
    } as any);
    assert.strictEqual(titleOf(harness), null, 'a late auto-title must not become the name');
  });

  test('upsertNew records the directory, and updates a stale one', () => {
    const store = new SessionHistoryStore(new FakeMemento());
    store.upsertNew('Claude Code', '/dir/x', 's1');
    assert.deepStrictEqual(store.recentDirectories('Claude Code'), ['/dir/x']);

    // Reopening the same session with a corrected directory must update it (the
    // "opened a session in a directory, then New Session should offer it" case).
    store.upsertNew('Claude Code', '/dir/y', 's1');
    assert.deepStrictEqual(store.recentDirectories('Claude Code'), ['/dir/y']);
    assert.strictEqual(store.get('Claude Code', 's1')?.cwd, '/dir/y');
  });
});


// [CUSTOM- replay 的三项修复：用户消息里的图片不再丢、记录用转录里的真实
// 时刻、在草稿页选历史会话时让位的是草稿而不是聚焦会话。
suite('chat panel: replay fidelity ()', () => {
  test('an image in a replayed user message becomes a content record', () => {
    // ACP delivers a multi-part user message as several chunks; the non-text ones
    // used to be dropped here, so a reopened conversation lost the picture.
    const harness = makeHarness('img-replay', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'img-replay',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'm-image',
        content: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'img-replay');
    const content = state.entries.find(e => e.kind === 'content') as { blocks: Array<{ type: string }> } | undefined;
    assert.ok(content, 'the image must survive a replay');
    assert.strictEqual(content!.blocks[0].type, 'image');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0,
      'an image-only chunk is not an empty user bubble');
  });

  test('the transcript timeline maps message ids to their real times', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-times-'));
    try {
      fs.writeFileSync(path.join(dir, 's1.jsonl'), [
        // user records are keyed by `uuid`; assistant records by `message.id`.
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-25T10:00:00.000Z', message: { role: 'user' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-09-25T10:05:00.000Z', message: { id: 'a1' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-09-25T10:05:30.000Z', message: { id: 'a1' } }),
        'not json at all',
      ].join('\n'));

      const times = await readTranscriptTimes(dir, 's1');
      assert.strictEqual(times.get('u1'), Date.parse('2026-09-25T10:00:00.000Z'));
      assert.strictEqual(times.get('a1'), Date.parse('2026-09-25T10:05:00.000Z'),
        'the EARLIEST record wins: one message id spans several records');
      assert.strictEqual(times.size, 2, 'a malformed line is skipped, not fatal');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a replayed record carries the real time from the transcript', async () => {
    // End to end: the host reads the timeline before replaying, then stamps the
    // records the agent streams back. Without it every row of a reopened
    // conversation showed `Date.now()` — one identical second for the whole thing.
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }   // no workspace folder ⇒ there is no transcript bucket to read

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-replay-times-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const bucket = path.join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucket, { recursive: true });
      const realTime = '2026-09-25T10:00:00.000Z';
      fs.writeFileSync(path.join(bucket, 'replayed-session.jsonl'), [
        JSON.stringify({ type: 'user', cwd, uuid: 'msg-1', timestamp: realTime, message: { role: 'user' } }),
      ].join('\n'));

      class LiveOpenManager extends SessionManager {
        readonly closed: string[] = [];
        override async closeSession(agentName: string, sessionId: string): Promise<void> {
          this.closed.push(sessionId);
          return super.closeSession(agentName, sessionId);
        }
        override async openExistingSession(): Promise<'live' | 'load' | 'resume'> { return 'live'; }
      }
      let manager!: LiveOpenManager;
      const harness = makeHarness('dummy-session', 'Claude Code', handler => {
        manager = new LiveOpenManager(new AgentManager(), new ConnectionManager(handler), handler);
        return manager;
      });
      harness.surface.sent.length = 0;

      harness.host.onMessage({
        type: 'openHistorySession',
        agentName: 'Claude Code',
        sessionId: 'replayed-session',
        cwd,
      });
      // The preload happens before the open, so waiting for the open to land is enough.
      for (let i = 0; i < 100 && manager.closed.length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      // Now the replay streams a chunk carrying that message id.
      registerFakeSession(harness.sessionManager, 'replayed-session', 'Claude Code');
      harness.handler.handleUpdate({
        sessionId: 'replayed-session',
        update: { sessionUpdate: 'user_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'hello' } },
      } as any);

      const state = settle(harness, 'Claude Code', 'replayed-session');
      const user = state.entries.find(e => e.kind === 'user') as { at: number } | undefined;
      assert.ok(user, 'the replayed user message is in the transcript');
      assert.strictEqual(user!.at, Date.parse(realTime),
        'the record carries the time the message was actually sent');
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a replayed record without a transcript time is elapsed from 0, not Date.now()', () => {
    // Reported: reopened sessions without a readable transcript showed every row at
    // `Date.now()` — one identical, misleading wall-clock second for the whole thing.
    // Now such records are 0-based relative ms (atIsElapsed), rendered as a stopwatch.
    const harness = makeHarness('fallback-session', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.sessionManager.emit('session-load-start', 'fallback-session', 'Claude Code');
    harness.handler.handleUpdate({
      sessionId: 'fallback-session',
      update: { sessionUpdate: 'user_message_chunk', messageId: 'm-unknown', content: { type: 'text', text: 'hi' } },
    } as any);
    harness.sessionManager.emit('session-load-end', 'fallback-session', 'Claude Code', true);

    const state = settle(harness, 'Claude Code', 'fallback-session');
    const user = state.entries.find(e => e.kind === 'user');
    assert.ok(user, 'the replayed user message is in the transcript');
    assert.strictEqual(user!.atIsElapsed, true, 'no real time -> the record is elapsed, not wall-clock');
    assert.ok(user!.at >= 0 && user!.at < 60_000,
      `at is 0-based (${user!.at}ms), not the epoch ms Date.now() would produce`);

    // Once the replay ends, a NEW record goes back to wall-clock time.
    const live = (harness.host as any).transcripts.appendUser('fallback-session', 'after replay');
    assert.ok(live, 'a live entry is appended');
    assert.ok(!live.atIsElapsed, 'post-replay records are wall-clock again');
  });

  test('opening a session while on a draft page leaves the focused session alone', async () => {
    // [CUSTOM- Reported: picking a history session while on the "New
    // session" page replaced the FIRST TAB instead, and the draft page never changed.
    // The draft is client-local, so the host's `focused` names some other session —
    // `fromDraft` is how the client says "that session is not the one to retire".
    class RecordingOpenManager extends SessionManager {
      readonly closed: string[] = [];
      override async closeSession(agentName: string, sessionId: string): Promise<void> {
        this.closed.push(sessionId);
        return super.closeSession(agentName, sessionId);
      }
      override async openExistingSession(): Promise<'live' | 'load' | 'resume'> { return 'live'; }
    }
    let manager!: RecordingOpenManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new RecordingOpenManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.host.onMessage({
      type: 'openHistorySession',
      agentName: 'Claude Code',
      sessionId: 'other-session',
      fromDraft: true,
    });

    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepStrictEqual(manager.closed, [],
      'the draft steps aside; the focused session must keep its tab');
  });

  // [CUSTOM- 注入块（<task-notification> 等）走 user_message_chunk 通道，
  // 但它们不是用户输入。渲染成蓝色用户气泡会把 agent 的回报误读成用户说过的话。
  test('a task-notification chunk is a meta notice, not a user bubble', () => {
    const harness = makeHarness('notify', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'notify',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'm-notify',
        content: { type: 'text', text: '<task-notification>\n<status>completed</status>\n<summary>explore done</summary>\n</task-notification>' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'notify');
    const userEntries = state.entries.filter(e => e.kind === 'user');
    const noticeEntries = state.entries.filter(e => e.kind === 'notice');
    assert.strictEqual(userEntries.length, 0, 'an injected block is NOT a user bubble');
    assert.strictEqual(noticeEntries.length, 1, 'it becomes a notice');
    const notice = noticeEntries[0] as { level: string; text: string };
    assert.strictEqual(notice.level, 'meta');
    assert.ok(notice.text.includes('completed'), 'the preview keeps the payload');
  });

  test('a system-reminder chunk is also a meta notice', () => {
    const harness = makeHarness('reminder', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'reminder',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'm-reminder',
        content: { type: 'text', text: '<system-reminder>Do something.</system-reminder>' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'reminder');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0);
    assert.strictEqual(state.entries.filter(e => e.kind === 'notice').length, 1);
  });

  // [CUSTOM- Claude Code 的上下文压缩摘要（ACP `session.compaction`）不是用户输入：
  // 它必须落成独立的 compact 记录，不能变成蓝色气泡、工具卡或大纲首条。
  interface CompactState {
    kind: 'compact';
    compactionId: string;
    text: string;
    html?: string;
    status?: string;
    error?: string;
    trigger?: string;
    preTokens?: number;
  }

  function compactOf(state: TranscriptState): CompactState | undefined {
    return state.entries.find(e => e.kind === 'compact') as CompactState | undefined;
  }

  test('a compaction update creates a compact row, not a user bubble or tool card', () => {
    const harness = makeHarness('compact', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact',
      update: {
        sessionUpdate: 'compaction_update',
        compactionId: 'c1',
        status: 'completed',
        summary: [{ type: 'text', text: 'earlier context' }],
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'compact');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0,
      'a compaction summary is not something the user said');
    assert.strictEqual(state.entries.filter(e => e.kind === 'tool').length, 0,
      'it is its own record, not a tool card');
    const compact = compactOf(state);
    assert.ok(compact, 'the compaction becomes a compact row');
    assert.strictEqual(compact!.compactionId, 'c1');
    assert.strictEqual(compact!.text, 'earlier context');
    assert.strictEqual(compact!.status, 'completed');
  });

  test('an in-progress compaction does not create a row until it is terminal', () => {
    const harness = makeHarness('compact-progress', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact-progress',
      update: { sessionUpdate: 'compaction_update', compactionId: 'c2', status: 'in_progress' },
    } as any);
    let state = settle(harness, 'Claude Code', 'compact-progress');
    assert.strictEqual(state.entries.filter(e => e.kind === 'compact').length, 0,
      'no half-built row while /compact runs');

    harness.handler.handleUpdate({
      sessionId: 'compact-progress',
      update: {
        sessionUpdate: 'compaction_update', compactionId: 'c2', status: 'completed',
        summary: [{ type: 'text', text: 'done' }],
      },
    } as any);
    state = settle(harness, 'Claude Code', 'compact-progress');
    assert.strictEqual(state.entries.filter(e => e.kind === 'compact').length, 1);
  });

  test('compaction summary chunks fill the row when the terminal update omits summary', () => {
    const harness = makeHarness('compact-chunks', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact-chunks',
      update: { sessionUpdate: 'compaction_update', compactionId: 'c3', status: 'in_progress' },
    } as any);
    harness.handler.handleUpdate({
      sessionId: 'compact-chunks',
      update: {
        sessionUpdate: 'compaction_summary_chunk', compactionId: 'c3',
        content: { type: 'text', text: 'streamed ' },
      },
    } as any);
    harness.handler.handleUpdate({
      sessionId: 'compact-chunks',
      update: {
        sessionUpdate: 'compaction_summary_chunk', compactionId: 'c3',
        content: { type: 'text', text: 'summary' },
      },
    } as any);
    harness.handler.handleUpdate({
      sessionId: 'compact-chunks',
      update: { sessionUpdate: 'compaction_update', compactionId: 'c3', status: 'completed' },
    } as any);

    const compact = compactOf(settle(harness, 'Claude Code', 'compact-chunks'));
    assert.ok(compact);
    assert.strictEqual(compact!.text, 'streamed summary');
  });

  test('an explicit empty summary does not resurrect accumulated chunks', () => {
    const harness = makeHarness('compact-clear', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact-clear',
      update: { sessionUpdate: 'compaction_update', compactionId: 'c4', status: 'in_progress' },
    } as any);
    harness.handler.handleUpdate({
      sessionId: 'compact-clear',
      update: {
        sessionUpdate: 'compaction_summary_chunk', compactionId: 'c4',
        content: { type: 'text', text: 'stale' },
      },
    } as any);
    harness.handler.handleUpdate({
      sessionId: 'compact-clear',
      update: { sessionUpdate: 'compaction_update', compactionId: 'c4', status: 'completed', summary: [] },
    } as any);

    const compact = compactOf(settle(harness, 'Claude Code', 'compact-clear'));
    assert.ok(compact);
    assert.strictEqual(compact!.text, '');
  });

  test('a failed compaction records its readable error', () => {
    const harness = makeHarness('compact-failed', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact-failed',
      update: {
        sessionUpdate: 'compaction_update', compactionId: 'c5', status: 'failed', error: 'out of room',
      },
    } as any);

    const compact = compactOf(settle(harness, 'Claude Code', 'compact-failed'));
    assert.ok(compact);
    assert.strictEqual(compact!.status, 'failed');
    assert.match(compact!.error ?? '', /Compaction failed: out of room/);
  });

  test('a compact-summary user chunk becomes a compact row, not a user bubble', () => {
    const harness = makeHarness('compact-fallback', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact-fallback',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'm-compact',
        content: {
          type: 'text',
          text: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nreal summary',
        },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'compact-fallback');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0,
      'the legacy adapter fallback must not create a user bubble');
    assert.strictEqual(state.entries.filter(e => e.kind === 'notice').length, 0,
      'it is a compact row, not a notice');
    const compact = compactOf(state);
    assert.ok(compact);
    assert.strictEqual(compact!.compactionId, 'm-compact');
    assert.strictEqual(compact!.text, 'real summary');
  });

  test('fallback chunks with the same messageId stay on one compact row', () => {
    const harness = makeHarness('compact-fallback-chunks', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact-fallback-chunks',
      update: {
        sessionUpdate: 'user_message_chunk', messageId: 'm-compact-2',
        content: {
          type: 'text',
          text: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nreal summary',
        },
      },
    } as any);
    harness.handler.handleUpdate({
      sessionId: 'compact-fallback-chunks',
      update: {
        sessionUpdate: 'user_message_chunk', messageId: 'm-compact-2',
        content: { type: 'text', text: ' and more' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'compact-fallback-chunks');
    const rows = state.entries.filter(e => e.kind === 'compact') as CompactState[];
    assert.strictEqual(rows.length, 1, 'one summary = one row');
    assert.strictEqual(rows[0].text, 'real summary and more');
  });

  test('preloaded compact markers and metadata drive the row without the text prefix', () => {
    const harness = makeHarness('compact-preload', 'Claude Code');
    harness.surface.sent.length = 0;
    (harness.host as any).replayUserParts.set('compact-preload', new Map([
      ['sum-1', { images: [], files: [], hasProse: true, compactSummary: true }],
    ]));
    (harness.host as any).replayCompactions.set('compact-preload', new Map([
      ['sum-1', { trigger: 'auto', preTokens: 176200 }],
    ]));

    harness.handler.handleUpdate({
      sessionId: 'compact-preload',
      update: {
        sessionUpdate: 'user_message_chunk', messageId: 'sum-1',
        content: { type: 'text', text: 'unframed summary' },
      },
    } as any);

    const compact = compactOf(settle(harness, 'Claude Code', 'compact-preload'));
    assert.ok(compact);
    assert.strictEqual(compact!.text, 'unframed summary');
    assert.strictEqual(compact!.trigger, 'auto');
    assert.strictEqual(compact!.preTokens, 176200);
  });

  test('a terminal compaction wins over a later fallback user chunk', () => {
    const harness = makeHarness('compact-dedupe', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact-dedupe',
      update: {
        sessionUpdate: 'compaction_update', compactionId: 'c6', status: 'completed',
        summary: [{ type: 'text', text: 'authoritative' }],
      },
    } as any);
    harness.handler.handleUpdate({
      sessionId: 'compact-dedupe',
      update: {
        sessionUpdate: 'user_message_chunk', messageId: 'c6',
        content: {
          type: 'text',
          text: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nfallback',
        },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'compact-dedupe');
    const rows = state.entries.filter(e => e.kind === 'compact') as CompactState[];
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].text, 'authoritative');
  });

  test('compact summaries are part of the markdown prefill', () => {
    const harness = makeHarness('compact-markdown', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact-markdown',
      update: {
        sessionUpdate: 'compaction_update', compactionId: 'c7', status: 'completed',
        summary: [{ type: 'text', text: '**bold** summary' }],
      },
    } as any);

    const compact = compactOf(settle(harness, 'Claude Code', 'compact-markdown'));
    assert.ok(compact);
    assert.ok(compact!.html && compact!.html.length > 0, 'the summary html is rendered before the snapshot');
  });

  test('a full-chain replay keeps the real first prompt before the compact row', () => {
    // The adapter rebuilds the pre-compaction history from the raw transcript; the
    // summary is then a compaction_update between old and new messages.
    const harness = makeHarness('compact-full-chain', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'compact-full-chain',
      update: {
        sessionUpdate: 'user_message_chunk', messageId: 'u1',
        content: { type: 'text', text: 'first question' },
      },
    } as any);
    harness.handler.handleUpdate({
      sessionId: 'compact-full-chain',
      update: {
        sessionUpdate: 'compaction_update', compactionId: 's1', status: 'completed',
        summary: [{ type: 'text', text: 'summary body' }],
      },
    } as any);
    harness.handler.handleUpdate({
      sessionId: 'compact-full-chain',
      update: {
        sessionUpdate: 'user_message_chunk', messageId: 'u2',
        content: { type: 'text', text: 'second question' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'compact-full-chain');
    const first = state.entries[0] as { kind: string; text?: string };
    assert.strictEqual(first.kind, 'user', 'the first record is the real prompt');
    assert.strictEqual(first.text, 'first question');

    const compactIndex = state.entries.findIndex(e => e.kind === 'compact');
    const secondIndex = state.entries.findIndex(
      e => e.kind === 'user' && (e as { text?: string }).text === 'second question',
    );
    assert.ok(compactIndex > 0, 'the compact row is after the pre-compaction history');
    assert.ok(secondIndex > compactIndex, 'the post-compaction message is after the compact row');
    assert.ok(
      !state.entries.some(
        e => e.kind === 'user'
          && String((e as { text?: string }).text ?? '').startsWith('This session is being continued'),
      ),
      'the summary never becomes a user bubble',
    );
  });

  // [CUSTOM- IDE 注入的"当前打开的文件"上下文（`<ide_opened_file>…</ide_opened_file>`）
  // 是**上下文**，不是用户说过的话。它以前按普通 user chunk 走 ⇒ 同一条消息渲染成**两个**蓝色气泡
  // （用户报："附加的文件没有合并到一个对话里（预期是跟图片附件一样显示），现在是分成了两条对话"）。
  // 现在：块不建记录，文件作为 **chip 挂到同一条消息的用户气泡**上（与官方插件同款：chip 在上、正文在下）。
  const IDE_BLOCK = '<ide_opened_file>The user opened the file d:/work/src/DemoFile.cs in the IDE. '
    + 'This may or may not be related to the current task.</ide_opened_file>';

  function feedUserChunks(sessionId: string, chunks: string[]): Harness {
    const harness = makeHarness(sessionId, 'Claude Code');
    harness.surface.sent.length = 0;
    for (const text of chunks) {
      harness.handler.handleUpdate({
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', messageId: 'm-ide', content: { type: 'text', text } },
      } as any);
    }
    return harness;
  }

  test('an ide_opened_file block becomes a file chip on the message, not a second bubble', () => {
    const harness = feedUserChunks('ide', [IDE_BLOCK, '两边都提交git']);
    const state = settle(harness, 'Claude Code', 'ide');

    const users = state.entries.filter(e => e.kind === 'user');
    assert.strictEqual(users.length, 1, '一条消息 = 一个气泡（以前是两条：ide 原文 + 正文）');
    assert.strictEqual(users[0].text, '两边都提交git', '气泡里是正文，不是那段注入文本');
    const attachments = (users[0] as { attachments?: Array<{ path?: string; name?: string }> }).attachments ?? [];
    assert.strictEqual(attachments.length, 1, '文件成了这条消息上的 chip');
    assert.strictEqual(attachments[0].path, 'd:/work/src/DemoFile.cs', '点它走 openFile');
    assert.strictEqual(attachments[0].name, 'DemoFile.cs', 'chip 显示文件名（官方插件同款）');
    assert.strictEqual(state.entries.filter(e => e.kind === 'notice').length, 0, '也不是提示条');
  });

  test('an ide_opened_file block with no message after it adds no record at all', () => {
    const harness = feedUserChunks('ide-only', [IDE_BLOCK]);
    const state = settle(harness, 'Claude Code', 'ide-only');
    assert.strictEqual(state.entries.length, 0, '只开了个文件，没有消息 ⇒ 什么都不该冒出来');
  });

  test('other <ide_…> context blocks are notices, not user bubbles', () => {
    const harness = feedUserChunks('ide-sel', ['<ide_selection>The user selected lines 1 to 9 from piano.cs</ide_selection>']);
    const state = settle(harness, 'Claude Code', 'ide-sel');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0, 'IDE 上下文不是"我说过的话"');
    assert.strictEqual(state.entries.filter(e => e.kind === 'notice').length, 1);
  });

  test('a plain user message is still a user bubble', () => {
    const harness = makeHarness('plain', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'plain',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'm-plain',
        content: { type: 'text', text: 'hello, this is a real question' },
      },
    } as any);

    const state = settle(harness, 'Claude Code', 'plain');
    assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 1,
      'a real user message is not diverted');
  });

  // [CUSTOM- Replay delivers a user message's text and its images as
  // separate chunks (100). The bubble has nothing to merge with unless the host reads
  // the transcript — so the image rides in on the text chunk, and the image chunk that
  // follows must NOT become a second row.
  test('a replayed user message carries its images in the bubble, and the image chunk is dropped', async () => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }   // no workspace folder ⇒ no transcript bucket to read
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-img-replay-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const bucket = path.join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucket, { recursive: true });
      fs.writeFileSync(path.join(bucket, 's-img.jsonl'), [
        JSON.stringify({
          type: 'user', uuid: 'u-img', timestamp: '2026-09-25T10:00:00.000Z',
          message: { role: 'user', content: [
            { type: 'text', text: 'look at this' },
            // Claude Code 的转录格式：source:{ type:'base64', media_type, data }
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ] },
        }),
      ].join('\n'));

      const harness = makeHarness('s-img', 'Claude Code');
      harness.surface.sent.length = 0;
      await (harness.host as any).preloadTranscriptTimes('Claude Code', 's-img');

      harness.handler.handleUpdate({
        sessionId: 's-img',
        update: { sessionUpdate: 'user_message_chunk', messageId: 'u-img', content: { type: 'text', text: 'look at this' } },
      } as any);
      harness.handler.handleUpdate({
        sessionId: 's-img',
        update: { sessionUpdate: 'user_message_chunk', messageId: 'u-img', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } },
      } as any);

      const state = settle(harness, 'Claude Code', 's-img');
      const users = state.entries.filter(e => e.kind === 'user');
      const contents = state.entries.filter(e => e.kind === 'content');
      assert.strictEqual(users.length, 1, 'one user entry');
      assert.strictEqual(contents.length, 0, 'the image chunk does not become a second row');
      const user = users[0] as { attachments?: Array<{ type: string; dataUri: string }> };
      assert.ok(user.attachments, 'the bubble carries the images');
      assert.strictEqual(user.attachments!.length, 1);
      assert.strictEqual(user.attachments![0].type, 'image');
      assert.ok(user.attachments![0].dataUri.startsWith('data:image/png;base64,'));
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // [CUSTOM- 文件引用在转录里**不是块，是一段文本**（agent 把 `resource_link`
  // 序列化成 `[@名](file:///…)`），回放时作为**单独一条** user chunk 发回来。原先它被当正文，
  // 于是重开后多出一条蓝色气泡、把 markdown 原样显示出来（用户报的就是这个）。
  test('a replayed user message carries its file references in the bubble, and the mention chunk is dropped', async () => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }   // no workspace folder ⇒ no transcript bucket to read
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-ref-replay-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const bucket = path.join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucket, { recursive: true });
      const target = 'd%3A/work/project/Source/Client/DemoFile.cs';
      fs.writeFileSync(path.join(bucket, 's-ref.jsonl'), [
        JSON.stringify({
          type: 'user', uuid: 'u-ref', timestamp: '2026-10-09T10:00:00.000Z',
          message: { role: 'user', content: [
            { type: 'text', text: '还是很多波浪线' },
            { type: 'text', text: `[@DemoFile.cs#L437-440](file:///${target}#L437-440)` },
          ] },
        }),
      ].join('\n'));

      const harness = makeHarness('s-ref', 'Claude Code');
      harness.surface.sent.length = 0;
      await (harness.host as any).preloadTranscriptTimes('Claude Code', 's-ref');

      harness.handler.handleUpdate({
        sessionId: 's-ref',
        update: { sessionUpdate: 'user_message_chunk', messageId: 'u-ref', content: { type: 'text', text: '还是很多波浪线' } },
      } as any);
      harness.handler.handleUpdate({
        sessionId: 's-ref',
        update: {
          sessionUpdate: 'user_message_chunk', messageId: 'u-ref',
          content: { type: 'text', text: `[@DemoFile.cs#L437-440](file:///${target}#L437-440)` },
        },
      } as any);

      const state = settle(harness, 'Claude Code', 's-ref');
      const users = state.entries.filter(e => e.kind === 'user');
      const contents = state.entries.filter(e => e.kind === 'content');
      assert.strictEqual(users.length, 1, 'the mention does not become a second user bubble');
      assert.strictEqual(contents.length, 0, 'and not a content row either');
      const user = users[0] as { text: string; attachments?: Array<{ type: string; name: string; path?: string; uri: string; line?: number; endLine?: number }> };
      assert.strictEqual(user.text, '还是很多波浪线', 'the prose stays the bubble text');
      assert.ok(user.attachments, 'the bubble carries the file reference');
      assert.strictEqual(user.attachments!.length, 1);
      assert.strictEqual(user.attachments![0].type, 'resource_link');
      // `path` 存在 ⇒ chip 点击走 openFile（039/205 的既有约定），与发送时那条同形。
      assert.strictEqual(user.attachments![0].path, 'd:\\work\\project\\Source\\Client\\DemoFile.cs');
      assert.strictEqual(user.attachments![0].line, 437, '回放的 mention 也带起始行');
      assert.strictEqual(user.attachments![0].endLine, 440, '以及结束行（点击框选整段）');
      // 名字归一成 live chip 的写法（composer.ts refLabel 的 `<name>:<start>-<end>`）。
      assert.strictEqual(user.attachments![0].name, 'DemoFile.cs:437-440');
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // 只有引用、没有正文的消息（发送路径支持：215）回放时**只有**那条引用 chunk —— 丢弃的判据
  // 必须是"这条记录有没有正文"，否则它连记录一起消失（比显示成原文更糟）。
  test('a message that is only a file reference still renders after the replay', async () => {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) { return; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-refonly-replay-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const bucket = path.join(root, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
      fs.mkdirSync(bucket, { recursive: true });
      const mention = '[@a.cs](file:///f%3A/tmp/a.cs)';
      fs.writeFileSync(path.join(bucket, 's-refonly.jsonl'), [
        JSON.stringify({
          type: 'user', uuid: 'u-refonly', timestamp: '2026-10-09T10:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: mention }] },
        }),
      ].join('\n'));

      const harness = makeHarness('s-refonly', 'Claude Code');
      harness.surface.sent.length = 0;
      await (harness.host as any).preloadTranscriptTimes('Claude Code', 's-refonly');

      harness.handler.handleUpdate({
        sessionId: 's-refonly',
        update: { sessionUpdate: 'user_message_chunk', messageId: 'u-refonly', content: { type: 'text', text: mention } },
      } as any);

      const state = settle(harness, 'Claude Code', 's-refonly');
      assert.strictEqual(state.entries.filter(e => e.kind === 'user').length, 0, 'no prose ⇒ no bubble');
      const contents = state.entries.filter(e => e.kind === 'content');
      assert.strictEqual(contents.length, 1, 'the reference itself is the record (same shape as sending)');
      const blocks = (contents[0] as { blocks: Array<{ type: string; path?: string }> }).blocks;
      assert.strictEqual(blocks.length, 1);
      assert.strictEqual(blocks[0].type, 'resource_link');
      assert.strictEqual(blocks[0].path, 'f:\\tmp\\a.cs');
      // 原文那串 markdown 绝不能出现在任何记录里。
      assert.ok(!visibleText(state).includes('](file:///'), 'the raw markdown is never shown');
    } finally {
      if (previous === undefined) { delete process.env.CLAUDE_CONFIG_DIR; }
      else { process.env.CLAUDE_CONFIG_DIR = previous; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// [CUSTOM- 工具卡标题（agent 写的 description）——对齐官方插件的
// "Bash 查看博客目录及父目录现有内容"。数据来源是抓包夹具里**真实**的 Bash 载荷：
// `rawInput.description` 与 `_meta.claudeCode.title` 同一个字符串，而 Read 卡两者都没有
// （用来钉"没有就回退"这一半）。
//
// 为什么要 latch：真夹具里 description 出现在**第 3 条 update**，而 `_meta` 是整体替换、
// 之后那条 toolResponse update 就把 `_meta.claudeCode.title` 抹掉了。任何"要用时再读一遍"
// 的写法都会让标题在下一个 chunk 闪回命令行——而且**没有任何报错**。
suite('chat panel: tool card description ()', () => {
  test('the description is latched: it survives the update that replaces _meta', () => {
    const store = new ToolInvocationStore();
    const meta = (extra: Record<string, unknown>) => ({ claudeCode: { toolName: 'Bash', ...extra } });
    store.upsertCall('s1', {
      toolCallId: 'c1', title: 'Terminal', kind: 'execute', status: 'pending',
      content: [], locations: [], rawInput: {}, _meta: meta({}),
    } as never);
    store.upsertUpdate('s1', { toolCallId: 'c1', rawInput: { command: 'ls -la' }, _meta: meta({}) } as never);
    store.upsertUpdate('s1', {
      toolCallId: 'c1', title: 'ls -la', rawInput: { command: 'ls -la', description: 'List files' },
      _meta: meta({ title: 'List files' }),
    } as never);
    // The shape the real capture ends on: _meta replaced WITHOUT the title, no rawInput key.
    store.upsertUpdate('s1', { toolCallId: 'c1', _meta: meta({ toolResponse: { stdout: 'x' } }) } as never);

    assert.strictEqual(store.get('s1', 'c1')!.description, 'List files',
      'the description must survive every later update');
  });

  test('a call that publishes no description is left without one', () => {
    const store = new ToolInvocationStore();
    store.upsertCall('s1', {
      toolCallId: 'c2', title: 'Read File', kind: 'read', status: 'pending',
      content: [], locations: [], rawInput: { file_path: 'a.ts' }, _meta: { claudeCode: { toolName: 'Read' } },
    } as never);
    assert.strictEqual(store.get('s1', 'c2')!.description, undefined);
  });

  test('the live replay carries the description through to the webview', () => {
    if (!fixture?.sessionId) { return; }
    // The harness session must BE the fixture's session: the host routes every
    // notification by sessionId and silently drops unknown ones (the first version of
    // this test used a made-up id and asserted on an empty message list).
    const harness = makeHarness(fixture.sessionId, 'Claude Code');
    feed(harness, phaseOf(fixture, 'live'));
    settle(harness, 'Claude Code', fixture.sessionId);

    // Every path a view model can take to the client: `append` (the card's first
    // paint) carries it on the entry, `toolUpdate` carries it on its own, and a
    // snapshot (boot / focus) carries entries too. Which one fires is the host's
    // business — the assertion is about the view model that reaches the client.
    const views: Array<{ toolCallId: string; title: string; description?: string; command: string | null }> = [];
    for (const message of harness.surface.sent as Array<Record<string, unknown>>) {
      if (message.type === 'toolUpdate') { views.push(message.tool as never); }
      if (message.type === 'append') {
        for (const entry of (message.entries as Array<Record<string, unknown>>) ?? []) {
          if (entry.toolView) { views.push(entry.toolView as never); }
        }
      }
      if (message.type === 'boot' || message.type === 'focus') {
        const snapshot = message.snapshot as { entries?: Array<Record<string, unknown>> } | null;
        for (const entry of snapshot?.entries ?? []) {
          if (entry.toolView) { views.push(entry.toolView as never); }
        }
      }
    }
    const bash = views.filter(v => v.command === 'ls -la').pop();
    assert.ok(bash, `the Bash card must have reached the webview (saw ${views.length} views)`);
    assert.strictEqual(bash!.description, 'List files in the working directory',
      'the agent-written description travels in the view model');
    assert.strictEqual(bash!.title, 'ls -la',
      'the ACP title is untouched — it is the IN line and the rail tooltip');
    // …and a tool that publishes none is left alone, so the client falls back to title.
    const read = views.filter(v => (v.command ?? null) === null && v.title.startsWith('Read')).pop();
    assert.ok(read, 'the Read card must have reached the webview too');
    assert.strictEqual(read!.description, undefined, 'no invented description');
  });
});

// [CUSTOM- 子 agent 的身份：用户问"主 agent 输出与子 agent 输出能区分吗"。
// ACP 没有答案（没有 subagent 概念）。判据是厂商专属键：`rawInput.subagent_type`（首帧就有）
// 与更早一次载荷的 `_meta.claudeCode.toolResponse.agentType` —— 两者都认，都没有就当不是委派。
// 锁存而不是按需读（`_meta` 整体替换、`rawInput` 只在首帧给全：117 的教训）。
suite('chat panel: sub-agent identity ()', () => {
  test('rawInput.subagent_type marks a delegation from the first frame', () => {
    const store = new ToolInvocationStore();
    store.upsertCall('s1', {
      toolCallId: 'a1', title: 'World doc C-tier review', kind: 'think', status: 'pending',
      content: [], locations: [],
      rawInput: { description: 'World doc C-tier review', prompt: '…', subagent_type: 'story_editor' },
      _meta: { claudeCode: { toolName: 'Agent' } },
    } as never);
    const inv = store.get('s1', 'a1')!;
    assert.strictEqual(inv.subagent?.type, 'story_editor');
    assert.strictEqual(toToolCallView(inv).subagent?.type, 'story_editor');
  });

  test('the older toolResponse.agentType shape is also honoured and latched', () => {
    const store = new ToolInvocationStore();
    const meta = (response?: Record<string, unknown>) =>
      ({ claudeCode: response ? { toolName: 'Agent', toolResponse: response } : { toolName: 'Agent' } });
    store.upsertCall('s1', {
      toolCallId: 'a1', title: 'Task', kind: 'think', status: 'in_progress',
      content: [], locations: [], rawInput: {}, _meta: meta(),
    } as never);
    assert.strictEqual(store.get('s1', 'a1')!.subagent, undefined, 'nothing reported yet');

    store.upsertUpdate('s1', {
      toolCallId: 'a1', status: 'completed',
      _meta: meta({
        agentType: 'story_editor', agentId: 'a3bd09f1ce4d3cc7d',
        resolvedModel: 'claude-opus-5.5', totalTokens: 152136, totalDurationMs: 924103,
      }),
    } as never);
    // The shape the real stream ends on: the next update replaces `_meta` wholesale,
    // with no toolResponse at all.
    store.upsertUpdate('s1', { toolCallId: 'a1', _meta: meta() } as never);

    const inv = store.get('s1', 'a1')!;
    assert.ok(inv.subagent, 'the identity survives the update that drops _meta');
    assert.strictEqual(inv.subagent!.type, 'story_editor');
    assert.strictEqual(inv.subagent!.agentId, 'a3bd09f1ce4d3cc7d');
    assert.strictEqual(inv.subagent!.model, 'claude-opus-5.5');
    assert.strictEqual(inv.subagent!.tokens, 152136);
    assert.strictEqual(inv.subagent!.durationMs, 924103);
  });

  test('a payload without either known key reports no sub-agent', () => {
    const store = new ToolInvocationStore();
    // `_meta.toolResponse` without `agentType`（实测 Bash 就是 {stdout,stderr,…}）+ 输入里也没有
    // `subagent_type` ⇒ 不是一次可识别的委派，整条都不猜（与 extractToolName 同规矩）。
    store.upsertCall('s1', {
      toolCallId: 'a2', title: 'Read', kind: 'read', status: 'completed', content: [], locations: [],
      rawInput: { file_path: 'a.ts' },
      _meta: { claudeCode: { toolName: 'Read', toolResponse: { status: 'completed' } } },
    } as never);
    assert.strictEqual(store.get('s1', 'a2')!.subagent, undefined);
  });
});

// [CUSTOM- 真数据驱动的工具卡回归：`src/test/fixtures/claude-code-bash-tools.json`
// 是 2026-09-29 用 `capture-acp-replay.mjs` 抓的一次真实 Bash 轮次（两条命令：一条成功、
// 一条失败）。它存在的理由：工具卡的 OUT 曾经是**空的**，而"空"有两个独立成因
// （空白文本项 / markdown 请求没人发），只看桩数据发现不了——夹具里那两条更新的形状
// 就是真机的样子：中段 update 的 content 是**描述**，最后一条才是 ```console 输出块 +
// rawOutput。判据必须跟着真载荷走。
const BASH_FIXTURE_PATH = path.resolve(
  __dirname, '..', '..', 'src', 'test', 'fixtures', 'claude-code-bash-tools.json',
);

function loadBashFixture(): Fixture | null {
  if (!fs.existsSync(BASH_FIXTURE_PATH)) { return null; }
  return JSON.parse(fs.readFileSync(BASH_FIXTURE_PATH, 'utf8')) as Fixture;
}

// [CUSTOM- 宿主对 renderMarkdown 的**逐项**校验：没有 sessionId 的项被静默跳过。
// 这条规则一直存在（协议里 sessionId 是必填），而客户端**工具项**曾经不带它 —— 于是工具正文的
// markdown 请求全部被丢弃、卡上留一个空 .tool-text，两个进程都不报错。这里把规则钉死，
// 客户端侧的对应断言在 chat-client.test.ts（'the render request carries the session id'）。
suite('chat panel: renderMarkdown item validation ()', () => {
  test('an item without a sessionId is dropped; the same item with one is rendered', () => {
    if (!fixture?.sessionId) { return; }
    const harness = makeHarness(fixture.sessionId, 'Claude Code');
    harness.surface.sent.length = 0;

    harness.host.onMessage({
      type: 'renderMarkdown',
      items: [
        { entryId: 'e-nosession', text: 'no session' },
        { entryId: 'e-ok', sessionId: fixture.sessionId, key: 'slot#1', text: 'hi there' },
      ],
    } as never);

    // The reply goes through the Outbox (one frame of coalescing) — flush it the way a
    // focus change does, or the assertion below sees an empty message list.
    settle(harness, 'Claude Code', fixture.sessionId);
    const replies = harness.surface.sent.filter(m => m.type === 'markdownRendered') as Array<{
      items: Array<{ entryId: string; html: string; key?: string }>;
    }>;
    assert.strictEqual(replies.length, 1, 'the host answers what it accepted');
    const answered = replies[0].items;
    assert.deepStrictEqual(answered.map(i => i.entryId), ['e-ok'],
      'the item with no session id never comes back — a silent drop, which is why the client must send it');
    assert.ok(answered[0].html.includes('hi there'), 'and the accepted one really was rendered');
  });

  // [CUSTOM- 大会话回放时客户端一次发来几百条；旧实现只要数组里混进一个 null
  // 就在 `item.entryId` 上抛异常 —— 整批不回包，而批尾正是"最后一条消息"。
  // 这条用例把"坏项不影响其余项"钉死（play 里不会出现坏项，但一次异常的全部代价
  // 是**静默的**：没有日志、没有回包，只有一条永远停在原文的记录）。
  test('a malformed item cannot take the whole batch (and its reply) down', () => {
    const sessionId = 'malformed-batch';
    const harness = makeHarness(sessionId, 'Claude Code');
    harness.surface.sent.length = 0;

    harness.host.onMessage({
      type: 'renderMarkdown',
      items: [
        null,
        'junk',
        { entryId: 'missing-text', sessionId },
        { entryId: 'e-good', sessionId, key: 'slot#1', text: 'still rendered' },
      ],
    } as never);
    settle(harness, 'Claude Code', sessionId);

    const replies = harness.surface.sent.filter(m => m.type === 'markdownRendered') as Array<{
      items: Array<{ entryId: string; html: string; key?: string }>;
    }>;
    assert.strictEqual(replies.length, 1, 'the good item must still be answered');
    assert.deepStrictEqual(replies[0].items.map(i => i.entryId), ['e-good']);
    assert.ok(replies[0].items[0].html.includes('still rendered'));
  });

  // [CUSTOM- 用户报"右键 Copy / Copy message 没反应"时，两个进程之前都没有一行
  // 日志。这条用例至少把宿主这一段（写剪贴板）钉住；客户端侧的 'context copy' 日志
  // 与宿主的 'copied N char(s)' 合起来能区分"点击没跑 / 消息没到 / 剪贴板拒绝"。
  test('a copy message writes the text to the clipboard', async () => {
    const sessionId = 'copy-clipboard';
    const harness = makeHarness(sessionId, 'Claude Code');
    // The clipboard is machine-global: put back whatever the developer had.
    let previous = '';
    try { previous = await vscode.env.clipboard.readText(); } catch { /* no clipboard: fine */ }
    try {
      await vscode.env.clipboard.writeText('seed');
      harness.host.onMessage({ type: 'copy', text: 'copied through the panel' });

      let got = '';
      for (let i = 0; i < 50 && got !== 'copied through the panel'; i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
        got = await vscode.env.clipboard.readText();
      }
      assert.strictEqual(got, 'copied through the panel');
    } finally {
      try { await vscode.env.clipboard.writeText(previous); } catch { /* nothing to restore */ }
    }
  });
});

// [CUSTOM- Read may infer a language only from host-owned kind/location/content.
suite('chat panel: Read syntax highlighting ()', () => {
  const BODY = '1\tconst value: number = 1;\n2\tconsole.log(value);';
  const READ_TEXT = '```\n' + BODY + '\n```';

  function sendTool(
    harness: Harness,
    toolCallId: string,
    kind: string,
    locations: Array<{ path: string; line?: number }>,
    text: string,
  ): void {
    harness.handler.handleUpdate({
      sessionId: harness.sessionId,
      update: {
        sessionUpdate: 'tool_call', toolCallId, title: 'Read file', kind, status: 'pending',
        content: [], locations: [], rawInput: { file_path: locations[0]?.path },
      },
    } as never);
    harness.handler.handleUpdate({
      sessionId: harness.sessionId,
      update: {
        sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', locations,
        content: [{ type: 'content', content: { type: 'text', text } }],
      },
    } as never);
  }

  function toolEntry(harness: Harness, toolCallId: string): Record<string, any> {
    for (const message of harness.surface.sent) {
      if (message.type !== 'append') { continue; }
      for (const entry of message.entries as Array<Record<string, any>>) {
        if (entry.kind === 'tool' && entry.toolCallId === toolCallId) { return entry; }
      }
    }
    throw new Error(`no tool entry for ${toolCallId}`);
  }

  function latestToolView(harness: Harness, entryId: string): Record<string, any> {
    let view: Record<string, any> | undefined;
    for (const message of harness.surface.sent) {
      if (message.type === 'toolUpdate' && (message as { entryId?: string }).entryId === entryId) {
        view = (message as { tool?: Record<string, any> }).tool;
      }
    }
    return view ?? {};
  }

  function askMarkdown(
    harness: Harness,
    entry: Record<string, any>,
    text: string,
    extra: Record<string, unknown> = {},
  ): { html: string; key?: string } {
    harness.surface.sent.length = 0;
    harness.host.onMessage({
      type: 'renderMarkdown',
      items: [{ entryId: entry.id, sessionId: harness.sessionId, key: 'slot#1', text, ...extra }],
    } as never);
    settle(harness, harness.agentName, harness.sessionId);
    const reply = harness.surface.sent.filter(m => m.type === 'markdownRendered') as Array<{
      items: Array<{ entryId: string; html: string; key?: string }>;
    }>;
    const item = reply.flatMap(r => r.items).find(i => i.entryId === entry.id && i.key === 'slot#1');
    if (!item) { throw new Error('the host did not answer the Read markdown request'); }
    return item;
  }

  function textContentOf(html: string): string {
    const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? html;
    return code.replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  test('a Read card is highlighted from its one trusted file location', () => {
    const harness = makeHarness('read-highlight', 'Claude Code');
    sendTool(harness, 'read-1', 'read', [{ path: '/repo/src/app.ts', line: 1 }], READ_TEXT);
    settle(harness, harness.agentName, harness.sessionId);
    const entry = toolEntry(harness, 'read-1');
    const viewText = latestToolView(harness, entry.id).items[0].block.text;

    const item = askMarkdown(harness, entry, viewText);
    assert.ok(item.html.includes('language-typescript'), 'inferred from the host-owned path');
    assert.ok(item.html.includes('hljs-keyword'));
    assert.strictEqual(textContentOf(item.html), BODY,
      'highlighting must not change the line-number + tab textContent');
    harness.host.dispose();
  });

  test('explicit fence languages are left untouched', () => {
    const harness = makeHarness('read-explicit', 'Claude Code');
    const text = '```python\nprint("x")\n```';
    sendTool(harness, 'read-1', 'read', [{ path: '/repo/src/app.ts', line: 1 }], text);
    settle(harness, harness.agentName, harness.sessionId);
    const entry = toolEntry(harness, 'read-1');

    const item = askMarkdown(harness, entry, text);
    assert.ok(item.html.includes('language-python'));
    assert.ok(!item.html.includes('language-typescript'));
    harness.host.dispose();
  });

  test('only Read with exactly one known location qualifies', () => {
    const cases: Array<{ id: string; kind: string; locations: Array<{ path: string; line?: number }> }> = [
      { id: 'execute', kind: 'execute', locations: [{ path: '/repo/src/app.ts' }] },
      { id: 'no-location', kind: 'read', locations: [] },
      { id: 'two-locations', kind: 'read', locations: [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }] },
      { id: 'unknown-extension', kind: 'read', locations: [{ path: '/repo/a.txt' }] },
    ];
    for (const testCase of cases) {
      const harness = makeHarness('read-' + testCase.id, 'Claude Code');
      sendTool(harness, testCase.id, testCase.kind, testCase.locations, READ_TEXT);
      settle(harness, harness.agentName, harness.sessionId);
      const entry = toolEntry(harness, testCase.id);

      const item = askMarkdown(harness, entry, READ_TEXT);
      assert.ok(!item.html.includes('language-typescript'),
        `${testCase.id} must not borrow a language`);
      assert.strictEqual(textContentOf(item.html), BODY, 'the text still renders unchanged');
      harness.host.dispose();
    }
  });

  test('a client-supplied path or language cannot change the inference', () => {
    const harness = makeHarness('read-spoof', 'Claude Code');
    sendTool(harness, 'read-1', 'read', [{ path: '/repo/a.txt', line: 1 }], READ_TEXT);
    settle(harness, harness.agentName, harness.sessionId);
    const entry = toolEntry(harness, 'read-1');

    const item = askMarkdown(harness, entry, READ_TEXT, {
      path: '/repo/src/app.ts', language: 'typescript',
    });
    assert.ok(!item.html.includes('language-typescript'), 'the host never reads these fields');
    harness.host.dispose();
  });

  test('a replayed Read is not swept into the prose prefill and highlights on request', () => {
    const harness = makeHarness('read-replay', 'Claude Code');
    harness.sessionManager.emit('session-load-start', harness.sessionId, harness.agentName);
    sendTool(harness, 'read-1', 'read', [{ path: '/repo/src/app.ts', line: 1 }], READ_TEXT);
    harness.sessionManager.emit('session-load-end', harness.sessionId, harness.agentName, true);
    settle(harness, harness.agentName, harness.sessionId);
    const entry = toolEntry(harness, 'read-1');
    const revised = harness.surface.sent.some(message => message.type === 'revise'
      && (message as { entryId?: string }).entryId === entry.id);
    assert.ok(!revised, 'the host prefill covers prose records only');

    const viewText = latestToolView(harness, entry.id).items[0].block.text;
    const item = askMarkdown(harness, entry, viewText);
    assert.ok(item.html.includes('language-typescript'));
    assert.strictEqual(textContentOf(item.html), BODY);
    harness.host.dispose();
  });

  test('the captured Read (a.txt) never guesses a language and keeps its text', () => {
    if (!fixture?.sessionId) { return; }
    const harness = makeHarness(fixture.sessionId, 'Claude Code');
    feed(harness, phaseOf(fixture, 'live'));
    settle(harness, harness.agentName, harness.sessionId);
    let entry: Record<string, any> | undefined;
    for (const message of harness.surface.sent) {
      if (message.type !== 'append') { continue; }
      for (const candidate of message.entries as Array<Record<string, any>>) {
        if (candidate.kind !== 'tool') { continue; }
        const view = latestToolView(harness, candidate.id);
        if (view.kind === 'read' && view.items && view.items.length > 0) { entry = candidate; break; }
      }
      if (entry) { break; }
    }
    assert.ok(entry, 'the capture contains a Read card');
    const text = latestToolView(harness, entry!.id).items[0].block.text;
    const item = askMarkdown(harness, entry!, text);
    assert.ok(!item.html.includes('language-'), 'a .txt path is not mapped to a language');
    assert.ok(textContentOf(item.html).includes('alpha'));
    harness.host.dispose();
  });
});

suite('chat panel: Bash tool payloads (real capture, )', () => {
  const bash = loadBashFixture();

  function toolViewsFor(fixture: Fixture, phase: string): Array<Record<string, unknown>> {
    const harness = makeHarness(fixture.sessionId as string, 'Claude Code');
    feed(harness, phaseOf(fixture, phase));
    settle(harness, 'Claude Code', fixture.sessionId as string);
    const views: Array<Record<string, unknown>> = [];
    for (const message of harness.surface.sent as Array<Record<string, unknown>>) {
      if (message.type === 'toolUpdate') { views.push(message.tool as Record<string, unknown>); }
      if (message.type === 'append') {
        for (const entry of (message.entries as Array<Record<string, unknown>>) ?? []) {
          if (entry.toolView) { views.push(entry.toolView as Record<string, unknown>); }
        }
      }
      if (message.type === 'boot' || message.type === 'focus') {
        const snapshot = message.snapshot as { entries?: Array<Record<string, unknown>> } | null;
        for (const entry of snapshot?.entries ?? []) {
          if (entry.toolView) { views.push(entry.toolView as Record<string, unknown>); }
        }
      }
    }
    return views;
  }

  /** The text of a view's content items, joined. */
  function itemText(view: Record<string, unknown>): string {
    const items = (view.items as Array<{ block?: { text?: string } }>) ?? [];
    return items.map(i => i.block?.text ?? '').join('\n');
  }

  test('live: the Bash output reaches the view model as renderable text', function () {
    if (!bash?.sessionId) { this.skip(); }
    const views = toolViewsFor(bash, 'live').filter(v => v.command === 'ls -la');
    assert.ok(views.length > 0, 'the Bash card reached the webview');
    const last = views[views.length - 1];
    assert.strictEqual(last.description, 'List files in current directory',
      'the human description is latched (it arrives mid-stream)');
    const text = itemText(last);
    assert.ok(text.includes('total 38147'),
      `the OUTPUT must be in the items — an empty OUT is the bug this fixture pins. Got: ${JSON.stringify(text.slice(0, 120))}`);
    assert.ok(typeof last.output === 'string' && (last.output as string).includes('total 38147'),
      'and rawOutput is exposed too, as the fallback when no item is renderable');
  });

  test('replay: the same output survives a re-opened session', function () {
    if (!bash?.sessionId) { this.skip(); }
    const views = toolViewsFor(bash, 'replay').filter(v => v.command === 'ls -la');
    assert.ok(views.length > 0, 'the replayed Bash card reached the webview');
    const last = views[views.length - 1];
    assert.ok(itemText(last).includes('total 38147'),
      'a re-opened session shows the same output (the replayed payload carries it)');
    assert.strictEqual(last.description, 'List files in current directory');
  });

  test('a failed command keeps its output and its failed status', function () {
    if (!bash?.sessionId) { this.skip(); }
    const views = toolViewsFor(bash, 'live').filter(v => v.command === 'git status --short');
    assert.ok(views.length > 0, 'the failing card reached the webview');
    const last = views[views.length - 1];
    assert.strictEqual(last.status, 'failed');
    assert.ok(itemText(last).includes('not a git repository'),
      'the error text is what the reader needs here — it must not be dropped');
  });
});

// [CUSTOM- 连接相位与自动连接开关（宿主侧协议流）。
//
// 最要紧的是**无条件回话**：`refreshSessions` 靠签名去重，而 `ensureConnected` 在进程
// 已经起来时不发任何事件 ⇒ 少了 `connection` 消息，「已连接 + 无会话 + 点 Connect」这条路上
// 宿主一句话都不会说，客户端的「连接中」就永久卡死（pitfalls #29 的形态）。
// 下面第二个用例就是那条回归钉。
suite('chat panel: connection phase and the auto-connect switch', () => {
  /** The phases the host reported, in order. */
  function phases(harness: Harness): string[] {
    return harness.surface.sent
      .filter(m => m.type === 'connection')
      .map(m => String((m as { state?: string }).state));
  }

  function connectedAt(harness: Harness): number {
    return harness.surface.sent
      .findIndex(m => m.type === 'connection' && (m as { state?: string }).state === 'connected');
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  class ConnectSessionManager extends SessionManager {
    readonly ensured: string[] = [];
    readonly liveIds: string[] = [];
    readonly created: string[] = [];
    failWith: string | null = null;

    override async ensureConnected(agentName: string): Promise<ConnectionInfo> {
      this.ensured.push(agentName);
      if (this.failWith) { throw new Error(this.failWith); }
      return {} as ConnectionInfo;
    }

    override getSessionIdsForAgent(): string[] { return this.liveIds; }

    /** [CUSTOM- A connect with no session to focus now creates one. */
    override async createSession(agentName: string): Promise<SessionInfo> {
      this.created.push(agentName);
      const sessionId = `fresh-session-${this.created.length}`;
      registerFakeSession(this, sessionId, agentName);
      return {
        sessionId,
        agentId: 'fake-agent-id',
        agentName,
        agentDisplayName: agentName,
        cwd: '/tmp',
        createdAt: new Date().toISOString(),
        initResponse: {},
        modes: null,
        models: null,
        configOptions: null,
        availableCommands: [],
      } as unknown as SessionInfo;
    }
  }

  function connectHarness(liveIds: string[] = [], prefs = new StubPrefs()): {
    harness: Harness; manager: ConnectSessionManager;
  } {
    let manager!: ConnectSessionManager;
    const harness = makeHarness('placeholder-session', 'Claude Code', handler => {
      manager = new ConnectSessionManager(new AgentManager(), new ConnectionManager(handler), handler);
      // Registered for real: `focusSession` looks the id up, and a focus is what the
      // "connected comes last" ordering test needs to observe.
      for (const id of liveIds) { registerFakeSession(manager, id, 'Claude Code'); }
      manager.liveIds.push(...liveIds);
      return manager;
    }, prefs);
    harness.surface.sent.length = 0;   // drop the attach-time boot noise
    return { harness, manager };
  }

  test('a connect reports connecting, then connected', async () => {
    const { harness, manager } = connectHarness();
    harness.host.onMessage({ type: 'connectAgent' });
    // Immediate: this is the phase that disables the button, so a frame of delay is a
    // frame in which a second click gets through.
    assert.deepStrictEqual(phases(harness), ['connecting']);
    await waitFor(() => phases(harness).length >= 2, 'connected');
    assert.deepStrictEqual(phases(harness), ['connecting', 'connected']);
    // [CUSTOM- Nothing to focus ⇒ a session is created, so the composer the
    // user gets is a real one (images, mode/model pickers all hang off a session).
    assert.deepStrictEqual(manager.created, ['Claude Code']);
  });

  test('a connect with a session to focus does not create another one', async () => {
    const { harness, manager } = connectHarness(['other-session']);
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => phases(harness).includes('connected'), 'connected');
    assert.deepStrictEqual(manager.created, [], 'reuse, do not pile up');
  });

  test('a panel whose process is already up still hears "connected"', async () => {
    // The regression this message exists for: on this path nothing else speaks — no
    // `agent-connected` event, no signature change to trip `refreshSessions` — so a
    // silent host would leave the client on "Connecting…" forever.
    const { harness, manager } = connectHarness([]);
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => phases(harness).includes('connected'), 'connected');
    assert.deepStrictEqual(manager.ensured, ['Claude Code']);
    assert.deepStrictEqual(phases(harness), ['connecting', 'connected']);
  });

  test('the focus lands before "connected"', async () => {
    // Load-bearing order: the client opens a draft on 'connected' only when no session is
    // focused. Sending the phase first would hand the user a spare tab next to the session
    // the connect just found.
    const { harness } = connectHarness(['other-session']);
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => connectedAt(harness) >= 0, 'connected');
    const focusAt = harness.surface.sent.findIndex(m => m.type === 'focus');
    assert.ok(focusAt >= 0, 'the session the connect found must be focused');
    assert.ok(focusAt < connectedAt(harness),
      `focus@${focusAt} must precede connected@${connectedAt(harness)}`);
  });

  test('a failed connect reports the phase and the error', async () => {
    const { harness, manager } = connectHarness();
    manager.failWith = 'agent would not start';
    harness.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => phases(harness).includes('failed'), 'failed');
    assert.deepStrictEqual(phases(harness), ['connecting', 'failed']);
    const failure = harness.surface.sent
      .find(m => m.type === 'connection' && (m as { state?: string }).state === 'failed');
    assert.match(String((failure as { message?: string }).message), /agent would not start/);
    assert.ok(harness.surface.sent.some(m => m.type === 'error'), 'and the usual error line');
  });

  test('the switch writes through the seam and is echoed back', async () => {
    const prefs = new StubPrefs(false);
    const { harness } = connectHarness([], prefs);
    harness.host.onMessage({ type: 'setAutoConnect', value: true });
    await waitFor(() => prefs.writes.length > 0, 'the write');
    assert.deepStrictEqual(prefs.writes, [true]);
    await waitFor(() => harness.surface.sent.some(m => m.type === 'autoConnectPref'), 'the echo');
    const echo = harness.surface.sent.filter(m => m.type === 'autoConnectPref');
    assert.strictEqual((echo[echo.length - 1] as { value?: boolean }).value, true);
  });

  test('a write that fails echoes the value the setting actually holds', async () => {
    const prefs = new StubPrefs(false);
    prefs.failWith = new Error('read-only');
    const { harness } = connectHarness([], prefs);
    harness.host.onMessage({ type: 'setAutoConnect', value: true });
    await waitFor(() => harness.surface.sent.some(m => m.type === 'autoConnectPref'), 'the echo');
    const echo = harness.surface.sent.filter(m => m.type === 'autoConnectPref');
    // Not `true`: the write threw, so the setting still says false. Echoing the request
    // back would leave the checkbox showing a value settings.json does not have.
    assert.strictEqual((echo[echo.length - 1] as { value?: boolean }).value, false);
  });

  test('boot carries the setting', () => {
    const { harness } = connectHarness([], new StubPrefs(true));
    harness.host.onMessage({ type: 'ready' });
    const boot = harness.surface.sent.filter(m => m.type === 'boot').pop();
    assert.strictEqual((boot as { autoConnect?: boolean }).autoConnect, true);
  });

  test('only the boolean true turns auto-connect on', () => {
    for (const raw of [undefined, null, 'true', 'yes', 0, 1, {}, []]) {
      assert.strictEqual(resolveAutoConnect(raw), false, JSON.stringify(raw));
    }
    assert.strictEqual(resolveAutoConnect(true), true);
  });
});

// [CUSTOM- 标签圆点的「等待回答」：宿主从两个桥读（它们才是 pending 的唯一
// 持有者），并且**必须计入 refreshSessions 的签名**——漏签名的后果在 022/063 上踩过两次：
// 数据变了，标签栏却永远不刷新。
suite('chat panel: the tab dot and the waiting state', () => {
  interface SummaryWire { sessionId: string; waiting: boolean; unread?: boolean }

  function summaries(harness: Harness): SummaryWire[] {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as { type?: string; sessions?: SummaryWire[] };
      if (message.type === 'sessionsChanged') { return message.sessions ?? []; }
    }
    return [];
  }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  test('a session parked on a permission prompt is marked waiting, and cleared when answered', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    harness.surface.sent.length = 0;

    void permission.request(
      { sessionId: 's-1', toolCall: { toolCallId: 't1', title: 'Run the tests' } } as never,
      // Only the dialog path uses the fallback; the harness has a presenter, so the
      // prompt lands in the panel and this never runs.
      (async () => ({ outcome: { outcome: 'cancelled' } })) as never,
    );

    await waitFor(() => summaries(harness).some(row => row.waiting), 'a waiting summary');
    assert.strictEqual(summaries(harness).find(row => row.sessionId === 's-1')?.waiting, true,
      'nothing advances until the reader answers — the strip has to be able to say so');

    // Settling it has to reach the strip too, or the dot would stay orange forever.
    permission.cancelSession('s-1');
    await waitFor(() => summaries(harness).some(row => row.waiting === false), 'the flag cleared');
    assert.strictEqual(summaries(harness).find(row => row.sessionId === 's-1')?.waiting, false);
  });

  // [CUSTOM- 与上一条同构，但走**表单**那条桥。用户报的正是这个形态：
  // 「已经处于"弹出选项框等待用户选择"的会话，会话 tab 的圆点看不出在等（蓝色）」——
  // 而 130 当初只钉过权限那一半：权限桥与表单桥是**两条独立的桥**，宿主那句 `waiting` 是
  // 二者的或。表单这条一旦不生效，圆点就会退回 running/attention（都是蓝色）⇒ 正是用户看到的。
  test('a session parked on a form is marked waiting, and cleared once answered', async () => {
    const elicitation = new ElicitationBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { elicitation });
    harness.surface.sent.length = 0;

    void elicitation.request(
      { sessionId: 's-1', message: 'Which one?', requestedSchema: { type: 'object', properties: {} } } as never,
      (async () => ({ action: 'cancel' })) as never,
    );

    await waitFor(() => summaries(harness).some(row => row.waiting), 'a waiting summary (form)');
    assert.strictEqual(summaries(harness).find(row => row.sessionId === 's-1')?.waiting, true,
      'a form parked on a session stops the turn just as hard as a permission prompt');

    elicitation.cancelSession('s-1');
    await waitFor(() => summaries(harness).some(row => row.waiting === false), 'the form flag cleared');
    assert.strictEqual(summaries(harness).find(row => row.sessionId === 's-1')?.waiting, false);
  });

  // [CUSTOM- 2026-10-29] 会话 tab 右键 "Mark as unread"：与后台输出同一条 attention 状态；
  // 聚焦到该会话时由宿主清掉（与 active-session-changed 的既有规则一致）。
  test('markUnread lights the unread flag and focusing the session clears it', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'markUnread', sessionId: 's-1' });
    await waitFor(() => summaries(harness).some(s => s.sessionId === 's-1' && s.unread === true),
      'the unread flag');

    harness.sessionManager.emit('active-session-changed', 's-1', 'Claude Code');
    await waitFor(() => summaries(harness).some(s => s.sessionId === 's-1' && s.unread === false),
      'the unread flag cleared on focus');
  });
});

// [CUSTOM- Tab 手工顺序落在**同一条** globalState 记录上（与大纲偏好同一条）。
// 两个写者各发自己那几个字段，所以宿主的处理必须是**合并**：重建会把对方那一半抹掉 —— 症状是
// "拖了一下 tab，大纲宽度被重置了"，而那要等到用户下次拖大纲栏才会发现（先记进测试）。
suite('chat panel: ui prefs merge ()', () => {
  function prefMessages(harness: Harness): Array<Record<string, unknown>> {
    return harness.surface.sent.filter(m => m.type === 'uiPrefs') as Array<Record<string, unknown>>;
  }

  function prefsOf(harness: Harness): Record<string, unknown> {
    const sent = prefMessages(harness);
    assert.ok(sent.length > 0, 'the host answers every write (pitfall #29)');
    return sent[sent.length - 1];
  }

  // `uiPrefs` is a coalescable (non-structural) message: it goes out on the outbox's
  // next flush, not synchronously. Wait for it instead of asserting through the queue.
  async function waitForPrefs(harness: Harness): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (prefMessages(harness).length > 0) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('timed out waiting for the uiPrefs reply');
  }

  async function waitFor(check: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.ok(check(), label);
  }

  function lastPrefsOn(surface: RecordingSurface): Record<string, unknown> {
    const sent = surface.sent.filter(m => m.type === 'uiPrefs') as Array<Record<string, unknown>>;
    assert.ok(sent.length > 0, 'every attached surface receives the preference projection');
    return sent[sent.length - 1];
  }

  async function settingsItems(harness: Harness): Promise<Array<Record<string, unknown>>> {
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'getSettings' });
    await waitFor(
      () => harness.surface.sent.some(m => m.type === 'settings'),
      'timed out waiting for the settings table',
    );
    const message = harness.surface.sent.find(m => m.type === 'settings') as
      { items: Array<Record<string, unknown>> } | undefined;
    return message?.items ?? [];
  }

  test('a tab-order write keeps the outline prefs, and vice versa', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'setUiPref', outlineMode: 'sidebar', outlineWidth: 320 });
    harness.host.onMessage({ type: 'setUiPref', tabOrder: ['b', 'a'] });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness), {
      type: 'uiPrefs', outlineMode: 'sidebar', outlineWidth: 320, tabOrder: ['b', 'a'],
      shortcuts: defaultShortcutMap(),
    }, 'the second write must not wipe what the first one set');

    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', outlineMode: 'popup', outlineWidth: 200 });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness).tabOrder, ['b', 'a'], 'and it survives the reverse order');
  });

  // [CUSTOM- 回归（2026-10-28）：设置面板写的是 `patchUiPrefs`，地址栏开关写的是
  // `setUiPref`。后者一旦按"这一轮认识的字段"重建记录，就会把设置面板刚写下的
  // markdownStyle / flatTools / sendKey / recentDirectoryLimit 静默抹掉
  // （用户现象：改完 Markdown style 再点「自动拖尾」，样式退回默认）。
  test('an address-bar write keeps the newer settings-panel keys', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'setSetting', key: 'panel.markdownStyle', value: 'github' });
    harness.host.onMessage({ type: 'setSetting', key: 'panel.recentDirectoryLimit', value: 12 });
    harness.host.onMessage({ type: 'setUiPref', tailBySession: { s1: false }, tailDefault: false });
    await waitForPrefs(harness);

    assert.strictEqual(prefsOf(harness).markdownStyle, 'github', 'Markdown style survives a Tail toggle');
    assert.strictEqual(prefsOf(harness).recentDirectoryLimit, 12, 'and so does the recent-directory limit');
    assert.deepStrictEqual(prefsOf(harness).tailBySession, { s1: false });
  });

  test('outlineTab is persisted and survives unrelated writes', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'setUiPref', outlineTab: 'cards' });
    await waitForPrefs(harness);
    assert.strictEqual(prefsOf(harness).outlineTab, 'cards');

    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', outlineTab: 'bogus' });
    harness.host.onMessage({ type: 'setUiPref', tailDefault: false });
    await waitForPrefs(harness);
    assert.strictEqual(prefsOf(harness).outlineTab, 'messages', 'an unknown value falls back to messages');
    assert.strictEqual(prefsOf(harness).tailDefault, false, 'the other writer still lands');
  });

  test('the webview HTML carries the lazy mermaid URI without widening script-src', () => {
    const harness = makeHarness('s-1');
    const surface = new RecordingSurface();
    (surface.webview as unknown as { asWebviewUri: (uri: vscode.Uri) => string }).asWebviewUri =
      (uri: vscode.Uri) => 'vscode-webview://test' + uri.path;
    harness.host.attachSurface(surface, { agentName: harness.agentName, sessionId: 's-1' });

    assert.ok(surface.html.includes('data-mermaid-src="vscode-webview://test'),
      'the lazy asset URI reaches the document');
    assert.ok(surface.html.includes("script-src 'nonce-"), 'still nonce-only');
    assert.ok(!/script-src[^;]*vscode-webview/.test(surface.html),
      'the extension resource host is NOT added to script-src');
  });

  test('reloadSurfaces writes a fresh document without touching host state', () => {
    const harness = makeHarness('s-1');
    const before = harness.surface.html;
    harness.surface.sent.length = 0;

    const reloaded = harness.host.reloadSurfaces();

    assert.deepStrictEqual(reloaded, ['view']);
    assert.notStrictEqual(harness.surface.html, before, 'a new nonce means a new document');
    assert.ok(harness.surface.html.includes("script-src 'nonce-"), 'the CSP is re-emitted');
    assert.strictEqual(harness.surface.sent.length, 0, 'reloading neither resets nor re-pushes host state');
  });

  test('reloadSurfaces only reloads visible surfaces (hidden ones stay untouched)', () => {
    const harness = makeHarness('s-1');
    const editor = new RecordingSurface('editor');
    editor.visibleFlag = false;
    harness.host.attachSurface(editor, { agentName: harness.agentName, sessionId: 's-1' });
    const viewBefore = harness.surface.html;
    const editorBefore = editor.html;

    const reloaded = harness.host.reloadSurfaces();

    assert.deepStrictEqual(reloaded, ['view']);
    assert.notStrictEqual(harness.surface.html, viewBefore);
    assert.strictEqual(editor.html, editorBefore, 'the hidden editor document is left alone');
  });

  test('boot always pushes a complete shortcut map even without stored preferences', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'ready' });
    await waitFor(
      () => harness.surface.sent.some(m => m.type === 'uiPrefs'),
      'timed out waiting for the boot preference projection',
    );
    assert.deepStrictEqual(lastPrefsOn(harness.surface).shortcuts, defaultShortcutMap());
  });

  test('a valid shortcut binding persists and fans out to view, editor and side', async () => {
    const memento = new FakeMemento();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    const editor = new RecordingSurface('editor');
    const side = new RecordingSurface('side');
    harness.host.attachSurface(editor, { agentName: harness.agentName, sessionId: 's-1' });
    harness.host.attachSurface(side, { agentName: harness.agentName, sessionId: 's-1' });
    for (const surface of [harness.surface, editor, side]) { surface.sent.length = 0; }

    harness.host.onMessage(
      { type: 'setSetting', key: 'panel.shortcut.scrollTop', value: 'Shift+Ctrl+KeyB' },
      'view',
    );
    await waitFor(
      () => [harness.surface, editor, side].every(
        surface => surface.sent.some(m => m.type === 'uiPrefs'),
      ),
      'the global shortcut change must reach all three surfaces',
    );
    for (const surface of [harness.surface, editor, side]) {
      const shortcuts = lastPrefsOn(surface).shortcuts as Record<string, string | null>;
      assert.strictEqual(shortcuts.scrollTop, 'Ctrl+Shift+KeyB');
    }
    const stored = memento.get<Record<string, unknown>>('vac.outlinePrefs.v1');
    assert.strictEqual(
      (stored?.shortcuts as Record<string, string | null> | undefined)?.scrollTop,
      'Ctrl+Shift+KeyB',
    );

    const items = await settingsItems(harness);
    const item = items.find(entry => entry.key === 'panel.shortcut.scrollTop');
    assert.ok(item);
    assert.strictEqual(item.type, 'shortcut');
    assert.strictEqual(item.group, 'shortcuts');
    assert.strictEqual(item.value, 'Ctrl+Shift+KeyB');
  });

  test('invalid and duplicate shortcut values are rejected with a visible warning', async () => {
    const memento = new FakeMemento();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);

    async function write(value: unknown): Promise<Record<string, unknown>> {
      harness.host.onMessage({ type: 'setSetting', key: 'panel.shortcut.scrollTop', value });
      const items = await settingsItems(harness);
      const item = items.find(entry => entry.key === 'panel.shortcut.scrollTop');
      assert.ok(item);
      return item;
    }

    const invalid = await write('KeyA');
    assert.strictEqual(invalid.value, DEFAULT_SHORTCUTS.scrollTop, 'the old binding is kept');
    assert.match(String(invalid.warning), /modifier/);
    assert.strictEqual(memento.get('vac.outlinePrefs.v1'), undefined, 'nothing invalid was persisted');

    const duplicate = await write('Alt+KeyE');
    assert.strictEqual(duplicate.value, DEFAULT_SHORTCUTS.scrollTop, 'the old binding is kept');
    assert.match(String(duplicate.warning), /already used by "Scroll to bottom"/);
    assert.strictEqual(memento.get('vac.outlinePrefs.v1'), undefined, 'nothing duplicate was persisted');

    const accepted = await write('Ctrl+KeyB');
    assert.strictEqual(accepted.value, 'Ctrl+KeyB');
    assert.strictEqual(accepted.warning, undefined, 'a later valid write clears the warning');
  });

  test('null disables a shortcut and "default" restores it', async () => {
    const memento = new FakeMemento();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);

    harness.host.onMessage({ type: 'setSetting', key: 'panel.shortcut.scrollBottom', value: null });
    let items = await settingsItems(harness);
    let item = items.find(entry => entry.key === 'panel.shortcut.scrollBottom');
    assert.strictEqual(item?.value, null);
    assert.strictEqual(
      (memento.get<Record<string, unknown>>('vac.outlinePrefs.v1')
        ?.shortcuts as Record<string, string | null> | undefined)?.scrollBottom,
      null,
    );

    harness.host.onMessage({
      type: 'setSetting', key: 'panel.shortcut.scrollBottom', value: 'default',
    });
    items = await settingsItems(harness);
    item = items.find(entry => entry.key === 'panel.shortcut.scrollBottom');
    assert.strictEqual(item?.value, DEFAULT_SHORTCUTS.scrollBottom);
  });

  test('reload normalizes legacy shortcut data while keeping the other preferences', async () => {
    const memento = new FakeMemento();
    await memento.update('vac.outlinePrefs.v1', {
      outlineMode: 'sidebar', outlineWidth: 320, markdownStyle: 'github',
      shortcuts: {
        scrollTop: 'shift+alt+KeyA',
        scrollBottom: 'Alt+Shift+KeyA',
        focusInput: 'not a shortcut',
        previousSession: null,
        nextSession: 'Alt+KeyN',
        obsolete: 'Alt+KeyQ',
      },
    });
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    const editor = new RecordingSurface('editor');
    const side = new RecordingSurface('side');
    harness.host.attachSurface(editor, { agentName: harness.agentName, sessionId: 's-1' });
    harness.host.attachSurface(side, { agentName: harness.agentName, sessionId: 's-1' });

    const normalized = {
      scrollTop: 'Alt+Shift+KeyA',
      scrollBottom: DEFAULT_SHORTCUTS.scrollBottom,
      focusInput: DEFAULT_SHORTCUTS.focusInput,
      previousSession: null,
      nextSession: DEFAULT_SHORTCUTS.nextSession,
      closeSession: DEFAULT_SHORTCUTS.closeSession,
      restoreClosed: DEFAULT_SHORTCUTS.restoreClosed,
    };
    for (const surface of [harness.surface, editor, side]) {
      surface.sent.length = 0;
      harness.host.onMessage({ type: 'ready' }, surface.key);
      await waitFor(
        () => surface.sent.some(m => m.type === 'uiPrefs'),
        'timed out waiting for the normalized preference projection',
      );
      const prefs = lastPrefsOn(surface);
      assert.deepStrictEqual(prefs.shortcuts, normalized);
      assert.strictEqual(
        prefs.outlineWidth,
        surface.key === 'side' ? 240 : 320,
        'scoped preferences keep their own value while globals are shared',
      );
      assert.strictEqual(prefs.markdownStyle, 'github');
    }
    assert.strictEqual(
      (memento.get<Record<string, unknown>>('vac.outlinePrefs.v1'))?.markdownStyle,
      'github',
      'normalization in the projection does not drop the stored record',
    );
  });

  test('setUiPref cannot overwrite shortcuts; only the settings writer can', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;
    harness.host.onMessage({
      type: 'setUiPref', outlineMode: 'sidebar', outlineWidth: 321,
      shortcuts: { scrollTop: null, scrollBottom: 'Alt+KeyZ' },
    });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness).shortcuts, defaultShortcutMap());
  });

  test('stored ui prefs arrive before boot restores the scroll position', async () => {
    const globalState = new FakeMemento();
    await globalState.update('vac.outlinePrefs.v1', {
      outlineMode: 'sidebar', outlineWidth: 320,
      tailBySession: { A: false, B: true }, tailDefault: false,
    });
    const harness = makeHarness('s-1', 'Claude Code', undefined, undefined, {}, globalState);
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'ready' });
    const messages = harness.surface.sent.filter(m => m.type === 'uiPrefs' || m.type === 'boot');
    assert.deepStrictEqual(messages.map(m => m.type), ['uiPrefs', 'boot']);
    const prefs = messages[0];
    assert.ok(prefs.type === 'uiPrefs');
    assert.deepStrictEqual(prefs.tailBySession, { A: false, B: true });
    assert.strictEqual(prefs.tailDefault, false);
  });

  test('junk in the order never reaches globalState', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'setUiPref', tabOrder: ['a', 'a', 7, '', 'b'] });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness).tabOrder, ['a', 'b'], 'strings only, no duplicates');

    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', tabOrder: 'not a list' });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness).tabOrder, [], 'a non-list is not a list');
  });

  // [CUSTOM- 2026-10-30：范围 0–30。0 必须原样保留（隐藏分组），清空输入框则回落默认 8。
  test('the recent-directory limit is clamped to 0–30, and an empty box means the default', async () => {
    const memento = new FakeMemento();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);

    function write(value: unknown): unknown {
      harness.host.onMessage({ type: 'setSetting', key: 'panel.recentDirectoryLimit', value });
      return memento.get<Record<string, unknown>>('vac.outlinePrefs.v1')?.recentDirectoryLimit;
    }

    assert.strictEqual(await write(0), 0, '0 is a real value (hide the group), not "unset"');
    assert.strictEqual(await write('0'), 0, 'the number input posts strings');
    assert.strictEqual(await write(30), 30, 'the old 16 ceiling is gone');
    assert.strictEqual(await write(31), 30, 'above the range clamps');
    assert.strictEqual(await write(-1), 0, 'below the range clamps');
    assert.strictEqual(await write(''), 8, 'clearing the box falls back to the default, not 0');
    assert.strictEqual(await write('   '), 8, 'whitespace counts as cleared');
    assert.strictEqual(await write('abc'), 8, 'non-numeric falls back');
  });

  test('a setUiPref merge keeps 0 and later writes do not reset it', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', recentDirectoryLimit: 0 });
    await waitForPrefs(harness);
    assert.strictEqual(prefsOf(harness).recentDirectoryLimit, 0, '0 survives the merge path');

    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', outlineWidth: 300 });
    await waitForPrefs(harness);
    assert.strictEqual(prefsOf(harness).recentDirectoryLimit, 0,
      'a later write without the field must not reset it');

    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', recentDirectoryLimit: 99 });
    await waitForPrefs(harness);
    assert.strictEqual(prefsOf(harness).recentDirectoryLimit, 30);
  });

  // [CUSTOM- 2026-11-05：历史显示上限 0 = 不限（默认）；0–10000 整数，空/非法为 0。
  test('the history display limit defaults to unlimited and is clamped to 0–10000', async () => {
    const memento = new FakeMemento();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);

    const items = await settingsItems(harness);
    const item = items.find(entry => entry.key === 'panel.historyDisplayLimit');
    assert.ok(item, 'the setting is exposed');
    assert.strictEqual(item?.type, 'number');
    assert.strictEqual(item?.value, 0, 'unset means unlimited');
    assert.strictEqual(item?.min, 0);
    assert.strictEqual(item?.max, 10_000);
    assert.strictEqual(item?.step, 1, 'the wide range still steps by one');

    function write(value: unknown): unknown {
      harness.host.onMessage({ type: 'setSetting', key: 'panel.historyDisplayLimit', value });
      return memento.get<Record<string, unknown>>('vac.outlinePrefs.v1')?.historyDisplayLimit;
    }

    assert.strictEqual(await write(0), 0, '0 is a real value (unlimited)');
    assert.strictEqual(await write('0'), 0, 'the number input posts strings');
    assert.strictEqual(await write(250), 250);
    assert.strictEqual(await write('250'), 250);
    assert.strictEqual(await write(12.7), 13, 'integer rounding');
    assert.strictEqual(await write(10_001), 10_000, 'above the range clamps');
    assert.strictEqual(await write(-1), 0, 'below the range clamps');
    assert.strictEqual(await write(''), 0, 'clearing the box means unlimited');
    assert.strictEqual(await write('   '), 0, 'whitespace counts as cleared');
    assert.strictEqual(await write('abc'), 0, 'non-numeric falls back to unlimited');
    assert.strictEqual(await write(null), 0);
    assert.strictEqual(await write(true), 0, 'a non-number is not a limit');
  });

  test('the history display limit is shared by every surface and survives unrelated writes', async () => {
    const harness = makeHarness('s-1');
    const side = new RecordingSurface('side');
    harness.host.attachSurface(side, { agentName: harness.agentName, sessionId: 'side-1' });
    const sentPrefs = (surface: RecordingSurface) =>
      surface.sent.filter(m => m.type === 'uiPrefs') as Array<Record<string, unknown>>;

    harness.host.onMessage({ type: 'setSetting', key: 'panel.historyDisplayLimit', value: 40 }, 'view');
    await waitFor(() => sentPrefs(harness.surface).some(m => m.historyDisplayLimit === 40),
      'the main surface receives the limit');
    await waitFor(() => sentPrefs(side).some(m => m.historyDisplayLimit === 40),
      'the side surface receives the same global limit');

    harness.surface.sent.length = 0;
    side.sent.length = 0;
    harness.host.onMessage({ type: 'setSetting', key: 'panel.markdownStyle', value: 'github' }, 'view');
    await waitFor(() => sentPrefs(harness.surface).length > 0, 'a global write still answers');
    await waitFor(() => sentPrefs(side).length > 0, 'a global write reaches the side too');
    assert.strictEqual(sentPrefs(harness.surface).at(-1)?.historyDisplayLimit, 40,
      'the global merge keeps the limit');
    assert.strictEqual(sentPrefs(side).at(-1)?.historyDisplayLimit, 40);
  });
});

// [CUSTOM- 2026-10-30：「New Session in This Folder」的新 tab 要落在源 tab 右侧。
suite('chat panel: 新会话 tab 插到源 tab 右侧', () => {
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  test('insertSessionAfter materializes the live order first', () => {
    assert.deepStrictEqual(insertSessionAfter(['a', 'b', 'c'], ['a', 'b', 'c'], 'b', 'n'),
      ['a', 'b', 'n', 'c'], 'source already ordered');
    assert.deepStrictEqual(insertSessionAfter([], ['a', 'b', 'c'], 'b', 'n'),
      ['a', 'b', 'n', 'c'], 'never dragged: source is not in tabOrder yet');
    assert.deepStrictEqual(insertSessionAfter(['x'], ['a', 'b', 'c'], 'b', 'n'),
      ['x', 'a', 'b', 'n', 'c'], 'stale ids stay put; live ids fill in host order');
  });

  test('insertSessionAfter keeps restoring ids and never duplicates', () => {
    assert.deepStrictEqual(insertSessionAfter(['restoring', 'a'], ['a', 'b'], 'a', 'restoring'),
      ['a', 'restoring', 'b'], 'an id already present is moved, not copied');
    assert.deepStrictEqual(insertSessionAfter(['a'], ['a'], 'missing', 'n'),
      ['a', 'n'], 'unknown source falls back to the end');
  });

  test('newSessionInDirectory writes the new id right after the source', async () => {
    class BesideManager extends SessionManager {
      override async createSession(
        agentName: string,
        opts: { cwd?: string } = {},
      ): Promise<SessionInfo> {
        const sessionId = 's-new';
        registerFakeSession(this, sessionId, agentName, { cwd: opts.cwd ?? '/tmp' });
        return {
          sessionId,
          agentId: 'fake-agent-id',
          agentName,
          agentDisplayName: agentName,
          cwd: opts.cwd ?? '/tmp',
          createdAt: new Date().toISOString(),
          initResponse: {},
          modes: null,
          models: null,
          configOptions: null,
          availableCommands: [],
        } as unknown as SessionInfo;
      }
    }
    let manager!: BesideManager;
    const memento = new FakeMemento();
    const harness = makeHarness('s-1', 'Claude Code', handler => {
      manager = new BesideManager(new AgentManager(), new ConnectionManager(handler), handler);
      registerFakeSession(manager, 's-2', 'Claude Code');
      return manager;
    }, new StubPrefs(), {}, memento);

    const prefMessages = () =>
      harness.surface.sent.filter(m => m.type === 'uiPrefs') as Array<Record<string, unknown>>;
    const latestPrefs = () => prefMessages()[prefMessages().length - 1];

    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', tabOrder: ['s-2', 's-1'] });
    await waitFor(() => prefMessages().length > 0, 'the tab order to be stored');

    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'newSessionInDirectory', sessionId: 's-1' });
    await waitFor(
      () => !!(latestPrefs()?.tabOrder as string[] | undefined)?.includes('s-new'),
      'the inserted tab order',
    );

    assert.deepStrictEqual(latestPrefs().tabOrder, ['s-2', 's-1', 's-new']);
    const stored = memento.get<{ tabOrder?: string[] }>('vac.outlinePrefs.v1');
    assert.deepStrictEqual(stored?.tabOrder, ['s-2', 's-1', 's-new'], 'and it is persisted');
  });
});

// [CUSTOM- Times 的两份状态（按会话记的那张表 + 一个默认值）落在**同一条**
// globalState 记录上 —— 它成了这条记录的第三个写者。形态与 tabOrder 一致：webview 整份发上来，
// 宿主按"缺的字段 = 这一轮没改它"合并、消毒后落盘并广播。
suite('chat panel: Times prefs ()', () => {
  function prefMessages(harness: Harness): Array<Record<string, unknown>> {
    return harness.surface.sent.filter(m => m.type === 'uiPrefs') as Array<Record<string, unknown>>;
  }

  function prefsOf(harness: Harness): Record<string, unknown> {
    const sent = prefMessages(harness);
    assert.ok(sent.length > 0, 'the host answers every write (pitfall #29)');
    return sent[sent.length - 1];
  }

  async function waitForPrefs(harness: Harness): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (prefMessages(harness).length > 0) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('timed out waiting for the uiPrefs reply');
  }

  test('the three writers share one record without wiping each other', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'setUiPref', outlineMode: 'sidebar', outlineWidth: 320, tabOrder: ['b', 'a'] });
    harness.host.onMessage({ type: 'setUiPref', timesBySession: { s1: true, s2: false }, timesDefault: true });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness), {
      type: 'uiPrefs', outlineMode: 'sidebar', outlineWidth: 320, tabOrder: ['b', 'a'],
      timesBySession: { s1: true, s2: false }, timesDefault: true,
      shortcuts: defaultShortcutMap(),
    });

    // 反过来：只写默认值的那一笔不该把那张表抹掉（缺字段 = 这一轮没改它）。
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', timesDefault: false });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness).timesBySession, { s1: true, s2: false }, 'the table survives');
    assert.strictEqual(prefsOf(harness).timesDefault, false, 'and the default moved');
    assert.strictEqual(prefsOf(harness).outlineMode, 'sidebar', 'and neither writer touched the outline');
  });

  test('junk never reaches globalState', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'setUiPref', timesBySession: { ok: true, bad: 'yes', s1: false } });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness).timesBySession, { ok: true, s1: false }, 'booleans only');

    // 字段**在但内容不是表**：与 `sanitizeTabOrder` 对"不是数组"的处理同形 —— 什么都不留下。
    // （"这一轮没改它"是另一件事，靠"字段缺不缺"判断，见上面那条用例。）
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', timesBySession: 'not a map' });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness).timesBySession, {}, 'a non-map leaves nothing behind');
  });

  // [CUSTOM- 大纲侧栏的"按会话开/关"与 Times **同一形状**（`sanitizeSessionFlags`
  // 一份消毒器管两张表），也走同一条记录 —— 第四个写者。
  test('the outline sidebar open/closed rides the same record (204)', async () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;

    harness.host.onMessage({
      type: 'setUiPref',
      outlineMode: 'sidebar',
      outlineOpenBySession: { A: true, B: false },
      outlineOpenDefault: false,
    });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness).outlineOpenBySession, { A: true, B: false });
    assert.strictEqual(prefsOf(harness).outlineOpenDefault, false);

    // 只写 Times 的那一笔不该把侧栏那一半抹掉（缺字段 = 这一轮没改它）。
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setUiPref', timesDefault: true });
    await waitForPrefs(harness);
    assert.deepStrictEqual(prefsOf(harness).outlineOpenBySession, { A: true, B: false }, '侧栏那一半留着');
    assert.strictEqual(prefsOf(harness).timesDefault, true, '而 Times 那一半生效了');
    assert.strictEqual(prefsOf(harness).outlineMode, 'sidebar', 'mode 也没被碰');
  });

  test('the per-session table is capped', async () => {    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;
    const big: Record<string, boolean> = {};
    for (let i = 0; i < 300; i++) { big[`s-${i}`] = true; }

    harness.host.onMessage({ type: 'setUiPref', timesBySession: big });
    await waitForPrefs(harness);
    const kept = prefsOf(harness).timesBySession as Record<string, boolean>;
    assert.strictEqual(Object.keys(kept).length, 200, 'a broken client cannot grow this without bound');
  });

  // [CUSTOM- 没有聚焦会话时地址栏显示的就是它 —— 所以它必须一直在 boot 上，
  // 而且永远不为空（空字符串会把"已连接、还没有会话"那几十秒又变成一格空白）。
  test('boot carries a non-empty default working directory (199)', async () => {
    const harness = makeHarness('s-1');
    const boot = harness.surface.sent.find(m => m.type === 'boot') as Record<string, unknown>;
    assert.strictEqual(typeof boot.defaultCwd, 'string');
    assert.ok((boot.defaultCwd as string).length > 0, 'the empty address bar falls back to wording, not to nothing');
  });
});

// [CUSTOM- 后台会话的权限 / 表单请求：从"窗口顶部的 QuickPick"改成"面板拥有 +
// 右下角通知"。用户截图里的那一幕（他在会话 A 里打字，会话 B 的权限请求弹到了窗口顶部）
// 正是旧判据的产物：canPresent 要求请求会话**必须聚焦**。这一档把"谁拥有请求"与"谁正在看它"
// 拆开——拥有 = 现代面板 + 有面（记录照建、跳过去就能答）；在不在屏幕上只决定要不要发通知。
suite('chat panel: background prompts notify instead of interrupting ()', () => {
  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  /** Fire a permission request; returns the dialog-path spy (empty = the panel owns it). */
  function requestPermission(bridge: PermissionBridge, sessionId: string, title = 'Run the tests'): string[] {
    const calls: string[] = [];
    void bridge.request(
      { sessionId, toolCall: { toolCallId: `t-${sessionId}`, title } } as never,
      (async () => { calls.push('dialog'); return { outcome: { outcome: 'cancelled' } }; }) as never,
    );
    return calls;
  }

  /** A background session (registered, not focused — the harness focuses its own). */
  function addBackgroundSession(harness: Harness, sessionId: string, agentName = 'Claude Code'): void {
    registerFakeSession(harness.sessionManager, sessionId, agentName);
  }

  /** The permission record the host appended for one session, if any. */
  function permissionRecord(harness: Harness, sessionId: string): { permission?: { promptId?: string; status?: string } } | null {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as {
        type?: string; sessionId?: string;
        entries?: Array<{ kind?: string; permission?: { promptId?: string; status?: string } }>;
      };
      if (message.type !== 'append' || message.sessionId !== sessionId) { continue; }
      const entry = message.entries?.find(e => e.kind === 'permission');
      if (entry) { return entry; }
    }
    return null;
  }

  /** The last permission status the webview was told about for one session. */
  function permissionStatus(harness: Harness, sessionId: string): string | undefined {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as {
        type?: string; sessionId?: string; patch?: { permission?: { status?: string } };
      };
      if (message.sessionId !== sessionId) { continue; }
      if (message.type === 'revise' && message.patch?.permission) { return message.patch.permission.status; }
      if (message.type === 'append') { return permissionRecord(harness, sessionId)?.permission?.status; }
    }
    return undefined;
  }

  /** Let the async half of a prompt (a resolve on a microtask/macrotask) run out. */
  async function settleTurns(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  test('a background request is owned by the panel: record + notification, no dialog', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    addBackgroundSession(harness, 's-2');
    harness.surface.sent.length = 0;

    const dialogCalls = requestPermission(permission, 's-2', 'cd /repo && npm test');

    assert.deepStrictEqual(dialogCalls, [], 'the window-level QuickPick must not open for a session the panel owns');
    // `append` rides the outbox (coalesced), so the record lands a frame later.
    await waitFor(() => !!permissionRecord(harness, 's-2'), 'the record');
    assert.ok(permissionRecord(harness, 's-2'), 'the record is built now — jumping over finds the prompt waiting');
    assert.strictEqual(harness.notices.shown.length, 1, 'exactly one notification');
    assert.strictEqual(harness.notices.shown[0].level, 'warning', 'waiting is a warning: it stays on screen');
    assert.ok(harness.notices.shown[0].message.includes('等待权限确认'), harness.notices.shown[0].message);
    assert.ok(harness.notices.shown[0].message.includes('npm test'), 'and it says what is being asked for');
  });

  test('the focused session on a visible surface is NOT notified — the card is right there', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });

    const dialogCalls = requestPermission(permission, 's-1');
    assert.deepStrictEqual(dialogCalls, []);
    await waitFor(() => !!permissionRecord(harness, 's-1'), 'the record');
    assert.deepStrictEqual(harness.notices.shown, [], 'a notification for a card the user is looking at is noise');
  });

  test('hiding the panel notifies even for the focused session', () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    harness.surface.visibleFlag = false;

    requestPermission(permission, 's-1');
    assert.strictEqual(harness.notices.shown.length, 1, 'the panel is behind an editor — the user cannot see the card');
  });

  test('clicking the notification focuses that session, and the request can then be answered', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    addBackgroundSession(harness, 's-2');
    requestPermission(permission, 's-2');

    await harness.notices.click(0);
    await waitFor(() => harness.sessionManager.getActiveSessionId() === 's-2', 'focus moved to the notified session');
    assert.ok(harness.surface.reveals >= 1, 'and the panel came to the front (an explicit user action may take focus)');

    // The answer path a card/drawer click uses. It must be accepted: the prompt was
    // owned by the panel all along, so nothing has to be "re-activated" first.
    const promptId = permissionRecord(harness, 's-2')?.permission?.promptId;
    assert.ok(promptId, 'the record carries the prompt id the answer needs');
    harness.host.onMessage({ type: 'permissionAnswer', sessionId: 's-2', promptId, optionId: 'allow-once' });
    await waitFor(() => permissionStatus(harness, 's-2') === 'selected', 'the prompt settled');
    assert.strictEqual(harness.notices.shown.length, 1, 'and no second notification appeared');
  });

  test('with no surface at all the dialog stays the exit that cannot hang the agent', () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    harness.host.detachSurface('view');

    const dialogCalls = requestPermission(permission, 's-1');
    assert.deepStrictEqual(dialogCalls, ['dialog'], 'nothing can be drawn, so the request must reach the dialog (pitfall #14)');
  });

  test('losing the last surface still demotes a parked request (the #14 guard)', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    const dialogCalls = requestPermission(permission, 's-1');
    assert.deepStrictEqual(dialogCalls, [], 'owned by the panel while a surface exists');

    harness.host.detachSurface('view');
    await waitFor(() => dialogCalls.length === 1, 'the parked request was demoted');
    assert.deepStrictEqual(dialogCalls, ['dialog'], 'onPresenterLost keeps its meaning: no surface ⇒ dialog');
  });

  // [CUSTOM-20261029] Sub-agent traffic is routed under the child's own session id,
  // which is not a registered session. Without the child→parent resolver the panel
  // said canPresent=false and the prompt fell through to the window-level QuickPick
  // (the user's screenshot: a raw session id in the placeholder).
  test('a sub-agent permission prompt is drawn in its parent session, not the QuickPick', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'subagent_update', sessionId: 'child-1', title: 'Child',
        state: { state: 'running' }, capabilities: { cancel: true },
      },
    } as never);

    const dialogCalls = requestPermission(permission, 'child-1', 'cd /repo && npm test');
    assert.deepStrictEqual(dialogCalls, [], 'the child id resolves to the parent — no window dialog');
    await waitFor(() => !!permissionRecord(harness, 's-1'), 'the record anchored to the parent');
    assert.strictEqual(permission.hasPendingFor('s-1'), true, 'the parent tab shows waiting');
    assert.strictEqual(permission.hasPendingFor('child-1'), true, 'the child id still matches cancelSubagent');

    // Stopping the parent turn must retire the child's prompt too — the ACP contract
    // is "exactly one answer", and cancelTurn only knows the parent id.
    permission.cancelSession('s-1');
    await waitFor(() => permissionStatus(harness, 's-1') === 'cancelled', 'the prompt settled');
  });

  test('a sub-agent form is drawn in its parent session too', async () => {
    const elicitation = new ElicitationBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { elicitation });
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'subagent_update', sessionId: 'child-2', title: 'Child',
        state: { state: 'running' }, capabilities: { cancel: true },
      },
    } as never);

    const dialogCalls: string[] = [];
    void elicitation.request(askRequest('child-2'), async () => {
      dialogCalls.push('dialog');
      return { action: 'cancel' };
    });
    assert.deepStrictEqual(dialogCalls, [], 'the form resolves to the parent — no per-field QuickPick');
    assert.strictEqual(elicitation.hasPendingFor('s-1'), true, 'the parent tab shows waiting');
    elicitation.cancelSession('s-1');
  });


  test('a background form notifies with its question', () => {
    const elicitation = new ElicitationBridge();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), { elicitation });
    addBackgroundSession(harness, 's-2');

    void elicitation.request(askRequest('s-2'), async () => { throw new Error('the dialog must not open'); });

    assert.strictEqual(harness.notices.shown.length, 1, 'waiting-form is part of the set');
    assert.ok(harness.notices.shown[0].message.includes('等待你的回答'), harness.notices.shown[0].message);
    assert.ok(harness.notices.shown[0].message.includes('Which framework?'), 'the question itself rides along');
  });

  test('a finished background turn notifies once; a cancelled one stays silent', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    addBackgroundSession(harness, 's-2');

    // Resolve turns without an agent process (same trick as registerFakeSession, one
    // level up: `sendPrompt` is the only thing that needs a connection here).
    let stopReason = 'end_turn';
    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({ stopReason }),
    });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-2', text: 'go' });
    await waitFor(() => harness.notices.shown.length === 1, 'the turn-done notification');
    assert.strictEqual(harness.notices.shown[0].level, 'info', 'a finished turn is information, not an alarm');
    assert.ok(harness.notices.shown[0].message.includes('已完成这一轮'), harness.notices.shown[0].message);

    // …and then a turn the user cancelled: they pressed Stop, they know.
    stopReason = 'cancelled';
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-2', text: 'go' });
    await settleTurns();
    assert.strictEqual(harness.notices.shown.length, 1, 'cancelling is not news');
  });

  test('a failed turn reuses the record\'s wording', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    addBackgroundSession(harness, 's-2');
    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({ stopReason: 'refusal' }),
    });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-2', text: 'go' });
    await waitFor(() => harness.notices.shown.length === 1, 'the failure notification');
    // The toast carries the SAME wording the record does, clipped to fit (the detail
    // is one line by design — see composeNotice). Comparing the head of the string is
    // what keeps the two from drifting apart (pitfall #19).
    const expected = stopReasonText('refusal')!;
    assert.ok(harness.notices.shown[0].message.includes(expected.slice(0, 60)),
      `the notification and the transcript notice must not tell two stories, got: ${harness.notices.shown[0].message}`);
  });

  test('the focused, visible session gets no turn-done notification', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({ stopReason: 'end_turn' }),
    });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: 'go' });
    await settleTurns();
    assert.deepStrictEqual(harness.notices.shown, [], 'the user is watching this one finish');
  });

  /** An AskUserQuestion-shaped form request (same shape as elicitation-bridge.test.ts). */
  function askRequest(sessionId: string): CreateElicitationRequest {
    return {
      mode: 'form',
      sessionId,
      toolCallId: 'call_1',
      message: 'Which framework?',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: {
            type: 'string',
            title: 'Base',
            oneOf: [{ const: 'Astro official', title: 'Astro official' }],
          },
        },
      },
    } as unknown as CreateElicitationRequest;
  }
});

// [CUSTOM-20261029] 面板内改名：客户端把 title 一并带来，宿主不再弹 InputBox。
// InputBox 在真实宿主测试里会直接把用例挂住 —— 所以"能跑完"本身就是断言的一部分。
suite('chat panel: rename from the panel popover', () => {
  test('a client-provided title is applied without the host InputBox', async () => {
    const memento = new FakeMemento();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {},
      memento as unknown as vscode.Memento);
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'renameSession', sessionId: 's-1', title: 'renamed' });
    await new Promise(resolve => setTimeout(resolve, 20));

    const action = harness.surface.sent.find(
      m => (m as { type?: string }).type === 'sessionAction') as
      { action?: string; sessionId?: string; title?: string } | undefined;
    assert.ok(action, 'the host replied with sessionAction');
    assert.strictEqual(action.action, 'rename');
    assert.strictEqual(action.sessionId, 's-1');
    assert.strictEqual(action.title, 'renamed');
    assert.strictEqual(
      memento.get<Record<string, { title?: string }>>('vac.sessionLabels.v1')?.['s-1']?.title,
      'renamed',
      'the label override is persisted',
    );
  });
});

// [CUSTOM-20261029] 标题栏 Stop / 命令面板不再直接取消：有可见面板时请求它出
// #stopConfirm；没有 surface 时返回 false，让 commands 走非模态通知兜底。
suite('chat panel: stop requests go through the panel confirmation', () => {
  class BusyManager extends SessionManager {
    private readonly busy = new Set<string>();
    markBusy(sessionId: string): void { this.busy.add(sessionId); }
    override isTurnInFlight(sessionId: string): boolean { return this.busy.has(sessionId); }
  }

  function busyHarness(): { harness: Harness; manager: BusyManager } {
    let manager!: BusyManager;
    const harness = makeHarness('s-1', 'Claude Code', handler => {
      manager = new BusyManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    manager.markBusy('s-1');
    harness.surface.sent.length = 0;
    return { harness, manager };
  }

  test('a visible surface showing the session receives stopAsk', () => {
    const { harness } = busyHarness();
    assert.strictEqual(harness.host.requestStop('s-1'), true);
    assert.deepStrictEqual(
      harness.surface.sent.filter(m => (m as { type?: string }).type === 'stopAsk'),
      [{ type: 'stopAsk', sessionId: 's-1' }],
    );
  });

  test('no visible surface ⇒ false (the command falls back to a notice)', () => {
    const { harness } = busyHarness();
    harness.host.detachSurface('view');
    assert.strictEqual(harness.host.requestStop('s-1'), false);
  });

  test('nothing in flight ⇒ true and no message (there is nothing to ask)', () => {
    const harness = makeHarness('s-1');
    harness.surface.sent.length = 0;
    assert.strictEqual(harness.host.requestStop('s-1'), true);
    assert.deepStrictEqual(
      harness.surface.sent.filter(m => (m as { type?: string }).type === 'stopAsk'), []);
  });
});

suite('chat panel: turn outcome wording ()', () => {
  test('a normal turn, a cancelled turn and a failed one are three different things', () => {
    assert.deepStrictEqual(turnOutcome('end_turn'), {}, 'a normal end says nothing extra');
    assert.strictEqual(turnOutcome('cancelled').silent, true, 'the user pressed Stop — no toast');
    assert.strictEqual(turnOutcome('refusal').failed, true);
    assert.strictEqual(turnOutcome('max_tokens').failed, true);
    assert.strictEqual(turnOutcome(undefined).silent, undefined, 'a missing reason is not "cancelled"');
  });

  test('only non-normal reasons have wording (shared by the record and the toast)', () => {
    assert.strictEqual(stopReasonText('end_turn'), null);
    assert.strictEqual(stopReasonText('cancelled'), null);
    assert.strictEqual(stopReasonText(undefined), null);
    assert.ok(stopReasonText('max_turn_requests')!.includes('agent-request limit'));
    assert.ok(stopReasonText('something-new')!.includes('something-new'), 'unknown reasons are still reported verbatim');
  });
});

// [CUSTOM- 自定义模型别名（`vac.customModels`）的归一化：只钉住纯函数，
// 不碰 vscode 配置读取（`readCustomModels` 读真实设置，测试不该去改它）。
suite('chat panel: custom model aliases ()', () => {
  test('non-array or empty input normalises to nothing', () => {
    assert.deepStrictEqual(normalizeCustomModels(undefined), []);
    assert.deepStrictEqual(normalizeCustomModels(null), []);
    assert.deepStrictEqual(normalizeCustomModels('nope'), []);
    assert.deepStrictEqual(normalizeCustomModels([]), []);
  });

  test('entries without a modelId are dropped, the rest keep their id', () => {
    assert.deepStrictEqual(normalizeCustomModels([
      { modelId: 'a' }, { name: 'no id' }, { modelId: '  ' }, {},
    ]), [{ modelId: 'a', name: 'a', description: undefined }]);
  });

  test('a missing or blank name falls back to the modelId', () => {
    assert.strictEqual(normalizeCustomModels([{ modelId: 'deepseek-v4-pro[1M]' }])[0].name, 'deepseek-v4-pro[1M]');
    assert.strictEqual(normalizeCustomModels([{ modelId: 'x', name: '   ' }])[0].name, 'x');
  });

  test('name and description are kept verbatim when present', () => {
    const [m] = normalizeCustomModels([{ modelId: 'x', name: '我的模型', description: 'hover' }]);
    assert.strictEqual(m.name, '我的模型');
    assert.strictEqual(m.description, 'hover');
    assert.strictEqual(normalizeCustomModels([{ modelId: 'x', description: 42 }])[0].description, undefined);
  });

  test('saving them writes the resolved layer and pushes the new list to the panel', async () => {
    const settingsIO = new StubSettingIO();
    const harness = makeHarness(
      's-custom', 'Claude Code', undefined, new StubPrefs(), {}, undefined, undefined, settingsIO,
    );
    harness.surface.sent.length = 0;
    const value = [{ modelId: 'm1', name: 'M', description: 'first' }];
    harness.host.onMessage({ type: 'setSetting', key: 'vac.customModels', value });
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    assert.deepStrictEqual(settingsIO.writes, [
      { key: 'vac.customModels', value, target: 'global' },
    ], 'no user/workspace override, so the cross-IDE layer is the write target');
    const pushed = harness.surface.sent.filter(message => message.type === 'customModels') as Array<{
      customModels: unknown;
    }>;
    assert.strictEqual(pushed.length, 1, 'the composer gets the new aliases/descriptions immediately');
    assert.deepStrictEqual(pushed[0].customModels, value);
  });
});

// [CUSTOM- 自定义模型列表的 compare-and-set 写入：保存 / 冲突 / 层变化 / 失败 /
// 二次确认并发 / 与 Inspect 层操作串行。用真实 ChatPanelHost + StubSettingIO 跑。
suite('chat panel: custom model list CAS ()', () => {
  class NonPersistingSettingIO extends StubSettingIO {
    async write(key: string, value: unknown, target: SettingWriteTarget): Promise<void> {
      this.writes.push({ key, value, target });
    }
  }

  class GatedSettingIO extends StubSettingIO {
    private releaseGate!: () => void;
    private readonly gate: Promise<void>;
    constructor() {
      super();
      this.gate = new Promise<void>(resolve => { this.releaseGate = resolve; });
    }
    release(): void { this.releaseGate(); }
    async write(key: string, value: unknown, target: SettingWriteTarget): Promise<void> {
      await this.gate;
      return super.write(key, value, target);
    }
  }

  // [CUSTOM- 模拟真实 SettingScope 在"workspace 目标 + 无文件夹"时的拒绝：
  // 测试通过注入 seam 复现，不依赖真实测试宿主有没有打开文件夹。
  class WorkspaceNoFolderSettingIO extends StubSettingIO {
    constructor(private readonly workspaceValue: unknown) { super(undefined); }
    resolve(_key: string, _defaultScope: 'global' | 'ide'): SettingSource {
      return {
        effective: 'workspace',
        writeTarget: 'workspace',
        layers: [
          { layer: 'workspace', value: this.workspaceValue },
          { layer: 'user' },
          { layer: 'global' },
          { layer: 'default', value: [] },
        ],
      };
    }
    async write(key: string, value: unknown, target: SettingWriteTarget): Promise<void> {
      this.writes.push({ key, value, target });
      throw new Error('Workspace settings need an open folder.');
    }
  }

  function delay(ms = 0): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function settingsTable(harness: Harness): Promise<Array<Record<string, any>>> {
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'getSettings' });
    for (let i = 0; i < 100; i++) {
      const message = harness.surface.sent.find(m => m.type === 'settings') as
        { items: Array<Record<string, any>> } | undefined;
      if (message) { return message.items; }
      await delay(5);
    }
    throw new Error('timed out waiting for settings');
  }

  async function modelItemFor(harness: Harness, requestId: string): Promise<Record<string, any>> {
    for (let i = 0; i < 100; i++) {
      const items = await settingsTable(harness);
      const item = items.find(entry => entry.key === 'vac.customModels');
      if (item?.modelSync?.requestId === requestId) { return item; }
      await delay(5);
    }
    throw new Error(`timed out waiting for model sync ${requestId}`);
  }

  function harnessWith(io: StubSettingIO): Harness {
    return makeHarness(
      's-model-cas', 'Claude Code', undefined, new StubPrefs(), {}, undefined, undefined, io,
    );
  }

  test('a valid baseline writes the resolved layer and reports saved', async () => {
    const io = new StubSettingIO();
    const harness = harnessWith(io);
    const value = [{ modelId: 'z', name: 'Z' }, { modelId: 'a', name: 'A' }];
    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'save-1',
      baseline: modelListBaseline('default', 'global', undefined),
      value,
    });
    for (let i = 0; i < 100 && !harness.surface.sent.some(m => m.type === 'customModels'); i++) {
      await delay(5);
    }
    assert.ok(
      harness.surface.sent.some(m => m.type === 'customModels'),
      'the composer gets the new order immediately',
    );
    const item = await modelItemFor(harness, 'save-1');

    assert.deepStrictEqual(io.writes, [
      { key: 'vac.customModels', value: normalizeCustomModels(value), target: 'global' },
    ]);
    assert.strictEqual(item.modelSync.status, 'saved');
    assert.deepStrictEqual(item.modelSync.models, normalizeCustomModels(value));
    assert.strictEqual(
      item.modelSync.baseline,
      modelListBaseline('global', 'global', normalizeCustomModels(value)),
    );
  });

  test('a value change and a same-value layer change both reject the stale baseline', async () => {
    const value = [{ modelId: 'a', name: 'A' }];
    const io = new StubSettingIO(value);
    const harness = harnessWith(io);

    // 同值但打开编辑器时还在 default 层（现在已被 workspace/global 覆盖）。
    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'stale-layer',
      baseline: modelListBaseline('default', 'global', value),
      value,
    });
    const layerConflict = await modelItemFor(harness, 'stale-layer');
    assert.strictEqual(layerConflict.modelSync.status, 'conflict');
    assert.deepStrictEqual(layerConflict.modelSync.models, normalizeCustomModels(value));
    assert.strictEqual(layerConflict.modelSync.baseline, modelListBaseline('global', 'global', value));
    assert.deepStrictEqual(io.writes, [], 'a stale layer never writes');

    // 打开编辑器后，另一个面改了值：值没变旧基线，但生效层已经变了。
    const external = [{ modelId: 'external', name: 'External' }];
    await io.write('vac.customModels', external, 'global');
    const writesBefore = io.writes.length;
    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'stale-value',
      baseline: modelListBaseline('global', 'global', value),
      value: [{ modelId: 'changed', name: 'Changed' }],
    });
    const valueConflict = await modelItemFor(harness, 'stale-value');
    assert.strictEqual(valueConflict.modelSync.status, 'conflict');
    assert.deepStrictEqual(valueConflict.modelSync.models, normalizeCustomModels(external));
    assert.strictEqual(io.writes.length, writesBefore, 'a stale value never writes');
  });

  test('a write failure is reported and keeps the current value', async () => {
    const io = new StubSettingIO();
    io.failWrites = true;
    const harness = harnessWith(io);
    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'fail-1',
      baseline: modelListBaseline('default', 'global', undefined),
      value: [{ modelId: 'a', name: 'A' }],
    });
    const item = await modelItemFor(harness, 'fail-1');
    assert.strictEqual(item.modelSync.status, 'error');
    assert.match(String(item.modelSync.message), /settings write failed/);
    assert.deepStrictEqual(item.value, [], 'the failed write is not reported as saved');
  });

  test('a workspace-target write without a folder is rejected, not reported as saved', async () => {
    const value = [{ modelId: 'a', name: 'A' }];
    const io = new WorkspaceNoFolderSettingIO(value);
    const harness = harnessWith(io);
    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'workspace-1',
      baseline: modelListBaseline('workspace', 'workspace', value),
      value,
    });
    const item = await modelItemFor(harness, 'workspace-1');
    assert.strictEqual(item.modelSync.status, 'error');
    assert.match(String(item.modelSync.message), /open folder/);
    assert.deepStrictEqual(io.writes, [{
      key: 'vac.customModels', value: normalizeCustomModels(value), target: 'workspace',
    }]);
    assert.deepStrictEqual(item.value, normalizeCustomModels(value), 'the effective value is still the old one');
  });

  test('a write that did not take effect becomes a conflict with the real value', async () => {
    const io = new NonPersistingSettingIO();
    const harness = harnessWith(io);
    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'drop-1',
      baseline: modelListBaseline('default', 'global', undefined),
      value: [{ modelId: 'a', name: 'A' }],
    });
    const item = await modelItemFor(harness, 'drop-1');
    assert.strictEqual(item.modelSync.status, 'conflict');
    assert.deepStrictEqual(item.modelSync.models, []);
    assert.strictEqual(item.modelSync.baseline, modelListBaseline('default', 'global', undefined));
    assert.strictEqual(io.writes.length, 1, 'it did attempt the write, but never claimed success');
  });

  test('Overwrite re-checks the conflict baseline; a newer write causes conflict again', async () => {
    const initial = [{ modelId: 'a', name: 'A' }];
    const io = new StubSettingIO(initial);
    const harness = harnessWith(io);

    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'confirm-1',
      baseline: modelListBaseline('default', 'global', initial),
      value: [{ modelId: 'local', name: 'Local' }],
    });
    const first = await modelItemFor(harness, 'confirm-1');
    assert.strictEqual(first.modelSync.status, 'conflict');

    // 用户确认 Overwrite 之后、请求执行之前，另一个面写入。
    const external = [{ modelId: 'external', name: 'External' }];
    await io.write('vac.customModels', external, 'global');
    const writesBefore = io.writes.length;

    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'confirm-2',
      baseline: first.modelSync.baseline,
      value: [{ modelId: 'local', name: 'Local' }],
      force: true,
    });
    const second = await modelItemFor(harness, 'confirm-2');
    assert.strictEqual(second.modelSync.status, 'conflict');
    assert.deepStrictEqual(second.modelSync.models, normalizeCustomModels(external));
    assert.strictEqual(io.writes.length, writesBefore, 'force did not bypass the newer CAS');

    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'confirm-3',
      baseline: second.modelSync.baseline,
      value: [{ modelId: 'local', name: 'Local' }],
      force: true,
    });
    const third = await modelItemFor(harness, 'confirm-3');
    assert.strictEqual(third.modelSync.status, 'saved');
  });

  test('removeSettingLayer waits behind an in-flight model write', async () => {
    const io = new GatedSettingIO();
    const harness = harnessWith(io);
    harness.host.onMessage({
      type: 'setModelList',
      requestId: 'queued-1',
      baseline: modelListBaseline('default', 'global', undefined),
      value: [{ modelId: 'a', name: 'A' }],
    });
    await delay(0);

    harness.host.onMessage({
      type: 'settingAction', action: 'removeSettingLayer', key: 'vac.customModels', layer: 'global',
    });
    await delay(0);
    assert.deepStrictEqual(io.cleared, [], 'the layer operation must not interleave with the CAS write');

    io.release();
    await modelItemFor(harness, 'queued-1');
    for (let i = 0; i < 100 && io.cleared.length === 0; i++) { await delay(5); }
    assert.deepStrictEqual(io.cleared, [{ key: 'vac.customModels', layer: 'global' }]);
    assert.strictEqual(io.writes.length, 1);
    assert.strictEqual(io.writes[0].target, 'global');
  });
});

// [CUSTOM- 把 agent 报的错翻译成人话：优先 `data.details`，否则回落 message。
suite('chat panel: errorDetail surfaces the real reason ()', () => {
  test('an ACP RequestError hides its reason in data.details', () => {
    const err = Object.assign(new Error('Internal error'), {
      code: -32603,
      data: { details: 'Invalid value for config option model: grok-4.6' },
    });
    assert.strictEqual(errorDetail(err), 'Invalid value for config option model: grok-4.6');
  });

  test('without details it falls back to message, then to String()', () => {
    assert.strictEqual(errorDetail(new Error('boom')), 'boom');
    assert.strictEqual(errorDetail({ data: { details: 42 }, message: 'm' }), 'm', 'a non-string details is ignored');
    assert.strictEqual(errorDetail({ data: { details: '  ' }, message: 'm' }), 'm', 'a blank details is ignored');
    assert.strictEqual(errorDetail('plain'), 'plain');
  });
});

// [CUSTOM- 记住用户选过的模式：新建会话套用、打开历史**不**套、草稿页显示它。
// 这条链最容易错的不是"记没记住"，而是**什么时候不该动** —— 把 load/resume 也当成"新会话"，
// 会改掉用户重新打开的那个会话自己的模式（那个模式是"重新打开它"的一部分）。
suite('chat panel: the remembered mode ()', () => {
  async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 20)); }

  const MODE_OPTIONS = [
    {
      id: 'mode', name: 'Mode', description: 'Session permission mode', category: 'mode',
      type: 'select', currentValue: 'default',
      options: [
        { value: 'default', name: 'Manual' },
        { value: 'plan', name: 'Plan' },
        { value: 'bypassPermissions', name: 'Bypass' },
      ],
    },
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }],
    },
  ];

  function modeHarness(remembered?: { configId: string; value: string }): { harness: Harness; memento: FakeMemento } {
    const memento = new FakeMemento();
    if (remembered) { void memento.update('vac.lastMode.v1', { 'Claude Code': remembered }); }
    return { harness: makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento), memento };
  }

  /** Record the config-option writes the host makes, and reflect them on the session. */
  function spyWrites(harness: Harness, sessionId: string): Array<{ configId: string; value: string }> {
    const calls: Array<{ configId: string; value: string }> = [];
    Object.assign(harness.sessionManager, {
      setConfigOption: async (_sid: string, configId: string, value: string) => {
        calls.push({ configId, value });
        const session = harness.sessionManager.getSession(sessionId) as unknown as { configOptions?: unknown[] } | undefined;
        if (session) {
          session.configOptions = MODE_OPTIONS.map(o => (o.id === configId ? { ...o, currentValue: value } : o));
        }
      },
    });
    return calls;
  }

  /** Notice entries the host appended for one session (the switch announcement lands here). */
  function noticesOf(harness: Harness, sessionId: string): string[] {
    const out: string[] = [];
    for (const message of harness.surface.sent as Array<{
      type?: string; sessionId?: string; entries?: Array<{ kind?: string; text?: string }>;
    }>) {
      if (message.type !== 'append' || message.sessionId !== sessionId) { continue; }
      for (const entry of message.entries ?? []) {
        if (entry.kind === 'notice') { out.push(String(entry.text ?? '')); }
      }
    }
    return out;
  }

  test('a NEW session starts on the mode the user last chose', async () => {
    const { harness } = modeHarness({ configId: 'mode', value: 'bypassPermissions' });
    registerFakeSession(harness.sessionManager, 's-new', 'Claude Code', { configOptions: MODE_OPTIONS });
    const calls = spyWrites(harness, 's-new');

    harness.sessionManager.emit('session-created', 's-new', 'Claude Code', 'new');
    await settle();

    assert.deepStrictEqual(calls, [{ configId: 'mode', value: 'bypassPermissions' }],
      'the new session is put on the mode the user last chose — the whole point of remembering it');
    await settle();
    assert.deepStrictEqual(noticesOf(harness, 's-new'), [],
      'and it is NOT announced as a switch the user never made (the baseline is seeded, 073/151)');
  });

  test('reopening a session from history does NOT touch its mode', async () => {
    const { harness } = modeHarness({ configId: 'mode', value: 'bypassPermissions' });
    registerFakeSession(harness.sessionManager, 's-old', 'Claude Code', { configOptions: MODE_OPTIONS });
    const calls = spyWrites(harness, 's-old');

    // load and resume take the same event; an older caller may pass no origin at all.
    harness.sessionManager.emit('session-created', 's-old', 'Claude Code', 'load');
    harness.sessionManager.emit('session-created', 's-old', 'Claude Code', 'resume');
    harness.sessionManager.emit('session-created', 's-old');
    await settle();

    assert.deepStrictEqual(calls, [], 'a session reopened from history keeps the mode it was left in');
  });

  test('a remembered value the new session no longer offers is skipped, quietly', async () => {
    const { harness } = modeHarness({ configId: 'mode', value: 'ghost-mode' });
    registerFakeSession(harness.sessionManager, 's-new', 'Claude Code', { configOptions: MODE_OPTIONS });
    const calls = spyWrites(harness, 's-new');

    harness.sessionManager.emit('session-created', 's-new', 'Claude Code', 'new');
    await settle();

    assert.deepStrictEqual(calls, [], 'a stale default must not become a request the agent would reject');
    assert.deepStrictEqual(harness.notices.shown, [], 'and nobody is notified about a default that did not apply');
  });

  test('the mode the user picks is remembered (and persisted for the next window)', async () => {
    const { harness, memento } = modeHarness();
    registerFakeSession(harness.sessionManager, 's-2', 'Claude Code', { configOptions: MODE_OPTIONS });
    spyWrites(harness, 's-2');

    harness.host.onMessage({ type: 'setConfigOption', sessionId: 's-2', configId: 'mode', value: 'plan' });
    await settle();

    assert.deepStrictEqual(memento.get('vac.lastMode.v1'), { 'Claude Code': { configId: 'mode', value: 'plan' } },
      'the value comes from the config option (the authoritative copy), and it survives a reload');
  });

  test('changing something that is NOT the mode remembers nothing', async () => {
    const { harness, memento } = modeHarness();
    registerFakeSession(harness.sessionManager, 's-3', 'Claude Code', { configOptions: MODE_OPTIONS });
    spyWrites(harness, 's-3');

    harness.host.onMessage({ type: 'setConfigOption', sessionId: 's-3', configId: 'model', value: 'opus' });
    await settle();

    assert.strictEqual(memento.get('vac.lastMode.v1'), undefined,
      'one message carries every option — only the mode one is a remembered preference');
  });

  test('the draft page shows the remembered mode as the current value (160)', async () => {
    const { harness } = modeHarness({ configId: 'mode', value: 'bypassPermissions' });
    // The draft snapshot is the agent's last-seen options; the remembered mode overlays it.
    registerFakeSession(harness.sessionManager, 'seeded', 'Claude Code', { configOptions: MODE_OPTIONS });
    harness.sessionManager.emit('config-options-changed', 'seeded');
    harness.sessionManager.emit('available-commands-changed', 'seeded');
    harness.surface.sent.length = 0;

    harness.host.onMessage({ type: 'listDraftOptions', draftId: 'd1' });
    const reply = harness.surface.sent.find(m => m.type === 'draftOptions') as unknown as {
      configOptions: Array<{ id: string; currentValue: string }>;
    };
    assert.ok(reply, 'the draft page always gets an answer (pitfall #29)');
    assert.strictEqual(reply.configOptions.find(o => o.id === 'mode')?.currentValue, 'bypassPermissions',
      'what the picker shows is what the new session will get');
    assert.strictEqual(reply.configOptions.find(o => o.id === 'model')?.currentValue, 'sonnet',
      'other options stay the agent\'s own last-seen values');
  });
});

// [CUSTOM- 轮次之外的 agent 工作（后台子任务）。用户报的现象：任务还在跑（在等
// 子 agent），发送按钮却已经变回普通状态。判据原本只看"轮次请求还没返回"，而后台子任务会在
// 轮次结束后继续干活。这里钉住这台状态机的四条边：进入要有证据、产出会续期、汇报即结束、
// 静默超时要**说出来**（静默复原正是用户看到的那种"没人告诉我发生了什么"）。
suite('chat panel: background work keeps the session running ()', () => {
  async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 15)); }

  async function waitFor(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (predicate()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  /** The host's picture of one session, as the client receives it. */
  function runningOf(harness: Harness, sessionId: string): boolean | undefined {
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i] as {
        type?: string; sessions?: Array<{ sessionId: string; running: boolean }>;
      };
      if (message.type !== 'sessionsChanged') { continue; }
      const row = (message.sessions ?? []).find(s => s.sessionId === sessionId);
      if (row) { return row.running; }
    }
    return undefined;
  }

  function note(harness: Harness, update: Record<string, unknown>, sessionId = harness.sessionId): void {
    harness.handler.handleUpdate({ sessionId, update } as never);
  }

  /** A Task tool call that asks the agent to run it in the background — the only
   * evidence we get that work will outlive the turn. */
  const launch = {
    sessionUpdate: 'tool_call', toolCallId: 't-task', title: 'Task', kind: 'other',
    rawInput: { description: 'diff a third file', prompt: '…', run_in_background: true },
  };

  test('a launched background task keeps the session running', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 60_000);
    // NOTE: nothing to assert before the launch — until something changes, the host has
    // not pushed a `sessionsChanged` at all (the harness only attaches a surface).

    note(harness, launch);
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true,
      'the agent said it launched background work — the composer must not offer Send');
  });

  test('housekeeping notifications never arm it', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 20);
    note(harness, { sessionUpdate: 'session_info_update', title: 'x' });
    note(harness, { sessionUpdate: 'available_commands_update', availableCommands: [] });
    note(harness, { sessionUpdate: 'usage_update', used: 1, size: 2 });
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), false,
      'a title/command/usage notification is not work — a Stop button there would be a lie');
  });

  test('output keeps the wait alive; silence ends it', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 60);
    note(harness, launch);
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true);

    note(harness, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still going…' } });
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true, 'a chunk re-arms the watchdog');

    await waitFor(() => runningOf(harness, 's-1') === false, 'the wait to time out');
  });

  test('the quiet timeout says so instead of silently coming back', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 30);
    // The user is looking elsewhere: the notice is the only way they learn the wait ended.
    harness.surface.visibleFlag = false;
    note(harness, launch);

    await waitFor(() => runningOf(harness, 's-1') === false, 'the wait to time out');
    assert.strictEqual(harness.notices.shown.length, 1, 'exactly one notice');
    assert.ok(harness.notices.shown[0].message.includes('后台任务'), harness.notices.shown[0].message);
    assert.ok(harness.notices.shown[0].message.includes('超时'), harness.notices.shown[0].message);
  });

  test('the task reporting back ends the wait without a notice', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 60_000);
    note(harness, launch);
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true);

    note(harness, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: '<task-notification>\nBackground task finished.\n</task-notification>' },
    });
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), false, 'the work we were waiting for reported back');
    assert.deepStrictEqual(harness.notices.shown, [], 'and the expected end is not news');
  });

  test('a new turn clears the background wait (no lingering Stop)', async () => {
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, undefined, 60_000);
    note(harness, launch);
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), true);

    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({ stopReason: 'end_turn' }),
    });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: 'go' });
    await settle();
    assert.strictEqual(runningOf(harness, 's-1'), false,
      'the turn is over and the background wait was already cleared — nothing keeps it "running"');
  });
});

// [CUSTOM- Markdown links to local files.
//
// The bug: `[GOAL.md:74](GOAL.md:74)` rendered as a struck-through grey span
// (title="Blocked link scheme") — it LOOKED clickable and did nothing, because
// `link()` only allowlisted http/https/mailto and dumped every other href into
// the "blocked scheme" branch. Fixing that is invisible to every existing check
// (a wrong href shape still renders *something*), so the routing is pinned here.
suite('chat panel: markdown links to local files', () => {
  const md = new SafeMarkdown();
  const render = (link: string) => md.render(link);

  test('a relative path with a line number becomes an openFile link', () => {
    const html = render('[GOAL.md:74](GOAL.md:74)');
    assert.ok(html.includes('data-path="GOAL.md"'), `expected a file link, got ${html}`);
    assert.ok(html.includes('data-line="74"'), `expected the line to travel, got ${html}`);
    assert.ok(!html.includes('link-blocked'), 'it must not be inert any more');
    assert.ok(html.includes('>GOAL.md:74</a>'), `label must be preserved, got ${html}`);
  });

  test('a GitHub-style fragment carries the line too', () => {
    const html = render('[a.ts](./src/a.ts#L12)');
    assert.ok(html.includes('data-path="./src/a.ts"'), `got ${html}`);
    assert.ok(html.includes('data-line="12"'), `got ${html}`);
    assert.ok(html.includes('data-end-line="12"'), `single line still selects that line: ${html}`);
  });

  test('a fragment range selects the whole range', () => {
    const html = render('[a.ts](src/a.ts#L12-L30)');
    assert.ok(html.includes('data-line="12"'), `got ${html}`);
    assert.ok(html.includes('data-end-line="30"'), `got ${html}`);
  });

  test('an absolute path survives the line split', () => {
    // Forward slashes: CommonMark reads `\r` in a link destination as an escape,
    // so a backslash path never reaches us as a link at all (measured, not
    // assumed) — and fileUri() accepts `C:/…` just as well as `C:\…`.
    const html = render('[a.ts](C:/repo/src/a.ts:12)');
    assert.ok(html.includes('data-path="C:/repo/src/a.ts"'), `got ${html}`);
    assert.ok(html.includes('data-line="12"'), `got ${html}`);
  });

  test('a file: URI opens the local file instead of warning about the scheme', () => {
    const url = pathToFileURL(path.resolve(__dirname, 'fixtures')).toString();
    const html = render(`[f](${url})`);
    assert.ok(html.includes('data-path="'), `got ${html}`);
    assert.ok(!html.includes('link-blocked'), `got ${html}`);
  });

  test('a path without a line still opens, with no line attributes', () => {
    const html = render('[notes.md](docs/notes.md)');
    assert.ok(html.includes('data-path="docs/notes.md"'), `got ${html}`);
    assert.ok(!html.includes('data-line='), `got ${html}`);
    assert.ok(!html.includes('data-end-line='), `got ${html}`);
  });

  test('quotes in a path are escaped, not able to break out of the attribute', () => {
    // Angle-bracket destination: the only form CommonMark lets carry a `"`.
    const html = render('[x](<a"b.ts>)');
    assert.ok(html.includes('data-path="a&quot;b.ts"'), `got ${html}`);
  });

  test('http links keep taking the external channel', () => {
    const html = render('[site](https://example.com/x#L12)');
    assert.ok(html.includes('data-href="https://example.com/x#L12"'), `got ${html}`);
  });

  test('unknown schemes stay inert', () => {
    for (const link of ['[x](javascript:alert(1))', '[x](command:workbench.action.closeAllEditors)', '[x](data:text/html,<b>x</b>)']) {
      const html = render(link);
      assert.ok(html.includes('link-blocked'), `${link} must stay blocked, got ${html}`);
      assert.ok(!html.includes('data-path'), `${link} must not become a file link, got ${html}`);
    }
  });

  test('a fragment on its own is not a file target', () => {
    // Opening "line 74 of nothing" (i.e. some unrelated file at line 74) would be
    // a worse outcome than leaving the link inert.
    const html = render('[see](#L74)');
    assert.ok(html.includes('link-blocked'), `got ${html}`);
    const section = render('[see](#section)');
    assert.ok(section.includes('link-blocked'),
      `an anchor we cannot resolve must not silently open a file: ${section}`);
  });
});

// [CUSTOM- 2026-10-30：文件引用的行区间解析与 resource_link 视图共用一份。
suite('chat panel: file link ranges', () => {
  test('fileLinkTarget returns the whole inclusive range', () => {
    assert.deepStrictEqual(fileLinkTarget('./src/a.ts#L12-L30'),
      { path: './src/a.ts', line: 12, endLine: 30 });
    assert.deepStrictEqual(fileLinkTarget('GOAL.md:74'),
      { path: 'GOAL.md', line: 74, endLine: 74 }, 'single line selects that line');
    assert.deepStrictEqual(fileLinkTarget('a.ts#L12'),
      { path: 'a.ts', line: 12, endLine: 12 });
    assert.strictEqual(fileLinkTarget('https://example.com/x#L12'), undefined);
    assert.strictEqual(fileLinkTarget('a.ts#section'), undefined,
      'an unusable fragment is not a file target');
  });

  test('resource_link views carry the range, and #section links stay openable', () => {
    const file = path.resolve(__dirname, 'fixtures', 'a.ts');
    const url = pathToFileURL(file).toString();

    const ranged = toContentView({ type: 'resource_link', uri: `${url}#L12-L30`, name: 'a.ts' } as any);
    assert.ok(ranged && ranged.type === 'resource_link');
    assert.strictEqual(ranged.path, file);
    assert.strictEqual(ranged.line, 12);
    assert.strictEqual(ranged.endLine, 30);

    const section = toContentView({ type: 'resource_link', uri: `${url}#section`, name: 'a.ts' } as any);
    assert.ok(section && section.type === 'resource_link');
    assert.ok(section.path, 'an unrecognized fragment still opens the file');
    assert.strictEqual(section.line, undefined);
    assert.strictEqual(section.endLine, undefined);

    const remote = toContentView({ type: 'resource_link', uri: 'https://example.com/a.ts#L1', name: 'a.ts' } as any);
    assert.ok(remote && remote.type === 'resource_link');
    assert.strictEqual(remote.path, undefined);
    assert.strictEqual(remote.line, undefined);
  });
});

// [CUSTOM- 上下文圆环只认 usage_update。
//
// 起因（用户报"上下文进度会出现超过上限的情况"，截图 tooltip：`100% · 1841k / 1000k tokens`）：
// 宿主曾在每次轮次结束时把 `PromptResponse.usage.totalTokens` 折进圆环的 `used`。而 ACP 协议里
// 那个字段是 *Sum of all token types **across session*** —— claude-agent-acp 的实现是每轮
// `accumulatedUsage.inputTokens += …`（cache read 每轮重算），是个只增不减的累计量；`size` 却是
// **窗口大小**。两者不是一回事，会话一长必然出现 1841k / 1000k。
// 这条测试钉住"响应里的 usage 不许动圆环"（旧代码在下面第二次断言处失败）。
suite('chat panel: the context ring only trusts usage_update', () => {
  function usageOf(harness: Harness): unknown {
    harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: harness.sessionId });
    for (const message of [...harness.surface.sent].reverse()) {
      if (message.type === 'focus' || message.type === 'boot') { return message.meta?.usage ?? null; }
    }
    return 'no snapshot was posted';
  }

  test('a prompt response carrying cumulative tokens does not touch the meter', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    harness.handler.handleUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'usage_update', used: 55642, size: 1000000,
        // The shape the agent really sends (measured, see the log): a raw float.
        cost: { amount: 2.6394680000000004, currency: 'USD' },
      },
    } as never);
    const reported = {
      used: 55642, size: 1000000,
      costAmount: 2.6394680000000004, costCurrency: 'USD',
      // [CUSTOM- 上下文 Tip 的统计字段：此刻还没完成任何轮次。
      turns: 0,
      history: [],
    };
    assert.deepStrictEqual(usageOf(harness), reported,
      'the agent-reported context usage is what the ring shows');

    Object.assign(harness.sessionManager, {
      sendPrompt: () => Promise.resolve({
        stopReason: 'end_turn',
        usage: { totalTokens: 1_841_000, inputTokens: 1_840_000, outputTokens: 1000 },
      }),
    });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: 'go' });
    await new Promise(resolve => setTimeout(resolve, 20));

    // [CUSTOM- 响应里的 usage 现在落在 lastTurn（Tip 的本轮构成），`used` 仍只由 usage_update 写。
    // 适配器在轮次激活时重置这个累计器，所以它描述的是本轮；即便如此也不许碰圆环。
    const after = usageOf(harness) as {
      used: number; size: number; turns: number;
      lastTurn?: { inputTokens: number; outputTokens: number };
    };
    assert.strictEqual(after.used, 55642,
      'a session-cumulative token total must never be rendered as context-window occupancy');
    assert.strictEqual(after.size, 1000000);
    assert.strictEqual(after.turns, 1);
    assert.deepStrictEqual(after.lastTurn, {
      inputTokens: 1_840_000, outputTokens: 1000, cachedReadTokens: 0, cachedWriteTokens: 0,
      costAmount: 2.6394680000000004,
    });
  });

  // [CUSTOM- 圆环双色：适配器把最近一次调用的拆分挂在 `_meta["_claude/usage"]` 上，
  // 宿主转成 camelCase 的 `meta.usage.parts`。缺失时字段不存在（客户端退回单色）。
  test('the last-call split rides on _claude/usage and reaches meta.usage.parts', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    harness.handler.handleUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'usage_update', used: 100, size: 200,
        _meta: {
          '_claude/usage': {
            inputTokens: 60, outputTokens: 20, cachedReadTokens: 15, cachedWriteTokens: 5,
          },
        },
      },
    } as never);
    const usage = usageOf(harness) as { parts?: Record<string, number> };
    assert.deepStrictEqual(usage.parts, {
      inputTokens: 60, outputTokens: 20, cachedReadTokens: 15, cachedWriteTokens: 5,
    });
  });

  test('an unknown _claude/usage shape is dropped rather than half-filled', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    harness.handler.handleUpdate({
      sessionId: 's-1',
      update: {
        sessionUpdate: 'usage_update', used: 100, size: 200,
        _meta: { '_claude/usage': { nonsense: true } },
      },
    } as never);
    const usage = usageOf(harness) as { parts?: unknown };
    assert.strictEqual(usage.parts, undefined);
  });
});

// [CUSTOM- 渲染回填只对"它就是照这段文本渲染的"那一版生效。
//
// 客户端发起渲染请求时给的是**那一刻**的文本（记录一落地就发，128），而正文还在流；
// 回填补上时记录往往已经更长。旧代码把这份 html 照收进 store，下一次快照（切会话 / 重开）
// 就会把"只渲染了开头几个字"的版本当成当前内容发给客户端 —— 记录看上去就是"显示不全"。
suite('chat panel: a stale markdown reply is not stored', () => {
  function chunk(harness: Harness, text: string): void {
    harness.handler.handleUpdate({
      sessionId: harness.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } },
    } as never);
  }

  /** The id the host assigned to the assistant record it just appended. */
  function assistantId(harness: Harness): string {
    for (const message of [...harness.surface.sent].reverse()) {
      if (message.type === 'append') {
        const entry = message.entries.find(e => e.kind === 'assistant');
        if (entry) { return entry.id; }
      }
    }
    throw new Error('no assistant record was appended');
  }

  /** The assistant entry the host is holding, as a snapshot would carry it. */
  function entryOf(harness: Harness, entryId: string): { text?: string; html?: string } | undefined {
    harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: harness.sessionId });
    for (const message of [...harness.surface.sent].reverse()) {
      if (message.type === 'focus' || message.type === 'boot') {
        const found = (message.snapshot?.entries ?? []).find(e => e.id === entryId);
        return found as { text?: string; html?: string } | undefined;
      }
    }
    return undefined;
  }

  test('streaming replies accept older prefixes without poisoning stored HTML', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    chunk(harness, 'first\n\ntail');
    const id = assistantId(harness);
    chunk(harness, ' grows');
    harness.host.onMessage({ type: 'renderMarkdown', items: [
      { entryId: id, sessionId: 's-1', text: 'first\n\ntail', streaming: true },
    ] });
    const entry = entryOf(harness, id);
    const replies = harness.surface.sent.filter(message => message.type === 'markdownRendered');
    const item = replies.flatMap(message => message.type === 'markdownRendered' ? message.items : [])
      .find(item => item.entryId === id && item.stream);
    assert.ok(item?.stream);
    assert.strictEqual(item.stream.sourceLength, 'first\n\ntail'.length);
    assert.strictEqual(item.stream.start, 0);
    assert.strictEqual(item.stream.blocks.join('') + item.stream.tailHtml, new SafeMarkdown().render('first\n\ntail'));
    assert.strictEqual(entry?.html, undefined);
    harness.host.dispose();
  });

  test('a length-based streaming request renders the host text and ships only new blocks', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    chunk(harness, 'one\n\ntwo\n\nthree');
    const id = assistantId(harness);
    const ask = (text: string, have?: { streamGeneration: number; streamBlocks: number }) => {
      harness.surface.sent.length = 0;
      harness.host.onMessage({ type: 'renderMarkdown', items: [
        { entryId: id, sessionId: 's-1', text: '', streaming: true, textLength: text.length, check: text.slice(-16), ...have },
      ] });
      harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: harness.sessionId });
      return harness.surface.sent.flatMap(message => message.type === 'markdownRendered' ? message.items : [])
        .find(item => item.entryId === id)?.stream;
    };
    const first = ask('one\n\ntwo\n\nthree');
    assert.ok(first);
    assert.strictEqual(first.start, 0);
    assert.strictEqual(first.blocks.join('') + first.tailHtml, new SafeMarkdown().render('one\n\ntwo\n\nthree'));
    chunk(harness, '\n\nfour');
    const next = ask('one\n\ntwo\n\nthree\n\nfour', { streamGeneration: first.generation, streamBlocks: first.blocks.length });
    assert.ok(next);
    assert.strictEqual(next.start, first.blocks.length, 'held blocks are not shipped again');
    assert.strictEqual(next.blocks.length, 1);
    assert.strictEqual(ask('one\n\nWRONG'), undefined, 'a mismatching check is refused');
    harness.host.dispose();
  });

  test('streamed chunks after the first travel as appendText deltas', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    chunk(harness, 'hello');
    harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: harness.sessionId });
    harness.surface.sent.length = 0;
    chunk(harness, ' world');
    chunk(harness, '!');
    harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: harness.sessionId });
    const deltas = harness.surface.sent.filter(message => message.type === 'appendText');
    assert.deepStrictEqual(deltas.map(m => m.type === 'appendText' ? [m.offset, m.text] : null), [[5, ' world!']],
      'one coalesced delta, offset = text the client already had');
    assert.ok(!harness.surface.sent.some(m => m.type === 'append'), 'the whole entry is not re-sent');
    harness.host.dispose();
  });

  test('a replaced source cannot produce a streaming reply', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    chunk(harness, 'current');
    const id = assistantId(harness);
    harness.host.onMessage({ type: 'renderMarkdown', items: [
      { entryId: id, sessionId: 's-1', text: 'obsolete', streaming: true },
    ] });
    entryOf(harness, id);
    assert.ok(!harness.surface.sent.some(message => message.type === 'markdownRendered'
      && message.items.some(item => item.entryId === id && item.stream)));
    harness.host.dispose();
  });

  test('a reply rendered from an older text never reaches the record', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    chunk(harness, '后端');
    const id = assistantId(harness);
    // The record grows while the reply is in flight.
    chunk(harness, '**没事**——被终止的只是那层包装 shell');

    harness.host.onMessage({
      type: 'renderMarkdown',
      items: [{ entryId: id, sessionId: 's-1', text: '后端' }],
    } as never);

    const entry = entryOf(harness, id);
    assert.strictEqual(entry?.text, '后端**没事**——被终止的只是那层包装 shell', 'the record kept the text');
    assert.strictEqual(entry?.html, undefined,
      'the rendering of the prefix must not be stored as if it were the record');
  });

  test('a reply for the text the record actually has is stored', () => {
    const harness = makeHarness('s-1', 'Claude Code');
    chunk(harness, '完整正文');
    const id = assistantId(harness);

    harness.host.onMessage({
      type: 'renderMarkdown',
      items: [{ entryId: id, sessionId: 's-1', text: '完整正文' }],
    } as never);

    assert.ok(entryOf(harness, id)?.html, 'the matching reply is still applied (this is the normal path)');
  });
});

// [CUSTOM- 轮次进行中发消息 = 注入**正在跑的那一轮**（steering），不是第二个轮次。
//
// 关键不变量：steering 不产生第二个 PromptResponse。走普通路径要么被"已有轮次在跑"守卫拒掉
// （用户报的"任务进行中按回车没反应"），要么永远 await 不到响应（Stop 按钮永不熄灭、
// finalizeTurn 永不执行）。
suite('chat panel: a message sent mid-turn steers the running turn', () => {
  function steerHarness(supported: boolean, outcome: 'steered' | 'idle') {
    const harness = makeHarness('s-1', 'Claude Code');
    const steered: Array<{ sessionId: string; blocks: unknown }> = [];
    const prompted: string[] = [];
    Object.assign(harness.sessionManager, {
      hasRunningTurn: () => true,
      supportsSteering: () => supported,
      steerPrompt: (sessionId: string, blocks: unknown) => {
        steered.push({ sessionId, blocks });
        return Promise.resolve(outcome);
      },
      sendPrompt: (sessionId: string) => {
        prompted.push(sessionId);
        return Promise.resolve({ stopReason: 'end_turn' });
      },
    });
    return { harness, steered, prompted };
  }

  test('the message is injected, and the running turn is left alone', async () => {
    const { harness, steered, prompted } = steerHarness(true, 'steered');
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: '补充一句' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.strictEqual(steered.length, 1, 'the message went out through the steering channel');
    assert.strictEqual(steered[0].sessionId, 's-1');
    assert.deepStrictEqual(steered[0].blocks, [{ type: 'text', text: '补充一句' }]);
    assert.deepStrictEqual(prompted, [], 'and NOT as a second prompt (that would be a second turn)');
    assert.deepStrictEqual(harness.notices.shown, [],
      'the turn is still running — a "turn finished" notice here would be a lie');
    const state = settle(harness, harness.agentName, harness.sessionId);
    assert.ok(visibleText(state).includes('补充一句'), 'the message still lands in the transcript');
  });

  test('an idle agent falls back to a normal prompt instead of swallowing it', async () => {
    const { harness, steered, prompted } = steerHarness(true, 'idle');
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: '补充一句' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.strictEqual(steered.length, 1, 'steering was attempted (our own flag said a turn was running)');
    assert.deepStrictEqual(prompted, ['s-1'],
      'the agent said no turn was running, so the message must go out as an ordinary prompt');
  });

  test('an agent without steering never gets one', async () => {
    const { harness, steered, prompted } = steerHarness(false, 'steered');
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's-1', text: '补充一句' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepStrictEqual(steered, [], 'a capability we do not have must not be exercised');
    assert.deepStrictEqual(prompted, ['s-1'], 'it goes down the ordinary path');
  });
});

// [CUSTOM- 连接期间，agent 的 stderr 要送到面板上。
//
// 用户报"一直卡在连接界面"。日志里的原因是 npx 在下载新版本适配器
// （`The following package was not found and will be installed: …`），而 `initialize` 要等它 ——
// 那几行此前只进日志，卡片上永远只有 "Connecting…"。这条把"送上去"这一跳钉住；
// "连上之后不再送"同样钉住（那时的 stderr 只是噪声）。
suite('chat panel: the connecting card hears why it is slow', () => {
  function connectionMessages(harness: Harness): Array<Record<string, unknown>> {
    return harness.surface.sent.filter(m => m.type === 'connection') as Array<Record<string, unknown>>;
  }

  test('an agent stderr line rides the connecting phase, and stops after it', async () => {
    const harness = makeHarness('s-1', 'Claude Code');
    // 让 ensureConnected 永远挂着：停在 connecting 相位，不去真的 spawn 一个进程。
    Object.assign(harness.sessionManager, { ensureConnected: () => new Promise(() => { /* never */ }) });
    harness.host.onMessage({ type: 'connectAgent', agentName: 'Claude Code' });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(connectionMessages(harness).some(m => m.state === 'connecting'),
      'the connecting phase went out first');

    harness.sessionManager.emit('agent-stderr', {
      agentId: 'agent_1',
      line: 'npm warn exec The following package was not found and will be installed: @agentclientprotocol/claude-agent-acp@0.86.0',
    });

    const withDetail = connectionMessages(harness).filter(m => m.detail !== undefined);
    assert.strictEqual(withDetail.length, 1, `expected one detail line, got ${JSON.stringify(withDetail)}`);
    assert.match(String(withDetail[0].detail), /will be installed/);
    assert.strictEqual(withDetail[0].state, 'connecting', 'and it stays in the connecting phase');

    // 相位结束（让这次连接失败收尾）之后，同样的 stderr 不再上卡片。
    Object.assign(harness.sessionManager, { ensureConnected: () => Promise.reject(new Error('nope')) });
    harness.host.onMessage({ type: 'connectAgent', agentName: 'Claude Code' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(connectionMessages(harness).some(m => m.state === 'failed'), 'the phase is over');

    const before = connectionMessages(harness).length;
    harness.sessionManager.emit('agent-stderr', { agentId: 'agent_1', line: 'a later, harmless warning' });
    assert.strictEqual(connectionMessages(harness).length, before, 'no stderr noise once the phase is over');
  });
});

// [CUSTOM- 编辑器「当前文件 + 多行选区」→ 输入框引用栏那一格。
//
// 判据都是纯函数/协议层的：真 `vscode.window.activeTextEditor` 在测试宿主里造不出来，所以
// `readActiveFileFrom` 收一个**结构子集**（同 `pickDefaultCwd` 的既有做法）。
suite('chat panel: active editor file → composer reference ()', () => {
  const editor = (over: Partial<ActiveEditorLike> = {}): ActiveEditorLike => ({
    document: { uri: { scheme: 'file', fsPath: 'd:/work/src/DemoFile.cs' } },
    selection: { isEmpty: true, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    ...over,
  });

  test('no editor, or a non-file document, yields nothing', () => {
    assert.strictEqual(readActiveFileFrom(undefined), null);
    assert.strictEqual(
      readActiveFileFrom(editor({ document: { uri: { scheme: 'untitled', fsPath: 'Untitled-1' } } })),
      null,
      'untitled: / 虚拟文档没有可引用的路径');
  });

  test('a file with no selection is the whole file', () => {
    assert.deepStrictEqual(readActiveFileFrom(editor()), {
      path: 'd:/work/src/DemoFile.cs', name: 'DemoFile.cs',
    });
  });

  test('a multi-line selection becomes a 1-based range; "ends at the next line start" does not count it', () => {
    // 0 基 2..5 → 界面上的 3-5
    assert.deepStrictEqual(
      readActiveFileFrom(editor({ selection: { isEmpty: false, start: { line: 2, character: 4 }, end: { line: 5, character: 9 } } })),
      { path: 'd:/work/src/DemoFile.cs', name: 'DemoFile.cs', lineStart: 3, lineEnd: 6 });
    // 拖到下一行行首（character 0）时那一行不算选中 ⇒ 3-5 而不是 3-6（与编辑器显示一致）
    assert.deepStrictEqual(
      readActiveFileFrom(editor({ selection: { isEmpty: false, start: { line: 2, character: 4 }, end: { line: 5, character: 0 } } })),
      { path: 'd:/work/src/DemoFile.cs', name: 'DemoFile.cs', lineStart: 3, lineEnd: 5 });
    // 单行选区也算行选择（用户报：选中一行里的几个字时识别不出行号）⇒ 1 基 5-5
    assert.deepStrictEqual(
      readActiveFileFrom(editor({ selection: { isEmpty: false, start: { line: 4, character: 1 }, end: { line: 4, character: 8 } } })),
      { path: 'd:/work/src/DemoFile.cs', name: 'DemoFile.cs', lineStart: 5, lineEnd: 5 });
    // 拖到下一行行首（character 0）选中整行时，同样是单行区间 5-5
    assert.deepStrictEqual(
      readActiveFileFrom(editor({ selection: { isEmpty: false, start: { line: 4, character: 0 }, end: { line: 5, character: 0 } } })),
      { path: 'd:/work/src/DemoFile.cs', name: 'DemoFile.cs', lineStart: 5, lineEnd: 5 });
  });

  test('attachPath 的 meta 进了附件（显示名带行区间），发送时 uri 带 #L 片段', async () => {
    class RecordingSendManager extends SessionManager {
      readonly sent: Array<unknown> = [];
      override async sendPrompt(_sessionId: string, prompt: unknown): Promise<PromptResponse> {
        this.sent.push(prompt);
        return { stopReason: 'end_turn' } as PromptResponse;
      }
    }
    let manager!: RecordingSendManager;
    const harness = makeHarness('ref-session', 'Claude Code', handler => {
      manager = new RecordingSendManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;

    harness.host.onMessage({
      type: 'attachPath', sessionId: 'ref-session', paths: ['d:/work/src/DemoFile.cs'],
      meta: [{ name: 'DemoFile.cs:12-40', lineStart: 12, lineEnd: 40 }],
    });
    const attachments = harness.surface.sent.filter(m => m.type === 'attachments').pop() as unknown as
      { attachments: Array<Record<string, unknown>> };
    assert.ok(attachments, '宿主必须把附件列回给客户端（chat 才会把 + 变成 ×）');
    assert.strictEqual(attachments.attachments[0].name, 'DemoFile.cs:12-40');
    assert.strictEqual(attachments.attachments[0].lineStart, 12);

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'ref-session', text: '两边都提交git' });
    for (let i = 0; i < 100 && manager.sent.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // `sendPrompt` 收到的是**内容块数组**本身（不是 { content: [...] } 包着的那种）。
    const blocks = (manager.sent[0] ?? []) as Array<{ type: string; uri?: string; name?: string }>;
    const link = blocks.find(b => b.type === 'resource_link');
    assert.ok(link, '提示里应有 resource_link：' + JSON.stringify(blocks));
    assert.ok(String(link!.uri).endsWith('#L12-40'), '行区间进 uri 片段（agent 也看得到）: ' + link!.uri);
    assert.strictEqual(link!.name, 'DemoFile.cs:12-40');
  });

  test('attachPath 的 kind: folder 保留为目录附件，普通路径仍是文件', () => {
    const harness = makeHarness('folder-ref', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.host.onMessage({
      type: 'attachPath', sessionId: 'folder-ref',
      paths: ['d:/work/src', 'd:/work/src/a.ts'],
      meta: [{ kind: 'folder' }, {}],
    });
    const message = harness.surface.sent.filter(m => m.type === 'attachments').pop() as unknown as
      { attachments: Array<Record<string, unknown>> };
    assert.ok(message, '附件广播必须到达客户端');
    assert.strictEqual(message.attachments[0].kind, 'folder');
    assert.strictEqual(message.attachments[0].path, 'd:/work/src');
    assert.strictEqual(message.attachments[1].kind, undefined, '普通路径不写 kind（保持旧形状）');
    assert.strictEqual(message.attachments[1].path, 'd:/work/src/a.ts');
  });
});

// [CUSTOM- 引用的同一性 = 路径 + 行区间：同一个文件可以引用**多段**，
// 摘除也只摘那一段（不带区间的拖拽/粘贴仍按路径去重/全摘，行为不变）。
suite('chat panel: one file, several referenced ranges ()', () => {
  const PATH = 'd:/work/src/DemoFile.cs';

  function listed(harness: Harness): Array<Record<string, unknown>> {
    const msg = harness.surface.sent.filter(m => m.type === 'attachments').pop() as unknown as
      { attachments: Array<Record<string, unknown>> } | undefined;
    return msg ? msg.attachments : [];
  }

  test('two ranges of one file are two references; the same range twice is one', () => {
    const harness = makeHarness('multi-ref', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.host.onMessage({
      type: 'attachPath', sessionId: 'multi-ref', paths: [PATH], meta: [{ name: 'a.cs:12-40', lineStart: 12, lineEnd: 40 }],
    });
    harness.host.onMessage({
      type: 'attachPath', sessionId: 'multi-ref', paths: [PATH], meta: [{ name: 'a.cs:5-9', lineStart: 5, lineEnd: 9 }],
    });
    assert.strictEqual(listed(harness).length, 2, '同一个文件的两段是两条引用');
    assert.deepStrictEqual(listed(harness).map(a => a.lineStart), [12, 5]);

    harness.host.onMessage({
      type: 'attachPath', sessionId: 'multi-ref', paths: [PATH], meta: [{ name: 'a.cs:12-40', lineStart: 12, lineEnd: 40 }],
    });
    assert.strictEqual(listed(harness).length, 2, '同一段再引用一次不重复');

    // 拖拽那条路没有区间：仍然按路径去重（原有的行为）
    harness.host.onMessage({ type: 'attachPath', sessionId: 'multi-ref', paths: [PATH] });
    assert.strictEqual(listed(harness).length, 3, '不带区间的一条是**第三**条引用（整文件）');
    harness.host.onMessage({ type: 'attachPath', sessionId: 'multi-ref', paths: [PATH] });
    assert.strictEqual(listed(harness).length, 3, '同一路径的整文件引用只留一份');
  });

  test('detachFile 带区间只摘那一段；不带则整条路径全摘', () => {
    const harness = makeHarness('detach-ref', 'Claude Code');
    harness.surface.sent.length = 0;
    for (const [start, end] of [[12, 40], [5, 9]] as Array<[number, number]>) {
      harness.host.onMessage({
        type: 'attachPath', sessionId: 'detach-ref', paths: [PATH],
        meta: [{ name: `a.cs:${start}-${end}`, lineStart: start, lineEnd: end }],
      });
    }
    harness.host.onMessage({ type: 'detachFile', sessionId: 'detach-ref', path: PATH, lineStart: 12, lineEnd: 40 });
    assert.deepStrictEqual(listed(harness).map(a => a.lineStart), [5], '只摘 12-40 那一段');

    harness.host.onMessage({ type: 'detachFile', sessionId: 'detach-ref', path: PATH });
    assert.strictEqual(listed(harness).length, 0, '不带区间 = 整条路径全摘');
  });

  test('发送时每一段各是一个 resource_link，各带自己的 #L 片段', async () => {
    class RecordingSendManager extends SessionManager {
      readonly sent: Array<unknown> = [];
      override async sendPrompt(_sessionId: string, prompt: unknown): Promise<PromptResponse> {
        this.sent.push(prompt);
        return { stopReason: 'end_turn' } as PromptResponse;
      }
    }
    let manager!: RecordingSendManager;
    const harness = makeHarness('multi-send', 'Claude Code', handler => {
      manager = new RecordingSendManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;
    for (const [start, end] of [[12, 40], [5, 9]] as Array<[number, number]>) {
      harness.host.onMessage({
        type: 'attachPath', sessionId: 'multi-send', paths: [PATH],
        meta: [{ name: `a.cs:${start}-${end}`, lineStart: start, lineEnd: end }],
      });
    }
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'multi-send', text: '看这两段' });
    for (let i = 0; i < 100 && manager.sent.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const blocks = (manager.sent[0] ?? []) as Array<{ type: string; uri?: string }>;
    const links = blocks.filter(b => b.type === 'resource_link');
    assert.strictEqual(links.length, 2, '两段 = 两个引用块');
    assert.ok(links.some(l => String(l.uri).endsWith('#L12-40')));
    assert.ok(links.some(l => String(l.uri).endsWith('#L5-9')));
  });
});

// 四件事分开测：①快照写盘（globalState）并端给下一个窗口；②恢复时**不关**别的会话（与 099 的
// 替换语义相反）；③有可恢复会话时**不自动建新会话**（否则用户既拿到新空会话又被打扰）；
// ④四条新消息（startRestore / dismissSessions / forgetRestorable / setRestorePref）。
suite('chat panel: session restore ()', () => {
  const OPEN_KEY = 'vac.openSessions.v1';
  type Snap = { sessions: Array<{ sessionId: string; agentName: string; cwd?: string }>; focused: string | null };
  const snapshotOf = (memento: FakeMemento): Snap | undefined => memento.get<Snap>(OPEN_KEY);

  async function waitFor(check: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (check()) { return; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('timed out waiting for ' + label);
  }

  test('the setting value is sanitized (a hand-edited settings.json cannot invent a phase)', () => {
    assert.strictEqual(resolveRestoreChoice('always'), 'always');
    assert.strictEqual(resolveRestoreChoice('never'), 'never');
    assert.strictEqual(resolveRestoreChoice('ask'), 'ask');
    assert.strictEqual(resolveRestoreChoice('sometimes'), 'ask');
    assert.strictEqual(resolveRestoreChoice(undefined), 'ask');
  });

  test('the open sessions are snapshotted, and offered to the next window', async () => {
    const memento = new FakeMemento();
    const first = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    // 快照挂在 created / closed / **focus** 三个事件上（harness 直接塞会话，不发 created），
    // 所以这里用一次聚焦把它触发 —— 真实路径上"打开一个会话"本来就带这次聚焦。
    first.host.onMessage({ type: 'focusSession', sessionId: 's-1' });
    await waitFor(() => (snapshotOf(memento)?.sessions.length ?? 0) === 1, 'the snapshot to be written');
    assert.deepStrictEqual(snapshotOf(memento)!.sessions.map(s => s.sessionId), ['s-1']);
    assert.strictEqual(snapshotOf(memento)!.focused, 's-1', '聚焦的那条也记着 —— 恢复时先加载它');

    // 新窗口：同一个 globalState，但宿主重启过（那条会话不再活）
    const second = makeHarness('s-2', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    const boot = second.surface.sent.find(m => m.type === 'boot') as unknown as
      { recoverable?: Array<{ sessionId: string }> };
    assert.deepStrictEqual(boot.recoverable?.map(r => r.sessionId), ['s-1'], '上一次开着的会被端上来');
  });

  test('a restore adds a session instead of replacing one (keepOthers)', async () => {
    class ClosingManager extends SessionManager {
      readonly closed: string[] = [];
      readonly opened: string[] = [];
      override async closeSession(_agentName: string, sessionId: string): Promise<void> { this.closed.push(sessionId); }
      override async openExistingSession(
        _agentName: string, sessionId: string, _opts: { cwd?: string; title?: string } = {},
      ): Promise<'live' | 'load' | 'resume'> {
        this.opened.push(sessionId);
        return 'live';
      }
    }
    let manager!: ClosingManager;
    const memento = new FakeMemento();
    const harness = makeHarness('focused-one', 'Claude Code', handler => {
      manager = new ClosingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    }, new StubPrefs(), {}, memento);
    harness.surface.sent.length = 0;

    harness.host.onMessage({
      type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'restored-one',
      cwd: '/tmp', title: 'restored', keepOthers: true,
    });
    await waitFor(() => manager.opened.length === 1, 'the restore to open the session');
    assert.deepStrictEqual(manager.closed, [], '恢复是"多开"：不许像历史选择器那样关掉聚焦的那个');
  });

  test('with sessions to restore, connecting does NOT create a new one (never 时照旧建)', async () => {
    class CountingManager extends SessionManager {
      readonly created: string[] = [];
      override async ensureConnected(agentName: string): Promise<ConnectionInfo> {
        void agentName;
        return {} as ConnectionInfo;
      }
      override isAgentConnected(): boolean { return true; }
      override getSessionIdsForAgent(): string[] { return []; }
      override async createSession(agentName: string): Promise<SessionInfo> {
        this.created.push(agentName);
        return { sessionId: 'fresh', agentName } as unknown as SessionInfo;
      }
    }
    const seed = async (memento: FakeMemento) => memento.update(OPEN_KEY, {
      sessions: [{ agentName: 'Claude Code', sessionId: 'gone', cwd: '/tmp' }], focused: 'gone',
    });

    const askingMemento = new FakeMemento();
    await seed(askingMemento);
    let asking!: CountingManager;
    const first = makeHarness('placeholder', 'Claude Code', handler => {
      asking = new CountingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return asking;
    }, new StubPrefs(), {}, askingMemento);
    first.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => first.surface.sent.some(m => m.type === 'connection' && m.state === 'connected'), 'connected');
    assert.deepStrictEqual(asking.created, [], '有可恢复的会话 ⇒ 先问用户，别当场建一个新的');

    // never：用户说了不要那些 tab ⇒ 回到"保持现在的逻辑"（照建）
    const neverMemento = new FakeMemento();
    await seed(neverMemento);
    let following!: CountingManager;
    const second = makeHarness('placeholder', 'Claude Code', handler => {
      following = new CountingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return following;
    }, new StubPrefs(false, 'never'), {}, neverMemento);
    second.host.onMessage({ type: 'connectAgent' });
    await waitFor(() => second.surface.sent.some(m => m.type === 'connection' && m.state === 'connected'), 'connected (never)');
    assert.deepStrictEqual(following.created, ['Claude Code'], '设置 never ⇒ 不问、照旧建一个');
  });

  test('dismiss / forget / setRestorePref 三条都落地', async () => {
    const memento = new FakeMemento();
    const prefs = new StubPrefs();
    const harness = makeHarness('s-1', 'Claude Code', undefined, prefs, {}, memento);
    harness.host.onMessage({ type: 'focusSession', sessionId: 's-1' });
    await waitFor(() => (snapshotOf(memento)?.sessions.length ?? 0) === 1, 'the snapshot to be written');

    harness.host.onMessage({ type: 'forgetRestorable', sessionId: 's-1' });
    await waitFor(() => (snapshotOf(memento)?.sessions.length ?? 1) === 0, 'the entry to be forgotten');

    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'setRestorePref', value: 'always' });
    await waitFor(() => harness.surface.sent.some(m => m.type === 'restorePref'), 'the pref reply');
    assert.deepStrictEqual(prefs.restoreWrites, ['always']);
    const reply = harness.surface.sent.filter(m => m.type === 'restorePref').pop() as unknown as { value: string };
    assert.strictEqual(reply.value, 'always', '回话带上真正的值（另一个面/设置面板改了也要跟上）');

    // [CUSTOM- 2026-10-30：New session 不再建真实会话，两个面的恢复卡片只能靠这条广播退场。
    const second = new RecordingSurface('editor');
    harness.host.attachSurface(second, { agentName: 'Claude Code', sessionId: 's-1' });
    second.sent.length = 0;
    harness.host.onMessage({ type: 'dismissSessions' });
    await waitFor(() => snapshotOf(memento) === undefined, 'the snapshot to be dropped');
    await waitFor(() => harness.surface.sent.some(m => m.type === 'sessionsDismissed'),
      'the first surface to hear about it');
    await waitFor(() => second.sent.some(m => m.type === 'sessionsDismissed'),
      'the other surface to hear about it');
  });

  test('dismiss cancels a snapshot write that is already queued', async () => {
    const memento = new FakeMemento();
    const harness = makeHarness('s-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    // A focus queues the 300ms debounced snapshot write. Dismiss before it fires:
    // without clearing the timer it would write the old snapshot back after the clear.
    harness.host.onMessage({ type: 'focusSession', sessionId: 's-1' });
    harness.host.onMessage({ type: 'dismissSessions' });
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.strictEqual(memento.get('vac.openSessions.v1'), undefined,
      'the queued write must not resurrect the dismissed snapshot');
  });

  test('startRestore loads the session that was focused, and leaves the rest lazy', async () => {
    class RecordingOpen extends SessionManager {
      readonly opened: string[] = [];
      override async openExistingSession(
        _agentName: string, sessionId: string, _opts: { cwd?: string; title?: string } = {},
      ): Promise<'live' | 'load' | 'resume'> {
        this.opened.push(sessionId);
        return 'load';
      }
    }
    const memento = new FakeMemento();
    await memento.update(OPEN_KEY, {
      sessions: [
        { agentName: 'Claude Code', sessionId: 'a', cwd: '/tmp' },
        { agentName: 'Claude Code', sessionId: 'b', cwd: '/tmp' },
      ],
      focused: 'b',
    });
    let manager!: RecordingOpen;
    const harness = makeHarness('placeholder', 'Claude Code', handler => {
      manager = new RecordingOpen(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    }, new StubPrefs(), {}, memento);

    harness.host.onMessage({ type: 'startRestore' });
    await waitFor(() => manager.opened.length === 1, 'the focused session to load');
    assert.deepStrictEqual(manager.opened, ['b'], '只把那一条真加载（其余点开才加载）');
  });
});

// [CUSTOM- 从记录 fork 会话：面板只报「哪条记录」（entryId），ACP `messageId` 由宿主
// 从记录里取 —— 所以记录的线格式不必带 messageId，而分叉点仍然精确到那条消息。
suite('chat panel: fork a session from a record', () => {
  async function waitFor(check: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.ok(check(), label);
  }

  class ForkingManager extends SessionManager {
    readonly forks: Array<{ agentName: string; sessionId: string; messageId?: string }> = [];
    override async forkSession(
      agentName: string, sessionId: string, opts: { messageId?: string } = {},
    ): Promise<SessionInfo> {
      this.forks.push({ agentName, sessionId, ...(opts.messageId ? { messageId: opts.messageId } : {}) });
      return { sessionId: 'forked' } as unknown as SessionInfo;
    }
  }

  function harnessWithForker(): { harness: Harness; manager: ForkingManager } {
    let manager!: ForkingManager;
    const harness = makeHarness('s-fork', 'Claude Code', handler => {
      manager = new ForkingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;
    return { harness, manager };
  }

  /** Feed one assistant chunk; its record id is what the panel would right-click. */
  function feedAssistant(harness: Harness, messageId?: string): string {
    harness.handler.handleUpdate({
      sessionId: harness.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk', ...(messageId ? { messageId } : {}),
        content: { type: 'text', text: 'answer' },
      },
    } as never);
    for (let i = harness.surface.sent.length - 1; i >= 0; i--) {
      const message = harness.surface.sent[i];
      if (message.type === 'append') {
        const entry = message.entries.find(e => e.kind === 'assistant');
        if (entry) { return entry.id; }
      }
    }
    throw new Error('no assistant record was appended');
  }

  test('the ACP messageId of that record is the fork point', async () => {
    const { harness, manager } = harnessWithForker();
    const entryId = feedAssistant(harness, 'm1');

    harness.host.onMessage({ type: 'forkFromMessage', sessionId: 's-fork', entryId });
    await waitFor(() => manager.forks.length === 1, 'the fork to be requested');
    assert.deepStrictEqual(manager.forks,
      [{ agentName: 'Claude Code', sessionId: 's-fork', messageId: 'm1' }],
      '宿主把记录还原成 ACP 的 messageId 再分叉');
  });

  test('a record the agent gave no messageId forks at the end of the session', async () => {
    const { harness, manager } = harnessWithForker();
    const entryId = feedAssistant(harness);

    harness.host.onMessage({ type: 'forkFromMessage', sessionId: 's-fork', entryId });
    await waitFor(() => manager.forks.length === 1, 'the fork to be requested');
    assert.deepStrictEqual(manager.forks,
      [{ agentName: 'Claude Code', sessionId: 's-fork' }],
      '没有消息 id 就不带 _meta（整条会话分叉）');
  });
});

// [CUSTOM- sub-agent 子会话（ACP draft subagent_update）。适配器把子会话**自己的流量**改路由到
// 子 sessionId；宿主把它**别名回父会话**照原样渲染（既有行为因此不变），另外多出一张
// 「身份 + 状态 + 取消」的卡。通知外层的 sessionId 是父，update 里的 sessionId 才是子。
suite('chat panel: sub-agent child sessions', () => {
  async function waitFor(check: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.ok(check(), label);
  }

  class CancellingManager extends SessionManager {
    readonly cancels: Array<{ parent: string; child: string }> = [];
    override async cancelSubagent(parentSessionId: string, subagentSessionId: string): Promise<void> {
      this.cancels.push({ parent: parentSessionId, child: subagentSessionId });
    }
  }

  interface Card {
    kind?: string; subagentSessionId?: string; title?: string;
    description?: string; state?: string; canCancel?: boolean;
  }
  interface Append { type?: string; sessionId?: string; entries: Card[] }

  function harnessWithManager(): { harness: Harness; manager: CancellingManager } {
    let manager!: CancellingManager;
    const harness = makeHarness('parent', 'Claude Code', handler => {
      manager = new CancellingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    harness.surface.sent.length = 0;
    return { harness, manager };
  }

  function appends(harness: Harness): Append[] {
    return harness.surface.sent.filter(m => m.type === 'append') as unknown as Append[];
  }

  function cards(harness: Harness): Card[] {
    return appends(harness).flatMap(m => m.entries).filter(e => e.kind === 'subagent');
  }

  /** One `subagent_update`, sent on the PARENT (its `sessionId` inside names the child). */
  function announce(harness: Harness, child: string, extra: Record<string, unknown> = {}): void {
    harness.handler.handleUpdate({
      sessionId: 'parent',
      update: {
        sessionUpdate: 'subagent_update', sessionId: child,
        title: 'story_editor', capabilities: { cancel: {} }, state: { state: 'running' },
        ...extra,
      },
    } as never);
  }

  test('a subagent_update adds a card carrying identity, state and cancel', async () => {
    const { harness } = harnessWithManager();
    announce(harness, 'child-1', { description: 'edits the story' });
    // `post` coalesces appends through the outbox, so the card lands on a later turn.
    await waitFor(() => cards(harness).length === 1, 'the sub-agent card to be appended');
    const card = cards(harness)[0];
    assert.strictEqual(card.subagentSessionId, 'child-1');
    assert.strictEqual(card.title, 'story_editor');
    assert.strictEqual(card.description, 'edits the story');
    assert.strictEqual(card.state, 'running');
    assert.strictEqual(card.canCancel, true);
  });

  test("the child's own output renders in the PARENT (aliased), not dropped", async () => {
    const { harness } = harnessWithManager();
    announce(harness, 'child-1');
    harness.handler.handleUpdate({
      sessionId: 'child-1',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'child says hi' } },
    } as never);

    await waitFor(() => appends(harness).flatMap(m => m.entries).some(e => e.kind === 'assistant'),
      "the child's text to land in the parent transcript");
    assert.ok(appends(harness).every(m => m.sessionId === 'parent'),
      'every append names the parent session, never the child');
  });

  test('a later subagent_update patches the card in place, not a second card', async () => {
    const { harness } = harnessWithManager();
    announce(harness, 'child-1');
    await waitFor(() => cards(harness).length === 1, 'the first card');
    announce(harness, 'child-1', { state: { state: 'requires_action' } });

    await waitFor(() => harness.surface.sent.filter(m => m.type === 'revise').length === 1,
      'the follow-up to be a patch');
    const revises = harness.surface.sent.filter(m => m.type === 'revise') as unknown as
      Array<{ patch?: { state?: string } }>;
    assert.strictEqual(revises[0].patch!.state, 'requires_action');
    assert.strictEqual(cards(harness).length, 1, 'still exactly one card');
  });

  // [CUSTOM- 重现用户现场：长会话回放会把 500 条窗口外的卡片挤掉，回放结尾
  // 再对每个子 agent 发一遍只带 state 的更新 —— 不能因此把卡片「复活」成一堆
  // 无标题的 idle 卡（截图中会话底部那一片 Sub-agent · unnamed）。
  test('the end-of-replay state sweep does not recreate an evicted card', async () => {
    const { harness } = harnessWithManager();
    announce(harness, 'child-1');
    await waitFor(() => cards(harness).length === 1, 'the first card');
    for (let i = 0; i < 500; i++) {
      harness.handler.handleUpdate({
        sessionId: 'parent',
        update: {
          sessionUpdate: 'tool_call', toolCallId: `t${i}`, title: 'Read', kind: 'read',
          status: 'completed', content: [],
        },
      } as never);
    }
    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'parent',
      update: { sessionUpdate: 'subagent_update', sessionId: 'child-1', state: { state: 'idle' } },
    } as never);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.strictEqual(cards(harness).length, 0, 'an evicted card is not recreated by a state-only sweep');

    // A child that is still working is shown again — with the labels the agent
    // map remembered from the announcement.
    harness.handler.handleUpdate({
      sessionId: 'parent',
      update: {
        sessionUpdate: 'subagent_update', sessionId: 'child-1',
        capabilities: { cancel: {} }, state: { state: 'running' },
      },
    } as never);
    await waitFor(() => cards(harness).length === 1, 'the working child to be shown again');
    assert.strictEqual(cards(harness)[0].title, 'story_editor');
  });

  test('cancelSubagent cancels exactly that child session', async () => {
    const { harness, manager } = harnessWithManager();
    announce(harness, 'child-1');
    harness.host.onMessage({ type: 'cancelSubagent', sessionId: 'parent', subagentSessionId: 'child-1' });
    await waitFor(() => manager.cancels.length === 1, 'the child cancel to be requested');
    assert.deepStrictEqual(manager.cancels, [{ parent: 'parent', child: 'child-1' }],
      '取消打在子会话 id 上，父会话与兄弟子会话不受影响');
  });

  test('subagent_update _meta["vac/agentMap"] reaches the client', async () => {
    const { harness } = harnessWithManager();
    assert.ok(harness.surface.html.includes('agentMapBtn'), 'the badge lives in the panel markup');
    announce(harness, 'child-1', {
      description: 'edits the story',
      _meta: {
        'vac/agentMap': {
          version: 1,
          startedAt: 1_000,
          durationMs: 2_500,
          totalTokens: 1_234,
          toolUses: 3,
          summary: 'editing the story',
          lastToolName: 'Read',
        },
      },
    });
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'requestAgentMap', sessionId: 'parent' });

    const message = harness.surface.sent.find(m => m.type === 'agentMap') as
      Extract<ExtToChatMessage, { type: 'agentMap' }> | undefined;
    assert.ok(message, 'the map snapshot is sent on demand');
    assert.strictEqual(message!.running, 1);
    const node = message!.agents[0];
    assert.strictEqual(node.agentId, 'child-1');
    assert.strictEqual(node.parentId, 'parent');
    assert.strictEqual(node.title, 'story_editor');
    assert.strictEqual(node.description, 'edits the story');
    assert.strictEqual(node.state, 'running');
    assert.strictEqual(node.canCancel, true);
    assert.strictEqual(node.startedAt, 1_000);
    assert.strictEqual(node.durationMs, 2_500);
    assert.strictEqual(node.totalTokens, 1_234);
    assert.strictEqual(node.toolUses, 3);
    assert.strictEqual(node.summary, 'editing the story');
    assert.strictEqual(node.lastToolName, 'Read');
  });

  test("a child usage_update feeds the agent's tokens and model", () => {
    const { harness } = harnessWithManager();
    announce(harness, 'child-1');
    harness.handler.handleUpdate({
      sessionId: 'child-1',
      update: {
        sessionUpdate: 'usage_update', used: 5_000, size: 200_000,
        cost: { amount: 0.12, currency: 'USD' },
        _meta: { '_claude/model': 'claude-opus-5.5' },
      },
    } as never);
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'requestAgentMap', sessionId: 'parent' });

    const message = harness.surface.sent.find(m => m.type === 'agentMap') as
      Extract<ExtToChatMessage, { type: 'agentMap' }> | undefined;
    assert.ok(message, 'the snapshot is sent');
    const node = message!.agents[0];
    assert.strictEqual(node.contextUsed, 5_000);
    assert.strictEqual(node.contextSize, 200_000);
    assert.strictEqual(node.costUsd, 0.12);
    assert.strictEqual(node.model, 'claude-opus-5.5');
  });

  test('stopAgent cancels that child only while it is cancellable and running', async () => {
    const { harness, manager } = harnessWithManager();
    announce(harness, 'child-1');
    harness.host.onMessage({ type: 'stopAgent', sessionId: 'parent', agentId: 'child-1' });
    await waitFor(() => manager.cancels.length === 1, 'the stop to reach cancelSubagent');
    assert.deepStrictEqual(manager.cancels, [{ parent: 'parent', child: 'child-1' }]);

    harness.host.onMessage({ type: 'stopAgent', sessionId: 'parent', agentId: 'unknown' });
    await Promise.resolve();
    assert.strictEqual(manager.cancels.length, 1, 'an unknown agent id is ignored');
  });

  test('closing the session clears its agent map', async () => {
    const { harness, manager } = harnessWithManager();
    announce(harness, 'child-1');
    await manager.closeSession('Claude Code', 'parent');
    registerFakeSession(manager, 'parent', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'requestAgentMap', sessionId: 'parent' });

    const message = harness.surface.sent.find(m => m.type === 'agentMap') as
      Extract<ExtToChatMessage, { type: 'agentMap' }> | undefined;
    assert.ok(message, 'a re-registered session can still be asked');
    assert.strictEqual(message!.running, 0);
    assert.deepStrictEqual(message!.agents, []);
  });
});

suite('chat panel: Side Chat surface isolation', () => {
  type BootMessage = Extract<ExtToChatMessage, { type: 'boot' }>;

  async function waitFor(check: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.ok(check(), label);
  }

  const sideSurfaces = new WeakMap<Harness, RecordingSurface>();
  const sideStubs = new WeakMap<Harness, {
    ids: string[];
    opened: Array<{ sessionId: string; selectedText?: string }>;
    closed: string[];
  }>();

  function sideStub(harness: Harness) {
    let stub = sideStubs.get(harness);
    if (stub) { return stub; }
    const ids: string[] = [];
    const opened: Array<{ sessionId: string; selectedText?: string }> = [];
    const closed: string[] = [];
    stub = { ids, opened, closed };
    sideStubs.set(harness, stub);
    harness.host.setSideChatOpener({
      open: async (sessionId, selectedText) => { opened.push({ sessionId, selectedText }); },
      has: sessionId => ids.includes(sessionId),
      sessionIds: () => ids,
      activate: (sessionId, options) => {
        const activated = harness.host.activateSideSession(sessionId);
        if (activated && options?.reveal) { sideSurfaces.get(harness)?.reveal(); }
        return activated;
      },
      close: async sessionId => { closed.push(sessionId); },
    });
    return stub;
  }

  function attachSide(harness: Harness, sideId = 'side-1', agentName = harness.agentName): RecordingSurface {
    sideStub(harness).ids.push(sideId);
    registerFakeSession(harness.sessionManager, sideId, agentName, {
      sideChat: {
        parentSessionId: harness.sessionId,
        forkedAt: '2026-11-03T00:01:00.000Z',
      },
    });
    let surface = sideSurfaces.get(harness);
    if (!surface) {
      surface = new RecordingSurface('side');
      sideSurfaces.set(harness, surface);
    }
    harness.host.attachSurface(surface, { agentName, sessionId: sideId });
    return surface;
  }

  function lastBoot(surface: RecordingSurface): BootMessage {
    const boot = surface.sent.filter(m => m.type === 'boot').pop();
    assert.ok(boot?.type === 'boot');
    return boot;
  }

  function prefMessages(surface: RecordingSurface): Array<Record<string, unknown>> {
    return surface.sent.filter(m => m.type === 'uiPrefs') as Array<Record<string, unknown>>;
  }

  function latestPrefs(surface: RecordingSurface): Record<string, unknown> {
    const prefs = prefMessages(surface).pop();
    assert.ok(prefs);
    return prefs;
  }

  function askSide(sessionId: string): CreateElicitationRequest {
    return {
      mode: 'form', sessionId, toolCallId: 'side-form', message: 'Side question?',
      requestedSchema: {
        type: 'object',
        properties: { answer: { type: 'string', title: 'Answer' } },
      },
    } as unknown as CreateElicitationRequest;
  }

  test('Side boot lists every member but hydrates only the active Side without changing main state', async () => {
    const memento = new FakeMemento();
    const harness = makeHarness('main-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    harness.sessionManager.getSession('main-1')!.title = 'Main title';
    harness.sessionManager.focusSession('main-1');
    const side = attachSide(harness);
    attachSide(harness, 'side-2');

    assert.deepStrictEqual(sideStub(harness).ids, ['side-1', 'side-2']);
    assert.strictEqual(harness.host.activeSideSessionId(), 'side-2');
    assert.strictEqual(harness.sessionManager.getActiveSessionId(), 'main-1');
    const boot = lastBoot(side);
    assert.strictEqual(boot.focused?.sessionId, 'side-2');
    assert.deepStrictEqual(boot.sessions.map(s => s.sessionId), ['side-1', 'side-2']);
    assert.deepStrictEqual(boot.focused?.sideChat, {
      parentSessionId: 'main-1', parentTitle: 'Main title', forkedAt: '2026-11-03T00:01:00.000Z',
    });
    assert.strictEqual(boot.autoConnect, false);
    assert.strictEqual('defaultCwd' in boot, false);
    assert.strictEqual('recoverable' in boot, false);
    assert.strictEqual(boot.snapshot?.entries.length ?? 0, 0);

    harness.host.onMessage({ type: 'sideFocus', sessionId: 'side-1' }, 'side');
    const focus = side.sent.filter(m => m.type === 'focus').pop();
    assert.ok(focus?.type === 'focus');
    assert.strictEqual(focus.summary?.sessionId, 'side-1');
    assert.strictEqual(harness.sessionManager.getActiveSessionId(), 'main-1');

    registerFakeSession(harness.sessionManager, 'main-2', harness.agentName);
    harness.surface.sent.length = 0;
    side.sent.length = 0;
    harness.sessionManager.emit('session-created', 'main-2', harness.agentName, 'load');
    harness.sessionManager.emit('active-session-changed', 'main-1', 'Claude Code');
    const mainSessions = harness.surface.sent.find(m => m.type === 'sessionsChanged');
    assert.ok(mainSessions?.type === 'sessionsChanged');
    assert.deepStrictEqual(mainSessions.sessions.map(s => s.sessionId), ['main-1', 'main-2']);
    assert.strictEqual(side.sent.some(m => m.type === 'focus'), false);

    harness.sessionManager.getSession('main-1')!.title = 'Renamed main';
    harness.sessionManager.emit('session-info-changed', 'main-1');
    const sideSessions = side.sent.find(m => m.type === 'sessionsChanged');
    assert.ok(sideSessions?.type === 'sessionsChanged');
    assert.deepStrictEqual(sideSessions.sessions.map(s => s.sessionId), ['side-1', 'side-2']);
    assert.ok(sideSessions.sessions.every(s => s.sideChat?.parentTitle === 'Renamed main'));

    await new Promise(resolve => setTimeout(resolve, 350));
    const snapshot = memento.get<{ sessions: Array<{ sessionId: string }> }>('vac.openSessions.v1');
    assert.deepStrictEqual(snapshot?.sessions.map(s => s.sessionId), ['main-1', 'main-2']);
  });

  test('only the main surface showing the source may open a Side', async () => {
    const harness = makeHarness('main-1');
    attachSide(harness);
    const opened = sideStub(harness).opened;

    harness.host.onMessage({ type: 'openSide', sessionId: 'main-1', selectedText: 'quoted' }, 'side');
    harness.host.onMessage({ type: 'openSide', sessionId: 'missing' });
    harness.host.onMessage({ type: 'openSide', sessionId: 'main-1', selectedText: 'quoted' });
    await waitFor(() => opened.length === 1, 'the valid open request');
    assert.deepStrictEqual(opened, [{ sessionId: 'main-1', selectedText: 'quoted' }]);
  });

  test('session guards allow only the active Side and reject cross-surface prompts', async () => {
    const harness = makeHarness('main-1');
    harness.sessionManager.focusSession('main-1');
    attachSide(harness);
    attachSide(harness, 'side-2');
    const sent: string[] = [];
    Object.assign(harness.sessionManager, {
      sendPrompt: (sessionId: string) => {
        sent.push(sessionId);
        return Promise.resolve({ stopReason: 'end_turn' });
      },
    });

    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'main-1', text: 'wrong' }, 'side');
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'side-1', text: 'stale' }, 'side');
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'side-2', text: 'wrong' });
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 'side-2', text: 'right' }, 'side');
    await waitFor(() => sent.length === 1, 'only the bound Side prompt');
    assert.deepStrictEqual(sent, ['side-2']);

    harness.host.onMessage({ type: 'newSession', agentName: 'Claude Code' }, 'side');
    harness.host.onMessage({ type: 'focusSession', sessionId: 'main-1' }, 'side');
    assert.strictEqual(harness.sessionManager.getActiveSessionId(), 'main-1');
  });

  test('Side tab commands validate surface and membership without focusing main', async () => {
    const harness = makeHarness('main-1');
    harness.sessionManager.focusSession('main-1');
    const side = attachSide(harness);
    attachSide(harness, 'side-2');
    side.sent.length = 0;

    harness.host.onMessage({ type: 'sideFocus', sessionId: 'side-1' });
    harness.host.onMessage({ type: 'sideFocus', sessionId: 'missing' }, 'side');
    assert.strictEqual(side.sent.some(m => m.type === 'focus'), false);
    harness.host.onMessage({ type: 'sideFocus', sessionId: 'side-1' }, 'side');
    await waitFor(() => side.sent.some(m => m.type === 'focus'), 'the active Side switch');
    assert.strictEqual(harness.sessionManager.getActiveSessionId(), 'main-1');

    harness.host.onMessage({ type: 'sideClose', sessionId: 'side-2' });
    harness.host.onMessage({ type: 'sideClose', sessionId: 'side-2' }, 'side');
    await waitFor(() => sideStub(harness).closed.length === 1, 'the Side close request');
    assert.deepStrictEqual(sideStub(harness).closed, ['side-2']);
  });

  test('Side agent connection follows the active tab and closed active bindings are cleared', () => {
    const harness = makeHarness('main-1');
    harness.sessionManager.focusSession('main-1');
    const side = attachSide(harness);
    Object.assign(harness.sessionManager, {
      isAgentConnected: (agentName: string) => agentName === harness.agentName,
    });
    attachSide(harness, 'side-2', 'Other Agent');
    harness.sessionManager.emit('agent-connected', 'Other Agent');
    assert.strictEqual(lastBoot(side).agentConnected, false);
    let change = side.sent.filter(m => m.type === 'sessionsChanged').pop();
    assert.ok(change?.type === 'sessionsChanged');
    assert.strictEqual(change.agentConnected, false);

    harness.host.onMessage({ type: 'sideFocus', sessionId: 'side-1' }, 'side');
    const focus = side.sent.filter(m => m.type === 'focus').pop();
    assert.ok(focus?.type === 'focus');
    assert.strictEqual(focus.agentConnected, true);
    change = side.sent.filter(m => m.type === 'sessionsChanged').pop();
    assert.ok(change?.type === 'sessionsChanged');
    assert.strictEqual(change.agentConnected, true);

    harness.sessionManager.emit('session-closed', 'side-1', harness.agentName, 'user');
    assert.strictEqual(harness.host.activeSideSessionId(), null);
    assert.strictEqual(harness.sessionManager.getActiveSessionId(), 'main-1');
  });

  test('permission and form answers cannot settle another session\'s request', async () => {
    const permission = new PermissionBridge();
    const elicitation = new ElicitationBridge();
    const harness = makeHarness('main-1', 'Claude Code', undefined, new StubPrefs(), { permission, elicitation });
    attachSide(harness);
    const fallback = (async () => { throw new Error('dialog must not open'); }) as never;

    const mainPermission = permission.request({
      sessionId: 'main-1', toolCall: { toolCallId: 'main-tool', title: 'Main permission' },
    } as never, fallback);
    const sidePermission = permission.request({
      sessionId: 'side-1', toolCall: { toolCallId: 'side-tool', title: 'Side permission' },
    } as never, fallback);
    const mainForm = elicitation.request(askSide('main-1'), fallback);
    const sideForm = elicitation.request(askSide('side-1'), fallback);

    harness.host.onMessage({ type: 'permissionAnswer', sessionId: 'main-1', promptId: 'side-1:2', optionId: 'allow' });
    harness.host.onMessage({
      type: 'elicitationAnswer', sessionId: 'main-1', promptId: 'side-1:2', action: 'accept', content: { answer: 'wrong' },
    });
    assert.strictEqual(permission.pendingCount, 2);
    assert.strictEqual(elicitation.pendingCount, 2);

    attachSide(harness, 'side-2');
    harness.host.onMessage({ type: 'permissionAnswer', sessionId: 'side-1', promptId: 'side-1:2', optionId: 'allow' }, 'side');
    harness.host.onMessage({
      type: 'elicitationAnswer', sessionId: 'side-1', promptId: 'side-1:2', action: 'accept', content: { answer: 'stale' },
    }, 'side');
    assert.strictEqual(permission.pendingCount, 2);
    assert.strictEqual(elicitation.pendingCount, 2);

    harness.host.onMessage({ type: 'sideFocus', sessionId: 'side-1' }, 'side');
    harness.host.onMessage({ type: 'permissionAnswer', sessionId: 'side-1', promptId: 'side-1:2', optionId: 'allow' }, 'side');
    harness.host.onMessage({
      type: 'elicitationAnswer', sessionId: 'side-1', promptId: 'side-1:2', action: 'accept', content: { answer: 'right' },
    }, 'side');
    assert.deepStrictEqual((await sidePermission).outcome, { outcome: 'selected', optionId: 'allow' });
    assert.deepStrictEqual(await sideForm, { action: 'accept', content: { answer: 'right' } });
    assert.strictEqual(permission.pendingCount, 1);
    assert.strictEqual(elicitation.pendingCount, 1);

    permission.cancelSession('main-1');
    elicitation.cancelSession('main-1');
    assert.deepStrictEqual((await mainPermission).outcome, { outcome: 'cancelled' });
    assert.deepStrictEqual(await mainForm, { action: 'cancel' });
  });

  test('Side metadata is targeted and a background notification activates its Side, not main', async () => {
    const permission = new PermissionBridge();
    const harness = makeHarness('main-1', 'Claude Code', undefined, new StubPrefs(), { permission });
    harness.sessionManager.focusSession('main-1');
    const side = attachSide(harness);
    Object.assign(harness.sessionManager, { setMode: () => Promise.resolve() });
    harness.surface.sent.length = 0;
    side.sent.length = 0;

    harness.host.onMessage({ type: 'setMode', sessionId: 'side-1', modeId: 'side-mode' }, 'side');
    await waitFor(() => side.sent.some(m => m.type === 'meta'), 'the Side meta reply');
    assert.strictEqual(harness.surface.sent.some(m => m.type === 'meta'), false);
    assert.strictEqual(side.sent.some(m => m.type === 'meta' && m.sessionId === 'side-1'), true);

    attachSide(harness, 'side-2');
    harness.host.onMessage({ type: 'sideFocus', sessionId: 'side-1' }, 'side');
    side.sent.length = 0;
    side.visibleFlag = false;
    const revealsBefore = side.reveals;
    const response = permission.request({
      sessionId: 'side-2', toolCall: { toolCallId: 'side-tool-2', title: 'Background Side permission' },
    } as never, (async () => { throw new Error('dialog must not open'); }) as never);
    assert.strictEqual(harness.notices.shown.length, 1);
    assert.strictEqual(side.reveals, revealsBefore, 'a background request does not reveal or steal the tab');
    assert.strictEqual(side.sent.some(m => m.type === 'focus' && m.summary?.sessionId === 'side-2'), false);
    await harness.notices.click(0);
    assert.ok(side.reveals > revealsBefore);
    assert.strictEqual(side.sent.some(m => m.type === 'focus' && m.summary?.sessionId === 'side-2'), true);
    assert.strictEqual(harness.sessionManager.getActiveSessionId(), 'main-1');
    permission.cancelSession('side-2');
    await response;
  });

  test('Main and Side persist four toolbar states independently and share only global changes', () => {
    const memento = new FakeMemento();
    const harness = makeHarness('main-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    registerFakeSession(harness.sessionManager, 'main-2', harness.agentName);
    const editor = new RecordingSurface('editor');
    harness.host.attachSurface(editor, { agentName: harness.agentName, sessionId: 'main-1' });
    const side = attachSide(harness, 'side-1');
    attachSide(harness, 'side-2');
    harness.surface.sent.length = 0;
    editor.sent.length = 0;
    side.sent.length = 0;

    harness.host.onMessage({
      type: 'setUiPref',
      outlineMode: 'sidebar', outlineWidth: 320, tabOrder: ['main-2', 'main-1'],
      timesBySession: { 'main-1': true, 'main-2': false }, timesDefault: true,
      tailBySession: { 'main-1': false, 'main-2': true }, tailDefault: false,
      outlineOpenBySession: { 'main-1': true, 'main-2': false }, outlineOpenDefault: true,
      autoExpandBySession: { 'main-1': false, 'main-2': true }, autoExpandDefault: false,
      autoExpandKinds: ['thought', 'tool'],
    }, 'view');
    assert.strictEqual(prefMessages(harness.surface).length, 1);
    assert.strictEqual(prefMessages(editor).length, 1);
    assert.strictEqual(prefMessages(side).length, 1, 'the initial global kinds value reaches Side too');
    assert.deepStrictEqual(latestPrefs(side).autoExpandKinds, ['thought', 'tool']);
    assert.strictEqual(latestPrefs(side).tailBySession, undefined);

    harness.surface.sent.length = 0;
    editor.sent.length = 0;
    side.sent.length = 0;
    harness.host.onMessage({
      type: 'setUiPref',
      outlineMode: 'popup', outlineWidth: 280,
      timesBySession: { 'side-1': false, 'side-2': true }, timesDefault: false,
      tailBySession: { 'side-1': true, 'side-2': false }, tailDefault: true,
      outlineOpenBySession: { 'side-1': false, 'side-2': true }, outlineOpenDefault: false,
      autoExpandBySession: { 'side-1': true, 'side-2': false }, autoExpandDefault: true,
      autoExpandKinds: ['thought', 'tool'],
    }, 'side');

    assert.strictEqual(prefMessages(harness.surface).length, 0, 'unchanged global kinds do not echo to Main');
    assert.strictEqual(prefMessages(editor).length, 0);
    assert.strictEqual(prefMessages(side).length, 1);
    assert.deepStrictEqual(memento.get('vac.outlinePrefs.v1'), {
      outlineMode: 'sidebar', outlineWidth: 320, tabOrder: ['main-2', 'main-1'],
      timesBySession: { 'main-1': true, 'main-2': false }, timesDefault: true,
      tailBySession: { 'main-1': false, 'main-2': true }, tailDefault: false,
      outlineOpenBySession: { 'main-1': true, 'main-2': false }, outlineOpenDefault: true,
      autoExpandBySession: { 'main-1': false, 'main-2': true }, autoExpandDefault: false,
      autoExpandKinds: ['thought', 'tool'],
      shortcuts: defaultShortcutMap(),
    });
    assert.deepStrictEqual(memento.get('vac.sideUiPrefs.v1'), {
      outlineMode: 'popup', outlineWidth: 280,
      timesBySession: { 'side-1': false, 'side-2': true }, timesDefault: false,
      tailBySession: { 'side-1': true, 'side-2': false }, tailDefault: true,
      outlineOpenBySession: { 'side-1': false, 'side-2': true }, outlineOpenDefault: false,
      autoExpandBySession: { 'side-1': true, 'side-2': false }, autoExpandDefault: true,
    });

    harness.surface.sent.length = 0;
    editor.sent.length = 0;
    side.sent.length = 0;
    harness.host.onMessage({
      type: 'setUiPref',
      autoExpandBySession: { 'side-1': true, 'side-2': false }, autoExpandDefault: true,
      autoExpandKinds: ['thought', 'tool'],
    }, 'side');
    assert.strictEqual(prefMessages(harness.surface).length, 0);
    assert.strictEqual(prefMessages(editor).length, 0);
    assert.strictEqual(prefMessages(side).length, 0, 'an identical projection is a no-op');

    harness.surface.sent.length = 0;
    editor.sent.length = 0;
    side.sent.length = 0;
    harness.host.onMessage({
      type: 'setUiPref',
      autoExpandBySession: { 'side-1': true, 'side-2': false }, autoExpandDefault: true,
      autoExpandKinds: ['tool'],
    }, 'side');

    assert.strictEqual(prefMessages(harness.surface).length, 1);
    assert.strictEqual(prefMessages(editor).length, 1);
    assert.strictEqual(prefMessages(side).length, 1);
    for (const surface of [harness.surface, editor]) {
      const prefs = latestPrefs(surface);
      assert.deepStrictEqual(prefs.autoExpandKinds, ['tool']);
      assert.deepStrictEqual(prefs.tailBySession, { 'main-1': false, 'main-2': true });
      assert.deepStrictEqual(prefs.tabOrder, ['main-2', 'main-1']);
    }
    const sidePrefs = latestPrefs(side);
    assert.deepStrictEqual(sidePrefs.autoExpandKinds, ['tool']);
    assert.deepStrictEqual(sidePrefs.tailBySession, { 'side-1': true, 'side-2': false });
    assert.strictEqual('tabOrder' in sidePrefs, false);
    assert.deepStrictEqual((memento.get<Record<string, unknown>>('vac.outlinePrefs.v1'))?.autoExpandKinds, ['tool']);
    assert.strictEqual((memento.get<Record<string, unknown>>('vac.sideUiPrefs.v1'))?.autoExpandKinds, undefined);
  });

  test('editor and view still synchronize Main preferences without notifying Side', () => {
    const memento = new FakeMemento();
    const harness = makeHarness('main-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    const editor = new RecordingSurface('editor');
    harness.host.attachSurface(editor, { agentName: harness.agentName, sessionId: 'main-1' });
    const side = attachSide(harness);
    harness.surface.sent.length = 0;
    editor.sent.length = 0;
    side.sent.length = 0;

    harness.host.onMessage({
      type: 'setUiPref', tailBySession: { 'main-1': false }, tailDefault: false,
    }, 'editor');
    assert.strictEqual(prefMessages(harness.surface).length, 1);
    assert.strictEqual(prefMessages(editor).length, 1);
    assert.strictEqual(prefMessages(side).length, 0);
    assert.deepStrictEqual(latestPrefs(harness.surface).tailBySession, { 'main-1': false });

    harness.surface.sent.length = 0;
    editor.sent.length = 0;
    harness.host.onMessage({
      type: 'setUiPref', timesBySession: { 'main-1': true }, timesDefault: true,
    }, 'view');
    assert.strictEqual(prefMessages(harness.surface).length, 1);
    assert.strictEqual(prefMessages(editor).length, 1);
    assert.strictEqual(prefMessages(side).length, 0);
    assert.deepStrictEqual(latestPrefs(editor).timesBySession, { 'main-1': true });
    assert.strictEqual(memento.get('vac.sideUiPrefs.v1'), undefined);
  });

  test('boot projects the target scope and reload keeps Side defaults but drops orphan session maps', () => {
    const memento = new FakeMemento();
    const mainPrefs = {
      outlineMode: 'sidebar', outlineWidth: 310, tabOrder: ['main-1'],
      timesBySession: { 'main-1': true }, timesDefault: true,
      tailBySession: { 'main-1': false }, tailDefault: false,
      outlineOpenBySession: { 'main-1': true }, outlineOpenDefault: true,
      autoExpandBySession: { 'main-1': true }, autoExpandDefault: true,
      flatTools: true,
    };
    void memento.update('vac.outlinePrefs.v1', mainPrefs);
    void memento.update('vac.sideUiPrefs.v1', {
      outlineMode: 'popup', outlineWidth: 275,
      timesBySession: { orphan: true }, timesDefault: false,
      tailBySession: { orphan: false }, tailDefault: true,
      outlineOpenBySession: { orphan: true }, outlineOpenDefault: false,
      autoExpandBySession: { orphan: true }, autoExpandDefault: true,
    });
    const harness = makeHarness('main-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    const editor = new RecordingSurface('editor');
    harness.host.attachSurface(editor, { agentName: harness.agentName, sessionId: 'main-1' });
    const side = attachSide(harness);

    assert.deepStrictEqual(memento.get('vac.outlinePrefs.v1'), mainPrefs);
    assert.deepStrictEqual(memento.get('vac.sideUiPrefs.v1'), {
      outlineMode: 'popup', outlineWidth: 275,
      timesBySession: {}, timesDefault: false,
      tailBySession: {}, tailDefault: true,
      outlineOpenBySession: {}, outlineOpenDefault: false,
      autoExpandBySession: {}, autoExpandDefault: true,
    });

    for (const surface of [harness.surface, editor, side]) {
      surface.sent.length = 0;
      harness.host.onMessage({ type: 'ready' }, surface.key);
      const sequence = surface.sent.filter(m => m.type === 'uiPrefs' || m.type === 'boot');
      assert.deepStrictEqual(sequence.slice(-2).map(m => m.type), ['uiPrefs', 'boot']);
    }
    assert.deepStrictEqual(latestPrefs(harness.surface).tailBySession, { 'main-1': false });
    assert.deepStrictEqual(latestPrefs(editor).tailBySession, { 'main-1': false });
    const sidePrefs = latestPrefs(side);
    assert.strictEqual(sidePrefs.outlineWidth, 275);
    assert.strictEqual(sidePrefs.flatTools, true);
    assert.deepStrictEqual(sidePrefs.timesBySession, {});
    assert.deepStrictEqual(sidePrefs.tailBySession, {});
    assert.deepStrictEqual(sidePrefs.outlineOpenBySession, {});
    assert.deepStrictEqual(sidePrefs.autoExpandBySession, {});
    assert.strictEqual('tabOrder' in sidePrefs, false);
  });

  test('Side boot uses built-in scoped defaults when only legacy Main preferences exist', () => {
    const memento = new FakeMemento();
    void memento.update('vac.outlinePrefs.v1', {
      outlineMode: 'sidebar', outlineWidth: 333, tailDefault: false,
      tailBySession: { 'main-1': false }, flatTools: true,
    });
    const harness = makeHarness('main-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    const side = attachSide(harness);
    side.sent.length = 0;
    harness.host.onMessage({ type: 'ready' }, 'side');

    const prefs = latestPrefs(side);
    assert.strictEqual(prefs.outlineMode, 'popup');
    assert.strictEqual(prefs.outlineWidth, 240);
    assert.strictEqual(prefs.flatTools, true);
    assert.strictEqual(prefs.tailDefault, undefined);
    assert.strictEqual(prefs.tailBySession, undefined);
    assert.strictEqual('tabOrder' in prefs, false);
  });

  test('Reset restores complete Main, Side and shared defaults on every surface', () => {
    const memento = new FakeMemento();
    const harness = makeHarness('main-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    const editor = new RecordingSurface('editor');
    harness.host.attachSurface(editor, { agentName: harness.agentName, sessionId: 'main-1' });
    const side = attachSide(harness);
    harness.host.onMessage({
      type: 'setUiPref', outlineMode: 'sidebar', outlineWidth: 400,
      tailBySession: { 'main-1': false }, tailDefault: false,
      flatTools: true, markdownStyle: 'github', recentDirectoryLimit: 20,
    }, 'view');
    harness.host.onMessage({
      type: 'setUiPref', outlineMode: 'sidebar', outlineWidth: 350,
      timesBySession: { 'side-1': true }, timesDefault: true,
      autoExpandBySession: { 'side-1': true }, autoExpandDefault: true,
    }, 'side');
    harness.host.onMessage({ type: 'setSetting', key: 'panel.historyDisplayLimit', value: 55 }, 'view');

    harness.host.onMessage({ type: 'settingAction', action: 'resetPanelPrefs' }, 'view');
    const defaults = {
      outlineMode: 'popup', outlineWidth: 240, tabOrder: [],
      timesBySession: {}, timesDefault: false,
      tailBySession: {}, tailDefault: true,
      outlineOpenBySession: {}, outlineOpenDefault: false, outlineTab: 'messages',
      autoExpandBySession: {}, autoExpandDefault: false,
      autoExpandKinds: ['thought', 'tool'], autoExpandToolHeight: 360, autoExpandThoughtHeight: 240,
      flatTools: false, composerMaxWidth: 720, inputMaxHeight: 320, sendKey: 'enter',
      defaultModelByAgent: {}, defaultEffortByAgent: {}, recentDirectoryLimit: 8, historyDisplayLimit: 0,
      markdownStyle: 'editor',
      shortcuts: defaultShortcutMap(),
    };
    const expected = { type: 'uiPrefs', ...defaults };
    assert.deepStrictEqual(latestPrefs(harness.surface), expected);
    assert.deepStrictEqual(latestPrefs(editor), expected);
    assert.deepStrictEqual({ ...latestPrefs(side), tabOrder: [] }, expected);
    assert.deepStrictEqual(memento.get('vac.outlinePrefs.v1'), defaults);
    const sideStored = memento.get<Record<string, unknown>>('vac.sideUiPrefs.v1');
    assert.deepStrictEqual(sideStored?.timesBySession, {});
    assert.deepStrictEqual(sideStored?.tailBySession, {});
    assert.deepStrictEqual(sideStored?.outlineOpenBySession, {});
    assert.deepStrictEqual(sideStored?.autoExpandBySession, {});
    assert.strictEqual(sideStored?.outlineMode, 'popup');
    assert.strictEqual(sideStored?.outlineWidth, 240);
    assert.strictEqual(sideStored?.flatTools, undefined);
    assert.strictEqual(sideStored?.tabOrder, undefined);
  });

  test('releasing a Side removes only its per-session UI preferences', () => {
    const memento = new FakeMemento();
    const mainPrefs = {
      outlineMode: 'popup', outlineWidth: 240,
      tabOrder: ['main-1', 'side-1'],
      timesBySession: { 'main-1': true, 'side-1': false },
      tailBySession: { 'main-1': true, 'side-1': false },
      outlineOpenBySession: { 'main-1': true, 'side-1': false },
      autoExpandBySession: { 'main-1': true, 'side-1': false },
    };
    void memento.update('vac.outlinePrefs.v1', mainPrefs);
    const harness = makeHarness('main-1', 'Claude Code', undefined, new StubPrefs(), {}, memento);
    const side = attachSide(harness, 'side-1');
    attachSide(harness, 'side-2');
    harness.host.onMessage({
      type: 'setUiPref', outlineMode: 'sidebar', outlineWidth: 300,
      timesBySession: { 'side-1': true, 'side-2': false }, timesDefault: true,
      tailBySession: { 'side-1': false, 'side-2': true }, tailDefault: false,
      outlineOpenBySession: { 'side-1': true, 'side-2': false }, outlineOpenDefault: true,
      autoExpandBySession: { 'side-1': false, 'side-2': true }, autoExpandDefault: false,
    }, 'side');
    harness.surface.sent.length = 0;
    side.sent.length = 0;

    harness.host.releaseSideSession('side-1');
    assert.deepStrictEqual(memento.get('vac.outlinePrefs.v1'), mainPrefs);
    assert.deepStrictEqual(memento.get('vac.sideUiPrefs.v1'), {
      outlineMode: 'sidebar', outlineWidth: 300,
      timesBySession: { 'side-2': false }, timesDefault: true,
      tailBySession: { 'side-2': true }, tailDefault: false,
      outlineOpenBySession: { 'side-2': false }, outlineOpenDefault: true,
      autoExpandBySession: { 'side-2': true }, autoExpandDefault: false,
    });
    assert.strictEqual(prefMessages(harness.surface).length, 0);
    assert.strictEqual(prefMessages(side).length, 1);
  });
});

// --- CUSTOM- 2026-11-08 review fixes -------------------------------------

import { AgentTreeItem, InfoTreeItem, SessionTreeProvider } from '../ui/SessionTreeProvider';

suite('session tree: a persistently failing session/list is not retried', () => {
  test('renders the error leaf, refetches only on invalidate, and unsubscribes on dispose', async () => {
    let listings = 0;
    const offs: string[] = [];
    const fake = {
      getCachedCapabilities: () => ({ list: true, load: false, resume: false }),
      listSessions: async () => {
        listings++;
        throw new Error('boom');
      },
      on: () => fake,
      off: (event: string) => { offs.push(event); return fake; },
      getActiveSessionId: () => null,
      isAgentConnected: () => true,
    };
    const provider = new SessionTreeProvider(
      fake as unknown as SessionManager, null, () => undefined,
    );
    const agent = new AgentTreeItem('Claude Code', true, vscode.TreeItemCollapsibleState.None);
    try {
      const loading = await provider.getChildren(agent);
      assert.strictEqual((loading[0] as InfoTreeItem).kind, 'loading');
      for (let i = 0; i < 100 && listings === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.strictEqual(listings, 1);

      const failed = await provider.getChildren(agent);
      assert.strictEqual(failed.length, 1);
      assert.strictEqual((failed[0] as InfoTreeItem).kind, 'error',
        'the failed row must be the error leaf, not a fresh loading leaf');
      // Repeated tree queries (VS Code asks often) must not retry the agent call.
      await provider.getChildren(agent);
      await provider.getChildren(agent);
      assert.strictEqual(listings, 1, 'no retry loop from getChildren alone');

      provider.invalidate('Claude Code');
      await provider.getChildren(agent);
      for (let i = 0; i < 100 && listings === 1; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.strictEqual(listings, 2, 'explicit invalidate/Retry refetches exactly once');
    } finally {
      provider.dispose();
    }
    assert.deepStrictEqual(offs.slice().sort(),
      ['active-session-changed', 'agent-connected', 'agent-disconnected', 'session-info-changed'],
      'every manager subscription is released on dispose');
  });
});

suite('chat panel: every main surface tracks the shared focus', () => {
  test('a focus change reaches BOTH main surfaces, so meta is delivered to both', () => {
    const harness = makeHarness('s1');
    registerFakeSession(harness.sessionManager, 's2', harness.agentName);
    const editor = new RecordingSurface('editor');
    harness.host.attachSurface(editor, { agentName: harness.agentName, sessionId: 's1' });
    harness.surface.sent.length = 0;
    editor.sent.length = 0;

    // The switch originates on the editor surface, so (with the old code) only
    // `lastActive` = editor would have had its recorded session updated.
    harness.host.onMessage({ type: 'focusSession', sessionId: 's2' }, 'editor');
    harness.surface.sent.length = 0;
    editor.sent.length = 0;

    harness.handler.handleUpdate({
      sessionId: 's2',
      update: { sessionUpdate: 'usage_update', used: 42, size: 100 },
    } as never);

    const metas = (surface: RecordingSurface) => surface.sent.filter(message =>
      message.type === 'meta' && (message as { sessionId?: string }).sessionId === 's2',
    ) as Array<{ meta?: { usage?: { used?: number } } }>;
    assert.strictEqual(metas(harness.surface).length, 1,
      'the sidebar surface still records s2 as what it shows');
    assert.strictEqual(metas(harness.surface)[0].meta?.usage?.used, 42);
    assert.strictEqual(metas(editor).length, 1,
      'the editor surface records s2 too');
  });
});

suite('chat panel: sub-agent child meta does not corrupt the parent', () => {
  function announce(harness: Harness, child: string): void {
    harness.handler.handleUpdate({
      sessionId: harness.sessionId,
      update: {
        sessionUpdate: 'subagent_update', sessionId: child,
        title: 'story_editor', capabilities: { cancel: {} }, state: { state: 'running' },
      },
    } as never);
    // Flush the card, then isolate the following assertions from it.
    harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: harness.sessionId });
    harness.surface.sent.length = 0;
  }

  test('child usage / title / plan are dropped; child tools still render in the parent', () => {
    const harness = makeHarness('parent');
    announce(harness, 'child-1');

    harness.handler.handleUpdate({
      sessionId: 'child-1',
      update: { sessionUpdate: 'usage_update', used: 999, size: 1000 },
    } as never);
    harness.handler.handleUpdate({
      sessionId: 'child-1',
      update: { sessionUpdate: 'session_info_update', title: 'Child renamed the parent' },
    } as never);
    harness.handler.handleUpdate({
      sessionId: 'child-1',
      update: { sessionUpdate: 'plan', entries: [{ content: 'child plan', status: 'in_progress', priority: 'high' }] },
    } as never);

    harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: 'parent' });
    const focus = harness.surface.sent.filter(m => m.type === 'focus').pop() as
      | { meta?: { usage?: unknown }; summary?: { title?: unknown } }
      | undefined;
    assert.ok(focus);
    assert.strictEqual(focus.meta?.usage ?? null, null,
      "the child's usage_update must not overwrite the parent's context ring");
    assert.notStrictEqual(focus.summary?.title, 'Child renamed the parent',
      "the child's session_info_update must not rename the parent");
    const planAppends = harness.surface.sent.filter(m => m.type === 'append')
      .flatMap(m => (m as { entries: Array<{ kind?: string }> }).entries)
      .filter(entry => entry.kind === 'plan');
    assert.strictEqual(planAppends.length, 0,
      "the child's plan must not replace the parent's plan card");

    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 'child-1',
      update: {
        sessionUpdate: 'tool_call', toolCallId: 'child-tool', title: 'Read x',
        kind: 'read', status: 'in_progress', content: [],
      },
    } as never);
    const state = settle(harness, harness.agentName, 'parent');
    const tool = state.entries.find(entry =>
      entry.kind === 'tool' && (entry as { toolCallId?: string }).toolCallId === 'child-tool');
    assert.ok(tool, "the child's tool call still renders in the parent transcript");
  });
});

suite('chat panel: interrupted tools are closed at turn end', () => {
  test('a Task left in_progress stops containing tool calls from the next turn', async () => {
    const harness = makeHarness('s1');
    harness.handler.handleUpdate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call', toolCallId: 'task', title: 'Task explore',
        kind: 'execute', status: 'in_progress', content: [], rawInput: { subagent_type: 'Explore' },
      },
    } as never);

    // The seeded session has no connection, so this prompt fails — which still runs
    // handleSendPrompt's `finally` (the one and only finalizeTurn call site).
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's1', text: 'go' });
    await new Promise(resolve => setTimeout(resolve, 30));
    // Let more than MIN_CONTAINMENT_MS (50ms) elapse after the turn ended.
    await new Promise(resolve => setTimeout(resolve, 70));

    harness.surface.sent.length = 0;
    harness.handler.handleUpdate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call', toolCallId: 'later', title: 'Read x',
        kind: 'read', status: 'in_progress', content: [],
      },
    } as never);
    const state = settle(harness, harness.agentName, 's1');
    const later = state.entries.find(entry =>
      entry.kind === 'tool' && (entry as { toolCallId?: string }).toolCallId === 'later') as
      { toolView?: { parentId?: string } } | undefined;
    assert.ok(later);
    assert.strictEqual(later.toolView?.parentId, undefined,
      'the cancelled Task interval must be closed, so it cannot swallow the next turn');
  });

  test('a thought followed directly by a tool call is finalized (no eternal "Thinking…")', () => {
    const harness = makeHarness('s1');
    harness.handler.handleUpdate({
      sessionId: 's1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reasoning…' } },
    } as never);
    harness.handler.handleUpdate({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read x',
        kind: 'read', status: 'in_progress', content: [],
      },
    } as never);
    const state = settle(harness, harness.agentName, 's1');
    const thought = state.entries.find(entry => entry.kind === 'thought') as
      { streaming?: boolean } | undefined;
    assert.ok(thought);
    assert.strictEqual(thought.streaming, false,
      'the thought must not keep streaming while its elapsed time absorbs the tool run');
  });
});

suite('chat panel: history replace is ordered around a successful open', () => {
  class LifecycleManager extends SessionManager {
    readonly events: string[] = [];
    running = false;
    failOpen = false;
    override isTurnInFlight(): boolean { return this.running; }
    override async openExistingSession(): Promise<'live' | 'load' | 'resume'> {
      this.events.push('open');
      if (this.failOpen) { throw new Error('load failed'); }
      return 'live';
    }
    override async closeSession(_agentName: string, sessionId: string): Promise<void> {
      this.events.push(`close:${sessionId}`);
    }
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  function newManager(): LifecycleManager {
    const handler = new SessionUpdateHandler();
    return new LifecycleManager(new AgentManager(), new ConnectionManager(handler), handler);
  }

  test('a running session is never replaced (its turn survives)', async () => {
    const manager = newManager();
    manager.running = true;
    const harness = makeHarness('dummy-session', 'Claude Code', () => manager);
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'next' });
    await until(() => manager.events.includes('open'));
    assert.deepStrictEqual(manager.events, ['open'],
      'the running tab is left alone; the pick opens alongside it');
  });

  test('the old tab closes only after the new session opened', async () => {
    const manager = newManager();
    const harness = makeHarness('dummy-session', 'Claude Code', () => manager);
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'next' });
    await until(() => manager.events.length >= 2);
    assert.deepStrictEqual(manager.events, ['open', 'close:dummy-session']);
  });

  test('a failed open leaves the previous session in place', async () => {
    const manager = newManager();
    manager.failOpen = true;
    const harness = makeHarness('dummy-session', 'Claude Code', () => manager);
    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'next' });
    await until(() => manager.events.includes('open'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepStrictEqual(manager.events, ['open'],
      'no close when the load threw');
  });
});

suite('chat panel: attachments survive a failed send', () => {
  test('a prompt that never reached the agent keeps its image chip', async () => {
    const harness = makeHarness('s1');
    harness.host.onMessage({
      type: 'attachImage', sessionId: 's1', id: 'img-1', name: 'shot.png',
      mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA',
    }, 'view');
    harness.surface.sent.length = 0;

    // The seeded session has no connection, so the prompt fails.
    harness.host.onMessage({ type: 'sendPrompt', sessionId: 's1', text: 'look' });
    await new Promise(resolve => setTimeout(resolve, 30));

    harness.host.onFocusChanged({ agentName: harness.agentName, sessionId: 's1' });
    const focus = harness.surface.sent.filter(m => m.type === 'focus').pop() as
      | { meta?: { attachments?: Array<{ path?: string }> } }
      | undefined;
    assert.ok(focus);
    assert.deepStrictEqual((focus.meta?.attachments ?? []).map(a => a.path), ['img-1'],
      'the image must still be pending, not silently consumed by a failed send');
    assert.strictEqual(harness.surface.sent.some(m => m.type === 'attachments'), false,
      'no empty-attachments broadcast on failure');
  });
});

suite('chat panel: a tab switch during session/load is honored immediately', () => {
  class LoadingManager extends SessionManager {
    loadingId: string | null = null;
    override isLoading(sessionId: string): boolean { return this.loadingId === sessionId; }
  }

  function harnessWithLoading(): { harness: Harness; manager: LoadingManager } {
    const handler = new SessionUpdateHandler();
    const manager = new LoadingManager(new AgentManager(), new ConnectionManager(handler), handler);
    const harness = makeHarness('A', 'Claude Code', () => manager);
    registerFakeSession(manager, 'B', 'Claude Code');
    return { harness, manager };
  }

  function appendsFor(harness: Harness, sessionId: string): ExtToChatMessage[] {
    return harness.surface.sent.filter(m =>
      m.type === 'append' && (m as { sessionId?: string }).sessionId === sessionId);
  }

  test('replay records are not streamed while loading, and a switch is not delayed by them', () => {
    const { harness, manager } = harnessWithLoading();
    harness.surface.sent.length = 0;
    manager.loadingId = 'A';
    harness.sessionManager.emit('session-load-start', 'A', harness.agentName);
    harness.handler.handleUpdate({
      sessionId: 'A',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'replayed hello' } },
    } as never);
    assert.strictEqual(appendsFor(harness, 'A').length, 0,
      'the loading overlay covers the replay; per-entry appends would saturate the webview queue');

    // The user clicks tab B mid-load. The host must answer now, not after load end.
    harness.host.onMessage({ type: 'focusSession', sessionId: 'B' }, 'view');
    const focus = harness.surface.sent.filter(m => m.type === 'focus').pop() as
      | { summary?: { sessionId?: string } } | undefined;
    assert.strictEqual(focus?.summary?.sessionId, 'B', 'the focus reply is immediate');

    const mark = harness.surface.sent.length;
    manager.loadingId = null;
    harness.sessionManager.emit('session-load-end', 'A', harness.agentName);
    const afterLoad = harness.surface.sent.slice(mark);
    assert.strictEqual(
      afterLoad.some(m => m.type === 'focus' && (m as { summary?: { sessionId?: string } }).summary?.sessionId === 'A'),
      false,
      'a completed load must not steal focus from the tab the user selected',
    );
    // The records are not lost: switching back hydrates the full transcript.
    harness.host.onMessage({ type: 'focusSession', sessionId: 'A' }, 'view');
    const back = harness.surface.sent.filter(m => m.type === 'focus').pop() as
      | { summary?: { sessionId?: string }; snapshot?: { entries: Array<{ text?: string }> } } | undefined;
    assert.strictEqual(back?.summary?.sessionId, 'A');
    assert.ok((back?.snapshot?.entries ?? []).some(entry => (entry.text ?? '').includes('replayed hello')),
      'the replay was stored even though it was not streamed');
  });

  test('a load that is still the focused session gets one fresh snapshot at the end', () => {
    const { harness, manager } = harnessWithLoading();
    harness.surface.sent.length = 0;
    manager.loadingId = 'A';
    harness.sessionManager.emit('session-load-start', 'A', harness.agentName);
    harness.handler.handleUpdate({
      sessionId: 'A',
      update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'still here' } },
    } as never);
    manager.loadingId = null;
    harness.sessionManager.emit('session-load-end', 'A', harness.agentName);

    const focus = harness.surface.sent.filter(m => m.type === 'focus').pop() as
      | { summary?: { sessionId?: string; loading?: boolean }; snapshot?: { entries: Array<{ text?: string }> } }
      | undefined;
    assert.strictEqual(focus?.summary?.sessionId, 'A');
    assert.strictEqual(focus?.summary?.loading, false);
    assert.ok((focus?.snapshot?.entries ?? []).some(entry => (entry.text ?? '').includes('still here')),
      'the panel is handed the finished transcript instead of the empty pre-load snapshot');
  });
});

suite('chat panel: additionalDirectories ride along on a history reopen', () => {
  class DirRecorder extends SessionManager {
    readonly opened: Array<{ agentName: string; sessionId: string; additionalDirectories?: string[] }> = [];
    override async openExistingSession(
      agentName: string,
      sessionId: string,
      opts: { cwd?: string; title?: string; additionalDirectories?: string[] } = {},
    ): Promise<'live' | 'load' | 'resume'> {
      this.opened.push({ agentName, sessionId, additionalDirectories: opts.additionalDirectories });
      return 'live';
    }
  }

  test('persisted extra roots are passed back to session/load', async () => {
    const handler = new SessionUpdateHandler();
    const manager = new DirRecorder(new AgentManager(), new ConnectionManager(handler), handler);
    const harness = makeHarness('dummy-session', 'Claude Code', () => manager);
    const memento = new FakeMemento();
    const store = new SessionHistoryStore(memento as unknown as vscode.Memento);
    manager.setHistoryStore(store);
    store.upsertNew('Claude Code', '/workspace', 'old-session');
    store.setAdditionalDirectories('Claude Code', 'old-session', ['D:\\other-root']);

    harness.host.onMessage({ type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'old-session' });
    for (let i = 0; i < 100 && manager.opened.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.deepStrictEqual(manager.opened, [{
      agentName: 'Claude Code', sessionId: 'old-session', additionalDirectories: ['D:\\other-root'],
    }]);

    // And the value survives a reload of the workspace state.
    const reloaded = new SessionHistoryStore(memento as unknown as vscode.Memento);
    assert.deepStrictEqual(reloaded.get('Claude Code', 'old-session')?.additionalDirectories,
      ['D:\\other-root']);
  });
});

suite('chat panel: Alt+T reopens the last closed session', () => {
  class RecordingManager extends SessionManager {
    readonly opened: Array<{ sessionId: string; cwd?: string; title?: string }> = [];
    override async openExistingSession(
      _agentName: string,
      sessionId: string,
      opts: { cwd?: string; title?: string } = {},
    ): Promise<'live' | 'load' | 'resume'> {
      this.opened.push({ sessionId, cwd: opts.cwd, ...(opts.title ? { title: opts.title } : {}) });
      return 'live';
    }
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  function harnessWithRecorder(): { harness: Harness; manager: RecordingManager } {
    let manager!: RecordingManager;
    const harness = makeHarness('dummy-session', 'Claude Code', handler => {
      manager = new RecordingManager(new AgentManager(), new ConnectionManager(handler), handler);
      return manager;
    });
    return { harness, manager };
  }

  test('a closed session is reopened with the descriptor it had when it closed', async () => {
    const { harness, manager } = harnessWithRecorder();
    const closed = manager.getSession('dummy-session');
    assert.ok(closed, 'the harness registered the session');
    harness.host.onMessage({ type: 'closeSession', sessionId: 'dummy-session' });
    await until(() => !manager.getSession('dummy-session'));
    assert.strictEqual(manager.getSession('dummy-session'), undefined);

    harness.host.onMessage({ type: 'restoreLastClosed' });
    await until(() => manager.opened.length > 0);
    assert.strictEqual(manager.opened.length, 1);
    assert.strictEqual(manager.opened[0].sessionId, 'dummy-session');
    assert.strictEqual(manager.opened[0].cwd, closed!.cwd,
      'the closed session was reopened in its own directory, not the workspace default');
  });

  test('it is a LIFO stack: the most recent close comes back first', async () => {
    const { harness, manager } = harnessWithRecorder();
    harness.host.onMessage({ type: 'closeSession', sessionId: 'dummy-session' });
    await until(() => !manager.getSession('dummy-session'));

    // Restore it, then close it again: the same id must not be listed twice.
    harness.host.onMessage({ type: 'restoreLastClosed' });
    await until(() => manager.opened.length === 1);
    harness.host.onMessage({ type: 'restoreLastClosed' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.strictEqual(manager.opened.length, 1, 'the stack was empty after one entry was consumed');
  });

  test('an empty stack reports the failure to the panel instead of doing nothing', async () => {
    const harness = makeHarness('dummy-session', 'Claude Code');
    harness.surface.sent.length = 0;
    harness.host.onMessage({ type: 'restoreLastClosed' });
    await until(() => harness.surface.sent.some(m => m.type === 'error'));
    const error = harness.surface.sent.find(m => m.type === 'error') as { message?: string };
    assert.match(String(error?.message), /No recently closed session/);
  });
});

suite('chat panel: Rewind to a user message', () => {
  class RewindManager extends SessionManager {
    readonly forks: Array<{ sessionId: string; messageId?: string }> = [];
    override async forkSession(
      _agentName: string,
      sessionId: string,
      opts: { messageId?: string } = {},
    ): Promise<SessionInfo> {
      this.forks.push({ sessionId, messageId: opts.messageId });
      const source = this.getSession(sessionId)!;
      return { ...source, sessionId: 'fork-rewound' } as SessionInfo;
    }
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !check(); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  function userEntryId(harness: Harness, sessionId = 'dummy-session'): string {
    const entries = (harness.host as any).transcripts.peekEntries(sessionId) as Array<{ id: string; kind: string }>;
    const user = entries.find(e => e.kind === 'user');
    return user ? user.id : '';
  }

  test('forks at the reply before the message, closes the old tab and returns the text', async () => {
    const handler = new SessionUpdateHandler();
    const manager = new RewindManager(new AgentManager(), new ConnectionManager(handler), handler);
    const harness = makeHarness('dummy-session', 'Claude Code', () => manager);
    // A reply, then the user message being rewound to (seeded straight into the record,
    // which is what the replay path would produce).
    (harness.host as any).transcripts.ensureSession('dummy-session', 'Claude Code');
    (harness.host as any).transcripts.appendAssistantChunk('dummy-session', 'first reply', 'msg-a');
    (harness.host as any).transcripts.appendUser('dummy-session', 'my question');
    const entryId = userEntryId(harness);
    assert.ok(entryId, 'the user bubble is in the transcript');

    harness.host.onMessage({ type: 'rewindTo', sessionId: 'dummy-session', entryId });
    await until(() => manager.forks.length > 0);
    await until(() => !manager.getSession('dummy-session'));
    await until(() => harness.surface.sent.some(m => m.type === 'rewindReady'));

    assert.deepStrictEqual(manager.forks, [{ sessionId: 'dummy-session', messageId: 'msg-a' }],
      'the fork point is the assistant message id, so the new history ends before this question');
    assert.strictEqual(manager.getSession('dummy-session'), undefined, 'the old tab retires');
    const ready = harness.surface.sent.find(m => m.type === 'rewindReady') as { text?: string } | undefined;
    assert.strictEqual(ready?.text, 'my question', 'the question goes back to the composer');
  });

  test('a running turn refuses to rewind instead of cancelling it under the user', async () => {
    class BusyManager extends RewindManager {
      override isTurnInFlight(): boolean { return true; }
    }
    const handler = new SessionUpdateHandler();
    const manager = new BusyManager(new AgentManager(), new ConnectionManager(handler), handler);
    const harness = makeHarness('dummy-session', 'Claude Code', () => manager);
    (harness.host as any).transcripts.ensureSession('dummy-session', 'Claude Code');
    (harness.host as any).transcripts.appendUser('dummy-session', 'my question');
    const entryId = userEntryId(harness);
    assert.ok(entryId);
    harness.host.onMessage({ type: 'rewindTo', sessionId: 'dummy-session', entryId });
    // Session-scoped failures land as an error notice in the transcript, not `type: 'error'`.
    const errored = () => harness.surface.sent.some(m => m.type === 'append'
      && JSON.stringify(m).includes('Stop the current turn before rewinding'));
    await until(errored);
    assert.deepStrictEqual(manager.forks, []);
    assert.ok(errored());
  });
});
