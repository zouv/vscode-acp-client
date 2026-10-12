import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';

import { log, logError } from '../utils/Logger';
import { TailBuffer } from '../utils/TailBuffer';

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

export interface TerminalSnapshot {
  output: string;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: string | null;
}

interface ManagedTerminal {
  process: ChildProcess;
  buffer: TailBuffer;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  exitPromise: Promise<void>;
  vsTerminal: vscode.Terminal;
  writer: vscode.EventEmitter<string>;
}

/** Backs the ACP `terminal/*` methods with real child processes mirrored into VS Code terminals. */
export class TerminalHandler {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private nextId = 1;

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = `term_${this.nextId++}`;
    const args = params.args ?? [];
    log(`createTerminal: ${params.command} ${args.join(' ')} (id=${terminalId})`);

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const v of params.env ?? []) { env[v.name] = v.value; }

    const child = spawn(params.command, args, {
      cwd: params.cwd || undefined,
      env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const writer = new vscode.EventEmitter<string>();
    const vsTerminal = vscode.window.createTerminal({
      name: `VAC: ${params.command}`,
      pty: {
        onDidWrite: writer.event,
        open: () => writer.fire(`$ ${params.command} ${args.join(' ')}\r\n`),
        close: () => { /* output stays visible per ACP spec */ },
      },
    });

    const buffer = new TailBuffer(params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT);
    const onData = (data: Buffer) => {
      buffer.append(data);
      writer.fire(data.toString().replace(/\n/g, '\r\n'));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const managed: ManagedTerminal = {
      process: child,
      buffer,
      exitCode: null,
      exitSignal: null,
      exited: false,
      exitPromise: Promise.resolve(),
      vsTerminal,
      writer,
    };
    managed.exitPromise = new Promise<void>(resolve => {
      child.on('close', (code, signal) => {
        managed.exitCode = code;
        managed.exitSignal = signal;
        managed.exited = true;
        resolve();
      });
      child.on('error', () => resolve());
    });

    this.terminals.set(terminalId, managed);
    return { terminalId };
  }

  /** Non-throwing read for the chat panel; null for unknown or released ids. */
  readOutput(terminalId: string): TerminalSnapshot | null {
    const t = this.terminals.get(terminalId);
    if (!t) { return null; }
    return {
      output: t.buffer.text(),
      truncated: t.buffer.truncated,
      exited: t.exited,
      exitCode: t.exitCode,
      exitSignal: t.exitSignal,
    };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const t = this.require(params.terminalId);
    const response: TerminalOutputResponse = { output: t.buffer.text(), truncated: t.buffer.truncated };
    if (t.exited) { response.exitStatus = { exitCode: t.exitCode, signal: t.exitSignal }; }
    return response;
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const t = this.require(params.terminalId);
    await t.exitPromise;
    return { exitCode: t.exitCode, signal: t.exitSignal };
  }

  async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const t = this.require(params.terminalId);
    try {
      t.process.kill('SIGTERM');
    } catch (e) {
      logError(`Failed to kill terminal ${params.terminalId}`, e);
    }
    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const t = this.require(params.terminalId);
    log(`releaseTerminal: ${params.terminalId}`);
    if (!t.exited) {
      try { t.process.kill('SIGTERM'); } catch { /* already gone */ }
    }
    this.terminals.delete(params.terminalId);
    return {};
  }

  /** Stops running commands but leaves their VS Code terminals (and output) in place. */
  killAll(): void {
    for (const t of this.terminals.values()) {
      if (t.exited) { continue; }
      try { t.process.kill('SIGKILL'); } catch { /* already gone */ }
    }
    this.terminals.clear();
  }

  dispose(): void {
    for (const t of this.terminals.values()) {
      try {
        if (!t.exited) { t.process.kill('SIGKILL'); }
        t.vsTerminal.dispose();
        t.writer.dispose();
      } catch { /* best effort */ }
    }
    this.terminals.clear();
  }

  private require(terminalId: string): ManagedTerminal {
    const t = this.terminals.get(terminalId);
    if (!t) { throw new Error(`Terminal not found: ${terminalId}`); }
    return t;
  }
}
