import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk';

import type { SessionCloseReason, SessionInfo } from './types';

/**
 * In-memory index of live sessions: who exists, which agent owns each, and which
 * one is focused (with most-recently-focused ordering for picking a successor).
 * Pure bookkeeping — no events, no I/O — so it is unit-testable without VS Code.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly byAgent = new Map<string, Set<string>>();
  private focusOrder: string[] = [];
  private focused: string | null = null;

  get(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  all(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  agentNames(): string[] {
    return Array.from(this.byAgent.keys());
  }

  hasAgent(agentName: string): boolean {
    return this.byAgent.has(agentName);
  }

  idsForAgent(agentName: string): string[] {
    const ids = this.byAgent.get(agentName);
    return ids ? Array.from(ids) : [];
  }

  add(session: SessionInfo): void {
    this.sessions.set(session.sessionId, session);
    let ids = this.byAgent.get(session.agentName);
    if (!ids) {
      ids = new Set();
      this.byAgent.set(session.agentName, ids);
    }
    ids.add(session.sessionId);
  }

  remove(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) { return undefined; }
    this.sessions.delete(sessionId);
    this.focusOrder = this.focusOrder.filter(id => id !== sessionId);
    const ids = this.byAgent.get(session.agentName);
    if (ids) {
      ids.delete(sessionId);
      if (ids.size === 0) { this.byAgent.delete(session.agentName); }
    }
    if (this.focused === sessionId) { this.focused = null; }
    return session;
  }

  get focusedId(): string | null {
    return this.focused;
  }

  /** Returns false when nothing changed (same focus, not forced). */
  focus(sessionId: string | null, force = false): boolean {
    if (sessionId !== null && !this.sessions.has(sessionId)) { return false; }
    if (this.focused === sessionId && !force) { return false; }
    this.focused = sessionId;
    if (sessionId) {
      this.focusOrder = this.focusOrder.filter(id => id !== sessionId);
      this.focusOrder.push(sessionId);
    }
    return true;
  }

  mostRecentLiveId(): string | null {
    for (let i = this.focusOrder.length - 1; i >= 0; i--) {
      if (this.sessions.has(this.focusOrder[i])) { return this.focusOrder[i]; }
    }
    let last: string | null = null;
    for (const id of this.sessions.keys()) { last = id; }
    return last;
  }

  clear(): void {
    this.sessions.clear();
    this.byAgent.clear();
    this.focusOrder = [];
    this.focused = null;
  }
}

/**
 * session/update notifications can land between the `session/new` response and
 * the moment the session is registered. They are parked here and drained onto
 * the session once it exists.
 */
export class PendingSessionState {
  private readonly commands = new Map<string, AvailableCommand[]>();
  private readonly configs = new Map<string, SessionConfigOption[]>();
  private readonly titles = new Map<string, string>();

  setCommands(sessionId: string, value: AvailableCommand[]): void { this.commands.set(sessionId, value); }
  setConfig(sessionId: string, value: SessionConfigOption[]): void { this.configs.set(sessionId, value); }
  setTitle(sessionId: string, value: string): void { this.titles.set(sessionId, value); }

  drainInto(session: SessionInfo): void {
    const { sessionId } = session;
    const commands = this.commands.get(sessionId);
    if (commands) {
      session.availableCommands = commands;
      this.commands.delete(sessionId);
    }
    const config = this.configs.get(sessionId);
    if (config !== undefined) {
      session.configOptions = config;
      this.configs.delete(sessionId);
    }
    const title = this.titles.get(sessionId);
    if (title !== undefined) {
      session.title = title;
      this.titles.delete(sessionId);
    }
  }
}

export type { SessionCloseReason };
