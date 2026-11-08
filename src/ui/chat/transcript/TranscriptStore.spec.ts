import { describe, expect, it } from 'vitest';
import { TranscriptStore } from './TranscriptStore';

function store(): TranscriptStore {
  return new TranscriptStore(() => undefined);
}

describe('prose merge isolation by sub-agent origin', () => {
  it('does not fuse chunks from different origins into one bubble', () => {
    const transcripts = store();
    transcripts.ensureSession('parent', 'Claude Code');
    const parentEntry = transcripts.appendAssistantChunk('parent', 'parent says ', undefined);
    expect(parentEntry).not.toBeNull();

    // Child chunk must open its own entry even though the parent bubble is open.
    const childEntry = transcripts.appendAssistantChunk('parent', 'child says ', undefined, 'child-1');
    expect(childEntry).not.toBe(parentEntry);
    expect(childEntry?.origin).toBe('child-1');
    expect(parentEntry?.text).toBe('parent says ');

    // A later parent chunk goes back to its own entry only if it is still the last
    // open one; here the child entry is last, so it opens a new parent bubble
    // instead of merging into the child's text.
    const parentAgain = transcripts.appendAssistantChunk('parent', 'more', undefined);
    expect(parentAgain).not.toBe(childEntry);
    expect(childEntry?.text).toBe('child says ');
    expect(parentAgain?.text).toBe('more');
  });

  it('still merges consecutive chunks from the same origin', () => {
    const transcripts = store();
    transcripts.ensureSession('parent', 'Claude Code');
    const first = transcripts.appendAssistantChunk('parent', 'a', undefined, 'child-1');
    const second = transcripts.appendAssistantChunk('parent', 'b', undefined, 'child-1');
    expect(second).toBe(first);
    expect(first?.text).toBe('ab');
  });

  it('keeps thoughts isolated the same way', () => {
    const transcripts = store();
    transcripts.ensureSession('parent', 'Claude Code');
    const parentThought = transcripts.appendThoughtChunk('parent', 'plan', undefined);
    const childThought = transcripts.appendThoughtChunk('parent', 'explore', undefined, 'child-1');
    expect(childThought).not.toBe(parentThought);
    expect(parentThought?.text).toBe('plan');
    expect(childThought?.origin).toBe('child-1');
  });
});
