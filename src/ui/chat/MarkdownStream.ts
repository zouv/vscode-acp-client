import { SafeMarkdown } from './markdown';

export interface MarkdownStreamFrame {
  source: string;
  blocks: string[];
  tailHtml: string;
}

/** Keep completed top-level blocks, re-lex only the mutable final block.
 * References can affect earlier blocks, so bracket syntax deliberately falls
 * back to a full parse. Final settled HTML always uses SafeMarkdown.render.
 */
export class MarkdownStream {
  private previous = '';
  private stableLength = 0;
  private blocks: string[] = [];

  constructor(private readonly markdown: SafeMarkdown) {}

  render(source: string): MarkdownStreamFrame {
    const text = source.replace(/\r\n?|\r/g, '\n');
    if (!text.startsWith(this.previous) || text.includes('[') || text.length > 262144) {
      this.stableLength = 0;
      this.blocks = [];
    }
    this.previous = text.length > 262144 ? '' : text;
    if (text.includes('[') || text.length > 262144) {
      return { source, blocks: [], tailHtml: this.markdown.render(source) };
    }
    const tokens = this.markdown.lex(text.slice(this.stableLength));
    let last = tokens.length - 1;
    while (last >= 0 && tokens[last].type === 'space') { last--; }
    // Hold the final substantive token AND its trailing whitespace. A list,
    // table, fence or setext heading can still grow across a blank line.
    for (let i = 0; i < last; i++) {
      this.stableLength += tokens[i].raw.length;
      const html = this.markdown.renderTokens([tokens[i]]);
      if (html) { this.blocks.push(html); }
    }
    return { source, blocks: [...this.blocks], tailHtml: this.markdown.renderTokens(tokens.slice(Math.max(0, last))) };
  }
}

/** Small LRU: a surface cannot retain unbounded streaming parser state. */
export class MarkdownStreamCache {
  private readonly streams = new Map<string, MarkdownStream>();
  constructor(private readonly markdown: SafeMarkdown, private readonly limit = 32) {}

  render(key: string, source: string): MarkdownStreamFrame {
    const stream = this.streams.get(key) ?? new MarkdownStream(this.markdown);
    this.streams.delete(key);
    this.streams.set(key, stream);
    while (this.streams.size > this.limit) { this.streams.delete(this.streams.keys().next().value!); }
    return stream.render(source);
  }

  delete(key: string): void { this.streams.delete(key); }
}
