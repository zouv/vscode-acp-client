import { isAbsolute } from 'node:path';

export interface DefaultCwdDecision {
  cwd: string;
  reason: 'configured' | 'workspace' | 'process';
  ignoredConfigured?: 'relative' | 'missing';
}

/**
 * A configured directory that is relative or missing is rejected rather than
 * passed on: `session/new` with a bogus cwd fails deep inside the agent where
 * the reason is hard to see.
 */
export function pickDefaultCwd(
  configured: string | undefined,
  workspaceFolder: string | undefined,
  processCwd: string,
  isDirectory: (candidate: string) => boolean,
): DefaultCwdDecision {
  const trimmed = typeof configured === 'string' ? configured.trim() : '';
  const reason: 'workspace' | 'process' = workspaceFolder ? 'workspace' : 'process';
  const cwd = workspaceFolder || processCwd;
  if (!trimmed) {
    return { cwd, reason };
  }
  if (!isAbsolute(trimmed)) {
    return { cwd, reason, ignoredConfigured: 'relative' };
  }
  if (!isDirectory(trimmed)) {
    return { cwd, reason, ignoredConfigured: 'missing' };
  }
  return { cwd: trimmed, reason: 'configured' };
}
