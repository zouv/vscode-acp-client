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
