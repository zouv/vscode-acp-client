import { describe, expect, it } from 'vitest';
import { CodexLineParser, CodexUsageSource, defaultCodexSessionsDir } from './CodexUsageSource';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emptySourceState } from './types';

function uuid7(ms: number): string {
  const hex = ms.toString(16).padStart(12, '0');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-7000-8000-000000000000';
}

const BASE = Date.parse('2026-08-19T14:06:47.789Z');

function meta(forkedFrom?: string): string {
  return JSON.stringify({
    timestamp: '2026-08-19T14:06:48.487Z',
    ordinal: 0,
    type: 'session_meta',
    payload: {
      session_id: 'sess-a',
      id: 'sess-a',
      forked_from_id: forkedFrom,
      timestamp: '2026-08-19T14:06:47.789Z',
      cwd: 'F:\\work\\demo',
      cli_version: '0.148.0-alpha.9',
      source: 'vscode',
    },
  });
}

function turnContext(turnId: string, model = 'gpt-5.6-sol'): string {
  return JSON.stringify({
    timestamp: '2026-08-19T14:06:48.488Z',
    ordinal: 5,
    type: 'turn_context',
    payload: { turn_id: turnId, cwd: 'F:\\work\\demo', model, approval_policy: 'never' },
  });
}

function tokenCount(ordinal: number, last: { input: number; cached: number; written: number; output: number }, total?: { input: number; cached: number; output: number; total: number }): string {
  return JSON.stringify({
    timestamp: '2026-08-19T14:06:48.489Z',
    ordinal,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: total ?? {
          input_tokens: last.input,
          cached_input_tokens: last.cached,
          cache_write_input_tokens: last.written,
          output_tokens: last.output,
          reasoning_output_tokens: 66,
          total_tokens: last.input + last.output,
        },
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached,
          cache_write_input_tokens: last.written,
          output_tokens: last.output,
          reasoning_output_tokens: 66,
          total_tokens: last.input + last.output,
        },
        model_context_window: 997500,
      },
      rate_limits: { limit_id: 'codex', plan_type: null },
    },
  });
}

function tokenCountNullInfo(ordinal: number): string {
  return JSON.stringify({
    timestamp: '2026-08-19T14:06:48.490Z',
    ordinal,
    type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex' } },
  });
}

const TURN = uuid7(BASE + 5000);

describe('CodexUsageSource', () => {
  it('emits per-turn deltas, skipping the first baseline sample', async () => {
    const parser = new CodexLineParser('fallback');
    const lines = [
      meta(),
      tokenCountNullInfo(14),
      turnContext(TURN),
      tokenCount(14, { input: 15415, cached: 0, written: 15372, output: 229 }),
      tokenCount(18, { input: 15415, cached: 0, written: 15372, output: 229 }),
      tokenCount(24, { input: 21954, cached: 15372, written: 6539, output: 4495 }),
    ];
    for (const [i, l] of lines.entries()) {
      parser.onLine(Buffer.from(l), i * 100);
    }
    const { events } = parser.finish();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ agent: 'codex', model: 'gpt-5.6-sol', project: 'F:\\work\\demo', sessionId: 'sess-a', cacheRead: 0, cacheCreate: 15372, output: 229 });
    expect(events[0].input).toBe(43);
    expect(events[1]).toMatchObject({ cacheRead: 15372, cacheCreate: 6539, output: 4495 });
    expect(events[1].input).toBe(43);
    expect(events[0].key).toBe('x|sess-a|n14');
    expect(events[1].key).toBe('x|sess-a|n24');
  });

  it('skips replayed turns inherited from a forked session', async () => {
    const parser = new CodexLineParser('fallback');
    const replayed = uuid7(BASE - 60000);
    const fresh = uuid7(BASE + 60000);
    const lines = [
      meta('01a0123d-cc80-7b03-a5c6-640c426489dd'),
      turnContext(replayed),
      tokenCount(14, { input: 100, cached: 0, written: 0, output: 10 }),
      tokenCount(24, { input: 200, cached: 0, written: 0, output: 20 }),
      turnContext(fresh),
      tokenCount(34, { input: 300, cached: 0, written: 0, output: 30 }),
    ];
    for (const [i, l] of lines.entries()) {
      parser.onLine(Buffer.from(l), i * 100);
    }
    const { events } = parser.finish();
    expect(events).toHaveLength(1);
    expect(events[0].output).toBe(30);
  });

  it('carries model and cwd in the cursor across incremental scans', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-codex-'));
    try {
      const file = path.join(root, '2026', '08', '19', 'rollout-2026-08-19T22-06-47-abc.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, [meta(), turnContext(TURN), tokenCount(14, { input: 100, cached: 0, written: 0, output: 10 }), tokenCount(24, { input: 100, cached: 0, written: 0, output: 99 })].join('\n') + '\n');
      const src = new CodexUsageSource(root);
      const first = await src.scan(emptySourceState());
      expect(first.events.map((e) => e.output)).toEqual([10, 99]);
      expect(first.state.files[file].extra).toMatchObject({ model: 'gpt-5.6-sol', sessionId: 'sess-a' });

      fs.appendFileSync(file, tokenCount(34, { input: 400, cached: 0, written: 0, output: 40 }) + '\n');
      const second = await src.scan(first.state);
      expect(second.events).toHaveLength(1);
      expect(second.events[0]).toMatchObject({ model: 'gpt-5.6-sol', project: 'F:\\work\\demo', output: 40 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns nothing for a missing sessions directory', async () => {
    const res = await new CodexUsageSource(path.join(os.tmpdir(), 'vac-codex-missing-' + Date.now())).scan(emptySourceState());
    expect(res.events).toEqual([]);
    expect(res.state.files).toEqual({});
  });

  it('ignores malformed lines and unrelated records', async () => {
    const parser = new CodexLineParser('fallback');
    const lines = ['', 'not json', '{"type":"event_msg","payload":{"type":"token_count","info":null}}', JSON.stringify({ timestamp: 'x', ordinal: 1, type: 'response_item', payload: { type: 'message' } }), tokenCount(14, { input: 5, cached: 0, written: 0, output: 5 }), tokenCount(24, { input: 5, cached: 0, written: 0, output: 7 })];
    for (const [i, l] of lines.entries()) {
      parser.onLine(Buffer.from(l), i * 10);
    }
    const { events } = parser.finish();
    expect(events).toHaveLength(2);
    expect(events[0].model).toBe('unknown');
    expect(events[0].project).toBe('');
    expect(events[1].model).toBe('unknown');
  });
});

describe('defaultCodexSessionsDir', () => {
  it('honours CODEX_HOME and falls back to ~/.codex', () => {
    expect(defaultCodexSessionsDir({ CODEX_HOME: path.join('x', 'codex') })).toBe(path.join('x', 'codex', 'sessions'));
    expect(defaultCodexSessionsDir({})).toBe(path.join(os.homedir(), '.codex', 'sessions'));
  });
});
