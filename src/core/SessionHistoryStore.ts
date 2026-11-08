import * as vscode from 'vscode';

export interface PersistedSessionEntry {
  agentName: string;
  cwd: string;
  sessionId: string;
  title?: string;
  firstPrompt?: string;
  createdAt: string;
  lastActiveAt: string;
  /**
   * [CUSTOM- Extra roots this session was created with (`additionalDirectories`).
   * `session/load` / `session/resume` take them again, and they are not part of
   * `session/list`, so without this cache a reopened session lost its extra roots.
   */
  additionalDirectories?: string[];
}

interface PersistedShape {
  version: 1;
  entries: PersistedSessionEntry[];
}

const STATE_KEY = 'vac.sessionHistory.v1';
// [CUSTOM- 目录抽屉里用户手动删掉的「Recently used」条目（2026-10-28）。
// **单独一条 key**：会话历史那条记录的 shape 有 version 字段，往里加字段要连带迁移；
// 这一份只是一张路径集合，丢了也只影响下拉列表。
const DISMISSED_KEY = 'vac.recentCwdDismissed.v1';
const MAX_PROMPT_LEN = 120;
const DEFAULT_CAP_PER_AGENT = 50;
const TOUCH_PERSIST_INTERVAL_MS = 5000;

const keyOf = (agentName: string, sessionId: string) => `${agentName}\u0000${sessionId}`;

/**
 * Workspace-scoped cache of past sessions per agent. It is the source for the
 * session list of agents that can `session/load` but do not advertise
 * `session/list`, and it remembers which directories sessions were used in.
 */
export class SessionHistoryStore {
  private readonly entries = new Map<string, PersistedSessionEntry>();
  private readonly liveSessionIds = new Map<string, Set<string>>();
  private readonly lastPersistedTouch = new Map<string, number>();
  /** 「Recently used」里被用户删掉、暂时不该再出现的目录（全局，不分 agent）。 */
  private readonly dismissedCwds = new Set<string>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly capPerAgent: number = DEFAULT_CAP_PER_AGENT,
  ) {
    const raw = this.workspaceState.get<PersistedShape>(STATE_KEY);
    if (raw && raw.version === 1 && Array.isArray(raw.entries)) {
      for (const entry of raw.entries) { this.entries.set(keyOf(entry.agentName, entry.sessionId), entry); }
    }
    const dismissed = this.workspaceState.get<string[]>(DISMISSED_KEY);
    if (Array.isArray(dismissed)) {
      for (const cwd of dismissed) { if (typeof cwd === 'string' && cwd) { this.dismissedCwds.add(cwd); } }
    }
  }

  /**
   * [CUSTOM- 「Recently used」的删除（2026-10-28）。列表本身是从会话条目**派生**的
   * （`recentDirectories`），删不了源数据；所以记一份"用户不想再看到"的路径集合，
   * 由调用方在合并（本地缓存 + agent 的 session/list）时过滤。
   */
  // [CUSTOM- 调用方（ui 层）需要按**目录同一性**判断（Windows 上 F:/x 与 f:/x 是同一个）——
  // core 不 import ui，所以这里只交出原字符串，归一化交给 ChatPanelHost 的 directoryKey。
  dismissedRecentDirectories(): string[] { return Array.from(this.dismissedCwds); }

  dismissRecentDirectory(cwd: string): boolean {
    if (!cwd || this.dismissedCwds.has(cwd)) { return false; }
    this.dismissedCwds.add(cwd);
    void this.workspaceState.update(DISMISSED_KEY, Array.from(this.dismissedCwds));
    return true;
  }

  /** 这个目录又开始用了（新建了会话）⇒ 让它重新回到最近列表。 */
  private undismissRecentDirectory(cwd: string): void {
    if (!cwd || !this.dismissedCwds.delete(cwd)) { return; }
    void this.workspaceState.update(DISMISSED_KEY, Array.from(this.dismissedCwds));
  }

  /** Live sessions are exempt from capacity eviction and `session/list` reconciliation. */
  setLiveSessions(agentName: string, sessionIds: Iterable<string>): void {
    const ids = new Set(sessionIds);
    if (ids.size === 0) { this.liveSessionIds.delete(agentName); } else { this.liveSessionIds.set(agentName, ids); }
  }

  list(agentName: string, cwd?: string): PersistedSessionEntry[] {
    const out: PersistedSessionEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.agentName === agentName && (!cwd || e.cwd === cwd)) { out.push(e); }
    }
    return out.sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''));
  }

  get(agentName: string, sessionId: string): PersistedSessionEntry | undefined {
    return this.entries.get(keyOf(agentName, sessionId));
  }

  /** Distinct directories this agent's sessions used, most recently active first. */
  recentDirectories(agentName: string): string[] {
    const seen = new Set<string>();
    for (const entry of this.list(agentName)) {
      if (entry.cwd) { seen.add(entry.cwd); }
    }
    return Array.from(seen);
  }

  upsertNew(agentName: string, cwd: string, sessionId: string, additionalDirectories?: readonly string[]): void {
    const now = new Date().toISOString();
    // 这个目录又被用了（新建会话）⇒ 之前若从「Recently used」里删过，让它回来。
    this.undismissRecentDirectory(cwd);
    const existing = this.get(agentName, sessionId);
    if (existing) {
      existing.lastActiveAt = now;
      existing.cwd = cwd;
      this.mergeAdditionalDirectories(existing, additionalDirectories);
    } else {
      const entry: PersistedSessionEntry = {
        agentName, cwd, sessionId, createdAt: now, lastActiveAt: now,
      };
      this.mergeAdditionalDirectories(entry, additionalDirectories);
      this.entries.set(keyOf(agentName, sessionId), entry);
      this.enforceCap(agentName);
    }
    this.persist();
  }

  /**
   * [CUSTOM- Record a live session's extra roots. Update-only: a row the history
   * does not know about has nothing to reopen it with, and inventing one would put
   * a session into the picker that never lived in this workspace's cache.
   */
  setAdditionalDirectories(agentName: string, sessionId: string, directories: readonly string[] | undefined): void {
    const entry = this.get(agentName, sessionId);
    if (!entry) { return; }
    if (!this.mergeAdditionalDirectories(entry, directories)) { return; }
    this.persist();
  }

  /** Copy the (deduplicated, non-empty) directories; returns whether anything changed. */
  private mergeAdditionalDirectories(
    entry: PersistedSessionEntry,
    directories: readonly string[] | undefined,
  ): boolean {
    if (!directories) { return false; }
    const next = Array.from(new Set(directories.filter(d => typeof d === 'string' && d.length > 0)));
    if (next.length === 0) { return false; }
    const previous = entry.additionalDirectories ?? [];
    if (previous.length === next.length && previous.every((value, index) => value === next[index])) {
      return false;
    }
    entry.additionalDirectories = next;
    return true;
  }

  setTitle(agentName: string, sessionId: string, title: string | null | undefined): void {
    const entry = this.get(agentName, sessionId);
    if (!entry) { return; }
    if (title === null) { delete entry.title; } else if (typeof title === 'string') { entry.title = title; }
    this.persist();
  }

  setFirstPromptIfMissing(agentName: string, sessionId: string, prompt: string): void {
    const entry = this.get(agentName, sessionId);
    if (!entry || entry.firstPrompt) { return; }
    entry.firstPrompt = prompt.slice(0, MAX_PROMPT_LEN);
    this.persist();
  }

  /** Bumps `lastActiveAt` in memory every time, but writes to storage at most every few seconds. */
  touch(agentName: string, sessionId: string): void {
    const key = keyOf(agentName, sessionId);
    const entry = this.entries.get(key);
    if (!entry) { return; }
    const now = Date.now();
    entry.lastActiveAt = new Date(now).toISOString();
    if (now - (this.lastPersistedTouch.get(key) ?? 0) < TOUCH_PERSIST_INTERVAL_MS) { return; }
    this.lastPersistedTouch.set(key, now);
    this.persist();
  }

  forget(agentName: string, sessionId: string): boolean {
    const removed = this.entries.delete(keyOf(agentName, sessionId));
    if (removed) { this.persist(); }
    return removed;
  }

  forgetAgent(agentName: string): number {
    let removed = 0;
    for (const [key, e] of this.entries) {
      if (e.agentName === agentName) { this.entries.delete(key); removed++; }
    }
    if (removed > 0) { this.persist(); }
    return removed;
  }

  /** Drops entries the agent no longer lists, except live sessions (agents may omit them until the turn ends). */
  reconcileFromAgent(agentName: string, knownSessionIds: Set<string>, liveSessionIds?: Iterable<string>): void {
    const live = new Set(this.liveSessionIds.get(agentName) ?? []);
    for (const id of liveSessionIds ?? []) { live.add(id); }
    let changed = false;
    for (const [key, e] of this.entries) {
      if (e.agentName !== agentName || knownSessionIds.has(e.sessionId) || live.has(e.sessionId)) { continue; }
      this.entries.delete(key);
      changed = true;
    }
    if (changed) { this.persist(); }
  }

  private enforceCap(agentName: string): void {
    const live = this.liveSessionIds.get(agentName);
    const evictable = this.list(agentName).filter(e => !live?.has(e.sessionId));
    for (const stale of evictable.slice(this.capPerAgent)) {
      this.entries.delete(keyOf(agentName, stale.sessionId));
    }
  }

  private persist(): void {
    const payload: PersistedShape = { version: 1, entries: Array.from(this.entries.values()) };
    void this.workspaceState.update(STATE_KEY, payload);
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
