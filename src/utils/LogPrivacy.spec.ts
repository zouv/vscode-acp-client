import { describe, expect, it } from 'vitest';
import { redactTraffic } from './LogPrivacy';

describe('traffic privacy', () => {
  it('redacts nested credentials and protocol content, retaining control metadata', () => {
    const result = JSON.stringify({ method: 'session/prompt', params: { sessionId: 's1', prompt: [{ text: 'private message' }], env: { OPENAI_API_KEY: 'private key' }, OPENAI_API_KEY: 'private key', rawOutput: 'private file', authorization: ['private key'] } }, redactTraffic);
    expect(result).not.toContain('private');
    expect(result).toContain('session/prompt');
    expect(result).toContain('s1');
  });
  it('scrubs recognizable credentials in otherwise retained strings', () => {
    expect(JSON.stringify({ message: 'error sk-FAKEVALUE123456 Bearer FAKEVALUE123456' }, redactTraffic)).not.toContain('FAKEVALUE');
  });
});
