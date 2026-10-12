import * as vscode from 'vscode';

export interface PersistedSessionEntry {
  agentName: string;
  cwd: string;
  sessionId: string;
  title?: string;
  firstPrompt?: string;
  createdAt: string;
  lastActiveAt: string;
}

interface PersistedShape {
  version: 1;
  entries: PersistedSessionEntry[];
}

const STATE_KEY = 'vac.sessionHistory.v1';
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

  upsertNew(agentName: string, cwd: string, sessionId: string): void {
    const now = new Date().toISOString();
    const existing = this.get(agentName, sessionId);
    if (existing) {
      existing.lastActiveAt = now;
      existing.cwd = cwd;
    } else {
      this.entries.set(keyOf(agentName, sessionId), {
        agentName, cwd, sessionId, createdAt: now, lastActiveAt: now,
      });
      this.enforceCap(agentName);
    }
    this.persist();
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
