// SessionManager 的协议细节：不起真实 agent，用替身连接核对发出去的请求形状。
import * as assert from 'assert';
import type { ChildProcess } from 'node:child_process';
import type * as vscode from 'vscode';

import { AgentManager, type AgentInstance } from '../core/AgentManager';
import { setAuthSecrets, takesApiKey } from '../core/auth';
import { ConnectionManager, type ConnectionInfo } from '../core/ConnectionManager';
import { SessionManager } from '../core/SessionManager';
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
    return method === 'setSessionConfigOption' ? { configOptions: [] } : {};
  };
  return {
    agentId: 'agent_1',
    connection: {
      newSession: record('newSession'),
      setSessionConfigOption: record('setSessionConfigOption'),
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
});
