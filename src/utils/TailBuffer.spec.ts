import { describe, expect, it } from 'vitest';

import { TailBuffer } from './TailBuffer';

describe('TailBuffer', () => {
  it('joins chunks in order', () => {
    const buffer = new TailBuffer(1024);
    buffer.append(Buffer.from('hello '));
    buffer.append(Buffer.from('world'));
    expect(buffer.text()).toBe('hello world');
    expect(buffer.truncated).toBe(false);
  });

  it('keeps only the newest bytes once over the limit', () => {
    const buffer = new TailBuffer(5);
    buffer.append(Buffer.from('aaa'));
    buffer.append(Buffer.from('bbb'));
    expect(buffer.text()).toBe('aabbb');
    expect(buffer.truncated).toBe(true);
  });

  it('never splits a multi-byte character', () => {
    const buffer = new TailBuffer(5);
    buffer.append(Buffer.from('你'));  // 3 bytes
    buffer.append(Buffer.from('好'));  // 3 bytes -> trims one byte of overlap
    const text = buffer.text();
    expect(text).toBe('好');
    expect(buffer.truncated).toBe(true);
  });

  it('drops whole leading chunks when they no longer fit', () => {
    const buffer = new TailBuffer(4);
    buffer.append(Buffer.from('ab'));
    buffer.append(Buffer.from('cd'));
    buffer.append(Buffer.from('ef'));
    expect(buffer.text()).toBe('cdef');
  });
});
