import * as vscode from 'vscode';
import type { SessionInfo as ProtocolSessionInfo } from '@agentclientprotocol/sdk';

import { getAgentNames } from '../config/AgentConfig';
import type { SessionHistoryStore, PersistedSessionEntry } from '../core/SessionHistoryStore';
import type { AgentCapabilitySummary, SessionManager } from '../core/SessionManager';
import { log, logError } from '../utils/Logger';

export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    public readonly connected: boolean,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(agentName, collapsibleState);
    this.contextValue = connected ? 'agent-connected' : 'agent-disconnected';
    this.iconPath = connected
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('circle-outline');
    this.description = connected ? 'connected' : '';
    if (connected) { this.command = { command: 'vac.openChat', title: 'Open Chat' }; }
    this.tooltip = connected
      ? `${agentName} — connected\nClick to open chat`
      : `${agentName} — not connected\nUse the plug icon to connect`;
  }
}

export class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly agentName: string,
    public readonly sessionId: string,
    label: string,
    isActive: boolean,
    description: string | undefined,
    tooltip: string,
    public readonly source: 'agent' | 'local',
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = source === 'local' ? 'session-local' : 'session';
    this.description = description;
    this.tooltip = tooltip;
    this.iconPath = isActive
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('comment-discussion');
    this.command = { command: 'vac.openSession', title: 'Open Session', arguments: [{ agentName, sessionId }] };
  }
}

type InfoKind = 'loading' | 'empty' | 'unsupported' | 'error' | 'auth-required' | 'load-more';

const INFO_ICONS: Record<InfoKind, { icon: string; context: string }> = {
  loading: { icon: 'loading~spin', context: 'session-info-loading' },
  empty: { icon: 'inbox', context: 'session-info-empty' },
  unsupported: { icon: 'info', context: 'session-info-unsupported' },
  error: { icon: 'warning', context: 'session-info-error' },
  'auth-required': { icon: 'key', context: 'session-info-auth' },
  'load-more': { icon: 'chevron-down', context: 'session-info-load-more' },
};

export class InfoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: InfoKind,
    public readonly agentName: string,
    label: string,
    tooltip?: string,
    command?: vscode.Command,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.command = command;
    this.iconPath = new vscode.ThemeIcon(INFO_ICONS[kind].icon);
    this.contextValue = INFO_ICONS[kind].context;
  }
}

type TreeNode = AgentTreeItem | SessionTreeItem | InfoTreeItem;

interface AgentListState {
  state: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported' | 'auth-required';
  agentSessions?: ProtocolSessionInfo[];
  nextCursor?: string;
  error?: string;
}

/**
 * Agents → sessions. A session list comes from the agent when it advertises
 * `session/list`, from the local history cache when it can only load/resume,
 * and is replaced by an explanatory leaf otherwise.
 */
export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly listStates = new Map<string, AgentListState>();
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly sessions: SessionManager,
    private readonly history: SessionHistoryStore | null,
    private readonly workspaceCwd: () => string | undefined,
  ) {
    for (const event of ['agent-connected', 'agent-disconnected', 'active-session-changed', 'session-info-changed']) {
      sessions.on(event, () => this.refresh());
    }
    history?.onDidChange(() => this.refresh());
  }

  /** Coalesces bursts (every title/focus/history change fires) into one tree refresh. */
  refresh(): void {
    if (this.refreshTimer) { return; }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.changed.fire();
    }, 50);
  }

  invalidate(agentName?: string): void {
    if (agentName) { this.listStates.delete(agentName); } else { this.listStates.clear(); }
    this.refresh();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) { return this.agentNodes(); }
    return element instanceof AgentTreeItem ? this.agentChildren(element.agentName) : [];
  }

  private agentNodes(): AgentTreeItem[] {
    return getAgentNames().map(name => {
      const caps = this.sessions.getCachedCapabilities(name);
      const localCount = this.history?.list(name, this.workspaceCwd()).length ?? 0;
      return new AgentTreeItem(name, this.sessions.isAgentConnected(name), this.collapsible(caps, localCount));
    });
  }

  private collapsible(caps: AgentCapabilitySummary | undefined, localCount: number): vscode.TreeItemCollapsibleState {
    const nothingToShow = caps && !caps.list && !caps.load && !caps.resume && localCount === 0;
    return nothingToShow ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
  }

  private async agentChildren(name: string): Promise<TreeNode[]> {
    let caps = this.sessions.getCachedCapabilities(name);
    if (!caps) {
      const probe = await this.probe(name);
      if (probe.kind === 'auth-cancelled') { return [this.authLeaf(name)]; }
      if (probe.kind === 'error') { return [this.errorLeaf(name, probe.message)]; }
      caps = probe.caps;
    }
    if (caps.list) { return this.agentSourced(name); }
    if (caps.load || caps.resume) { return this.localSourced(name); }
    return [new InfoTreeItem(
      'unsupported', name, 'Session list not supported',
      'This agent does not advertise session/list, session/load, or session/resume.\nYou can still start a new chat from the agent row.',
    )];
  }

  private agentSourced(name: string): TreeNode[] {
    const state = this.listStates.get(name);
    if (state?.state === 'loading') { return [this.loadingLeaf(name)]; }
    if (!state || state.state === 'idle' || state.state === 'error') {
      void this.fetchList(name);
      return [this.loadingLeaf(name)];
    }
    if (state.state === 'auth-required') { return [this.authLeaf(name)]; }
    if (state.state === 'unsupported') { return [new InfoTreeItem('unsupported', name, 'Session list not supported')]; }

    const list = state.agentSessions ?? [];
    if (list.length === 0 && !state.nextCursor) { return [new InfoTreeItem('empty', name, '(no previous sessions)')]; }
    const activeId = this.sessions.getActiveSessionId();
    const items: TreeNode[] = list.map(s => new SessionTreeItem(
      name, s.sessionId, s.title?.trim() || shortId(s.sessionId), s.sessionId === activeId,
      relativeTime(s.updatedAt), tooltipFor(name, s.sessionId, s.cwd, s.updatedAt, 'agent'), 'agent',
    ));
    if (state.nextCursor) {
      items.push(new InfoTreeItem('load-more', name, 'Load more…', undefined, {
        command: 'vac.loadMoreSessions', title: 'Load more sessions', arguments: [name],
      }));
    }
    return items;
  }

  private async fetchList(name: string): Promise<void> {
    this.listStates.set(name, { state: 'loading' });
    this.refresh();
    try {
      const result = await this.sessions.listSessions(name, { cwd: this.workspaceCwd() });
      this.listStates.set(name, { state: 'ready', agentSessions: result.sessions, nextCursor: result.nextCursor });
    } catch (e) {
      const message = String((e as Error | undefined)?.message || 'Unknown error');
      logError(`Failed to list sessions for ${name}`, e);
      this.listStates.set(name, /auth|authentication|cancelled/i.test(message)
        ? { state: 'auth-required' }
        : { state: 'error', error: message });
    } finally {
      this.refresh();
    }
  }

  async loadMore(name: string): Promise<void> {
    const state = this.listStates.get(name);
    if (!state || state.state !== 'ready' || !state.nextCursor) { return; }
    this.listStates.set(name, { ...state, state: 'loading' });
    this.refresh();
    try {
      const result = await this.sessions.listSessions(name, { cwd: this.workspaceCwd(), cursor: state.nextCursor });
      this.listStates.set(name, {
        state: 'ready',
        agentSessions: [...(state.agentSessions ?? []), ...result.sessions],
        nextCursor: result.nextCursor,
      });
    } catch (e) {
      logError(`Failed to load more sessions for ${name}`, e);
      this.listStates.set(name, { ...state, error: String((e as Error | undefined)?.message || e) });
    } finally {
      this.refresh();
    }
  }

  private localSourced(name: string): TreeNode[] {
    if (!this.history) {
      return [new InfoTreeItem('unsupported', name, 'Session history unavailable', 'No workspace storage is wired up.')];
    }
    const entries = this.history.list(name, this.workspaceCwd());
    if (entries.length === 0) {
      return [new InfoTreeItem('empty', name, '(no previous sessions)', 'Sessions you start with this agent will appear here.')];
    }
    const activeId = this.sessions.getActiveSessionId();
    return entries.map(e => this.localItem(e, activeId));
  }

  private localItem(entry: PersistedSessionEntry, activeId: string | null): SessionTreeItem {
    const label = entry.title?.trim()
      || (entry.firstPrompt?.trim() && truncate(entry.firstPrompt.trim(), 60))
      || shortId(entry.sessionId);
    return new SessionTreeItem(
      entry.agentName, entry.sessionId, label, entry.sessionId === activeId,
      relativeTime(entry.lastActiveAt),
      tooltipFor(entry.agentName, entry.sessionId, entry.cwd, entry.lastActiveAt, 'local'), 'local',
    );
  }

  private async probe(name: string): Promise<
    | { kind: 'ok'; caps: AgentCapabilitySummary }
    | { kind: 'auth-cancelled' }
    | { kind: 'error'; message: string }
  > {
    log(`Probing capabilities for agent "${name}"…`);
    try {
      await this.sessions.ensureConnected(name);
      const caps = this.sessions.getCachedCapabilities(name);
      return caps ? { kind: 'ok', caps } : { kind: 'error', message: 'Failed to determine agent capabilities.' };
    } catch (e) {
      const message = String((e as Error | undefined)?.message || e);
      logError(`Capability probe failed for ${name}`, e);
      return /cancelled/i.test(message) ? { kind: 'auth-cancelled' } : { kind: 'error', message };
    }
  }

  private loadingLeaf(name: string): InfoTreeItem {
    return new InfoTreeItem('loading', name, 'Loading sessions…');
  }

  private authLeaf(name: string): InfoTreeItem {
    return new InfoTreeItem('auth-required', name, 'Authentication required', 'Click to retry authentication.', {
      command: 'vac.connectAgent', title: 'Retry connect', arguments: [name],
    });
  }

  private errorLeaf(name: string, message: string): InfoTreeItem {
    return new InfoTreeItem('error', name, 'Failed to load sessions', message, {
      command: 'vac.refreshSessions', title: 'Retry', arguments: [name],
    });
  }

  dispose(): void {
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.changed.dispose();
  }
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const RELATIVE_UNITS: Array<[number, string]> = [
  [60, 's'], [3600, 'm'], [86400, 'h'], [7 * 86400, 'd'], [35 * 86400, 'w'], [365 * 86400, 'mo'],
];
const RELATIVE_DIVISORS = [1, 60, 3600, 86400, 7 * 86400, 30 * 86400];

function relativeTime(iso: string | null | undefined): string | undefined {
  if (!iso) { return undefined; }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) { return undefined; }
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 0) { return 'just now'; }
  for (let i = 0; i < RELATIVE_UNITS.length; i++) {
    if (sec < RELATIVE_UNITS[i][0]) { return `${Math.floor(sec / RELATIVE_DIVISORS[i])}${RELATIVE_UNITS[i][1]} ago`; }
  }
  return `${Math.floor(sec / (365 * 86400))}y ago`;
}

function tooltipFor(
  agentName: string,
  sessionId: string,
  cwd: string | undefined,
  updatedAt: string | undefined | null,
  source: 'agent' | 'local',
): string {
  const lines = [`Agent: ${agentName}`, `Session: ${sessionId}`];
  if (cwd) { lines.push(`cwd: ${cwd}`); }
  if (updatedAt) { lines.push(`Last active: ${updatedAt}`); }
  lines.push(source === 'local' ? 'Stored locally — agent does not list sessions' : 'Listed by agent');
  return lines.join('\n');
}
