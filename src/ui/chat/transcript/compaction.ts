// [CUSTOM- Claude Code 的上下文压缩在 ACP 里是一条独立的 `compaction_update` 生命周期。
// 它既不是用户发言，也不是工具调用：渲染成一条自己的 compact 记录（与官方 Claude 插件的
// "Compacted chat" 折叠行同形），不进入大纲 / 置顶用户条 / 轮次计数。
import type { CompactionUpdate } from '@agentclientprotocol/sdk';

/**
 * [CUSTOM- Claude Code 把保留的摘要写成一条 user 记录，并用这段续接语包装。
 * 老适配器（未声明 `session.compaction`）会把它当 `user_message_chunk` 原样回放；
 * 这个前缀是最后的兜底判据，和 `diskSessions.titleOf` 共用同一份正则。
 */
export const COMPACT_SUMMARY_PREFIX = /^\s*This session is being continued from a previous conversation/i;

export function isCompactSummaryText(text: string): boolean {
  return COMPACT_SUMMARY_PREFIX.test(text);
}

/** `summary` patch 语义的两种「空」：未提供（保留累计值）vs 显式清空。 */
export interface CompactionSummaryField {
  /** `summary` 字段是否出现（`undefined` = 未提供；`null` / `[]` = 显式清空）。 */
  provided: boolean;
  text: string;
}

export function compactionSummaryField(
  summary: CompactionUpdate['summary'] | null | undefined,
): CompactionSummaryField {
  if (summary === undefined) { return { provided: false, text: '' }; }
  if (summary === null || !Array.isArray(summary)) { return { provided: true, text: '' }; }
  const text = summary
    .filter((block): block is { type: 'text'; text: string } =>
      !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string',
    )
    .map(block => block.text)
    .join('\n');
  return { provided: true, text };
}

/** The authoritative summary text for a terminal update. */
export function compactionText(update: CompactionUpdate, accumulated?: string): string {
  const field = compactionSummaryField(update.summary);
  return field.provided ? field.text : (accumulated ?? '');
}

export function isTerminalCompaction(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Human-readable failure/cancel reason. `completed` has none, even if a stale
 * `error` field happens to be present.
 */
export function compactionError(update: CompactionUpdate): string | undefined {
  const detail = typeof update.error === 'string' && update.error.length > 0 ? update.error : undefined;
  if (update.status === 'failed') {
    return detail ? `Compaction failed: ${detail}` : 'Compaction failed.';
  }
  if (update.status === 'cancelled') {
    return detail ? `Compaction cancelled: ${detail}` : 'Compaction cancelled.';
  }
  return undefined;
}

/**
 * Strip Claude's continuation framing from a raw persisted summary.
 *
 * The adapter cleans this for clients on the compaction contract; the fallback
 * path (older adapter replaying the summary as a user chunk) still carries the
 * framing. If the framing is not recognized the text is returned unchanged, so a
 * vendor wording change can never hide the actual content.
 */
const PERSISTED_PREAMBLE =
  /^\s*This session is being continued from a previous conversation[^\n]*\n+Summary:[ \t]*\r?\n/i;
const PERSISTED_TRAILERS = [
  /\n+If you need specific details from before compaction[\s\S]*$/i,
  /\n+(?:Please )?[Cc]ontinue the conversation from where it left (?:it )?off[\s\S]*$/i,
];

export function compactSummaryBody(text: string): string {
  let out = text.replace(PERSISTED_PREAMBLE, '');
  for (const trailer of PERSISTED_TRAILERS) { out = out.replace(trailer, ''); }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : text.trim();
}
