import * as vscode from 'vscode';

import type { SessionManager } from '../../core/SessionManager';
import type { ElicitationBridge } from '../../handlers/ElicitationBridge';
import type { PermissionBridge } from '../../handlers/PermissionBridge';
import type { SessionUpdateHandler } from '../../handlers/SessionUpdateHandler';
import { log } from '../../utils/Logger';
import { ChatEditorPanel } from './ChatEditorPanel';
import { ChatPanelHost } from './ChatPanelHost';
import type { PanelContext } from './panelContract';

/**
 * Owns the single `vac-chat` sidebar view and the editor-area panel. Both are
 * surfaces of one `ChatPanelHost`, which holds all transcripts and state.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'vac-chat';

  private view: vscode.WebviewView | null = null;
  private readonly host: ChatPanelHost;
  private readonly editor: ChatEditorPanel;

  constructor(
    extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    sessionUpdateHandler: SessionUpdateHandler,
    permissionBridge?: PermissionBridge,
    globalState?: vscode.Memento,
    elicitationBridge?: ElicitationBridge,
  ) {
    this.host = new ChatPanelHost(
      extensionUri, sessionManager, sessionUpdateHandler, permissionBridge, globalState, elicitationBridge,
    );
    this.editor = new ChatEditorPanel(this.host, sessionManager, extensionUri, () => this.context());
    sessionManager.on('active-session-changed', () => this.syncFocus());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.onDidReceiveMessage(message => this.host.onMessage(message));
    webviewView.onDidDispose(() => {
      this.host.detach();
      this.view = null;
    });
    log('chat-view: resolving sidebar chat view');
    this.host.attach(webviewView, this.context());
  }

  get hasChatContent(): boolean {
    return this.host.hasContent();
  }

  attachFile(uri: vscode.Uri): void {
    this.host.attachFile(uri);
  }

  openEditorChat(): void {
    this.editor.open();
  }

  notifyActiveSessionChanged(): void {
    this.syncFocus();
  }

  dispose(): void {
    this.editor.dispose();
    this.host.detach();
    this.view = null;
    this.host.dispose();
  }

  private context(): PanelContext {
    return {
      agentName: this.sessionManager.getFocusedAgentName(),
      sessionId: this.sessionManager.getActiveSessionId(),
    };
  }

  /** Also pushes focus when only the editor panel is open (the sidebar view may never have been resolved). */
  private syncFocus(): void {
    if (this.view || this.editor.isOpen) { this.host.onFocusChanged(this.context()); }
  }
}
