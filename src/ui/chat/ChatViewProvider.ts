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
    // [CUSTOM- 扩展的 globalStorage：设置面板的「打开/清除 agent 运行时缓存」用。
    storageRoot?: string,
  ) {
    this.host = new ChatPanelHost(
      extensionUri, sessionManager, sessionUpdateHandler, permissionBridge, globalState, elicitationBridge,
    );
    this.host.setStorageRoot(storageRoot);
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
    // [CUSTOM- 先拉 agent，再渲染面板：首次连接慢在 npx 冷启动（实测 initialize 36s），
    // 这段等待应当和 webview 渲染重叠，而不是排在它后面。
    this.host.prewarm();
    this.host.attach(webviewView, this.context());
  }

  get hasChatContent(): boolean {
    return this.host.hasContent();
  }

  attachFile(uri: vscode.Uri): void {
    this.host.attachFile(uri);
  }

  /**
   * [CUSTOM-20261029] Route a stop request to the visible panel's `#stopConfirm`.
   * Returns false when no surface shows the session (caller falls back).
   */
  requestStop(sessionId: string): boolean {
    return this.host.requestStop(sessionId);
  }

  openEditorChat(): void {
    // [CUSTOM- 编辑区是第二种 surface：从命令/标签栏打开时同样先预热（见 prewarm）。
    this.host.prewarm();
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
