import type { SessionNotification } from '@agentclientprotocol/sdk';

import { logError } from '../utils/Logger';

export type SessionUpdateListener = (update: SessionNotification) => void;

/** Fans `session/update` notifications out to subscribers; one failing listener never starves the rest. */
export class SessionUpdateHandler {
  private readonly inactiveAgents = new Set<string>();
  onRelease?: (sessionId: string) => void;
  private readonly owners = new Map<string, string>();
  private readonly listeners = new Set<SessionUpdateListener>();

  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

  activateAgent(agentId: string): void { this.inactiveAgents.delete(agentId); }

  /** Early notifications claim an id until its connection is removed. */
  accepts(sessionId: string, agentId?: string): boolean {
    if (!agentId) { return true; } // Direct handler calls in tests have no connection.
    if (this.inactiveAgents.has(agentId)) { return false; }
    const owner = this.owners.get(sessionId);
    if (owner && owner !== agentId) { return false; }
    this.owners.set(sessionId, agentId);
    return true;
  }

  claim(sessionId: string, agentId: string): void {
    if (!this.accepts(sessionId, agentId)) {
      throw new Error('Session id is already owned by another agent connection.');
    }
  }

  releaseAgent(agentId: string): string[] {
    this.inactiveAgents.add(agentId);
    const released: string[] = [];
    for (const [sessionId, owner] of this.owners) {
      if (owner === agentId) { this.owners.delete(sessionId); released.push(sessionId); this.onRelease?.(sessionId); }
    }
    return released;
  }

  handleUpdate(update: SessionNotification, agentId?: string): void {
    if (!this.accepts(update.sessionId, agentId)) { return; }
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (e) {
        logError('session update listener failed', e);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.owners.clear();
    this.inactiveAgents.clear();
  }
}
