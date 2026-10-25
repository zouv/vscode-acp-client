import * as os from 'os';
import * as path from 'path';
import { JsonlSourceOptions, JsonlUsageSource, LineParser } from './JsonlUsageSource';
import { UsageEvent } from './types';

/** `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects` (Claude Code's own lookup order). */
export function defaultClaudeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export class ClaudeLineParser implements LineParser {
  private readonly byKey = new Map<string, UsageEvent>();

  constructor(
    private readonly fallbackProject: string,
    private readonly fallbackSession: string,
  ) {}

  onLine(line: Buffer): void {
    if (line.indexOf('"usage"') < 0) {
      return;
    }
    let o: any;
    try {
      o = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    if (!o || typeof o !== 'object' || o.type !== 'assistant') {
      return;
    }
    const msg = o.message;
    if (!msg || typeof msg !== 'object') {
      return;
    }
    const usage = msg.usage;
    if (!usage || typeof usage !== 'object') {
      return;
    }
    const model = str(msg.model);
    if (!model || model.startsWith('<')) {
      return;
    }
    const id = str(msg.id) ?? str(o.uuid);
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (!id || !Number.isFinite(ts)) {
      return;
    }
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    const cacheCreate = num(usage.cache_creation_input_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    if (input + output + cacheCreate + cacheRead === 0) {
      return;
    }
    const key = 'c|' + id + '|' + (str(o.requestId) ?? '');
    this.byKey.delete(key);
    this.byKey.set(key, {
      key,
      agent: 'claude',
      ts,
      model,
      project: str(o.cwd) ?? this.fallbackProject,
      sessionId: str(o.sessionId) ?? this.fallbackSession,
      input,
      output,
      cacheCreate,
      cacheRead,
    });
  }

  finish(): { events: UsageEvent[] } {
    return { events: Array.from(this.byKey.values()) };
  }
}

export class ClaudeUsageSource extends JsonlUsageSource {
  readonly agent = 'claude' as const;

  constructor(root: string = defaultClaudeProjectsDir(), options?: JsonlSourceOptions) {
    super(root, options);
  }

  protected createParser(file: string): LineParser {
    const rel = path.relative(this.root, file).split(path.sep);
    const fallbackProject = rel.length > 1 ? rel[0] : path.basename(path.dirname(file));
    return new ClaudeLineParser(fallbackProject, path.basename(file, '.jsonl'));
  }
}
