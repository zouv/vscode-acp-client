import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import type { AgentConfigEntry } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';
import {
  entryFromInstall,
  installDirFor,
  installedMarkerPath,
  npxSpecOf,
  readInstalled,
  writeInstalled,
} from './AgentInstall';

const FORCE_KILL_AFTER_MS = 5000;
/** 等首轮连接稳定之后再在后台缓存运行时，别和 npx 冷启动抢 CPU/网络。 */
const INSTALL_DELAY_MS = 15000;

export interface AgentInstance {
  id: string;
  name: string;
  process: ChildProcess;
  config: AgentConfigEntry;
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** `shell: true` 在 Windows 上只做字符串拼接 —— 带空格的路径（如 `Code - Insiders`）必须自己加引号。 */
function quoteWindowsArg(arg: string): string {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
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

function launchCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  stdio: StdioOptions = ['pipe', 'pipe', 'pipe'],
): ChildProcess {
  if (process.platform === 'win32') {
    // npx & friends are .cmd shims that only resolve through cmd.exe
    const line = [command, ...args].map(quoteWindowsArg).join(' ');
    return spawn(line, { stdio, env, cwd, shell: true, windowsHide: true });
  }

  const { shell, login } = resolveUnixShell();
  const line = [command, ...args].map(shellQuote).join(' ');
  return spawn(shell, login ? ['-l', '-c', line] : ['-c', line], {
    stdio,
    env,
    cwd,
    // own process group so the whole npx -> node tree can be signalled at once
    detached: true,
  });
}

function launch(config: AgentConfigEntry, cwd: string | undefined): ChildProcess {
  return launchCommand(
    config.command,
    config.args ?? [],
    { ...process.env, ...(config.env ?? {}) },
    cwd || undefined,
  );
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
  private readonly installs = new Map<string, ChildProcess>();
  private readonly installTimers = new Set<NodeJS.Timeout>();
  private nextId = 1;

  /** `installRoot` 是扩展的 globalStorage：给了它，npx 启动的 agent 会缓存成 node 直启。 */
  constructor(private readonly installRoot?: string) {
    super();
  }

  spawnAgent(name: string, config: AgentConfigEntry, cwd?: string): AgentInstance {
    const id = `agent_${this.nextId++}`;
    const args = config.args ?? [];
    const spec = npxSpecOf(config.command, args);
    const cached = spec && this.installRoot
      ? readInstalled(installDirFor(this.installRoot, name), spec.spec)
      : null;
    const env = { ...process.env, ...(config.env ?? {}) };
    const child = cached && spec
      // [CUSTOM- 本地缓存命中：直接 `node <entry>`，跳过 `npm exec` 的每次 reify
      // （真机实测 npx 11–17s，直启 ~0.6s）。
      ? launchCommand('node', [cached.entry, ...spec.extraArgs], env, cwd || undefined)
      : launch(config, cwd);
    log(cached
      ? `Spawning agent "${name}" (${id}): node ${cached.entry} (cached runtime${cached.version ? ` v${cached.version}` : ''})`
      : `Spawning agent "${name}" (${id}): ${config.command} ${args.join(' ')}`);
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
    // [CUSTOM- 首次仍走 npx（行为不变），等这一轮连接稳定后再把运行时缓存下来。
    if (spec && this.installRoot && !cached) { this.scheduleInstall(name, spec.spec); }
    return instance;
  }

  /** Cache the npx package locally so the next start can run it with a plain `node`. */
  private scheduleInstall(agentName: string, spec: string): void {
    const key = `${agentName}\u0000${spec}`;
    if (this.installs.has(key)) { return; }
    const timer = setTimeout(() => {
      this.installTimers.delete(timer);
      this.runInstall(agentName, spec);
    }, INSTALL_DELAY_MS);
    timer.unref?.();
    this.installTimers.add(timer);
  }

  private runInstall(agentName: string, spec: string): void {
    if (!this.installRoot) { return; }
    const key = `${agentName}\u0000${spec}`;
    if (this.installs.has(key)) { return; }
    const dir = installDirFor(this.installRoot, agentName);
    try {
      mkdirSync(dir, { recursive: true });
      // [CUSTOM- 换 spec 时清掉旧树与元数据：否则 package.json 里会攒两个依赖，
      // 旧包也不会被 npm prune 掉。
      const marker = installedMarkerPath(dir);
      let previousSpec = '';
      if (existsSync(marker)) {
        try { previousSpec = String((JSON.parse(readFileSync(marker, 'utf8')) as { spec?: unknown }).spec ?? ''); }
        catch { previousSpec = ''; }
      }
      if (previousSpec && previousSpec !== spec) {
        rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
        rmSync(join(dir, 'package.json'), { force: true });
        rmSync(join(dir, 'package-lock.json'), { force: true });
      }
    } catch (e) {
      log(`Agent runtime cache for "${agentName}": could not prepare ${dir}: ${(e as Error)?.message ?? String(e)}`);
      return;
    }

    const started = Date.now();
    log(`Caching agent runtime for "${agentName}" (${spec}) in ${dir}`);
    const child = launchCommand(
      'npm',
      ['install', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error', spec],
      process.env,
      dir,
      ['ignore', 'ignore', 'pipe'],
    );
    this.installs.set(key, child);
    let stderr = '';
    let settled = false;
    child.stderr?.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2000); });
    const finish = (ok: boolean, detail?: string): void => {
      if (settled) { return; }
      settled = true;
      this.installs.delete(key);
      if (!ok) {
        log(`Agent runtime cache failed for "${agentName}" after ${Date.now() - started}ms: ${detail ?? 'unknown error'}`);
        return;
      }
      const found = entryFromInstall(dir, spec);
      if (!found) {
        log(`Agent runtime cache for "${agentName}" produced no runnable bin (see ${dir})`);
        return;
      }
      try {
        writeInstalled(dir, { spec, entry: found.entry, version: found.version, installedAt: Date.now() });
        log(`Agent runtime cached for "${agentName}" in ${Date.now() - started}ms — next start skips npx`);
      } catch (e) {
        log(`Agent runtime cache for "${agentName}": could not write marker: ${(e as Error)?.message ?? String(e)}`);
      }
    };
    child.on('error', err => finish(false, err.message));
    child.on('close', code => finish(code === 0, stderr.trim().slice(-400)));
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
    for (const timer of this.installTimers) { clearTimeout(timer); }
    this.installTimers.clear();
    for (const child of this.installs.values()) { terminateTree(child, 'SIGTERM'); }
    this.installs.clear();
    this.killAll();
    this.removeAllListeners();
  }
}
