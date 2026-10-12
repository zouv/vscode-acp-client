import * as vscode from 'vscode';
import { DASHBOARD_COMMANDS, renderDashboardHtml } from './DashboardHtml';
import { buildDashboardValues, DASHBOARD_SESSION_LIMIT, DashboardHost, EMPTY_SNAPSHOT, snapshotMessage } from './DashboardModel';
import { UsageService } from './usage/UsageService';

export type { DashboardHost } from './DashboardModel';

export interface DashboardViewProviderOptions {
  isEnabled(): boolean;
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export class DashboardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'vac-dashboard';

  private view: vscode.WebviewView | undefined;
  private visible = false;
  private readonly disposables: vscode.Disposable[] = [];
  private pending: NodeJS.Timeout | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: UsageService,
    private readonly host: DashboardHost,
    private readonly options: DashboardViewProviderOptions,
  ) {
    this.disposables.push(this.service.onDidChange(() => this.schedulePost()));
    this.disposables.push(this.host.onDidChangeState(() => this.schedulePost()));
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = renderDashboardHtml({ cspSource: webviewView.webview.cspSource, nonce: nonce() });
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((msg) => void this.onMessage(msg)),
      webviewView.onDidChangeVisibility(() => this.setVisible(webviewView.visible)),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
          this.visible = false;
        }
      }),
    );
    this.setVisible(webviewView.visible);
  }

  async refresh(): Promise<void> {
    if (!this.options.isEnabled()) {
      this.post();
      return;
    }
    await this.service.refresh();
    this.post();
  }

  dispose(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  private setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.options.isEnabled()) {
      void this.refresh();
      return;
    }
    this.post();
  }

  private schedulePost(): void {
    if (!this.visible || !this.view || this.pending) {
      return;
    }
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.post();
    }, 80);
    this.pending.unref?.();
  }

  private post(): void {
    const view = this.view;
    if (!view || !this.visible) {
      return;
    }
    const usage = this.options.isEnabled() ? this.service.snapshot() : EMPTY_SNAPSHOT;
    const values = buildDashboardValues(usage, this.host.connectionSummary(), this.host.recentSessions(DASHBOARD_SESSION_LIMIT));
    const notice = this.options.isEnabled() ? undefined : 'Dashboard disabled: enable vac.dashboard.enabled to scan local transcripts.';
    void view.webview.postMessage(snapshotMessage(values, notice));
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    const m = msg as { type?: string; id?: string; agentName?: string; sessionId?: string };
    if (m.type === 'command') {
      if (typeof m.id !== 'string' || !(DASHBOARD_COMMANDS as readonly string[]).includes(m.id)) {
        return;
      }
      await vscode.commands.executeCommand(m.id);
      return;
    }
    if (m.type === 'refresh') {
      await this.refresh();
      return;
    }
    if (m.type === 'openSession' && typeof m.agentName === 'string' && typeof m.sessionId === 'string') {
      await vscode.commands.executeCommand('vac.openSession', { agentName: m.agentName, sessionId: m.sessionId });
    }
  }
}
