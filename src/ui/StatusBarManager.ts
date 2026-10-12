import * as vscode from 'vscode';

import type { SessionManager } from '../core/SessionManager';

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly sessions: SessionManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'vac.connectAgent';
    this.update();

    for (const event of ['agent-connected', 'agent-disconnected', 'active-session-changed', 'agent-closed']) {
      sessions.on(event, () => this.update());
    }
    sessions.on('agent-error', () => this.showError());
  }

  private update(): void {
    const connected = this.sessions.getConnectedAgentNames();
    this.item.backgroundColor = undefined;
    if (connected.length === 0) {
      this.item.text = '$(hubot) VAC: Disconnected';
      this.item.tooltip = 'Click to connect to an agent';
    } else {
      const name = this.sessions.getActiveSession()?.agentDisplayName || connected[0];
      this.item.text = `$(hubot) VAC: ${name}`;
      this.item.tooltip = `Connected to ${name}\n${connected.length} agent(s) connected`;
    }
    this.item.show();
  }

  private showError(): void {
    this.item.text = '$(error) VAC: Error';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  dispose(): void {
    this.item.dispose();
  }
}
