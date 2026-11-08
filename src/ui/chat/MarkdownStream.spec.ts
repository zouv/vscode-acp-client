import { describe, expect, it } from 'vitest';
import { SafeMarkdown } from './markdown';
import { MarkdownStream, MarkdownStreamCache, streamSourceOf, type MarkdownStreamFrame } from './MarkdownStream';

/** The receiver side: keep [0, start) of the held blocks for the same generation. */
class Receiver {
  generation = -1;
  blocks: string[] = [];
  tailHtml = '';
  apply(frame: MarkdownStreamFrame): void {
    if (frame.start > 0) {
      expect(frame.generation).toBe(this.generation);
      expect(this.blocks.length).toBeGreaterThanOrEqual(frame.start);
    }
    this.blocks = this.blocks.slice(0, frame.start).concat(frame.blocks);
    this.generation = frame.generation;
    this.tailHtml = frame.tailHtml;
  }
  have() { return { generation: this.generation, blocks: this.blocks.length }; }
  html(): string { return this.blocks.join('') + this.tailHtml; }
}

const corpus = [
  '# Heading\n\nFirst **paragraph**.\n\nNext paragraph.\n',
  'Title\n=====\n\n- one\n\n- two\n  continued\n\nAfter list.\n',
  '> quote\n> continued\n\n> another\n\nAfter.\n',
  '~~~ts\nconst x = 1;\n\nconst y = 2;\n~~~\n\nDone.\n',
  '```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n\nAfter.\n',
  '| A | B |\n| - | - |\n| a | b |\n\nEnd.\n',
  'A [reference][id].\n\nAnother paragraph.\n\n[id]: https://example.com\n',
  'A &amp; B\n\n<div>unsafe</div>\n\nAfter.\n',
  'First\r\n\r\nSecond\r\n\r\nThird.',
  '    indented\n\n    continued\n\nAfter.\n',
  'Links [inline](https://a.example) and [shortcut] text.\n\n- [x] task\n- [ ] other\n\nArray a[0] end.\n',
  '> [quoted][q]\n\nMiddle.\n\n> [q]: https://q.example\n',
];

describe('streaming markdown', () => {
  for (const [index, text] of corpus.entries()) {
    it('matches full safe parsing at every character boundary: ' + index, () => {
      const safe = new SafeMarkdown();
      const stream = new MarkdownStream(safe);
      const receiver = new Receiver();
      for (let length = 1; length <= text.length; length++) {
        const source = text.slice(0, length);
        const frame = stream.render(source, receiver.have());
        expect(frame.sourceLength).toBe(source.length);
        receiver.apply(frame);
        expect(receiver.html(), 'prefix ' + length).toBe(safe.render(source));
      }
    });

    it('a requester without state always gets the full block list: ' + index, () => {
      const safe = new SafeMarkdown();
      const stream = new MarkdownStream(safe);
      for (let length = 1; length <= text.length; length += 7) {
        const source = text.slice(0, length);
        const frame = stream.render(source);
        expect(frame.start).toBe(0);
        expect(frame.blocks.join('') + frame.tailHtml).toBe(safe.render(source));
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
    const next = stream.render(prefix + 'tail grows', { generation: initial.generation, blocks: initial.blocks.length });
    expect(next.start).toBe(initial.blocks.length);
    expect(next.blocks).toEqual([]);
    expect(lengths.at(-1)).toBeLessThan(20);
  });

  it('ships only blocks the requester does not hold yet', () => {
    const safe = new SafeMarkdown();
    const stream = new MarkdownStream(safe);
    const receiver = new Receiver();
    receiver.apply(stream.render('one\n\ntwo\n\nthree', receiver.have()));
    expect(receiver.blocks.length).toBe(2);
    const next = stream.render('one\n\ntwo\n\nthree\n\nfour', receiver.have());
    expect(next.start).toBe(2);
    expect(next.blocks).toEqual([safe.render('three')]);
    receiver.apply(next);
    expect(receiver.html()).toBe(safe.render('one\n\ntwo\n\nthree\n\nfour'));
    expect(stream.render('one\n\ntwo\n\nthree\n\nfour', receiver.have()).blocks).toEqual([]);
  });

  it('an unknown or stale generation gets the full list', () => {
    const safe = new SafeMarkdown();
    const stream = new MarkdownStream(safe);
    const first = stream.render('a\n\nb\n\nc');
    expect(stream.render('a\n\nb\n\nc d', { generation: first.generation + 999, blocks: 2 }).start).toBe(0);
    expect(stream.render('a\n\nb\n\nc d e', { generation: first.generation, blocks: 99 }).start).toBe(0);
    const replaced = stream.render('other\n\ntext', { generation: first.generation, blocks: 2 });
    expect(replaced.start).toBe(0);
    expect(replaced.generation).not.toBe(first.generation);
    // A recreated stream (LRU eviction) never reuses an old generation.
    expect(new MarkdownStream(safe).render('a\n\nb\n\nc').generation).not.toBe(first.generation);
  });

  it('plain brackets stay incremental; a link definition forces a full parse', () => {
    const safe = new SafeMarkdown();
    const lengths: number[] = [];
    const lex = safe.lex.bind(safe);
    safe.lex = text => { lengths.push(text.length); return lex(text); };
    const stream = new MarkdownStream(safe);
    const prefix = 'See [the docs](https://example.com) and a[0] index.\n\n'.repeat(400);
    stream.render(prefix + 'tail');
    stream.render(prefix + 'tail grows');
    expect(lengths.at(-1)).toBeLessThan(20);
    const withDefinition = prefix + 'A [ref][id].\n\n[id]: https://example.com';
    const frame = stream.render(withDefinition);
    expect(frame.start).toBe(0);
    expect(frame.blocks).toEqual([]);
    expect(frame.tailHtml).toBe(safe.render(withDefinition));
  });

  it('a definition split across two chunks is still detected', () => {
    const safe = new SafeMarkdown();
    const stream = new MarkdownStream(safe);
    const receiver = new Receiver();
    for (const source of ['A [x][id].\n\n[id]', 'A [x][id].\n\n[id]: https://example.com']) {
      receiver.apply(stream.render(source, receiver.have()));
      expect(receiver.html()).toBe(safe.render(source));
    }
  });

  it('invalidates on replacement or newly introduced reference syntax', () => {
    const safe = new SafeMarkdown();
    const stream = new MarkdownStream(safe);
    stream.render('first\n\nsecond');
    for (const source of ['different\n\nend', 'different\n\nend [x][id]\n\n[id]: https://example.com']) {
      const frame = stream.render(source);
      expect(frame.start).toBe(0);
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

  it('resolves a streaming request against the host text', () => {
    const host = 'abcdefghijklmnopqrstuvwxyz';
    expect(streamSourceOf(host, { text: 'abc' })).toBe('abc');
    expect(streamSourceOf(host, { text: 'abX' })).toBeUndefined();
    expect(streamSourceOf(host, { text: '', textLength: 20, check: host.slice(4, 20) })).toBe(host.slice(0, 20));
    expect(streamSourceOf(host, { text: '', textLength: 20, check: 'nope' })).toBeUndefined();
    expect(streamSourceOf(host, { text: '', textLength: 27, check: '' })).toBeUndefined();
    expect(streamSourceOf(host, { text: '', textLength: 0 })).toBeUndefined();
    expect(streamSourceOf(host, { text: '', textLength: 1.5 })).toBeUndefined();
  });
});
