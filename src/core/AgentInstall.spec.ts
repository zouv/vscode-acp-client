import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  entryFromInstall,
  installDirFor,
  REFRESH_AFTER_MS,
  npxSpecOf,
  readInstalled,
  writeInstalled,
} from './AgentInstall';

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vac-agent-install-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) { rmSync(dir, { recursive: true, force: true }); }
});

describe('npxSpecOf', () => {
  it('splits the package spec out of an npx command', () => {
    expect(npxSpecOf('npx', ['-y', 'github:zouv/claude-agent-acp']))
      .toEqual({ spec: 'github:zouv/claude-agent-acp', extraArgs: [] });
  });

  it('accepts the Windows shim and trailing arguments', () => {
    expect(npxSpecOf('npx.cmd', ['--yes', '@scope/pkg@1.2.3', '--flag']))
      .toEqual({ spec: '@scope/pkg@1.2.3', extraArgs: ['--flag'] });
  });

  it('leaves non-npx commands alone', () => {
    expect(npxSpecOf('claude-agent-acp', ['--flag'])).toBeNull();
    expect(npxSpecOf('node', ['script.js'])).toBeNull();
  });

  it('returns null when npx has no package to run', () => {
    expect(npxSpecOf('npx', ['-y'])).toBeNull();
  });
});

describe('installDirFor', () => {
  it('gives each agent one stable directory under agents/', () => {
    expect(installDirFor('/storage', 'Claude Code')).toBe(join('/storage', 'agents', 'claude-code'));
    expect(installDirFor('/storage', 'Claude Code')).toBe(installDirFor('/storage', 'Claude Code'));
  });
});

describe('readInstalled', () => {
  it('accepts a marker whose entry still exists', () => {
    const dir = tempDir();
    const entry = join(dir, 'index.js');
    writeFileSync(entry, '');
    writeInstalled(dir, { spec: 'github:x/y', entry, installedAt: 1000 });
    expect(readInstalled(dir, 'github:x/y', 2000)?.entry).toBe(entry);
  });

  it('rejects a different spec, a missing entry, or an expired install', () => {
    const dir = tempDir();
    const entry = join(dir, 'index.js');
    writeFileSync(entry, '');
    writeInstalled(dir, { spec: 'github:x/y', entry, installedAt: 1000 });
    expect(readInstalled(dir, 'github:x/z', 2000)).toBeNull();
    expect(readInstalled(dir, 'github:x/y', 1000 + REFRESH_AFTER_MS + 1)).toBeNull();
    rmSync(entry);
    expect(readInstalled(dir, 'github:x/y', 2000)).toBeNull();
  });
});

describe('entryFromInstall', () => {
  it('follows the dependency recorded by npm to its bin', () => {
    const dir = tempDir();
    const pkgDir = join(dir, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    writeFileSync(join(pkgDir, 'dist', 'index.js'), '');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: { '@agentclientprotocol/claude-agent-acp': 'github:zouv/claude-agent-acp' },
    }));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: '@agentclientprotocol/claude-agent-acp',
      version: '0.91.0',
      bin: { 'claude-agent-acp': 'dist/index.js' },
    }));

    expect(entryFromInstall(dir, 'github:zouv/claude-agent-acp')).toEqual({
      entry: join(pkgDir, 'dist', 'index.js'),
      version: '0.91.0',
    });
  });

  it('copes with a string bin and skips packages without one', () => {
    const dir = tempDir();
    const pkgDir = join(dir, 'node_modules', 'thing');
    mkdirSync(join(pkgDir, 'bin'), { recursive: true });
    writeFileSync(join(pkgDir, 'bin', 'run.js'), '');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { thing: 'thing@1' } }));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'thing', bin: 'bin/run.js' }));

    expect(entryFromInstall(dir, 'thing@1')?.entry).toBe(join(pkgDir, 'bin', 'run.js'));
  });

  it('returns null when the package has no usable bin', () => {
    const dir = tempDir();
    const pkgDir = join(dir, 'node_modules', 'nobin');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { nobin: 'nobin@1' } }));
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'nobin', main: 'index.js' }));
    expect(entryFromInstall(dir, 'nobin@1')).toBeNull();
  });
});
