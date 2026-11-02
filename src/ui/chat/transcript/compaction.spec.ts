import { describe, expect, it } from 'vitest';
import type { CompactionUpdate } from '@agentclientprotocol/sdk';
import {
  compactSummaryBody,
  compactionError,
  compactionSummaryField,
  compactionText,
  isCompactSummaryText,
  isTerminalCompaction,
} from './compaction';

function update(patch: Partial<CompactionUpdate>): CompactionUpdate {
  return { compactionId: 'c1', status: 'completed', ...patch };
}

describe('compaction summary semantics', () => {
  it('distinguishes an omitted summary from an explicit clear', () => {
    expect(compactionSummaryField(undefined)).toEqual({ provided: false, text: '' });
    expect(compactionSummaryField(null)).toEqual({ provided: true, text: '' });
    expect(compactionSummaryField([])).toEqual({ provided: true, text: '' });
  });

  it('joins text blocks and ignores non-text blocks', () => {
    expect(compactionSummaryField([
      { type: 'text', text: 'a' },
      { type: 'image', data: '', mimeType: 'image/png' },
      { type: 'text', text: 'b' },
    ])).toEqual({ provided: true, text: 'a\nb' });
  });

  it('uses the summary when provided, otherwise the accumulated chunks', () => {
    expect(compactionText(update({ summary: [{ type: 'text', text: 'clean' }] }), 'raw')).toBe('clean');
    expect(compactionText(update({}), 'raw')).toBe('raw');
    expect(compactionText(update({ summary: [] }), 'stale')).toBe('');
  });
});

describe('compaction terminal state', () => {
  it('only completed / failed / cancelled are terminal', () => {
    expect(isTerminalCompaction('completed')).toBe(true);
    expect(isTerminalCompaction('failed')).toBe(true);
    expect(isTerminalCompaction('cancelled')).toBe(true);
    expect(isTerminalCompaction('in_progress')).toBe(false);
    expect(isTerminalCompaction(undefined)).toBe(false);
  });

  it('turns failure details into a readable message', () => {
    expect(compactionError(update({ status: 'failed', error: 'out of room' }))).toBe('Compaction failed: out of room');
    expect(compactionError(update({ status: 'failed' }))).toBe('Compaction failed.');
    expect(compactionError(update({ status: 'cancelled' }))).toBe('Compaction cancelled.');
    expect(compactionError(update({ status: 'completed', error: 'stale' }))).toBeUndefined();
  });
});

describe('compact summary framing', () => {
  it('recognizes the continuation preamble', () => {
    expect(isCompactSummaryText('This session is being continued from a previous conversation that ran out of context.')).toBe(true);
    expect(isCompactSummaryText('  this SESSION is being continued from a previous conversation')).toBe(true);
    expect(isCompactSummaryText('a normal user message')).toBe(false);
  });

  it('strips the persisted preamble and trailers', () => {
    const raw = [
      'This session is being continued from a previous conversation that ran out of context.',
      '',
      'Summary:',
      '1. Primary Request: build a storybook.',
      '',
      'If you need specific details from before compaction, use the tools.',
    ].join('\n');
    expect(compactSummaryBody(raw)).toBe('1. Primary Request: build a storybook.');
  });

  it('returns the text unchanged when the framing is not recognized', () => {
    expect(compactSummaryBody('plain summary text')).toBe('plain summary text');
  });
});
