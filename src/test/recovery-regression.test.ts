import type { PromptResponse } from '@agentclientprotocol/sdk';
import * as assert from 'node:assert';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { AgentManager, type AgentInstance } from '../core/AgentManager';
import { AgentConnector } from '../core/AgentConnector';
import { ConnectionManager, type ConnectionInfo } from '../core/ConnectionManager';
import { SessionManager } from '../core/SessionManager';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { withDeadline } from '../utils/AsyncDeadline';

class RecoveryAgents extends AgentManager {
  spawns = 0;
  readonly killed: string[] = [];
  override spawnAgent(name: string): AgentInstance {
    return { id: 'recovery-' + (++this.spawns), name, process: {} as ChildProcess, config: { command: 'unused' } };
  }
  override getRunningAgents(): AgentInstance[] { return []; }
  override killAgent(id: string): boolean { this.killed.push(id); return true; }
}
class RecoveryConnections extends ConnectionManager {
  readonly live = new Map<string, ConnectionInfo>();
  readonly calls: string[] = [];
  onResume: () => Promise<unknown> = async () => ({});
  failConnect = false;
  override async connect(id: string): Promise<ConnectionInfo> {
    if (this.failConnect) { throw new Error('process failed'); }
    const conn = {
      agentId: id,
      initResponse: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
      connection: { resumeSession: async (params: { sessionId: string }) => { this.calls.push(params.sessionId); return this.onResume(); } },
    } as unknown as ConnectionInfo;
    this.live.set(id, conn); return conn;
  }
  override getConnection(id: string): ConnectionInfo | undefined { return this.live.get(id); }
  override removeConnection(id: string): void { this.live.delete(id); super.removeConnection(id); }
  override dispose(): void { this.live.clear(); super.dispose(); }
}
async function setup(delaysMs = [0, 0, 0], enabled = true) {
  const agents = new RecoveryAgents(); const updates = new SessionUpdateHandler();
  const connections = new RecoveryConnections(updates);
  const manager = new SessionManager(agents, connections, updates, { enabled: () => enabled, delaysMs, resumeTimeoutMs: 30 });
  const conn = await manager.ensureConnected('Codex CLI');
  const session = { sessionId: 'retained', agentName: 'Codex CLI', agentId: conn.agentId, agentDisplayName: 'Codex CLI',
    cwd: process.cwd(), createdAt: new Date().toISOString(), initResponse: conn.initResponse,
    modes: null, models: null, configOptions: null, availableCommands: [], title: 'kept title' };
  manager.seedSession(session); manager.focusSession(session.sessionId);
  const close = () => { manager.dispose(); updates.dispose(); };
  const crash = () => agents.emit('agent-closed', { agentId: conn.agentId, code: 1, name: 'Codex CLI' });
  return { manager, agents, updates, connections, session, crash, close };
}
const event = (manager: SessionManager, name: string) => withDeadline(() => once(manager, name), 2000, 'test event');

suite('connection recovery regression', () => {
  test('resumes retained identity without closing tabs or replaying prompts', async () => {
    const env = await setup(); let closed = 0;
    env.manager.on('session-closed', () => closed++);
    try {
      const done = event(env.manager, 'agent-recovered'); env.crash(); await done;
      assert.strictEqual(env.manager.getSession('retained'), env.session);
      assert.strictEqual(env.session.agentId, 'recovery-2');
      assert.strictEqual(env.session.title, 'kept title');
      assert.strictEqual(env.manager.getActiveSessionId(), 'retained');
      assert.strictEqual(closed, 0); assert.deepStrictEqual(env.connections.calls, ['retained']);
      assert.strictEqual(env.updates.accepts('retained', 'recovery-1'), false);
      assert.strictEqual(env.updates.accepts('retained', 'recovery-2'), true);
    } finally { env.close(); }
  });
  test('authentication failure stops once and keeps tabs for explicit reconnect', async () => {
    const env = await setup();
    try {
      env.connections.onResume = async () => { throw Object.assign(new Error('authentication required'), { code: -32000 }); };
      const stopped = event(env.manager, 'agent-recovery-failed'); env.crash(); await stopped;
      assert.strictEqual(env.agents.spawns, 2); assert.ok(env.agents.killed.includes('recovery-2')); assert.deepStrictEqual(env.connections.calls, ['retained']);
      assert.strictEqual(env.manager.getSession('retained'), env.session);
      assert.strictEqual(env.manager.getConnectionForSession('retained'), undefined);
      env.connections.onResume = async () => ({});
      await env.manager.connectToAgent('Codex CLI');
      assert.strictEqual(env.manager.getSession('retained'), env.session);
      assert.strictEqual(env.session.agentId, 'recovery-3');
    } finally { env.close(); }
  });
  test('concurrent manual reconnects share one retained-session resume', async () => {
    const env = await setup([1000]);
    let release!: (value: unknown) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    try {
      env.crash(); env.manager.cancelAutomaticRecovery();
      env.connections.onResume = () => { started(); return new Promise(resolve => { release = resolve; }); };
      const first = env.manager.ensureConnected('Codex CLI');
      const second = env.manager.ensureConnected('Codex CLI');
      await entered; release({});
      const [a, b] = await Promise.all([first, second]);
      assert.strictEqual(a, b); assert.deepStrictEqual(env.connections.calls, ['retained']);
      assert.strictEqual(env.manager.getSession('retained'), env.session);
      await env.manager.ensureConnected('Codex CLI');
      assert.deepStrictEqual(env.connections.calls, ['retained']);
    } finally { env.close(); }
  });
  test('failed shared manual resume is released so an explicit retry can succeed', async () => {
    const env = await setup([1000]);
    try {
      env.crash(); env.manager.cancelAutomaticRecovery();
      env.connections.onResume = async () => { throw new Error('resume failed'); };
      const results = await Promise.allSettled([
        env.manager.ensureConnected('Codex CLI'), env.manager.ensureConnected('Codex CLI'),
      ]);
      assert.ok(results.every(result => result.status === 'rejected'));
      assert.deepStrictEqual(env.connections.calls, ['retained']);
      assert.strictEqual(env.manager.getConnectionForSession('retained'), undefined);
      env.connections.onResume = async () => ({});
      await env.manager.ensureConnected('Codex CLI');
      assert.deepStrictEqual(env.connections.calls, ['retained', 'retained']);
      assert.strictEqual(env.manager.getConnectionForSession('retained')?.agentId, env.session.agentId);
    } finally { env.close(); }
  });
  test('failed handshakes stop after three attempts', async () => {
    const env = await setup();
    try {
      env.connections.failConnect = true;
      const stopped = event(env.manager, 'agent-recovery-failed'); env.crash(); await stopped;
      assert.strictEqual(env.agents.spawns, 4);
      assert.strictEqual(env.manager.getSession('retained'), env.session);
    } finally { env.close(); }
  });
  test('explicit disconnect cancels delayed recovery and closes retained sessions', async () => {
    const env = await setup([30]);
    try {
      env.crash(); await env.manager.disconnectAgent('Codex CLI');
      await new Promise(r => setTimeout(r, 60));
      assert.strictEqual(env.agents.spawns, 1); assert.strictEqual(env.manager.getSession('retained'), undefined);
    } finally { env.close(); }
  });
  test('dispose cancels recovery before a spawn', async () => {
    const env = await setup([30]); env.crash(); env.close();
    await new Promise(r => setTimeout(r, 60)); assert.strictEqual(env.agents.spawns, 1);
  });
  test('a closed session is not resurrected by late resume success', async () => {
    const env = await setup(); let resolve!: (value: unknown) => void;
    let started!: () => void; const entered = new Promise<void>(r => { started = r; });
    try {
      env.connections.onResume = () => { started(); return new Promise(r => { resolve = r; }); };
      const done = event(env.manager, 'agent-recovered'); env.crash(); await entered;
      await env.manager.closeSession('Codex CLI', 'retained'); resolve({}); await done;
      assert.strictEqual(env.manager.getSession('retained'), undefined);
    } finally { env.close(); }
  });
  test('a stalled resume times out, stops its process, and preserves the tab', async () => {
    const env = await setup();
    try {
      env.connections.onResume = () => new Promise(() => {});
      const stopped = event(env.manager, 'agent-recovery-failed'); env.crash(); await stopped;
      assert.ok(env.agents.killed.includes('recovery-2'));
      assert.strictEqual(env.manager.getSession('retained'), env.session);
      assert.strictEqual(env.manager.getConnectionForSession('retained'), undefined);
    } finally { env.close(); }
  });
  test('turn responses from the dead connection cannot end a recovered turn', async () => {
    const env = await setup(); let endOld!: (value: PromptResponse) => void; let endNew!: (value: PromptResponse) => void;
    try {
      const old = env.manager.getConnectionForSession('retained')!;
      old.connection.prompt = () => new Promise(r => { endOld = r; });
      const oldTurn = env.manager.sendPrompt('retained', 'old');
      const done = event(env.manager, 'agent-recovered'); env.crash(); await done;
      const current = env.manager.getConnectionForSession('retained')!;
      current.connection.prompt = () => new Promise(r => { endNew = r; });
      const newTurn = env.manager.sendPrompt('retained', 'new');
      endOld({ stopReason: 'end_turn' }); await oldTurn;
      assert.strictEqual(env.manager.isTurnInFlight('retained'), true);
      endNew({ stopReason: 'end_turn' }); await newTurn;
      assert.strictEqual(env.manager.isTurnInFlight('retained'), false);
    } finally { env.close(); }
  });
  test('disabling automatic recovery while waiting cancels only the recovery, not its tab', async () => {
    const env = await setup([30]);
    try {
      env.crash(); env.manager.cancelAutomaticRecovery();
      await new Promise(r => setTimeout(r, 60));
      assert.strictEqual(env.agents.spawns, 1); assert.strictEqual(env.manager.getSession('retained'), env.session);
    } finally { env.close(); }
  });
  test('disabling recovery preserves deliberate teardown behavior', async () => {
    const env = await setup([0], false);
    try { env.crash(); assert.strictEqual(env.manager.getSession('retained'), undefined); assert.strictEqual(env.agents.spawns, 1); }
    finally { env.close(); }
  });
  test('real stalled initialize times out and the connector stops its process', async () => {
    class StalledAgents extends AgentManager {
      child?: ChildProcess;
      override spawnAgent(name: string): AgentInstance {
        const flags = process.versions.electron && process.versions.node.startsWith('18.') ? ['--ms-enable-electron-run-as-node'] : [];
        const instance = super.spawnAgent(name, { command: process.execPath, args: [...flags, '-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], env: { ELECTRON_RUN_AS_NODE: '1' } });
        this.child = instance.process; return instance;
      }
    }
    const agents = new StalledAgents(); const updates = new SessionUpdateHandler();
    const connections = new ConnectionManager(updates, undefined, undefined, { initializeTimeoutMs: 40 });
    const connector = new AgentConnector(agents, connections, { resolveCwd: () => process.cwd(), onConnected: () => assert.fail('must not connect') });
    try {
      const pending = connector.ensure('Codex CLI');
      const exited = agents.child ? once(agents.child, 'close').then(() => {}) : Promise.resolve();
      await assert.rejects(pending, /initialize timed out/);
      await withDeadline(() => exited, 5000, 'agent process exit');
      assert.strictEqual(connector.isConnected('Codex CLI'), false);
      assert.strictEqual(agents.getRunningAgents().length, 0);
    } finally { connector.clear(); agents.dispose(); connections.dispose(); updates.dispose(); }
  });
});
