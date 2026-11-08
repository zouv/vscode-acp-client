import { describe, expect, it } from 'vitest';
import { sliceLines } from './FileSlice';

describe('sliceLines', () => {
  const text = 'a\nb\nc\nd';
  it('returns everything without line/limit', () => {
    expect(sliceLines(text)).toBe(text);
    expect(sliceLines(text, null, null)).toBe(text);
  });
  it('treats line as 1-based and limit as a maximum', () => {
    expect(sliceLines(text, 2)).toBe('b\nc\nd');
    expect(sliceLines(text, 2, 2)).toBe('b\nc');
    expect(sliceLines(text, undefined, 1)).toBe('a');
    expect(sliceLines(text, 0, 1)).toBe('a');
    expect(sliceLines(text, 9)).toBe('');
  });
  it('limit 0 reads no lines instead of the whole file', () => {
    expect(sliceLines(text, undefined, 0)).toBe('');
    expect(sliceLines(text, 2, 0)).toBe('');
  });
});
