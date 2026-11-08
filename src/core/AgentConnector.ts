import type { AgentCapabilities } from '@agentclientprotocol/sdk';

import { abortable } from '../utils/Abortable';
import { DeadlineExceededError, withDeadline } from '../utils/AsyncDeadline';
import { getAgentConfigs } from '../config/AgentConfig';
import type { AgentManager } from './AgentManager';
import type { ConnectionInfo, ConnectionManager } from './ConnectionManager';
import type { AgentCapabilitySummary } from './types';

/**
 * Per-task deadline of the control-plane queue: when it passes, the caller's promise rejects
 * with `DeadlineExceededError` and the queue moves on (the RPC itself may still answer later).
 */
export const CONTROL_PLANE_TIMEOUT_MS = 60_000;
/** `session/load` replays the whole history before answering, so it gets longer. */
export const SESSION_LOAD_TIMEOUT_MS = 300_000;
/** session/close is best-effort (the session is already gone locally): don't let it hold the queue long. */
export const SESSION_CLOSE_TIMEOUT_MS = 15_000;

export interface EnqueueOptions {
  timeoutMs?: number;
  label?: string;
}

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
  private readonly connecting = new Map<string, { promise: Promise<ConnectionInfo>; controller: AbortController; agentId?: string }>();
  private disposed = false;
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
    if (this.disposed) { return Promise.reject(new Error('Agent connector is disposed.')); }
    const inFlight = this.connecting.get(agentName);
    if (inFlight) { return inFlight.promise; }
    const controller = new AbortController();
    const attempt = { promise: undefined as unknown as Promise<ConnectionInfo>, controller, agentId: undefined as string | undefined };
    this.connecting.set(agentName, attempt);
    attempt.promise = abortable(controller.signal, () => this.ensureOnce(agentName, preferredCwd, attempt)).finally(() => {
      if (this.connecting.get(agentName) === attempt) { this.connecting.delete(agentName); }
    });
    return attempt.promise;
  }

  cancel(agentName: string): boolean {
    const attempt = this.connecting.get(agentName);
    if (!attempt) { return false; }
    this.connecting.delete(agentName);
    attempt.controller.abort();
    if (attempt.agentId) {
      this.connections.removeConnection(attempt.agentId);
      this.agents.killAgent(attempt.agentId);
    }
    return true;
  }

  /**
   * Control-plane RPCs (new/load/resume/close/delete/fork) run one at a time per connection;
   * prompts stay concurrent. Each task has a deadline measured from when it starts, so one
   * hung RPC cannot block every later one. Keep interactive UI (auth dialogs) out of tasks.
   */
  enqueue<T>(agentId: string, task: (expired: AbortSignal) => Promise<T>, opts: EnqueueOptions = {}): Promise<T> {
    const prev = this.queues.get(agentId) ?? Promise.resolve();
    const run = () => {
      if (this.disposed || !this.nameById.has(agentId) || !this.connections.getConnection(agentId)) {
        throw new Error('Agent connection cancelled.');
      }
      // `expired` aborts once the caller has been rejected, so a late answer can skip its side effects.
      const expired = new AbortController();
      return withDeadline(() => task(expired.signal), opts.timeoutMs ?? CONTROL_PLANE_TIMEOUT_MS, opts.label ?? 'ACP control-plane request')
        .catch((error: unknown) => {
          if (error instanceof DeadlineExceededError) { expired.abort(error); }
          throw error;
        });
    };
    const next = prev.then(run, run);
    this.queues.set(agentId, next.catch(() => undefined));
    return next;
  }

  clear(): void {
    this.idByName.clear();
    this.nameById.clear();
    this.disposed = true;
    for (const name of Array.from(this.connecting.keys())) { this.cancel(name); }
    this.connecting.clear();
    this.capabilityCache.clear();
    this.queues.clear();
  }

  private async ensureOnce(agentName: string, preferredCwd: string | undefined, attempt: { controller: AbortController; agentId?: string }): Promise<ConnectionInfo> {
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
    attempt.agentId = instance.id;
    let conn: ConnectionInfo;
    try {
      conn = await this.connections.connect(instance.id, instance.process, attempt.controller.signal);
    } catch (e) {
      this.agents.killAgent(instance.id);
      throw e;
    }
    if (attempt.controller.signal.aborted || this.disposed) {
      this.connections.removeConnection(instance.id);
      this.agents.killAgent(instance.id);
      throw new Error('Agent connection cancelled.');
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
