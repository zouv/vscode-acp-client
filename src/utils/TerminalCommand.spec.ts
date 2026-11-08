import { describe, expect, it } from 'vitest';
import { batchCommandLine, cmdShimCommandLine, mergeEnv, resolveWindowsCommand, spawnTerminalCommand } from './TerminalCommand';

describe('terminal argv', () => {
  it('preserves shell syntax as one literal executable argument', async () => {
    const value = 'one & echo ACP_SECOND_COMMAND';
    const child = spawnTerminalCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value], undefined, process.env);
    let output = '';
    child.stdout!.on('data', data => { output += data; });
    await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(String(code)))); });
    expect(output).toBe(value);
  });
  it('quotes safe batch paths and refuses ambiguous shell syntax', () => {
    expect(batchCommandLine('C:/Program Files/tool.cmd', ['two words', ''])).toBe('"C:/Program Files/tool.cmd" "two words" ""');
    for (const arg of ['a&b', '%PATH%', 'a"b', 'a\nb', '!x!', '(x)', 'a^b']) {
      expect(() => batchCommandLine('tool.cmd', [arg])).toThrow(/shell syntax/);
    }
  });
});

describe('cmd shim command line (agent launch)', () => {
  it('quotes every argument and keeps cmd metacharacters literal inside quotes', () => {
    expect(cmdShimCommandLine('C:\\Program Files (x86)\\nodejs\\npx.cmd', ['-y', 'pkg@^1.2.0', 'a&b', 'Code - Insiders']))
      .toBe('"C:\\Program Files (x86)\\nodejs\\npx.cmd" "-y" "pkg@^1.2.0" "a&b" "Code - Insiders"');
  });
  it('refuses % (expanded even inside quotes), quotes and newlines', () => {
    expect(() => cmdShimCommandLine('npx.cmd', ['%USERPROFILE%'])).toThrow(/%/);
    expect(() => cmdShimCommandLine('npx.cmd', ['50%'])).toThrow(/%/);
    expect(() => cmdShimCommandLine('npx.cmd', ['a"b'])).toThrow(/quote/);
    expect(() => cmdShimCommandLine('npx.cmd', ['a\r\nb'])).toThrow(/newline/);
  });
  it('doubles trailing backslashes so the closing quote is not escaped', () => {
    expect(cmdShimCommandLine('x.cmd', ['C:\\dir\\'])).toBe('"x.cmd" "C:\\dir\\\\"');
  });
});

describe('mergeEnv', () => {
  it('lets an override replace an inherited key of another case on win32', () => {
    const env = mergeEnv({ Path: 'C:\\inherited', Other: '1' }, { PATH: 'C:\\agent' }, 'win32');
    expect(env).toEqual({ PATH: 'C:\\agent', Other: '1' });
  });
  it('keeps keys case-sensitive elsewhere', () => {
    expect(mergeEnv({ Path: 'a' }, { PATH: 'b' }, 'linux')).toEqual({ Path: 'a', PATH: 'b' });
  });
  it('later overrides win and the base is not mutated', () => {
    const base = { A: '1' };
    expect(mergeEnv(base, { A: '2' }, 'win32')).toEqual({ A: '2' });
    expect(base).toEqual({ A: '1' });
    expect(mergeEnv(base, undefined)).toEqual({ A: '1' });
  });
});

describe('resolveWindowsCommand', () => {
  const files = new Set(['C:\\node\\npx', 'C:\\node\\npx.cmd', 'C:\\agent\\npx.cmd', 'C:\\work\\npx.cmd', 'C:\\bin\\tool.exe', 'C:\\work\\sub\\run.bat']);
  const exists = (p: string) => files.has(p);

  it('uses the merged PATH, so an agent-supplied PATH wins over the inherited Path', () => {
    const env = mergeEnv({ Path: 'C:\\node' }, { PATH: 'C:\\agent' }, 'win32');
    expect(resolveWindowsCommand('npx', 'C:\\work', env, { exists })).toBe('C:\\agent\\npx.cmd');
  });
  it('skips the extension-less sh shim and honours PATHEXT order', () => {
    expect(resolveWindowsCommand('npx', undefined, { PATH: 'C:\\node' }, { exists })).toBe('C:\\node\\npx.cmd');
    expect(resolveWindowsCommand('tool', undefined, { PATH: 'C:\\bin', PATHEXT: '.JS;.EXE' }, { exists })).toBe('C:\\bin\\tool.exe');
  });
  it('searches the working directory only when asked', () => {
    expect(resolveWindowsCommand('npx', 'C:\\work', { PATH: 'C:\\node' }, { exists })).toBe('C:\\node\\npx.cmd');
    expect(resolveWindowsCommand('npx', 'C:\\work', { PATH: 'C:\\node' }, { exists, searchCwd: true })).toBe('C:\\work\\npx.cmd');
  });
  it('resolves relative paths against cwd and leaves explicit extensions / misses alone', () => {
    expect(resolveWindowsCommand('sub\\run', 'C:\\work', {}, { exists })).toBe('C:\\work\\sub\\run.bat');
    expect(resolveWindowsCommand('node.exe', undefined, { PATH: 'C:\\node' }, { exists })).toBe('node.exe');
    expect(resolveWindowsCommand('missing', undefined, { PATH: 'C:\\node' }, { exists })).toBe('missing');
  });
  it('looks a bare name with an extension up on PATH, not in the workspace first', () => {
    expect(resolveWindowsCommand('npx.cmd', 'C:\\work', { PATH: 'C:\\node' }, { exists })).toBe('C:\\node\\npx.cmd');
  });
});
