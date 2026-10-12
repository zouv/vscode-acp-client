import * as vscode from 'vscode';
import { EventEmitter } from 'node:events';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type {
  AvailableCommand,
  ContentBlock,
  NewSessionResponse,
  PromptResponse,
  SessionConfigOption,
  SessionInfo as ProtocolSessionInfo,
} from '@agentclientprotocol/sdk';

import { profileFor } from '../agents/AgentProfile';
import { getAgentConfigs, getAgentKind } from '../config/AgentConfig';
import { readCustomModels } from '../config/CustomModels';
import type { ElicitationBridge } from '../handlers/ElicitationBridge';
import type { PermissionBridge } from '../handlers/PermissionBridge';
import { log, logError } from '../utils/Logger';
import { AgentConnector } from './AgentConnector';
import type { AgentManager } from './AgentManager';
import { isAuthRequiredError, runAuthFlow } from './auth';
import type { ConnectionInfo, ConnectionManager } from './ConnectionManager';
import { pickDefaultCwd } from './cwd';
import type { SessionHistoryStore } from './SessionHistoryStore';
import { PendingSessionState, SessionStore } from './SessionStore';
import type {
  AgentCapabilitySummary,
  SessionCloseReason,
  SessionInfo,
  SessionOrigin,
} from './types';
import type { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';

export { pickDefaultCwd } from './cwd';
export type {
  AgentCapabilitySummary,
  AgentConnectionError,
  SessionCloseReason,
  SessionInfo,
  SessionModelState,
} from './types';

const NOT_FOUND = /not found|no such|unknown session/i;

const toBlocks = (prompt: string | ContentBlock[]): ContentBlock[] =>
  typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;

/**
 * Orchestrates N agent processes × M ACP sessions.
 *
 * Events: agent-connected, agent-disconnected, agent-error, agent-stderr,
 * agent-closed, active-session-changed(sessionId|null, agentName|null),
 * session-created(sessionId, agentName, origin), session-closed(sessionId, agentName, reason),
 * turn-state-changed(sessionId, running), session-load-start/end, mode-changed, model-changed, config-options-changed,
 * available-commands-changed, session-info-changed.
 *
 * `activeSessionId` means "the focused session" — the one the chat panel shows.
 */
export class SessionManager extends EventEmitter {
  private readonly store = new SessionStore();
  private readonly pending = new PendingSessionState();
  private readonly connector: AgentConnector;
  private readonly inFlightTurns = new Set<string>();
  private readonly loadingSessionIds = new Set<string>();
  private historyStore: SessionHistoryStore | null = null;
  private permissionBridge: PermissionBridge | null = null;
  private elicitationBridge: ElicitationBridge | null = null;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly connectionManager: ConnectionManager,
    _sessionUpdateHandler?: SessionUpdateHandler,
  ) {
    super();
    this.connector = new AgentConnector(agentManager, connectionManager, {
      resolveCwd: () => this.resolveDefaultCwd(),
      onConnected: agentName => this.emit('agent-connected', agentName),
    });

    agentManager.on('agent-error', (evt: { agentId: string; error: Error }) => {
      const agentName = this.connector.nameOf(evt.agentId);
      logError(`Agent ${agentName ?? evt.agentId} error`, evt.error);
      this.emit('agent-error', evt.agentId, evt.error, agentName);
    });
    agentManager.on('agent-stderr', (evt: { agentId: string; line: string }) => {
      this.emit('agent-stderr', evt);
    });
    agentManager.on('agent-closed', (evt: { agentId: string; code: number | null; name?: string }) => {
      const agentName = this.connector.nameOf(evt.agentId) ?? evt.name;
      log(`Agent ${agentName ?? evt.agentId} closed with code ${evt.code}`);
      // disconnectAgent() deregisters before killing, so a deliberate kill does not tear down twice
      if (agentName && this.connector.agentIdOf(agentName) === evt.agentId) {
        this.teardownAgent(agentName, false);
      }
      this.emit('agent-closed', evt.agentId, evt.code, agentName);
    });
  }

  setHistoryStore(store: SessionHistoryStore): void { this.historyStore = store; }
  setPermissionBridge(bridge: PermissionBridge): void { this.permissionBridge = bridge; }
  setElicitationBridge(bridge: ElicitationBridge): void { this.elicitationBridge = bridge; }
  getHistoryStore(): SessionHistoryStore | null { return this.historyStore; }

  getCachedCapabilities(agentName: string): AgentCapabilitySummary | undefined {
    return this.connector.capabilities(agentName);
  }

  /** `vac.defaultWorkingDirectory`, else the first workspace folder, else `process.cwd()`. */
  resolveDefaultCwd(): string {
    const decision = pickDefaultCwd(
      vscode.workspace.getConfiguration('vac').get<string>('defaultWorkingDirectory'),
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      process.cwd(),
      candidate => existsSync(candidate) && statSync(candidate).isDirectory(),
    );
    if (decision.ignoredConfigured) {
      log(`SessionManager: ignoring vac.defaultWorkingDirectory (${decision.ignoredConfigured})`);
    }
    return decision.cwd;
  }

  // --- Focus & bookkeeping -------------------------------------------------

  focusSession(sessionId: string | null, opts: { force?: boolean } = {}): void {
    if (!this.store.focus(sessionId, opts.force)) { return; }
    const agentName = sessionId ? (this.store.get(sessionId)?.agentName ?? null) : null;
    this.emit('active-session-changed', sessionId, agentName);
  }

  /** Test seam: registers an already-built session as live without any agent process. */
  seedSession(session: SessionInfo): void {
    this.registerSession(session);
    this.connector.register(session.agentName, session.agentId);
  }

  private registerSession(session: SessionInfo): void {
    this.store.add(session);
    this.pending.drainInto(session);
    this.syncLiveSessions(session.agentName);
  }

  private syncLiveSessions(agentName: string): void {
    this.historyStore?.setLiveSessions(agentName, this.store.idsForAgent(agentName));
  }

  private removeSession(sessionId: string, reason: SessionCloseReason): void {
    const wasFocused = this.store.focusedId === sessionId;
    const session = this.store.remove(sessionId);
    if (!session) { return; }
    this.inFlightTurns.delete(sessionId);
    this.loadingSessionIds.delete(sessionId);
    this.syncLiveSessions(session.agentName);
    this.emit('session-closed', sessionId, session.agentName, reason);
    if (wasFocused) { this.focusSession(this.store.mostRecentLiveId(), { force: true }); }
  }

  private teardownAgent(agentName: string, kill: boolean): void {
    const agentId = this.connector.detach(agentName);
    for (const sessionId of this.store.idsForAgent(agentName)) {
      this.removeSession(sessionId, 'agent-disconnected');
    }
    if (kill && agentId) {
      this.agentManager.killAgent(agentId);
      this.connectionManager.removeConnection(agentId);
    } else if (agentId) {
      this.connectionManager.removeConnection(agentId);
    }
    this.emit('agent-disconnected', agentName);
    this.focusSession(this.store.mostRecentLiveId());
  }

  // --- Connection + session lifecycle --------------------------------------

  /** Reuses the agent's newest live session, otherwise creates one. */
  async connectToAgent(agentName: string, opts: { focus?: boolean } = {}): Promise<SessionInfo> {
    const { focus = true } = opts;
    const live = this.getSessionIdsForAgent(agentName);
    if (live.length > 0) {
      const sessionId = live[live.length - 1];
      this.focusSession(sessionId, { force: focus });
      return this.store.get(sessionId)!;
    }
    return this.createSession(agentName, { focus });
  }

  async createSession(
    agentName: string,
    opts: { focus?: boolean; cwd?: string; additionalDirectories?: string[] } = {},
  ): Promise<SessionInfo> {
    const { focus = true, additionalDirectories = [] } = opts;
    const cwd = opts.cwd || this.resolveDefaultCwd();

    const configs = getAgentConfigs();
    if (!configs[agentName]) {
      throw new Error(`Unknown agent: ${agentName}. Available: ${Object.keys(configs).join(', ')}`);
    }
    log(`SessionManager: creating session for agent "${agentName}" in ${cwd}`);

    const conn = await this.ensureConnected(agentName, cwd);
    const agentId = this.agentIdFor(conn, agentName);
    const session = await this.connector.enqueue(
      agentId,
      () => this.newAcpSession(agentName, agentId, conn, cwd, additionalDirectories),
    );

    this.emit('session-created', session.sessionId, agentName, 'new' satisfies SessionOrigin);
    if (focus) { this.focusSession(session.sessionId); }
    log(`Created session ${session.sessionId} for agent ${agentName}`);
    return session;
  }

  /** Opens an additional session; existing ones stay alive in their tabs. */
  async newConversation(agentName?: string): Promise<SessionInfo | null> {
    const target = agentName ?? this.getActiveAgentName();
    if (!target) { return null; }
    return this.createSession(target, { focus: true });
  }

  /** Closes one session; the agent process and sibling sessions stay alive. */
  async closeSession(agentName: string, sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session || session.agentName !== agentName) { return; }

    // An in-flight turn must be cancelled first so pending permission requests get answered
    if (this.isTurnInFlight(sessionId)) {
      try {
        await this.cancelTurn(sessionId);
      } catch (e) {
        logError(`cancel before close failed for ${sessionId} (closing anyway)`, e);
      }
    }

    if (this.getCachedCapabilities(agentName)?.close) {
      const conn = this.connectionManager.getConnection(session.agentId);
      if (conn) {
        try {
          await this.connector.enqueue(session.agentId, () => conn.connection.closeSession({ sessionId }));
        } catch (e) {
          logError(`session/close failed for ${sessionId} (continuing with local teardown)`, e);
        }
      }
    }

    log(`Closing session ${sessionId} of agent ${agentName}`);
    this.removeSession(sessionId, 'user');
  }

  async disconnectAgent(agentName: string): Promise<void> {
    if (!this.connector.isConnected(agentName) && !this.store.hasAgent(agentName)) { return; }
    log(`Disconnecting agent ${agentName}`);
    this.teardownAgent(agentName, true);
  }

  async ensureConnected(agentName: string, preferredCwd?: string): Promise<ConnectionInfo> {
    return this.connector.ensure(agentName, preferredCwd);
  }

  // --- Prompting -------------------------------------------------------------

  async sendPrompt(sessionId: string, prompt: string | ContentBlock[]): Promise<PromptResponse> {
    const session = this.requireSession(sessionId);
    const conn = this.requireConnection(session);
    if (this.inFlightTurns.has(sessionId)) {
      throw new Error('A turn is already running for this session. Cancel it before sending another prompt.');
    }
    const blocks = toBlocks(prompt);
    log(`sendPrompt: session=${sessionId}, blocks=${blocks.length}`);

    this.inFlightTurns.add(sessionId);
    this.emit('turn-state-changed', sessionId, true);
    try {
      const response = await conn.connection.prompt({ sessionId, prompt: blocks });
      log(`Prompt response: stopReason=${response.stopReason}`);
      return response;
    } finally {
      this.inFlightTurns.delete(sessionId);
      this.emit('turn-state-changed', sessionId, false);
    }
  }

  supportsSteering(sessionId: string): boolean {
    const session = this.store.get(sessionId);
    return !!session && this.connectionManager.getConnection(session.agentId)?.supportsSteering === true;
  }

  hasRunningTurn(sessionId: string): boolean { return this.inFlightTurns.has(sessionId); }
  isTurnInFlight(sessionId: string): boolean { return this.inFlightTurns.has(sessionId); }

  /**
   * Injects a message into the running turn (`_session/steering`, an agreed but
   * unpublished extension). Returns 'idle' when the agent says no turn was
   * running so the caller can fall back to a normal prompt instead of dropping it.
   */
  async steerPrompt(sessionId: string, prompt: string | ContentBlock[]): Promise<'steered' | 'idle'> {
    const session = this.requireSession(sessionId);
    const conn = this.requireConnection(session);
    if (!conn.supportsSteering) { throw new Error('This agent does not support steering.'); }

    const blocks = toBlocks(prompt);
    log(`steerPrompt: session=${sessionId}, blocks=${blocks.length}`);
    const result = await conn.connection.extMethod('_session/steering', {
      sessionId,
      prompt: blocks,
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    });
    const outcome = (result as { outcome?: unknown } | null | undefined)?.outcome;
    log(`steerPrompt: outcome=${String(outcome ?? 'steered')}`);
    return outcome === 'promptRequired' ? 'idle' : 'steered';
  }

  async cancelTurn(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) { return; }
    // ACP: pending permission/form requests of a cancelled session must be answered or the agent hangs
    this.permissionBridge?.cancelSession(sessionId);
    this.elicitationBridge?.cancelSession(sessionId);

    const conn = this.connectionManager.getConnection(session.agentId);
    if (!conn) { return; }
    log(`Cancelling turn for session ${sessionId}`);
    await conn.connection.cancel({ sessionId });
  }

  // --- Session settings ------------------------------------------------------

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) { return; }

    const modeOption = session.configOptions?.find(o => o.category === 'mode');
    if (modeOption) {
      await this.setConfigOption(sessionId, modeOption.id, modeId);
      return;
    }
    const conn = this.connectionManager.getConnection(session.agentId);
    if (!conn) { return; }
    await conn.connection.setSessionMode({ sessionId, modeId });
    if (session.modes) { session.modes.currentModeId = modeId; }
    this.emit('mode-changed', sessionId, modeId);
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) { return; }

    const modelOption = session.configOptions?.find(o => o.category === 'model');
    if (modelOption) {
      await this.setConfigOption(sessionId, modelOption.id, modelId);
      return;
    }
    // ACP SDK 1.x dropped the dedicated model API; only old agents without a model config option land here
    const conn = this.connectionManager.getConnection(session.agentId);
    if (!conn) { return; }
    const legacy = (conn.connection as unknown as {
      unstable_setSessionModel?: (p: { sessionId: string; modelId: string }) => Promise<unknown>;
    }).unstable_setSessionModel;
    if (typeof legacy !== 'function') {
      log(`SessionManager: agent "${session.agentId}" has no model config option and no legacy setSessionModel — cannot switch to ${modelId}`);
      return;
    }
    await legacy.call(conn.connection, { sessionId, modelId });
    if (session.models) { session.models.currentModelId = modelId; }
    this.emit('model-changed', sessionId, modelId);
  }

  /** The agent answers with the full option list (changing a model can cascade into other options). */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SessionConfigOption[] | null> {
    const session = this.store.get(sessionId);
    const conn = session && this.connectionManager.getConnection(session.agentId);
    if (!session || !conn) { return null; }

    const response = await conn.connection.setSessionConfigOption({ sessionId, configId, value });
    const options = (response as { configOptions?: SessionConfigOption[] } | null)?.configOptions ?? null;
    this.applyConfigOptions(sessionId, options);
    return options;
  }

  applyConfigOptions(sessionId: string, options: SessionConfigOption[] | null): void {
    const session = this.store.get(sessionId);
    if (!session) {
      this.pending.setConfig(sessionId, options ?? []);
      return;
    }
    session.configOptions = options ?? null;
    // The mode option is authoritative for "which mode"; keep legacy `modes` in step
    const modeOption = (options ?? []).find(o => (o as { category?: unknown }).category === 'mode');
    const current = (modeOption as { currentValue?: unknown } | undefined)?.currentValue;
    if (session.modes && current !== undefined && current !== null) {
      session.modes.currentModeId = String(current);
    }
    this.emit('config-options-changed', sessionId, session.configOptions);
  }

  applyAvailableCommands(sessionId: string, commands: AvailableCommand[]): void {
    const session = this.store.get(sessionId);
    if (!session) {
      this.pending.setCommands(sessionId, commands);
      return;
    }
    session.availableCommands = commands;
    this.emit('available-commands-changed', sessionId, commands);
  }

  applySessionInfoUpdate(sessionId: string, update: { title?: string | null; updatedAt?: string | null }): void {
    const session = this.store.get(sessionId);
    if (session) {
      if (update.title === null) {
        delete session.title;
      } else if (typeof update.title === 'string') {
        session.title = update.title;
      }
      this.historyStore?.setTitle(session.agentName, sessionId, update.title);
    } else if (typeof update.title === 'string') {
      this.pending.setTitle(sessionId, update.title);
    }
    this.emit('session-info-changed', sessionId, update);
  }

  recordFirstPrompt(sessionId: string, prompt: string): void {
    const session = this.store.get(sessionId);
    if (session) { this.historyStore?.setFirstPromptIfMissing(session.agentName, sessionId, prompt); }
  }

  touchHistory(sessionId: string): void {
    const session = this.store.get(sessionId);
    if (session) { this.historyStore?.touch(session.agentName, sessionId); }
  }

  // --- Existing sessions -----------------------------------------------------

  /** ACP `session/list`; throws when the agent does not advertise it. */
  async listSessions(
    agentName: string,
    opts: { cwd?: string; cursor?: string } = {},
  ): Promise<{ sessions: ProtocolSessionInfo[]; nextCursor?: string }> {
    const conn = await this.ensureConnected(agentName);
    if (!this.getCachedCapabilities(agentName)?.list) {
      throw new Error(`Agent "${agentName}" does not support session/list.`);
    }
    const params: { cwd?: string; cursor?: string } = {};
    if (opts.cwd) { params.cwd = opts.cwd; }
    if (opts.cursor) { params.cursor = opts.cursor; }

    let response: { sessions?: ProtocolSessionInfo[]; nextCursor?: string | null } | undefined;
    try {
      response = await conn.connection.listSessions(params);
    } catch (e) {
      if (!isAuthRequiredError(e)) { throw e; }
      await runAuthFlow(agentName, conn);
      response = await conn.connection.listSessions(params);
    }

    const sessions = response?.sessions ?? [];
    if (this.historyStore && !opts.cursor) {
      this.historyStore.reconcileFromAgent(
        agentName,
        new Set(sessions.map(s => s.sessionId)),
        this.getSessionIdsForAgent(agentName),
      );
    }
    return { sessions, nextCursor: response?.nextCursor ?? undefined };
  }

  /**
   * The single decision point for "open a session that already exists": live ->
   * focus, else `session/load` (replays history) when supported, else resume.
   * Connects on demand because capabilities only exist after `initialize`.
   */
  async openExistingSession(
    agentName: string,
    sessionId: string,
    opts: { cwd?: string; title?: string } = {},
  ): Promise<'live' | 'load' | 'resume'> {
    const existing = this.store.get(sessionId);
    if (existing) {
      if (opts.title && !existing.title) { existing.title = opts.title; }
      this.focusSession(sessionId, { force: true });
      return 'live';
    }
    await this.ensureConnected(agentName, opts.cwd);
    const caps = this.getCachedCapabilities(agentName);
    if (caps?.load) {
      await this.loadSession(agentName, sessionId, opts.cwd, opts.title);
      return 'load';
    }
    if (caps?.resume) {
      await this.resumeSession(agentName, sessionId, opts.cwd, opts.title);
      return 'resume';
    }
    throw new Error(`Agent "${agentName}" does not support loading or resuming sessions.`);
  }

  async loadSession(agentName: string, sessionId: string, requestedCwd?: string, title?: string): Promise<SessionInfo> {
    const existing = this.store.get(sessionId);
    if (existing) {
      this.focusSession(sessionId, { force: true });
      return existing;
    }
    const conn = await this.ensureConnected(agentName);
    if (!this.getCachedCapabilities(agentName)?.load) {
      throw new Error(`Agent "${agentName}" does not support session/load.`);
    }
    const cwd = this.sessionCwd(agentName, sessionId, requestedCwd);
    const agentId = this.agentIdFor(conn, agentName);

    // Registered before the RPC so replayed notifications have a session to land on
    const placeholder = this.buildSession(conn, agentName, agentId, sessionId, cwd, null, { title });
    this.registerSession(placeholder);
    this.loadingSessionIds.add(sessionId);
    this.emit('session-created', sessionId, agentName, 'load' satisfies SessionOrigin);
    // Focus first so the panel repaints from the new session, then shows the loading overlay
    this.focusSession(sessionId, { force: true });
    this.emit('session-load-start', sessionId, agentName);

    try {
      const response = await this.connector.enqueue(agentId, () => conn.connection.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
        ...this.metaFor(agentName),
      }));
      this.applyStateFrom(placeholder, response);
    } catch (e) {
      this.loadingSessionIds.delete(sessionId);
      this.removeSession(sessionId, 'user');
      this.emit('session-load-end', sessionId, agentName, false);
      if (NOT_FOUND.test(String((e as Error | undefined)?.message || ''))) {
        this.historyStore?.forget(agentName, sessionId);
      }
      throw e;
    }

    this.loadingSessionIds.delete(sessionId);
    this.emit('session-load-end', sessionId, agentName, true);
    this.historyStore?.upsertNew(agentName, cwd, sessionId);
    return placeholder;
  }

  /** Light path: no history replay. */
  async resumeSession(agentName: string, sessionId: string, requestedCwd?: string, title?: string): Promise<SessionInfo> {
    const existing = this.store.get(sessionId);
    if (existing) {
      this.focusSession(sessionId, { force: true });
      return existing;
    }
    const conn = await this.ensureConnected(agentName);
    if (!this.getCachedCapabilities(agentName)?.resume) {
      throw new Error(`Agent "${agentName}" does not support session/resume.`);
    }
    const cwd = this.sessionCwd(agentName, sessionId, requestedCwd);
    const agentId = this.agentIdFor(conn, agentName);

    let response: unknown;
    try {
      response = await this.connector.enqueue(agentId, () => conn.connection.resumeSession({
        sessionId,
        cwd,
        mcpServers: [],
        ...this.metaFor(agentName),
      }));
    } catch (e) {
      if (NOT_FOUND.test(String((e as Error | undefined)?.message || ''))) {
        this.historyStore?.forget(agentName, sessionId);
      }
      throw e;
    }

    const session = this.buildSession(conn, agentName, agentId, sessionId, cwd, response, { title });
    this.registerSession(session);
    this.emit('session-created', sessionId, agentName, 'resume' satisfies SessionOrigin);
    this.focusSession(sessionId, { force: true });
    this.historyStore?.upsertNew(agentName, cwd, sessionId);
    return session;
  }

  isLoading(sessionId: string): boolean { return this.loadingSessionIds.has(sessionId); }

  // --- Queries ---------------------------------------------------------------

  getSession(sessionId: string): SessionInfo | undefined { return this.store.get(sessionId); }

  getActiveSession(): SessionInfo | undefined {
    const id = this.store.focusedId;
    return id ? this.store.get(id) : undefined;
  }

  getActiveSessionId(): string | null { return this.store.focusedId; }
  getActiveAgentName(): string | null { return this.getActiveSession()?.agentName ?? null; }
  getFocusedAgentName(): string | null { return this.getActiveAgentName(); }

  isAgentConnected(agentName: string): boolean {
    return this.connector.isConnected(agentName) || this.store.hasAgent(agentName);
  }

  getConnectedAgentNames(): string[] {
    return Array.from(new Set([...this.connector.connectedNames(), ...this.store.agentNames()]));
  }

  getLiveSessions(): SessionInfo[] { return this.store.all(); }

  /** Creation order; callers treat the last as newest. */
  getSessionIdsForAgent(agentName: string): string[] { return this.store.idsForAgent(agentName); }

  getConnectionForSession(sessionId: string): ConnectionInfo | undefined {
    const session = this.store.get(sessionId);
    return session ? this.connectionManager.getConnection(session.agentId) : undefined;
  }

  dispose(): void {
    this.agentManager.killAll();
    this.connectionManager.dispose();
    this.store.clear();
    this.connector.clear();
    this.inFlightTurns.clear();
    this.loadingSessionIds.clear();
  }

  // --- Internals -------------------------------------------------------------

  private requireSession(sessionId: string): SessionInfo {
    const session = this.store.get(sessionId);
    if (!session) { throw new Error(`Session not found: ${sessionId}`); }
    return session;
  }

  private requireConnection(session: SessionInfo): ConnectionInfo {
    const conn = this.connectionManager.getConnection(session.agentId);
    if (!conn) { throw new Error(`No connection for agent: ${session.agentId}`); }
    return conn;
  }

  private agentIdFor(conn: ConnectionInfo, agentName: string): string {
    const agentId = conn.agentId || this.connector.agentIdOf(agentName);
    if (!agentId) { throw new Error(`Unable to locate agent process for "${agentName}".`); }
    return agentId;
  }

  /** A session's own directory: the caller's, else the history cache's, else the default. */
  private sessionCwd(agentName: string, sessionId: string, requested?: string): string {
    return requested || this.historyStore?.get(agentName, sessionId)?.cwd || this.resolveDefaultCwd();
  }

  /** Agent-specific `_meta` for session/new | load | resume (e.g. custom models for Claude). */
  private metaFor(agentName: string): { _meta?: Record<string, unknown> } {
    const meta = profileFor(getAgentKind(agentName)).sessionMeta({
      customModelIds: readCustomModels().map(m => m.modelId),
    });
    return meta ? { _meta: meta } : {};
  }

  private buildSession(
    conn: ConnectionInfo,
    agentName: string,
    agentId: string,
    sessionId: string,
    cwd: string,
    response: unknown,
    extra: { title?: string; additionalDirectories?: string[] } = {},
  ): SessionInfo {
    const session: SessionInfo = {
      sessionId,
      agentId,
      agentName,
      agentDisplayName: conn.initResponse.agentInfo?.title || conn.initResponse.agentInfo?.name || agentName,
      cwd,
      createdAt: new Date().toISOString(),
      initResponse: conn.initResponse,
      modes: null,
      models: null,
      configOptions: null,
      availableCommands: [],
    };
    if (extra.title) { session.title = extra.title; }
    if (extra.additionalDirectories?.length) { session.additionalDirectories = extra.additionalDirectories; }
    this.applyStateFrom(session, response);
    return session;
  }

  private applyStateFrom(session: SessionInfo, response: unknown): void {
    const r = response as { modes?: SessionInfo['modes']; models?: SessionInfo['models']; configOptions?: SessionInfo['configOptions'] } | null | undefined;
    session.modes = r?.modes ?? null;
    session.models = r?.models ?? null;
    session.configOptions = r?.configOptions ?? null;
  }

  private async newAcpSession(
    agentName: string,
    agentId: string,
    conn: ConnectionInfo,
    cwd: string,
    additionalDirectories: string[],
  ): Promise<SessionInfo> {
    // Only explicitly requested, absolute directories, and only if the agent advertises support
    const extra = this.getCachedCapabilities(agentName)?.additionalDirectories
      ? additionalDirectories.map(p => p?.trim()).filter(p => !!p && isAbsolute(p))
      : [];
    const request = {
      cwd,
      mcpServers: [],
      ...(extra.length ? { additionalDirectories: extra } : {}),
      ...this.metaFor(agentName),
    };

    let response: NewSessionResponse;
    try {
      response = await conn.connection.newSession(request);
    } catch (e) {
      if (!isAuthRequiredError(e)) {
        logError('Failed to create session', e);
        this.agentManager.killAgent(agentId);
        throw e;
      }
      try {
        await runAuthFlow(agentName, conn);
        response = await conn.connection.newSession(request);
      } catch (retryError) {
        logError('Failed to create session after authentication', retryError);
        this.agentManager.killAgent(agentId);
        throw retryError;
      }
    }

    const session = this.buildSession(conn, agentName, agentId, response.sessionId, cwd, response, {
      additionalDirectories: extra,
    });
    // Registered synchronously with the response so notifications racing the caller's
    // continuation are persisted instead of dropped
    this.registerSession(session);
    this.historyStore?.upsertNew(agentName, cwd, session.sessionId);
    return session;
  }
}
