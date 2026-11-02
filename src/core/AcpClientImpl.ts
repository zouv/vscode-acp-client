import type {
  Agent,
  Client,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import type { ElicitationHandler } from '../handlers/ElicitationHandler';
import type { FileSystemHandler } from '../handlers/FileSystemHandler';
import type { PermissionHandler } from '../handlers/PermissionHandler';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import type { TerminalHandler } from '../handlers/TerminalHandler';

export interface ClientHandlers {
  fs: FileSystemHandler;
  terminal: TerminalHandler;
  permission: PermissionHandler;
  sessionUpdate: SessionUpdateHandler;
  elicitation: ElicitationHandler;
}

/** Pure delegation: one ACP `Client` per connection, one handler per capability. */
export class AcpClientImpl implements Client {
  private agent: Agent | null = null;

  constructor(private readonly handlers: ClientHandlers, private readonly agentId?: string) {}

  private verifySession(sessionId: string): void {
    if (!this.handlers.sessionUpdate.accepts(sessionId, this.agentId)) {
      throw new Error('Session id belongs to another agent connection.');
    }
  }

  setAgent(agent: Agent): void { this.agent = agent; }
  getAgent(): Agent | null { return this.agent; }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.verifySession(params.sessionId);
    return this.handlers.permission.requestPermission(params);
  }

  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const sessionId = (params as { sessionId?: string }).sessionId;
    if (sessionId) { this.verifySession(sessionId); }
    return this.handlers.elicitation.create(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.handlers.sessionUpdate.handleUpdate(params, this.agentId);
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.verifySession(params.sessionId);
    return this.handlers.fs.readTextFile(params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    this.verifySession(params.sessionId);
    return this.handlers.fs.writeTextFile(params);
  }

  createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    this.verifySession(params.sessionId);
    return this.handlers.terminal.createTerminal(params);
  }

  terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    this.verifySession(params.sessionId);
    return this.handlers.terminal.terminalOutput(params);
  }

  waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    this.verifySession(params.sessionId);
    return this.handlers.terminal.waitForTerminalExit(params);
  }

  killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    this.verifySession(params.sessionId);
    return this.handlers.terminal.killTerminal(params);
  }

  releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    this.verifySession(params.sessionId);
    return this.handlers.terminal.releaseTerminal(params);
  }
}
