#!/usr/bin/env node
// 握手探针：拉起一个 ACP agent，只做 `initialize`（可选再做一次 `session/new`），打印它声明的能力。
//
// **为什么需要它**：接一个新 agent（或适配器换了大版本）时，先要知道它声明了哪些能力、
// 有哪些认证方式、新会话返回哪些配置项——这些决定 `agents/AgentProfile.ts` 要不要分化。
// 只握手、不发 prompt，所以**不花额度**；`--session` 也只建一个空会话（不登录时多半会 -32000，
// 这本身就是要知道的信息）。
//
// 用法：
//   node scripts/probe-agent-init.mjs --agent "npx -y @agentclientprotocol/codex-acp"
//   node scripts/probe-agent-init.mjs --agent "npx -y @agentclientprotocol/codex-acp" --session --out <file.json>
// 可选：--timeout 300000（首次 npx 要下载，给足时间）
//
// 声明的 clientCapabilities 与扩展 `ConnectionManager.connect` 保持一致——agent 的回答可能取决于它。
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const agentCommand = argOf('--agent', 'npx -y @agentclientprotocol/codex-acp');
const outPath = argOf('--out', '');
const timeoutMs = Number(argOf('--timeout', '300000'));
const wantSession = argv.includes('--session');

// agent 可能读写 cwd：放在一次性的临时目录里，绝不在仓库里跑。
const scratch = mkdtempSync(join(tmpdir(), 'acp-init-probe-'));
const child = spawn(agentCommand, { cwd: scratch, shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const stderr = [];
child.stderr.on('data', d => { stderr.push(d.toString()); });

const timer = setTimeout(() => { finish({ error: `timed out after ${timeoutMs}ms` }, 2); }, timeoutMs);

const notifications = [];
const client = {
  async sessionUpdate(params) { notifications.push(params.update?.sessionUpdate ?? 'unknown'); },
  async requestPermission() { return { outcome: { outcome: 'cancelled' } }; },
  async readTextFile() { throw new Error('probe: no fs'); },
  async writeTextFile() { throw new Error('probe: no fs'); },
};

const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const connection = new ClientSideConnection(() => client, stream);

const report = { agent: agentCommand, at: new Date().toISOString() };
try {
  const started = Date.now();
  const init = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: 'vscode-acp-client-probe', version: '0.0.0' },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
      elicitation: { form: {} },
      subagents: {},
      session: { configOptions: { boolean: {} } },
    },
  });
  report.initializeMs = Date.now() - started;
  report.initialize = init;
  if (wantSession) {
    try {
      const session = await connection.newSession({ cwd: scratch, mcpServers: [] });
      report.newSession = session;
    } catch (e) {
      report.newSessionError = { code: e?.code, message: e?.message, data: e?.data };
    }
    // 早到的通知（可用命令 / 配置项）往往跟在响应后面一点点。
    await new Promise(r => setTimeout(r, 1500));
    report.notifications = notifications;
  }
  finish(report, 0);
} catch (e) {
  finish({ ...report, error: e?.message ?? String(e) }, 1);
}

function finish(result, code) {
  clearTimeout(timer);
  result.stderrTail = stderr.join('').split(/\r?\n/).filter(Boolean).slice(-15);
  const text = JSON.stringify(result, null, 2);
  if (outPath) { writeFileSync(resolve(outPath), text + '\n'); }
  process.stdout.write(text + '\n');
  try {
    if (process.platform === 'win32') { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }
    else { child.kill(); }
  } catch { /* already gone */ }
  setTimeout(() => {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* still locked */ }
    process.exit(code);
  }, 500);
}
