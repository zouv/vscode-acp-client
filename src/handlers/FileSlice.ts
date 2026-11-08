/**
 * ACP `fs/read_text_file` line window: `line` is 1-based (values below 1 read from the
 * start), `limit` is a maximum line count — `0` means no lines, absent/null means to the end.
 */
export function sliceLines(content: string, line?: number | null, limit?: number | null): string {
  const hasLine = line !== undefined && line !== null;
  const hasLimit = limit !== undefined && limit !== null;
  if (!hasLine && !hasLimit) { return content; }
  if (hasLimit && limit <= 0) { return ''; }
  const lines = content.split('\n');
  const start = Math.max(0, (hasLine ? line : 1) - 1);
  return lines.slice(start, hasLimit ? start + limit : undefined).join('\n');
}
