import { SafeMarkdown } from './markdown';

/**
 * One streaming render. Blocks are a DELTA: `blocks` are the stable blocks from
 * index `start` onward; the receiver keeps `[0, start)` from the frame it already
 * holds for the same `generation`. `start === 0` means "replace everything".
 */
export interface MarkdownStreamFrame {
  /** Characters of the (un-normalised) source this frame renders. */
  sourceLength: number;
  /** Bumps whenever the stable block list is rebuilt from scratch. */
  generation: number;
  start: number;
  blocks: string[];
  tailHtml: string;
}

/** What the requester already holds, so only newer stable blocks are shipped. */
export interface MarkdownStreamHave {
  generation: number;
  blocks: number;
}

/** A link reference definition ("[label]: url") can change how EARLIER blocks render.
 * Any "]:" is treated as one: a cheap, linear superset test. */
const LINK_DEFINITION = /\]:/;
const STREAM_LIMIT = 262144;
/** Process-wide, so a stream recreated after LRU eviction never reuses a generation. */
let generationSeq = 0;

/** Keep completed top-level blocks, re-lex only the mutable final block.
 * Link reference definitions affect earlier blocks, so their presence
 * deliberately falls back to a full parse. Final settled HTML always uses
 * SafeMarkdown.render.
 */
export class MarkdownStream {
  private previous = '';
  private stableLength = 0;
  private blocks: string[] = [];
  private generation = ++generationSeq;
  private definition = false;

  constructor(private readonly markdown: SafeMarkdown) {}

  render(source: string, have?: MarkdownStreamHave): MarkdownStreamFrame {
    const text = source.replace(/\r\n?|\r/g, '\n');
    const extendsPrevious = this.previous.length > 0 && text.startsWith(this.previous);
    // Only the new suffix (plus one char, for a "]:" split across chunks) needs scanning.
    this.definition = extendsPrevious
      ? this.definition || LINK_DEFINITION.test(text.slice(this.previous.length - 1))
      : LINK_DEFINITION.test(text);
    const full = text.length > STREAM_LIMIT || this.definition;
    if (!extendsPrevious || full) {
      if (this.stableLength > 0 || this.blocks.length > 0) { this.generation = ++generationSeq; }
      this.stableLength = 0;
      this.blocks = [];
    }
    this.previous = text.length > STREAM_LIMIT ? '' : text;
    if (full) {
      return { sourceLength: source.length, generation: this.generation, start: 0, blocks: [], tailHtml: this.markdown.render(source) };
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
    const start = have && have.generation === this.generation && have.blocks >= 0 && have.blocks <= this.blocks.length
      ? have.blocks
      : 0;
    return {
      sourceLength: source.length,
      generation: this.generation,
      start,
      blocks: this.blocks.slice(start),
      tailHtml: this.markdown.renderTokens(tokens.slice(Math.max(0, last))),
    };
  }
}

/** Small LRU: a surface cannot retain unbounded streaming parser state. */
export class MarkdownStreamCache {
  private readonly streams = new Map<string, MarkdownStream>();
  constructor(private readonly markdown: SafeMarkdown, private readonly limit = 32) {}

  render(key: string, source: string, have?: MarkdownStreamHave): MarkdownStreamFrame {
    const stream = this.streams.get(key) ?? new MarkdownStream(this.markdown);
    this.streams.delete(key);
    this.streams.set(key, stream);
    while (this.streams.size > this.limit) { this.streams.delete(this.streams.keys().next().value!); }
    return stream.render(source, have);
  }

  delete(key: string): void { this.streams.delete(key); }
}

/**
 * The prefix of the host's live text a streaming request refers to, or undefined
 * when the two sides disagree. A length-based request (`textLength` + `check`, the
 * last <=16 chars) avoids uploading the whole growing text every frame; a legacy
 * request carries the full prefix in `text`.
 */
export function streamSourceOf(
  current: string,
  item: { text: string; textLength?: number; check?: string },
): string | undefined {
  if (typeof item.textLength === 'number') {
    const length = item.textLength;
    if (!Number.isInteger(length) || length <= 0 || length > current.length) { return undefined; }
    const check = typeof item.check === 'string' ? item.check : '';
    if (check.length > length || !current.startsWith(check, length - check.length)) { return undefined; }
    return current.slice(0, length);
  }
  return current.startsWith(item.text) ? item.text : undefined;
}
