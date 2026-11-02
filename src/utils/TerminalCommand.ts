import { existsSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export function batchCommandLine(command: string, args: string[]): string {
  if ([command, ...args].some(value => /[\r\n"&|<>^%!()]/.test(value))) {
    throw new Error('Batch arguments contain shell syntax; use an executable or invoke a shell explicitly.');
  }
  return [command, ...args].map(value => '"' + value + '"').join(' ');
}

export function spawnTerminalCommand(command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): ChildProcess {
  let executable = command;
  if (process.platform === 'win32' && !extname(command)) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
    const dirs = isAbsolute(command) ? [''] : /[\\/]/.test(command) ? [cwd || process.cwd()] : [cwd || process.cwd(), ...(env[pathKey || 'PATH'] || '').split(delimiter)];
    for (const dir of dirs) {
      const candidate = ['', '.exe', '.com', '.cmd', '.bat'].map(ext => dir ? join(dir, command + ext) : command + ext).find(existsSync);
      if (candidate) { executable = candidate; break; }
    }
  }
  const options = { cwd, env, stdio: 'pipe' as const, windowsHide: true, detached: process.platform !== 'win32' };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const line = batchCommandLine(executable, args);
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/v:off', '/c', '"' + line + '"'], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(executable, args, options);
}
