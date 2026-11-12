import { describe, expect, it } from 'vitest';
import { AgentMapStore, mapAgentState } from './AgentMapStore';

describe('AgentMapStore state mapping', () => {
  it('flavours idle by stopReason / error', () => {
    expect(mapAgentState('idle', undefined)).toBe('idle');
    expect(mapAgentState('idle', 'cancelled')).toBe('cancelled');
    expect(mapAgentState('idle', 'error')).toBe('failed');
    expect(mapAgentState('idle', undefined, 'boom')).toBe('failed');
    expect(mapAgentState('running')).toBe('running');
    expect(mapAgentState('requires_action')).toBe('requires_action');
    expect(mapAgentState('unknown')).toBe('unknown');
    expect(mapAgentState('nonsense')).toBe('unknown');
  });

  it('maps an idle+error announcement to failed in the registry', () => {
    const store = new AgentMapStore();
    store.upsert('root', {
      agentId: 'child', parentId: 'root', state: 'idle', stopReason: 'error', error: 'killed',
    });
    const node = store.get('root', 'child')!;
    expect(node.state).toBe('failed');
    expect(node.error).toBe('killed');
  });

  it('maps idle+cancelled to cancelled', () => {
    const store = new AgentMapStore();
    store.upsert('root', { agentId: 'child', parentId: 'root', state: 'idle', stopReason: 'cancelled' });
    expect(store.get('root', 'child')!.state).toBe('cancelled');
  });
});

describe('AgentMapStore merge + usage', () => {
  it('partial meta updates never wipe fields they omit', () => {
    const store = new AgentMapStore();
    store.upsert('root', {
      agentId: 'child', parentId: 'root', title: 'Explorer', state: 'running',
      startedAt: 1000, totalTokens: 42, toolUses: 3, summary: 'reading',
    });
    store.upsert('root', { agentId: 'child', state: 'requires_action' });
    const node = store.get('root', 'child')!;
    expect(node.title).toBe('Explorer');
    expect(node.state).toBe('requires_action');
    expect(node.startedAt).toBe(1000);
    expect(node.totalTokens).toBe(42);
    expect(node.toolUses).toBe(3);
    expect(node.summary).toBe('reading');
  });

  it('noteUsage / noteTool fill context, cost, model and last tool', () => {
    const store = new AgentMapStore();
    store.upsert('root', { agentId: 'child', parentId: 'root', state: 'running' });
    store.noteUsage('root', 'child', { used: 1200, size: 8000, cost: { amount: 0.25 }, model: 'claude-x' });
    store.noteTool('root', 'child', 'Read');
    const node = store.get('root', 'child')!;
    expect(node.contextUsed).toBe(1200);
    expect(node.contextSize).toBe(8000);
    expect(node.costUsd).toBe(0.25);
    expect(node.model).toBe('claude-x');
    expect(node.lastToolName).toBe('Read');
  });

  it('usage that beats the announcement creates a placeholder', () => {
    const store = new AgentMapStore();
    store.noteUsage('root', 'child', { used: 5, size: 10 });
    expect(store.size('root')).toBe(1);
    store.upsert('root', { agentId: 'child', parentId: 'root', title: 'Late', state: 'running' });
    const node = store.get('root', 'child')!;
    expect(node.title).toBe('Late');
    expect(node.contextUsed).toBe(5);
  });
});

describe('AgentMapStore snapshot', () => {
  it('counts running + requires_action only', () => {
    const store = new AgentMapStore();
    store.upsert('root', { agentId: 'a', parentId: 'root', state: 'running' });
    store.upsert('root', { agentId: 'b', parentId: 'root', state: 'requires_action' });
    store.upsert('root', { agentId: 'c', parentId: 'root', state: 'idle' });
    store.upsert('root', { agentId: 'd', parentId: 'root', state: 'failed' });
    expect(store.snapshot('root').running).toBe(2);
  });

  it('nests grandchildren under their parentId', () => {
    const store = new AgentMapStore();
    store.upsert('root', { agentId: 'parent', parentId: 'root', state: 'running', title: 'P' });
    store.upsert('root', { agentId: 'grand', parentId: 'parent', state: 'running', title: 'G' });
    store.upsert('root', { agentId: 'sibling', parentId: 'root', state: 'idle', title: 'S' });
    const snapshot = store.snapshot('root');
    expect(snapshot.agents.map(a => a.agentId).sort()).toEqual(['parent', 'sibling']);
    const parent = snapshot.agents.find(a => a.agentId === 'parent')!;
    expect(parent.children.map(a => a.agentId)).toEqual(['grand']);
  });

  it('returns an empty snapshot and null-ish signature for an unknown session', () => {
    const store = new AgentMapStore();
    expect(store.snapshot('nope')).toEqual({ running: 0, agents: [] });
    expect(store.signature('nope')).toBe('');
  });

  it('totalCostUsd sums every child and stays undefined without a cost', () => {
    const store = new AgentMapStore();
    expect(store.totalCostUsd('root')).toBeUndefined();
    store.upsert('root', { agentId: 'a', parentId: 'root', state: 'running' });
    store.upsert('root', { agentId: 'b', parentId: 'a', state: 'running' });
    expect(store.totalCostUsd('root')).toBeUndefined();
    store.noteUsage('root', 'a', { cost: { amount: 0.25 } });
    store.noteUsage('root', 'b', { cost: { amount: 0.5 } });
    expect(store.totalCostUsd('root')).toBe(0.75);
  });

  it('clear drops the whole bucket', () => {
    const store = new AgentMapStore();
    store.upsert('root', { agentId: 'a', parentId: 'root', state: 'running' });
    store.clear('root');
    expect(store.size('root')).toBe(0);
    expect(store.snapshot('root').agents).toEqual([]);
  });
});

describe('AgentMapStore signature', () => {
  it('is stable for identical data and ignores the activity clock', () => {
    const store = new AgentMapStore();
    const patch = {
      agentId: 'a', parentId: 'root', title: 'T', state: 'running' as const, startedAt: 10,
    };
    store.upsert('root', patch);
    const first = store.signature('root');
    store.upsert('root', patch);
    expect(store.signature('root')).toBe(first);

    store.noteTool('root', 'a', 'Read');
    const withTool = store.signature('root');
    expect(withTool).not.toBe(first);

    store.noteTool('root', 'a', 'Read');
    expect(store.signature('root')).toBe(withTool);

    store.noteUsage('root', 'a', { used: 7, size: 100 });
    expect(store.signature('root')).not.toBe(withTool);
  });

  it('changes when identity fields change', () => {
    const store = new AgentMapStore();
    store.upsert('root', { agentId: 'a', parentId: 'root', state: 'running' });
    const first = store.signature('root');
    store.upsert('root', { agentId: 'a', state: 'requires_action' });
    expect(store.signature('root')).not.toBe(first);
  });
});
