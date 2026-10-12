import { describe, expect, it } from 'vitest';

import { inferAgentKind, isAgentKind, profileFor } from './AgentProfile';

describe('inferAgentKind', () => {
  it('honours an explicit kind', () => {
    expect(inferAgentKind('Whatever', { kind: 'codex', command: 'claude' })).toBe('codex');
  });

  it('ignores an invalid kind and infers instead', () => {
    expect(inferAgentKind('Codex CLI', { kind: 'nope', command: 'npx' })).toBe('codex');
  });

  it('infers from the name, command or args', () => {
    expect(inferAgentKind('Claude Code', { command: 'npx' })).toBe('claude');
    expect(inferAgentKind('My Agent', { command: 'npx', args: ['@zed-industries/codex-acp@latest'] })).toBe('codex');
    expect(inferAgentKind('My Agent', { command: 'claude-code-acp' })).toBe('claude');
  });

  it('falls back to generic', () => {
    expect(inferAgentKind('Gemini CLI', { command: 'npx', args: ['@google/gemini-cli'] })).toBe('generic');
    expect(inferAgentKind('Nothing', undefined)).toBe('generic');
  });

  it('validates kinds', () => {
    expect(isAgentKind('claude')).toBe(true);
    expect(isAgentKind('Claude')).toBe(false);
    expect(isAgentKind(undefined)).toBe(false);
  });
});

describe('agent profiles', () => {
  it('injects custom models as _meta.extraModels for Claude only', () => {
    expect(profileFor('claude').sessionMeta({ customModelIds: ['opus-5', 'sonnet-5'] }))
      .toEqual({ extraModels: ['opus-5', 'sonnet-5'] });
    expect(profileFor('claude').sessionMeta({ customModelIds: [] })).toBeUndefined();
    expect(profileFor('codex').sessionMeta({ customModelIds: ['x'] })).toBeUndefined();
  });
});
