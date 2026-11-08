import { StringDecoder } from 'node:string_decoder';

/** Turns a byte stream into complete lines: chunk boundaries never split a line or a UTF-8 character. */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private rest = '';

  /** A stream that never emits a newline is flushed in pieces of this many characters. */
  constructor(private readonly maxLine = 64 * 1024) {}

  /** Complete lines in this chunk (without their terminators); the trailing partial line is kept. */
  push(chunk: Buffer | string): string[] {
    const text = this.rest + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    const lines = text.split(/\r?\n/);
    this.rest = lines.pop() ?? '';
    if (this.rest.length >= this.maxLine) {
      lines.push(this.rest);
      this.rest = '';
    }
    return lines;
  }

  /** Whatever is left once the stream ends. */
  end(): string[] {
    const tail = this.rest + this.decoder.end();
    this.rest = '';
    return tail ? [tail] : [];
  }
}
