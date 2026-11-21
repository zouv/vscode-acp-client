import { describe, expect, it } from 'vitest';

import { migrateAgentEntry, migrateAgents } from './AgentMigration';

describe('migrateAgentEntry', () => {
  it('swaps the deprecated Codex adapter for the VAC fork and adds -y for npx', () => {
    expect(migrateAgentEntry({ command: 'npx', args: ['@zed-industries/codex-acp@latest'], env: {} }))
      .toEqual({ command: 'npx', args: ['-y', 'github:zouv/codex-acp#main'], env: {} });
  });

  it('keeps an existing -y and the args after the spec', () => {
    expect(migrateAgentEntry({ command: 'npx.cmd', args: ['--yes', '@zed-industries/codex-acp', '--flag'] }))
      .toEqual({ command: 'npx.cmd', args: ['--yes', 'github:zouv/codex-acp#main', '--flag'] });
  });

  it('does not add -y when the command is not npx', () => {
    expect(migrateAgentEntry({ command: 'pnpx', args: ['@zed-industries/codex-acp@0.16.0'] }))
      .toEqual({ command: 'pnpx', args: ['github:zouv/codex-acp#main'] });
  });

  it('moves the official Codex package to the VAC fork', () => {
    expect(migrateAgentEntry({ command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] }))
      .toEqual({ command: 'npx', args: ['-y', 'github:zouv/codex-acp#main'] });
    expect(migrateAgentEntry({ command: 'npx', args: ['@agentclientprotocol/codex-acp@2.8.0'] }))
      .toEqual({ command: 'npx', args: ['-y', 'github:zouv/codex-acp#main'] });
  });

  it('returns null when nothing is deprecated', () => {
    expect(migrateAgentEntry({ command: 'npx', args: ['-y', 'github:zouv/codex-acp#main'] })).toBeNull();
    expect(migrateAgentEntry({ command: 'codex-acp' })).toBeNull();
  });

  it('points the bare Claude adapter fork at the full-history main branch', () => {
    expect(migrateAgentEntry({ command: 'npx', args: ['-y', 'github:zouv/claude-agent-acp'] }))
      .toEqual({
        command: 'npx',
        args: ['-y', 'github:zouv/claude-agent-acp#main'],
      });
  });

  it('replaces the broken commit pin with the main branch', () => {
    expect(migrateAgentEntry({
      command: 'npx',
      args: ['-y', 'github:zouv/claude-agent-acp#dfcefd33ff9ef785a6072f3f44eae1fe757038ca'],
    })).toEqual({
      command: 'npx',
      args: ['-y', 'github:zouv/claude-agent-acp#main'],
    });
  });

  it('does not rewrite a Claude adapter that is already pinned', () => {
    expect(migrateAgentEntry({
      command: 'npx',
      args: ['-y', 'github:zouv/claude-agent-acp#some-other-commit'],
    })).toBeNull();
  });
});

describe('migrateAgents', () => {
  it('reports only the migrated names and keeps the rest untouched', () => {
    const claude = { command: 'npx', args: ['-y', 'claude-agent-acp'] };
    const result = migrateAgents({
      'Claude Code': claude,
      'Codex CLI': { command: 'npx', args: ['@zed-industries/codex-acp@latest'] },
    });
    expect(result.changed).toEqual(['Codex CLI']);
    expect(result.agents['Claude Code']).toBe(claude);
    expect(result.agents['Codex CLI'].args).toEqual(['-y', 'github:zouv/codex-acp#main']);
  });
});
