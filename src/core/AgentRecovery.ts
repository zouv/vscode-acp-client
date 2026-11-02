/** A crash-loop budget persists across successful reconnects until they stay stable. */
export class RecoveryBudget {
  private attempts = 0;
  private connectedAt: number | undefined;
  constructor(private readonly delays: readonly number[] = [1_000, 3_000, 8_000], private readonly stableMs = 60_000) {}
  nextDelay(now = Date.now()): number | undefined {
    if (this.connectedAt !== undefined && now - this.connectedAt >= this.stableMs) { this.attempts = 0; }
    this.connectedAt = undefined;
    return this.delays[this.attempts++];
  }
  connected(now = Date.now()): void { this.connectedAt = now; }
}

export interface RecoveryOptions {
  enabled?: () => boolean;
  delaysMs?: readonly number[];
  resumeTimeoutMs?: number;
}

export function recoveryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Agent recovery cancelled.')); return; }
    const cancelled = () => { clearTimeout(timer); reject(new Error('Agent recovery cancelled.')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancelled); resolve(); }, ms);
    signal.addEventListener('abort', cancelled, { once: true });
  });
}
