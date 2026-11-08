import { describe, expect, it, vi } from 'vitest';
import { scrollClient } from './scroll';

interface ScrollHarness {
  scroll: any;
  NS: any;
  tail: any;
  container: any;
  jumpBtn: any;
  flush(): void;
  clickJump(): void;
  triggerResize(): void;
}

function createClient(ui: Record<string, unknown> = {}): ScrollHarness {
  const frames: Array<() => void> = [];
  const containerListeners: Record<string, (event: any) => void> = {};
  const jumpListeners: Record<string, (event: any) => void> = {};
  const body = {
    className: 'surface-view',
    attrs: {} as Record<string, string>,
    style: {
      getPropertyValue: () => '',
      setProperty: () => undefined,
    },
    setAttribute(this: any, name: string, value: unknown) { this.attrs[name] = String(value); },
    getAttribute(this: any, name: string) { return this.attrs[name] ?? null; },
  };
  const container = {
    scrollTop: 0,
    scrollHeight: 3000,
    clientHeight: 500,
    offsetWidth: 500,
    offsetHeight: 500,
    lastElementChild: null as any,
    addEventListener(type: string, listener: (event: any) => void) {
      containerListeners[type] = listener;
    },
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 500, bottom: 500 }),
  };
  const jumpBtn = {
    hidden: true,
    addEventListener(type: string, listener: (event: any) => void) {
      jumpListeners[type] = listener;
    },
  };
  const document = {
    body,
    addEventListener: vi.fn(),
    elementsFromPoint: () => [],
  };
  const resizeObservers: Array<{ callback: (entries: unknown[]) => void }> = [];
  class FakeResizeObserver {
    callback: (entries: unknown[]) => void;
    constructor(callback: (entries: unknown[]) => void) { this.callback = callback; resizeObservers.push(this); }
    observe(_target?: unknown) { /* no layout in the harness */ }
    unobserve(_target?: unknown) { /* no layout in the harness */ }
    disconnect() { /* no layout in the harness */ }
  }
  const window: any = {
    ResizeObserver: FakeResizeObserver,
    getComputedStyle: () => ({
      paddingBottom: '0px',
      overflowX: 'visible',
      overflowY: 'visible',
    }),
    addEventListener: vi.fn(),
    setTimeout: (callback: (...args: any[]) => void, ms?: number) => setTimeout(callback, ms),
    clearTimeout: (handle: any) => clearTimeout(handle),
  };
  const tail = {
    resumeFromJump: vi.fn(),
    cancelFromScroll: vi.fn(),
    cancelFromRestore: vi.fn(),
  };
  const NS: any = {
    dom: {
      qs: () => null,
      schedule: (fn: () => void) => { frames.push(fn); },
    },
    tail,
    boot: {
      recallUi: () => ui,
      persistUi: vi.fn(),
    },
  };
  window.__vac = NS;
  new Function('window', 'document', scrollClient)(window, document);
  NS.scroll.init(container, jumpBtn);
  return {
    scroll: NS.scroll,
    NS,
    tail,
    container,
    jumpBtn,
    flush() {
      for (const frame of frames.splice(0)) { frame(); }
    },
    clickJump() { jumpListeners.click({}); },
    triggerResize() {
      for (const observer of resizeObservers) { observer.callback([{ target: {} }]); }
    },
  };
}

describe('chat scroll: jumpToLatest', () => {
  it('keeps the existing Jump-button behaviour (bottom + resume current Tail)', () => {
    const { clickJump, container, jumpBtn, tail, scroll } = createClient();
    container.scrollTop = 1200;

    clickJump();

    expect(container.scrollTop).toBe(3000);
    expect(jumpBtn.hidden).toBe(true);
    expect(tail.resumeFromJump).toHaveBeenCalledTimes(1);
    expect(scroll.isPinned()).toBe(true);
  });

  it('is exported for the shortcut path with the same semantics', () => {
    const { scroll, container, jumpBtn, tail } = createClient();
    container.scrollTop = 700;

    scroll.jumpToLatest();

    expect(container.scrollTop).toBe(3000);
    expect(jumpBtn.hidden).toBe(true);
    expect(tail.resumeFromJump).toHaveBeenCalledTimes(1);
    expect(scroll.isPinned()).toBe(true);
  });
});

describe('chat scroll: jumpToTop', () => {
  it('cancels this session Tail, lands at the top and shows Jump', () => {
    const { scroll, container, jumpBtn, tail } = createClient();
    scroll.setTail(true, false);
    container.scrollTop = 2500;

    scroll.jumpToTop();

    expect(container.scrollTop).toBe(0);
    expect(scroll.isTail()).toBe(false);
    expect(tail.cancelFromScroll).toHaveBeenCalledTimes(1);
    expect(scroll.isPinned()).toBe(false);
    expect(jumpBtn.hidden).toBe(false);
  });

  it('defuses a queued follow-to-bottom frame so it cannot steal the viewport', () => {
    const { scroll, container, flush } = createClient();
    scroll.setTail(true, false);
    container.scrollTop = 2200;
    scroll.follow();
    expect(container.scrollTop).toBe(2200);

    scroll.jumpToTop();
    flush();

    expect(container.scrollTop).toBe(0);
    expect(scroll.isPinned()).toBe(false);
  });

  it('clears a pending restore anchor so reassert cannot pull the viewport back', () => {
    const { scroll, container } = createClient({
      scroll: { s1: { top: 800, pinned: false } },
    });
    scroll.restore('s1');
    expect(container.scrollTop).toBe(800);
    expect(scroll.isPinned()).toBe(false);

    scroll.jumpToTop();
    scroll.reassert();

    expect(container.scrollTop).toBe(0);
    expect(scroll.isPinned()).toBe(false);
  });

  it('still hides Jump when the transcript does not overflow', () => {
    const { scroll, container, jumpBtn } = createClient();
    container.scrollHeight = 400;
    container.clientHeight = 500;

    scroll.jumpToTop();

    expect(container.scrollTop).toBe(0);
    expect(scroll.isPinned()).toBe(true);
    expect(jumpBtn.hidden).toBe(true);
  });
});


describe('chat scroll: Tail re-pins on asynchronous growth', () => {
  // [CUSTOM- follow() only covers growth announced by a writer (append / markdown
  // patch / tool output). Growth that lands AFTER that frame — markdown slices, image
  // decode, mermaid, font swap — used to leave the viewport short of the bottom until
  // the next message triggered another follow. The record ResizeObserver is what
  // makes "Tail on" mean "always at the bottom"; these tests pin that behaviour.
  it('writes the new bottom when a record grew after the follow frame', () => {
    const { container, scroll, triggerResize } = createClient();
    scroll.setTail(true, true);
    expect(container.scrollTop).toBe(3000);

    container.scrollTop = 1500;      // the viewport is now above the bottom…
    container.scrollHeight = 4000;   // …because a record grew underneath it.
    triggerResize();

    expect(container.scrollTop).toBe(3500); // scrollHeight 4000 - clientHeight 500
  });

  it('does not move the viewport while Tail is off', () => {
    const { container, scroll, triggerResize } = createClient();
    scroll.setTail(false, false);
    container.scrollTop = 1500;
    container.scrollHeight = 4000;

    triggerResize();

    expect(container.scrollTop).toBe(1500); // a reader parked in history is never dragged back
  });

  it('is a no-op when the viewport is already at the bottom', () => {
    const { container, scroll, triggerResize } = createClient();
    scroll.setTail(true, true);
    container.scrollTop = 3500;
    container.scrollHeight = 4000;

    triggerResize();

    expect(container.scrollTop).toBe(3500);
  });
});
