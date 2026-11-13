// [CUSTOM- 设置面板「自定义模型」拖拽/键盘排序与 compare-and-set 回执的独立逻辑测试。
//
// 用最小桩 DOM 真跑 settingsPanelClient：能测行顺序、回传消息、冲突/错误 UI 与草稿保留，
// 不测布局。宿主写入队列由 ModelListSync.spec.ts 覆盖。
import { describe, expect, it } from 'vitest';

import { domClient } from './dom';
import { settingsPanelClient } from './settingsPanel';

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
  rect = { top: 0, height: 20 };
  private listeners: Record<string, Array<(event: any) => void>> = {};
  readonly tagName: string;

  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  appendChild<T extends StubNode | StubText>(child: T): T {
    if (child.parentNode) { child.parentNode.removeChild(child); }
    child.parentNode = this as unknown as StubNode;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends StubNode | StubText>(child: T, reference: StubNode | StubText | null): T {
    if (child.parentNode) { child.parentNode.removeChild(child); }
    child.parentNode = this as unknown as StubNode;
    const at = reference ? this.childNodes.indexOf(reference) : -1;
    if (at < 0) { this.childNodes.push(child); } else { this.childNodes.splice(at, 0, child); }
    return child;
  }

  removeChild(child: StubNode | StubText): void {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) { this.childNodes.splice(at, 1); }
    child.parentNode = null;
  }

  get firstChild(): StubNode | StubText | null { return this.childNodes[0] ?? null; }

  get nextSibling(): StubNode | StubText | null {
    if (!this.parentNode) { return null; }
    const at = this.parentNode.childNodes.indexOf(this);
    return at >= 0 ? this.parentNode.childNodes[at + 1] ?? null : null;
  }

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

  setAttribute(name: string, value: unknown): void {
    this.attributes[name] = String(value);
    if (name === 'class') { this.className = String(value); }
  }

  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }

  focus(): void { this.focused = true; }

  getBoundingClientRect(): { top: number; height: number } { return this.rect; }

  matches(selector: string): boolean {
    const parts = selector.trim().split(/\s+/);
    const matchesSimple = (node: StubNode, sel: string): boolean => {
      if (!sel) { return false; }
      if (sel.startsWith('.')) { return node.className.split(/\s+/).includes(sel.slice(1)); }
      return node.tagName === sel.toUpperCase();
    };
    if (!matchesSimple(this, parts[parts.length - 1])) { return false; }
    let ancestor = this.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (ancestor && !matchesSimple(ancestor, parts[i])) { ancestor = ancestor.parentNode; }
      if (!ancestor) { return false; }
      ancestor = ancestor.parentNode;
    }
    return true;
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

function modelItem(value: any[], overrides: Record<string, unknown> = {}): any {
  return {
    key: 'vac.customModels', group: 'advanced', label: 'Custom models', type: 'models',
    value,
    modelBaseline: 'global|global|base',
    ...overrides,
  };
}

function makePanel(value: any[], overrides: Record<string, unknown> = {}) {
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
  const docListeners: Record<string, Array<(event: any) => void>> = {};
  const win: any = {
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
    addEventListener(type: string, fn: (event: any) => void) {
      (docListeners[type] = docListeners[type] ?? []).push(fn);
    },
  };

  new Function('window', 'document', domClient)(win, doc);
  new Function('window', 'document', settingsPanelClient)(win, doc);
  const NS = win.__vac;
  const posted: any[] = [];
  NS.bridge = { post: (message: any) => { posted.push(message); } };
  const popover = { calls: [] as any[], accept: true, show: true };
  NS.popover = {
    confirm(options: any) {
      popover.calls.push(options);
      if (!popover.show) { return false; }
      if (popover.accept && options && typeof options.onConfirm === 'function') {
        options.onConfirm();
      }
      return true;
    },
  };
  NS.settingsPanel.init();
  NS.settingsPanel.open();
  NS.settingsPanel.setItems([modelItem(value, overrides)]);
  posted.length = 0;

  const itemOverrides = overrides;
  const rows = (): StubNode[] => elements.settingsSubBody.querySelectorAll('.settings-model-row');
  const openEditor = (): void => {
    const edit = elements.settingsBody.querySelector('.settings-action');
    if (!edit) { throw new Error('Edit button not rendered'); }
    edit.dispatch('click', {});
  };
  const applySync = (sync: any, nextValue = value): void => {
    NS.settingsPanel.setItems([modelItem(nextValue, {
      ...itemOverrides,
      modelSync: sync,
    })]);
  };
  const fireDocKey = (event: any): void => {
    for (const fn of (docListeners.keydown ?? []).slice()) { fn(event); }
  };
  const status = (): StubNode | null => elements.settingsSubBody.querySelector('.settings-model-status');
  const statusButtons = (): StubNode[] =>
    elements.settingsSubBody.querySelectorAll('.settings-model-status-actions .settings-link');
  const announce = (): StubNode => elements.settingsSubBody.querySelector('.settings-model-announce')!;

  return {
    NS,
    elements,
    posted,
    rows,
    openEditor,
    applySync,
    fireDocKey,
    status,
    statusButtons,
    announce,
    popover,
    list: () => elements.settingsSubBody.querySelector('.settings-models')!,
  };
}

function pressMove(panel: ReturnType<typeof makePanel>, index: number, key: string): void {
  panel.rows()[index].querySelector('.settings-model-drag')!.dispatch('keydown', { key, preventDefault() {} });
}

describe('settings panel: custom model ordering', () => {
  it('renders a focusable drag handle and no move buttons on every row', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }]);
    panel.openEditor();
    const rows = panel.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll('.settings-model-drag')).toHaveLength(1);
    expect(rows[0].querySelectorAll('.settings-model-move')).toHaveLength(0);
    expect(rows[0].querySelectorAll('.settings-model-up')).toHaveLength(0);
    expect(rows[0].querySelectorAll('.settings-model-down')).toHaveLength(0);
    const handle = rows[0].querySelector('.settings-model-drag')!;
    expect(handle.getAttribute('tabindex')).toBe('0');
    expect(handle.getAttribute('role')).toBe('button');
    expect(handle.getAttribute('aria-label')).toBe('Reorder model');
    expect(panel.elements.settingsSubBody.textContent).toContain('Drag the handle');
    expect(panel.elements.settingsSubBody.textContent).toContain('agent must support extra models');
    expect(panel.elements.settingsSubBody.textContent).toContain('newly created or restored sessions');
  });

  it('moves a row with arrow keys on the drag handle and posts the new sequence', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }]);
    panel.openEditor();
    // 输入中的 alias 还没触发 change：移动不能丢它。
    panel.rows()[0].querySelectorAll('input')[1].value = 'A typed';
    pressMove(panel, 0, 'ArrowDown');

    expect(panel.rows().map(row => row.querySelectorAll('input')[0].value)).toEqual(['b', 'a']);
    expect(panel.rows().map(row => row.querySelectorAll('input')[1].value)).toEqual(['B', 'A typed']);
    expect(panel.posted).toHaveLength(1);
    expect(panel.posted[0]).toMatchObject({
      type: 'setModelList',
      baseline: 'global|global|base',
      value: [{ modelId: 'b', name: 'B' }, { modelId: 'a', name: 'A typed' }],
    });
    expect(typeof panel.posted[0].requestId).toBe('string');
    expect(panel.posted[0].requestId.length).toBeGreaterThan(0);
    expect(panel.posted[0].force).toBe(false);
    expect(panel.posted.some(message => message.type === 'setSetting')).toBe(false);
    // 屏幕阅读器播报具体模型 + 位置。
    expect(panel.announce().getAttribute('aria-live')).toBe('polite');
    expect(panel.announce().textContent)
      .toBe('Moved model "A typed" to position 2 of 2.');
  });

  it('does not save or stay open when nothing changed', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }]);
    panel.openEditor();
    const done = panel.elements.settingsSubBody
      .querySelectorAll('.settings-editor-footer .settings-action')[0];
    done.dispatch('click', {});
    expect(panel.posted).toEqual([]);
    expect(panel.elements.settingsSubOverlay.hidden).toBe(true);
    // 主设置面板仍在（Done 只关子面板）。
    expect(panel.elements.settingsOverlay.hidden).toBe(false);
  });

  it('drops empty rows but keeps duplicate ids and their order', () => {
    const panel = makePanel([
      { modelId: 'a', name: 'A' },
      { modelId: '', name: '', description: '' },
      { modelId: 'b', name: 'B' },
      { modelId: 'a', name: 'A second' },
    ]);
    panel.openEditor();
    // 空行本身不构成变更；改一个 alias 才能把整份列表（含重复 id 的顺序）提交出去。
    panel.rows()[3].querySelectorAll('input')[1].value = 'A second changed';
    const done = panel.elements.settingsSubBody
      .querySelectorAll('.settings-editor-footer .settings-action')[0];
    done.dispatch('click', {});
    expect(panel.posted).toHaveLength(1);
    expect(panel.posted[0].value).toEqual([
      { modelId: 'a', name: 'A' },
      { modelId: 'b', name: 'B' },
      { modelId: 'a', name: 'A second changed' },
    ]);
  });

  it('serialises consecutive commits and sends the queued one after success', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }]);
    panel.openEditor();
    pressMove(panel, 0, 'ArrowDown');
    expect(panel.posted).toHaveLength(1);
    const first = panel.posted[0];

    // 第二次排序发生在第一条在途时：只排队，不再发。
    pressMove(panel, 0, 'ArrowDown');
    expect(panel.posted).toHaveLength(1);

    panel.applySync({
      requestId: first.requestId, status: 'saved',
      baseline: 'global|global|first-saved',
      models: first.value,
    }, first.value);

    expect(panel.posted).toHaveLength(2);
    expect(panel.posted[1]).toMatchObject({
      type: 'setModelList',
      baseline: 'global|global|first-saved',
      value: [{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }],
    });
  });

  it('keeps the local draft and offers Reload / Overwrite on conflict', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }]);
    panel.openEditor();
    panel.rows()[0].querySelectorAll('input')[1].value = 'typed locally';
    pressMove(panel, 0, 'ArrowDown');
    const first = panel.posted[0];

    panel.applySync({
      requestId: first.requestId, status: 'conflict', message: 'Changed again after confirmation.',
      models: [{ modelId: 'external', name: 'External' }],
      baseline: 'workspace|workspace|external',
    }, [{ modelId: 'external', name: 'External' }]);

    expect(panel.status()!.hidden).toBe(false);
    expect(panel.status()!.textContent).toContain('Changed again after confirmation.');
    expect(panel.statusButtons().map(button => button.textContent)).toEqual(['Reload', 'Overwrite']);
    // 本地草稿没有被回执覆盖。
    expect(panel.rows().map(row => row.querySelectorAll('input')[0].value)).toEqual(['b', 'a']);
    expect(panel.rows().map(row => row.querySelectorAll('input')[1].value))
      .toEqual(['B', 'typed locally']);
    expect(panel.posted).toHaveLength(1);

    panel.statusButtons()[0].dispatch('click', {});
    expect(panel.rows()).toHaveLength(1);
    expect(panel.rows()[0].querySelectorAll('input')[0].value).toBe('external');
    expect(panel.posted).toHaveLength(1);
    expect(panel.status()!.hidden).toBe(true);
  });

  it('Overwrite sends the local draft with force and the external baseline', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }]);
    panel.openEditor();
    panel.rows()[0].querySelectorAll('input')[1].value = 'mine';
    panel.rows()[0].querySelectorAll('input')[1].dispatch('change', {});
    const first = panel.posted[0];
    panel.applySync({
      requestId: first.requestId, status: 'conflict',
      models: [{ modelId: 'external', name: 'External' }],
      baseline: 'user|user|external',
    }, [{ modelId: 'external', name: 'External' }]);

    panel.statusButtons()[1].dispatch('click', {});
    expect(panel.posted).toHaveLength(2);
    expect(panel.posted[1]).toMatchObject({
      type: 'setModelList',
      baseline: 'user|user|external',
      force: true,
      value: [{ modelId: 'a', name: 'mine' }],
    });
  });

  it('keeps the draft on a write failure and retries the same value', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }]);
    panel.openEditor();
    panel.rows()[0].querySelectorAll('input')[1].value = 'draft';
    panel.rows()[0].querySelectorAll('input')[1].dispatch('change', {});
    const first = panel.posted[0];

    panel.applySync({ requestId: first.requestId, status: 'error', message: 'EACCES' });
    expect(panel.status()!.textContent).toContain('EACCES');
    expect(panel.statusButtons().map(button => button.textContent)).toEqual(['Retry', 'Discard']);
    expect(panel.rows()[0].querySelectorAll('input')[1].value).toBe('draft');

    // 失败后继续输入但没触发 change：Retry 必须读此刻 DOM，而不是失败时的旧值。
    panel.rows()[0].querySelectorAll('input')[1].value = 'typed after failure';
    panel.statusButtons()[0].dispatch('click', {});
    expect(panel.posted).toHaveLength(2);
    expect(panel.posted[1].value).toEqual([{ modelId: 'a', name: 'typed after failure' }]);
    expect(panel.posted[1].baseline).toBe('global|global|base');
  });

  it('failure offers an explicit Discard that confirms before dropping the draft', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }]);
    panel.openEditor();
    panel.rows()[0].querySelectorAll('input')[1].value = 'draft';
    panel.rows()[0].querySelectorAll('input')[1].dispatch('change', {});
    panel.applySync({ requestId: panel.posted[0].requestId, status: 'error', message: 'EACCES' });

    panel.popover.accept = false;
    panel.statusButtons()[1].dispatch('click', {});
    expect(panel.popover.calls).toHaveLength(1);
    expect(panel.popover.calls[0].message).toContain('Discard');
    expect(panel.elements.settingsSubOverlay.hidden).toBe(false);
    expect(panel.rows()[0].querySelectorAll('input')[1].value).toBe('draft');

    // confirm 返回 false（没能展示/用户拒绝）也不能丢草稿。
    panel.popover.show = false;
    panel.statusButtons()[1].dispatch('click', {});
    expect(panel.elements.settingsSubOverlay.hidden).toBe(false);
    expect(panel.rows()[0].querySelectorAll('input')[1].value).toBe('draft');

    // 完全没有确认机制时保留草稿并提示。
    const popover = panel.NS.popover;
    delete panel.NS.popover;
    panel.statusButtons()[1].dispatch('click', {});
    expect(panel.elements.settingsSubOverlay.hidden).toBe(false);
    expect(panel.status()!.textContent).toContain('Could not show a discard confirmation');
    expect(panel.rows()[0].querySelectorAll('input')[1].value).toBe('draft');

    panel.NS.popover = popover;
    panel.popover.show = true;
    panel.popover.accept = true;
    panel.statusButtons()[1].dispatch('click', {});
    expect(panel.elements.settingsSubOverlay.hidden).toBe(true);
    expect(panel.posted).toHaveLength(1);
  });

  it('Esc and the settings close button can discard a failed save instead of wedging', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }]);
    panel.openEditor();
    panel.rows()[0].querySelectorAll('input')[1].value = 'draft';
    panel.rows()[0].querySelectorAll('input')[1].dispatch('change', {});
    panel.applySync({ requestId: panel.posted[0].requestId, status: 'error', message: 'EACCES' });

    panel.fireDocKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    expect(panel.popover.calls).toHaveLength(1);
    expect(panel.elements.settingsSubOverlay.hidden).toBe(true);
    expect(panel.elements.settingsOverlay.hidden).toBe(false);

    // 再触发一次错误态，用整个设置面板的关闭按钮：确认后两层都关。
    panel.rows(); // editor is gone; reopen below
    panel.openEditor();
    panel.rows()[0].querySelectorAll('input')[1].value = 'draft 2';
    panel.rows()[0].querySelectorAll('input')[1].dispatch('change', {});
    panel.applySync({ requestId: panel.posted[1].requestId, status: 'error', message: 'EACCES' });
    panel.NS.settingsPanel.close();
    expect(panel.elements.settingsSubOverlay.hidden).toBe(true);
    expect(panel.elements.settingsOverlay.hidden).toBe(true);
  });

  it('reorders with drag and drop using row geometry', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }]);
    panel.openEditor();
    const rows = panel.rows();
    rows[0].rect = { top: 0, height: 20 };
    rows[1].rect = { top: 30, height: 20 };
    const list = panel.list();
    const handle = rows[0].querySelector('.settings-model-drag')!;

    handle.dispatch('dragstart', { dataTransfer: { effectAllowed: '', setData() {} } });
    list.dispatch('dragover', { preventDefault() {}, dataTransfer: { dropEffect: '' }, clientY: 5 });
    expect(rows[0].className).toContain('settings-model-drop-before');
    list.dispatch('dragleave', { relatedTarget: null });
    expect(rows[0].className).not.toContain('settings-model-drop-before');
    list.dispatch('dragover', { preventDefault() {}, dataTransfer: { dropEffect: '' }, clientY: 100 });
    expect(rows[1].className).toContain('settings-model-drop-after');
    list.dispatch('drop', { clientY: 100, preventDefault() {} });

    expect(panel.rows().map(row => row.querySelectorAll('input')[0].value)).toEqual(['b', 'a']);
    expect(panel.posted).toHaveLength(1);
    expect(panel.posted[0].value).toEqual([{ modelId: 'b', name: 'B' }, { modelId: 'a', name: 'A' }]);
    expect(panel.announce().textContent).toBe('Moved model "A" to position 2 of 2.');
    for (const row of panel.rows()) {
      expect(row.className).not.toContain('settings-model-drop-');
    }
  });

  it('does not close over input typed during the Done save round-trip', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }]);
    panel.openEditor();
    panel.rows()[0].querySelectorAll('input')[1].value = 'draft';
    panel.rows()[0].querySelectorAll('input')[1].dispatch('change', {});
    const first = panel.posted[0];

    // 保存还在途中就点 Done：closeAfterSave 置位，但此时不能关。
    const done = panel.elements.settingsSubBody
      .querySelectorAll('.settings-editor-footer .settings-action')[0];
    done.dispatch('click', {});
    expect(panel.elements.settingsSubOverlay.hidden).toBe(false);

    // 回执到达前继续输入，且不派发 change。
    panel.rows()[0].querySelectorAll('input')[1].value = 'typed during save';

    panel.applySync({
      requestId: first.requestId, status: 'saved',
      baseline: 'global|global|after-first', models: first.value,
    }, first.value);
    // Done 时排队的那条与已确认值相同、无需重发；关闭前重新读 DOM，
    // 把回执期间输入的 latest 值再排一条，而不是直接 hide。
    expect(panel.posted).toHaveLength(2);
    expect(panel.posted[1].value).toEqual([{ modelId: 'a', name: 'typed during save' }]);
    expect(panel.elements.settingsSubOverlay.hidden).toBe(false);

    panel.applySync({
      requestId: panel.posted[1].requestId, status: 'saved',
      baseline: 'global|global|after-second', models: panel.posted[1].value,
    }, panel.posted[1].value);
    expect(panel.posted).toHaveLength(2);
    expect(panel.elements.settingsSubOverlay.hidden).toBe(true);
  });

  it('keeps both panels open while a save or conflict is unresolved', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }]);
    panel.openEditor();
    pressMove(panel, 0, 'ArrowDown');
    const first = panel.posted[0];

    panel.NS.settingsPanel.close();
    expect(panel.elements.settingsOverlay.hidden).toBe(false);
    expect(panel.elements.settingsSubOverlay.hidden).toBe(false);

    panel.applySync({
      requestId: first.requestId, status: 'conflict',
      models: [{ modelId: 'external', name: 'External' }],
      baseline: 'workspace|workspace|external',
    }, [{ modelId: 'external', name: 'External' }]);
    panel.NS.settingsPanel.close();
    expect(panel.elements.settingsOverlay.hidden).toBe(false);
    expect(panel.elements.settingsSubOverlay.hidden).toBe(false);

    // Reload 之后没有在途/冲突，再关就真的关掉两层。
    panel.statusButtons()[0].dispatch('click', {});
    panel.NS.settingsPanel.close();
    expect(panel.elements.settingsOverlay.hidden).toBe(true);
    expect(panel.elements.settingsSubOverlay.hidden).toBe(true);
  });

  it('Escape during an unresolved save does not hide the panels', () => {
    const panel = makePanel([{ modelId: 'a', name: 'A' }, { modelId: 'b', name: 'B' }]);
    panel.openEditor();
    pressMove(panel, 0, 'ArrowDown');
    panel.fireDocKey({
      key: 'Escape',
      preventDefault() {},
      stopPropagation() {},
    });
    expect(panel.elements.settingsOverlay.hidden).toBe(false);
    expect(panel.elements.settingsSubOverlay.hidden).toBe(false);
  });
});
