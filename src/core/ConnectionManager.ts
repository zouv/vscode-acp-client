import * as vscode from 'vscode';
import { withDeadline } from '../utils/AsyncDeadline';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type InitializeResponse,
  type Stream,
} from '@agentclientprotocol/sdk';

import { ElicitationHandler } from '../handlers/ElicitationHandler';
import type { ElicitationBridge } from '../handlers/ElicitationBridge';
import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { PermissionHandler } from '../handlers/PermissionHandler';
import type { PermissionBridge } from '../handlers/PermissionBridge';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { TerminalHandler, newRetainedTerminalPool } from '../handlers/TerminalHandler';
import { log, logError, logTraffic } from '../utils/Logger';
import { readPackageVersion } from '../utils/BuildInfo';
import { AcpClientImpl } from './AcpClientImpl';

export interface ConnectionInfo {
  agentId: string;
  connection: ClientSideConnection;
  client: AcpClientImpl;
  initResponse: InitializeResponse;
  terminals: TerminalHandler;
  /** `_session/steering` is advertised in `initialize._meta.steering.supported`. */
  supportsSteering: boolean;
}

/**
 * After the SDK closes a connection we wait this long before declaring it lost, so a
 * process that is exiting anyway reports through `agent-closed` (with its exit code) first.
 */
export const CONNECTION_LOST_GRACE_MS = 500;

export type ConnectionLostListener = (agentId: string, reason: unknown) => void;

function tapStream(stream: Stream): Stream {
  const send = new TransformStream({
    transform(chunk: unknown, controller) {
      logTraffic('send', chunk);
      controller.enqueue(chunk);
    },
  });
  const recv = new TransformStream({
    transform(chunk: unknown, controller) {
      logTraffic('recv', chunk);
      controller.enqueue(chunk);
    },
  });
  void send.readable.pipeTo(stream.writable).catch(e => logError('traffic tap (send) closed', e));
  void stream.readable.pipeTo(recv.writable).catch(e => logError('traffic tap (recv) closed', e));
  return { writable: send.writable, readable: recv.readable };
}

/** Builds an ACP `ClientSideConnection` per agent process and runs the `initialize` handshake. */
export class ConnectionManager {
  private disposed = false;
  private readonly pendingTerminals = new Map<string, TerminalHandler>();
  /** Released/retired VS Code terminals of every connection, capped (see RETAINED_TERMINAL_CAP). */
  private readonly retainedTerminals = newRetainedTerminalPool();
  private readonly connections = new Map<string, ConnectionInfo>();
  private readonly lostListeners = new Set<ConnectionLostListener>();

  constructor(
    private readonly sessionUpdates: SessionUpdateHandler,
    private readonly permissionBridge?: PermissionBridge,
    private readonly elicitationBridge?: ElicitationBridge,
    private readonly options: { initializeTimeoutMs?: number } = {},
  ) {}

  async connect(agentId: string, child: ChildProcess, signal?: AbortSignal): Promise<ConnectionInfo> {
    if (this.disposed) { throw new Error('Connection manager is disposed.'); }
    this.sessionUpdates.activateAgent(agentId);
    if (!child.stdout || !child.stdin) {
      throw new Error('Agent process missing stdio streams');
    }
    log(`ConnectionManager: connecting to agent ${agentId}`);

    const stream = tapStream(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));

    const terminals = new TerminalHandler(this.retainedTerminals);
    this.pendingTerminals.set(agentId, terminals);
    const client = new AcpClientImpl({
      fs: new FileSystemHandler(),
      terminal: terminals,
      permission: new PermissionHandler(this.permissionBridge),
      sessionUpdate: this.sessionUpdates,
      elicitation: new ElicitationHandler(this.elicitationBridge),
    }, agentId);
    const connection = new ClientSideConnection((agent: Agent) => {
      client.setAgent(agent);
      return client;
    }, stream);

    try {
      const configured = vscode.workspace.getConfiguration('vac').get<number>('connectionTimeoutMs', 60_000);
      const timeoutMs = this.options.initializeTimeoutMs ?? (Number.isFinite(configured) ? Math.max(1_000, Math.min(300_000, configured)) : 60_000);
      const initResponse = await withDeadline(() => connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'vscode-acp-client', version: readPackageVersion() || '0.0.0' },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          // Without this the Claude adapter disables AskUserQuestion outright; `url` mode is
          // deliberately undeclared because agents fail closed on modes the client never renders.
          elicitation: { form: {} },
          // Draft (agent-client-protocol #1992): the adapter then reports each Claude Code
          // sub-agent as a child session (`subagent_update`), which we surface as a card.
          subagents: {},
          // The composer renders boolean options; without this agents must not send any.
          // Declaring compaction makes Claude replay a compact summary as
          // `compaction_update` instead of a user_message_chunk (a 64KB user bubble).
          session: { configOptions: { boolean: {} }, compaction: {} },
          // [CUSTOM- Agent map (2026-11-09): the adapter then enriches every
          // `subagent_update` with `_meta["vac/agentMap"]` (times, tokens, tool count,
          // summary). Without it the map still works from the RFD body, just sparser.
          _meta: { 'vac/agentMap': true },
        },
      }), timeoutMs, 'ACP initialize', signal);
      log(`ConnectionManager: initialized. Agent: ${initResponse.agentInfo?.name || 'unknown'} v${initResponse.agentInfo?.version || '?'}`);

      const meta = initResponse._meta as { steering?: { supported?: unknown } } | null | undefined;
      const supportsSteering = meta?.steering?.supported === true;
      log(`ConnectionManager: steering ${supportsSteering ? 'supported' : 'not supported'} by ${agentId}`);

      if (this.disposed || this.pendingTerminals.get(agentId) !== terminals) {
        throw new Error('Agent connection cancelled.');
      }
      const info: ConnectionInfo = { agentId, connection, client, initResponse, terminals, supportsSteering };
      this.connections.set(agentId, info);
      this.watchClose(info);
      return info;
    } catch (error) {
      terminals.dispose();
      this.sessionUpdates.releaseAgent(agentId);
      throw error;
    } finally {
      if (this.pendingTerminals.get(agentId) === terminals) { this.pendingTerminals.delete(agentId); }
    }
  }

  /**
   * Fires when the SDK closed a registered connection by itself (stream error, a message over
   * its size limit) while nobody removed it: every RPC on it now fails, so the owner has to
   * treat the agent as gone even though its process may still be alive.
   */
  onConnectionLost(listener: ConnectionLostListener): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  private watchClose(info: ConnectionInfo): void {
    const signal = info.connection.signal as AbortSignal | undefined;
    if (!signal) { return; }
    const lost = () => {
      const timer = setTimeout(() => {
        if (this.disposed || this.connections.get(info.agentId) !== info) { return; }
        logError(`ConnectionManager: ACP connection to ${info.agentId} closed underneath a live registration`, signal.reason);
        for (const listener of Array.from(this.lostListeners)) {
          try { listener(info.agentId, signal.reason); } catch (e) { logError('connection-lost listener failed', e); }
        }
      }, CONNECTION_LOST_GRACE_MS);
      timer.unref?.();
    };
    if (signal.aborted) { lost(); } else { signal.addEventListener('abort', lost, { once: true }); }
  }

  getConnection(agentId: string): ConnectionInfo | undefined {
    return this.connections.get(agentId);
  }

  removeConnection(agentId: string): void {
    this.sessionUpdates.releaseAgent(agentId);
    this.pendingTerminals.get(agentId)?.dispose();
    this.pendingTerminals.delete(agentId);
    const terminals = this.connections.get(agentId)?.terminals;
    terminals?.retire();
    this.connections.delete(agentId);
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const [agentId, terminals] of this.pendingTerminals) {
      terminals.dispose();
      this.sessionUpdates.releaseAgent(agentId);
    }
    this.pendingTerminals.clear();
    this.retainedTerminals.clear();
    for (const info of this.connections.values()) {
      info.terminals.dispose();
      this.sessionUpdates.releaseAgent(info.agentId);
    }
    this.connections.clear();
    this.lostListeners.clear();
  }
}
