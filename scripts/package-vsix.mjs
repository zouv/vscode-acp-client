import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = join(root, 'release');
const outFile = join(outDir, `${name}-${version}.vsix`);

const vsce = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
if (!existsSync(vsce)) {
  console.error('vsce not found — run `npm install` first.');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

execFileSync(process.execPath, [vsce, 'package', '--out', outFile, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
});
