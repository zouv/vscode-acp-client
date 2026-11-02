import { appendFile, rename, rm, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export class FileLog {
  private pending: Buffer[] = [];
  private bytes = 0;
  private writing: Promise<void> | undefined;

  constructor(private readonly file: string, private readonly maxFileBytes = 5 * 1024 * 1024, private readonly maxQueueBytes = 1024 * 1024, private readonly onError: (error: unknown) => void = () => {}) {}

  get queuedBytes(): number { return this.bytes; }

  enqueue(text: string): void {
    let data = Buffer.from(text + '\n');
    const limit = Math.min(this.maxQueueBytes, this.maxFileBytes);
    if (data.length > limit) {
      const decoder = new StringDecoder('utf8');
      // Drop an incomplete final code point rather than writing invalid UTF-8.
      data = Buffer.from(decoder.write(data.subarray(0, Math.max(0, limit - 1))) + '\n');
    }
    while (this.bytes + data.length > limit && this.pending.length) { this.bytes -= this.pending.shift()!.length; }
    this.pending.push(data);
    this.bytes += data.length;
  }

  flush(): Promise<void> {
    if (this.writing) { return this.writing; }
    this.writing = this.drain().finally(() => { this.writing = undefined; });
    return this.writing;
  }

  private async drain(): Promise<void> {
    while (this.pending.length) {
      const payload = Buffer.concat(this.pending);
      this.pending = [];
      this.bytes = 0;
      try {
        let size = 0;
        try { size = (await stat(this.file)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
        if (size && size + payload.length > this.maxFileBytes) {
          await rm(this.file + '.1', { force: true });
          await rename(this.file, this.file + '.1');
        }
        await appendFile(this.file, payload);
      } catch (error) { this.onError(error); }
    }
  }
}
