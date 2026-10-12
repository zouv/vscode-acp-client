import { describe, expect, it } from 'vitest';
import { buildDashboardValues, EMPTY_SNAPSHOT, snapshotMessage } from './DashboardModel';

describe('DashboardModel', () => {
  it('exposes a zeroed snapshot for the disabled state', () => {
    expect(EMPTY_SNAPSHOT.hasData).toBe(false);
    expect(EMPTY_SNAPSHOT.periods.all.tokens).toBe(0);
    expect(EMPTY_SNAPSHOT.daily).toEqual([]);
    expect(EMPTY_SNAPSHOT.sources).toEqual([]);
  });

  it('passes usage, connections and sessions through to the webview message', () => {
    const values = buildDashboardValues(EMPTY_SNAPSHOT, [{ name: 'Claude Code', connected: true, sessions: 2 }], [
      { agentName: 'Claude Code', sessionId: 's1', title: 't', cwd: '/p', lastActiveAt: '2026-10-12T00:00:00.000Z' },
    ]);
    const msg = snapshotMessage(values);
    expect(msg.type).toBe('snapshot');
    expect(msg.usage).toBe(EMPTY_SNAPSHOT);
    expect(msg.connections[0].name).toBe('Claude Code');
    expect(msg.sessions[0].sessionId).toBe('s1');
    expect(msg.notice).toBeUndefined();
    expect(snapshotMessage(values, 'off').notice).toBe('off');
  });

  it('serialises to JSON without cycles or undefined holes', () => {
    const msg = snapshotMessage(buildDashboardValues(EMPTY_SNAPSHOT, [], []));
    expect(() => JSON.stringify(msg)).not.toThrow();
    expect(JSON.parse(JSON.stringify(msg)).usage.periods.today.cost).toBe(0);
  });
});
