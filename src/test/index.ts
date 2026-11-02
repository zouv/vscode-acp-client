import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

/** Deterministic discovery without loading the CLI/glob/coverage toolchain in Electron. */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 10000 });
  function addTests(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { addTests(file); }
      else if (entry.name.endsWith('.test.js')) { mocha.addFile(file); }
    }
  }
  addTests(__dirname);
  return new Promise((resolve, reject) => {
    mocha.run(failures => failures ? reject(new Error(String(failures) + ' host tests failed')) : resolve());
  });
}
