import * as vscode from 'vscode';

import { inferAgentKind, type AgentKind } from '../agents/AgentProfile';

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
