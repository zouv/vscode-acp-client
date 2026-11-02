import { describe, expect, it } from 'vitest';
import { boundedPayload } from './BoundedPayload';

describe('boundedPayload', () => {
  it('bounds large strings and collections without mutating the input', () => {
    const input = { text: 'a'.repeat(200000), items: Array.from({ length: 10000 }, () => 'b'.repeat(1000)) };
    const result = boundedPayload(input, 65536);
    expect(result.text).toContain('[truncated]');
    expect(JSON.stringify(result).length).toBeLessThan(70000);
    expect(input.text.length).toBe(200000);
  });
  it('bounds deep, circular and many tiny payloads', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(boundedPayload(cycle).self).toBe('[circular]');
    const tiny = Array.from({ length: 1000 }, () => Array.from({ length: 1000 }, () => ({})));
    expect(JSON.stringify(boundedPayload(tiny)).length).toBeLessThan(10000);
  });
});
