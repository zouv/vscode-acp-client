import { describe, expect, it } from 'vitest';
import { TranscriptStore } from './TranscriptStore';
import { ToolInvocationStore } from './ToolInvocationStore';
import { toToolCallView } from '../content/toolCalls';
import { toContentView } from '../content/contentBlocks';

function stores() {
  const tools = new ToolInvocationStore();
  const transcripts = new TranscriptStore((sessionId, entries) => {
    for (const entry of entries) {
      if (entry.kind === 'tool' && !transcripts.snapshot(sessionId)?.entries.some(row => row.kind === 'tool' && row.toolCallId === entry.toolCallId)) {
        tools.remove(sessionId, entry.toolCallId);
      }
    }
  });
  const add = (sessionId: string, id: string) => {
    tools.upsertCall(sessionId, { toolCallId: id, title: id, content: [], rawOutput: 'result' });
    transcripts.appendTool(sessionId, id);
  };
  return { tools, transcripts, add };
}

describe('reference-driven tool collection', () => {
  it('safely renders partial blocks after a nested payload exceeds the budget', () => {
    const tools = new ToolInvocationStore();
    const inv = tools.upsertCall('s', { toolCallId: 't', title: 'tool', content: [{ type: 'content', content: { type: 'resource', resource: { uri: 'file:///a', text: 'x'.repeat(200000) } } }] });
    expect(() => toToolCallView(inv)).not.toThrow();
    expect(toContentView({ type: 'resource' } as never)).toBeNull();
    expect(toContentView({ type: 'resource_link' } as never)).toBeNull();
    expect(toContentView({ type: 'text' } as never)).toBeNull();
  });
  it('keeps explicit collection replacement when earlier fields consume the budget', () => {
    const tools = new ToolInvocationStore();
    tools.upsertCall('s', { toolCallId: 't', title: 'tool', content: [{ type: 'content', content: { type: 'text', text: 'old' } }] });
    const inv = tools.upsertUpdate('s', { toolCallId: 't', rawOutput: Array(128).fill('x'.repeat(32768)), content: [{ type: 'content', content: { type: 'resource', resource: { uri: 'file:///b', text: 'new' } } }] });
    expect(inv?.content).toEqual([]);
    expect(() => toToolCallView(inv!)).not.toThrow();
  });
  it('reclaims evicted tools, including eviction caused by non-tool messages', () => {
    const { tools, transcripts, add } = stores();
    transcripts.ensureSession('s', 'agent');
    transcripts.setLiveSessionIds(['s']);
    for (let i = 0; i < 650; i++) { add('s', 't' + i); }
    expect(tools.list('s')).toHaveLength(500);
    expect(tools.get('s', 't0')).toBeUndefined();
    expect(tools.get('s', 't649')?.rawOutput).toBe('result');
    for (let i = 0; i < 500; i++) { transcripts.appendUser('s', 'next'); }
    expect(tools.list('s')).toHaveLength(0);
  });
  it('preserves duplicate references and releases LRU-evicted sessions', () => {
    const { tools, transcripts, add } = stores();
    transcripts.ensureSession('s', 'agent');
    add('s', 'same');
    add('s', 'same');
    for (let i = 0; i < 499; i++) { transcripts.appendUser('s', 'next'); }
    expect(tools.get('s', 'same')).toBeDefined();
    for (let i = 0; i < 25; i++) { transcripts.ensureSession('s' + i, 'agent'); add('s' + i, 't'); }
    expect(tools.list('s')).toHaveLength(0);
    transcripts.dropAgent('agent');
    expect(tools.list('s24')).toHaveLength(0);
  });
  it('retains bounded payloads while keeping tool identity and replace semantics', () => {
    const tools = new ToolInvocationStore();
    tools.upsertCall('s', { toolCallId: 't', title: 'tool', rawInput: { text: 'x'.repeat(1000000) }, content: [] });
    expect(JSON.stringify(tools.get('s', 't')).length).toBeLessThan(140000);
    tools.upsertUpdate('s', { toolCallId: 't', content: [{ type: 'content', content: { type: 'text', text: 'new' } }] });
    expect(tools.get('s', 't')?.content).toEqual([{ type: 'content', content: { type: 'text', text: 'new' } }]);
    tools.upsertUpdate('s', { toolCallId: 't', content: [] });
    expect(tools.get('s', 't')?.content).toEqual([]);
  });
});
