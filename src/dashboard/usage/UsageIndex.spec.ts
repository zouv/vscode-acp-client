import { describe, expect, it } from 'vitest';
import { ARCHIVE_DAY, UsageIndex } from './UsageIndex';
import { UsageEvent } from './types';

const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function ev(partial: Partial<UsageEvent> & { key: string; ts: number }): UsageEvent {
  return {
    agent: 'claude',
    model: 'claude-sonnet-5.5',
    project: '/p/a',
    sessionId: 's1',
    input: 1000,
    output: 100,
    cacheCreate: 0,
    cacheRead: 0,
    ...partial,
  };
}

describe('UsageIndex', () => {
  it('buckets events into today, 7d, 30d and all time', () => {
    const idx = new UsageIndex();
    idx.apply(
      [
        ev({ key: 'k1', ts: NOW }),
        ev({ key: 'k2', ts: NOW - 3 * DAY }),
        ev({ key: 'k3', ts: NOW - 20 * DAY }),
        ev({ key: 'k4', ts: NOW - 200 * DAY }),
      ],
      NOW,
    );
    const s = idx.summarize(NOW);
    expect(s.periods.today.tokens).toBe(1100);
    expect(s.periods.last7d.tokens).toBe(2200);
    expect(s.periods.last30d.tokens).toBe(3300);
    expect(s.periods.all.tokens).toBe(4400);
    expect(s.periods.all.messages).toBe(4);
    expect(s.daily).toHaveLength(30);
    expect(s.daily[29].tokens).toBe(1100);
    expect(s.daily[9].tokens).toBe(1100);
  });

  it('upserts by event key so a re-seen message replaces its usage', () => {
    const idx = new UsageIndex();
    idx.apply([ev({ key: 'k1', ts: NOW, output: 5 })], NOW);
    idx.apply([ev({ key: 'k1', ts: NOW, output: 500 })], NOW);
    const s = idx.summarize(NOW);
    expect(s.periods.all.messages).toBe(1);
    expect(s.periods.all.output).toBe(500);
    expect(idx.rowCount).toBe(1);
  });

  it('does not double count when a whole file is rescanned', () => {
    const idx = new UsageIndex();
    const batch = [ev({ key: 'k1', ts: NOW }), ev({ key: 'k2', ts: NOW })];
    idx.apply(batch, NOW);
    idx.apply(batch, NOW);
    expect(idx.summarize(NOW).periods.all.tokens).toBe(2200);
  });

  it('breaks down by model and project with unpriced tokens excluded from cost', () => {
    const idx = new UsageIndex();
    idx.apply(
      [
        ev({ key: 'k1', ts: NOW, model: 'claude-sonnet-5.5', project: '/p/a', input: 1_000_000, output: 0, cacheCreate: 0, cacheRead: 0 }),
        ev({ key: 'k2', ts: NOW, model: 'glm-5.3-flash', project: '/p/b', input: 1_000_000, output: 0, cacheCreate: 0, cacheRead: 0 }),
      ],
      NOW,
    );
    const s = idx.summarize(NOW);
    expect(s.breakdown.last30d.models.map((m) => m.name)).toEqual(['claude-sonnet-5.5', 'glm-5.3-flash']);
    expect(s.breakdown.last30d.models[0].cost).toBeCloseTo(3, 6);
    expect(s.breakdown.last30d.models[1].priced).toBe(false);
    expect(s.unpriced.models).toEqual(['glm-5.3-flash']);
    expect(s.unpriced.tokens).toBe(1_000_000);
    expect(s.periods.all.cost).toBeCloseTo(3, 6);
  });

  it('compacts old rows without changing all-time totals', () => {
    const idx = new UsageIndex({ archiveAfterDays: 60 });
    idx.apply([ev({ key: 'k1', ts: NOW }), ev({ key: 'k2', ts: NOW - 100 * DAY })], NOW);
    const before = idx.summarize(NOW).periods.all;
    expect(idx.rowCount).toBe(2);
    idx.compact(NOW);
    expect(idx.rowCount).toBe(2);
    const after = idx.summarize(NOW).periods.all;
    expect(after.tokens).toBe(before.tokens);
    expect(after.cost).toBeCloseTo(before.cost, 9);
    expect(idx.toJSON().rows.some((r) => r[0] === ARCHIVE_DAY)).toBe(true);
  });

  it('keeps the recent map bounded', () => {
    const idx = new UsageIndex({ recentLimit: 5 });
    for (let i = 0; i < 20; i++) {
      idx.apply([ev({ key: 'k' + i, ts: NOW })], NOW);
    }
    expect(idx.toJSON().recent.length).toBeLessThanOrEqual(5);
    expect(idx.rowCount).toBe(1);
  });

  it('round-trips through JSON', () => {
    const idx = new UsageIndex();
    idx.apply([ev({ key: 'k1', ts: NOW }), ev({ key: 'k2', ts: NOW - 2 * DAY, model: 'claude-opus-5', output: 7 })], NOW);
    const revived = UsageIndex.fromJSON(JSON.parse(JSON.stringify(idx.toJSON())));
    expect(revived).toBeDefined();
    expect(revived?.summarize(NOW)).toEqual(idx.summarize(NOW));
  });

  it('rejects corrupt or version-mismatched payloads', () => {
    expect(UsageIndex.fromJSON(undefined)).toBeUndefined();
    expect(UsageIndex.fromJSON({ version: 99, rows: [], recent: [] })).toBeUndefined();
    expect(UsageIndex.fromJSON({ version: 1, rows: [['2026-10-12', 'claude']], recent: [] })).toBeUndefined();
    expect(UsageIndex.fromJSON({ version: 1, rows: [['2026-10-12', 'nope', 'm', 'p', 1, 1, 1, 1, 1]], recent: [] })).toBeUndefined();
    expect(UsageIndex.fromJSON({ version: 1, rows: [], recent: [['k', 'day', 'claude', 'm', 'p', 1, 2, 3, 'x']] })).toBeUndefined();
  });

  it('reports emptiness and dirty state', () => {
    const idx = new UsageIndex();
    expect(idx.isEmpty).toBe(true);
    idx.apply([ev({ key: 'k1', ts: NOW })], NOW);
    expect(idx.isEmpty).toBe(false);
    expect(idx.isDirty).toBe(true);
    idx.markClean();
    expect(idx.isDirty).toBe(false);
  });
});
