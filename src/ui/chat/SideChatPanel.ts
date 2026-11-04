import * as vscode from 'vscode';

import type { SessionManager } from '../../core/SessionManager';
import { log, logError } from '../../utils/Logger';
import type { ChatPanelHost } from './ChatPanelHost';
import { panelSurface } from './ChatSurface';
import type { SideChatOpener } from './panelContract';

export const SIDE_CHAT_VIEW_TYPE = 'vac-side-chat';

interface SideChatPanelOptions {
  createPanel?: (title: string) => vscode.WebviewPanel;
}

export class SideChatPanel implements SideChatOpener, vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly sideSessionIds: string[] = [];
  private panelListeners: vscode.Disposable[] = [];
  private readonly pendingQuotes = new Map<string, string[]>();
  private ready = false;
  private opening: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private readonly closingSessions = new Map<string, Promise<void>>();
  private generation = 0;
  private disposed = false;
  private readonly createPanel: (title: string) => vscode.WebviewPanel;

  constructor(
    private readonly host: ChatPanelHost,
    private readonly sessionManager: SessionManager,
    private readonly extensionUri: vscode.Uri,
    options: SideChatPanelOptions = {},
  ) {
    this.createPanel = options.createPanel ?? (title => vscode.window.createWebviewPanel(
      SIDE_CHAT_VIEW_TYPE,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    ));
    this.host.setSideChatOpener(this);
    this.sessionManager.on('session-closed', this.onSessionClosed);
  }

  get isOpen(): boolean {
    return this.panel !== null;
  }

  has(sessionId: string): boolean {
    return this.sideSessionIds.includes(sessionId)
      && !!this.sessionManager.getSession(sessionId)?.sideChat;
  }

  sessionIds(): readonly string[] {
    return this.sideSessionIds.slice();
  }

  open(sourceSessionId: string, selectedText?: string): Promise<void> {
    const run = this.opening.catch(() => undefined).then(() => this.openNow(sourceSessionId, selectedText));
    this.opening = run;
    return run;
  }

  activate(
    sessionId: string,
    options: { reveal?: boolean; preserveFocus?: boolean } = {},
  ): boolean {
    const panel = this.panel;
    if (!panel || !this.has(sessionId) || !this.host.activateSideSession(sessionId)) { return false; }
    if (options.reveal) { panel.reveal(undefined, options.preserveFocus ?? true); }
    this.flushQuotes(sessionId);
    return true;
  }

  async close(sessionId: string): Promise<void> {
    await this.closeGroup([sessionId], true);
  }

  private async openNow(sourceSessionId: string, selectedText?: string): Promise<void> {
    if (this.closing) { await this.closing; }
    if (this.disposed) { return; }
    this.assertMainSession(sourceSessionId);
    const generation = this.generation;
    const previousActive = this.host.activeSideSessionId();
    const source = this.sessionManager.getSession(sourceSessionId)!;
    const side = await this.sessionManager.forkSideSession(source.agentName, sourceSessionId);
    if (this.disposed || generation !== this.generation || !this.isMainSession(sourceSessionId)) {
      await this.rollbackSide(side.sessionId);
      return;
    }

    this.sideSessionIds.push(side.sessionId);
    if (selectedText?.trim()) { this.pendingQuotes.set(side.sessionId, [selectedText]); }
    let created = false;
    try {
      if (!this.panel) {
        created = true;
        const panel = this.createPanel('Side Chat');
        this.panel = panel;
        this.ready = false;
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.png');
        this.panelListeners = [
          panel.webview.onDidReceiveMessage(message => {
            if (this.panel !== panel) { return; }
            this.host.onMessage(message, 'side');
            if ((message as { type?: string })?.type === 'ready') {
              this.ready = true;
              const active = this.host.activeSideSessionId();
              if (active) { this.flushQuotes(active); }
            }
          }),
          panel.onDidDispose(() => {
            if (this.panel === panel) { void this.closeAll(false); }
          }),
        ];
        this.host.attachSurface(panelSurface(panel, 'side'), {
          agentName: source.agentName,
          sessionId: side.sessionId,
        });
        this.flushQuotes(side.sessionId);
      } else if (!this.activate(side.sessionId, { reveal: true, preserveFocus: false })) {
        throw new Error('Side Chat panel is no longer available.');
      }
      log(`chat-panel: Side Chat opened (${sourceSessionId} -> ${side.sessionId})`);
    } catch (e) {
      this.removeMembers([side.sessionId]);
      if (!created && this.host.activeSideSessionId() === side.sessionId) {
        const fallback = previousActive && this.has(previousActive)
          ? previousActive
          : this.sideSessionIds[0];
        if (fallback) { this.host.activateSideSession(fallback); }
      }
      if (created) { await this.closePanel(); }
      await this.deleteSide(side.sessionId);
      throw e;
    }
  }

  private flushQuotes(sessionId: string): void {
    if (!this.panel || !this.ready || this.host.activeSideSessionId() !== sessionId) { return; }
    const quotes = this.pendingQuotes.get(sessionId);
    if (!quotes?.length) { return; }
    this.pendingQuotes.delete(sessionId);
    for (const quote of quotes) { this.host.postSideQuote(sessionId, quote); }
  }

  private assertMainSession(sessionId: string): void {
    if (!this.isMainSession(sessionId)) {
      throw new Error('Side Chat needs a live main session.');
    }
  }

  private isMainSession(sessionId: string): boolean {
    const session = this.sessionManager.getSession(sessionId);
    return !!session && !session.sideChat;
  }

  private readonly onSessionClosed = (sessionId: string): void => {
    const children = this.sideSessionIds.filter(id =>
      this.sessionManager.getSession(id)?.sideChat?.parentSessionId === sessionId);
    if (children.length > 0) {
      void this.closeGroup(children, true);
      return;
    }
    if (!this.sideSessionIds.includes(sessionId)) { return; }

    const before = this.sideSessionIds.slice();
    const active = this.host.activeSideSessionId();
    this.removeMembers([sessionId]);
    if (this.sideSessionIds.length === 0) {
      void this.closePanel();
      return;
    }
    if (!active || active === sessionId || !this.has(active)) {
      const successor = this.successor(before, [sessionId], sessionId);
      if (successor) { this.activate(successor); }
    }
  };

  private async closeGroup(sessionIds: string[], disposePanel: boolean): Promise<void> {
    const doomed = new Set(sessionIds.filter(id => this.sideSessionIds.includes(id)));
    if (doomed.size === 0) { return; }
    const before = this.sideSessionIds.slice();
    const active = this.host.activeSideSessionId();
    const successor = active && doomed.has(active)
      ? this.successor(before, Array.from(doomed), active)
      : null;
    this.removeMembers(Array.from(doomed));
    if (this.sideSessionIds.length === 0) {
      await this.closePanel(disposePanel);
    } else if (successor) {
      this.activate(successor);
    }
    await Promise.all(Array.from(doomed, id => this.deleteSide(id)));
  }

  private successor(before: string[], removed: string[], active: string): string | null {
    const removedSet = new Set(removed);
    const index = before.indexOf(active);
    for (let i = index + 1; i < before.length; i++) {
      if (!removedSet.has(before[i])) { return before[i]; }
    }
    for (let i = index - 1; i >= 0; i--) {
      if (!removedSet.has(before[i])) { return before[i]; }
    }
    return null;
  }

  private removeMembers(sessionIds: string[]): void {
    const removed = new Set(sessionIds);
    for (let i = this.sideSessionIds.length - 1; i >= 0; i--) {
      if (removed.has(this.sideSessionIds[i])) { this.sideSessionIds.splice(i, 1); }
    }
    for (const sessionId of removed) {
      this.pendingQuotes.delete(sessionId);
      this.host.releaseSideSession(sessionId);
    }
  }

  private async closeAll(disposePanel = true): Promise<void> {
    const sessionIds = this.sideSessionIds.slice();
    this.removeMembers(sessionIds);
    await this.closePanel(disposePanel);
    await Promise.all(sessionIds.map(id => this.deleteSide(id)));
  }

  private closePanel(disposePanel = true): Promise<void> {
    if (this.closing) { return this.closing; }
    const run = this.closePanelNow(disposePanel);
    this.closing = run;
    return run.finally(() => {
      if (this.closing === run) { this.closing = null; }
    });
  }

  private async closePanelNow(disposePanel: boolean): Promise<void> {
    this.generation += 1;
    const panel = this.panel;
    const listeners = this.panelListeners.splice(0);
    this.panel = null;
    this.pendingQuotes.clear();
    this.ready = false;
    for (const listener of listeners) { listener.dispose(); }
    if (disposePanel) { panel?.dispose(); }
    this.host.detachSurface('side');
  }

  private async rollbackSide(sessionId: string): Promise<void> {
    this.pendingQuotes.delete(sessionId);
    this.host.releaseSideSession(sessionId);
    await this.deleteSide(sessionId);
  }

  private async deleteSide(sessionId: string): Promise<void> {
    const existing = this.closingSessions.get(sessionId);
    if (existing) { return existing; }
    const side = this.sessionManager.getSession(sessionId);
    const deletion = side
      ? this.sessionManager.deleteSession(side.agentName, side.sessionId).catch(e => {
        logError(`Side Chat cleanup failed for ${side.sessionId}`, e);
      })
      : Promise.resolve();
    this.closingSessions.set(sessionId, deletion);
    try {
      await deletion;
    } finally {
      if (this.closingSessions.get(sessionId) === deletion) {
        this.closingSessions.delete(sessionId);
      }
    }
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.host.setSideChatOpener(null);
    this.sessionManager.off('session-closed', this.onSessionClosed);
    void this.closeAll();
  }
}
