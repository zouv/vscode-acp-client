import { describe, expect, it } from 'vitest';

import { inferAgentKind, isAgentKind, profileFor, resolveDefaultAgent } from './AgentProfile';

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
    expect(inferAgentKind('My Agent', { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] })).toBe('codex');
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

describe('resolveDefaultAgent', () => {
  it('uses the configured agent when it still exists', () => {
    expect(resolveDefaultAgent(['Claude Code', 'Codex CLI'], 'Codex CLI')).toBe('Codex CLI');
    expect(resolveDefaultAgent(['Claude Code', 'Codex CLI'], '  Codex CLI  ')).toBe('Codex CLI');
  });

  it('falls back to the first configured agent', () => {
    expect(resolveDefaultAgent(['Claude Code', 'Codex CLI'], '')).toBe('Claude Code');
    expect(resolveDefaultAgent(['Claude Code', 'Codex CLI'], undefined)).toBe('Claude Code');
    expect(resolveDefaultAgent(['Claude Code', 'Codex CLI'], 'removed agent')).toBe('Claude Code');
  });

  it('returns undefined when no agent is configured', () => {
    expect(resolveDefaultAgent([], 'Codex CLI')).toBeUndefined();
  });
});

describe('agent profiles', () => {
  it('injects custom models as _meta.extraModels for Claude and Codex', () => {
    expect(profileFor('claude').sessionMeta({ customModelIds: ['opus-5', 'sonnet-5'] }))
      .toEqual({ extraModels: ['opus-5', 'sonnet-5'] });
    expect(profileFor('claude').sessionMeta({ customModelIds: [] })).toBeUndefined();
    expect(profileFor('codex').sessionMeta({ customModelIds: ['x'] })).toEqual({ extraModels: ['x'] });
    expect(profileFor('codex').sessionMeta({ customModelIds: [] })).toBeUndefined();
  });

  it('only Claude reads its transcripts and nests tool calls', () => {
    expect(profileFor('claude')).toMatchObject({ transcriptStore: 'claude', nesting: 'claude-code' });
    expect(profileFor('codex')).toMatchObject({ transcriptStore: null, nesting: 'flat' });
    expect(profileFor('generic')).toMatchObject({ transcriptStore: null, nesting: 'flat' });
  });

  it('Claude and Codex fork at a message and accept custom models', () => {
    expect(profileFor('claude')).toMatchObject({ messageFork: true, customModels: true });
    expect(profileFor('codex')).toMatchObject({ messageFork: true, customModels: true });
    expect(profileFor('generic')).toMatchObject({ messageFork: false, customModels: false });
  });
});
