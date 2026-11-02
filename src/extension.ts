import * as vscode from 'vscode';

import { AgentManager } from './core/AgentManager';
import { setAuthSecrets } from './core/auth';
import { ConnectionManager } from './core/ConnectionManager';
import { SessionHistoryStore } from './core/SessionHistoryStore';
import { SessionManager } from './core/SessionManager';
import { createUsageService, ClaudeUsageSource, CodexUsageSource, DashboardViewProvider, type DashboardHost } from './dashboard';
import type { DashboardValues } from './dashboard/DashboardModel';
import { registerCommands } from './commands';
import { offerAgentMigration } from './config/AgentConfig';
import { ElicitationBridge } from './handlers/ElicitationBridge';
import { PermissionBridge } from './handlers/PermissionBridge';
import { SessionUpdateHandler } from './handlers/SessionUpdateHandler';
import { ChatViewProvider } from './ui/chat';
import { SessionTreeProvider } from './ui/SessionTreeProvider';
import { StatusBarManager } from './ui/StatusBarManager';
import { buildStamp } from './utils/BuildInfo';
import { disposeChannels, log, logError } from './utils/Logger';

const DASHBOARD_SESSION_LIMIT = 10;

function createDashboardHost(sessions: SessionManager, history: SessionHistoryStore): DashboardHost {
  const changed = new vscode.EventEmitter<void>();
  for (const event of ['agent-connected', 'agent-disconnected', 'session-created', 'session-closed', 'active-session-changed', 'session-info-changed']) {
    sessions.on(event, () => changed.fire());
  }
  return {
    connectionSummary: () => sessions.getConnectedAgentNames().map(name => ({
      name,
      connected: sessions.isAgentConnected(name),
      sessions: sessions.getSessionIdsForAgent(name).length,
    })),
    recentSessions: limit => {
      const out: DashboardValues['sessions'] = [];
      for (const agentName of sessions.getConnectedAgentNames()) {
        for (const entry of history.list(agentName)) {
          out.push({
            agentName,
            sessionId: entry.sessionId,
            title: entry.title || entry.firstPrompt || '',
            cwd: entry.cwd,
            lastActiveAt: entry.lastActiveAt,
          });
        }
      }
      return out
        .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''))
        .slice(0, limit || DASHBOARD_SESSION_LIMIT);
    },
    onDidChangeState: cb => changed.event(cb),
  };
}

export function activate(context: vscode.ExtensionContext): void {
  log(`VAC extension activating... [build ${buildStamp()}]`);
  setAuthSecrets(context.secrets);

  const updates = new SessionUpdateHandler();
  const agentManager = new AgentManager(context.globalStorageUri.fsPath);
  const permissionBridge = new PermissionBridge();
  const elicitationBridge = new ElicitationBridge();
  const connectionManager = new ConnectionManager(updates, permissionBridge, elicitationBridge);
  const sessions = new SessionManager(agentManager, connectionManager, updates);

  sessions.on('agent-recovery-failed', () => {
    void vscode.window.showWarningMessage('VAC: Automatic recovery stopped. Your tabs are retained; reconnect manually or disconnect to close them.');
  });
  const agentConfigListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('vac.autoReconnect') && !vscode.workspace.getConfiguration('vac').get<boolean>('autoReconnect', true)) { sessions.cancelAutomaticRecovery(); }
    if (!event.affectsConfiguration('vac.agents')) { return; }
    void vscode.window.showInformationMessage('VAC: Agent configuration changed. Reload the window to apply it to running agents.', 'Reload Window').then(action => {
      if (action === 'Reload Window') { void vscode.commands.executeCommand('workbench.action.reloadWindow'); }
    });
  });

  const history = new SessionHistoryStore(context.workspaceState);
  sessions.setHistoryStore(history);
  sessions.setPermissionBridge(permissionBridge);
  sessions.setElicitationBridge(elicitationBridge);

  const sessionLookup = (sessionId: string) => {
    const session = sessions.getSession(sessionId);
    return session ? { title: session.title, agentName: session.agentName } : undefined;
  };
  permissionBridge.setSessionLookup(sessionLookup);
  elicitationBridge.setSessionLookup(sessionLookup);

  const tree = new SessionTreeProvider(sessions, history, () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  const chat = new ChatViewProvider(
    context.extensionUri, sessions, updates, permissionBridge, context.globalState, elicitationBridge,
    context.globalStorageUri.fsPath,
  );

  const config = () => vscode.workspace.getConfiguration('vac');
  const usage = createUsageService({
    storageDir: context.globalStorageUri.fsPath,
    enabled: config().get<boolean>('dashboard.enabled', true),
    claudeProjectsDir: config().get<string>('dashboard.claudeProjectsDir') || undefined,
  });
  let projectsDir = config().get<string>('dashboard.claudeProjectsDir') || undefined;
  let usageConfigQueue: Promise<void> = Promise.resolve();
  const usageConfigListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('vac.dashboard.enabled') && !event.affectsConfiguration('vac.dashboard.claudeProjectsDir')) { return; }
    usage.setEnabled(false);
    usageConfigQueue = usageConfigQueue.then(async () => {
      const nextDir = config().get<string>('dashboard.claudeProjectsDir') || undefined;
      if (nextDir !== projectsDir) {
        await usage.replaceSources([new ClaudeUsageSource(nextDir), new CodexUsageSource()]);
        projectsDir = nextDir;
      }
      const enabled = config().get<boolean>('dashboard.enabled', true);
      usage.setEnabled(enabled);
      if (enabled) { usage.startWatching(); await usage.refresh(); }
    }).catch(error => logError('dashboard configuration failed', error));
  });
  const dashboard = new DashboardViewProvider(
    context.extensionUri,
    usage,
    createDashboardHost(sessions, history),
    { isEnabled: () => config().get<boolean>('dashboard.enabled', true) },
  );

  const updateTurnContext = () => {
    const focused = sessions.getActiveSessionId();
    void vscode.commands.executeCommand(
      'setContext', 'vac.turnInProgress', !!focused && sessions.isTurnInFlight(focused),
    );
  };
  sessions.on('turn-state-changed', updateTurnContext);
  sessions.on('active-session-changed', updateTurnContext);

  context.subscriptions.push(
    vscode.window.createTreeView('vac-sessions', { treeDataProvider: tree }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(DashboardViewProvider.viewType, dashboard, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    new StatusBarManager(sessions),
    ...registerCommands({
      sessions, history, chat, tree,
      refreshDashboard: () => void dashboard.refresh(),
    }),
    {
      dispose: () => {
        sessions.dispose();
        updates.dispose();
        permissionBridge.cancelAll();
        elicitationBridge.cancelAll();
        dashboard.dispose();
        usageConfigListener.dispose();
        agentConfigListener.dispose();
        usage.dispose();
        chat.dispose();
        permissionBridge.dispose();
        elicitationBridge.dispose();
        tree.dispose();
        history.dispose();
        void disposeChannels();
      },
    },
  );

  // The first scan is expensive, so it starts after activation and never blocks it.
  void usage.load().then(() => usage.refresh()).catch(e => logError('dashboard: initial scan failed', e));
  void offerAgentMigration(context.globalState).catch(e => logError('agent config migration failed', e));

  log('VAC extension activated.');
}

export async function deactivate(): Promise<void> {
  log('VAC extension deactivated.');
  await disposeChannels();
}
