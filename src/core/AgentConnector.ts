import type { AgentCapabilities } from '@agentclientprotocol/sdk';

import { getAgentConfigs } from '../config/AgentConfig';
import type { AgentManager } from './AgentManager';
import type { ConnectionInfo, ConnectionManager } from './ConnectionManager';
import type { AgentCapabilitySummary } from './types';

export interface ConnectorHooks {
  resolveCwd(): string;
  onConnected(agentName: string): void;
}

export function summarizeCapabilities(caps: AgentCapabilities | undefined | null): AgentCapabilitySummary {
  const sc = (caps as { sessionCapabilities?: Record<string, unknown> } | undefined | null)?.sessionCapabilities;
  return {
    list: !!sc?.list,
    load: !!(caps as { loadSession?: unknown } | undefined | null)?.loadSession,
    resume: !!sc?.resume,
    close: !!sc?.close,
    delete: !!sc?.delete,
    fork: !!sc?.fork,
    additionalDirectories: !!sc?.additionalDirectories,
    logout: !!(caps as { auth?: { logout?: unknown } } | undefined | null)?.auth?.logout,
  };
}

/**
 * Owns the agent-name ↔ process index, spawn-and-handshake de-duplication,
 * cached capabilities and the per-connection control-plane queue.
 */
export class AgentConnector {
  private readonly idByName = new Map<string, string>();
  private readonly nameById = new Map<string, string>();
  private readonly connecting = new Map<string, Promise<ConnectionInfo>>();
  private readonly capabilityCache = new Map<string, AgentCapabilitySummary>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly agents: AgentManager,
    private readonly connections: ConnectionManager,
    private readonly hooks: ConnectorHooks,
  ) {}

  isConnected(agentName: string): boolean { return this.idByName.has(agentName); }
  connectedNames(): string[] { return Array.from(this.idByName.keys()); }
  agentIdOf(agentName: string): string | undefined { return this.idByName.get(agentName); }
  nameOf(agentId: string): string | undefined { return this.nameById.get(agentId); }
  capabilities(agentName: string): AgentCapabilitySummary | undefined { return this.capabilityCache.get(agentName); }

  register(agentName: string, agentId: string): void {
    this.idByName.set(agentName, agentId);
    this.nameById.set(agentId, agentName);
  }

  /** Removes the indices and returns the process id so the caller can kill it. */
  detach(agentName: string): string | undefined {
    const agentId = this.idByName.get(agentName);
    this.idByName.delete(agentName);
    if (agentId) {
      this.nameById.delete(agentId);
      this.queues.delete(agentId);
    }
    return agentId;
  }

  /** Concurrent callers for one agent share a single spawn+handshake. */
  ensure(agentName: string, preferredCwd?: string): Promise<ConnectionInfo> {
    const inFlight = this.connecting.get(agentName);
    if (inFlight) { return inFlight; }
    const attempt = this.ensureOnce(agentName, preferredCwd).finally(() => this.connecting.delete(agentName));
    this.connecting.set(agentName, attempt);
    return attempt;
  }

  /** Control-plane RPCs (new/load/resume/close) run one at a time per connection; prompts stay concurrent. */
  enqueue<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(agentId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(agentId, next.catch(() => undefined));
    return next;
  }

  clear(): void {
    this.idByName.clear();
    this.nameById.clear();
    this.connecting.clear();
    this.queues.clear();
  }

  private async ensureOnce(agentName: string, preferredCwd?: string): Promise<ConnectionInfo> {
    const known = this.idByName.get(agentName);
    if (known) {
      const conn = this.connections.getConnection(known);
      if (conn) { return this.remember(agentName, conn); }
      this.detach(agentName);
    }

    for (const instance of this.agents.getRunningAgents()) {
      if (instance.name !== agentName) { continue; }
      const conn = this.connections.getConnection(instance.id);
      if (conn) {
        this.register(agentName, instance.id);
        return this.remember(agentName, conn);
      }
    }

    const config = getAgentConfigs()[agentName];
    if (!config) { throw new Error(`Unknown agent: ${agentName}.`); }

    const instance = this.agents.spawnAgent(agentName, config, preferredCwd || this.hooks.resolveCwd());
    let conn: ConnectionInfo;
    try {
      conn = await this.connections.connect(instance.id, instance.process);
    } catch (e) {
      this.agents.killAgent(instance.id);
      throw e;
    }
    this.register(agentName, instance.id);
    this.remember(agentName, conn);
    this.hooks.onConnected(agentName);
    return conn;
  }

  private remember(agentName: string, conn: ConnectionInfo): ConnectionInfo {
    this.capabilityCache.set(agentName, summarizeCapabilities(conn.initResponse.agentCapabilities));
    return conn;
  }
}
