import { describe, expect, it } from 'vitest';
import { SafeMarkdown } from './markdown';

const md = new SafeMarkdown();

describe('SafeMarkdown code blocks', () => {
  it('highlights registered languages with class-only markup', () => {
    const html = md.render('```ts\nconst x: number = 1;\n```');
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain('hljs-keyword');
    expect(html).not.toContain('style=');
  });

  it('escapes unknown languages instead of guessing', () => {
    const html = md.render('```not-a-language\n<script>alert(1)</script>\n```');
    expect(html).not.toContain('<span class="hljs-');
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps mermaid fences as tagged source', () => {
    const html = md.render('```mermaid\ngraph TD\n  A[Start] --> B[End]\n```');
    expect(html).toContain('data-lang="mermaid"');
    expect(html).toContain('data-mermaid="1"');
    expect(html).not.toContain('<span class="hljs-');
    expect(html).toContain('A[Start]');
  });

  it('uses the first info-string token as the language', () => {
    const html = md.render('```ts title="x"\nconst x = 1;\n```');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('hljs-keyword');
  });

  it('skips highlighting for oversized blocks', () => {
    const html = md.render('```ts\n' + 'const x = 1;\n'.repeat(10000) + '```');
    expect(html).toContain('language-ts');
    expect(html).not.toContain('<span class="hljs-');
  });
});

function codeText(html: string): string {
  const code = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? '';
  return code.replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

describe('SafeMarkdown Read code blocks', () => {
  it('strips numbered prefixes, highlights the whole block and puts them back', () => {
    const body = '1\tconst value = "<tag>";\n2\tconsole.log(value);';
    const html = md.render('```\n' + body + '\n```', { readLanguage: 'typescript' });
    expect(html).toContain('language-typescript');
    expect(html).toContain('hljs-keyword');
    expect(html).not.toContain('<tag>');
    expect(codeText(html)).toBe(body);
  });

  it('keeps an explicit language even when a Read context is supplied', () => {
    const html = md.render('```python\nprint("x")\n```', { readLanguage: 'typescript' });
    expect(html).toContain('language-python');
    expect(html).not.toContain('language-typescript');
  });

  it('recognises a C++ preprocessor line and a multi-line comment after removing prefixes', () => {
    const body = '1\t#include <iostream>\n2\t\n3\tint main() {\n4\t    /* multi\n5\t       line */\n6\t    return 0;\n7\t}';
    const html = md.render('```\n' + body + '\n```', { readLanguage: 'cpp' });
    expect(html).toContain('data-lang="cpp"');
    expect(html).toContain('class="hljs language-cpp"');
    expect(html).toContain('hljs-meta');
    expect(html).toContain('hljs-comment');
    expect(html).not.toContain('<iostream>');
    expect(html.match(/<span/g)?.length).toBe(html.match(/<\/span>/g)?.length);
    expect(html).toMatch(/<span class="hljs-comment">[\s\S]*\n5\t[\s\S]*<\/span>/);
    expect(codeText(html)).toBe(body);
  });

  it('highlights a single unlabelled fence even when the agent omitted line numbers', () => {
    const body = '#include <iostream>\nint main() {\n    return 0;\n}';
    const html = md.render('```\n' + body + '\n```', { readLanguage: 'cpp' });
    expect(html).toContain('language-cpp');
    expect(html).toContain('hljs-meta');
    expect(codeText(html)).toBe(body);
  });

  it('highlights a Read of a markdown file as markdown', () => {
    const body = '1\t# Title\n2\t**bold**';
    const html = md.render('```\n' + body + '\n```', { readLanguage: 'markdown' });
    expect(html).toContain('language-markdown');
    expect(html).toContain('hljs-section');
    expect(html).toContain('hljs-strong');
    expect(codeText(html)).toBe(body);
  });

  it('falls back without highlighting when the Read text is not a single unlabelled fence', () => {
    const plain = md.render('plain <script>alert(1)</script>', { readLanguage: 'typescript' });
    expect(plain).not.toContain('hljs-');
    expect(plain).toContain('&lt;script&gt;');
  });

  it('does not highlight a Read block over the size limit', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `${i + 1}\tconst x = "<tag>";`).join('\n');
    const html = md.render('```\n' + body + '\n```', { readLanguage: 'typescript' });
    expect(html).not.toContain('hljs-keyword');
    expect(html).toContain('&lt;tag&gt;');
  });

  it('keeps code textContent/Copy identical to the normal fence renderer', () => {
    const sources = [
      '```\n1\t#include <x>\n2\tint main() {}\n```',
      '```\n\n```',
      '```\r\n1\ta\r\n```',
      '```\n1\ta\n\n```',
      '```\n1\ta\n2\tb\n\n```',
      '```\n1\ta\n2\tb\n```',
      '```\n  1\tline\n 2\tline2\n```',
      '```\n1\t\n2\t\n```',
      '```\n1\tconst s = "a & b < c";\n2\t// 中文 ✓\n```',
      '```\r\n1\ta\r\n\r\n```',
      '```\n1\ta\n\n\n```',
      '```\n1\ta\n2\tb```',
      '```\n1\ta\n```\t ',
      '```\na\n   ```\nb\n```',
      '```\na\n```~\nb\n```',
    ];
    for (const source of sources) {
      const normal = codeText(md.render(source));
      const read = codeText(md.render(source, { readLanguage: 'cpp' }));
      expect(read, JSON.stringify(source)).toBe(normal);
    }
  });
});
