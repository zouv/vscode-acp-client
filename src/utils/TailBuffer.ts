/**
 * Tail buffer capped at `limit` bytes. Byte accounting is incremental (no
 * re-measuring the whole text per chunk) and the string is only materialised
 * on read.
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private cache: string | null = '';
  truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.cache = null;
    if (this.bytes > this.limit) { this.trim(); }
  }

  text(): string {
    if (this.cache === null) { this.cache = Buffer.concat(this.chunks).toString('utf-8'); }
    return this.cache;
  }

  private trim(): void {
    this.truncated = true;
    let excess = this.bytes - this.limit;
    while (excess > 0 && this.chunks.length > 0) {
      const head = this.chunks[0];
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
        excess -= head.length;
        continue;
      }
      let cut = excess;
      while (cut < head.length && (head[cut] & 0xc0) === 0x80) { cut++; }
      this.chunks[0] = head.subarray(cut);
      this.bytes -= cut;
      excess = 0;
    }
  }
}

