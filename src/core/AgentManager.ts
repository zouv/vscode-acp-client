import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';

import type { AgentConfigEntry } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';

const FORCE_KILL_AFTER_MS = 5000;

export interface AgentInstance {
  id: string;
  name: string;
  process: ChildProcess;
  config: AgentConfigEntry;
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Login shells source the user's profile so PATH contains nvm/Homebrew; only
 * POSIX-compatible shells accept `-l -c` reliably.
 */
function resolveUnixShell(): { shell: string; login: boolean } {
  const userShell = process.env.SHELL;
  if (userShell) {
    const base = userShell.split('/').pop() || '';
    if (['zsh', 'bash', 'ksh'].includes(base)) { return { shell: userShell, login: true }; }
    if (['fish', 'sh', 'dash'].includes(base)) { return { shell: userShell, login: false }; }
    log(`User shell "${userShell}" is not POSIX-compatible, falling back to bash/sh`);
  }
  for (const candidate of ['/bin/bash', '/usr/bin/bash']) {
    if (existsSync(candidate)) { return { shell: candidate, login: true }; }
  }
  return { shell: '/bin/sh', login: false };
}

function launch(config: AgentConfigEntry, cwd: string | undefined): ChildProcess {
  const args = config.args ?? [];
  const env = { ...process.env, ...(config.env ?? {}) };
  const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];

  if (process.platform === 'win32') {
    // npx & friends are .cmd shims that only resolve through cmd.exe
    return spawn(config.command, args, { stdio, env, cwd, shell: true, windowsHide: true });
  }

  const { shell, login } = resolveUnixShell();
  const command = [config.command, ...args].map(shellQuote).join(' ');
  return spawn(shell, login ? ['-l', '-c', command] : ['-c', command], {
    stdio,
    env,
    cwd,
    // own process group so the whole npx -> node tree can be signalled at once
    detached: true,
  });
}

function terminateTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid;
  if (pid === undefined) { return; }
  if (process.platform === 'win32') {
    // killing cmd.exe alone orphans the node process behind it
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => { child.kill(); });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Spawns and reaps ACP agent child processes. Events: agent-stderr, agent-error, agent-closed. */
export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, AgentInstance>();
  private nextId = 1;

  spawnAgent(name: string, config: AgentConfigEntry, cwd?: string): AgentInstance {
    const id = `agent_${this.nextId++}`;
    log(`Spawning agent "${name}" (${id}): ${config.command} ${(config.args ?? []).join(' ')}`);

    const child = launch(config, cwd || undefined);
    const instance: AgentInstance = { id, name, process: child, config };
    this.agents.set(id, instance);

    child.stdin?.on('error', () => { /* agent died; the stream layer reports it */ });
    child.stderr?.on('data', (data: Buffer) => {
      for (const raw of data.toString().split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) { continue; }
        log(`[${name} stderr] ${line}`);
        this.emit('agent-stderr', { agentId: id, line });
      }
    });
    child.on('error', err => {
      logError(`Agent "${name}" process error`, err);
      this.emit('agent-error', { agentId: id, name, error: err });
    });
    child.on('close', (code, signal) => {
      log(`Agent "${name}" exited (code=${code}, signal=${signal})`);
      this.agents.delete(id);
      this.emit('agent-closed', { agentId: id, name, code, signal });
    });
    return instance;
  }

  killAgent(agentId: string): boolean {
    const instance = this.agents.get(agentId);
    if (!instance) { return false; }
    log(`Killing agent "${instance.name}" (${agentId})`);

    const { process: child } = instance;
    this.agents.delete(agentId);
    try {
      terminateTree(child, 'SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { terminateTree(child, 'SIGKILL'); }
      }, FORCE_KILL_AFTER_MS);
      timer.unref?.();
      child.once('close', () => clearTimeout(timer));
    } catch (e) {
      logError(`Failed to kill agent ${agentId}`, e);
    }
    return true;
  }

  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  getRunningAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  killAll(): void {
    for (const id of Array.from(this.agents.keys())) { this.killAgent(id); }
  }

  dispose(): void {
    this.killAll();
    this.removeAllListeners();
  }
}
