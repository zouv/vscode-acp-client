import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscodeNs from 'vscode';

const executeCommand = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
vi.mock('vscode', () => ({
  commands: {
    executeCommand: (...args: unknown[]) => executeCommand(...args),
  },
}));

import { DashboardViewProvider } from './DashboardViewProvider';
import { EMPTY_SNAPSHOT } from './DashboardModel';

interface FakeView {
  visible: boolean;
  posts: unknown[];
  webview: {
    options: Record<string, unknown>;
    html: string;
    cspSource: string;
  };
  setVisible(v: boolean): void;
  receive(msg: unknown): void;
}

function fakeView(): FakeView {
  let messageCb: (msg: unknown) => void = () => undefined;
  let visibilityCb: () => void = () => undefined;
  const posts: unknown[] = [];
  const view = {
    visible: true,
    posts,
    webview: {
      options: {} as Record<string, unknown>,
      html: '',
      cspSource: 'vscode-webview://csp',
      onDidReceiveMessage(cb: (msg: unknown) => void) {
        messageCb = cb;
        return { dispose: () => undefined };
      },
      async postMessage(msg: unknown) {
        posts.push(msg);
        return true;
      },
    },
    onDidChangeVisibility(cb: () => void) {
      visibilityCb = cb;
      return { dispose: () => undefined };
    },
    onDidDispose(_cb: () => void) {
      return { dispose: () => undefined };
    },
    setVisible(v: boolean) {
      view.visible = v;
      visibilityCb();
    },
    receive(msg: unknown) {
      messageCb(msg);
    },
  };
  return view as unknown as FakeView;
}

interface ProviderBundle {
  provider: DashboardViewProvider;
  refreshes: number[];
  fireChange: () => void;
}

function makeProvider(opts: { enabled?: boolean } = {}): ProviderBundle {
  const refreshes: number[] = [];
  const changeCbs = new Set<() => void>();
  const service = {
    onDidChange: (cb: () => void) => {
      changeCbs.add(cb);
      return { dispose: () => changeCbs.delete(cb) };
    },
    snapshot: () => EMPTY_SNAPSHOT,
    refresh: async () => {
      refreshes.push(1);
    },
  };
  const host = {
    connectionSummary: () => [{ name: 'Claude Code', connected: true, sessions: 1 }],
    recentSessions: (limit: number) => [{ agentName: 'Claude Code', sessionId: 's' + limit, title: 't', cwd: '/p', lastActiveAt: 'x' }],
    onDidChangeState: () => ({ dispose: () => undefined }),
  };
  const provider = new DashboardViewProvider(
    { fsPath: '/ext' } as unknown as vscodeNs.Uri,
    service as unknown as never,
    host,
    { isEnabled: () => opts.enabled ?? true },
  );
  return { provider, refreshes, fireChange: () => changeCbs.forEach((cb) => cb()) };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  executeCommand.mockClear();
});

describe('DashboardViewProvider', () => {
  it('uses the vac-dashboard view type', () => {
    expect(DashboardViewProvider.viewType).toBe('vac-dashboard');
  });

  it('renders html with a nonce and an enabled-script webview', () => {
    const { provider } = makeProvider();
    const view = fakeView();
    provider.resolveWebviewView(view as unknown as vscodeNs.WebviewView);
    expect(view.webview.options).toMatchObject({ enableScripts: true });
    expect(view.webview.html).toContain('Content-Security-Policy');
    expect(view.webview.html).toMatch(/nonce="[A-Za-z0-9]{32}"/);
    provider.dispose();
  });

  it('posts a snapshot to a visible webview', async () => {
    const { provider } = makeProvider();
    const view = fakeView();
    provider.resolveWebviewView(view as unknown as vscodeNs.WebviewView);
    await provider.refresh();
    const last = view.posts[view.posts.length - 1] as { type: string; usage: unknown; connections: unknown[]; sessions: unknown[] };
    expect(last.type).toBe('snapshot');
    expect(last.usage).toBe(EMPTY_SNAPSHOT);
    expect(last.connections).toHaveLength(1);
    expect(last.sessions).toHaveLength(1);
    provider.dispose();
  });

  it('does not post while the view is hidden and reposts when it becomes visible', async () => {
    const { provider } = makeProvider();
    const view = fakeView();
    provider.resolveWebviewView(view as unknown as vscodeNs.WebviewView);
    await provider.refresh();
    const before = view.posts.length;

    view.setVisible(false);
    await provider.refresh();
    expect(view.posts.length).toBe(before);

    view.setVisible(true);
    await settle();
    expect(view.posts.length).toBeGreaterThan(before);
    provider.dispose();
  });

  it('executes only whitelisted command ids from the webview', async () => {
    const { provider } = makeProvider();
    const view = fakeView();
    provider.resolveWebviewView(view as unknown as vscodeNs.WebviewView);

    view.receive({ type: 'command', id: 'vac.newConversation' });
    view.receive({ type: 'command', id: 'vac.evil' });
    view.receive({ type: 'command' });
    view.receive({ type: 'command', id: null });
    view.receive('not-an-object');
    view.receive(undefined);
    await settle();
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith('vac.newConversation');
    provider.dispose();
  });

  it('opens a session only when both ids are strings', async () => {
    const { provider } = makeProvider();
    const view = fakeView();
    provider.resolveWebviewView(view as unknown as vscodeNs.WebviewView);

    view.receive({ type: 'openSession', agentName: 'Claude Code', sessionId: 's1' });
    view.receive({ type: 'openSession', agentName: 'Claude Code' });
    view.receive({ type: 'openSession', agentName: 7, sessionId: 's1' });
    view.receive({ type: 'openSession', agentName: 'Claude Code', sessionId: 's2' });
    await settle();
    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(executeCommand).toHaveBeenCalledWith('vac.openSession', { agentName: 'Claude Code', sessionId: 's1' });
    expect(executeCommand).toHaveBeenCalledWith('vac.openSession', { agentName: 'Claude Code', sessionId: 's2' });
    provider.dispose();
  });

  it('refreshes on a webview refresh message', async () => {
    const { provider, refreshes } = makeProvider();
    const view = fakeView();
    provider.resolveWebviewView(view as unknown as vscodeNs.WebviewView);
    const before = refreshes.length;
    view.receive({ type: 'refresh' });
    await settle();
    expect(refreshes.length).toBe(before + 1);
    provider.dispose();
  });

  it('skips scanning and posts a notice when the dashboard is disabled', async () => {
    const { provider, refreshes } = makeProvider({ enabled: false });
    const view = fakeView();
    provider.resolveWebviewView(view as unknown as vscodeNs.WebviewView);
    await provider.refresh();
    expect(refreshes).toHaveLength(0);
    const last = view.posts[view.posts.length - 1] as { notice?: string };
    expect(last.notice).toContain('vac.dashboard.enabled');
    provider.dispose();
  });

  it('stops posting service-driven updates after dispose', async () => {
    const { provider, fireChange } = makeProvider();
    const view = fakeView();
    provider.resolveWebviewView(view as unknown as vscodeNs.WebviewView);
    await provider.refresh();
    const before = view.posts.length;

    fireChange();
    await new Promise((r) => setTimeout(r, 150));
    expect(view.posts.length).toBe(before + 1);

    provider.dispose();
    const afterDispose = view.posts.length;
    fireChange();
    await new Promise((r) => setTimeout(r, 150));
    expect(view.posts.length).toBe(afterDispose);
  });
});
