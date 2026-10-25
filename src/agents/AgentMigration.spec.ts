import { describe, expect, it } from 'vitest';

import { migrateAgentEntry, migrateAgents } from './AgentMigration';

describe('migrateAgentEntry', () => {
  it('swaps the deprecated Codex adapter and adds -y for npx', () => {
    expect(migrateAgentEntry({ command: 'npx', args: ['@zed-industries/codex-acp@latest'], env: {} }))
      .toEqual({ command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'], env: {} });
  });

  it('keeps an existing -y and the args after the spec', () => {
    expect(migrateAgentEntry({ command: 'npx.cmd', args: ['--yes', '@zed-industries/codex-acp', '--flag'] }))
      .toEqual({ command: 'npx.cmd', args: ['--yes', '@agentclientprotocol/codex-acp', '--flag'] });
  });

  it('does not add -y when the command is not npx', () => {
    expect(migrateAgentEntry({ command: 'pnpx', args: ['@zed-industries/codex-acp@0.16.0'] }))
      .toEqual({ command: 'pnpx', args: ['@agentclientprotocol/codex-acp'] });
  });

  it('returns null when nothing is deprecated', () => {
    expect(migrateAgentEntry({ command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] })).toBeNull();
    expect(migrateAgentEntry({ command: 'codex-acp' })).toBeNull();
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
    expect(result.agents['Codex CLI'].args).toEqual(['-y', '@agentclientprotocol/codex-acp']);
  });
});
