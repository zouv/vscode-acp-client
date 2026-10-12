import { describe, expect, it } from 'vitest';
import { estimateCost, findPrice, isPriced, PRICING_AS_OF, PRICE_TABLE } from './pricing';

const M = 1_000_000;

describe('pricing', () => {
  it('prices opus, sonnet and haiku families by prefix', () => {
    expect(findPrice('claude-opus-5')?.inputPerM).toBe(5);
    expect(findPrice('claude-sonnet-5.5')?.inputPerM).toBe(3);
    expect(findPrice('claude-haiku-4.5')?.inputPerM).toBe(1);
    expect(findPrice('sonnet')?.outputPerM).toBe(15);
  });

  it('prefers the longest matching prefix', () => {
    expect(findPrice('claude-opus-4-1-20250805')?.inputPerM).toBe(15);
    expect(findPrice('claude-3-5-haiku-20241022')?.inputPerM).toBe(0.8);
  });

  it('strips provider prefixes and context-window suffixes', () => {
    expect(findPrice('claude-sonnet-5.5[1m]')?.inputPerM).toBe(3);
    expect(findPrice('anthropic/claude-haiku-4.5')?.inputPerM).toBe(1);
  });

  it('prices cache writes at 1.25x input and reads at 0.1x input', () => {
    const cost = estimateCost({ model: 'claude-sonnet-5.5', input: M, output: M, cacheCreate: M, cacheRead: M });
    expect(cost).toBeCloseTo(3 + 15 + 3 * 1.25 + 3 * 0.1, 6);
  });

  it('returns 0 for unknown models', () => {
    expect(isPriced('glm-5.3-flash')).toBe(false);
    expect(estimateCost({ model: 'glm-5.3-flash', input: M, output: M, cacheCreate: 0, cacheRead: 0 })).toBe(0);
  });

  it('exposes an edit-friendly table and an as-of marker', () => {
    expect(PRICE_TABLE.every((p) => p.inputPerM >= 0 && p.outputPerM >= 0)).toBe(true);
    expect(PRICING_AS_OF).toMatch(/^\d{4}-\d{2}$/);
  });
});
