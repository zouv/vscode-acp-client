import { ClaudeUsageSource } from './usage/ClaudeUsageSource';
import { CodexUsageSource } from './usage/CodexUsageSource';
import { UsageService } from './usage/UsageService';
import { UsageSource } from './usage/types';
import * as path from 'path';

export interface CreateUsageServiceOptions {
  storageDir: string;
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  now?: () => number;
  watchMode?: 'native' | 'poll' | 'off';
}

export function createUsageService(options: CreateUsageServiceOptions): UsageService {
  const sources: UsageSource[] = [new ClaudeUsageSource(options.claudeProjectsDir), new CodexUsageSource(options.codexSessionsDir)];
  const service = new UsageService({
    sources,
    persistPath: path.join(options.storageDir, 'usage-index.json'),
    now: options.now,
  });
  if (options.watchMode !== 'off') {
    service.startWatching();
  }
  return service;
}

export { DashboardViewProvider } from './DashboardViewProvider';
export type { DashboardHost } from './DashboardModel';
export { UsageService } from './usage/UsageService';
export { ClaudeUsageSource } from './usage/ClaudeUsageSource';
export { CodexUsageSource } from './usage/CodexUsageSource';
export type { UsageEvent, UsageSource, DashboardSnapshot } from './usage/types';
