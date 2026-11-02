import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ChildProcess } from 'node:child_process';
import type { CreateElicitationRequest, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

import { AcpClientImpl, type ClientHandlers } from '../core/AcpClientImpl';
import { AgentConnector } from '../core/AgentConnector';
import { AgentManager, type AgentInstance } from '../core/AgentManager';
import { ConnectionManager, type ConnectionInfo } from '../core/ConnectionManager';
import { SessionManager } from '../core/SessionManager';
import { FileSystemHandler } from '../handlers/FileSystemHandler';
import { PermissionBridge } from '../handlers/PermissionBridge';
import { ElicitationBridge } from '../handlers/ElicitationBridge';
import { SessionUpdateHandler } from '../handlers/SessionUpdateHandler';
import { TerminalHandler } from '../handlers/TerminalHandler';
import { terminateTree } from '../utils/ProcessTree';
import { withDeadline } from '../utils/AsyncDeadline';
import { withCancellationToken } from '../utils/CancellationToken';
import { spawnTerminalCommand } from '../utils/TerminalCommand';

async function cleanupTempDir(dir: string): Promise<void> {
  assert.strictEqual(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.match(path.basename(dir), /^vac-(file|batch)-test-/);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));
const permission = (sessionId: string): RequestPermissionRequest => ({ sessionId, toolCall: { toolCallId: 't', title: 'Run' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
const form = (sessionId: string): CreateElicitationRequest => ({ mode: 'form', sessionId, message: 'Question', requestedSchema: { type: 'object', properties: { q: { type: 'string' } } } });

class FakeAgents extends AgentManager {
  killed: string[] = [];
  disposedCalls = 0;
  override spawnAgent(name: string): AgentInstance { return { id: 'agent-test', name, process: {} as ChildProcess, config: { command: 'unused' } }; }
  override getRunningAgents(): AgentInstance[] { return []; }
  override killAgent(id: string): boolean { this.killed.push(id); return true; }
  override dispose(): void { this.disposedCalls++; super.dispose(); }
}

suite('review regression: filesystem consistency', () => {
  for (const dirty of [false, true]) {
    test(dirty ? 'refuses dirty-buffer writes without losing user changes' : 'updates clean editor and disk consistently', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vac-file-test-'));
      const file = path.join(dir, 'sample.txt');
      const uri = vscode.Uri.file(file);
      try {
        await fs.writeFile(file, 'disk');
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        if (dirty) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), 'user draft');
          assert.ok(await vscode.workspace.applyEdit(edit));
          assert.ok(doc.isDirty);
        }
        const handler = new FileSystemHandler();
        const request = { sessionId: 's', path: file, content: 'agent result' };
        if (dirty) {
          await assert.rejects(handler.writeTextFile(request), /unsaved editor/);
          assert.strictEqual(doc.getText(), 'user draft');
          assert.strictEqual(await fs.readFile(file, 'utf8'), 'disk');
        } else {
          await handler.writeTextFile(request);
          assert.strictEqual(doc.getText(), 'agent result');
          assert.strictEqual(await fs.readFile(file, 'utf8'), 'agent result');
          assert.strictEqual(doc.isDirty, false);
        }
        assert.strictEqual((await handler.readTextFile({ sessionId: 's', path: file })).content, doc.getText());
      } finally {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await cleanupTempDir(dir);
      }
    });
  }
});

suite('review regression: cancellation and ownership', () => {
  test('cancelled permission fallback cannot stall FIFO, even when it ignores abort', async () => {
    const bridge = new PermissionBridge();
    let signal: AbortSignal | undefined;
    let late!: (response: RequestPermissionResponse) => void;
    let secondStarted = false;
    try {
      const first = bridge.request(permission('first'), (_p, _l, s) => { signal = s; return new Promise(r => late = r); });
      const second = bridge.request(permission('second'), async () => { secondStarted = true; return { outcome: { outcome: 'selected', optionId: 'allow' } }; });
      await tick();
      assert.strictEqual(secondStarted, false);
      bridge.cancelSession('first');
      assert.deepStrictEqual(await first, { outcome: { outcome: 'cancelled' } });
      assert.strictEqual(signal?.aborted, true);
      assert.deepStrictEqual(await second, { outcome: { outcome: 'selected', optionId: 'allow' } });
      late({ outcome: { outcome: 'selected', optionId: 'allow' } });
      await tick();
      assert.strictEqual(bridge.pendingCount, 0);
    } finally { bridge.dispose(); }
  });

  test('cancelled elicitation fallback cannot stall FIFO', async () => {
    const bridge = new ElicitationBridge();
    let signal: AbortSignal | undefined;
    try {
      const first = bridge.request(form('first'), (_p, _l, s) => { signal = s; return new Promise(() => undefined); });
      const second = bridge.request(form('second'), async () => ({ action: 'accept', content: { q: 'yes' } }));
      bridge.cancelSession('first');
      assert.deepStrictEqual(await first, { action: 'cancel' });
      assert.strictEqual(signal?.aborted, true);
      assert.deepStrictEqual(await second, { action: 'accept', content: { q: 'yes' } });
      assert.strictEqual(bridge.pendingCount, 0);
    } finally { bridge.dispose(); }
  });

  test('AbortSignal cancels the VS Code UI token', async () => {
    const controller = new AbortController();
    let token!: vscode.CancellationToken;
    let release!: () => void;
    const pending = withCancellationToken(controller.signal, t => { token = t; return new Promise<void>(r => release = r); });
    controller.abort();
    assert.strictEqual(token.isCancellationRequested, true);
    release();
    await pending;
  });

  test('a second connection cannot update or request tools for an owned id', async () => {
    const updates = new SessionUpdateHandler();
    let observed = 0;
    let permissions = 0;
    updates.addListener(() => observed++);
    updates.claim('shared', 'first-agent');
    const handlers = { sessionUpdate: updates, permission: { requestPermission: async () => { permissions++; return { outcome: { outcome: 'cancelled' } }; } } } as unknown as ClientHandlers;
    const second = new AcpClientImpl(handlers, 'second-agent');
    await second.sessionUpdate({ sessionId: 'shared', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } });
    assert.strictEqual(observed, 0);
    assert.throws(() => second.requestPermission(permission('shared')), /another agent/);
    assert.strictEqual(permissions, 0);
    updates.releaseAgent('first-agent');
    assert.strictEqual(updates.accepts('shared', 'first-agent'), false, 'late traffic from disconnected connections is ignored');
    assert.strictEqual(updates.accepts('shared', 'second-agent'), true);
    updates.dispose();
  });

  test('disconnect and dispose settle both bridges and dispose AgentManager once', async () => {
    const agents = new FakeAgents();
    const updates = new SessionUpdateHandler();
    const manager = new SessionManager(agents, new ConnectionManager(updates), updates);
    const permissions = new PermissionBridge();
    const forms = new ElicitationBridge();
    manager.setPermissionBridge(permissions);
    manager.setElicitationBridge(forms);
    manager.seedSession({ sessionId: 's', agentId: 'agent-test', agentName: 'Codex CLI', agentDisplayName: 'Codex CLI', cwd: process.cwd(), createdAt: new Date().toISOString(), initResponse: { protocolVersion: 1 }, modes: null, models: null, configOptions: null, availableCommands: [] });
    const p = permissions.request(permission('s'), () => new Promise(() => undefined));
    const f = forms.request(form('s'), () => new Promise(() => undefined));
    await manager.disconnectAgent('Codex CLI');
    assert.deepStrictEqual(await p, { outcome: { outcome: 'cancelled' } });
    assert.deepStrictEqual(await f, { action: 'cancel' });
    manager.dispose();
    manager.dispose();
    assert.strictEqual(agents.disposedCalls, 1);
    permissions.dispose(); forms.dispose(); updates.dispose();
  });

  for (const dispose of [false, true]) {
    test(dispose ? 'dispose rejects an in-flight handshake and ignores late success' : 'disconnect rejects an in-flight handshake and ignores late success', async () => {
      const agents = new FakeAgents();
      let release!: (value: ConnectionInfo) => void;
      const gate = new Promise<ConnectionInfo>(r => release = r);
      const removed: string[] = [];
      const connections = { getConnection: () => undefined, connect: () => gate, removeConnection: (id: string) => removed.push(id) } as unknown as ConnectionManager;
      let connected = 0;
      const connector = new AgentConnector(agents, connections, { resolveCwd: () => process.cwd(), onConnected: () => connected++ });
      const pending = connector.ensure('Codex CLI');
      const rejection = assert.rejects(pending, /cancelled/);
      if (dispose) { connector.clear(); } else { assert.strictEqual(connector.cancel('Codex CLI'), true); }
      await rejection;
      release({ agentId: 'agent-test', initResponse: { protocolVersion: 1 } } as ConnectionInfo);
      await tick();
      assert.strictEqual(connector.agentIdOf('Codex CLI'), undefined);
      assert.strictEqual(connected, 0);
      assert.ok(removed.includes('agent-test'));
      assert.ok(agents.killed.includes('agent-test'));
      connector.clear(); agents.dispose();
    });
  }
});

suite('review regression: control-plane queue', () => {
  test('disconnect skips control-plane RPCs that have not started', async () => {
    const agents = new FakeAgents();
    const connections = { getConnection: () => ({ agentId: 'agent-test' }) } as unknown as ConnectionManager;
    const connector = new AgentConnector(agents, connections, { resolveCwd: () => process.cwd(), onConnected: () => {} });
    connector.register('test', 'agent-test');
    let release!: () => void;
    let started = false;
    const first = connector.enqueue('agent-test', () => new Promise<void>(r => release = r));
    const queued = connector.enqueue('agent-test', async () => { started = true; });
    const rejection = assert.rejects(queued, /cancelled/);
    await tick();
    connector.detach('test');
    release();
    await first;
    await rejection;
    assert.strictEqual(started, false);
    connector.clear(); agents.dispose();
  });
});

suite('review regression: terminals', () => {
  test('decodes split UTF-8 independently on stdout and stderr', async () => {
    const terminals = new TerminalHandler();
    try {
      const code = "const b=Buffer.from('中文');process.stdout.write(b.subarray(0,1));process.stderr.write(b.subarray(0,2));setTimeout(()=>{process.stdout.write(b.subarray(1));process.stderr.write(b.subarray(2));},30);";
      const result = await terminals.createTerminal({ sessionId: 's', command: process.execPath, args: ['-e', code], env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }] });
      const exit = await terminals.waitForTerminalExit({ sessionId: 's', terminalId: result.terminalId });
      assert.strictEqual(exit.exitCode, 0);
      assert.strictEqual(terminals.readOutput(result.terminalId)?.output, '中文中文');
    } finally { terminals.dispose(); }
  });
  test('spawn errors settle terminal exit and released terminals remain disposable', async () => {
    const terminals = new TerminalHandler();
    try {
      const result = await terminals.createTerminal({ sessionId: 's', command: 'vac-command-that-does-not-exist-123456' });
      const exit = await terminals.waitForTerminalExit({ sessionId: 's', terminalId: result.terminalId });
      assert.strictEqual(exit.exitCode, 1);
      assert.ok(terminals.readOutput(result.terminalId)?.exited);
      await terminals.releaseTerminal({ sessionId: 's', terminalId: result.terminalId });
      assert.strictEqual(terminals.readOutput(result.terminalId), null);
      terminals.dispose();
      await assert.rejects(terminals.createTerminal({ sessionId: 's', command: 'unused' }), /disposed/);
    } finally { terminals.dispose(); }
  });
  test('terminating a real process tree stops parent, child, and grandchild', async function () {
    this.timeout(15000);
    // VS Code 1.85's Windows Electron needs its run-as-node flag on every generation.
    const flags = process.platform === 'win32' && process.versions.electron && process.versions.node.startsWith('18.') ? ['--ms-enable-electron-run-as-node'] : [];
    const leaf = "console.log('PID ' + process.pid);setInterval(()=>{},1000)";
    const middle = "const{spawn}=require('node:child_process');console.log('PID '+process.pid);spawn(process.execPath," + JSON.stringify([...flags, '-e', leaf]) + ",{stdio:'inherit',windowsHide:true});setInterval(()=>{},1000)";
    const root = "const{spawn}=require('node:child_process');console.log('PID '+process.pid);spawn(process.execPath," + JSON.stringify([...flags, '-e', middle]) + ",{stdio:'inherit',windowsHide:true});setInterval(()=>{},1000)";
    const child = spawnTerminalCommand(process.execPath, [...flags, '-e', root], undefined, { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
    const pids = new Set<number>(); let buffer = ''; let diagnostics = '';
    child.stderr?.on('data', chunk => { diagnostics = (diagnostics + String(chunk)).slice(-4000); });
    const ready = new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => {
        if (pids.size < 3) { reject(new Error('Process tree exited during startup (' + code + '); collected=' + pids.size + '; ' + diagnostics)); }
      });
      child.stdout?.on('data', chunk => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
        for (const line of lines) { const match = /^PID (\d+)$/.exec(line); if (match) { pids.add(Number(match[1])); } }
        if (pids.size === 3) { resolve(); }
      });
    });
    try {
      await withDeadline(() => ready, 5000, 'process tree startup');
      terminateTree(child, 'SIGKILL');
      await withDeadline(async () => {
        while (true) {
          let alive = false;
          for (const pid of pids) {
            try {
              process.kill(pid, 0);
              // Linux init/reapers may briefly retain a dead orphan as a zombie.
              if (process.platform === 'linux') {
                try { const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8'); if (/\) Z /.test(stat)) { continue; } }
                catch { continue; }
              }
              alive = true;
            } catch { /* process is gone */ }
          }
          if (!alive) { return; }
          await new Promise(r => setTimeout(r, 30));
        }
      }, 6000, 'process tree shutdown');
      assert.strictEqual(pids.size, 3);
    } finally { terminateTree(child, 'SIGKILL'); }
  });
  test('Windows batch shim preserves safe argument boundaries', async function () {
    if (process.platform !== 'win32') { this.skip(); }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vac-batch-test-'));
    try {
      const command = path.join(dir, 'probe.cmd');
      await fs.writeFile(command, '@echo off\r\necho [%~1]\r\necho [%~2]\r\n');
      for (const launch of [command, './probe']) {
        const child = spawnTerminalCommand(launch, ['hello world', 'second'], dir, process.env);
        let output = '';
        child.stdout?.on('data', chunk => output += String(chunk));
        await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('batch exit ' + code))); });
        assert.ok(output.includes('[hello world]'));
        assert.ok(output.includes('[second]'));
      }
    } finally { await cleanupTempDir(dir); }
  });
});
