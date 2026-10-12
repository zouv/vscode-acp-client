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
import { TerminalHandler } from '../handlers/TerminalHandler';
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
  private readonly connections = new Map<string, ConnectionInfo>();

  constructor(
    private readonly sessionUpdates: SessionUpdateHandler,
    private readonly permissionBridge?: PermissionBridge,
    private readonly elicitationBridge?: ElicitationBridge,
  ) {}

  async connect(agentId: string, child: ChildProcess): Promise<ConnectionInfo> {
    if (!child.stdout || !child.stdin) {
      throw new Error('Agent process missing stdio streams');
    }
    log(`ConnectionManager: connecting to agent ${agentId}`);

    const stream = tapStream(ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ));

    const terminals = new TerminalHandler();
    const client = new AcpClientImpl({
      fs: new FileSystemHandler(),
      terminal: terminals,
      permission: new PermissionHandler(this.permissionBridge),
      sessionUpdate: this.sessionUpdates,
      elicitation: new ElicitationHandler(this.elicitationBridge),
    });
    const connection = new ClientSideConnection((agent: Agent) => {
      client.setAgent(agent);
      return client;
    }, stream);

    const initResponse = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'vscode-acp-client', version: readPackageVersion() || '0.0.0' },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        // Without this the Claude adapter disables AskUserQuestion outright; `url` mode is
        // deliberately undeclared because agents fail closed on modes the client never renders.
        elicitation: { form: {} },
      },
    });
    log(`ConnectionManager: initialized. Agent: ${initResponse.agentInfo?.name || 'unknown'} v${initResponse.agentInfo?.version || '?'}`);

    const meta = initResponse._meta as { steering?: { supported?: unknown } } | null | undefined;
    const supportsSteering = meta?.steering?.supported === true;
    log(`ConnectionManager: steering ${supportsSteering ? 'supported' : 'not supported'} by ${agentId}`);

    const info: ConnectionInfo = { agentId, connection, client, initResponse, terminals, supportsSteering };
    this.connections.set(agentId, info);
    return info;
  }

  getConnection(agentId: string): ConnectionInfo | undefined {
    return this.connections.get(agentId);
  }

  removeConnection(agentId: string): void {
    this.connections.get(agentId)?.terminals.killAll();
    this.connections.delete(agentId);
  }

  dispose(): void {
    for (const info of this.connections.values()) { info.terminals.dispose(); }
    this.connections.clear();
  }
}
