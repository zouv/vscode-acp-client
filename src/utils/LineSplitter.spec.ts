import { describe, expect, it } from 'vitest';
import { LineSplitter } from './LineSplitter';

describe('LineSplitter', () => {
  it('joins a line split across chunks and handles CRLF split between them', () => {
    const lines = new LineSplitter();
    expect(lines.push('hel')).toEqual([]);
    expect(lines.push('lo\r')).toEqual([]);
    expect(lines.push('\nworld\nnext')).toEqual(['hello', 'world']);
    expect(lines.end()).toEqual(['next']);
    expect(lines.end()).toEqual([]);
  });
  it('does not garble a UTF-8 character split across chunks', () => {
    const bytes = Buffer.from('错误：中文\n');
    const lines = new LineSplitter();
    const out = [...lines.push(bytes.subarray(0, 4)), ...lines.push(bytes.subarray(4, 8)), ...lines.push(bytes.subarray(8))];
    expect(out).toEqual(['错误：中文']);
  });
  it('flushes an unterminated tail at end and caps a runaway line', () => {
    const lines = new LineSplitter(4);
    expect(lines.push('abcdef')).toEqual(['abcdef']);
    expect(lines.push(Buffer.from('xé'))).toEqual([]);
    expect(lines.end()).toEqual(['xé']);
  });
});
