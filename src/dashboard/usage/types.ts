export type AgentKind = 'claude' | 'codex';

export interface UsageEvent {
  key: string;
  agent: AgentKind;
  ts: number;
  model: string;
  project: string;
  sessionId: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface FileCursor {
  size: number;
  mtimeMs: number;
  offset: number;
  extra?: Record<string, unknown>;
}

export interface SourceState {
  files: Record<string, FileCursor>;
}

export interface ScanOptions {
  onBatch?: (events: UsageEvent[]) => void;
  onProgress?: (state: SourceState) => void;
}

export interface ScanResult {
  events: UsageEvent[];
  state: SourceState;
}

export interface UsageSource {
  readonly agent: AgentKind;
  scan(state: SourceState, options?: ScanOptions): Promise<ScanResult>;
  watchRoots(): string[];
}

export interface UsageTokens {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface Period extends UsageTokens {
  tokens: number;
  cost: number;
  messages: number;
}

export interface DailyPoint extends Period {
  day: string;
}

export interface BreakdownEntry extends Period {
  name: string;
  agent: AgentKind | 'mixed';
  priced: boolean;
}

export interface Breakdown {
  models: BreakdownEntry[];
  projects: BreakdownEntry[];
}

export interface SourceInfo {
  agent: AgentKind;
  files: number;
  error?: string;
}

export interface DashboardSnapshot {
  version: 1;
  generatedAt: number;
  scanning: boolean;
  firstScanDone: boolean;
  hasData: boolean;
  pricingAsOf: string;
  periods: { today: Period; last7d: Period; last30d: Period; all: Period };
  daily: DailyPoint[];
  breakdown: { last30d: Breakdown; all: Breakdown };
  unpriced: { tokens: number; models: string[] };
  sources: SourceInfo[];
  lastError?: string;
}

export function emptySourceState(): SourceState {
  return { files: {} };
}

export function emptyPeriod(): Period {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, tokens: 0, cost: 0, messages: 0 };
}
