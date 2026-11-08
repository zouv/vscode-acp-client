import { describe, expect, it } from 'vitest';
import { RetainedPool } from './RetainedPool';

describe('RetainedPool', () => {
  it('disposes the oldest items beyond the cap', () => {
    const disposed: number[] = [];
    const pool = new RetainedPool<number>(2, n => disposed.push(n));
    pool.add(1); pool.add(2); pool.add(3);
    expect(disposed).toEqual([1]);
    expect(pool.size).toBe(2);
  });
  it('re-adding refreshes recency; delete forgets without disposing; clear disposes the rest', () => {
    const disposed: number[] = [];
    const pool = new RetainedPool<number>(2, n => disposed.push(n));
    pool.add(1); pool.add(2); pool.add(1); pool.add(3);
    expect(disposed).toEqual([2]);
    pool.delete(1);
    pool.clear();
    expect(disposed).toEqual([2, 3]);
    expect(pool.size).toBe(0);
  });
});
