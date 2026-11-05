// [CUSTOM- 设置面板快捷键控件（Shortcuts 分组 + 录制）的独立逻辑测试。
//
// 放在 vitest（*.spec.ts）而不是 chat-client.test.ts：后者正被其它模块并行修改，
// 本套件只需要 settingsPanel + dom 两个纯字符串模块，用最小桩 DOM 即可真跑逻辑。
// 与 chat-client.test.ts 同一条边界：能测 DOM 结构/回传消息/按键过滤，不能测布局与焦点外观。
import { describe, expect, it } from 'vitest';

import { domClient } from './dom';
import { settingsPanelClient } from './settingsPanel';
import { shortcutsClient } from './shortcuts';

class StubText {
  nodeType = 3;
  parentNode: StubNode | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
}

class StubNode {
  nodeType = 1;
  className = '';
  hidden = false;
  type = '';
  title = '';
  value = '';
  disabled = false;
  focused = false;
  parentNode: StubNode | null = null;
  childNodes: Array<StubNode | StubText> = [];
  attributes: Record<string, string> = {};
  private listeners: Record<string, Array<(event: any) => void>> = {};
  readonly tagName: string;

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  appendChild<T extends StubNode | StubText>(child: T): T {
    child.parentNode = this as unknown as StubNode;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: StubNode | StubText): void {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) { this.childNodes.splice(at, 1); }
    child.parentNode = null;
  }

  get firstChild(): StubNode | StubText | null { return this.childNodes[0] ?? null; }

  addEventListener(type: string, fn: (event: any) => void): void {
    (this.listeners[type] = this.listeners[type] ?? []).push(fn);
  }

  removeEventListener(type: string, fn: (event: any) => void): void {
    const list = this.listeners[type];
    if (!list) { return; }
    const at = list.indexOf(fn);
    if (at >= 0) { list.splice(at, 1); }
  }

  dispatch(type: string, event: any): void {
    for (const fn of (this.listeners[type] ?? []).slice()) { fn(event); }
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'class') { this.className = value; }
  }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }

  focus(): void { this.focused = true; }

  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      const sel = part.trim();
      if (sel.startsWith('.')) { return this.className.split(/\s+/).includes(sel.slice(1)); }
      return this.tagName === sel.toUpperCase();
    });
  }

  querySelector(selector: string): StubNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): StubNode[] {
    const out: StubNode[] = [];
    const walk = (node: StubNode): void => {
      for (const child of node.childNodes) {
        if (!(child instanceof StubNode)) { continue; }
        if (child.matches(selector)) { out.push(child); }
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  get textContent(): string {
    return this.childNodes
      .map(child => (child instanceof StubText ? child.data : child.textContent))
      .join('');
  }

  set textContent(value: string) {
    this.childNodes = [];
    if (value !== '') { this.appendChild(new StubText(value)); }
  }
}

function keyEvent(overrides: Record<string, unknown> = {}): any {
  const event: any = {
    key: '',
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    repeat: false,
    keyCode: 0,
    defaultPrevented: false,
    propagationStopped: false,
    immediateStopped: false,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() { event.propagationStopped = true; },
    stopImmediatePropagation() { event.immediateStopped = true; },
    getModifierState(_name: string) { return false; },
    ...overrides,
  };
  return event;
}

function shortcutItems(values?: Partial<Record<string, string | null>>): any[] {
  const bind = (action: string, fallback: string): string | null =>
    values && Object.prototype.hasOwnProperty.call(values, action)
      ? values[action] as string | null
      : fallback;
  return [
    { key: 'panel.shortcut.scrollTop', group: 'shortcuts', type: 'shortcut', label: 'Scroll to top', value: bind('scrollTop', 'Alt+KeyA') },
    { key: 'panel.shortcut.scrollBottom', group: 'shortcuts', type: 'shortcut', label: 'Scroll to bottom', value: bind('scrollBottom', 'Alt+KeyE') },
    { key: 'panel.shortcut.focusInput', group: 'shortcuts', type: 'shortcut', label: 'Focus the input', value: bind('focusInput', 'Alt+KeyI') },
    { key: 'panel.shortcut.previousSession', group: 'shortcuts', type: 'shortcut', label: 'Previous session', value: bind('previousSession', 'Alt+KeyP') },
    { key: 'panel.shortcut.nextSession', group: 'shortcuts', type: 'shortcut', label: 'Next session', value: bind('nextSession', 'Alt+KeyN') },
  ];
}

function makePanel(items: any[]) {
  const elements: Record<string, StubNode> = {
    settingsBtn: new StubNode('button'),
    settingsOverlay: new StubNode('div'),
    settingsNav: new StubNode('div'),
    settingsBody: new StubNode('div'),
    settingsClose: new StubNode('button'),
    settingsSubOverlay: new StubNode('div'),
    settingsSubTitle: new StubNode('span'),
    settingsSubBody: new StubNode('div'),
    settingsSubClose: new StubNode('button'),
  };
  elements.settingsOverlay.hidden = true;
  elements.settingsSubOverlay.hidden = true;

  const windowListeners: Record<string, Array<(event: any) => void>> = {};
  const win: any = {
    __vac: {},
    addEventListener(type: string, fn: (event: any) => void) {
      (windowListeners[type] = windowListeners[type] ?? []).push(fn);
    },
    removeEventListener(type: string, fn: (event: any) => void) {
      const list = windowListeners[type];
      if (!list) { return; }
      const at = list.indexOf(fn);
      if (at >= 0) { list.splice(at, 1); }
    },
  };
  const doc: any = {
    createElement: (tag: string) => new StubNode(tag),
    createTextNode: (text: string) => new StubText(text),
    getElementById: (id: string) => elements[id] ?? null,
  };

  new Function('window', 'document', domClient)(win, doc);
  // 真实装配顺序：快捷键分发器先于设置面板定义，录制复用同一个 fromEvent。
  new Function('window', 'document', shortcutsClient)(win, doc);
  new Function('window', 'document', settingsPanelClient)(win, doc);
  const NS = win.__vac;
  const posted: any[] = [];
  NS.bridge = { post: (message: any) => { posted.push(message); } };
  NS.settingsPanel.init();
  NS.settingsPanel.open();
  posted.length = 0;
  NS.settingsPanel.setItems(items);
  posted.length = 0;

  const fireWindow = (type: string, event: any): void => {
    for (const fn of (windowListeners[type] ?? []).slice()) { fn(event); }
  };

  return {
    NS,
    elements,
    posted,
    fireKey: (event: any) => fireWindow('keydown', event),
    fireWindowBlur: () => fireWindow('blur', {}),
    records: () => elements.settingsBody.querySelectorAll('.settings-shortcut-record'),
  };
}

describe('settings panel: Shortcuts group', () => {
  it('renders the group, five record controls, readable bindings and the layout note', () => {
    const panel = makePanel(shortcutItems());
    const tabs = panel.elements.settingsNav.querySelectorAll('.settings-tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['Shortcuts']);
    expect(panel.records().map(button => button.textContent))
      .toEqual(['Alt+A', 'Alt+E', 'Alt+I', 'Alt+P', 'Alt+N']);
    expect(panel.elements.settingsBody.textContent).toContain('physical key positions');
    expect(panel.elements.settingsBody.textContent)
      .toContain('Option combinations (including the Alt+E/I/N defaults)');
    expect(panel.elements.settingsBody.textContent).toContain('rebind them if needed');
  });

  it('converts canonical codes to readable labels, including arrows and digits', () => {
    const panel = makePanel(shortcutItems({
      scrollTop: 'Ctrl+Shift+ArrowUp',
      scrollBottom: 'Meta+Digit1',
      focusInput: null,
    }));
    expect(panel.records().map(button => button.textContent))
      .toEqual(['Ctrl+Shift+Up', 'Meta+1', 'Disabled', 'Alt+P', 'Alt+N']);
  });
});

describe('settings panel: shortcut recording', () => {
  it('records a valid combination and posts the canonical value', () => {
    const panel = makePanel(shortcutItems());
    const record = panel.records()[0];
    record.dispatch('click', {});
    expect(record.textContent).toBe('Press keys…');
    expect(record.className).toContain('recording');

    const event = keyEvent({ key: 'x', code: 'KeyX', altKey: true });
    panel.fireKey(event);

    expect(panel.posted).toEqual([
      { type: 'setSetting', key: 'panel.shortcut.scrollTop', value: 'Alt+KeyX' },
    ]);
    expect(record.className).not.toContain('recording');
    expect(record.textContent).toBe('Alt+A');
    expect(event.defaultPrevented).toBe(true);
    expect(event.propagationStopped).toBe(true);
    expect(event.immediateStopped).toBe(true);
  });

  it('always emits modifiers in Ctrl+Alt+Shift+Meta order', () => {
    const panel = makePanel(shortcutItems());
    panel.records()[0].dispatch('click', {});
    panel.fireKey(keyEvent({
      key: '1', code: 'Digit1',
      ctrlKey: true, altKey: true, shiftKey: true, metaKey: true,
    }));
    expect(panel.posted[0].value).toBe('Ctrl+Alt+Shift+Meta+Digit1');
  });

  it('ignores IME, 229, AltGraph, repeat and modifier-only keydowns', () => {
    const panel = makePanel(shortcutItems());
    const record = panel.records()[0];
    record.dispatch('click', {});

    // 输入法合成 / AltGraph 必须原样放行（不 preventDefault、不停止传播）。
    const composing = keyEvent({ key: 'q', code: 'KeyQ', altKey: true, isComposing: true });
    const ime229 = keyEvent({ key: 'Process', code: 'KeyQ', altKey: true, keyCode: 229 });
    const altGraph = keyEvent({
      key: 'q', code: 'KeyQ', altKey: true,
      getModifierState: (name: string) => name === 'AltGraph',
    });
    const dead = keyEvent({ key: 'Dead', code: 'KeyE', altKey: true });
    panel.fireKey(composing);
    panel.fireKey(ime229);
    panel.fireKey(altGraph);
    panel.fireKey(dead);

    // repeat / 纯修饰键仍由录制器吞掉，不能触发聊天动作。
    const repeat = keyEvent({ key: 'q', code: 'KeyQ', altKey: true, repeat: true });
    const modifier = keyEvent({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    panel.fireKey(repeat);
    panel.fireKey(modifier);

    expect(panel.posted).toEqual([]);
    expect(record.className).toContain('recording');
    for (const event of [composing, ime229, altGraph, dead]) {
      expect(event.defaultPrevented).toBe(false);
      expect(event.propagationStopped).toBe(false);
      expect(event.immediateStopped).toBe(false);
    }
    expect(repeat.propagationStopped).toBe(true);
    expect(modifier.propagationStopped).toBe(true);
  });

  it('Escape cancels recording without closing the panel or posting', () => {
    const panel = makePanel(shortcutItems());
    const record = panel.records()[0];
    record.dispatch('click', {});
    panel.fireKey(keyEvent({ key: 'Escape', code: 'Escape' }));

    expect(panel.posted).toEqual([]);
    expect(record.className).not.toContain('recording');
    expect(record.textContent).toBe('Alt+A');
    expect(panel.elements.settingsOverlay.hidden).toBe(false);
  });

  it('blur and window blur cancel recording', () => {
    const panel = makePanel(shortcutItems());
    const record = panel.records()[0];
    record.dispatch('click', {});
    record.dispatch('blur', {});
    expect(record.className).not.toContain('recording');
    expect(panel.posted).toEqual([]);

    record.dispatch('click', {});
    panel.fireWindowBlur();
    expect(record.className).not.toContain('recording');
    expect(panel.posted).toEqual([]);
  });

  it('refuses duplicate bindings locally with a clear warning and stays recording', () => {
    const panel = makePanel(shortcutItems());
    const record = panel.records()[0];
    record.dispatch('click', {});
    panel.fireKey(keyEvent({ key: 'e', code: 'KeyE', altKey: true }));

    expect(panel.posted).toEqual([]);
    expect(record.className).toContain('recording');
    expect(panel.elements.settingsBody.textContent)
      .toContain('"Alt+E" is already used by "Scroll to bottom"');

    panel.fireKey(keyEvent({ key: 'x', code: 'KeyX', altKey: true }));
    expect(panel.posted).toEqual([
      { type: 'setSetting', key: 'panel.shortcut.scrollTop', value: 'Alt+KeyX' },
    ]);
  });

  it('warns about unsupported keys, missing modifiers and Shift-only bindings without posting', () => {
    const panel = makePanel(shortcutItems());
    const record = panel.records()[0];
    record.dispatch('click', {});

    panel.fireKey(keyEvent({ key: ';', code: 'Semicolon', ctrlKey: true }));
    expect(panel.posted).toEqual([]);
    expect(panel.elements.settingsBody.textContent).toContain('Unsupported key');

    panel.fireKey(keyEvent({ key: 'a', code: 'KeyA' }));
    expect(panel.posted).toEqual([]);
    expect(panel.elements.settingsBody.textContent).toContain('Add at least one modifier');

    panel.fireKey(keyEvent({ key: 'A', code: 'KeyA', shiftKey: true }));
    expect(panel.posted).toEqual([]);
    expect(panel.elements.settingsBody.textContent)
      .toContain('Shift alone would intercept capital letters');
    expect(record.className).toContain('recording');
  });

  it('sends null for Disable and "default" for Reset', () => {
    const panel = makePanel(shortcutItems());
    panel.elements.settingsBody.querySelector('.settings-shortcut-disable')!.dispatch('click', {});
    expect(panel.posted).toEqual([
      { type: 'setSetting', key: 'panel.shortcut.scrollTop', value: null },
    ]);

    panel.posted.length = 0;
    panel.elements.settingsBody.querySelector('.settings-shortcut-reset')!.dispatch('click', {});
    expect(panel.posted).toEqual([
      { type: 'setSetting', key: 'panel.shortcut.scrollTop', value: 'default' },
    ]);
  });

  it('hides the Disable action for an already-disabled binding', () => {
    const panel = makePanel(shortcutItems({ scrollTop: null }));
    const record = panel.records()[0];
    expect(record.textContent).toBe('Disabled');
    expect(record.className).toContain('is-disabled');
    expect(panel.elements.settingsBody.querySelector('.settings-shortcut-disable')!.hidden).toBe(true);
  });

  it('cancels a ghost recording when the host re-renders the table', () => {
    const panel = makePanel(shortcutItems());
    panel.records()[0].dispatch('click', {});
    panel.NS.settingsPanel.setItems(shortcutItems());
    expect(panel.records()[0].className).not.toContain('recording');

    panel.fireKey(keyEvent({ key: 'x', code: 'KeyX', altKey: true }));
    expect(panel.posted).toEqual([]);
  });

  it('shows a warning sent by the host on the shortcut row', () => {
    const items = shortcutItems();
    items[0].warning = 'This shortcut is reserved by the IDE.';
    const panel = makePanel(items);
    expect(panel.elements.settingsBody.textContent)
      .toContain('This shortcut is reserved by the IDE.');
  });
});
