import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const DEFAULT_PATHEXT = ['.com', '.exe', '.bat', '.cmd'];

/**
 * `{ ...base, ...overrides }`, except that on Windows keys are case-insensitive: an override
 * `PATH` replaces an inherited `Path` instead of living beside it (the child would see either).
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!overrides) { return env; }
  for (const [key, value] of Object.entries(overrides)) {
    if (platform === 'win32') {
      const lower = key.toLowerCase();
      for (const existing of Object.keys(env)) {
        if (existing !== key && existing.toLowerCase() === lower) { delete env[existing]; }
      }
    }
    env[key] = value;
  }
  return env;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  const key = Object.keys(env).find(candidate => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : env[key];
}

/**
 * Windows lookup of an extension-less command through PATH × PATHEXT, like cmd.exe does but
 * without its "current directory first" step unless `searchCwd` is set. Returns the original
 * command when nothing matches (the spawn then reports ENOENT).
 */
export function resolveWindowsCommand(
  command: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  opts: { searchCwd?: boolean; exists?: (path: string) => boolean } = {},
): string {
  const exists = opts.exists ?? existsSync;
  const base = cwd || process.cwd();
  // Only what spawn (or cmd for batch files) can start directly; `.js`/`.vbs` would need a host.
  const exts = (envValue(env, 'PATHEXT') || '').split(';').map(ext => ext.trim().toLowerCase()).filter(ext => DEFAULT_PATHEXT.includes(ext));
  // A name that already has an extension (`npx.cmd`) is looked up as-is.
  const candidates = win32.extname(command) ? [''] : exts.length > 0 ? exts : DEFAULT_PATHEXT;
  const dirs = win32.isAbsolute(command)
    ? ['']
    : /[\\/]/.test(command)
      ? [base]
      : [...(opts.searchCwd ? [base] : []), ...(envValue(env, 'PATH') || '').split(';').filter(Boolean)];
  for (const dir of dirs) {
    for (const ext of candidates) {
      const candidate = dir ? win32.join(dir, command + ext) : command + ext;
      if (exists(candidate)) { return candidate; }
    }
  }
  return command;
}

/** Strict quoting for agent-controlled terminal commands: anything cmd.exe could interpret is refused. */
export function batchCommandLine(command: string, args: string[]): string {
  if ([command, ...args].some(value => /[\r\n"&|<>^%!()]/.test(value))) {
    throw new Error('Batch arguments contain shell syntax; use an executable or invoke a shell explicitly.');
  }
  return [command, ...args].map(value => '"' + value + '"').join(' ');
}

/**
 * Quoting for user-configured launches of `.cmd`/`.bat` shims (`npx.cmd`) under
 * `cmd /d /s /v:off /c`: inside quotes `& | < > ^ ( ) !` are literal, but `%VAR%` still
 * expands and `"`/newlines break out, so those are refused. Trailing backslashes are doubled
 * so the shim's eventual C-runtime target does not read `\"` as an escaped quote.
 */
export function cmdShimCommandLine(command: string, args: string[]): string {
  for (const value of [command, ...args]) {
    if (/[\r\n"]/.test(value)) { throw new Error(`Argument cannot be passed through cmd.exe safely (quote or newline): ${value}`); }
    if (value.includes('%')) { throw new Error(`Argument contains "%", which cmd.exe would expand as an environment variable: ${value}`); }
  }
  return [command, ...args].map(value => '"' + value.replace(/(\\+)$/, '$1$1') + '"').join(' ');
}

export function isBatchFile(executable: string): boolean {
  return /\.(cmd|bat)$/i.test(executable);
}

export function spawnTerminalCommand(command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): ChildProcess {
  const executable = process.platform === 'win32' ? resolveWindowsCommand(command, cwd, env, { searchCwd: true }) : command;
  const options = { cwd, env, stdio: 'pipe' as const, windowsHide: true, detached: process.platform !== 'win32' };
  if (process.platform === 'win32' && isBatchFile(executable)) {
    const line = batchCommandLine(executable, args);
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/v:off', '/c', '"' + line + '"'], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(executable, args, options);
}
