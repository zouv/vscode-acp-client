/** Copy untrusted JSON with bounded depth, collection size and retained text. */
export function boundedPayload<T>(value: T, maxChars = 64 * 1024): T {
  let remaining = maxChars;
  let nodes = 2048;
  const seen = new WeakSet<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (--nodes < 0 || remaining <= 0 || depth > 10) { return '[truncated]'; }
    if (typeof item === 'string') {
      const length = Math.min(item.length, remaining, 32 * 1024);
      remaining -= length;
      return item.length > length ? Buffer.from(item.slice(0, length)).toString('utf8') + '…[truncated]' : item;
    }
    if (!item || typeof item !== 'object') { return item; }
    if (seen.has(item)) { return '[circular]'; }
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) {
      const entries: unknown[] = [];
      for (let i = 0; i < Math.min(item.length, 128) && remaining > 0 && nodes > 0; i++) {
        entries.push(copy(item[i], depth + 1));
      }
      result = entries;
    } else {
      const record: Record<string, unknown> = {};
      let count = 0;
      for (const key of Object.keys(item)) {
        if (++count > 128 || remaining <= 0 || nodes <= 0) { break; }
        remaining -= key.length;
        if (key.length > 1024) { continue; }
        Object.defineProperty(record, key, { value: copy((item as Record<string, unknown>)[key], depth + 1), enumerable: true, writable: true, configurable: true });
      }
      result = record;
    }
    seen.delete(item);
    return result;
  };
  return copy(value, 0) as T;
}
