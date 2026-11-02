import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDiskSessions, readTranscriptCompactions, readTranscriptUserAttachments } from './diskSessions';

const roots: string[] = [];

function transcriptDir(lines: Array<Record<string, unknown>>, name = 'session.jsonl'): string {
  const root = mkdtempSync(join(tmpdir(), 'vac-disk-sessions-'));
  roots.push(root);
  writeFileSync(join(root, name), lines.map(line => JSON.stringify(line)).join('\n'));
  return root;
}

function user(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', uuid: `u-${text.length}`, message: { content: [{ type: 'text', text }] }, ...extra };
}

afterEach(() => {
  for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); }
});

describe('disk session titles', () => {
  it('does not use a compact summary as the history title', async () => {
    const dir = transcriptDir([
      user('This session is being continued from a previous conversation that ran out of context.', { isCompactSummary: true }),
      user('the real first prompt'),
    ]);
    const rows = await readDiskSessions(dir);
    expect(rows[0]?.title).toBe('the real first prompt');
  });

  it('skips meta user records and the continuation preamble even without the flag', async () => {
    const dir = transcriptDir([
      user('This session is being continued from a previous conversation that ran out of context.'),
      user('internal note', { isMeta: true }),
    ]);
    const rows = await readDiskSessions(dir);
    expect(rows[0]?.title).toBeUndefined();
  });

  it('still uses the first ordinary prompt as the fallback title', async () => {
    const dir = transcriptDir([user('  a   normal    prompt  ')]);
    const rows = await readDiskSessions(dir);
    expect(rows[0]?.title).toBe('a normal prompt');
  });
});

describe('transcript compaction metadata', () => {
  it('maps a compact boundary to the summary uuid and its facts', async () => {
    const dir = transcriptDir([
      {
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'auto', preTokens: 176200, preservedSegment: { anchorUuid: 'summary-1' } },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'manual', preTokens: 1000, preservedMessages: { anchorUuid: 'summary-2' } },
      },
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } },
    ], 'compaction.jsonl');

    const map = await readTranscriptCompactions(dir, 'compaction');
    expect(map.get('summary-1')).toEqual({ trigger: 'auto', preTokens: 176200 });
    expect(map.get('summary-2')).toEqual({ trigger: 'manual', preTokens: 1000 });
    expect(map.size).toBe(2);
  });

  it('marks string-content compact summaries in the user-parts map', async () => {
    const dir = transcriptDir([
      {
        type: 'user',
        uuid: 'summary-1',
        isCompactSummary: true,
        message: { content: 'This session is being continued from a previous conversation that ran out of context.' },
      },
      { type: 'user', uuid: 'prompt-1', message: { content: [{ type: 'text', text: 'hello' }] } },
    ], 'parts.jsonl');

    const parts = await readTranscriptUserAttachments(dir, 'parts');
    expect(parts.get('summary-1')).toMatchObject({ compactSummary: true, hasProse: true });
    expect(parts.get('prompt-1')).toMatchObject({ compactSummary: false, hasProse: true });
  });
});
