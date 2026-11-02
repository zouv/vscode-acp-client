import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileLog } from './FileLog';

describe('bounded file log', () => {
  it('truncates oversized Unicode lines at a complete UTF-8 code point', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vac-log-test-'));
    try {
      const file = join(dir, 'unicode.log');
      const logger = new FileLog(file, 40, 20);
      logger.enqueue('中文'.repeat(100));
      await logger.flush();
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain('�');
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20);
    } finally {
      expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
      expect(basename(dir)).toMatch(/^vac-log-test-/);
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rotates during a running window and bounds queued bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vac-log-test-'));
    try {
      const path = join(dir, 'test.log');
      const logger = new FileLog(path, 40, 20);
      logger.enqueue('first-line-12345');
      await logger.flush();
      logger.enqueue('second-line-1234');
      await logger.flush();
      logger.enqueue('third-line-12345');
      await logger.flush();
      expect((await stat(path)).size).toBeLessThanOrEqual(40);
      expect(await readFile(path + '.1', 'utf8')).toContain('first-line');
      for (let i = 0; i < 100; i++) { logger.enqueue('123456789'); }
      expect(logger.queuedBytes).toBeLessThanOrEqual(20);
      logger.enqueue('x'.repeat(100));
      expect(logger.queuedBytes).toBeLessThanOrEqual(20);
      await Promise.all([logger.flush(), logger.flush()]);
    } finally {
      expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
      expect(basename(dir)).toMatch(/^vac-log-test-/);
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('reports append failures without an unbounded retry loop', async () => {
    const errors: unknown[] = [];
    const logger = new FileLog(join(tmpdir(), 'vac-missing-dir-test', 'test.log'), 40, 20, error => errors.push(error));
    logger.enqueue('message');
    await logger.flush();
    expect(errors).toHaveLength(1);
    expect(logger.queuedBytes).toBe(0);
  });
});
