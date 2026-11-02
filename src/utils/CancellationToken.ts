import * as vscode from 'vscode';

export async function withCancellationToken<T>(signal: AbortSignal | undefined, run: (token: vscode.CancellationToken) => PromiseLike<T>): Promise<T> {
  const source = new vscode.CancellationTokenSource();
  const cancel = () => source.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) { source.cancel(); }
  try { return await run(source.token); }
  finally { signal?.removeEventListener('abort', cancel); source.dispose(); }
}
