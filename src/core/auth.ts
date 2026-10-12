import * as vscode from 'vscode';
import { RequestError } from '@agentclientprotocol/sdk';

import { log, logError } from '../utils/Logger';
import type { ConnectionInfo } from './ConnectionManager';

/** ACP "auth required" is JSON-RPC code -32000. */
export function isAuthRequiredError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  return (e instanceof RequestError && e.code === -32000)
    || err?.code === -32000
    || (typeof err?.message === 'string' && /auth.?required/i.test(err.message));
}

/** Interactive authentication. Throws when it is impossible, cancelled or fails; the caller reaps the process. */
export async function runAuthFlow(agentName: string, conn: ConnectionInfo): Promise<void> {
  const methods = conn.initResponse.authMethods;
  if (!methods || methods.length === 0) {
    throw new Error(`Agent "${agentName}" requires authentication but did not advertise any auth methods.`);
  }
  log(`Agent requires authentication. Methods: ${methods.map(m => m.name).join(', ')}`);

  let method = methods[0];
  if (methods.length > 1) {
    const picked = await vscode.window.showQuickPick(
      methods.map(m => ({ label: m.name, description: m.description || '', detail: `ID: ${m.id}`, method: m })),
      { placeHolder: 'Select an authentication method', title: `${agentName} requires authentication` },
    );
    if (!picked) { throw new Error('Authentication cancelled by user.'); }
    method = picked.method;
  } else {
    const confirm = await vscode.window.showInformationMessage(
      `${agentName} requires authentication via "${method.name}".`,
      { modal: true, detail: method.description || undefined },
      'Authenticate',
    );
    if (confirm !== 'Authenticate') { throw new Error('Authentication cancelled by user.'); }
  }

  try {
    log(`Authenticating with method: ${method.name} (${method.id})`);
    await conn.connection.authenticate({ methodId: method.id });
    log('Authentication successful');
  } catch (e) {
    logError('Authentication failed', e);
    throw new Error(`Authentication failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
