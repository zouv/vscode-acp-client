import { describe, expect, it } from 'vitest';
import { sessionMenuClient } from './sessionMenu';

function createClient() {
  const window: Record<string, any> = {};
  new Function('window', 'document', sessionMenuClient)(window, {});
  return window.__vac.sessionMenu as {
    applyPrefs(message: Record<string, unknown>): void;
    limitRows<T>(items: T[]): T[];
    canRefreshList(isOpen: boolean, isLoading: boolean, message: unknown): boolean;
  };
}

function rows(count: number) {
  return Array.from({ length: count }, (_, i) => i);
}

describe('history display limit', () => {
  it('is unlimited by default', () => {
    const menu = createClient();
    const items = rows(5);
    expect(menu.limitRows(items)).toEqual([0, 1, 2, 3, 4]);
    expect(menu.limitRows(items)).toBe(items);
  });

  it('caps the rendered view without mutating the loaded rows', () => {
    const menu = createClient();
    const items = rows(5);
    menu.applyPrefs({ historyDisplayLimit: 2 });
    expect(menu.limitRows(items)).toEqual([0, 1]);
    expect(items).toEqual([0, 1, 2, 3, 4]);
  });

  it('0 means unlimited, and out-of-range numbers clamp', () => {
    const menu = createClient();
    menu.applyPrefs({ historyDisplayLimit: 2 });
    menu.applyPrefs({ historyDisplayLimit: 0 });
    expect(menu.limitRows(rows(4))).toEqual([0, 1, 2, 3]);
    menu.applyPrefs({ historyDisplayLimit: -3 });
    expect(menu.limitRows(rows(4))).toEqual([0, 1, 2, 3]);
  });

  it('a missing or invalid update keeps the limit already in force', () => {
    const menu = createClient();
    menu.applyPrefs({ historyDisplayLimit: 2 });
    menu.applyPrefs({});
    expect(menu.limitRows(rows(4))).toEqual([0, 1]);
    menu.applyPrefs({ historyDisplayLimit: '' });
    expect(menu.limitRows(rows(4))).toEqual([0, 1]);
    menu.applyPrefs({ historyDisplayLimit: 'abc' });
    expect(menu.limitRows(rows(4))).toEqual([0, 1]);
    menu.applyPrefs({ historyDisplayLimit: null });
    expect(menu.limitRows(rows(4))).toEqual([0, 1]);
  });

  it('accepts the number input string and clamps the upper bound', () => {
    const menu = createClient();
    menu.applyPrefs({ historyDisplayLimit: '3' });
    expect(menu.limitRows(rows(4))).toEqual([0, 1, 2]);
    menu.applyPrefs({ historyDisplayLimit: 10_001 });
    expect(menu.limitRows(rows(10_005))).toHaveLength(10_000);
  });

  it('does not refresh a closed, loading, or not-yet-received list', () => {
    const menu = createClient();
    expect(menu.canRefreshList(false, false, { sessions: [] })).toBe(false);
    expect(menu.canRefreshList(true, true, null)).toBe(false);
    expect(menu.canRefreshList(true, true, { sessions: [] })).toBe(false);
    expect(menu.canRefreshList(true, false, null)).toBe(false);
    expect(menu.canRefreshList(true, false, { sessions: [] })).toBe(true);
  });
});
