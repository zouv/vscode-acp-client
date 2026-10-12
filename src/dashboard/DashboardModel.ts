import { DashboardSnapshot } from './usage/types';

export interface DashboardHost {
  connectionSummary(): Array<{ name: string; connected: boolean; sessions: number }>;
  recentSessions(limit: number): Array<{ agentName: string; sessionId: string; title: string; cwd: string; lastActiveAt: string }>;
  onDidChangeState(cb: () => void): { dispose(): void };
}

export interface DashboardValues {
  usage: DashboardSnapshot;
  connections: ReturnType<DashboardHost['connectionSummary']>;
  sessions: ReturnType<DashboardHost['recentSessions']>;
}

export const DASHBOARD_SESSION_LIMIT = 10;

export const EMPTY_SNAPSHOT: DashboardSnapshot = {
  version: 1,
  generatedAt: 0,
  scanning: false,
  firstScanDone: false,
  hasData: false,
  pricingAsOf: '',
  periods: {
    today: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, tokens: 0, cost: 0, messages: 0 },
    last7d: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, tokens: 0, cost: 0, messages: 0 },
    last30d: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, tokens: 0, cost: 0, messages: 0 },
    all: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, tokens: 0, cost: 0, messages: 0 },
  },
  daily: [],
  breakdown: { last30d: { models: [], projects: [] }, all: { models: [], projects: [] } },
  unpriced: { tokens: 0, models: [] },
  sources: [],
};

export function buildDashboardValues(
  usage: DashboardSnapshot,
  connections: DashboardValues['connections'],
  sessions: DashboardValues['sessions'],
): DashboardValues {
  return { usage, connections, sessions };
}

export function snapshotMessage(
  values: DashboardValues,
  notice?: string,
): {
  type: 'snapshot';
  usage: DashboardSnapshot;
  connections: DashboardValues['connections'];
  sessions: DashboardValues['sessions'];
  notice?: string;
} {
  return { type: 'snapshot', usage: values.usage, connections: values.connections, sessions: values.sessions, notice };
}
