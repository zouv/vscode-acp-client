import { describe, expect, it } from 'vitest';
import { Outbox } from './Outbox';
import type { ExtToChatMessage } from './protocol';

function outbox() {
  const sent: ExtToChatMessage[] = [];
  const box = new Outbox({ send: m => sent.push(m), log: () => {}, flushMs: 1_000_000 });
  return { box, sent };
}

const tool = (status: string) => ({ toolCallId: 't', title: 'T', kind: 'execute', status }) as never;

describe('Outbox coalescing', () => {
  it('concatenates contiguous text deltas for the same entry', () => {
    const { box, sent } = outbox();
    box.enqueue({ type: 'appendText', sessionId: 's', entryId: 'e', offset: 5, text: 'ab' });
    box.enqueue({ type: 'appendText', sessionId: 's', entryId: 'e', offset: 7, text: 'cd' });
    box.flush();
    expect(sent).toEqual([{ type: 'appendText', sessionId: 's', entryId: 'e', offset: 5, text: 'abcd' }]);
    expect(box.stats().merged).toBe(1);
  });

  it('keeps non-contiguous or foreign deltas separate', () => {
    const { box, sent } = outbox();
    box.enqueue({ type: 'appendText', sessionId: 's', entryId: 'e', offset: 0, text: 'ab' });
    box.enqueue({ type: 'appendText', sessionId: 's', entryId: 'e', offset: 9, text: 'zz' });
    box.enqueue({ type: 'appendText', sessionId: 's', entryId: 'f', offset: 11, text: 'yy' });
    box.enqueue({ type: 'appendText', sessionId: 'other', entryId: 'f', offset: 13, text: 'xx' });
    box.flush();
    expect(sent).toHaveLength(4);
  });

  it('drops a delta already contained in the queued live append', () => {
    const { box, sent } = outbox();
    const entry = { id: 'e', kind: 'assistant', at: 0, text: 'hello', streaming: true } as never as { text: string };
    box.enqueue({ type: 'append', sessionId: 's', entries: [entry as never] });
    entry.text += ' world';
    box.enqueue({ type: 'appendText', sessionId: 's', entryId: 'e', offset: 5, text: ' world' });
    box.enqueue({ type: 'appendText', sessionId: 's', entryId: 'e', offset: 11, text: '!' });
    box.flush();
    expect(sent.map(m => m.type)).toEqual(['append', 'appendText']);
    expect(sent[1]).toMatchObject({ offset: 11, text: '!' });
  });

  it('tool updates are last-wins per entry and never overtake the append', () => {
    const { box, sent } = outbox();
    box.enqueue({ type: 'append', sessionId: 's', entries: [{ id: 'e', kind: 'tool', at: 0, toolCallId: 't' } as never] });
    box.enqueue({ type: 'toolUpdate', sessionId: 's', entryId: 'e', tool: tool('pending') });
    box.enqueue({ type: 'revise', sessionId: 's', entryId: 'x', patch: { streaming: false } });
    box.enqueue({ type: 'toolUpdate', sessionId: 's', entryId: 'other', tool: tool('pending') });
    box.enqueue({ type: 'toolUpdate', sessionId: 's', entryId: 'e', tool: tool('in_progress') });
    box.enqueue({ type: 'toolUpdate', sessionId: 's', entryId: 'e', tool: tool('completed') });
    box.flush();
    expect(sent.map(m => m.type === 'toolUpdate' ? `tool:${m.entryId}:${(m.tool as { status: string }).status}` : m.type))
      .toEqual(['append', 'revise', 'tool:other:pending', 'tool:e:completed']);
  });

  it('keeps the original single-append merge rule', () => {
    const { box, sent } = outbox();
    const a = { id: 'e', kind: 'assistant', at: 0, text: 'a' } as never;
    box.enqueue({ type: 'append', sessionId: 's', entries: [a] });
    box.enqueue({ type: 'append', sessionId: 's', entries: [a] });
    box.flush();
    expect(sent).toHaveLength(1);
  });
});
