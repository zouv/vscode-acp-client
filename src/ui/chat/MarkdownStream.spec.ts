import { describe, expect, it } from 'vitest';
import { SafeMarkdown } from './markdown';
import { MarkdownStream, MarkdownStreamCache } from './MarkdownStream';

const corpus = [
  '# Heading\n\nFirst **paragraph**.\n\nNext paragraph.\n',
  'Title\n=====\n\n- one\n\n- two\n  continued\n\nAfter list.\n',
  '> quote\n> continued\n\n> another\n\nAfter.\n',
  '~~~ts\nconst x = 1;\n\nconst y = 2;\n~~~\n\nDone.\n',
  '| A | B |\n| - | - |\n| a | b |\n\nEnd.\n',
  'A [reference][id].\n\nAnother paragraph.\n\n[id]: https://example.com\n',
  'A &amp; B\n\n<div>unsafe</div>\n\nAfter.\n',
  'First\r\n\r\nSecond\r\n\r\nThird.',
  '    indented\n\n    continued\n\nAfter.\n',
];

describe('streaming markdown', () => {
  for (const [index, text] of corpus.entries()) {
    it('matches full safe parsing at every character boundary: ' + index, () => {
      const safe = new SafeMarkdown();
      const stream = new MarkdownStream(safe);
      for (let length = 1; length <= text.length; length++) {
        const source = text.slice(0, length);
        const frame = stream.render(source);
        expect(frame.blocks.join('') + frame.tailHtml, 'prefix ' + length).toBe(safe.render(source));
      }
    });
  }

  it('re-lexes only the final block and keeps stable blocks unchanged', () => {
    const safe = new SafeMarkdown();
    const lengths: number[] = [];
    const lex = safe.lex.bind(safe);
    safe.lex = text => { lengths.push(text.length); return lex(text); };
    const stream = new MarkdownStream(safe);
    const prefix = 'A'.repeat(30000) + '\n\n';
    const initial = stream.render(prefix + 'tail');
    const next = stream.render(prefix + 'tail grows');
    expect(next.blocks).toEqual(initial.blocks);
    expect(lengths.at(-1)).toBeLessThan(20);
  });

  it('invalidates on replacement or newly introduced reference syntax', () => {
    const safe = new SafeMarkdown();
    const stream = new MarkdownStream(safe);
    stream.render('first\n\nsecond');
    for (const source of ['different\n\nend', 'different\n\nend [x][id]\n\n[id]: https://example.com']) {
      const frame = stream.render(source);
      expect(frame.blocks.join('') + frame.tailHtml).toBe(safe.render(source));
    }
  });

  it('bounds parser state and releases settled records', () => {
    const cache = new MarkdownStreamCache(new SafeMarkdown(), 2);
    const internal = cache as unknown as { streams: Map<string, unknown> };
    cache.render('a', 'a'); cache.render('b', 'b'); cache.render('a', 'a grows'); cache.render('c', 'c');
    expect([...internal.streams.keys()]).toEqual(['a', 'c']);
    cache.delete('a');
    expect([...internal.streams.keys()]).toEqual(['c']);
  });
});
