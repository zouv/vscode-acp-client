import { isAbsolute } from 'node:path';

export interface DefaultCwdDecision {
  cwd: string;
  reason: 'configured' | 'workspace' | 'process';
  ignoredConfigured?: 'relative' | 'missing';
}

/**
 * [CUSTOM- 2026-11-13] Which workspace folder a new session should default to.
 *
 * Multi-root workspaces: prefer the folder of the file the user is editing.
 * When the active editor is not a text editor (e.g. the chat panel itself is
 * open in the editor area), fall back to the last text editor's folder, so the
 * default does not silently snap back to the first root. The first folder is
 * only the last resort.
 */
export function preferredWorkspaceFolder(
  activeFolder: string | undefined,
  lastEditorFolder: string | undefined,
  folders: ReadonlyArray<string>,
): string | undefined {
  return activeFolder || lastEditorFolder || folders[0];
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
