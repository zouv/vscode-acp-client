import { runTests } from '@vscode/test-electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await runTests({
  version: process.env.VSCODE_TEST_VERSION || 'stable',
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(root, 'out/test/index.js'),
  launchArgs: ['--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
});
