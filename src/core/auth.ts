import * as vscode from 'vscode';
import { RequestError, type AuthMethod } from '@agentclientprotocol/sdk';

import { log, logError } from '../utils/Logger';
import type { ConnectionInfo } from './ConnectionManager';

let secrets: vscode.SecretStorage | undefined;
const inFlight = new WeakMap<ConnectionInfo, Promise<void>>();

/** Where API keys typed into the auth flow are kept (never in settings.json). */
export function setAuthSecrets(storage: vscode.SecretStorage): void { secrets = storage; }

const apiKeySecret = (agentName: string): string => `vac.apiKey.${agentName}`;

/** ACP "auth required" is JSON-RPC code -32000. */
export function isAuthRequiredError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  return (e instanceof RequestError && e.code === -32000)
    || err?.code === -32000
    || (typeof err?.message === 'string' && /auth.?required/i.test(err.message));
}

/**
 * A method marked `_meta['api-key']` takes the key from the client in
 * `authenticate._meta['api-key'].apiKey` (codex-acp's convention; without it the agent
 * falls back to its own environment, e.g. `CODEX_API_KEY` / `OPENAI_API_KEY`).
 */
export function takesApiKey(method: AuthMethod): boolean {
  const meta = method._meta as Record<string, unknown> | null | undefined;
  return !!meta && typeof meta['api-key'] === 'object' && meta['api-key'] !== null;
}

/** Drops the stored API key, e.g. after `logout`. */
export async function forgetApiKey(agentName: string): Promise<void> {
  await secrets?.delete(apiKeySecret(agentName));
}

/**
 * Interactive authentication. Throws when it is impossible, cancelled or fails.
 * Concurrent callers on one connection share a single flow (one dialog, not one per request).
 */
export function runAuthFlow(agentName: string, conn: ConnectionInfo): Promise<void> {
  const running = inFlight.get(conn);
  if (running) { return running; }
  const flow = authenticateOnce(agentName, conn).finally(() => inFlight.delete(conn));
  inFlight.set(conn, flow);
  return flow;
}

async function authenticateOnce(agentName: string, conn: ConnectionInfo): Promise<void> {
  // Terminal methods are run by the client as a TUI and MUST NOT be passed to `authenticate`.
  const methods = (conn.initResponse.authMethods ?? []).filter(m => (m as { type?: unknown }).type !== 'terminal');
  if (methods.length === 0) {
    throw new Error(`Agent "${agentName}" requires authentication but did not advertise any auth methods.`);
  }
  log(`Agent requires authentication. Methods: ${methods.map(m => m.name).join(', ')}`);

  // A key stored by an earlier flow is tried silently first: a restart should not ask again.
  const keyMethod = methods.find(takesApiKey);
  const stored = keyMethod ? await secrets?.get(apiKeySecret(agentName)) : undefined;
  if (keyMethod && stored) {
    try {
      await authenticate(conn, keyMethod, stored);
      return;
    } catch (e) {
      logError('Stored API key was rejected; asking again', e);
      await forgetApiKey(agentName);
    }
  }

  let method = methods[0];
  if (methods.length > 1) {
    const picked = await vscode.window.showQuickPick(
      methods.map(m => ({ label: m.name, description: m.description || '', detail: `ID: ${m.id}`, method: m })),
      { placeHolder: 'Select an authentication method', title: `${agentName} requires authentication` },
    );
    if (!picked) { throw new Error('Authentication cancelled by user.'); }
    method = picked.method;
  } else if (!takesApiKey(method)) {
    const confirm = await vscode.window.showInformationMessage(
      `${agentName} requires authentication via "${method.name}".`,
      { modal: true, detail: method.description || undefined },
      'Authenticate',
    );
    if (confirm !== 'Authenticate') { throw new Error('Authentication cancelled by user.'); }
  }

  let apiKey: string | undefined;
  if (takesApiKey(method)) {
    apiKey = await vscode.window.showInputBox({
      title: `${agentName}: ${method.name}`,
      prompt: 'Kept in VS Code Secret Storage. Leave empty to use the key from the agent\'s environment.',
      password: true,
      ignoreFocusOut: true,
    });
    if (apiKey === undefined) { throw new Error('Authentication cancelled by user.'); }
    apiKey = apiKey.trim() || undefined;
  }

  await authenticate(conn, method, apiKey);
  if (apiKey) { await secrets?.store(apiKeySecret(agentName), apiKey); }
}

async function authenticate(conn: ConnectionInfo, method: AuthMethod, apiKey?: string): Promise<void> {
  try {
    log(`Authenticating with method: ${method.name} (${method.id})`);
    await conn.connection.authenticate({
      methodId: method.id,
      ...(apiKey ? { _meta: { 'api-key': { apiKey } } } : {}),
    });
    log('Authentication successful');
  } catch (e) {
    logError('Authentication failed', e);
    throw new Error(`Authentication failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
