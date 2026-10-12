import { dayKey, dayKeyDaysAgo } from './dates';
import { estimateCost, isPriced } from './pricing';
import { AgentKind, Breakdown, BreakdownEntry, DailyPoint, emptyPeriod, Period, UsageEvent } from './types';

export const INDEX_SCHEMA_VERSION = 1;
export const ARCHIVE_DAY = '0000-00-00';

export interface UsageIndexOptions {
  recentLimit?: number;
  archiveAfterDays?: number;
  topN?: number;
}

interface Rec {
  day: string;
  agent: AgentKind;
  model: string;
  project: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

interface Row extends Rec {
  messages: number;
}

export interface IndexData {
  version: number;
  rows: Array<[string, string, string, string, number, number, number, number, number]>;
  recent: Array<[string, string, string, string, string, number, number, number, number]>;
}

export interface IndexSummary {
  periods: { today: Period; last7d: Period; last30d: Period; all: Period };
  daily: DailyPoint[];
  breakdown: { last30d: Breakdown; all: Breakdown };
  unpriced: { tokens: number; models: string[] };
  hasData: boolean;
}

function rowKey(r: Rec): string {
  return r.day + '\u0000' + r.agent + '\u0000' + r.model + '\u0000' + r.project;
}

function add(p: Period, r: Row, cost: number): void {
  p.input += r.input;
  p.output += r.output;
  p.cacheCreate += r.cacheCreate;
  p.cacheRead += r.cacheRead;
  p.tokens += r.input + r.output + r.cacheCreate + r.cacheRead;
  p.cost += cost;
  p.messages += r.messages;
}

export class UsageIndex {
  private rows = new Map<string, Row>();
  private recent = new Map<string, Rec>();
  private readonly recentLimit: number;
  private readonly archiveAfterDays: number;
  private readonly topN: number;
  private dirty = false;

  constructor(options: UsageIndexOptions = {}) {
    this.recentLimit = options.recentLimit ?? 20000;
    this.archiveAfterDays = options.archiveAfterDays ?? 60;
    this.topN = options.topN ?? 8;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  markClean(): void {
    this.dirty = false;
  }

  get isEmpty(): boolean {
    return this.rows.size === 0;
  }

  get rowCount(): number {
    return this.rows.size;
  }

  apply(events: UsageEvent[], now: number): void {
    if (events.length === 0) {
      return;
    }
    const horizon = dayKeyDaysAgo(now, this.archiveAfterDays);
    for (const ev of events) {
      const prev = this.recent.get(ev.key);
      if (prev) {
        this.bump(prev, -1);
        this.recent.delete(ev.key);
      }
      const day = dayKey(ev.ts);
      const rec: Rec = {
        day: day < horizon ? ARCHIVE_DAY : day,
        agent: ev.agent,
        model: ev.model,
        project: ev.project,
        input: ev.input,
        output: ev.output,
        cacheCreate: ev.cacheCreate,
        cacheRead: ev.cacheRead,
      };
      this.bump(rec, 1);
      this.recent.set(ev.key, rec);
    }
    while (this.recent.size > this.recentLimit) {
      const first = this.recent.keys().next().value as string;
      this.recent.delete(first);
    }
    this.dirty = true;
  }

  compact(now: number): void {
    const horizon = dayKeyDaysAgo(now, this.archiveAfterDays);
    const old: Row[] = [];
    for (const [k, r] of this.rows) {
      if (r.day !== ARCHIVE_DAY && r.day < horizon) {
        old.push(r);
        this.rows.delete(k);
      }
    }
    if (old.length === 0) {
      return;
    }
    for (const r of old) {
      const folded: Row = { ...r, day: ARCHIVE_DAY };
      const k = rowKey(folded);
      const ex = this.rows.get(k);
      if (ex) {
        ex.input += r.input;
        ex.output += r.output;
        ex.cacheCreate += r.cacheCreate;
        ex.cacheRead += r.cacheRead;
        ex.messages += r.messages;
      } else {
        this.rows.set(k, folded);
      }
    }
    this.dirty = true;
  }

  private bump(rec: Rec, sign: 1 | -1): void {
    let k = rowKey(rec);
    let row = this.rows.get(k);
    if (!row && sign === -1 && rec.day !== ARCHIVE_DAY) {
      k = rowKey({ ...rec, day: ARCHIVE_DAY });
      row = this.rows.get(k);
    }
    if (!row) {
      if (sign === -1) {
        return;
      }
      row = { ...rec, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, messages: 0 };
      this.rows.set(k, row);
    }
    row.input += sign * rec.input;
    row.output += sign * rec.output;
    row.cacheCreate += sign * rec.cacheCreate;
    row.cacheRead += sign * rec.cacheRead;
    row.messages += sign;
    if (row.messages <= 0) {
      this.rows.delete(k);
    }
  }

  summarize(now: number): IndexSummary {
    const today = dayKey(now);
    const d7 = dayKeyDaysAgo(now, 6);
    const d30 = dayKeyDaysAgo(now, 29);
    const periods = { today: emptyPeriod(), last7d: emptyPeriod(), last30d: emptyPeriod(), all: emptyPeriod() };
    const dailyMap = new Map<string, DailyPoint>();
    const daily: DailyPoint[] = [];
    for (let i = 29; i >= 0; i--) {
      const day = dayKeyDaysAgo(now, i);
      const pt: DailyPoint = { day, ...emptyPeriod() };
      dailyMap.set(day, pt);
      daily.push(pt);
    }
    const models30 = new Map<string, BreakdownEntry>();
    const models = new Map<string, BreakdownEntry>();
    const projects30 = new Map<string, BreakdownEntry>();
    const projects = new Map<string, BreakdownEntry>();
    const unpricedModels = new Set<string>();
    let unpricedTokens = 0;

    const touch = (map: Map<string, BreakdownEntry>, name: string, r: Row, cost: number, priced: boolean): void => {
      let e = map.get(name);
      if (!e) {
        e = { name, agent: r.agent, priced, ...emptyPeriod() };
        map.set(name, e);
      } else if (e.agent !== r.agent) {
        e.agent = 'mixed';
      }
      e.priced = e.priced && priced;
      add(e, r, cost);
    };

    for (const r of this.rows.values()) {
      const priced = isPriced(r.model);
      const cost = estimateCost(r);
      add(periods.all, r, cost);
      const tokens = r.input + r.output + r.cacheCreate + r.cacheRead;
      if (!priced) {
        unpricedTokens += tokens;
        unpricedModels.add(r.model);
      }
      const modelName = r.model;
      const projectName = r.project || '(unknown)';
      touch(models, modelName, r, cost, priced);
      touch(projects, projectName, r, cost, priced);
      if (r.day >= d30 && r.day <= today) {
        add(periods.last30d, r, cost);
        touch(models30, modelName, r, cost, priced);
        touch(projects30, projectName, r, cost, priced);
        const pt = dailyMap.get(r.day);
        if (pt) {
          add(pt, r, cost);
        }
        if (r.day >= d7) {
          add(periods.last7d, r, cost);
        }
        if (r.day === today) {
          add(periods.today, r, cost);
        }
      }
    }

    const top = (m: Map<string, BreakdownEntry>): BreakdownEntry[] =>
      Array.from(m.values())
        .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
        .slice(0, this.topN);

    return {
      periods,
      daily,
      breakdown: {
        last30d: { models: top(models30), projects: top(projects30) },
        all: { models: top(models), projects: top(projects) },
      },
      unpriced: { tokens: unpricedTokens, models: Array.from(unpricedModels).sort() },
      hasData: this.rows.size > 0,
    };
  }

  toJSON(): IndexData {
    return {
      version: INDEX_SCHEMA_VERSION,
      rows: Array.from(this.rows.values()).map((r) => [r.day, r.agent, r.model, r.project, r.input, r.output, r.cacheCreate, r.cacheRead, r.messages]),
      recent: Array.from(this.recent, ([k, r]) => [k, r.day, r.agent, r.model, r.project, r.input, r.output, r.cacheCreate, r.cacheRead]),
    };
  }

  static fromJSON(data: unknown, options?: UsageIndexOptions): UsageIndex | undefined {
    const d = data as IndexData | undefined;
    if (!d || d.version !== INDEX_SCHEMA_VERSION || !Array.isArray(d.rows) || !Array.isArray(d.recent)) {
      return undefined;
    }
    const idx = new UsageIndex(options);
    const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const isAgent = (v: unknown): v is AgentKind => v === 'claude' || v === 'codex';
    for (const t of d.rows) {
      if (!Array.isArray(t) || typeof t[0] !== 'string' || !isAgent(t[1]) || typeof t[2] !== 'string' || typeof t[3] !== 'string') {
        return undefined;
      }
      if (![t[4], t[5], t[6], t[7], t[8]].every(isNum)) {
        return undefined;
      }
      const row: Row = { day: t[0], agent: t[1], model: t[2], project: t[3], input: t[4], output: t[5], cacheCreate: t[6], cacheRead: t[7], messages: t[8] };
      idx.rows.set(rowKey(row), row);
    }
    for (const t of d.recent) {
      if (!Array.isArray(t) || typeof t[0] !== 'string' || typeof t[1] !== 'string' || !isAgent(t[2]) || typeof t[3] !== 'string' || typeof t[4] !== 'string') {
        return undefined;
      }
      if (![t[5], t[6], t[7], t[8]].every(isNum)) {
        return undefined;
      }
      idx.recent.set(t[0], { day: t[1], agent: t[2], model: t[3], project: t[4], input: t[5], output: t[6], cacheCreate: t[7], cacheRead: t[8] });
    }
    return idx;
  }
}
