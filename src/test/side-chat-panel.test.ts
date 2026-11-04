import * as assert from 'assert';
import { EventEmitter } from 'node:events';
import * as vscode from 'vscode';

import type { SessionInfo } from '../core/SessionManager';
import type { SessionManager } from '../core/SessionManager';
import type { ChatPanelHost } from '../ui/chat/ChatPanelHost';
import type { ChatSurface, SurfaceKey } from '../ui/chat/ChatSurface';
import type { PanelContext, SideChatOpener } from '../ui/chat/panelContract';
import { SideChatPanel } from '../ui/chat/SideChatPanel';

class FakeWebviewPanel {
  readonly webview: vscode.Webview;
  visible = true;
  reveals = 0;
  disposed = false;
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly disposeListeners = new Set<() => void>();

  constructor() {
    this.webview = {
      cspSource: 'vscode-webview://side-chat-test',
      html: '',
      options: {},
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        this.messageListeners.add(listener);
        return new vscode.Disposable(() => this.messageListeners.delete(listener));
      },
    } as unknown as vscode.Webview;
  }

  reveal(): void { this.reveals++; }

  onDidDispose(listener: () => void): vscode.Disposable {
    this.disposeListeners.add(listener);
    return new vscode.Disposable(() => this.disposeListeners.delete(listener));
  }

  emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) { listener(message); }
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const listener of Array.from(this.disposeListeners)) { listener(); }
    this.disposeListeners.clear();
  }
}

class HostStub {
  opener: SideChatOpener | null = null;
  attached: PanelContext[] = [];
  detached: SurfaceKey[] = [];
  released: string[] = [];
  quotes: Array<{ sessionId: string; text: string }> = [];
  messages: Array<{ message: unknown; from: SurfaceKey }> = [];
  timeline: string[] = [];
  active: string | null = null;
  failAttach = false;
  failActivate = false;

  setSideChatOpener(opener: SideChatOpener | null): void { this.opener = opener; }
  activeSideSessionId(): string | null { return this.active; }
  activateSideSession(sessionId: string): boolean {
    if (this.failActivate) { throw new Error('activate failed'); }
    if (!this.opener?.has(sessionId)) { return false; }
    if (this.active !== sessionId) { this.timeline.push(`focus:${sessionId}`); }
    this.active = sessionId;
    return true;
  }
  postSideQuote(sessionId: string, text: string): void {
    this.quotes.push({ sessionId, text });
    this.timeline.push(`quote:${sessionId}:${text}`);
  }
  releaseSideSession(sessionId: string): void { this.released.push(sessionId); }
  attachSurface(_surface: ChatSurface, context: PanelContext): void {
    if (this.failAttach) { throw new Error('attach failed'); }
    this.attached.push(context);
    this.active = context.sessionId;
  }
  detachSurface(key: SurfaceKey): void {
    this.detached.push(key);
    if (key === 'side') { this.active = null; }
  }
  onMessage(message: unknown, from: SurfaceKey = 'view'): void { this.messages.push({ message, from }); }
}

class ManagerStub extends EventEmitter {
  readonly sessions = new Map<string, SessionInfo>();
  readonly forked: string[] = [];
  readonly deleted: string[] = [];
  readonly events: string[] = [];
  host: HostStub | null = null;
  forkError: Error | null = null;
  failForkAt = 0;
  forkGate: Promise<void> | null = null;
  private nextId = 1;

  addMain(sessionId: string): void {
    this.sessions.set(sessionId, {
      sessionId,
      agentId: 'agent-1',
      agentName: 'Claude Code',
      agentDisplayName: 'Claude Code',
      cwd: '/tmp',
      createdAt: '2026-11-03T00:00:00.000Z',
      initResponse: { protocolVersion: 1 },
      modes: null,
      models: null,
      configOptions: null,
      availableCommands: [],
    });
  }

  getSession(sessionId: string): SessionInfo | undefined { return this.sessions.get(sessionId); }

  async forkSideSession(agentName: string, sourceSessionId: string): Promise<SessionInfo> {
    this.forked.push(sourceSessionId);
    this.events.push(`fork:${sourceSessionId}`);
    if (this.forkError || this.failForkAt === this.forked.length) {
      throw this.forkError ?? new Error(`fork ${this.forked.length} failed`);
    }
    if (this.forkGate) { await this.forkGate; }
    const source = this.getSession(sourceSessionId);
    if (!source) { throw new Error('source closed'); }
    const sessionId = `side-${this.nextId++}`;
    const side: SessionInfo = {
      ...source,
      sessionId,
      sideChat: { parentSessionId: sourceSessionId, forkedAt: '2026-11-03T00:01:00.000Z' },
    };
    this.sessions.set(sessionId, side);
    this.emit('session-created', sessionId, agentName, 'side');
    return side;
  }

  async deleteSession(_agentName: string, sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
    this.events.push(`delete:${sessionId}`);
    this.sessions.delete(sessionId);
    this.emitClosed(sessionId);
  }

  closeMain(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.emitClosed(sessionId);
  }

  closeSideExternally(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.emitClosed(sessionId);
  }

  private emitClosed(sessionId: string): void {
    if (this.host?.active === sessionId) { this.host.active = null; }
    this.emit('session-closed', sessionId, 'Claude Code', 'user');
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.ok(check(), label);
}

suite('Side Chat panel lifecycle', () => {
  const panels: SideChatPanel[] = [];

  teardown(() => {
    for (const panel of panels.splice(0)) { panel.dispose(); }
  });

  function setup(options: {
    createPanel?: (panel: FakeWebviewPanel) => void;
  } = {}) {
    const manager = new ManagerStub();
    manager.addMain('main-1');
    manager.addMain('main-2');
    const host = new HostStub();
    manager.host = host;
    const created: FakeWebviewPanel[] = [];
    const panel = new SideChatPanel(
      host as unknown as ChatPanelHost,
      manager as unknown as SessionManager,
      vscode.Uri.file('/tmp/side-chat-test'),
      {
        createPanel: () => {
          const webviewPanel = new FakeWebviewPanel();
          created.push(webviewPanel);
          options.createPanel?.(webviewPanel);
          return webviewPanel as unknown as vscode.WebviewPanel;
        },
      },
    );
    panels.push(panel);
    assert.strictEqual(host.opener, panel);
    return { manager, host, created, panel };
  }

  test('a failed fork creates no panel and leaves no temporary session to clean', async () => {
    const { manager, created, panel } = setup();
    manager.forkError = new Error('fork unsupported');

    await assert.rejects(panel.open('main-1'), /fork unsupported/);
    assert.strictEqual(created.length, 0);
    assert.strictEqual(panel.isOpen, false);
    assert.deepStrictEqual(manager.deleted, []);
  });

  test('same-source opens create independent tabs and keep quotes session-scoped', async () => {
    const { manager, host, created, panel } = setup();
    const first = panel.open('main-1', 'first');
    const second = panel.open('main-1', 'second');
    await Promise.all([first, second]);

    assert.deepStrictEqual(manager.forked, ['main-1', 'main-1']);
    assert.deepStrictEqual(panel.sessionIds(), ['side-1', 'side-2']);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(host.active, 'side-2');
    created[0].emitMessage({ type: 'ready' });
    assert.deepStrictEqual(host.quotes, [{ sessionId: 'side-2', text: 'second' }]);

    assert.strictEqual(panel.activate('side-1'), true);
    assert.deepStrictEqual(host.quotes, [
      { sessionId: 'side-2', text: 'second' },
      { sessionId: 'side-1', text: 'first' },
    ]);
    assert.ok(host.timeline.indexOf('focus:side-1') < host.timeline.indexOf('quote:side-1:first'));

    await panel.open('main-1', 'third');
    assert.deepStrictEqual(host.quotes[2], { sessionId: 'side-3', text: 'third' });
    assert.strictEqual(manager.forked.length, 3);
    assert.strictEqual(created.length, 1);
  });

  test('cross-source opens preserve existing Side sessions', async () => {
    const { manager, host, created, panel } = setup();
    await panel.open('main-1');
    created[0].emitMessage({ type: 'ready' });
    await panel.open('main-2', 'other source');

    assert.deepStrictEqual(panel.sessionIds(), ['side-1', 'side-2']);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].disposed, false);
    assert.deepStrictEqual(manager.deleted, []);
    assert.deepStrictEqual(host.quotes, [{ sessionId: 'side-2', text: 'other source' }]);

    await panel.close('side-1');
    assert.strictEqual(host.active, 'side-2');
    assert.deepStrictEqual(panel.sessionIds(), ['side-2']);
  });

  test('opens are strictly serial and one failure does not block later opens', async () => {
    const { manager, panel, created } = setup();
    const gate = deferred();
    manager.forkGate = gate.promise;
    manager.failForkAt = 2;
    const first = panel.open('main-1');
    const second = panel.open('main-1');
    const third = panel.open('main-1');
    await waitFor(() => manager.forked.length === 1, 'the first fork');
    assert.strictEqual(manager.forked.length, 1);
    gate.resolve();
    const results = await Promise.allSettled([first, second, third]);

    assert.deepStrictEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled']);
    assert.deepStrictEqual(manager.forked, ['main-1', 'main-1', 'main-1']);
    assert.deepStrictEqual(panel.sessionIds(), ['side-1', 'side-2']);
    assert.strictEqual(created.length, 1);
  });

  test('an attach failure rolls back the fork, surface and panel', async () => {
    const { manager, host, created, panel } = setup();
    host.failAttach = true;

    await assert.rejects(panel.open('main-1'), /attach failed/);
    assert.strictEqual(panel.isOpen, false);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].disposed, true);
    assert.deepStrictEqual(manager.deleted, ['side-1']);
    assert.deepStrictEqual(host.released, ['side-1']);
    assert.deepStrictEqual(host.detached, ['side']);
  });

  test('a later activation failure rolls back only the new Side', async () => {
    const { manager, host, created, panel } = setup();
    await panel.open('main-1');
    host.failActivate = true;

    await assert.rejects(panel.open('main-1'), /activate failed/);
    assert.strictEqual(panel.isOpen, true);
    assert.strictEqual(created.length, 1);
    assert.strictEqual(host.active, 'side-1');
    assert.deepStrictEqual(panel.sessionIds(), ['side-1']);
    assert.deepStrictEqual(manager.deleted, ['side-2']);
  });

  test('closing active tabs chooses the right sibling and disposes only after the last', async () => {
    const { manager, host, created, panel } = setup();
    await panel.open('main-1');
    await panel.open('main-1');
    await panel.open('main-1');
    panel.activate('side-2');

    await panel.close('side-2');
    assert.strictEqual(host.active, 'side-3');
    assert.deepStrictEqual(panel.sessionIds(), ['side-1', 'side-3']);
    await panel.close('side-3');
    assert.strictEqual(host.active, 'side-1');
    assert.strictEqual(panel.isOpen, true);
    await panel.close('side-1');

    assert.strictEqual(panel.isOpen, false);
    assert.strictEqual(created[0].disposed, true);
    assert.deepStrictEqual(manager.deleted, ['side-2', 'side-3', 'side-1']);
    assert.deepStrictEqual(host.detached, ['side']);
  });

  test('closing a source cleans all its children and preserves other sources', async () => {
    const { manager, host, created, panel } = setup();
    await panel.open('main-1');
    await panel.open('main-1');
    await panel.open('main-2');
    panel.activate('side-2');

    manager.closeMain('main-1');
    await waitFor(() => manager.deleted.length === 2, 'source-close cleanup');
    assert.deepStrictEqual(manager.deleted, ['side-1', 'side-2']);
    assert.deepStrictEqual(panel.sessionIds(), ['side-3']);
    assert.strictEqual(host.active, 'side-3');
    assert.strictEqual(panel.isOpen, true);

    manager.closeMain('main-2');
    await waitFor(() => manager.deleted.length === 3, 'last-source cleanup');
    assert.strictEqual(created[0].disposed, true);
    assert.strictEqual(panel.isOpen, false);
  });

  test('an external Side close reconciles tabs without deleting again', async () => {
    const { manager, host, created, panel } = setup();
    await panel.open('main-1');
    await panel.open('main-1');
    panel.activate('side-1');

    manager.closeSideExternally('side-1');
    assert.strictEqual(host.active, 'side-2');
    assert.deepStrictEqual(panel.sessionIds(), ['side-2']);
    assert.deepStrictEqual(manager.deleted, []);
    manager.closeSideExternally('side-2');
    await waitFor(() => !panel.isOpen, 'external last-tab cleanup');
    assert.strictEqual(created[0].disposed, true);
    assert.deepStrictEqual(manager.deleted, []);
  });

  test('disposing the panel or provider cleans every Side exactly once', async () => {
    const { manager, host, created, panel } = setup();
    await panel.open('main-1');
    await panel.open('main-2');
    created[0].dispose();
    await waitFor(() => manager.deleted.length === 2, 'panel-dispose cleanup');
    assert.strictEqual(panel.isOpen, false);

    await panel.open('main-1');
    panel.dispose();
    panel.dispose();
    await waitFor(() => manager.deleted.length === 3, 'provider-dispose cleanup');
    assert.deepStrictEqual(manager.deleted, ['side-1', 'side-2', 'side-3']);
    assert.deepStrictEqual(host.released, ['side-1', 'side-2', 'side-3']);
    assert.strictEqual(host.opener, null);
  });

  test('dispose during an in-flight fork deletes the late session without creating a panel', async () => {
    const { manager, created, panel } = setup();
    const gate = deferred();
    manager.forkGate = gate.promise;
    const opening = panel.open('main-1');
    await waitFor(() => manager.forked.length === 1, 'the in-flight fork');

    panel.dispose();
    gate.resolve();
    await opening;
    assert.strictEqual(panel.isOpen, false);
    assert.strictEqual(created.length, 0);
    assert.deepStrictEqual(manager.deleted, ['side-1']);
  });
});
