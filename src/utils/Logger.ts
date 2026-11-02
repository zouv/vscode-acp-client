import * as vscode from 'vscode';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileLog } from './FileLog';
import { redactTraffic } from './LogPrivacy';

const OUTPUT_NAME = 'VAC';
const TRAFFIC_NAME = 'VAC Traffic';
const FLUSH_INTERVAL_MS = 250;

let outputChannel: vscode.OutputChannel | undefined;
let trafficChannel: vscode.OutputChannel | undefined;
let configListener: vscode.Disposable | undefined;
let trafficEnabled: boolean | undefined;

let logFile: string | null | undefined;
let fileLog: FileLog | undefined;
let flushTimer: NodeJS.Timeout | undefined;

export function logFilePath(): string | null {
  if (logFile !== undefined) { return logFile; }
  logFile = null;
  try {
    const dir = join(process.env.VAC_HOME || join(homedir(), '.vac'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'vac.log');
    logFile = file;
    fileLog = new FileLog(file, undefined, undefined, error => {
      outputChannel?.appendLine('VAC log write failed: ' + String(error));
    });
  } catch { /* no writable home: output channel only */ }
  return logFile;
}

function enqueue(text: string): void {
  if (!logFilePath()) { return; }
  fileLog?.enqueue(text);
  if (!flushTimer) {
    flushTimer = setTimeout(() => { void flushLogs(); }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

export async function flushLogs(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
  await fileLog?.flush();
}

export function getOutputChannel(): vscode.OutputChannel {
  return outputChannel ??= vscode.window.createOutputChannel(OUTPUT_NAME);
}

export function getTrafficChannel(): vscode.OutputChannel {
  return trafficChannel ??= vscode.window.createOutputChannel(TRAFFIC_NAME);
}

export function log(message: string, ...args: unknown[]): void {
  const stamp = new Date().toISOString();
  const line = args.length > 0
    ? `[${stamp}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}`
    : `[${stamp}] ${message}`;
  getOutputChannel().appendLine(line);
  enqueue(line);
}

export function logError(message: string, error?: unknown): void {
  const stamp = new Date().toISOString();
  const detail = error instanceof Error ? error.message : String(error ?? '');
  const line = `[${stamp}] ERROR: ${message} ${detail}`;
  getOutputChannel().appendLine(line);
  enqueue(line);
  if (error instanceof Error && error.stack) {
    getOutputChannel().appendLine(error.stack);
    enqueue(error.stack);
  }
}

function isTrafficEnabled(): boolean {
  if (trafficEnabled === undefined) {
    trafficEnabled = vscode.workspace.getConfiguration('vac').get<boolean>('logTraffic', false);
    configListener ??= vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vac.logTraffic')) { trafficEnabled = undefined; }
    });
  }
  return trafficEnabled;
}

export function logTraffic(direction: 'send' | 'recv', data: unknown): void {
  if (!isTrafficEnabled()) { return; }
  const arrow = direction === 'send' ? '>>> CLIENT → AGENT' : '<<< AGENT → CLIENT';
  const msg = data as Record<string, unknown> | null;
  let label = '';
  if (msg && typeof msg === 'object') {
    if ('method' in msg && 'id' in msg) {
      label = ` [REQUEST] ${msg.method}`;
    } else if ('method' in msg) {
      label = ` [NOTIFICATION] ${msg.method}`;
    } else if ('result' in msg || 'error' in msg) {
      label = ` [RESPONSE] id=${msg.id}`;
    }
  }
  const text = `[${new Date().toISOString()}] ${arrow}${label}\n${JSON.stringify(data, redactTraffic, 2)}\n`;
  getTrafficChannel().appendLine(text);
  enqueue(text);
}

export async function disposeChannels(): Promise<void> {
  await flushLogs();
  configListener?.dispose();
  configListener = undefined;
  trafficEnabled = undefined;
  outputChannel?.dispose();
  trafficChannel?.dispose();
  outputChannel = undefined;
  trafficChannel = undefined;
}
