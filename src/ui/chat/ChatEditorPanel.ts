// 编辑区（编辑器标签页）里的 Chat 面板：与侧边栏 `vac-chat` 视图并存，两者共享同一个
// `ChatPanelHost`——记录本来就存在扩展宿主，所以两个面天然同源，关掉再打开也不丢内容
// （重开只是新文档 → `ready` → 定向 boot → 全量快照，不会触发 session/load）。
import * as vscode from 'vscode';

import type { SessionManager } from '../../core/SessionManager';
import { log } from '../../utils/Logger';
import type { ChatPanelHost } from './ChatPanelHost';
import { panelSurface } from './ChatSurface';
import { getAgentNames } from '../../config/AgentConfig';
import type { PanelContext } from './panelContract';

export const CHAT_EDITOR_VIEW_TYPE = 'vac-chat-editor';

const LOG_PREFIX = 'chat-panel';

export class ChatEditorPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly host: ChatPanelHost,
    private readonly sessionManager: SessionManager,
    private readonly extensionUri: vscode.Uri,
    private readonly context: () => PanelContext,
  ) {}

  get isOpen(): boolean {
    return this.panel !== null;
  }

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  open(): void {
    const ctx = this.context();
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }

    // 没有聚焦会话时先挑一个，否则面板打开就是空态（用户选的行为）。
    if (!ctx.sessionId) { this.focusMostRecentSession(); }

    const panel = vscode.window.createWebviewPanel(
      CHAT_EDITOR_VIEW_TYPE,
      'VAC Chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // Same trade-off as the sidebar view: the transcript lives in the
        // extension host, but keeping the document alive avoids rebuilding a
        // long timeline every time the tab is switched away and back.
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );
    this.panel = panel;
    // Tab strip icon: without it the tab falls back to a generic editor glyph.
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.png');

    // ORDER MATTERS: the listeners must exist BEFORE the surface attaches.
    // `attachSurface` writes the HTML, and the document's `ready` message can
    // arrive immediately after; registering late drops that first `ready` and
    // leaves the panel permanently empty (same failure class as the message
    // guard documented in arch/chat-panel.md §5.4 —
    // nothing automated catches it).
    panel.webview.onDidReceiveMessage(message => this.host.onMessage(message, 'editor'));
    panel.onDidDispose(() => {
      this.panel = null;
      this.host.detachSurface('editor');
      log(`${LOG_PREFIX}: editor panel disposed`);
    });

    // Re-read the context: focusing a session above may have just changed it, and
    // the boot snapshot is built from whatever we hand over here.
    this.host.attachSurface(panelSurface(panel), this.context());
    log(`${LOG_PREFIX}: editor panel opened`);
  }

  /**
   * No session is focused but the user wants the panel: focus the most recent live
   * session (configured agents first). Never creates one — opening the panel must
   * not spawn an agent process; an empty panel is valid and its `+` creates a session.
   */
  private focusMostRecentSession(): void {
    for (const agentName of getAgentNames()) {
      const ids = this.sessionManager.getSessionIdsForAgent(agentName);
      const mostRecent = ids[ids.length - 1];
      if (mostRecent) {
        log(`${LOG_PREFIX}: no focused session; focusing ${agentName}'s most recent (${mostRecent})`);
        this.sessionManager.focusSession(mostRecent);
        return;
      }
    }
    log(`${LOG_PREFIX}: no focused session and no live session to focus; opening empty panel`);
  }

  close(reason: 'user' | 'focus-changed' | 'dispose'): void {
    if (!this.panel) { return; }
    log(`${LOG_PREFIX}: editor panel closed (${reason})`);
    this.panel.dispose();
  }

  dispose(): void {
    this.close('dispose');
  }
}
