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
  SessionNotification,
} from '@agentclientprotocol/sdk';

import { profileFor } from '../agents/AgentProfile';
import { getAgentConfigs, getAgentKind } from '../config/AgentConfig';
import { readCustomModels } from '../config/CustomModels';
import type { ElicitationBridge } from '../handlers/ElicitationBridge';
import type { PermissionBridge } from '../handlers/PermissionBridge';
import { log, logError } from '../utils/Logger';
import { DeadlineExceededError, withDeadline } from '../utils/AsyncDeadline';
import { RecoveryBudget, recoveryDelay, type RecoveryOptions } from './AgentRecovery';
import { AgentConnector, SESSION_CLOSE_TIMEOUT_MS, SESSION_LOAD_TIMEOUT_MS } from './AgentConnector';
import type { AgentManager } from './AgentManager';
import { forgetApiKey, isAuthRequiredError, runAuthFlow } from './auth';
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
import type { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';

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
 * `_meta` the Claude adapter reads to fork at a specific message (its
 * `fork-session.ts`). AIR-shaped, but the adapter does not gate it on the
 * client's identity: any client that sends it gets a message-level fork.
 */
function forkPointMeta(messageId: string): Record<string, unknown> {
  return { jetbrains: { air: { fork: { version: 1, messageId } } } };
}

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
  private disposed = false;
  private readonly recoveries = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly recoveryBudgets = new Map<string, RecoveryBudget>();
  private readonly retainedResumes = new Map<SessionInfo, { conn: ConnectionInfo; promise: Promise<void> }>();
  /** load/resume in flight per session id: concurrent opens share one RPC instead of replaying twice. */
  private readonly openings = new Map<string, { agentName: string; promise: Promise<SessionInfo> }>();
  private readonly store = new SessionStore();
  private readonly pending = new PendingSessionState();
  private readonly connector: AgentConnector;
  private readonly inFlightTurns = new Set<string>();
  private readonly cancelHolds = new Set<string>();
  private readonly loadingSessionIds = new Set<string>();
  private readonly updateListener?: SessionUpdateListener;
  private historyStore: SessionHistoryStore | null = null;
  private permissionBridge: PermissionBridge | null = null;
  private elicitationBridge: ElicitationBridge | null = null;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly connectionManager: ConnectionManager,
    private readonly sessionUpdateHandler?: SessionUpdateHandler,
    private readonly recoveryOptions: RecoveryOptions = {},
  ) {
    super();
    this.connector = new AgentConnector(agentManager, connectionManager, {
      resolveCwd: () => this.resolveDefaultCwd(),
      onConnected: agentName => this.emit('agent-connected', agentName),
    });

    // 会话状态（可用命令 / 配置项 / 当前模式）由 core 自己从 agent 推送里落账：
    // 这些通知会早于 `session/new` 响应到达，而 UI 侧的监听器在会话未注册时整体丢弃，
    // 这里走 `apply*` 的 pending 缓冲 + `registerSession` 的 drain 才是对的。
    if (sessionUpdateHandler) {
      sessionUpdateHandler.onRelease = sessionId => this.pending.remove(sessionId);
      this.updateListener = notification => this.applySessionUpdate(notification);
      sessionUpdateHandler.addListener(this.updateListener);
    }

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
      if (agentName && this.connector.agentIdOf(agentName) === evt.agentId) { this.handleAgentGone(agentName, false); }
      this.emit('agent-closed', evt.agentId, evt.code, agentName);
    });
    // The SDK can close the connection while the process lives on (stream error, oversized
    // message): stop the process and recover exactly as if it had exited. Whichever of this and
    // `agent-closed` runs first detaches the agent, so the other one is a no-op.
    connectionManager.onConnectionLost(agentId => {
      const agentName = this.connector.nameOf(agentId);
      if (!agentName || this.connector.agentIdOf(agentName) !== agentId) { return; }
      log(`Agent ${agentName} lost its ACP connection while still running; stopping the process`);
      this.handleAgentGone(agentName, true);
    });
  }

  private handleAgentGone(agentName: string, kill: boolean): void {
    if (this.recoveries.has(agentName)) {
      this.suspendAgent(agentName, kill);
    } else if (this.canRecover(agentName)) {
      this.suspendAgent(agentName, kill);
      this.startRecovery(agentName);
    } else { this.teardownAgent(agentName, kill); }
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
    this.connector.register(session.agentName, session.agentId);
    this.registerSession(session);
  }

  private registerSession(session: SessionInfo): void {
    if (this.disposed || this.connector.agentIdOf(session.agentName) !== session.agentId) {
      throw new Error('Agent connection was closed before the session could be registered.');
    }
    this.sessionUpdateHandler?.claim(session.sessionId, session.agentId);
    this.store.add(session);
    this.pending.drainInto(session);
    this.syncLiveSessions(session.agentName);
  }

  private syncLiveSessions(agentName: string): void {
    this.historyStore?.setLiveSessions(agentName, this.store.idsForAgent(agentName));
  }

  private removeSession(sessionId: string, reason: SessionCloseReason): void {
    const wasFocused = this.store.focusedId === sessionId;
    this.permissionBridge?.cancelSession(sessionId);
    this.elicitationBridge?.cancelSession(sessionId);
    const session = this.store.remove(sessionId);
    if (!session) { return; }
    this.releaseCancelHold(sessionId);
    if (this.inFlightTurns.delete(sessionId)) { this.emit('turn-state-changed', sessionId, false); }
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

  private canRecover(agentName: string): boolean {
    return !this.disposed && (this.recoveryOptions.enabled?.() ?? vscode.workspace.getConfiguration('vac').get<boolean>('autoReconnect', true))
      && !!this.connector.capabilities(agentName)?.resume && this.store.hasAgent(agentName);
  }

  /** Keep tab/transcript/draft identity; settle old turns and release the dead connection. */
  private suspendAgent(agentName: string, kill = false): void {
    const agentId = this.connector.detach(agentName);
    if (agentId) { this.connectionManager.removeConnection(agentId); if (kill) { this.agentManager.killAgent(agentId); } }
    for (const id of this.store.idsForAgent(agentName)) {
      this.permissionBridge?.cancelSession(id);
      this.elicitationBridge?.cancelSession(id);
      this.releaseCancelHold(id);
      if (this.inFlightTurns.delete(id)) { this.emit('turn-state-changed', id, false); }
    }
    this.emit('agent-disconnected', agentName);
  }

  private startRecovery(agentName: string): void {
    const controller = new AbortController();
    const job = { controller, promise: undefined as unknown as Promise<void> };
    this.recoveries.set(agentName, job);
    job.promise = this.recoverAgent(agentName, controller.signal).catch(error => {
      if (!controller.signal.aborted && !this.disposed && this.recoveries.get(agentName) === job) {
        this.suspendAgent(agentName, true);
        this.connector.cancel(agentName);
        this.emit('agent-recovery-failed', agentName);
        logError('Automatic agent recovery stopped', error);
      }
      throw error;
    }).finally(() => { if (this.recoveries.get(agentName) === job) { this.recoveries.delete(agentName); } });
    // There need not be a caller awaiting this background job.
    void job.promise.catch(() => {});
  }

  private async recoverAgent(agentName: string, signal: AbortSignal): Promise<void> {
    let budget = this.recoveryBudgets.get(agentName);
    if (!budget) { budget = new RecoveryBudget(this.recoveryOptions.delaysMs); this.recoveryBudgets.set(agentName, budget); }
    while (this.canRecover(agentName) && !signal.aborted) {
      const delay = budget.nextDelay();
      if (delay === undefined) { throw new Error('Automatic recovery retry limit reached.'); }
      await recoveryDelay(delay, signal);
      if (!this.canRecover(agentName)) { return; }
      const first = this.store.get(this.store.idsForAgent(agentName)[0]);
      if (!first) { return; }
      let conn: ConnectionInfo;
      try { conn = await this.connector.ensure(agentName, first.cwd); }
      catch (error) { if (signal.aborted) { throw error; } continue; }
      try {
        for (const id of this.store.idsForAgent(agentName)) {
          const session = this.store.get(id);
          if (!session) { continue; }
          // No auth retry here: authentication / missing sessions require an explicit user action.
          await this.resumeRetainedSession(session, conn, signal);
        }
      } catch (error) {
        if (!signal.aborted && this.connectionManager.getConnection(conn.agentId) !== conn) { continue; }
        throw error;
      }
      if (this.connectionManager.getConnection(conn.agentId) !== conn) { continue; }
      budget.connected();
      this.emit('agent-recovered', agentName);
      return;
    }
  }

  private resumeRetainedSession(session: SessionInfo, conn: ConnectionInfo, signal?: AbortSignal): Promise<void> {
    if (session.agentId === conn.agentId) { return Promise.resolve(); }
    const pending = this.retainedResumes.get(session);
    if (pending?.conn === conn) { return pending.promise; }
    const job = { conn, promise: undefined as unknown as Promise<void> };
    this.retainedResumes.set(session, job);
    job.promise = this.resumeRetainedSessionOnce(session, conn, signal).finally(() => {
      if (this.retainedResumes.get(session) === job) { this.retainedResumes.delete(session); }
    });
    return job.promise;
  }

  private async resumeRetainedSessionOnce(session: SessionInfo, conn: ConnectionInfo, signal?: AbortSignal): Promise<void> {
    if (!this.connector.capabilities(session.agentName)?.resume) { throw new Error('Agent no longer supports session/resume.'); }
    const request = () => conn.connection.resumeSession({
      sessionId: session.sessionId, cwd: session.cwd, mcpServers: [],
      ...this.directoriesParam(session.agentName, session.additionalDirectories),
      ...this.metaFor(session.agentName),
    });
    const timed = () => withDeadline(() => this.connector.enqueue(conn.agentId, request, { label: 'ACP session/resume' }),
      this.recoveryOptions.resumeTimeoutMs ?? 30_000, 'ACP session/resume', signal);
    let response: unknown;
    try {
      // Auth UI runs outside the queue slot and the deadline; unattended recovery never authenticates.
      response = await (signal ? timed() : this.withAuthRetry(session.agentName, conn, timed));
    } catch (error) {
      // A timed-out queued/manual RPC must not execute later on a still-live connection.
      if (error instanceof DeadlineExceededError && !signal) { this.suspendAgent(session.agentName, true); }
      throw error;
    }
    if (this.store.get(session.sessionId) !== session) { return; } // Closed tabs must not be resurrected by late RPCs.
    if (this.disposed || signal?.aborted || this.connectionManager.getConnection(conn.agentId) !== conn) {
      throw new Error('Session was closed while recovering.');
    }
    this.sessionUpdateHandler?.claim(session.sessionId, conn.agentId);
    // Migration is allowed only for the same retained object after a successful resume.
    session.agentId = conn.agentId;
    session.initResponse = conn.initResponse;
    this.applyStateFrom(session, response);
    this.pending.drainInto(session);
    this.emit('session-info-changed', session.sessionId);
  }

  // --- Connection + session lifecycle --------------------------------------

  /** Reuses the agent's newest live session, otherwise creates one. */
  async connectToAgent(agentName: string, opts: { focus?: boolean } = {}): Promise<SessionInfo> {
    const { focus = true } = opts;
    const live = this.getSessionIdsForAgent(agentName);
    if (live.length > 0) {
      const sessionId = live[live.length - 1];
      if (!this.getConnectionForSession(sessionId)) { await this.ensureConnected(agentName); }
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
    // Auth dialogs run between queue slots, never while holding one.
    const session = await this.withAuthRetry(agentName, conn, () => this.connector.enqueue(
      agentId,
      expired => this.newAcpSession(agentName, agentId, conn, cwd, additionalDirectories, expired),
      { label: 'ACP session/new' },
    ));

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

    if (this.isTurnInFlight(sessionId)) {
      try {
        await this.cancelTurn(sessionId);
      } catch (e) {
        logError(`cancel before close failed for ${sessionId} (closing anyway)`, e);
      }
    } else {
      this.permissionBridge?.cancelSession(sessionId);
      this.elicitationBridge?.cancelSession(sessionId);
    }

    const conn = this.getCachedCapabilities(agentName)?.close ? this.connectionManager.getConnection(session.agentId) : undefined;
    log(`Closing session ${sessionId} of agent ${agentName}`);
    // Local teardown first: session/close is best-effort and must not hold the tab open.
    this.removeSession(sessionId, 'user');
    if (!conn) { return; }
    try {
      await this.connector.enqueue(session.agentId, () => conn.connection.closeSession({ sessionId }),
        { timeoutMs: SESSION_CLOSE_TIMEOUT_MS, label: 'ACP session/close' });
    } catch (e) {
      logError(`session/close failed for ${sessionId} (already removed locally)`, e);
    }
  }

  /**
   * Permanently deletes a session: cancels any running turn and closes it when it
   * is live, asks the agent to delete it (`session/delete`, only when advertised),
   * then drops the local cache entry. The agent call is best-effort — the local
   * entry always goes, so the tree cannot keep a row the user just deleted.
   */
  async deleteSession(agentName: string, sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (session && session.agentName === agentName) {
      await this.closeSession(agentName, sessionId);
    }

    const agentId = this.connector.agentIdOf(agentName);
    const conn = agentId ? this.connectionManager.getConnection(agentId) : undefined;
    if (agentId && conn && this.getCachedCapabilities(agentName)?.delete) {
      try {
        await this.connector.enqueue(agentId, () => conn.connection.deleteSession({ sessionId }), { label: 'ACP session/delete' });
        log(`Deleted session ${sessionId} on agent ${agentName}`);
      } catch (e) {
        logError(`session/delete failed for ${sessionId} (continuing with local removal)`, e);
      }
    }

    this.historyStore?.forget(agentName, sessionId);
  }

  cancelAutomaticRecovery(): void {
    for (const [name, recovery] of this.recoveries) {
      this.recoveries.delete(name);
      recovery.controller.abort();
      this.connector.cancel(name);
      this.suspendAgent(name, true);
    }
  }

  async disconnectAgent(agentName: string): Promise<void> {
    const recovery = this.recoveries.get(agentName);
    this.recoveries.delete(agentName);
    recovery?.controller.abort();
    this.recoveryBudgets.delete(agentName);
    const cancelled = this.connector.cancel(agentName);
    if (!cancelled && !this.connector.isConnected(agentName) && !this.store.hasAgent(agentName)) { return; }
    log(`Disconnecting agent ${agentName}`);
    this.teardownAgent(agentName, true);
  }

  async ensureConnected(agentName: string, preferredCwd?: string): Promise<ConnectionInfo> {
    const recovery = this.recoveries.get(agentName);
    if (recovery) { await recovery.promise; }
    const conn = await this.connector.ensure(agentName, preferredCwd);
    // Explicit reconnects may authenticate, unlike unattended crash recovery.
    for (const id of this.store.idsForAgent(agentName)) {
      const session = this.store.get(id);
      if (!session) { continue; }
      if (session.agentId !== conn.agentId) { await this.resumeRetainedSession(session, conn); }
    }
    return conn;
  }

  /**
   * ACP `logout` (only when advertised as `auth.logout`) plus the API key this client
   * stored for the agent. Live sessions are left alone; the agent decides what they can still do.
   */
  async logout(agentName: string): Promise<void> {
    const conn = await this.ensureConnected(agentName);
    if (!this.getCachedCapabilities(agentName)?.logout) {
      throw new Error(`Agent "${agentName}" does not support logout.`);
    }
    await conn.connection.logout({});
    await forgetApiKey(agentName);
    log(`Logged out of agent ${agentName}`);
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
      const response = await this.withAuthRetry(
        session.agentName,
        conn,
        () => conn.connection.prompt({ sessionId, prompt: blocks }),
      );
      log(`Prompt response: stopReason=${response.stopReason}`);
      return response;
    } finally {
      // A late response from a dead connection must not end a new recovered turn.
      if (this.connectionManager.getConnection(session.agentId) === conn && this.inFlightTurns.delete(sessionId)) {
        this.releaseCancelHold(sessionId);
        this.emit('turn-state-changed', sessionId, false);
      }
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

  /**
   * Cancels ONE sub-agent child session (`session/cancel` on the child id), leaving
   * its parent session and siblings running. A child is not a registered session, so
   * `cancelTurn` cannot be used: it looks the id up in the store and would no-op.
   */
  async cancelSubagent(parentSessionId: string, subagentSessionId: string): Promise<void> {
    const parent = this.store.get(parentSessionId);
    if (!parent) { return; }
    this.permissionBridge?.cancelSession(subagentSessionId);
    this.elicitationBridge?.cancelSession(subagentSessionId);
    const conn = this.connectionManager.getConnection(parent.agentId);
    if (!conn) { return; }
    log(`Cancelling subagent ${subagentSessionId} of ${parentSessionId}`);
    await conn.connection.cancel({ sessionId: subagentSessionId });
  }

  async cancelTurn(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) { return; }
    // Requests the agent still sends before the cancelled prompt returns are answered
    // `cancelled` without being shown; the hold ends with the turn (releaseCancelHold).
    if (this.inFlightTurns.has(sessionId)) {
      this.cancelHolds.add(sessionId);
      this.permissionBridge?.holdCancelled(sessionId);
      this.elicitationBridge?.holdCancelled(sessionId);
    }
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

  /**
   * The agent answers with the full option list (changing a model can cascade into other options).
   *
   * [CUSTOM- `source` 只用于诊断：用户报过"选了自定义模型、发完消息又变回内置模型"，
   * 而这条链上有四个写入方（会话响应 / 设置响应 / agent 通知 / 早到的 pending）。
   * 每次 model 值真的变了就打一行，下一次就能直接看出是谁改的。
   */
  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<SessionConfigOption[] | null> {
    const session = this.store.get(sessionId);
    const conn = session && this.connectionManager.getConnection(session.agentId);
    if (!session || !conn) { return null; }

    // The UI speaks strings; boolean options go on the wire typed (`{ type: 'boolean', value }`).
    const option = session.configOptions?.find(o => o.id === configId);
    const request = option?.type === 'boolean'
      ? { sessionId, configId, type: 'boolean' as const, value: value === true || value === 'true' }
      : { sessionId, configId, value: String(value) };
    const response = await conn.connection.setSessionConfigOption(request);
    const options = (response as { configOptions?: SessionConfigOption[] } | null)?.configOptions ?? null;
    this.applyConfigOptions(sessionId, options, 'set-response');
    return options;
  }

  applyConfigOptions(sessionId: string, options: SessionConfigOption[] | null, source = 'update'): void {
    const session = this.store.get(sessionId);
    if (!session) {
      this.pending.setConfig(sessionId, options ?? []);
      return;
    }
    this.noteModelChange(sessionId, session.configOptions, options, source);
    session.configOptions = options ?? null;
    // The mode option is authoritative for "which mode"; keep legacy `modes` in step
    const modeOption = (options ?? []).find(o => (o as { category?: unknown }).category === 'mode');
    const current = (modeOption as { currentValue?: unknown } | undefined)?.currentValue;
    if (session.modes && current !== undefined && current !== null) {
      session.modes.currentModeId = String(current);
    }
    this.emit('config-options-changed', sessionId, session.configOptions);
  }

  /** [CUSTOM- 模型值变化的一行诊断（见 setConfigOption 的注释）。 */
  private noteModelChange(
    sessionId: string,
    before: SessionConfigOption[] | null,
    after: SessionConfigOption[] | null,
    source: string,
  ): void {
    const prev = modelValueOf(before);
    const next = modelValueOf(after);
    if (prev === next) { return; }
    log(`SessionManager: model ${prev ?? '-'} -> ${next ?? '-'} (${source}) session=${sessionId}`);
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

  applyCurrentMode(sessionId: string, modeId: string): void {
    const session = this.store.get(sessionId);
    if (!session) {
      this.pending.setMode(sessionId, modeId);
      return;
    }
    if (session.modes) { session.modes.currentModeId = modeId; }
    this.emit('mode-changed', sessionId, modeId);
  }

  /** 只接纯状态通知；带 UI 语义的（chunk / tool_call / plan / usage…）归 `ChatPanelHost.onSessionUpdate`。 */
  private applySessionUpdate(notification: SessionNotification): void {
    const { sessionId } = notification;
    const data = notification.update as {
      sessionUpdate?: string;
      availableCommands?: AvailableCommand[];
      configOptions?: SessionConfigOption[] | null;
      currentModeId?: string;
    };
    switch (data.sessionUpdate) {
      case 'available_commands_update':
        this.applyAvailableCommands(sessionId, data.availableCommands ?? []);
        return;
      case 'config_option_update':
        // [CUSTOM- 缺字段的通知不该把整个选项表清空（那会让模型/模式选择器凭空消失）。
        if (data.configOptions) { this.applyConfigOptions(sessionId, data.configOptions, 'notification'); }
        return;
      case 'current_mode_update':
        if (typeof data.currentModeId === 'string') { this.applyCurrentMode(sessionId, data.currentModeId); }
        return;
      default:
        return;
    }
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

    const response: { sessions?: ProtocolSessionInfo[]; nextCursor?: string | null } | undefined =
      await this.withAuthRetry(agentName, conn, () => conn.connection.listSessions(params));

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
   * Concurrent opens of one id share a single load/resume (`openings`); later callers get 'live'.
   */
  async openExistingSession(
    agentName: string,
    sessionId: string,
    opts: { cwd?: string; title?: string; additionalDirectories?: string[] } = {},
  ): Promise<'live' | 'load' | 'resume'> {
    const existing = this.liveOrJoin(agentName, sessionId);
    if (existing) { return this.openedLive(agentName, sessionId, await existing, opts); }
    await this.ensureConnected(agentName, opts.cwd);
    // Another caller may have started while we connected; loadSession/resumeSession register
    // their `openings` entry synchronously, so nothing can slip in after this re-check.
    const started = this.liveOrJoin(agentName, sessionId);
    if (started) { return this.openedLive(agentName, sessionId, await started, opts); }
    const caps = this.getCachedCapabilities(agentName);
    if (caps?.load) {
      await this.loadSession(agentName, sessionId, opts.cwd, opts.title, opts.additionalDirectories);
      return 'load';
    }
    if (caps?.resume) {
      await this.resumeSession(agentName, sessionId, opts.cwd, opts.title, opts.additionalDirectories);
      return 'resume';
    }
    throw new Error(`Agent "${agentName}" does not support loading or resuming sessions.`);
  }

  private async openedLive(agentName: string, sessionId: string, session: SessionInfo, opts: { cwd?: string; title?: string }): Promise<'live'> {
    if (!this.getConnectionForSession(sessionId)) { await this.ensureConnected(agentName, opts.cwd); }
    if (opts.title && !session.title) { session.title = opts.title; }
    this.focusSession(sessionId, { force: true });
    return 'live';
  }

  async loadSession(agentName: string, sessionId: string, requestedCwd?: string, title?: string, additionalDirectories?: string[]): Promise<SessionInfo> {
    const existing = this.liveOrJoin(agentName, sessionId);
    if (existing) { return this.refocus(agentName, sessionId, await existing, requestedCwd); }
    return this.shareOpen(agentName, sessionId, () => this.loadSessionNow(agentName, sessionId, requestedCwd, title, additionalDirectories));
  }

  /** Light path: no history replay. */
  async resumeSession(agentName: string, sessionId: string, requestedCwd?: string, title?: string, additionalDirectories?: string[]): Promise<SessionInfo> {
    const existing = this.liveOrJoin(agentName, sessionId);
    if (existing) { return this.refocus(agentName, sessionId, await existing, requestedCwd); }
    return this.shareOpen(agentName, sessionId, () => this.resumeSessionNow(agentName, sessionId, requestedCwd, title, additionalDirectories));
  }

  /** The live session, or the open already in flight for it; undefined when the caller must open it. */
  private liveOrJoin(agentName: string, sessionId: string): Promise<SessionInfo> | undefined {
    const existing = this.store.get(sessionId);
    if (existing) {
      if (existing.agentName !== agentName) { throw new Error('Session id is already open for another agent.'); }
      return Promise.resolve(existing);
    }
    const opening = this.openings.get(sessionId);
    if (!opening) { return undefined; }
    if (opening.agentName !== agentName) { throw new Error('Session id is already being opened for another agent.'); }
    return opening.promise;
  }

  private shareOpen(agentName: string, sessionId: string, run: () => Promise<SessionInfo>): Promise<SessionInfo> {
    const job = { agentName, promise: undefined as unknown as Promise<SessionInfo> };
    this.openings.set(sessionId, job);
    job.promise = run().finally(() => { if (this.openings.get(sessionId) === job) { this.openings.delete(sessionId); } });
    return job.promise;
  }

  private async refocus(agentName: string, sessionId: string, session: SessionInfo, cwd?: string): Promise<SessionInfo> {
    if (!this.getConnectionForSession(sessionId)) { await this.ensureConnected(agentName, cwd); }
    this.focusSession(sessionId, { force: true });
    return session;
  }

  private async loadSessionNow(agentName: string, sessionId: string, requestedCwd?: string, title?: string, additionalDirectories?: string[]): Promise<SessionInfo> {
    const conn = await this.ensureConnected(agentName);
    if (!this.getCachedCapabilities(agentName)?.load) {
      throw new Error(`Agent "${agentName}" does not support session/load.`);
    }
    const cwd = this.sessionCwd(agentName, sessionId, requestedCwd);
    const agentId = this.agentIdFor(conn, agentName);
    const directories = this.directoriesParam(agentName, additionalDirectories);

    // Registered before the RPC so replayed notifications have a session to land on
    const placeholder = this.buildSession(conn, agentName, agentId, sessionId, cwd, null, { title, ...directories });
    this.registerSession(placeholder);
    this.loadingSessionIds.add(sessionId);
    this.emit('session-created', sessionId, agentName, 'load' satisfies SessionOrigin);
    // Focus first so the panel repaints from the new session, then shows the loading overlay
    this.focusSession(sessionId, { force: true });
    this.emit('session-load-start', sessionId, agentName);

    try {
      const response = await this.withAuthRetry(agentName, conn, () => this.connector.enqueue(agentId, () => conn.connection.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
        ...directories,
        ...this.metaFor(agentName),
      }), { timeoutMs: SESSION_LOAD_TIMEOUT_MS, label: 'ACP session/load' }));
      if (this.disposed || this.store.get(sessionId) !== placeholder) {
        throw new Error('Session was closed while loading.');
      }
      this.applyStateFrom(placeholder, response);
    } catch (e) {
      this.loadingSessionIds.delete(sessionId);
      if (this.store.get(sessionId) === placeholder) { this.removeSession(sessionId, 'user'); }
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

  private async resumeSessionNow(agentName: string, sessionId: string, requestedCwd?: string, title?: string, additionalDirectories?: string[]): Promise<SessionInfo> {
    const conn = await this.ensureConnected(agentName);
    if (!this.getCachedCapabilities(agentName)?.resume) {
      throw new Error(`Agent "${agentName}" does not support session/resume.`);
    }
    const cwd = this.sessionCwd(agentName, sessionId, requestedCwd);
    const agentId = this.agentIdFor(conn, agentName);
    const directories = this.directoriesParam(agentName, additionalDirectories);

    let response: unknown;
    try {
      response = await this.withAuthRetry(agentName, conn, () => this.connector.enqueue(agentId, () => conn.connection.resumeSession({
        sessionId,
        cwd,
        mcpServers: [],
        ...directories,
        ...this.metaFor(agentName),
      }), { label: 'ACP session/resume' }));
    } catch (e) {
      if (NOT_FOUND.test(String((e as Error | undefined)?.message || ''))) {
        this.historyStore?.forget(agentName, sessionId);
      }
      throw e;
    }

    const session = this.buildSession(conn, agentName, agentId, sessionId, cwd, response, { title, ...directories });
    this.registerSession(session);
    this.emit('session-created', sessionId, agentName, 'resume' satisfies SessionOrigin);
    this.focusSession(sessionId, { force: true });
    this.historyStore?.upsertNew(agentName, cwd, sessionId);
    return session;
  }

  isLoading(sessionId: string): boolean { return this.loadingSessionIds.has(sessionId); }

  /**
   * Forks a live session into a new independent one (`session/fork`, only when the
   * agent advertises it). With a `messageId` the agent forks at that message;
   * without it, at the end of the session. The forked session is then opened
   * through `openExistingSession` so the panel shows the history it inherited.
   */
  async forkSession(
    agentName: string,
    sessionId: string,
    opts: { messageId?: string } = {},
  ): Promise<SessionInfo> {
    const { source, response } = await this.requestFork(agentName, sessionId, opts.messageId);
    log(`forkSession: ${sessionId} -> ${response.sessionId}${opts.messageId ? ` @ ${opts.messageId}` : ''}`);

    await this.openExistingSession(agentName, response.sessionId, {
      cwd: source.cwd, title: source.title, additionalDirectories: source.additionalDirectories,
    });
    const forked = this.store.get(response.sessionId);
    if (!forked) { throw new Error('The forked session could not be opened.'); }
    return forked;
  }

  async forkSideSession(agentName: string, sourceSessionId: string): Promise<SessionInfo> {
    const { source, conn, agentId, response } = await this.requestFork(agentName, sourceSessionId);
    const side = this.buildSession(conn, agentName, agentId, response.sessionId, source.cwd, response, {
      title: source.title,
      additionalDirectories: source.additionalDirectories,
    });
    if (!side.modes && source.modes) {
      side.modes = {
        ...source.modes,
        availableModes: source.modes.availableModes.map(mode => ({ ...mode })),
      };
    }
    if (!side.models && source.models) {
      side.models = {
        ...source.models,
        availableModels: source.models.availableModels.map(model => ({ ...model })),
      };
    }
    if (!side.configOptions && source.configOptions) {
      side.configOptions = source.configOptions.map(option => ({ ...option }));
    }
    side.availableCommands = source.availableCommands.map(command => ({ ...command }));
    side.sideChat = { parentSessionId: sourceSessionId, forkedAt: side.createdAt };
    this.registerSession(side);
    this.emit('session-created', side.sessionId, agentName, 'side' satisfies SessionOrigin);
    log(`forkSideSession: ${sourceSessionId} -> ${side.sessionId}`);
    return side;
  }

  private async requestFork(agentName: string, sessionId: string, messageId?: string) {
    const source = this.store.get(sessionId);
    if (!source || source.agentName !== agentName || source.sideChat) {
      throw new Error('Fork needs a live main session of the same agent.');
    }
    const conn = await this.ensureConnected(agentName, source.cwd);
    if (!this.getCachedCapabilities(agentName)?.fork) {
      throw new Error(`Agent "${agentName}" does not support session/fork.`);
    }
    const agentId = this.agentIdFor(conn, agentName);
    const response = await this.connector.enqueue(agentId, () => conn.connection.unstable_forkSession({
      sessionId,
      cwd: source.cwd,
      // The source's roots were already accepted by this agent, so no capability re-check.
      ...(source.additionalDirectories?.length ? { additionalDirectories: source.additionalDirectories } : {}),
      ...(messageId ? { _meta: forkPointMeta(messageId) } : {}),
    }), { label: 'ACP session/fork' });
    return { source, conn, agentId, response };
  }

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
  getMainLiveSessions(): SessionInfo[] { return this.store.all().filter(session => !session.sideChat); }

  /** Creation order; callers treat the last as newest. */
  getSessionIdsForAgent(agentName: string, opts: { includeSide?: boolean } = {}): string[] {
    const ids = this.store.idsForAgent(agentName);
    return opts.includeSide ? ids : ids.filter(id => !this.store.get(id)?.sideChat);
  }

  getConnectionForSession(sessionId: string): ConnectionInfo | undefined {
    const session = this.store.get(sessionId);
    return session ? this.connectionManager.getConnection(session.agentId) : undefined;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const recovery of this.recoveries.values()) { recovery.controller.abort(); }
    this.recoveries.clear();
    this.recoveryBudgets.clear();
    if (this.updateListener) { this.sessionUpdateHandler?.removeListener(this.updateListener); }
    this.permissionBridge?.cancelAll();
    this.elicitationBridge?.cancelAll();
    this.connector.clear();
    this.agentManager.dispose();
    this.connectionManager.dispose();
    this.store.clear();
    this.pending.clear();
    if (this.sessionUpdateHandler) { this.sessionUpdateHandler.onRelease = undefined; }
    this.inFlightTurns.clear();
    this.cancelHolds.clear();
    this.openings.clear();
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

  /** Runs `call`; on ACP "auth required" (-32000) authenticates once and retries. */
  private async withAuthRetry<T>(agentName: string, conn: ConnectionInfo, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (e) {
      if (!isAuthRequiredError(e) || this.disposed || this.connectionManager.getConnection(conn.agentId) !== conn) { throw e; }
      await runAuthFlow(agentName, conn);
      if (this.disposed || this.connectionManager.getConnection(conn.agentId) !== conn) { throw new Error('Agent connection cancelled during authentication.'); }
      return call();
    }
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
    this.noteModelChange(session.sessionId, session.configOptions, r?.configOptions ?? null, 'session-response');
    session.modes = r?.modes ?? null;
    session.models = r?.models ?? null;
    session.configOptions = r?.configOptions ?? null;
  }

  /**
   * Only explicitly requested, absolute directories, and only if the agent advertises
   * support — the same rule for session/new, load, resume and fork.
   */
  private directoriesParam(agentName: string, directories: readonly string[] | undefined): { additionalDirectories?: string[] } {
    if (!this.getCachedCapabilities(agentName)?.additionalDirectories) { return {}; }
    const extra = (directories ?? []).map(p => p?.trim()).filter((p): p is string => !!p && isAbsolute(p));
    return extra.length ? { additionalDirectories: extra } : {};
  }

  private releaseCancelHold(sessionId: string): void {
    if (!this.cancelHolds.delete(sessionId)) { return; }
    this.permissionBridge?.releaseCancelled(sessionId);
    this.elicitationBridge?.releaseCancelled(sessionId);
  }

  private async newAcpSession(
    agentName: string,
    agentId: string,
    conn: ConnectionInfo,
    cwd: string,
    additionalDirectories: string[],
    expired: AbortSignal,
  ): Promise<SessionInfo> {
    const directories = this.directoriesParam(agentName, additionalDirectories);
    const request = {
      cwd,
      mcpServers: [],
      ...directories,
      ...this.metaFor(agentName),
    };

    // A failed session/new must not reap the process: sibling sessions live on it.
    let response: NewSessionResponse;
    try {
      response = await conn.connection.newSession(request);
    } catch (e) {
      logError('Failed to create session', e);
      throw e;
    }
    // The caller already got a timeout: an answer this late must not register a tab nobody opened.
    if (expired.aborted) { throw new Error('session/new answered after its deadline.'); }

    const session = this.buildSession(conn, agentName, agentId, response.sessionId, cwd, response, directories);
    // Registered synchronously with the response so notifications racing the caller's
    // continuation are persisted instead of dropped
    this.registerSession(session);
    this.historyStore?.upsertNew(agentName, cwd, session.sessionId);
    return session;
  }
}

/** [CUSTOM- `category === 'model'` 那个选项的当前值；没有就返回 undefined。 */
function modelValueOf(options: SessionConfigOption[] | null): string | undefined {
  const option = (options ?? []).find(o => (o as { category?: unknown }).category === 'model');
  const value = (option as { currentValue?: unknown } | undefined)?.currentValue;
  return value === undefined || value === null ? undefined : String(value);
}
