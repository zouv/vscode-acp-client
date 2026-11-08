import { shortcutsClient } from './shortcuts';
import { describe, expect, it } from 'vitest';

function createClient() {
  const listeners: Record<string, (event: any) => void> = {};
  const elements: Record<string, { hidden: boolean }> = {};
  const calls: string[] = [];
  const document = {
    addEventListener: (type: string, listener: (event: any) => void) => { listeners[type] = listener; },
    getElementById: (id: string) => elements[id] ?? null,
    querySelector: () => null,
  };
  const window = { __vac: {
    scroll: { jumpToTop: () => calls.push('top'), jumpToLatest: () => calls.push('bottom') },
    tabs: {
      activateRelative: (n: number) => calls.push(String(n)),
      closeActive: () => calls.push('close'),
    },
    composer: { isComposable: () => true, focusInput: () => calls.push('input') },
    bridge: { post: (message: any) => calls.push('restore:' + message.type) },
  } };
  new Function('window', 'document', shortcutsClient)(window, document);
  const shortcuts = (window.__vac as any).shortcuts;
  shortcuts.init();
  function key(code: string, overrides: Record<string, unknown> = {}) {
    const event: Record<string, any> = {
      code, altKey: true, target: null, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
      ...overrides,
    };
    listeners.keydown(event);
    return event;
  }
  return { calls, key, shortcuts, elements, window };
}

describe('chat shortcuts', () => {
  it('dispatches defaults and stops their propagation', () => {
    const { calls, key } = createClient();
    for (const code of ['KeyA', 'KeyE', 'KeyI', 'KeyP', 'KeyN', 'KeyW', 'KeyT']) {
      expect(key(code)).toMatchObject({ defaultPrevented: true, stopped: true });
    }
    expect(calls).toEqual(['top', 'bottom', 'input', '-1', '1', 'close', 'restore:restoreLastClosed']);
    expect(key('KeyZ').defaultPrevented).toBe(false);
  });

  it('matches custom key combinations and disables individual actions', () => {
    const { calls, key, shortcuts } = createClient();
    shortcuts.applyPrefs({ shortcuts: { scrollTop: 'Ctrl+Shift+KeyQ', scrollBottom: null } });
    expect(key('KeyA').defaultPrevented).toBe(false);
    expect(key('KeyE').defaultPrevented).toBe(false);
    expect(key('KeyQ', { ctrlKey: true, shiftKey: true, altKey: false }).stopped).toBe(true);
    expect(calls).toEqual(['top']);
  });

  it('never captures Shift-only combinations that would swallow capital text', () => {
    const { calls, key, shortcuts } = createClient();
    shortcuts.applyPrefs({ shortcuts: { scrollTop: 'Shift+KeyA' } });
    expect(shortcuts.fromEvent({ code: 'KeyA', shiftKey: true })).toBeNull();
    const event = key('KeyA', { altKey: false, shiftKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(event.stopped).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('lets macOS dead keys pass through instead of consuming them', () => {
    const { calls, key, shortcuts } = createClient();
    expect(shortcuts.fromEvent({ code: 'KeyE', altKey: true, key: 'Dead' })).toBeNull();
    const event = key('KeyE', { key: 'Dead' });
    expect(event.defaultPrevented).toBe(false);
    expect(event.stopped).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('does not swallow Option-typed characters that differ from the physical letter', () => {
    const { calls, key, shortcuts } = createClient();
    // macOS：Option+A 输入 å、Option+E 输入死键重音，不能当成 Alt+KeyA / Alt+KeyE。
    expect(shortcuts.fromEvent({ code: 'KeyA', altKey: true, key: 'å' })).toBeNull();
    const typed = key('KeyA', { key: 'å' });
    expect(typed.defaultPrevented).toBe(false);
    expect(typed.stopped).toBeUndefined();
    // 非字母 code（方向键）不受"键入字符"判据影响。
    shortcuts.applyPrefs({ shortcuts: { scrollTop: 'Alt+ArrowUp' } });
    expect(key('ArrowUp', { key: 'ArrowUp' }).defaultPrevented).toBe(true);
    expect(calls).toEqual(['top']);
  });

  it('stops repeated keydowns from bubbling without repeating the action', () => {
    const { calls, key } = createClient();
    const repeat = key('KeyA', { repeat: true });
    expect(repeat).toMatchObject({ defaultPrevented: true, stopped: true });
    expect(calls).toEqual([]);
    expect(key('KeyA').stopped).toBe(true);
    expect(calls).toEqual(['top']);
  });

  it('does not override composition, AltGr, extra modifiers or consumed events', () => {
    const { calls, key } = createClient();
    for (const extra of [
      { isComposing: true }, { keyCode: 229 },
      { getModifierState: () => true }, { ctrlKey: true }, { defaultPrevented: true },
    ]) { key('KeyA', extra); }
    expect(calls).toEqual([]);
  });

  it('does not steal keys from active overlays or outside input controls', () => {
    const { calls, key, elements } = createClient();
    elements.history = { hidden: false };
    expect(key('KeyA').defaultPrevented).toBe(false);
    elements.history.hidden = true;
    const target = { closest: (selector: string) => selector.startsWith('input') ? {} : null };
    expect(key('KeyA', { target }).defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
  });
});
