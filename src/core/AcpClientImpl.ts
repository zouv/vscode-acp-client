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

  constructor(private readonly handlers: ClientHandlers) {}

  setAgent(agent: Agent): void { this.agent = agent; }
  getAgent(): Agent | null { return this.agent; }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.handlers.permission.requestPermission(params);
  }

  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    return this.handlers.elicitation.create(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.handlers.sessionUpdate.handleUpdate(params);
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.handlers.fs.readTextFile(params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.handlers.fs.writeTextFile(params);
  }

  createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    return this.handlers.terminal.createTerminal(params);
  }

  terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    return this.handlers.terminal.terminalOutput(params);
  }

  waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    return this.handlers.terminal.waitForTerminalExit(params);
  }

  killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    return this.handlers.terminal.killTerminal(params);
  }

  releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    return this.handlers.terminal.releaseTerminal(params);
  }
}
