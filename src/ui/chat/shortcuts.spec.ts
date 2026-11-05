import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SHORTCUTS,
  applyShortcutSetting,
  canonicalizeShortcut,
  defaultShortcutMap,
  normalizeShortcutMap,
} from './shortcuts';

describe('shortcut canonicalization', () => {
  it('keeps the canonical modifier order and KeyboardEvent.code', () => {
    expect(canonicalizeShortcut('Alt+KeyA')).toEqual({ ok: true, value: 'Alt+KeyA' });
    expect(canonicalizeShortcut('shift+alt+KeyA')).toEqual({ ok: true, value: 'Alt+Shift+KeyA' });
    expect(canonicalizeShortcut('Meta+Ctrl+Shift+Alt+ArrowUp'))
      .toEqual({ ok: true, value: 'Ctrl+Alt+Shift+Meta+ArrowUp' });
    expect(canonicalizeShortcut('ctrl+digit0')).toEqual({ ok: true, value: 'Ctrl+Digit0' });
    expect(canonicalizeShortcut('Alt+PageDown')).toEqual({ ok: true, value: 'Alt+PageDown' });
  });

  it('accepts modifier aliases but still emits one canonical spelling', () => {
    expect(canonicalizeShortcut('control+option+cmd+KeyZ'))
      .toEqual({ ok: true, value: 'Ctrl+Alt+Meta+KeyZ' });
  });

  it('rejects Shift-only bindings that would swallow capital text', () => {
    expect(canonicalizeShortcut('Shift+KeyA')).toEqual({ ok: false });
    expect(canonicalizeShortcut('Shift+Digit1')).toEqual({ ok: false });
    expect(canonicalizeShortcut('Shift+Alt+KeyA')).toEqual({ ok: true, value: 'Alt+Shift+KeyA' });
    expect(applyShortcutSetting(defaultShortcutMap(), 'scrollTop', 'Shift+KeyB'))
      .toEqual({ ok: false, reason: 'invalid' });
  });

  it('treats null as disabled and rejects malformed values', () => {
    expect(canonicalizeShortcut(null)).toEqual({ ok: true, value: null });
    expect(canonicalizeShortcut('KeyA')).toEqual({ ok: false });
    expect(canonicalizeShortcut('Alt')).toEqual({ ok: false });
    expect(canonicalizeShortcut('Alt+KeyAA')).toEqual({ ok: false });
    expect(canonicalizeShortcut('Alt+F1')).toEqual({ ok: false });
    expect(canonicalizeShortcut('Alt+Ctrl+Alt+KeyA')).toEqual({ ok: false });
    expect(canonicalizeShortcut('Alt++KeyA')).toEqual({ ok: false });
    expect(canonicalizeShortcut(7)).toEqual({ ok: false });
  });
});

describe('shortcut map normalization', () => {
  it('fills missing actions with defaults', () => {
    expect(normalizeShortcutMap(undefined)).toEqual(defaultShortcutMap());
    expect(normalizeShortcutMap({ scrollTop: null })).toEqual({
      ...defaultShortcutMap(),
      scrollTop: null,
    });
  });

  it('normalizes dirty spellings without letting them collide', () => {
    const normalized = normalizeShortcutMap({
      scrollTop: 'shift+alt+KeyA',
      scrollBottom: 'Alt+Shift+KeyA',
      focusInput: 'not a shortcut',
      previousSession: null,
    });
    expect(normalized).toEqual({
      scrollTop: 'Alt+Shift+KeyA',
      scrollBottom: DEFAULT_SHORTCUTS.scrollBottom,
      focusInput: DEFAULT_SHORTCUTS.focusInput,
      previousSession: null,
      nextSession: DEFAULT_SHORTCUTS.nextSession,
    });
    expect(new Set(Object.values(normalized).filter(Boolean)).size)
      .toBe(Object.values(normalized).filter(Boolean).length);
  });

  it('falls back deterministically when a dirty default is already taken', () => {
    expect(normalizeShortcutMap({ scrollTop: 'Alt+KeyE' })).toEqual({
      scrollTop: 'Alt+KeyE',
      scrollBottom: null,
      focusInput: DEFAULT_SHORTCUTS.focusInput,
      previousSession: DEFAULT_SHORTCUTS.previousSession,
      nextSession: DEFAULT_SHORTCUTS.nextSession,
    });
  });
});

describe('shortcut setting updates', () => {
  it('accepts a unique binding, disables with null, and resets with default', () => {
    const base = defaultShortcutMap();
    const changed = applyShortcutSetting(base, 'scrollTop', 'Ctrl+Shift+KeyB');
    expect(changed).toEqual({
      ok: true,
      shortcuts: { ...base, scrollTop: 'Ctrl+Shift+KeyB' },
    });

    const disabled = applyShortcutSetting(base, 'scrollTop', null);
    expect(disabled).toEqual({ ok: true, shortcuts: { ...base, scrollTop: null } });

    const reset = applyShortcutSetting({ ...base, scrollTop: 'Ctrl+KeyB' }, 'scrollTop', 'default');
    expect(reset).toEqual({ ok: true, shortcuts: base });
  });

  it('rejects invalid values and duplicate bindings', () => {
    const base = defaultShortcutMap();
    expect(applyShortcutSetting(base, 'scrollTop', 'KeyA')).toEqual({ ok: false, reason: 'invalid' });
    expect(applyShortcutSetting(base, 'scrollTop', 'Alt+KeyE')).toEqual({
      ok: false,
      reason: 'duplicate',
      conflictAction: 'scrollBottom',
      binding: 'Alt+KeyE',
    });
    expect(applyShortcutSetting(base, 'scrollBottom', 'default')).toEqual({
      ok: true,
      shortcuts: base,
    });
  });

  it('rejects a reset whose default is currently used by another action', () => {
    const current = { ...defaultShortcutMap(), scrollTop: 'Alt+KeyE', scrollBottom: null };
    expect(applyShortcutSetting(current, 'scrollBottom', 'default')).toEqual({
      ok: false,
      reason: 'duplicate',
      conflictAction: 'scrollTop',
      binding: 'Alt+KeyE',
    });
  });
});
