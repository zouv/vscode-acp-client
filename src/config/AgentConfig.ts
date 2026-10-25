import * as vscode from 'vscode';

import { migrateAgents } from '../agents/AgentMigration';
import { inferAgentKind, type AgentKind } from '../agents/AgentProfile';
import { log } from '../utils/Logger';

export interface AgentConfigEntry {
  kind?: AgentKind;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  displayName?: string;
}

export function getAgentConfigs(): Record<string, AgentConfigEntry> {
  return vscode.workspace.getConfiguration('vac').get<Record<string, AgentConfigEntry>>('agents', {});
}

export function getAgentConfig(name: string): AgentConfigEntry | undefined {
  return getAgentConfigs()[name];
}

export function getAgentKind(name: string): AgentKind {
  return inferAgentKind(name, getAgentConfig(name));
}

/** Configured agent names; the first Claude agent is pinned first, the rest keep their order. */
export function getAgentNames(): string[] {
  const configs = getAgentConfigs();
  const names = Object.keys(configs);
  const at = names.findIndex(n => inferAgentKind(n, configs[n]) === 'claude');
  if (at > 0) {
    const [primary] = names.splice(at, 1);
    names.unshift(primary);
  }
  return names;
}

export function primaryAgentName(): string | undefined {
  return getAgentNames()[0];
}

const MIGRATION_DISMISSED_KEY = 'vac.agentMigrationDismissed.v1';

/**
 * Offers to swap deprecated adapter packages in the user's own `vac.agents`
 * (the shipped default is already current). Each configured scope is rewritten in place.
 */
export async function offerAgentMigration(state: vscode.Memento): Promise<void> {
  if (state.get<boolean>(MIGRATION_DISMISSED_KEY)) { return; }
  const inspected = vscode.workspace.getConfiguration('vac').inspect<Record<string, AgentConfigEntry>>('agents');
  if (!inspected) { return; }
  const scopes: Array<[vscode.ConfigurationTarget, Record<string, AgentConfigEntry> | undefined]> = [
    [vscode.ConfigurationTarget.Global, inspected.globalValue],
    [vscode.ConfigurationTarget.Workspace, inspected.workspaceValue],
  ];
  const pending = scopes
    .map(([target, value]) => ({ target, result: value ? migrateAgents(value) : null }))
    .filter(p => p.result && p.result.changed.length > 0);
  if (pending.length === 0) { return; }

  const names = Array.from(new Set(pending.flatMap(p => p.result!.changed))).join(', ');
  const choice = await vscode.window.showInformationMessage(
    `VAC: ${names} uses a deprecated ACP adapter (@zed-industries/codex-acp). Switch to @agentclientprotocol/codex-acp?`,
    'Switch', 'Not now', "Don't ask again",
  );
  if (choice === "Don't ask again") { await state.update(MIGRATION_DISMISSED_KEY, true); return; }
  if (choice !== 'Switch') { return; }
  for (const { target, result } of pending) {
    await vscode.workspace.getConfiguration('vac').update('agents', result!.agents, target);
  }
  log(`Agent config migrated: ${names}`);
}
