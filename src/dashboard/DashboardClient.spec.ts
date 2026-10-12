import { describe, expect, it } from 'vitest';
import { DASHBOARD_COMMANDS, renderDashboardHtml } from './DashboardHtml';
import { Period, UsageTokens } from './usage/types';

interface FakeElement {
  id: string;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
}

const SLOTS = ['status', 'cards', 'connections', 'sessions', 'chart', 'breakdown', 'empty', 'unpriced'];

function period(partial: Partial<Period> = {}): Period {
  const t: UsageTokens = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  return { ...t, tokens: 0, cost: 0, messages: 0, ...partial };
}

function snapshotMessage() {
  return {
    type: 'snapshot',
    notice: undefined,
    connections: [
      { name: 'Claude Code', connected: true, sessions: 2 },
      { name: 'Codex', connected: false, sessions: 0 },
    ],
    sessions: [{ agentName: 'Claude Code', sessionId: 'sess-42', title: 'Fix <script> & escape', cwd: 'D:\\p', lastActiveAt: '2026-10-12T00:00:00.000Z' }],
    usage: {
      version: 1,
      generatedAt: 1,
      scanning: false,
      firstScanDone: true,
      hasData: true,
      pricingAsOf: '2026-01',
      periods: {
        today: period({ input: 1000, output: 20, tokens: 1020, cost: 0.5, messages: 3 }),
        last7d: period({ tokens: 2000, cost: 1 }),
        last30d: period({ tokens: 3000, cost: 1.5 }),
        all: period({ tokens: 4000, cost: 2, messages: 10 }),
      },
      daily: Array.from({ length: 30 }, (_, i) => ({ ...period(), day: '2026-10-0' + (i % 9), tokens: i * 10 })),
      breakdown: {
        last30d: {
          models: [
            { name: 'claude-sonnet-5.5', agent: 'claude', priced: true, tokens: 1000, cost: 1, messages: 2, input: 1000, output: 0, cacheCreate: 0, cacheRead: 0 },
            { name: 'glm-5.3-flash', agent: 'claude', priced: false, tokens: 500, cost: 0, messages: 1, input: 500, output: 0, cacheCreate: 0, cacheRead: 0 },
          ],
          projects: [{ name: 'D:\\proj', agent: 'claude', priced: true, tokens: 1000, cost: 1, messages: 2, input: 1000, output: 0, cacheCreate: 0, cacheRead: 0 }],
        },
        all: { models: [], projects: [] },
      },
      unpriced: { tokens: 500, models: ['glm-5.3-flash'] },
      sources: [{ agent: 'claude', files: 12 }],
    },
  };
}

function boot() {
  const html = renderDashboardHtml({ cspSource: 'vscode-webview://x', nonce: 'N1' });
  const script = html.slice(html.lastIndexOf('<script nonce=') + '<script nonce="N1">'.length, html.lastIndexOf('</script>'));
  const elements = new Map<string, FakeElement>();
  for (const id of SLOTS) {
    elements.set(id, { id, textContent: '', innerHTML: '', hidden: false });
  }
  const documentListeners: Array<(ev: any) => void> = [];
  const windowListeners: Array<(ev: any) => void> = [];
  const posted: any[] = [];
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    addEventListener: (type: string, cb: (ev: any) => void) => documentListeners.push(cb),
    addEventListener_types: () => undefined,
  };
  const window = { addEventListener: (type: string, cb: (ev: any) => void) => windowListeners.push(cb) };
  const acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
  new Function('acquireVsCodeApi', 'document', 'window', script)(acquireVsCodeApi, document, window);
  return { html, elements, windowListeners, documentListeners, posted };
}

function send(listeners: Array<(ev: any) => void>, data: unknown): void {
  for (const cb of listeners) {
    cb({ data });
  }
}

describe('dashboard client script', () => {
  it('requests a refresh once on load', () => {
    const { posted } = boot();
    expect(posted).toEqual([{ type: 'refresh' }]);
  });

  it('renders cards, breakdown and sessions from a snapshot message', () => {
    const h = boot();
    send(h.windowListeners, snapshotMessage());
    expect(h.elements.get('cards')?.innerHTML).toContain('1.0k');
    expect(h.elements.get('cards')?.innerHTML).toContain('est. $0.50');
    expect(h.elements.get('cards')?.innerHTML).toContain('est. $2.00');
    expect(h.elements.get('cards')?.innerHTML).toContain('Estimated equivalent API cost');
    expect(h.elements.get('connections')?.innerHTML).toContain('Claude Code');
    expect(h.elements.get('connections')?.innerHTML).toContain('dot on');
    expect(h.elements.get('sessions')?.innerHTML).toContain('data-session="sess-42"');
    expect(h.elements.get('breakdown')?.innerHTML).toContain('Top models (30d)');
    expect(h.elements.get('breakdown')?.innerHTML).toContain('n/a');
    expect(h.elements.get('chart')?.innerHTML).toContain('<svg');
    expect(h.elements.get('chart')?.innerHTML).toContain('<desc>');
    expect(h.elements.get('empty')?.hidden).toBe(true);
    expect(h.elements.get('unpriced')?.textContent).toContain('glm-5.3-flash');
  });

  it('escapes untrusted session titles', () => {
    const h = boot();
    send(h.windowListeners, snapshotMessage());
    const sessions = h.elements.get('sessions')?.innerHTML ?? '';
    expect(sessions).toContain('&lt;script&gt;');
    expect(sessions).not.toContain('<script>');
  });

  it('shows the scanning state and the empty state', () => {
    const h = boot();
    const msg = snapshotMessage();
    msg.usage.hasData = false;
    msg.usage.scanning = true;
    send(h.windowListeners, msg);
    expect(h.elements.get('status')?.textContent).toContain('Scanning');
    expect(h.elements.get('empty')?.hidden).toBe(false);
    expect(h.elements.get('empty')?.innerHTML).toContain('No transcripts found yet');
    expect(h.elements.get('chart')?.innerHTML).toBe('');
  });

  it('surfaces a host notice and source errors in the status line', () => {
    const h = boot();
    const msg = snapshotMessage();
    (msg as any).notice = 'Dashboard disabled';
    send(h.windowListeners, msg);
    expect(h.elements.get('status')?.textContent).toBe('Dashboard disabled');

    const err = snapshotMessage();
    (err.usage as { lastError?: string }).lastError = 'EACCES';
    send(h.windowListeners, err);
    expect(h.elements.get('status')?.textContent).toContain('EACCES');
  });

  it('posts whitelisted command ids and drops everything else', () => {
    const h = boot();
    const click = h.documentListeners[0];
    click({ target: { closest: (sel: string) => (sel === '[data-command]' ? { getAttribute: () => 'vac.newConversation' } : null) } });
    click({ target: { closest: (sel: string) => (sel === '[data-command]' ? { getAttribute: () => 'vac.evil' } : null) } });
    click({ target: { closest: (sel: string) => (sel === '[data-command]' ? { getAttribute: () => 'vac.refreshDashboard' } : null) } });
    click({
      target: {
        closest: (sel: string) =>
          sel === '[data-session]'
            ? { getAttribute: (k: string) => (k === 'data-agent' ? 'Claude Code' : 'sess-42') }
            : null,
      },
    });
    expect(h.posted.slice(1)).toEqual([
      { type: 'command', id: 'vac.newConversation' },
      { type: 'command', id: 'vac.refreshDashboard' },
      { type: 'openSession', agentName: 'Claude Code', sessionId: 'sess-42' },
    ]);
  });

  it('whitelists exactly the four quick-action commands in html and script', () => {
    const h = boot();
    expect(DASHBOARD_COMMANDS).toHaveLength(4);
    for (const id of DASHBOARD_COMMANDS) {
      expect(h.html).toContain("'" + id + "'");
    }
  });
});
