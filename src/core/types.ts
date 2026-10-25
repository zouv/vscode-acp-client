import type {
  AvailableCommand,
  InitializeResponse,
  SessionConfigOption,
  SessionModeState,
} from '@agentclientprotocol/sdk';

export interface SessionModelState {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string; description?: string | null }>;
}

export interface SessionInfo {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  cwd: string;
  additionalDirectories?: string[];
  createdAt: string;
  initResponse: InitializeResponse;
  modes: SessionModeState | null;
  models: SessionModelState | null;
  configOptions: SessionConfigOption[] | null;
  availableCommands: AvailableCommand[];
  title?: string;
}

export interface AgentCapabilitySummary {
  list: boolean;
  load: boolean;
  resume: boolean;
  close: boolean;
  delete: boolean;
  fork: boolean;
  additionalDirectories: boolean;
  /** `logout` (advertised as `agentCapabilities.auth.logout`). */
  logout: boolean;
}

export type SessionCloseReason = 'user' | 'agent-disconnected';

export type SessionOrigin = 'new' | 'load' | 'resume';

export type AgentConnectionError =
  | { kind: 'auth-cancelled' }
  | { kind: 'connect-failed'; message: string };
