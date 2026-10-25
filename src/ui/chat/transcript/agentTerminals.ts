// Agent 自己跑、经 `_meta` 推送输出的终端（Zed 约定：`terminal_info` / `terminal_output(_delta)` /
// `terminal_exit`）。
//
// **为什么需要**：codex-acp 不走客户端的 `terminal/create`，而是在工具卡 `content` 里放一个
// `{type:'terminal', terminalId: <toolCallId>}`，再把命令输出**分片**塞进每次 `tool_call_update`
// 的 `_meta.terminal_output_delta`。这个 id 在 `TerminalHandler` 里根本不存在，不接住这些分片，
// Codex 的命令输出在面板上就是一片空白（只剩一个点了也打不开的 terminal 按钮）。
//
// `_meta` 每次更新整体替换，所以只能**逐条累加**收到的那份 `_meta`，不能读 `inv.meta`。
import type { AgentTerminal, ToolInvocation } from './types';

/** Tail kept per terminal; older output is dropped (the card is a preview, not a log). */
export const AGENT_TERMINAL_LIMIT = 256 * 1024;

type Chunk = { terminal_id?: unknown; data?: unknown; exit_code?: unknown };

const asChunk = (value: unknown): Chunk | undefined =>
  value && typeof value === 'object' ? value as Chunk : undefined;

/** Folds one update's own `_meta` into the invocation's agent terminals. Returns whether anything changed. */
export function applyTerminalMeta(inv: ToolInvocation, meta: unknown): boolean {
  if (!meta || typeof meta !== 'object') { return false; }
  const m = meta as Record<string, unknown>;
  let changed = false;
  const terminal = (chunk: Chunk | undefined): AgentTerminal | undefined => {
    const id = typeof chunk?.terminal_id === 'string' && chunk.terminal_id ? chunk.terminal_id : undefined;
    if (!id) { return undefined; }
    const all = inv.agentTerminals ??= {};
    return all[id] ??= { output: '', truncated: false, exited: false, exitCode: null };
  };

  if (terminal(asChunk(m.terminal_info))) { changed = true; }
  for (const key of ['terminal_output_delta', 'terminal_output']) {
    const chunk = asChunk(m[key]);
    const t = terminal(chunk);
    if (t && typeof chunk?.data === 'string' && chunk.data.length > 0) {
      t.output += chunk.data;
      if (t.output.length > AGENT_TERMINAL_LIMIT) {
        t.output = t.output.slice(t.output.length - AGENT_TERMINAL_LIMIT);
        t.truncated = true;
      }
      changed = true;
    }
  }
  const exit = asChunk(m.terminal_exit);
  const ended = terminal(exit);
  if (ended) {
    ended.exited = true;
    ended.exitCode = typeof exit?.exit_code === 'number' ? exit.exit_code : null;
    changed = true;
  }
  return changed;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * Markdown for one agent terminal (a ```console fence, like Claude Code's shell output),
 * or null while there is nothing to show yet.
 */
export function agentTerminalMarkdown(t: AgentTerminal): string | null {
  const text = t.output.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const exitNote = t.exited && t.exitCode !== null && t.exitCode !== 0 ? `Exited with code ${t.exitCode}` : '';
  if (!text && !exitNote) { return null; }
  const parts: string[] = [];
  if (text) {
    const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    parts.push(`${fence}console\n${t.truncated ? '…\n' : ''}${text}\n${fence}`);
  }
  if (exitNote) { parts.push(exitNote); }
  return parts.join('\n\n');
}
