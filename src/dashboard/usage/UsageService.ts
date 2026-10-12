import * as fs from 'fs';
import * as path from 'path';
import { PRICING_AS_OF } from './pricing';
import { IndexData, UsageIndex, UsageIndexOptions } from './UsageIndex';
import { DashboardSnapshot, emptySourceState, SourceInfo, SourceState, UsageSource } from './types';
import { dayKey } from './dates';

export interface WatchHandle {
  close(): void;
}

export type WatchFactory = (root: string, onChange: () => void, onError: () => void) => WatchHandle | undefined;

export interface UsageServiceOptions {
  sources: UsageSource[];
  persistPath?: string;
  now?: () => number;
  debounceMs?: number;
  pollMs?: number;
  persistIntervalMs?: number;
  emitIntervalMs?: number;
  indexOptions?: UsageIndexOptions;
  watchFactory?: WatchFactory;
}

interface PersistedFile {
  version: number;
  savedAt: number;
  states: Record<string, SourceState>;
  index: IndexData;
}

const PERSIST_VERSION = 1;

export function defaultWatchFactory(root: string, onChange: () => void, onError: () => void): WatchHandle | undefined {
  try {
    const w = fs.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename || String(filename).endsWith('.jsonl')) {
        onChange();
      }
    });
    w.on('error', () => {
      try {
        w.close();
      } catch {
        // already closed
      }
      onError();
    });
    return { close: () => w.close() };
  } catch {
    return undefined;
  }
}

function sanitizeState(raw: unknown): SourceState {
  const out = emptySourceState();
  const files = raw && typeof raw === 'object' ? (raw as SourceState).files : undefined;
  if (!files || typeof files !== 'object') {
    return out;
  }
  for (const [k, c] of Object.entries(files)) {
    if (c && typeof c.size === 'number' && typeof c.mtimeMs === 'number' && typeof c.offset === 'number') {
      out.files[k] = c;
    }
  }
  return out;
}

export class UsageService {
  private index: UsageIndex;
  private states = new Map<string, SourceState>();
  private readonly sourceErrors = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private readonly persistIntervalMs: number;
  private readonly emitIntervalMs: number;
  private readonly indexOptions: UsageIndexOptions | undefined;
  private readonly watchFactory: WatchFactory;
  private inflight: Promise<void> | undefined;
  private rerun = false;
  private loaded: Promise<void> | undefined;
  private scanning = false;
  private firstScanDone = false;
  private stateDirty = false;
  private lastPersistAt = 0;
  private lastEmitAt = 0;
  private persistChain: Promise<void> = Promise.resolve();
  private debounceTimer: NodeJS.Timeout | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private watchers = new Map<string, WatchHandle>();
  private watching = false;
  private disposed = false;
  private version = 0;
  private cache: { key: string; snap: DashboardSnapshot } | undefined;

  constructor(private readonly opts: UsageServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.debounceMs = opts.debounceMs ?? 2000;
    this.pollMs = opts.pollMs ?? 60000;
    this.persistIntervalMs = opts.persistIntervalMs ?? 5000;
    this.emitIntervalMs = opts.emitIntervalMs ?? 1000;
    this.indexOptions = opts.indexOptions;
    this.watchFactory = opts.watchFactory ?? defaultWatchFactory;
    this.index = new UsageIndex(this.indexOptions);
  }

  onDidChange(cb: () => void): { dispose(): void } {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = this.loadFromDisk();
    }
    return this.loaded;
  }

  refresh(): Promise<void> {
    if (this.inflight) {
      return this.inflight;
    }
    this.scanning = true;
    this.emit(true);
    const p = this.runRefresh().finally(() => {
      if (this.inflight === p) {
        this.inflight = undefined;
      }
    });
    this.inflight = p;
    return p;
  }

  scheduleRefresh(): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (this.inflight) {
        this.rerun = true;
      } else {
        void this.refresh();
      }
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  startWatching(): void {
    if (this.watching || this.disposed) {
      return;
    }
    this.watching = true;
    this.attachWatchers();
    this.pollTimer = setInterval(() => {
      this.attachWatchers();
      if (this.watchers.size < this.rootsCount()) {
        this.scheduleRefresh();
      }
    }, this.pollMs);
    this.pollTimer.unref?.();
  }

  stopWatching(): void {
    this.watching = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    this.watchers.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.listeners.clear();
  }

  flush(): Promise<void> {
    return this.persist(true);
  }

  snapshot(): DashboardSnapshot {
    const now = this.now();
    const key = this.version + '|' + dayKey(now) + '|' + this.scanning + '|' + this.firstScanDone;
    if (this.cache && this.cache.key === key) {
      return this.cache.snap;
    }
    const s = this.index.summarize(now);
    const sources: SourceInfo[] = this.opts.sources.map((src) => {
      const info: SourceInfo = { agent: src.agent, files: Object.keys(this.states.get(src.agent)?.files ?? {}).length };
      const err = this.sourceErrors.get(src.agent);
      if (err) {
        info.error = err;
      }
      return info;
    });
    const daily = s.daily.slice();
    const snap: DashboardSnapshot = {
      version: 1,
      generatedAt: now,
      scanning: this.scanning,
      firstScanDone: this.firstScanDone,
      hasData: s.hasData,
      pricingAsOf: PRICING_AS_OF,
      periods: s.periods,
      daily,
      breakdown: s.breakdown,
      unpriced: s.unpriced,
      sources,
    };
    const errs = Array.from(this.sourceErrors.values());
    if (errs.length > 0) {
      snap.lastError = errs[0];
    }
    this.cache = { key, snap };
    return snap;
  }

  private rootsCount(): number {
    let n = 0;
    for (const s of this.opts.sources) {
      n += s.watchRoots().length;
    }
    return n;
  }

  private attachWatchers(): void {
    if (!this.watching) {
      return;
    }
    for (const s of this.opts.sources) {
      for (const root of s.watchRoots()) {
        if (this.watchers.has(root)) {
          continue;
        }
        const h = this.watchFactory(
          root,
          () => this.scheduleRefresh(),
          () => {
            this.watchers.delete(root);
          },
        );
        if (h) {
          this.watchers.set(root, h);
        }
      }
    }
  }

  private emit(force = false): void {
    this.version++;
    const t = Date.now();
    if (!force && t - this.lastEmitAt < this.emitIntervalMs) {
      return;
    }
    this.lastEmitAt = t;
    for (const cb of Array.from(this.listeners)) {
      try {
        cb();
      } catch {
        // listener failure must not break scanning
      }
    }
  }

  private async runRefresh(): Promise<void> {
    await this.load();
    do {
      this.rerun = false;
      await this.pass();
    } while (this.rerun && !this.disposed);
  }

  private async pass(): Promise<void> {
    try {
      for (const src of this.opts.sources) {
        const prev = this.states.get(src.agent) ?? emptySourceState();
        try {
          const res = await src.scan(prev, {
            onBatch: (events) => {
              this.index.apply(events, this.now());
            },
            onProgress: (state) => {
              this.states.set(src.agent, state);
              this.stateDirty = true;
              this.emit();
              if (Date.now() - this.lastPersistAt >= this.persistIntervalMs) {
                void this.persist(false);
              }
            },
          });
          if (res.events.length > 0) {
            this.index.apply(res.events, this.now());
          }
          if (JSON.stringify(res.state.files) !== JSON.stringify(prev.files)) {
            this.stateDirty = true;
          }
          this.states.set(src.agent, res.state);
          this.sourceErrors.delete(src.agent);
        } catch (e) {
          this.sourceErrors.set(src.agent, e instanceof Error ? e.message : String(e));
        }
      }
      this.index.compact(this.now());
    } finally {
      if (!this.rerun) {
        this.scanning = false;
        this.firstScanDone = true;
        await this.persist(true);
        this.emit(true);
      }
    }
  }

  private persist(force: boolean): Promise<void> {
    const path_ = this.opts.persistPath;
    if (!path_) {
      return Promise.resolve();
    }
    if (!force && !this.index.isDirty && !this.stateDirty) {
      return Promise.resolve();
    }
    if (!this.index.isDirty && !this.stateDirty) {
      return this.persistChain;
    }
    this.lastPersistAt = Date.now();
    const states: Record<string, SourceState> = {};
    for (const [k, v] of this.states) {
      states[k] = v;
    }
    const payload: PersistedFile = { version: PERSIST_VERSION, savedAt: this.now(), states, index: this.index.toJSON() };
    const json = JSON.stringify(payload);
    this.index.markClean();
    this.stateDirty = false;
    this.persistChain = this.persistChain.then(() => this.writeAtomic(path_, json)).catch(() => undefined);
    return this.persistChain;
  }

  private async writeAtomic(file: string, json: string): Promise<void> {
    const tmp = file + '.' + process.pid + '.tmp';
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, json, 'utf8');
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.promises.rename(tmp, file);
          return;
        } catch (e) {
          if (attempt >= 3) {
            throw e;
          }
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        }
      }
    } catch {
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private async loadFromDisk(): Promise<void> {
    const file = this.opts.persistPath;
    if (!file) {
      return;
    }
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as PersistedFile;
      if (!parsed || parsed.version !== PERSIST_VERSION) {
        return;
      }
      const idx = UsageIndex.fromJSON(parsed.index, this.indexOptions);
      if (!idx) {
        return;
      }
      this.index = idx;
      this.states = new Map();
      for (const src of this.opts.sources) {
        this.states.set(src.agent, sanitizeState(parsed.states ? parsed.states[src.agent] : undefined));
      }
      this.firstScanDone = true;
      this.version++;
    } catch {
      this.index = new UsageIndex(this.indexOptions);
      this.states = new Map();
    }
  }
}
