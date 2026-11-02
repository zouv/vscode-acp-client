import { abortable } from './Abortable';

export class DeadlineExceededError extends Error {
  constructor(label: string, timeoutMs: number) { super(label + ' timed out after ' + timeoutMs + 'ms.'); this.name = 'DeadlineExceededError'; }
}

/** Bounds an RPC without leaving cancellation listeners or timeout handles behind. */
export async function withDeadline<T>(run: () => Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = async () => {
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceededError(label, timeoutMs)), timeoutMs);
    });
    return Promise.race([run(), expired]);
  };
  try { return await (signal ? abortable(signal, timed) : timed()); }
  finally { if (timer) { clearTimeout(timer); } }
}
