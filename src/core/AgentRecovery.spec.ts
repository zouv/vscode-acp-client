import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryBudget, recoveryDelay } from './AgentRecovery';
afterEach(() => { vi.useRealTimers(); });
describe('agent recovery', () => {
  it('uses bounded backoff', () => {
    const budget = new RecoveryBudget();
    expect([budget.nextDelay(0), budget.nextDelay(1), budget.nextDelay(2), budget.nextDelay(3)]).toEqual([1000, 3000, 8000, undefined]);
  });
  it('does not reset its budget during a rapid crash loop', () => {
    const budget = new RecoveryBudget([1, 2, 3], 60);
    expect(budget.nextDelay(0)).toBe(1); budget.connected(1);
    expect(budget.nextDelay(2)).toBe(2); budget.connected(3);
    expect(budget.nextDelay(4)).toBe(3); budget.connected(5);
    expect(budget.nextDelay(6)).toBeUndefined();
  });
  it('resets after a stable recovered connection', () => {
    const budget = new RecoveryBudget([1], 60);
    expect(budget.nextDelay(0)).toBe(1); budget.connected(1);
    expect(budget.nextDelay(61)).toBe(1);
  });
  it('cancels a delay and releases the timer', async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const wait = recoveryDelay(1000, controller.signal); controller.abort();
    await expect(wait).rejects.toThrow('cancelled'); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not allocate a timer after cancellation', async () => {
    vi.useFakeTimers(); const controller = new AbortController(); controller.abort();
    await expect(recoveryDelay(1000, controller.signal)).rejects.toThrow('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });
});
