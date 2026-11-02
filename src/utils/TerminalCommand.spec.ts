import { describe, expect, it } from 'vitest';
import { batchCommandLine, spawnTerminalCommand } from './TerminalCommand';

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
