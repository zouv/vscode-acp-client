import { describe, expect, it } from 'vitest';

import { PendingSessionState, SessionStore } from './SessionStore';
import type { SessionInfo } from './types';

const session = (sessionId: string, agentName = 'Claude Code'): SessionInfo => ({
  sessionId,
  agentId: `agent-for-${agentName}`,
  agentName,
  agentDisplayName: agentName,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  initResponse: {} as SessionInfo['initResponse'],
  modes: null,
  models: null,
  configOptions: null,
  availableCommands: [],
});

describe('SessionStore', () => {
  it('indexes sessions by agent, keeping creation order', () => {
    const store = new SessionStore();
    store.add(session('s1'));
    store.add(session('s2'));
    store.add(session('o1', 'Codex CLI'));
    expect(store.idsForAgent('Claude Code')).toEqual(['s1', 's2']);
    expect(store.idsForAgent('Codex CLI')).toEqual(['o1']);
    expect(store.agentNames().sort()).toEqual(['Claude Code', 'Codex CLI']);
  });

  it('focuses only known sessions and reports whether anything changed', () => {
    const store = new SessionStore();
    store.add(session('s1'));
    expect(store.focus('missing')).toBe(false);
    expect(store.focusedId).toBeNull();
    expect(store.focus('s1')).toBe(true);
    expect(store.focus('s1')).toBe(false);
    expect(store.focus('s1', true)).toBe(true);
  });

  it('picks the most recently focused live session as successor', () => {
    const store = new SessionStore();
    store.add(session('s1'));
    store.add(session('s2'));
    store.add(session('s3'));
    store.focus('s1');
    store.focus('s3');
    store.focus('s2');
    expect(store.mostRecentLiveId()).toBe('s2');
    store.remove('s2');
    expect(store.mostRecentLiveId()).toBe('s3');
    store.remove('s3');
    expect(store.mostRecentLiveId()).toBe('s1');
  });

  it('drops the agent bucket when its last session goes away', () => {
    const store = new SessionStore();
    store.add(session('s1'));
    store.remove('s1');
    expect(store.hasAgent('Claude Code')).toBe(false);
    expect(store.idsForAgent('Claude Code')).toEqual([]);
  });

  it('clears focus when the focused session is removed', () => {
    const store = new SessionStore();
    store.add(session('s1'));
    store.focus('s1');
    store.remove('s1');
    expect(store.focusedId).toBeNull();
  });

  it('returns null when nothing is live', () => {
    expect(new SessionStore().mostRecentLiveId()).toBeNull();
  });
});

describe('PendingSessionState', () => {
  it('drains buffered commands, config options and title onto the session', () => {
    const pending = new PendingSessionState();
    const target = session('s1');
    pending.setCommands('s1', [{ name: 'review', description: 'review' }] as never);
    pending.setConfig('s1', [{ id: 'model', currentValue: 'opus' }] as never);
    pending.setTitle('s1', 'A title');

    pending.drainInto(target);
    expect(target.availableCommands).toHaveLength(1);
    expect(target.configOptions).toMatchObject([{ id: 'model' }]);
    expect(target.title).toBe('A title');

    // drained state is consumed once; a second session must not inherit it
    const other = session('s2');
    pending.drainInto(other);
    expect(other.availableCommands).toEqual([]);
    expect(other.configOptions).toBeNull();
    expect(other.title).toBeUndefined();
  });

  it('leaves fields alone when nothing was buffered', () => {
    const target = session('s1');
    new PendingSessionState().drainInto(target);
    expect(target.configOptions).toBeNull();
    expect(target.title).toBeUndefined();
  });

  it('drains a buffered mode onto the session when the agent reported modes', () => {
    const pending = new PendingSessionState();
    const target = session('s1');
    target.modes = {
      currentModeId: 'ask',
      availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }],
    };
    pending.setMode('s1', 'code');

    pending.drainInto(target);
    expect(target.modes?.currentModeId).toBe('code');
  });

  it('drops a buffered mode when the session has no modes at all', () => {
    const pending = new PendingSessionState();
    const target = session('s1');
    pending.setMode('s1', 'code');

    pending.drainInto(target);
    expect(target.modes).toBeNull();
  });
});
