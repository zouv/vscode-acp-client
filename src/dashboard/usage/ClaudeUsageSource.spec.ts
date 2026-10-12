import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeUsageSource } from './ClaudeUsageSource';
import { emptySourceState } from './types';

const NEWLINE = String.fromCharCode(10);

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-claude-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function assistantLine(opts: {
  id: string;
  ts?: string;
  model?: string;
  cwd?: string;
  sessionId?: string;
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
  requestId?: string;
  sidechain?: boolean;
}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: opts.sidechain ?? false,
    type: 'assistant',
    uuid: 'u-' + opts.id,
    sessionId: opts.sessionId ?? 'sess-1',
    cwd: opts.cwd ?? '/home/u/proj',
    requestId: opts.requestId,
    timestamp: opts.ts ?? '2026-10-12T05:06:07.510Z',
    message: {
      id: opts.id,
      type: 'message',
      role: 'assistant',
      model: opts.model ?? 'claude-sonnet-5.5',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: opts.input ?? 2,
        output_tokens: opts.output ?? 10,
        cache_creation_input_tokens: opts.cacheCreate ?? 100,
        cache_read_input_tokens: opts.cacheRead ?? 50,
        service_tier: 'standard',
      },
    },
  });
}

describe('ClaudeUsageSource', () => {
  it('extracts assistant usage with project and session fallbacks', async () => {
    write(
      'D--proj/sess-1.jsonl',
      [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-12T05:06:03.137Z' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, timestamp: '2026-10-12T05:06:03.173Z' }),
        assistantLine({ id: 'msg_a', cwd: '/home/u/proj', sessionId: 'sess-1' }),
      ].join('\n') + '\n',
    );
    const src = new ClaudeUsageSource(root);
    const res = await src.scan(emptySourceState());
    expect(res.events).toHaveLength(1);
    const e = res.events[0];
    expect(e.agent).toBe('claude');
    expect(e.model).toBe('claude-sonnet-5.5');
    expect(e.project).toBe('/home/u/proj');
    expect(e.sessionId).toBe('sess-1');
    expect(e.input).toBe(2);
    expect(e.output).toBe(10);
    expect(e.cacheCreate).toBe(100);
    expect(e.cacheRead).toBe(50);
    expect(e.ts).toBe(Date.parse('2026-10-12T05:06:07.510Z'));
    expect(e.key).toContain('msg_a');
  });

  it('keeps the last usage for a streaming message id', async () => {
    write(
      'p/s.jsonl',
      [
        assistantLine({ id: 'msg_a', output: 5 }),
        assistantLine({ id: 'msg_a', output: 120 }),
        assistantLine({ id: 'msg_b', output: 7 }),
      ].join('\n') + '\n',
    );
    const res = await new ClaudeUsageSource(root).scan(emptySourceState());
    expect(res.events).toHaveLength(2);
    const a = res.events.find((e) => e.key.includes('msg_a'));
    expect(a?.output).toBe(120);
  });

  it('separates events that share a message id but differ by requestId', async () => {
    write('p/s.jsonl', [assistantLine({ id: 'msg_a', requestId: 'r1', output: 5 }), assistantLine({ id: 'msg_a', requestId: 'r2', output: 9 })].join('\n') + '\n');
    const res = await new ClaudeUsageSource(root).scan(emptySourceState());
    expect(res.events).toHaveLength(2);
  });

  it('holds back a partial trailing line and reads it after append', async () => {
    const firstLine = assistantLine({ id: 'msg_a' }) + '\n';
    const partial = assistantLine({ id: 'msg_b', output: 42 });
    const file = write('p/s.jsonl', firstLine + partial.slice(0, 60));
    const src = new ClaudeUsageSource(root);
    const first = await src.scan(emptySourceState());
    expect(first.events.map((e) => e.key)).toHaveLength(1);
    expect(first.state.files[file].offset).toBe(firstLine.length);

    fs.appendFileSync(file, partial.slice(60) + '\n' + assistantLine({ id: 'msg_c', output: 3 }) + '\n');
    const second = await src.scan(first.state);
    expect(second.events.map((e) => e.key.includes('msg_b'))).toEqual([true, false]);
    expect(second.events.find((e) => e.key.includes('msg_b'))?.output).toBe(42);
    expect(second.state.files[file].offset).toBe(fs.statSync(file).size);
  });

  it('only reads appended bytes on an unchanged file', async () => {
    const file = write('p/s.jsonl', assistantLine({ id: 'msg_a' }) + '\n');
    const src = new ClaudeUsageSource(root);
    const first = await src.scan(emptySourceState());
    const unchanged = await src.scan(first.state);
    expect(unchanged.events).toHaveLength(0);

    fs.appendFileSync(file, assistantLine({ id: 'msg_b' }) + '\n');
    const second = await src.scan(first.state);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].key).toContain('msg_b');
    expect(second.state.files[file].offset).toBe(fs.statSync(file).size);
  });

  it('rescans from zero when a file is truncated or replaced', async () => {
    const file = write('p/s.jsonl', assistantLine({ id: 'msg_a' }) + '\n' + assistantLine({ id: 'msg_b' }) + '\n');
    const src = new ClaudeUsageSource(root);
    const first = await src.scan(emptySourceState());
    expect(first.events).toHaveLength(2);

    const short = assistantLine({ id: 'msg_c' }) + '\n';
    fs.writeFileSync(file, short);
    const second = await src.scan(first.state);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].key).toContain('msg_c');

    const replaced = assistantLine({ id: 'msg_d' }).replace('"output_tokens":10', '"output_tokens":11') + NEWLINE;
    fs.writeFileSync(file, replaced);
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(file, past, past);
    const third = await src.scan(second.state);
    expect(third.events.map((e) => e.key).filter((k) => k.includes('msg_d'))).toHaveLength(1);
  });

  it('skips malformed lines, non-usage records and synthetic models', async () => {
    const synthetic = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-12T05:06:07.510Z',
      message: { id: 'msg_syn', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    });
    write(
      'p/s.jsonl',
      [
        '',
        'not json at all',
        '{"type":"assistant"}',
        JSON.stringify({ type: 'assistant', message: { id: 'msg_x', model: 'claude-sonnet-5.5', usage: { input_tokens: 0, output_tokens: 0 } }, timestamp: '2026-10-12T05:06:07.510Z' }),
        synthetic,
        assistantLine({ id: 'msg_ok' }),
        '{"truncated":',
      ].join('\n') + '\n',
    );
    const res = await new ClaudeUsageSource(root).scan(emptySourceState());
    expect(res.events).toHaveLength(1);
    expect(res.events[0].key).toContain('msg_ok');
  });

  it('falls back to the project directory name when cwd is absent', async () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-9',
      timestamp: '2026-10-12T05:06:07.510Z',
      message: { id: 'msg_n', model: 'claude-sonnet-5.5', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    write('D--my-proj/sess-9.jsonl', line + '\n');
    const res = await new ClaudeUsageSource(root).scan(emptySourceState());
    expect(res.events[0].project).toBe('D--my-proj');
    expect(res.events[0].sessionId).toBe('sess-9');
  });

  it('tolerates a missing root directory', async () => {
    const res = await new ClaudeUsageSource(path.join(root, 'nope')).scan(emptySourceState());
    expect(res.events).toHaveLength(0);
    expect(res.state.files).toEqual({});
  });
});
