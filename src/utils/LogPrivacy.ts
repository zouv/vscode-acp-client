const SECRET_KEY = /(?:api[._-]?key|token|password|secret|authorization|credential|cookie)/i;
const CONTENT_KEY = /^(prompt|content|text|data|blob|env|rawInput|rawOutput|arguments|answers|args|message|description|title|oldText|newText|path|uri|command|requestedSchema|_meta)$/i;

const METADATA_KEY = /^(jsonrpc|method|id|sessionId|toolCallId|terminalId|type|kind|status|outcome|optionId|protocolVersion)$/;

export function redactTraffic(key: string, value: unknown): unknown {
  if (SECRET_KEY.test(key) || CONTENT_KEY.test(key)) { return '«redacted»'; }
  if (typeof value === 'string') {
    if (!METADATA_KEY.test(key)) { return '«redacted»'; }
    const safe = value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)/gi, '«redacted»');
    return safe.length > 2000 ? safe.slice(0, 2000) + '…(truncated)' : safe;
  }
  return value;
}
