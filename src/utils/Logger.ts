import * as vscode from 'vscode';
import { appendFile, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OUTPUT_NAME = 'VAC';
const TRAFFIC_NAME = 'VAC Traffic';
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
const FLUSH_INTERVAL_MS = 250;
const TRAFFIC_STRING_LIMIT = 2000;

let outputChannel: vscode.OutputChannel | undefined;
let trafficChannel: vscode.OutputChannel | undefined;
let configListener: vscode.Disposable | undefined;
let trafficEnabled: boolean | undefined;

let logFile: string | null | undefined;
let pending: string[] = [];
let flushTimer: NodeJS.Timeout | undefined;
let flushing = false;

export function logFilePath(): string | null {
  if (logFile !== undefined) { return logFile; }
  logFile = null;
  try {
    const dir = join(process.env.VAC_HOME || join(homedir(), '.vac'));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'vac.log');
    try {
      if (statSync(file).size > LOG_FILE_MAX_BYTES) {
        rmSync(`${file}.1`, { force: true });
        renameSync(file, `${file}.1`);
      }
    } catch { /* missing file or failed rotation: keep appending */ }
    logFile = file;
  } catch { /* no writable home: output channel only */ }
  return logFile;
}

function enqueue(text: string): void {
  if (!logFilePath()) { return; }
  pending.push(text);
  if (!flushTimer) {
    flushTimer = setTimeout(flushLogs, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }
}

export function flushLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  const file = logFile;
  if (!file || flushing || pending.length === 0) { return; }
  const payload = pending.join('\n') + '\n';
  pending = [];
  flushing = true;
  appendFile(file, payload, () => {
    flushing = false;
    if (pending.length > 0 && !flushTimer) {
      flushTimer = setTimeout(flushLogs, FLUSH_INTERVAL_MS);
      flushTimer.unref?.();
    }
  });
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
    trafficEnabled = vscode.workspace.getConfiguration('vac').get<boolean>('logTraffic', true);
    configListener ??= vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('vac.logTraffic')) { trafficEnabled = undefined; }
    });
  }
  return trafficEnabled;
}

const SECRET_KEY = /^(api_?key|token|access_?token|password|secret|authorization)$/i;

function clip(key: string, value: unknown): unknown {
  // Credentials ride in requests too (e.g. `authenticate._meta['api-key'].apiKey`): never log them.
  if (SECRET_KEY.test(key) && typeof value === 'string') { return '«redacted»'; }
  if (typeof value === 'string' && value.length > TRAFFIC_STRING_LIMIT) {
    return `${value.slice(0, TRAFFIC_STRING_LIMIT)}…(+${value.length - TRAFFIC_STRING_LIMIT} chars)`;
  }
  return value;
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
  const text = `[${new Date().toISOString()}] ${arrow}${label}\n${JSON.stringify(data, clip, 2)}\n`;
  getTrafficChannel().appendLine(text);
  enqueue(text);
}

export function disposeChannels(): void {
  flushLogs();
  configListener?.dispose();
  configListener = undefined;
  trafficEnabled = undefined;
  outputChannel?.dispose();
  trafficChannel?.dispose();
  outputChannel = undefined;
  trafficChannel = undefined;
}
