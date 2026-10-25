import { describe, expect, it } from 'vitest';

import { toToolCallView } from '../content/toolCalls';
import { AGENT_TERMINAL_LIMIT, agentTerminalMarkdown, applyTerminalMeta } from './agentTerminals';
import { ToolInvocationStore } from './ToolInvocationStore';
import type { ToolInvocation } from './types';

const S = 'session';

describe('agent-owned terminals (codex-acp `_meta` output)', () => {
  it('accumulates terminal_output_delta chunks across updates and shows them as console text', () => {
    const store = new ToolInvocationStore();
    store.upsertCall(S, {
      toolCallId: 'call_1', title: 'ls', kind: 'execute', status: 'in_progress',
      content: [{ type: 'terminal', terminalId: 'call_1' }],
      _meta: { terminal_info: { cwd: '/w', terminal_id: 'call_1' } },
    });
    store.upsertUpdate(S, { toolCallId: 'call_1', _meta: { terminal_output_delta: { data: 'a.txt\n', terminal_id: 'call_1' } } });
    store.upsertUpdate(S, { toolCallId: 'call_1', _meta: { terminal_output_delta: { data: 'b.txt\n', terminal_id: 'call_1' } } });
    // An update without `_meta` must not replay the last chunk.
    store.upsertUpdate(S, { toolCallId: 'call_1', status: 'in_progress' });
    const inv = store.upsertUpdate(S, {
      toolCallId: 'call_1', status: 'completed', rawOutput: { exit_code: 0 },
      _meta: { terminal_exit: { exit_code: 0, signal: null, terminal_id: 'call_1' } },
    })!;

    expect(inv.agentTerminals?.call_1).toMatchObject({ output: 'a.txt\nb.txt\n', exited: true, exitCode: 0 });
    const view = toToolCallView(inv);
    expect(view.items).toEqual([{ type: 'content', block: { type: 'text', text: '```console\na.txt\nb.txt\n```' } }]);
    expect(view.output).toBeUndefined();
  });

  it('keeps a client-created terminal as a chip', () => {
    const store = new ToolInvocationStore();
    const inv = store.upsertCall(S, {
      toolCallId: 't', title: 'Bash', content: [{ type: 'terminal', terminalId: 'term_1' }],
    });
    expect(toToolCallView(inv).items).toEqual([{ type: 'terminal', terminalId: 'term_1' }]);
  });

  it('notes a failing exit code, strips ANSI and uses a fence longer than any backtick run', () => {
    const text = agentTerminalMarkdown({ output: '\u001b[31mboom ```x```\u001b[0m\r\n', truncated: false, exited: true, exitCode: 2 });
    expect(text).toBe('````console\nboom ```x```\n````\n\nExited with code 2');
    expect(agentTerminalMarkdown({ output: '', truncated: false, exited: false, exitCode: null })).toBeNull();
  });

  it('keeps only the tail of a huge output', () => {
    const inv: ToolInvocation = { toolCallId: 'x', title: '', kind: undefined, status: undefined, content: [], locations: [], rawInput: undefined, rawOutput: undefined, startedAt: 0 };
    applyTerminalMeta(inv, { terminal_output_delta: { terminal_id: 'x', data: 'a'.repeat(AGENT_TERMINAL_LIMIT) } });
    applyTerminalMeta(inv, { terminal_output_delta: { terminal_id: 'x', data: 'END' } });
    const t = inv.agentTerminals!.x;
    expect(t.output.length).toBe(AGENT_TERMINAL_LIMIT);
    expect(t.output.endsWith('END')).toBe(true);
    expect(t.truncated).toBe(true);
  });
});

describe('structured rawOutput', () => {
  it('shows an object result as JSON but skips a bare exit code', () => {
    const store = new ToolInvocationStore();
    const mcp = store.upsertCall(S, { toolCallId: 'm', title: 'search', rawOutput: { hits: [1, 2] } });
    expect(toToolCallView(mcp).output).toBe('{\n  "hits": [\n    1,\n    2\n  ]\n}');
    const exit = store.upsertCall(S, { toolCallId: 'e', title: 'cmd', rawOutput: { exit_code: 0 } });
    expect(toToolCallView(exit).output).toBeUndefined();
  });
});
