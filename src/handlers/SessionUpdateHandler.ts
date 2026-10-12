import type { SessionNotification } from '@agentclientprotocol/sdk';

import { logError } from '../utils/Logger';

export type SessionUpdateListener = (update: SessionNotification) => void;

/** Fans `session/update` notifications out to subscribers; one failing listener never starves the rest. */
export class SessionUpdateHandler {
  private readonly listeners = new Set<SessionUpdateListener>();

  addListener(listener: SessionUpdateListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SessionUpdateListener): void {
    this.listeners.delete(listener);
  }

  handleUpdate(update: SessionNotification): void {
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
  }
}
