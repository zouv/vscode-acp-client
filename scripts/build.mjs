import { execSync } from 'node:child_process';
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

function git(args, fallback) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

const sha = git('rev-parse --short HEAD', 'nogit');
const dirty = git('status --porcelain', '') === '' ? '' : '-dirty';

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: production ? 'external' : 'linked',
  minify: production,
  logLevel: 'info',
  define: {
    __VAC_BUILD_GIT__: JSON.stringify(`${sha}${dirty}`),
    __VAC_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
