import { describe, expect, it } from 'vitest';
import {
  readLanguageForToolText,
  readLanguageFromPath,
  stripReadLineNumbers,
  unlabelledFenceBody,
} from './readHighlight';

const fenced = (body: string, info = ''): string => '```' + info + '\n' + body + '\n```';
const contentOf = (text: string): unknown[] => [{ type: 'content', content: { type: 'text', text } }];

describe('Read language inference', () => {
  it('maps only known extensions, from a single location', () => {
    expect(readLanguageFromPath('/repo/src/app.ts')).toBe('typescript');
    expect(readLanguageFromPath('C:\\repo\\main.PY')).toBe('python');
    expect(readLanguageFromPath('/repo/App.cs')).toBe('csharp');
    expect(readLanguageFromPath('/repo/include/my_header.H')).toBe('cpp');
    expect(readLanguageFromPath('/repo/README.md')).toBe('markdown');
    expect(readLanguageFromPath('/repo/Dockerfile')).toBeUndefined();
    expect(readLanguageFromPath('/repo/.bashrc')).toBeUndefined();
    expect(readLanguageFromPath('/repo/a.unknown')).toBeUndefined();
    expect(readLanguageFromPath('constructor')).toBeUndefined();
  });

  it('uses host content, kind and exactly one location', () => {
    const text = fenced('1\tconst x = 1;');
    expect(readLanguageForToolText('read', [{ path: '/repo/a.ts' }], contentOf(text), text))
      .toBe('typescript');
    expect(readLanguageForToolText('execute', [{ path: '/repo/a.ts' }], contentOf(text), text))
      .toBeUndefined();
    expect(readLanguageForToolText('read', [], contentOf(text), text)).toBeUndefined();
    expect(readLanguageForToolText('read', [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }], contentOf(text), text))
      .toBeUndefined();
    expect(readLanguageForToolText('read', [{ path: '/repo/a.unknown' }], contentOf(text), text))
      .toBeUndefined();
  });

  it('never infers a language for text the tool did not report', () => {
    const text = fenced('1\tconst x = 1;');
    expect(readLanguageForToolText('read', [{ path: '/repo/a.ts' }], contentOf(text), text + ' '))
      .toBeUndefined();
    expect(readLanguageForToolText('read', [{ path: '/repo/a.ts' }], [], text)).toBeUndefined();
  });
});

describe('Read fence parsing', () => {
  it('returns the body of exactly one unlabelled fence', () => {
    expect(unlabelledFenceBody(fenced('1\ta\n2\tb'))).toBe('1\ta\n2\tb');
    expect(unlabelledFenceBody('```\n```')).toBe('');
    expect(unlabelledFenceBody(fenced('1\ta', 'ts'))).toBeUndefined();
    expect(unlabelledFenceBody('const x = 1;')).toBeUndefined();
    expect(unlabelledFenceBody(fenced('a') + '\n' + fenced('b'))).toBeUndefined();
    expect(unlabelledFenceBody(fenced('a\n```\nb'))).toBeUndefined();
    expect(unlabelledFenceBody('```\nno closing fence')).toBeUndefined();
    expect(unlabelledFenceBody('``\ntoo short\n``')).toBeUndefined();
  });

  it('matches marked closing fences, including mixed padding and indentation', () => {
    expect(unlabelledFenceBody(' ```\na\n ```')).toBe('a');
    expect(unlabelledFenceBody('```\na\n````')).toBe('a');
    expect(unlabelledFenceBody('```\na\n```~`')).toBe('a');
    expect(unlabelledFenceBody('  ```\n  1\ta\n  ```')).toBe('1\ta');
    expect(unlabelledFenceBody('```\na\n```\t')).toBeUndefined();
    expect(unlabelledFenceBody('```\na\n```\t ')).toBeUndefined();
  });

  it('rejects a legal close that appears before the end', () => {
    expect(unlabelledFenceBody('```\na\n   ```\nb\n```')).toBeUndefined();
    expect(unlabelledFenceBody('```\na\n```~\nb\n```')).toBeUndefined();
  });

  it('strips strict line-number prefixes and keeps them in order', () => {
    const result = stripReadLineNumbers('1\t#include <iostream>\n2\t// a\n3\t');
    expect(result).toEqual({
      code: '#include <iostream>\n// a\n',
      prefixes: ['1\t', '2\t', '3\t'],
    });
  });

  it('rejects text that is not strictly numbered on every line', () => {
    expect(stripReadLineNumbers('const x = 1;')).toBeUndefined();
    expect(stripReadLineNumbers('1\tconst x = 1;\nconst y = 2;')).toBeUndefined();
    expect(stripReadLineNumbers('1 const x = 1;')).toBeUndefined();
    expect(stripReadLineNumbers('')).toBeUndefined();
  });

  it('normalizes CRLF before stripping', () => {
    expect(stripReadLineNumbers('1\t#include <x>\r\n2\tint main() {}')).toEqual({
      code: '#include <x>\nint main() {}',
      prefixes: ['1\t', '2\t'],
    });
  });
});
