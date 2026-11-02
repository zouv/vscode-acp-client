import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeadline } from './AsyncDeadline';

afterEach(() => { vi.useRealTimers(); });
describe('RPC deadlines', () => {
  it('cleans the deadline on success', async () => {
    vi.useFakeTimers();
    expect(await withDeadline(async () => 42, 20, 'test')).toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a stalled RPC and consumes a late rejection', async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    const run = withDeadline(() => new Promise((_r, r) => { reject = r; }), 20, 'initialize');
    const assertion = expect(run).rejects.toThrow('initialize timed out');
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    reject(new Error('late')); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels promptly and clears the timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = withDeadline(() => new Promise(() => {}), 1000, 'test', controller.signal);
    controller.abort();
    await expect(run).rejects.toThrow('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start an already-cancelled RPC', async () => {
    const controller = new AbortController(); controller.abort();
    const run = vi.fn(async () => 42);
    await expect(withDeadline(run, 20, 'test', controller.signal)).rejects.toThrow('cancelled');
    expect(run).not.toHaveBeenCalled();
  });
});
