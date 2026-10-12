import { describe, expect, it } from 'vitest';

import { pickDefaultCwd } from './cwd';

const dirs = (existing: string[]) => (candidate: string) => existing.includes(candidate);

describe('pickDefaultCwd', () => {
  it('prefers a configured absolute directory that exists', () => {
    expect(pickDefaultCwd('/chosen', '/workspace', '/proc', dirs(['/chosen']))).toEqual({
      cwd: '/chosen',
      reason: 'configured',
    });
  });

  it('falls back to the workspace folder when nothing is configured', () => {
    expect(pickDefaultCwd('', '/workspace', '/proc', dirs([]))).toEqual({ cwd: '/workspace', reason: 'workspace' });
  });

  it('falls back to the process cwd when there is no workspace folder', () => {
    expect(pickDefaultCwd(undefined, undefined, '/proc', dirs([]))).toEqual({ cwd: '/proc', reason: 'process' });
  });

  it('ignores a relative configured directory', () => {
    expect(pickDefaultCwd('relative/dir', '/workspace', '/proc', dirs(['relative/dir']))).toEqual({
      cwd: '/workspace',
      reason: 'workspace',
      ignoredConfigured: 'relative',
    });
  });

  it('ignores a configured directory that does not exist', () => {
    expect(pickDefaultCwd('/gone', '/workspace', '/proc', dirs([]))).toEqual({
      cwd: '/workspace',
      reason: 'workspace',
      ignoredConfigured: 'missing',
    });
  });

  it('trims a configured value before deciding', () => {
    expect(pickDefaultCwd('  /chosen  ', '/workspace', '/proc', dirs(['/chosen']))).toEqual({
      cwd: '/chosen',
      reason: 'configured',
    });
  });
});
