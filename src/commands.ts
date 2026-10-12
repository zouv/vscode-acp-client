import * as vscode from 'vscode';

import { getAgentNames } from './config/AgentConfig';
import type { SessionHistoryStore } from './core/SessionHistoryStore';
import type { SessionManager } from './core/SessionManager';
import type { ChatViewProvider } from './ui/chat';
import type { SessionTreeProvider } from './ui/SessionTreeProvider';
import { getOutputChannel, getTrafficChannel, logError } from './utils/Logger';

export interface CommandDeps {
  sessions: SessionManager;
  history: SessionHistoryStore;
  chat: ChatViewProvider;
  tree: SessionTreeProvider;
  refreshDashboard: () => void;
}

type TreeArg = string | { agentName?: string; sessionId?: string } | undefined;

const agentNameOf = (arg: TreeArg): string | undefined => (typeof arg === 'string' ? arg : arg?.agentName);

const withProgress = <T>(title: string, task: () => Promise<T>): Thenable<T> =>
  vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, task);

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function readAgentsConfig() {
  const config = vscode.workspace.getConfiguration('vac');
  return { config, agents: { ...(config.get<Record<string, unknown>>('agents') ?? {}) } };
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { sessions, history, chat, tree } = deps;
  const handlers: Record<string, (...args: any[]) => unknown> = {
    'vac.connectAgent': async (arg?: TreeArg) => {
      let agentName = agentNameOf(arg);
      if (!agentName) {
        const names = getAgentNames();
        if (names.length === 0) {
          void vscode.window.showWarningMessage('No agents configured. Add agents in Settings > VAC > Agents.');
          return;
        }
        agentName = await vscode.window.showQuickPick(names, {
          placeHolder: 'Select an agent to connect',
          title: 'Connect to Agent',
        });
        if (!agentName) { return; }
      }
      const target = agentName;
      try {
        await withProgress(`Connecting to ${target}...`, () => sessions.connectToAgent(target));
      } catch (e) {
        logError('Failed to connect to agent', e);
        void vscode.window.showErrorMessage(`Failed to connect: ${errorMessage(e)}`);
      }
    },

    'vac.newConversation': async () => {
      const active = sessions.getActiveSession();
      if (!active) {
        await vscode.commands.executeCommand('vac.connectAgent');
        return;
      }
      try {
        await withProgress(`Starting new conversation with ${active.agentDisplayName}...`, () => sessions.newConversation());
      } catch (e) {
        logError('Failed to start new conversation', e);
        void vscode.window.showErrorMessage(`Failed to start new conversation: ${errorMessage(e)}`);
      }
    },

    'vac.disconnectAgent': async (arg?: TreeArg) => {
      const agentName = agentNameOf(arg) || sessions.getActiveAgentName();
      if (!agentName) {
        void vscode.window.showInformationMessage('No agent connected.');
        return;
      }
      await sessions.disconnectAgent(agentName);
      void vscode.window.showInformationMessage(`Disconnected from ${agentName}.`);
    },

    'vac.openChat': () => vscode.commands.executeCommand('vac-chat.focus'),
    'vac.sendPrompt': () => vscode.commands.executeCommand('vac-chat.focus'),
    'vac.openChatInEditor': () => chat.openEditorChat(),

    'vac.cancelTurn': async () => {
      const id = sessions.getActiveSessionId();
      if (!id) { return; }
      try {
        await sessions.cancelTurn(id);
      } catch (e) {
        logError('Cancel failed', e);
      }
    },

    'vac.restartAgent': async () => {
      const active = sessions.getActiveSession();
      if (!active) { return; }
      try {
        await withProgress(`Restarting ${active.agentDisplayName}...`, async () => {
          await sessions.disconnectAgent(active.agentName);
          await sessions.connectToAgent(active.agentName);
        });
        void vscode.window.showInformationMessage(`Restarted ${active.agentName}`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Failed to restart: ${errorMessage(e)}`);
      }
    },

    'vac.showLog': () => getOutputChannel().show(),
    'vac.showTraffic': () => getTrafficChannel().show(),

    'vac.setMode': async (modeId?: string) => {
      const id = sessions.getActiveSessionId();
      if (!id) { return; }
      const mode = modeId || await vscode.window.showInputBox({
        placeHolder: 'Enter mode ID (e.g., "plan", "code")',
        title: 'Set Agent Mode',
      });
      if (!mode) { return; }
      try {
        await sessions.setMode(id, mode);
      } catch (e) {
        void vscode.window.showErrorMessage(`Failed to set mode: ${errorMessage(e)}`);
      }
    },

    'vac.setModel': async (modelId?: string) => {
      const id = sessions.getActiveSessionId();
      if (!id) { return; }
      const model = modelId || await vscode.window.showInputBox({ placeHolder: 'Enter model ID', title: 'Set Agent Model' });
      if (!model) { return; }
      try {
        await sessions.setModel(id, model);
      } catch (e) {
        void vscode.window.showErrorMessage(`Failed to set model: ${errorMessage(e)}`);
      }
    },

    'vac.refreshAgents': () => tree.refresh(),
    'vac.refreshSessions': (arg?: TreeArg) => tree.invalidate(agentNameOf(arg)),
    'vac.refreshDashboard': () => deps.refreshDashboard(),

    'vac.openSession': async (arg?: { agentName?: string; sessionId?: string }) => {
      const { agentName, sessionId } = arg ?? {};
      if (!agentName || !sessionId) {
        void vscode.window.showErrorMessage('Open Session: missing agentName/sessionId.');
        return;
      }
      // Already focused: an explicit click must still be answered (the panel may be on a draft page)
      if (sessions.getActiveSessionId() === sessionId) {
        sessions.focusSession(sessionId, { force: true });
        await vscode.commands.executeCommand('vac-chat.focus');
        return;
      }
      try {
        await vscode.commands.executeCommand('vac-chat.focus');
        const how = await withProgress('Opening session…', () => sessions.openExistingSession(agentName, sessionId));
        if (how === 'resume') {
          void vscode.window.showInformationMessage('Resumed session (history not replayed).');
        }
      } catch (e) {
        logError('Failed to open session', e);
        void vscode.window.showErrorMessage(`Failed to open session: ${errorMessage(e)}`);
      }
    },

    'vac.loadMoreSessions': (agentName?: string) => (agentName ? tree.loadMore(agentName) : undefined),

    'vac.copySessionId': async (arg?: { sessionId?: string }) => {
      if (!arg?.sessionId) { return; }
      await vscode.env.clipboard.writeText(arg.sessionId);
      void vscode.window.showInformationMessage(`Copied session ID: ${arg.sessionId}`);
    },

    'vac.forgetSession': (arg?: { agentName?: string; sessionId?: string }) => {
      if (arg?.agentName && arg.sessionId) { history.forget(arg.agentName, arg.sessionId); }
    },

    'vac.addAgent': async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Agent name', placeHolder: 'my-agent', title: 'Add ACP Agent' });
      if (!name) { return; }
      const command = await vscode.window.showInputBox({ prompt: 'Command to launch the agent', placeHolder: 'npx', title: 'Agent Command' });
      if (!command) { return; }
      const argsText = await vscode.window.showInputBox({ prompt: 'Arguments (space-separated)', placeHolder: '-y @my-org/agent', title: 'Agent Arguments' });
      const { config, agents } = await readAgentsConfig();
      agents[name] = { command, args: argsText ? argsText.split(/\s+/) : [] };
      await config.update('agents', agents, vscode.ConfigurationTarget.Global);
      tree.refresh();
      void vscode.window.showInformationMessage(`Agent "${name}" added.`);
    },

    'vac.removeAgent': async (arg?: TreeArg) => {
      const { config, agents } = await readAgentsConfig();
      const names = Object.keys(agents);
      if (names.length === 0) {
        void vscode.window.showInformationMessage('No agents configured.');
        return;
      }
      const name = agentNameOf(arg) ?? await vscode.window.showQuickPick(names, {
        placeHolder: 'Select agent to remove',
        title: 'Remove ACP Agent',
      });
      if (!name) { return; }
      const confirm = await vscode.window.showWarningMessage(`Remove agent "${name}"?`, { modal: true }, 'Remove');
      if (confirm !== 'Remove') { return; }
      if (sessions.isAgentConnected(name)) { await sessions.disconnectAgent(name); }
      delete agents[name];
      await config.update('agents', agents, vscode.ConfigurationTarget.Global);
      tree.refresh();
      void vscode.window.showInformationMessage(`Agent "${name}" removed.`);
    },

    'vac.attachFile': async () => {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Attach', title: 'Attach File to Chat' });
      if (uris && uris.length > 0) { chat.attachFile(uris[0]); }
    },
  };

  return Object.entries(handlers).map(([id, handler]) => vscode.commands.registerCommand(id, handler));
}
