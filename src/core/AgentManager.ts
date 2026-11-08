import { terminateTree } from '../utils/ProcessTree';
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';

import type { AgentConfigEntry } from '../config/AgentConfig';
import { log, logError } from '../utils/Logger';
import { LineSplitter } from '../utils/LineSplitter';
import { cmdShimCommandLine, isBatchFile, mergeEnv, resolveWindowsCommand } from '../utils/TerminalCommand';
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

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
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
    // No `shell: true`: cmd expands %VAR% even inside quotes. Executables start directly;
    // .cmd shims (npx & friends) go through cmd with every argument quoted and checked.
    const executable = resolveWindowsCommand(command, cwd, env);
    if (isBatchFile(executable)) {
      const line = cmdShimCommandLine(executable, args);
      return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/v:off', '/c', `"${line}"`], {
        stdio, env, cwd, windowsHide: true, windowsVerbatimArguments: true,
      });
    }
    return spawn(executable, args, { stdio, env, cwd, windowsHide: true });
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
    mergeEnv(process.env, config.env),
    cwd || undefined,
  );
}


/** Spawns and reaps ACP agent child processes. Events: agent-stderr, agent-error, agent-closed. */
export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, AgentInstance>();
  private readonly installs = new Map<string, ChildProcess>();
  private readonly installTimers = new Set<NodeJS.Timeout>();
  private readonly dying = new Set<ChildProcess>();
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
    const env = mergeEnv(process.env, config.env);
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
    // Chunk boundaries split lines and UTF-8 characters; the splitter reassembles both.
    const stderrLines = new LineSplitter();
    const emitStderr = (lines: string[]): void => {
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) { continue; }
        log(`[${name} stderr] ${line}`);
        this.emit('agent-stderr', { agentId: id, line });
      }
    };
    child.stderr?.on('data', (data: Buffer) => emitStderr(stderrLines.push(data)));
    child.stderr?.on('end', () => emitStderr(stderrLines.end()));
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
    let child: ChildProcess;
    try {
      child = launchCommand(
        'npm',
        ['install', '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error', spec],
        process.env,
        dir,
        ['ignore', 'ignore', 'pipe'],
      );
    } catch (e) {
      log(`Agent runtime cache for "${agentName}": could not start npm: ${(e as Error)?.message ?? String(e)}`);
      return;
    }
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
      this.trackDying(child);
      const timer = setTimeout(() => {
        if (isAlive(child)) { terminateTree(child, 'SIGKILL'); }
      }, FORCE_KILL_AFTER_MS);
      timer.unref?.();
      child.once('close', () => clearTimeout(timer));
    } catch (e) {
      logError(`Failed to kill agent ${agentId}`, e);
    }
    return true;
  }

  /**
   * The SIGKILL fallback timer is unref'd, so an extension host exiting within
   * FORCE_KILL_AFTER_MS would leave a detached agent that ignores SIGTERM running.
   * `process.on('exit')` only allows synchronous work: `process.kill` of the group is.
   */
  private trackDying(child: ChildProcess): void {
    if (process.platform === 'win32' || !isAlive(child)) { return; } // taskkill /T /F is already forceful
    this.dying.add(child);
    if (this.dying.size === 1) { process.on('exit', this.killSurvivors); }
    child.once('close', () => {
      this.dying.delete(child);
      if (this.dying.size === 0) { process.removeListener('exit', this.killSurvivors); }
    });
  }

  private readonly killSurvivors = (): void => {
    for (const child of this.dying) {
      if (!isAlive(child) || child.pid === undefined) { continue; }
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }
    this.dying.clear();
  };

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
    for (const child of this.installs.values()) { terminateTree(child, 'SIGTERM'); this.trackDying(child); }
    this.installs.clear();
    this.killAll();
    this.removeAllListeners();
  }
}
