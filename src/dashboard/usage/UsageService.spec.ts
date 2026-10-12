import { describe, expect, it } from 'vitest';
import { UsageService } from './UsageService';
import { emptySourceState, ScanOptions, ScanResult, SourceState, UsageEvent, UsageSource } from './types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

class FakeSource implements UsageSource {
  readonly agent = 'claude' as const;
  calls = 0;
  batches = 0;
  error: string | undefined;
  roots: string[];
  private batches_: UsageEvent[][];

  constructor(batchSets: UsageEvent[][], roots: string[] = []) {
    this.batches_ = batchSets;
    this.roots = roots;
  }

  watchRoots(): string[] {
    return this.roots;
  }

  async scan(state: SourceState, options: ScanOptions = {}): Promise<ScanResult> {
    const call = this.calls++;
    if (this.error) {
      throw new Error(this.error);
    }
    const events = this.batches_[Math.min(call, this.batches_.length - 1)] ?? [];
    if (events.length > 0) {
      options.onBatch?.(events);
      this.batches++;
    }
    const next: SourceState = { files: { ...state.files, ['f' + call]: { size: 1, mtimeMs: 1, offset: 1 } } };
    options.onProgress?.(next);
    return { events: [], state: next };
  }
}

function ev(key: string, ts: number, output = 10): UsageEvent {
  return { key, agent: 'claude', ts, model: 'claude-sonnet-5.5', project: '/p', sessionId: 's', input: 1000, output, cacheCreate: 0, cacheRead: 0 };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vac-svc-'));
}

const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();

describe('UsageService', () => {
  it('is single-flight: concurrent refreshes share one scan', async () => {
    const src = new FakeSource([[ev('a', NOW)]]);
    const svc = new UsageService({ sources: [src], now: () => NOW });
    await Promise.all([svc.refresh(), svc.refresh(), svc.refresh()]);
    expect(src.calls).toBe(1);
    expect(svc.snapshot().periods.today.tokens).toBe(1010);
  });

  it('re-runs once when a refresh is requested mid-scan', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const src: UsageSource = {
      agent: 'claude',
      watchRoots: () => [],
      async scan(state, options = {}): Promise<ScanResult> {
        await gate;
        options.onBatch?.([ev('a', NOW)]);
        return { events: [], state: emptySourceState() };
      },
    };
    const svc = new UsageService({ sources: [src], now: () => NOW, debounceMs: 1 });
    const first = svc.refresh();
    const second = svc.refresh();
    svc.scheduleRefresh();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    expect(svc.snapshot().periods.today.tokens).toBe(1010);
  });

  it('notifies listeners and caches the snapshot', async () => {
    const src = new FakeSource([[ev('a', NOW)]]);
    const svc = new UsageService({ sources: [src], now: () => NOW });
    let changes = 0;
    const sub = svc.onDidChange(() => changes++);
    await svc.refresh();
    expect(changes).toBeGreaterThan(0);
    const snap = svc.snapshot();
    expect(svc.snapshot()).toBe(snap);
    sub.dispose();
  });

  it('reports per-source file counts and errors', async () => {
    const src = new FakeSource([[]]);
    const svc = new UsageService({ sources: [src], now: () => NOW });
    await svc.refresh();
    expect(svc.snapshot().sources[0].files).toBe(1);

    src.error = 'boom';
    await svc.refresh();
    const snap = svc.snapshot();
    expect(snap.sources[0].error).toBe('boom');
    expect(snap.lastError).toBe('boom');
  });

  it('persists incrementally and resumes cursors on reload', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'usage-index.json');
    try {
      const src = new FakeSource([[ev('a', NOW)]]);
      const svc = new UsageService({ sources: [src], persistPath: file, now: () => NOW });
      await svc.refresh();
      await svc.flush();
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(written.version).toBe(1);
      expect(written.states.claude.files.f0).toBeDefined();

      const src2 = new FakeSource([[ev('a', NOW)]]);
      const svc2 = new UsageService({ sources: [src2], persistPath: file, now: () => NOW });
      await svc2.load();
      const restored = svc2.snapshot();
      expect(restored.firstScanDone).toBe(true);
      expect(restored.periods.today.tokens).toBe(1010);
      expect(restored.sources[0].files).toBe(1);
      await svc2.refresh();
      expect(svc2.snapshot().periods.today.tokens).toBe(1010);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds from scratch when the persisted file is corrupt', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'usage-index.json');
    try {
      fs.writeFileSync(file, '{ not json');
      const src = new FakeSource([[ev('a', NOW)]]);
      const svc = new UsageService({ sources: [src], persistPath: file, now: () => NOW });
      await svc.load();
      expect(svc.snapshot().hasData).toBe(false);
      await svc.refresh();
      expect(svc.snapshot().periods.today.tokens).toBe(1010);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a persisted file with an unknown schema version', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'usage-index.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ version: 99, savedAt: 0, states: {}, index: { version: 1, rows: [], recent: [] } }));
      const svc = new UsageService({ sources: [new FakeSource([[]])], persistPath: file, now: () => NOW });
      await svc.load();
      expect(svc.snapshot().firstScanDone).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('debounces file-watch triggers', async () => {
    const src = new FakeSource([[ev('a', NOW)]]);
    const svc = new UsageService({ sources: [src], now: () => NOW, debounceMs: 5 });
    svc.scheduleRefresh();
    svc.scheduleRefresh();
    svc.scheduleRefresh();
    expect(src.calls).toBe(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(src.calls).toBe(1);
    svc.dispose();
  });

  it('marks the snapshot as scanning during a pass', async () => {
    const src = new FakeSource([[ev('a', NOW)]]);
    const svc = new UsageService({ sources: [src], now: () => NOW });
    const p = svc.refresh();
    expect(svc.snapshot().scanning).toBe(true);
    await p;
    const snap = svc.snapshot();
    expect(snap.scanning).toBe(false);
    expect(snap.firstScanDone).toBe(true);
  });

  it('registers watchers for each source root and stops them on dispose', () => {
    const closed: string[] = [];
    const src = new FakeSource([[]], ['/root/a', '/root/b']);
    const svc = new UsageService({
      sources: [src],
      now: () => NOW,
      watchFactory: (root) => ({
        close: () => closed.push(root),
      }),
    });
    svc.startWatching();
    expect(closed).toEqual([]);
    svc.dispose();
    expect(closed.sort()).toEqual(['/root/a', '/root/b']);
  });
});
