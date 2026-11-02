import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
// The SDK is ESM-only. Production bundles it; CommonJS tsc test output must
// use the same bundling strategy on the minimum VS Code host (Node18).
const dir = 'out/node_modules/@agentclientprotocol/sdk';
await mkdir(dir, { recursive: true });
await build({
  entryPoints: [require.resolve('@agentclientprotocol/sdk')],
  outfile: dir + '/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
});
await writeFile(dir + '/package.json', JSON.stringify({ name: '@agentclientprotocol/sdk', main: 'index.cjs' }));
// Bundle the modern Mocha programmatic API for Electron's Node18 runtime.
// CLI discovery, watch mode and parallel workers are intentionally not used.
const mochaDir = 'out/node_modules/mocha';
await mkdir(mochaDir, { recursive: true });
await build({
  entryPoints: [require.resolve('mocha')],
  outfile: mochaDir + '/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  plugins: [{
    name: 'serial-host-tests',
    setup(build) {
      build.onResolve({ filter: /parallel-buffered-runner/ }, () => ({ path: 'serial-only', namespace: 'serial-only' }));
      build.onLoad({ filter: /.*/, namespace: 'serial-only' }, () => ({ contents: 'throw new Error("Parallel host tests are unsupported");', loader: 'js' }));
    },
  }],
});
await writeFile(mochaDir + '/package.json', JSON.stringify({ name: 'mocha', main: 'index.cjs' }));
const args = [require.resolve('typescript/bin/tsc'), '-p', '.', '--outDir', 'out'];
if (process.argv.includes('--watch')) { args.push('--watch'); }
execFileSync(process.execPath, args, { stdio: 'inherit' });
