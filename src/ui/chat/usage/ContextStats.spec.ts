import { describe, expect, it } from 'vitest';
import { ContextStats, type ContextUsageInput } from './ContextStats';

const usage = (
  used: number,
  size: number,
  extra: Partial<ContextUsageInput> = {},
): ContextUsageInput => ({ used, size, ...extra });

describe('ContextStats snapshot', () => {
  it('has no payload until a context window is known', () => {
    const stats = new ContextStats();
    expect(stats.snapshot('s')).toBeNull();
    stats.noteUsage('s', { used: 100 });          // no size
    expect(stats.snapshot('s')).toBeNull();
    stats.noteUsage('s', usage(100, 1000));
    expect(stats.snapshot('s')).toMatchObject({ used: 100, size: 1000, turns: 0, history: [] });
  });

  it('carries model, cost and rate limits from usage updates', () => {
    const stats = new ContextStats();
    stats.noteUsage('s', usage(10, 100, { model: 'claude-x', costAmount: 1.5, costCurrency: 'USD' }));
    stats.noteRateLimit('s', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.62, resetsAt: 5000 });
    stats.noteRateLimit('s', { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.8 });
    const snapshot = stats.snapshot('s')!;
    expect(snapshot.model).toBe('claude-x');
    expect(snapshot.costAmount).toBe(1.5);
    expect(snapshot.rateLimits).toEqual([
      { type: 'five_hour', status: 'allowed', utilization: 0.62, resetsAt: 5000 },
      { type: 'seven_day', status: 'allowed_warning', utilization: 0.8 },
    ]);
  });

  it('keeps the parts of the last model call for the split ring', () => {
    const stats = new ContextStats();
    stats.noteUsage('s', usage(100000, 200000, {
      parts: { inputTokens: 60000, outputTokens: 20000, cachedReadTokens: 15000, cachedWriteTokens: 5000 },
    }));
    expect(stats.snapshot('s')!.parts).toEqual({
      inputTokens: 60000, outputTokens: 20000, cachedReadTokens: 15000, cachedWriteTokens: 5000,
    });
    // [CUSTOM- 压缩后的 usage_update 只带 post_tokens、不带拆分：旧拆分必须一起作废。
    stats.noteUsage('s', usage(40000, 200000));
    expect(stats.snapshot('s')!.parts).toBeUndefined();
  });

  it('keeps only the latest snapshot per limit type', () => {
    const stats = new ContextStats();
    stats.noteUsage('s', usage(10, 100));
    stats.noteRateLimit('s', { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 });
    stats.noteRateLimit('s', { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.9 });
    expect(stats.snapshot('s')!.rateLimits).toEqual([
      { type: 'five_hour', status: 'allowed_warning', utilization: 0.9 },
    ]);
  });

  it('clamps utilization and ignores snapshots without a status', () => {
    const stats = new ContextStats();
    stats.noteUsage('s', usage(10, 100));
    stats.noteRateLimit('s', { rateLimitType: 'five_hour' });
    stats.noteRateLimit('s', { status: 'allowed', rateLimitType: 'five_hour', utilization: 1.7 });
    expect(stats.snapshot('s')!.rateLimits).toEqual([
      { type: 'five_hour', status: 'allowed', utilization: 1 },
    ]);
  });
});

describe('ContextStats turns', () => {
  it('records each prompt response as that turn\'s mix', () => {
    const stats = new ContextStats();
    stats.noteUsage('s', usage(100, 1000));
    stats.noteTurn('s', { inputTokens: 10, outputTokens: 2, cachedReadTokens: 100, cachedWriteTokens: 5 });
    stats.noteUsage('s', usage(400, 1000));
    stats.noteTurn('s', { inputTokens: 14, outputTokens: 5, cachedReadTokens: 380, cachedWriteTokens: 8 });
    const snapshot = stats.snapshot('s')!;
    expect(snapshot.turns).toBe(2);
    // 每轮 response 在适配器侧已按轮重置，所以第二轮就是它自己的数字（不做差值）。
    expect(snapshot.lastTurn).toEqual({
      inputTokens: 14, outputTokens: 5, cachedReadTokens: 380, cachedWriteTokens: 8,
    });
    expect(snapshot.history).toEqual([
      { turn: 1, used: 100, size: 1000 },
      { turn: 2, used: 400, size: 1000 },
    ]);
  });

  it('keeps thought tokens when the agent reports them', () => {
    const stats = new ContextStats();
    stats.noteUsage('s', usage(10, 100));
    stats.noteTurn('s', { inputTokens: 4, thoughtTokens: 30 });
    expect(stats.snapshot('s')!.lastTurn).toEqual({
      inputTokens: 4, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 30,
    });
  });

  it('does not invent a turn mix when the response carries no usage', () => {
    const stats = new ContextStats();
    stats.noteUsage('s', usage(50, 100));
    stats.noteTurn('s', undefined);
    const snapshot = stats.snapshot('s')!;
    expect(snapshot.lastTurn).toBeUndefined();
    expect(snapshot.history).toEqual([{ turn: 1, used: 50, size: 100 }]);
  });

  it('derives the per-turn cost from the cumulative cost', () => {
    const stats = new ContextStats();
    stats.noteUsage('s', usage(10, 100, { costAmount: 0.3 }));
    stats.noteTurn('s', { inputTokens: 1 });
    stats.noteUsage('s', usage(20, 100, { costAmount: 0.5 }));
    stats.noteTurn('s', { inputTokens: 2 });
    expect(stats.snapshot('s')!.lastTurn!.costAmount).toBeCloseTo(0.2);
  });

  it('caps history and records compaction turns once', () => {
    const stats = new ContextStats();
    stats.noteUsage('s', usage(10, 100));
    for (let i = 0; i < 60; i++) { stats.noteTurn('s', { inputTokens: i + 1 }); }
    const history = stats.snapshot('s')!.history!;
    expect(history).toHaveLength(48);
    expect(history[47].turn).toBe(60);
    stats.noteCompaction('s');
    stats.noteCompaction('s');
    expect(stats.snapshot('s')!.compactions).toEqual([60]);
  });
});
