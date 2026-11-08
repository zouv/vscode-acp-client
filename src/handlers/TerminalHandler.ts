import { type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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
import { terminateTree } from '../utils/ProcessTree';
import { mergeEnv, spawnTerminalCommand } from '../utils/TerminalCommand';
import { RetainedPool } from './RetainedPool';

const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
/** Released terminals kept on screen (across all connections when the pool is shared). */
export const RETAINED_TERMINAL_CAP = 10;

export function newRetainedTerminalPool(): RetainedPool<vscode.Terminal> {
  return new RetainedPool<vscode.Terminal>(RETAINED_TERMINAL_CAP, terminal => {
    try { terminal.dispose(); } catch { /* best effort */ }
  });
}

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
  private disposed = false;
  private readonly terminals = new Map<string, ManagedTerminal>();
  private nextId = 1;
  private readonly ownsRetained: boolean;
  private readonly retained: RetainedPool<vscode.Terminal>;

  /** `retained` is shared by the ConnectionManager so the cap holds across reconnects. */
  constructor(retained?: RetainedPool<vscode.Terminal>) {
    this.ownsRetained = !retained;
    this.retained = retained ?? newRetainedTerminalPool();
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    if (this.disposed) { throw new Error('Terminal handler is disposed.'); }
    const terminalId = `term_${this.nextId++}`;
    const args = params.args ?? [];
    log(`createTerminal: ${params.command} (id=${terminalId})`);

    const env = mergeEnv(process.env, Object.fromEntries((params.env ?? []).map(v => [v.name, v.value])));

    const child = spawnTerminalCommand(params.command, args, params.cwd || undefined, env);

    const writer = new vscode.EventEmitter<string>();
    const vsTerminal = vscode.window.createTerminal({
      name: `VAC: ${params.command}`,
      pty: {
        onDidWrite: writer.event,
        open: () => writer.fire(`$ ${params.command} ${args.join(' ')}\r\n`),
        close: () => {
          this.retained.delete(vsTerminal);
          // A reaped pid may already belong to another process.
          if (child.exitCode === null && child.signalCode === null) { terminateTree(child, 'SIGKILL'); }
          writer.dispose();
        },
      },
    });

    const buffer = new TailBuffer(params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT);
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const append = (text: string) => {
      if (!text) { return; }
      buffer.append(Buffer.from(text));
      writer.fire(text.replace(/\n/g, '\r\n'));
    };
    child.stdout?.on('data', (data: Buffer) => append(stdoutDecoder.write(data)));
    child.stderr?.on('data', (data: Buffer) => append(stderrDecoder.write(data)));

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
      child.once('close', (code, signal) => {
        append(stdoutDecoder.end());
        append(stderrDecoder.end());
        if (managed.exitCode === null) { managed.exitCode = code; }
        managed.exitSignal = signal;
        managed.exited = true;
        resolve();
      });
      child.once('error', error => {
        managed.exited = true;
        managed.exitCode = 1;
        buffer.append(Buffer.from(String(error)));
        resolve();
      });
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
    if (t.exited) { return {}; }
    try {
      terminateTree(t.process, 'SIGKILL');
    } catch (e) {
      logError(`Failed to kill terminal ${params.terminalId}`, e);
    }
    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const t = this.require(params.terminalId);
    log(`releaseTerminal: ${params.terminalId}`);
    if (!t.exited) {
      try { terminateTree(t.process, 'SIGKILL'); } catch { /* already gone */ }
    }
    this.terminals.delete(params.terminalId);
    this.retained.add(t.vsTerminal);
    void t.exitPromise.then(() => t.writer.dispose());
    return {};
  }

  /** Stops running commands but leaves their VS Code terminals (and output) in place, up to the retention cap. */
  killAll(): void {
    for (const t of this.terminals.values()) {
      if (!t.exited) { try { terminateTree(t.process, 'SIGKILL'); } catch { /* already gone */ } }
      this.retained.add(t.vsTerminal);
      void t.exitPromise.then(() => t.writer.dispose());
    }
    this.terminals.clear();
  }

  /** The connection is gone: stop its commands and refuse late `terminal/create` calls. */
  retire(): void {
    this.disposed = true;
    this.killAll();
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.terminals.values()) {
      if (!t.exited) { try { terminateTree(t.process, 'SIGKILL'); } catch { /* best effort */ } }
      try { t.vsTerminal.dispose(); } catch { /* best effort */ }
      t.writer.dispose();
    }
    this.terminals.clear();
    if (this.ownsRetained) { this.retained.clear(); }
  }

  private require(terminalId: string): ManagedTerminal {
    const t = this.terminals.get(terminalId);
    if (!t) { throw new Error(`Terminal not found: ${terminalId}`); }
    return t;
  }
}
