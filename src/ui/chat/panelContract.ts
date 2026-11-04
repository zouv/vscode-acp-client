import * as vscode from 'vscode';

/** Focused agent + session, as understood by the chat surfaces. */
export interface PanelContext {
  agentName: string | null;
  sessionId: string | null;
}

export interface SideChatOpener {
  open(sourceSessionId: string, selectedText?: string): Promise<void>;
  has(sessionId: string): boolean;
  sessionIds(): readonly string[];
  activate(
    sessionId: string,
    options?: { reveal?: boolean; preserveFocus?: boolean },
  ): boolean;
  close(sessionId: string): Promise<void>;
}

/**
 * What the sidebar view provider needs from the chat host. The host owns every
 * transcript, so detaching a surface never loses content.
 *
 * `detach()` may be followed by stray events: a detached host drops outgoing
 * messages instead of throwing.
 */
export interface IChatPanel {
  attach(view: vscode.WebviewView, ctx: PanelContext): void;
  detach(): void;
  onMessage(message: unknown): void;
  onFocusChanged(ctx: PanelContext): void;
  hasContent(): boolean;
  attachFile(uri: vscode.Uri): void;
}
