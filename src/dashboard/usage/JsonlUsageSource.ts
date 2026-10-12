import * as fs from 'fs';
import * as path from 'path';
import { AgentKind, FileCursor, ScanOptions, ScanResult, SourceState, UsageEvent, UsageSource } from './types';

export interface LineParser {
  onLine(line: Buffer, offset: number): void;
  finish(): { events: UsageEvent[]; extra?: Record<string, unknown> };
}

export interface JsonlSourceOptions {
  concurrency?: number;
  chunkBytes?: number;
  maxSliceMs?: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_SLICE_MS = 8;

export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function listJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

export async function readLinesFrom(
  file: string,
  startOffset: number,
  onLine: (line: Buffer, offset: number) => void,
  chunkBytes: number,
  maxSliceMs: number,
): Promise<number> {
  const handle = await fs.promises.open(file, 'r');
  try {
    let pos = startOffset;
    let carry: Buffer = Buffer.alloc(0);
    let carryStart = startOffset;
    let sliceStart = Date.now();
    const chunk = Buffer.allocUnsafe(chunkBytes);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkBytes, pos);
      if (bytesRead === 0) {
        break;
      }
      pos += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : Buffer.from(chunk.subarray(0, bytesRead));
      let lineStart = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, lineStart);
        if (nl < 0) {
          break;
        }
        let end = nl;
        if (end > lineStart && data[end - 1] === 0x0d) {
          end--;
        }
        if (end > lineStart) {
          onLine(data.subarray(lineStart, end), carryStart + lineStart);
        }
        lineStart = nl + 1;
      }
      carry = data.subarray(lineStart);
      carryStart += lineStart;
      if (Date.now() - sliceStart >= maxSliceMs) {
        await yieldToLoop();
        sliceStart = Date.now();
      }
    }
    return carryStart;
  } finally {
    await handle.close();
  }
}

export abstract class JsonlUsageSource implements UsageSource {
  abstract readonly agent: AgentKind;
  private readonly concurrency: number;
  private readonly chunkBytes: number;
  private readonly maxSliceMs: number;

  constructor(
    protected readonly root: string,
    options: JsonlSourceOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.chunkBytes = Math.max(1024, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
    this.maxSliceMs = options.maxSliceMs ?? DEFAULT_SLICE_MS;
  }

  protected abstract createParser(file: string, extra: Record<string, unknown> | undefined): LineParser;

  watchRoots(): string[] {
    return [this.root];
  }

  async scan(state: SourceState, options: ScanOptions = {}): Promise<ScanResult> {
    const files = await listJsonlFiles(this.root);
    const next: SourceState = { files: {} };
    const collected: UsageEvent[] = [];
    const prevFiles = state && state.files ? state.files : {};
    for (const f of files) {
      if (prevFiles[f]) {
        next.files[f] = prevFiles[f];
      }
    }
    let index = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = index++;
        if (i >= files.length) {
          return;
        }
        const file = files[i];
        const res = await this.scanFile(file, prevFiles[file]);
        if (!res) {
          continue;
        }
        if (res.events.length > 0) {
          if (options.onBatch) {
            options.onBatch(res.events);
          } else {
            for (const e of res.events) {
              collected.push(e);
            }
          }
        }
        next.files[file] = res.cursor;
        if (options.onProgress) {
          options.onProgress(next);
        }
        await yieldToLoop();
      }
    };
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.min(this.concurrency, files.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return { events: collected, state: next };
  }

  private async scanFile(
    file: string,
    prev: FileCursor | undefined,
  ): Promise<{ events: UsageEvent[]; cursor: FileCursor } | undefined> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return undefined;
    }
    if (prev && st.size === prev.size && st.mtimeMs === prev.mtimeMs) {
      return undefined;
    }
    const replaced = !prev || st.size < prev.offset || st.size < prev.size || (st.size === prev.size && st.mtimeMs !== prev.mtimeMs);
    const start = replaced ? 0 : (prev as FileCursor).offset;
    try {
      const parser = this.createParser(file, replaced ? undefined : prev?.extra);
      const offset = await readLinesFrom(file, start, (line, off) => parser.onLine(line, off), this.chunkBytes, this.maxSliceMs);
      const fin = parser.finish();
      const cursor: FileCursor = { size: st.size, mtimeMs: st.mtimeMs, offset };
      if (fin.extra) {
        cursor.extra = fin.extra;
      }
      return { events: fin.events, cursor };
    } catch {
      return undefined;
    }
  }
}
