// SessionManager 的协议细节：不起真实 agent，用替身连接核对发出去的请求形状。
import * as assert from 'assert';
import type { ChildProcess } from 'node:child_process';
import type * as vscode from 'vscode';

import { AgentManager, type AgentInstance } from '../core/AgentManager';
import { setAuthSecrets, takesApiKey } from '../core/auth';
import { ConnectionManager, type ConnectionInfo } from '../core/ConnectionManager';
import { SessionManager } from '../core/SessionManager';
import type { AgentCapabilitySummary } from '../core/types';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';

type Call = { method: string; params: unknown };

/** One fake connection whose ACP methods record their params; `newSession` can be made to fail. */
function fakeConnection(calls: Call[], opts: { failNewSession?: boolean } = {}): ConnectionInfo {
  const record = (method: string) => async (params: unknown) => {
    calls.push({ method, params });
    if (method === 'newSession') {
      if (opts.failNewSession) { throw new Error('cwd rejected'); }
      return { sessionId: `s-${calls.length}` };
    }
    if (method === 'unstable_forkSession') { return { sessionId: `side-${calls.length}` }; }
    return method === 'setSessionConfigOption' ? { configOptions: [] } : {};
  };
  return {
    agentId: 'agent_1',
    connection: {
      newSession: record('newSession'),
      setSessionConfigOption: record('setSessionConfigOption'),
      unstable_forkSession: record('unstable_forkSession'),
      closeSession: record('closeSession'),
      deleteSession: record('deleteSession'),
    },
    client: {},
    initResponse: { protocolVersion: 1 },
    terminals: { killAll() { /* none */ }, dispose() { /* none */ } },
    supportsSteering: false,
  } as unknown as ConnectionInfo;
}

class RecordingAgents extends AgentManager {
  readonly killed: string[] = [];
  override killAgent(agentId: string): boolean { this.killed.push(agentId); return true; }
  override getRunningAgents(): AgentInstance[] { return []; }
  override spawnAgent(): AgentInstance { return { id: 'agent_1', name: 'x', process: {} as ChildProcess, config: { command: 'x' } }; }
}

class FixedConnections extends ConnectionManager {
  constructor(private readonly info: ConnectionInfo) { super(new SessionUpdateHandler()); }
  override getConnection(): ConnectionInfo | undefined { return this.info; }
}

function managerWith(info: ConnectionInfo, agents = new RecordingAgents()): SessionManager {
  const manager = new SessionManager(agents, new FixedConnections(info));
  (manager as unknown as { ensureConnected: () => Promise<ConnectionInfo> }).ensureConnected = async () => info;
  return manager;
}

function seed(manager: SessionManager, sessionId: string, configOptions: unknown[] = []): void {
  manager.seedSession({
    sessionId,
    agentId: 'agent_1',
    agentName: 'Codex CLI',
    agentDisplayName: 'Codex CLI',
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
    initResponse: {},
    modes: null,
    models: null,
    configOptions,
    availableCommands: [],
  } as unknown as Parameters<SessionManager['seedSession']>[0]);
}

function setCapabilities(manager: SessionManager, overrides: Partial<AgentCapabilitySummary>): void {
  const capabilities: AgentCapabilitySummary = {
    list: false,
    load: false,
    resume: false,
    close: false,
    delete: false,
    fork: false,
    additionalDirectories: false,
    logout: false,
    ...overrides,
  };
  (manager as unknown as { getCachedCapabilities: () => AgentCapabilitySummary }).getCachedCapabilities = () => capabilities;
}

suite('session manager: protocol details', () => {
  test('boolean config options go on the wire typed; select options stay strings', async () => {
    const calls: Call[] = [];
    const manager = managerWith(fakeConnection(calls));
    seed(manager, 's1', [
      { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
      { id: 'effort', name: 'Effort', type: 'select', currentValue: 'low', options: [] },
    ]);

    await manager.setConfigOption('s1', 'fast', 'true');
    await manager.setConfigOption('s1', 'effort', 'high');

    assert.deepStrictEqual(calls.map(c => c.params), [
      { sessionId: 's1', configId: 'fast', type: 'boolean', value: true },
      { sessionId: 's1', configId: 'effort', value: 'high' },
    ]);
  });

  test('a failed session/new keeps the agent process and its other sessions alive', async () => {
    const calls: Call[] = [];
    const agents = new RecordingAgents();
    const manager = managerWith(fakeConnection(calls, { failNewSession: true }), agents);
    seed(manager, 'sibling');

    await assert.rejects(manager.createSession('Codex CLI', { cwd: process.cwd() }), /cwd rejected/);

    assert.deepStrictEqual(agents.killed, []);
    assert.ok(manager.getSession('sibling'), 'the sibling session must survive');
  });

  test('side fork registers inherited state without loading, focusing, or exposing a main tab', async () => {
    const calls: Call[] = [];
    const manager = managerWith(fakeConnection(calls));
    setCapabilities(manager, { fork: true });
    seed(manager, 'source', [
      { id: 'model', name: 'Model', type: 'select', currentValue: 'fast', options: [] },
    ]);
    const source = manager.getSession('source')!;
    source.additionalDirectories = ['/workspace/shared'];
    source.title = 'Main session';
    source.modes = {
      currentModeId: 'ask',
      availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
    };
    source.models = {
      currentModelId: 'fast',
      availableModels: [{ modelId: 'fast', name: 'Fast' }],
    };
    source.availableCommands = [{ name: 'review', description: 'Review' }];
    manager.focusSession('source');
    const origins: string[] = [];
    manager.on('session-created', (_id, _agent, origin) => origins.push(origin));

    const side = await manager.forkSideSession('Codex CLI', 'source');
    const secondSide = await manager.forkSideSession('Codex CLI', 'source');

    assert.notStrictEqual(side.sessionId, secondSide.sessionId);
    assert.deepStrictEqual(calls.map(call => call.method), ['unstable_forkSession', 'unstable_forkSession']);
    assert.deepStrictEqual(calls[0].params, {
      sessionId: 'source',
      cwd: process.cwd(),
      additionalDirectories: ['/workspace/shared'],
    });
    assert.strictEqual(manager.getActiveSessionId(), 'source');
    assert.deepStrictEqual(origins, ['side', 'side']);
    assert.deepStrictEqual(side.sideChat, { parentSessionId: 'source', forkedAt: side.createdAt });
    assert.deepStrictEqual(secondSide.sideChat, { parentSessionId: 'source', forkedAt: secondSide.createdAt });
    assert.deepStrictEqual(manager.getMainLiveSessions().map(session => session.sessionId), ['source']);
    assert.deepStrictEqual(manager.getLiveSessions().map(session => session.sessionId), ['source', side.sessionId, secondSide.sessionId]);
    assert.deepStrictEqual(manager.getSessionIdsForAgent('Codex CLI'), ['source']);
    assert.deepStrictEqual(manager.getSessionIdsForAgent('Codex CLI', { includeSide: true }), ['source', side.sessionId, secondSide.sessionId]);
    assert.strictEqual(side.modes?.currentModeId, 'ask');
    assert.strictEqual(side.models?.currentModelId, 'fast');
    assert.strictEqual(side.configOptions?.[0]?.id, 'model');
    assert.strictEqual(side.availableCommands[0]?.name, 'review');
    side.modes!.currentModeId = 'code';
    assert.strictEqual(source.modes?.currentModeId, 'ask');
    manager.focusSession(side.sessionId);
    assert.strictEqual(manager.getActiveSessionId(), 'source');
    await assert.rejects(manager.forkSideSession('Codex CLI', side.sessionId), /live main session/);
    await assert.rejects(manager.forkSession('Codex CLI', side.sessionId), /live main session/);
  });

  test('side fork fails cleanly when the agent does not advertise fork', async () => {
    const calls: Call[] = [];
    const manager = managerWith(fakeConnection(calls));
    seed(manager, 'source');

    await assert.rejects(manager.forkSideSession('Codex CLI', 'source'), /does not support session\/fork/);

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(manager.getLiveSessions().map(session => session.sessionId), ['source']);
  });

  test('deleting an idle side settles pending requests before close and delete', async () => {
    const calls: Call[] = [];
    const manager = managerWith(fakeConnection(calls));
    setCapabilities(manager, { close: true, delete: true });
    seed(manager, 'side');
    const order: string[] = [];
    let permissionsCancelled = false;
    let formsCancelled = false;
    manager.setPermissionBridge({
      cancelSession: () => {
        if (!permissionsCancelled) { order.push('permissions'); }
        permissionsCancelled = true;
      },
    } as never);
    manager.setElicitationBridge({
      cancelSession: () => {
        if (!formsCancelled) { order.push('forms'); }
        formsCancelled = true;
      },
    } as never);
    manager.on('session-closed', () => order.push('removed'));

    await manager.deleteSession('Codex CLI', 'side');

    assert.deepStrictEqual(order, ['permissions', 'forms', 'removed']);
    assert.deepStrictEqual(calls.map(call => call.method), ['closeSession', 'deleteSession']);
    assert.strictEqual(manager.getSession('side'), undefined);
  });

  test('auth required mid-prompt: a stored API key authenticates silently and the prompt is retried', async () => {
    const stored = new Map<string, string>([['vac.apiKey.Codex CLI', 'sk-test']]);
    setAuthSecrets({
      get: async (k: string) => stored.get(k),
      store: async (k: string, v: string) => { stored.set(k, v); },
      delete: async (k: string) => { stored.delete(k); },
    } as unknown as vscode.SecretStorage);

    const calls: Call[] = [];
    let prompts = 0;
    const info = fakeConnection(calls);
    Object.assign(info.connection, {
      prompt: async () => {
        prompts++;
        if (prompts === 1) { throw Object.assign(new Error('Authentication required'), { code: -32000 }); }
        return { stopReason: 'end_turn' };
      },
      authenticate: async (params: unknown) => { calls.push({ method: 'authenticate', params }); return {}; },
    });
    (info as { initResponse: unknown }).initResponse = {
      protocolVersion: 1,
      authMethods: [
        { id: 'chat-gpt', name: 'ChatGPT' },
        { id: 'api-key', name: 'API Key', _meta: { 'api-key': { provider: 'openai' } } },
      ],
    };
    const manager = managerWith(info);
    seed(manager, 's1');

    const response = await manager.sendPrompt('s1', 'hi');

    assert.strictEqual(response.stopReason, 'end_turn');
    assert.strictEqual(prompts, 2);
    assert.deepStrictEqual(calls.map(c => c.params), [
      { methodId: 'api-key', _meta: { 'api-key': { apiKey: 'sk-test' } } },
    ]);
  });

  test('only methods marked _meta["api-key"] take a client-supplied key', () => {
    assert.strictEqual(takesApiKey({ id: 'a', name: 'A', _meta: { 'api-key': { provider: 'openai' } } }), true);
    assert.strictEqual(takesApiKey({ id: 'b', name: 'B' }), false);
    assert.strictEqual(takesApiKey({ id: 'c', name: 'C', _meta: { 'api-key': null } }), false);
  });

  // [CUSTOM- "prompt went out" is one event even when auth retries the call:
  // the panel consumes the pending attachments from it (they must not linger for
  // the whole turn, but a retry must not broadcast an empty list twice either).
  test('sendPrompt reports the dispatch once, before the prompt RPC', async () => {
    const stored = new Map<string, string>([['vac.apiKey.Codex CLI', 'sk-test']]);
    setAuthSecrets({
      get: async (k: string) => stored.get(k),
      store: async (k: string, v: string) => { stored.set(k, v); },
      delete: async (k: string) => { stored.delete(k); },
    } as unknown as vscode.SecretStorage);

    const calls: Call[] = [];
    let prompts = 0;
    const info = fakeConnection(calls);
    let dispatchedAtPrompt = -1;
    let dispatched = 0;
    Object.assign(info.connection, {
      prompt: async () => {
        prompts++;
        if (prompts === 1) { throw Object.assign(new Error('Authentication required'), { code: -32000 }); }
        dispatchedAtPrompt = dispatched;
        return { stopReason: 'end_turn' };
      },
      authenticate: async () => ({}),
    });
    (info as { initResponse: unknown }).initResponse = {
      protocolVersion: 1,
      authMethods: [{ id: 'api-key', name: 'API Key', _meta: { 'api-key': { provider: 'openai' } } }],
    };
    const manager = managerWith(info);
    seed(manager, 's1');

    await manager.sendPrompt('s1', 'hi', () => { dispatched++; });

    assert.strictEqual(prompts, 2);
    assert.strictEqual(dispatched, 1, 'one dispatch per prompt, not one per auth retry');
    assert.strictEqual(dispatchedAtPrompt, 1, 'the callback runs before the RPC that actually succeeds');
  });
});
