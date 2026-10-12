import * as os from 'os';
import * as path from 'path';
import { JsonlSourceOptions, JsonlUsageSource, LineParser } from './JsonlUsageSource';
import { UsageEvent } from './types';

export function defaultCodexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

// Turn ids are UUIDv7, so the first 48 bits are the turn's own creation time.
function uuid7Ms(id: unknown): number {
  if (typeof id !== 'string') {
    return NaN;
  }
  const hex = id.replace(/-/g, '').slice(0, 12);
  return /^[0-9a-f]{12}$/i.test(hex) ? parseInt(hex, 16) : NaN;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

interface CodexExtra {
  sessionId?: string;
  cwd?: string;
  model?: string;
  forkedAt?: number;
  replay?: boolean;
  lastTotal?: string;
  [k: string]: unknown;
}

const INTERESTING = ['"token_count"', '"session_meta"', '"turn_context"', '"task_started"'];

export class CodexLineParser implements LineParser {
  private readonly events: UsageEvent[] = [];
  private readonly st: CodexExtra;

  constructor(
    private readonly fallbackSession: string,
    extra?: Record<string, unknown>,
  ) {
    this.st = { ...(extra as CodexExtra | undefined) };
  }

  onLine(line: Buffer, offset: number): void {
    let hit = false;
    for (const needle of INTERESTING) {
      if (line.indexOf(needle) >= 0) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      return;
    }
    let o: any;
    try {
      o = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    if (!o || typeof o !== 'object' || !o.payload || typeof o.payload !== 'object') {
      return;
    }
    const p = o.payload;
    if (o.type === 'session_meta') {
      this.st.sessionId = typeof p.id === 'string' ? p.id : typeof p.session_id === 'string' ? p.session_id : this.st.sessionId;
      if (typeof p.cwd === 'string') {
        this.st.cwd = p.cwd;
      }
      if (typeof p.forked_from_id === 'string' && p.forked_from_id) {
        const t = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
        this.st.forkedAt = Number.isFinite(t) ? t : undefined;
      }
      return;
    }
    if (o.type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) {
        this.st.model = p.model;
      }
      if (typeof p.cwd === 'string') {
        this.st.cwd = p.cwd;
      }
      this.markTurn(p.turn_id);
      return;
    }
    if (o.type !== 'event_msg') {
      return;
    }
    if (p.type === 'task_started') {
      this.markTurn(p.turn_id);
      return;
    }
    if (p.type !== 'token_count' || !p.info || typeof p.info !== 'object') {
      return;
    }
    const total = p.info.total_token_usage;
    const last = p.info.last_token_usage;
    if (!total || !last || typeof last !== 'object') {
      return;
    }
    const sig = [num(total.input_tokens), num(total.cached_input_tokens), num(total.output_tokens), num(total.total_tokens)].join('|');
    if (sig === this.st.lastTotal) {
      return;
    }
    this.st.lastTotal = sig;
    if (this.st.replay) {
      return;
    }
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ts)) {
      return;
    }
    const cached = num(last.cached_input_tokens);
    const written = num(last.cache_write_input_tokens);
    const input = Math.max(0, num(last.input_tokens) - cached - written);
    const output = num(last.output_tokens);
    if (input + output + cached + written === 0) {
      return;
    }
    const sessionId = this.st.sessionId ?? this.fallbackSession;
    const ord = typeof o.ordinal === 'number' ? 'n' + o.ordinal : 'o' + offset;
    this.events.push({
      key: 'x|' + sessionId + '|' + ord,
      agent: 'codex',
      ts,
      model: this.st.model ?? 'unknown',
      project: this.st.cwd ?? '',
      sessionId,
      input,
      output,
      cacheCreate: written,
      cacheRead: cached,
    });
  }

  private markTurn(turnId: unknown): void {
    if (this.st.forkedAt === undefined) {
      return;
    }
    const t = uuid7Ms(turnId);
    this.st.replay = Number.isFinite(t) && t < (this.st.forkedAt as number) - 1000;
  }

  finish(): { events: UsageEvent[]; extra: Record<string, unknown> } {
    return { events: this.events, extra: { ...this.st } };
  }
}

export class CodexUsageSource extends JsonlUsageSource {
  readonly agent = 'codex' as const;

  constructor(root: string = defaultCodexSessionsDir(), options?: JsonlSourceOptions) {
    super(root, options);
  }

  protected createParser(file: string, extra: Record<string, unknown> | undefined): LineParser {
    return new CodexLineParser(path.basename(file, '.jsonl'), extra);
  }
}
