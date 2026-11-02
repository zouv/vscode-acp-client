export async function abortable<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  if (signal.aborted) { throw new Error('Request cancelled.'); }
  let rejectCancel: (reason: Error) => void = () => {};
  const cancel = () => rejectCancel(new Error('Request cancelled.'));
  const cancelled = new Promise<never>((_resolve, reject) => { rejectCancel = reject; });
  signal.addEventListener('abort', cancel, { once: true });
  try { return await Promise.race([run(), cancelled]); }
  finally { signal.removeEventListener('abort', cancel); }
}
