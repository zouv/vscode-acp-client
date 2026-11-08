import { describe, expect, it } from 'vitest';
import type { ToolInvocation } from '../transcript/types';
import { ClaudeCodeNesting, nestingInputsOf } from './ClaudeCodeNesting';

function call(id: string, title: string, startedAt: number, endedAt?: number, extra: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    toolCallId: id, title, kind: 'execute', status: endedAt === undefined ? 'in_progress' : 'completed',
    content: [], locations: [], rawInput: {}, rawOutput: undefined, startedAt, endedAt, ...extra,
  } as ToolInvocation;
}

describe('ClaudeCodeNesting gating', () => {
  const nesting = new ClaudeCodeNesting();

  it('skips the pass outright when no task-like call exists', () => {
    const all = [call('a', 'Bash ls', 0, 10), call('b', 'Read x', 1, 5)];
    expect(nesting.apply(all)).toEqual([]);
    expect(all.every(inv => inv.parentId === undefined)).toBe(true);
  });

  it('still clears a stale link once the parent is gone', () => {
    const child = call('b', 'Read x', 1, 5, { parentId: 'gone', inferredParent: true });
    expect(nesting.apply([call('a', 'Bash ls', 0, 10), child])).toEqual(['b']);
    expect(child.parentId).toBeUndefined();
  });

  it('links a contained child under the innermost task (candidates are tasks only)', () => {
    const task = call('t', 'Task explore', 0, 1000);
    const inner = call('u', 'Task nested', 100, 900);
    const child = call('c', 'Read x', 200, 300);
    expect(nesting.apply([task, inner, child]).sort()).toEqual(['c', 'u']);
    expect(child.parentId).toBe('u');
    expect(inner.parentId).toBe('t');
    expect(child.inferredParent).toBe(true);
  });

  it('prefers an explicit mention in the task output (memoised per payload)', () => {
    const output = { log: 'spawned c and d' };
    const task = call('t', 'Task explore', 0, 1000, { rawOutput: output });
    const other = call('o', 'Task other', 100, 900);
    const child = call('c', 'Read x', 200, 300);
    nesting.apply([task, other, child]);
    expect(child.parentId).toBe('t');
    expect(child.inferredParent).toBe(false);
    nesting.apply([task, other, child]);
    expect(child.parentId).toBe('t');
  });

  it('needsPass: a content-only update with nothing open cannot move a link', () => {
    const task = call('t', 'Task explore', 0, 1000);
    const child = call('c', 'Bash ls', 200, 300);
    const all = [task, child];
    nesting.apply(all);
    const prior = nestingInputsOf(child);
    child.content = [{ type: 'content', content: { type: 'text', text: 'more output' } }];
    expect(nesting.needsPass(prior, child, all)).toBe(false);
  });

  it('needsPass: status / timing / payload identity changes always re-run', () => {
    const child = call('c', 'Bash ls', 200);
    const all = [call('t', 'Task explore', 0, 1000), child];
    let prior = nestingInputsOf(child);
    child.endedAt = 400; child.status = 'completed';
    expect(nesting.needsPass(prior, child, all)).toBe(true);
    prior = nestingInputsOf(child);
    child.rawOutput = { replaced: true };
    expect(nesting.needsPass(prior, child, all)).toBe(true);
    expect(nesting.needsPass(undefined, child, all)).toBe(true);
  });

  it('needsPass: an open task or an open linked child keeps the time-dependent pass alive', () => {
    const runningTask = call('t', 'Task explore', 0);
    const child = call('c', 'Bash ls', 200, 300);
    expect(nesting.needsPass(nestingInputsOf(child), child, [runningTask, child])).toBe(true);
    const linked = call('d', 'Bash watch', 200, undefined, { parentId: 'x' });
    const ended = call('x', 'Task done', 0, 1000);
    expect(nesting.needsPass(nestingInputsOf(linked), linked, [ended, linked])).toBe(true);
  });
});
