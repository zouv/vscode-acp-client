import { describe, expect, it, vi } from 'vitest';
import { tabsClient } from './tabs';

interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  title: string;
  tabIndex: number;
  type: string;
  parentNode: FakeElement | null;
  children: FakeElement[];
  attrs: Record<string, string>;
  listeners: Record<string, Array<(event: any) => void>>;
  readonly firstChild: FakeElement | null;
  appendChild(child: FakeElement): FakeElement;
  removeChild(child: FakeElement): FakeElement;
  setAttribute(name: string, value: unknown): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: (event: any) => void): void;
  fire(type: string, event: any): void;
  contains(node: FakeElement | null): boolean;
  querySelectorAll(selector: string): FakeElement[];
  focus(): void;
}

function element(tagName = 'div'): FakeElement {
  const node: FakeElement = {
    tagName,
    className: '',
    textContent: '',
    hidden: false,
    disabled: false,
    title: '',
    tabIndex: 0,
    type: '',
    parentNode: null,
    children: [] as FakeElement[],
    attrs: {} as Record<string, string>,
    listeners: {} as Record<string, Array<(event: any) => void>>,
    get firstChild() { return this.children.length > 0 ? this.children[0] : null; },
    appendChild(child: FakeElement) {
      child.parentNode = node;
      (node as any).children.push(child);
      return child;
    },
    removeChild(child: FakeElement) {
      const children: FakeElement[] = (node as any).children;
      const index = children.indexOf(child);
      if (index >= 0) { children.splice(index, 1); }
      child.parentNode = null;
      return child;
    },
    setAttribute(name: string, value: unknown) { (node as any).attrs[name] = String(value); },
    getAttribute(name: string) { return (node as any).attrs[name] ?? null; },
    addEventListener(type: string, listener: (event: any) => void) {
      const list = (node as any).listeners[type] || ((node as any).listeners[type] = []);
      list.push(listener);
    },
    fire(type: string, event: any) {
      for (const listener of ((node as any).listeners[type] || [])) { listener(event); }
    },
    contains(candidate: FakeElement | null): boolean {
      if (!candidate) { return false; }
      if (candidate === node) { return true; }
      return ((node as any).children as FakeElement[]).some(child => child.contains(candidate));
    },
    querySelectorAll(selector: string) {
      if (selector === '.tab.active') {
        return ((node as any).children as FakeElement[])
          .filter(child => (' ' + child.className + ' ').indexOf(' active ') >= 0);
      }
      return [];
    },
    focus: vi.fn(),
  };
  return node;
}

function session(sessionId: string, extra: Record<string, unknown> = {}) {
  return { sessionId, agentName: 'Claude Code', agentKind: 'claude', title: sessionId, cwd: 'C:/work', ...extra };
}

function createClient() {
  const elements: Record<string, FakeElement> = {};
  for (const id of ['tabs', 'tabStrip', 'agentBar', 'agentSelect', 'agentMenu', 'cwdBtn', 'newTab']) {
    elements[id] = element();
  }
  const document = {
    body: element('body'),
    activeElement: undefined as FakeElement | undefined,
    createElement: (tag: string) => element(tag),
    getElementById: (id: string) => elements[id] ?? null,
    addEventListener: vi.fn(),
  };
  const window: any = {
    setTimeout: (callback: (...args: any[]) => void, ms?: number) => setTimeout(callback, ms),
    clearTimeout: (handle: any) => clearTimeout(handle),
    addEventListener: vi.fn(),
  };
  const bridge = { post: vi.fn() };
  const composer = { focusInput: vi.fn() };
  const NS: any = {
    bridge,
    composer,
    popover: { confirm: vi.fn(() => false) },
    dom: {
      qs: (id: string) => elements[id] ?? null,
      el: (tag: string, className?: string, text?: string) => {
        const node = element(tag);
        if (className) { node.className = className; }
        if (text !== undefined) { node.textContent = text; }
        return node;
      },
      clear: (node: FakeElement) => { while (node.firstChild) { node.removeChild(node.firstChild); } },
    },
  };
  window.__vac = NS;
  new Function('window', 'document', tabsClient)(window, document);
  const tabs = NS.tabs;
  const draft = {
    focus: vi.fn((draftId: string) => tabs.setDraftFocus({ draftId, cwd: null })),
    start: vi.fn(),
    drop: vi.fn(),
  };
  NS.draft = draft;
  tabs.init();
  return { tabs, NS, elements, document, bridge, draft, composer };
}

function tabNode(elements: Record<string, FakeElement>, attribute: string, id: string) {
  return elements.tabs.children.find(child => child.getAttribute(attribute) === id);
}

function restore(sessionId: string) {
  return { sessionId, agentName: 'Claude Code', title: sessionId, cwd: 'C:/work' };
}

describe('chat tabs: activateRelative', () => {
  it('moves through live sessions in tabModels order and wraps both ways', () => {
    const { tabs, bridge } = createClient();
    const a = session('a');
    const b = session('b');
    const c = session('c');
    tabs.setSessions([a, b, c]);
    tabs.setFocus(a);

    expect(tabs.activateRelative(1)).toBe(true);
    expect(tabs.activateRelative(1)).toBe(true);
    expect(tabs.activateRelative(1)).toBe(true);
    expect(bridge.post.mock.calls.map(call => call[0])).toEqual([
      { type: 'focusSession', sessionId: 'b' },
      { type: 'focusSession', sessionId: 'c' },
      { type: 'focusSession', sessionId: 'a' },
    ]);
  });

  it('wraps backwards from the first model to the last', () => {
    const { tabs, bridge } = createClient();
    const a = session('a');
    const b = session('b');
    tabs.setSessions([a, b]);
    tabs.setFocus(a);

    expect(tabs.activateRelative(-1)).toBe(true);
    expect(bridge.post).toHaveBeenCalledWith({ type: 'focusSession', sessionId: 'b' });
  });

  it('covers drafts and keeps input focus untouched', () => {
    const { tabs, bridge, draft, composer, document } = createClient();
    const a = session('a');
    tabs.setSessions([a]);
    tabs.setDrafts([{ draftId: 'd1', cwd: null }], null);
    tabs.setFocus(a);
    const active = element();
    (document as any).activeElement = active;

    expect(tabs.activateRelative(1)).toBe(true);
    expect(draft.focus).toHaveBeenCalledWith('d1');
    expect(composer.focusInput).not.toHaveBeenCalled();
    expect(active.focus).not.toHaveBeenCalled();

    tabs.setDraftFocus({ draftId: 'd1', cwd: null });
    bridge.post.mockClear();
    expect(tabs.activateRelative(-1)).toBe(true);
    expect(bridge.post).toHaveBeenCalledWith({ type: 'focusSession', sessionId: 'a' });
  });

  it('uses sideFocus for Side tabs', () => {
    const { tabs, bridge } = createClient();
    const first = session('side-1', { sideChat: { parentSessionId: 'main', forkedAt: 1 } });
    const second = session('side-2', { sideChat: { parentSessionId: 'main', forkedAt: 1 } });
    tabs.setSessions([first, second]);
    tabs.setFocus(first);

    expect(tabs.activateRelative(1)).toBe(true);
    expect(bridge.post).toHaveBeenCalledWith({ type: 'sideFocus', sessionId: 'side-2' });
  });

  it('requests a lazy restore once and blocks shortcut navigation while it is pending', () => {
    const { tabs, bridge } = createClient();
    const a = session('a');
    tabs.setSessions([a]);
    tabs.setRestoring([restore('r1')]);
    tabs.setFocus(a);

    expect(tabs.activateRelative(1)).toBe(true);
    expect(tabs.activateRelative(1)).toBe(false);
    expect(tabs.activateRelative(-1)).toBe(false);

    const opens = bridge.post.mock.calls.filter(call => call[0].type === 'openHistorySession');
    expect(opens).toEqual([[
      { type: 'openHistorySession', agentName: 'Claude Code', sessionId: 'r1', cwd: 'C:/work', title: 'r1', keepOthers: true, trackRestore: true },
    ]]);
    expect(bridge.post.mock.calls.filter(call => call[0].type === 'focusSession')).toHaveLength(0);
  });

  it('never steps past a pending restore to request another one', () => {
    const { tabs, bridge } = createClient();
    const a = session('a');
    tabs.setSessions([a]);
    tabs.setRestoring([restore('r1'), restore('r2')]);
    tabs.setFocus(a);

    expect(tabs.activateRelative(1)).toBe(true);
    expect(tabs.activateRelative(1)).toBe(false);
    expect(tabs.activateRelative(1)).toBe(false);

    const opens = bridge.post.mock.calls.filter(call => call[0].type === 'openHistorySession');
    expect(opens.map(call => call[0].sessionId)).toEqual(['r1']);
  });

  it('keeps direct tab clicks working while a shortcut restore is pending', () => {
    const { tabs, elements, bridge } = createClient();
    tabs.setSessions([session('a'), session('b')]);
    tabs.setRestoring([restore('r1')]);
    tabs.setFocus(session('b'));
    expect(tabs.activateRelative(1)).toBe(true);

    const liveTab = elements.tabs.children.find(child => child.getAttribute('data-session-id') === 'a');
    expect(liveTab).toBeTruthy();
    liveTab!.fire('click', {});

    expect(bridge.post).toHaveBeenCalledWith({ type: 'focusSession', sessionId: 'a' });
    expect(tabs.activateRelative(1)).toBe(false);
  });

  it('does not ask for completion tracking on a directly clicked restore tab', () => {
    const { tabs, elements, bridge } = createClient();
    tabs.setSessions([session('a')]);
    tabs.setRestoring([restore('r1')]);
    tabs.setFocus(session('a'));

    const restoreTab = tabNode(elements, 'data-restore-id', 'r1');
    expect(restoreTab).toBeTruthy();
    restoreTab!.fire('click', {});

    const open = bridge.post.mock.calls
      .map(call => call[0])
      .find(message => message.type === 'openHistorySession');
    expect(open).toBeTruthy();
    expect('trackRestore' in open).toBe(false);
  });

  it('unlocks immediately on a failed restoreFinished instead of waiting for the timeout', () => {
    vi.useFakeTimers();
    try {
      const { tabs, bridge } = createClient();
      tabs.setSessions([session('a')]);
      tabs.setRestoring([restore('r1')]);
      tabs.setFocus(session('a'));

      expect(tabs.activateRelative(1)).toBe(true);
      expect(tabs.activateRelative(1)).toBe(false);
      expect(tabs.finishRestore('r1', false)).toBe(false);
      expect(tabs.activateRelative(1)).toBe(true);

      const opens = bridge.post.mock.calls.filter(call => call[0].type === 'openHistorySession');
      expect(opens.map(call => call[0].sessionId)).toEqual(['r1', 'r1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a restoreFinished without ok=false as completion', () => {
    vi.useFakeTimers();
    try {
      const { tabs } = createClient();
      tabs.setSessions([session('a')]);
      tabs.setRestoring([restore('r1')]);
      tabs.setFocus(session('a'));
      expect(tabs.activateRelative(1)).toBe(true);

      expect(tabs.finishRestore('r1', undefined)).toBe(true);
      expect(tabs.activateRelative(1)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays single-flight past the old 15s window and unlocks only on the failure receipt', () => {
    vi.useFakeTimers();
    try {
      const { tabs, bridge } = createClient();
      const a = session('a');
      tabs.setSessions([a]);
      tabs.setRestoring([restore('r1'), restore('r2')]);
      tabs.setFocus(a);

      expect(tabs.activateRelative(1)).toBe(true);
      vi.advanceTimersByTime(60000);
      expect(tabs.activateRelative(1)).toBe(false);

      const opens = bridge.post.mock.calls.filter(call => call[0].type === 'openHistorySession');
      expect(opens.map(call => call[0].sessionId)).toEqual(['r1']);

      expect(tabs.finishRestore('r1', false)).toBe(false);
      expect(tabs.activateRelative(1)).toBe(true);
      expect(bridge.post.mock.calls
        .filter(call => call[0].type === 'openHistorySession')
        .map(call => call[0].sessionId)).toEqual(['r1', 'r1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not release the pending guard merely because the session is registered live', () => {
    const { tabs, bridge } = createClient();
    const a = session('a');
    tabs.setSessions([a]);
    tabs.setRestoring([restore('r1')]);
    tabs.setFocus(a);
    expect(tabs.activateRelative(1)).toBe(true);

    // sessionsChanged 可能先于真正的 focus/load 完成 —— 不能在这里解单飞。
    tabs.setSessions([a, session('r1')]);
    expect(tabs.activateRelative(1)).toBe(false);

    // 真正的 focus 到了才解锁。
    tabs.setFocus(session('r1'));
    expect(tabs.activateRelative(1)).toBe(true);

    const opens = bridge.post.mock.calls.filter(call => call[0].type === 'openHistorySession');
    expect(opens).toHaveLength(1);
    expect(bridge.post).toHaveBeenCalledWith({ type: 'focusSession', sessionId: 'a' });
  });

  it('ignores directions other than -1 and +1', () => {
    const { tabs, bridge } = createClient();
    tabs.setSessions([session('a'), session('b')]);
    tabs.setFocus(session('a'));

    expect(tabs.activateRelative(0)).toBe(false);
    expect(tabs.activateRelative(2)).toBe(false);
    expect(bridge.post).not.toHaveBeenCalled();
  });
});

describe('chat tabs: shortcut focus preservation', () => {
  it('returns focus to the new active tab when the shortcut started in the tab strip', () => {
    const { tabs, elements, document } = createClient();
    tabs.setSessions([session('a'), session('b')]);
    tabs.setFocus(session('a'));
    document.activeElement = tabNode(elements, 'data-session-id', 'a');

    expect(tabs.activateRelative(1)).toBe(true);

    const active = tabNode(elements, 'data-session-id', 'b');
    expect(active).toBeTruthy();
    expect(active!.className).toContain('active');
    expect(active!.focus).toHaveBeenCalledTimes(1);
  });

  it('keeps tab focus when the host echoes the same focus after a local switch', () => {
    const { tabs, elements, document } = createClient();
    tabs.setSessions([session('a'), session('b')]);
    tabs.setFocus(session('a'));
    document.activeElement = tabNode(elements, 'data-session-id', 'a');

    expect(tabs.activateRelative(1)).toBe(true);
    const localActive = tabNode(elements, 'data-session-id', 'b');
    expect(localActive!.focus).toHaveBeenCalledTimes(1);
    // 浏览器把焦点真正落到新 tab 上；随后宿主对同一会话的 focus 回包再次重绘。
    document.activeElement = localActive;

    tabs.setFocus(session('b'));

    const echoed = tabNode(elements, 'data-session-id', 'b');
    expect(echoed!.className).toContain('active');
    expect(echoed!.focus).toHaveBeenCalledTimes(1);
  });

  it('keeps tab focus across a setSessions re-render', () => {
    const { tabs, elements, document } = createClient();
    tabs.setSessions([session('a'), session('b')]);
    tabs.setFocus(session('a'));
    document.activeElement = tabNode(elements, 'data-session-id', 'a');

    tabs.setSessions([session('a'), session('b')]);

    const active = tabNode(elements, 'data-session-id', 'a');
    expect(active!.className).toContain('active');
    expect(active!.focus).toHaveBeenCalledTimes(1);
  });

  it('does not steal focus from an input field', () => {
    const { tabs, elements, document, composer } = createClient();
    tabs.setSessions([session('a'), session('b')]);
    tabs.setFocus(session('a'));
    const input = element('textarea');
    document.activeElement = input;

    expect(tabs.activateRelative(1)).toBe(true);

    const active = tabNode(elements, 'data-session-id', 'b');
    expect(active!.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(composer.focusInput).not.toHaveBeenCalled();
  });

  it('preserves tab-strip focus across a draft switch', () => {
    const { tabs, elements, document, composer } = createClient();
    tabs.setSessions([session('a')]);
    tabs.setDrafts([{ draftId: 'd1', cwd: null }], null);
    tabs.setFocus(session('a'));
    document.activeElement = tabNode(elements, 'data-session-id', 'a');

    expect(tabs.activateRelative(1)).toBe(true);

    const active = tabNode(elements, 'data-draft-id', 'd1');
    expect(active).toBeTruthy();
    expect(active!.className).toContain('active');
    expect(active!.focus).toHaveBeenCalledTimes(1);
    expect(composer.focusInput).not.toHaveBeenCalled();
  });

  it('preserves tab-strip focus across a Side switch', () => {
    const { tabs, elements, document } = createClient();
    const first = session('side-1', { sideChat: { parentSessionId: 'main', forkedAt: 1 } });
    const second = session('side-2', { sideChat: { parentSessionId: 'main', forkedAt: 1 } });
    tabs.setSessions([first, second]);
    tabs.setFocus(first);
    document.activeElement = tabNode(elements, 'data-session-id', 'side-1');

    expect(tabs.activateRelative(1)).toBe(true);

    const active = tabNode(elements, 'data-session-id', 'side-2');
    expect(active!.className).toContain('active');
    expect(active!.focus).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the restored tab when the restore completes', () => {
    const { tabs, elements, document } = createClient();
    tabs.setSessions([session('a')]);
    tabs.setRestoring([restore('r1')]);
    tabs.setFocus(session('a'));
    document.activeElement = tabNode(elements, 'data-session-id', 'a');

    expect(tabs.activateRelative(1)).toBe(true);
    // 注册 live 早于结果：既不能解除单飞，也不能丢掉"还焦点"意图。
    tabs.setSessions([session('a'), session('r1')]);
    expect(tabs.activateRelative(1)).toBe(false);
    expect(tabs.finishRestore('r1', true)).toBe(true);
    // 重建 tab 条后焦点会掉到 body：这时才应该把焦点还给新的活动 tab。
    document.activeElement = document.body;
    tabs.setFocus(session('r1'));

    const active = tabNode(elements, 'data-session-id', 'r1');
    expect(active!.className).toContain('active');
    expect(active!.focus).toHaveBeenCalledTimes(1);
  });

  it('does not steal focus if the user moved into the input while a restore was loading', () => {
    const { tabs, elements, document } = createClient();
    tabs.setSessions([session('a')]);
    tabs.setRestoring([restore('r1')]);
    tabs.setFocus(session('a'));
    document.activeElement = tabNode(elements, 'data-session-id', 'a');

    expect(tabs.activateRelative(1)).toBe(true);
    tabs.setSessions([session('a'), session('r1')]);
    const input = element('textarea');
    document.activeElement = input;
    tabs.setFocus(session('r1'));

    const active = tabNode(elements, 'data-session-id', 'r1');
    expect(active!.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it('does not restore focus after a failed restoreFinished', () => {
    const { tabs, elements, document } = createClient();
    tabs.setSessions([session('a')]);
    tabs.setRestoring([restore('r1')]);
    tabs.setFocus(session('a'));
    document.activeElement = tabNode(elements, 'data-session-id', 'a');

    expect(tabs.activateRelative(1)).toBe(true);
    expect(tabs.finishRestore('r1', false)).toBe(false);
    tabs.setSessions([session('a'), session('r1')]);
    document.activeElement = document.body;
    tabs.setFocus(session('r1'));

    const active = tabNode(elements, 'data-session-id', 'r1');
    expect(active!.focus).not.toHaveBeenCalled();
  });

  it('keeps the focus intent across a slow restore past the old five-second window', () => {
    vi.useFakeTimers();
    try {
      const { tabs, elements, document } = createClient();
      tabs.setSessions([session('a')]);
      tabs.setRestoring([restore('r1')]);
      tabs.setFocus(session('a'));
      document.activeElement = tabNode(elements, 'data-session-id', 'a');

      expect(tabs.activateRelative(1)).toBe(true);
      vi.advanceTimersByTime(60000);
      // 慢恢复仍在途：单飞不解除、焦点意图也不应被提前丢掉。
      expect(tabs.activateRelative(1)).toBe(false);

      expect(tabs.finishRestore('r1', true)).toBe(true);
      tabs.setSessions([session('a'), session('r1')]);
      document.activeElement = document.body;
      tabs.setFocus(session('r1'));

      const active = tabNode(elements, 'data-session-id', 'r1');
      expect(active!.focus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only starts the five-second cleanup when success waits for focus', () => {
    vi.useFakeTimers();
    try {
      const { tabs, elements, document } = createClient();
      tabs.setSessions([session('a')]);
      tabs.setRestoring([restore('r1')]);
      tabs.setFocus(session('a'));
      document.activeElement = tabNode(elements, 'data-session-id', 'a');

      expect(tabs.activateRelative(1)).toBe(true);
      expect(tabs.finishRestore('r1', true)).toBe(true);
      vi.advanceTimersByTime(5000);
      tabs.setSessions([session('a'), session('r1')]);
      document.activeElement = document.body;
      tabs.setFocus(session('r1'));

      const active = tabNode(elements, 'data-session-id', 'r1');
      expect(active!.focus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('chat tabs: restore tab keyboard lookup', () => {  it('modelIndexOf recognizes data-restore-id so arrow keys work from a lazy tab', () => {
    const { tabs, elements, bridge } = createClient();
    tabs.setSessions([session('a'), session('b')]);
    tabs.setRestoring([restore('r1')]);
    tabs.setFocus(session('a'));

    const restoreTab = elements.tabs.children.find(child => child.getAttribute('data-restore-id') === 'r1');
    expect(restoreTab).toBeTruthy();
    const event = {
      key: 'ArrowLeft',
      target: restoreTab,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    elements.tabs.fire('keydown', event);

    expect(event.defaultPrevented).toBe(true);
    expect(bridge.post).toHaveBeenCalledWith({ type: 'focusSession', sessionId: 'b' });
  });

  it('leaves modifier+arrow to document shortcuts instead of consuming it', () => {
    const { tabs, elements, bridge } = createClient();
    tabs.setSessions([session('a'), session('b')]);
    tabs.setFocus(session('a'));

    const liveTab = elements.tabs.children.find(child => child.getAttribute('data-session-id') === 'a');
    expect(liveTab).toBeTruthy();
    const event = {
      key: 'ArrowRight',
      altKey: true,
      target: liveTab,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    elements.tabs.fire('keydown', event);

    expect(event.defaultPrevented).toBe(false);
    expect(bridge.post).not.toHaveBeenCalled();
  });
});

describe('chat tabs: closeActive (Alt+W)', () => {
  it('closes the focused live session through the shared closeModel path', () => {
    const { tabs, bridge } = createClient();
    tabs.setSessions([session('a'), session('b')]);
    tabs.setFocus(session('a'));

    expect(tabs.closeActive()).toBe(true);
    expect(bridge.post).toHaveBeenCalledWith({ type: 'closeSession', sessionId: 'a' });
  });

  it('uses sideClose for a focused Side tab', () => {
    const { tabs, bridge } = createClient();
    const side = session('side-1', { sideChat: { parentSessionId: 'main', forkedAt: 1 } });
    tabs.setSessions([side]);
    tabs.setFocus(side);

    expect(tabs.closeActive()).toBe(true);
    expect(bridge.post).toHaveBeenCalledWith({ type: 'sideClose', sessionId: 'side-1' });
  });

  it('discards a focused draft instead of posting a session close', () => {
    const { tabs, bridge, draft } = createClient();
    tabs.setSessions([]);
    tabs.setDrafts([{ draftId: 'd1', cwd: null }], 'd1');

    expect(tabs.closeActive()).toBe(true);
    expect(draft.drop).toHaveBeenCalledWith('d1');
    expect(bridge.post).not.toHaveBeenCalled();
  });

  it('forgets a lazy-restore tab instead of trying to close it', () => {
    const { tabs, bridge, elements } = createClient();
    tabs.setSessions([]);
    tabs.setRestoring([restore('r1')]);

    tabs.closeTabNode(tabNode(elements, 'data-restore-id', 'r1'), {});
    expect(bridge.post).toHaveBeenCalledWith({ type: 'forgetRestorable', sessionId: 'r1' });
  });

  it('asks before closing a running session and only posts after confirmation', () => {
    const { tabs, bridge, NS } = createClient();
    tabs.setSessions([session('a', { running: true })]);
    tabs.setFocus(session('a'));
    NS.popover.confirm.mockReturnValue(true);

    expect(tabs.closeActive()).toBe(true);
    expect(NS.popover.confirm).toHaveBeenCalledTimes(1);
    expect(bridge.post).not.toHaveBeenCalledWith({ type: 'closeSession', sessionId: 'a' });
  });

  it('is a no-op when nothing is focused', () => {
    const { tabs, bridge } = createClient();
    tabs.setSessions([]);
    expect(tabs.closeActive()).toBe(false);
    expect(bridge.post).not.toHaveBeenCalled();
  });
});

describe('chat tabs: vertical wheel scrolls the strip horizontally', () => {
  function wheel(overrides: Record<string, unknown> = {}) {
    return {
      deltaX: 0, deltaY: 0, deltaMode: 0,
      ctrlKey: false, metaKey: false, shiftKey: false,
      preventDefault: vi.fn(),
      ...overrides,
    };
  }

  function overflowingStrip() {
    const client = createClient();
    const scroller = client.elements.tabs as any;
    scroller.scrollWidth = 400;
    scroller.clientWidth = 100;
    scroller.scrollLeft = 0;
    return { ...client, scroller };
  }

  it('converts a vertical wheel into scrollLeft when the tabs overflow', () => {
    const { elements, scroller } = overflowingStrip();
    const event = wheel({ deltaY: 50 });

    elements.tabStrip.fire('wheel', event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(scroller.scrollLeft).toBe(50);
  });

  it('leaves native horizontal trackpad gestures alone', () => {
    const { elements, scroller } = overflowingStrip();
    const event = wheel({ deltaX: 30 });

    elements.tabStrip.fire('wheel', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(scroller.scrollLeft).toBe(0);
  });

  it('does not preventDefault when there is nothing to scroll', () => {
    const { elements, scroller } = overflowingStrip();
    scroller.scrollWidth = 100;

    const event = wheel({ deltaY: 50 });
    elements.tabStrip.fire('wheel', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(scroller.scrollLeft).toBe(0);
  });

  it('stops at the edges without consuming the wheel', () => {
    const { elements, scroller } = overflowingStrip();
    scroller.scrollLeft = 300; // max = 400 - 100

    const event = wheel({ deltaY: 50 });
    elements.tabStrip.fire('wheel', event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(scroller.scrollLeft).toBe(300);
  });

  it('respects deltaMode line and page units', () => {
    const line = overflowingStrip();
    line.elements.tabStrip.fire('wheel', wheel({ deltaY: 2, deltaMode: 1 }));
    expect(line.scroller.scrollLeft).toBe(32);

    const page = overflowingStrip();
    page.elements.tabStrip.fire('wheel', wheel({ deltaY: 1, deltaMode: 2 }));
    expect(page.scroller.scrollLeft).toBe(100);
  });

  it('keeps Shift/Ctrl/Meta combinations native', () => {
    const { elements, scroller } = overflowingStrip();
    for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey']) {
      const event = wheel({ deltaY: 50, [modifier]: true });
      elements.tabStrip.fire('wheel', event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(scroller.scrollLeft).toBe(0);
  });
});
