import * as assert from 'assert';
import * as vscode from 'vscode';

import { configurationKey, resolveSetting } from '../config/SettingScope';

const EXTENSION_ID = 'zouv.vscode-acp-client';

const COMMANDS = [
  'vac.connectAgent',
  'vac.newConversation',
  'vac.openChat',
  'vac.openChatInEditor',
  'vac.openChatFromEditorTab',
  'vac.addAgent',
  'vac.removeAgent',
  'vac.showLog',
  'vac.showTraffic',
  'vac.setMode',
  'vac.setModel',
  'vac.attachFile',
  'vac.refreshAgents',
  'vac.refreshSessions',
  'vac.openSession',
  'vac.copySessionId',
  'vac.forgetSession',
  'vac.restartAgent',
  'vac.logoutAgent',
  'vac.refreshDashboard',
  'vac.reloadWebview',
];

suite('extension', () => {
  test('activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} is not present`);
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test('registers every vac.* command', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const id of COMMANDS) {
      assert.ok(registered.has(id), `${id} is not registered`);
    }
  });

  test('rejects commands from the legacy namespace', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    assert.ok(!registered.has('acp.connectAgent'), 'the acp.* namespace must not be re-exported');
    assert.ok(!registered.has('acpc.connectAgent'), 'the acpc.* namespace must not be re-exported');
  });

  test('declares the documented settings', () => {
    const config = vscode.workspace.getConfiguration('vac');
    for (const key of ['agents', 'autoApprovePermissions', 'defaultWorkingDirectory', 'autoAddWorkspaceFolders', 'logTraffic']) {
      assert.notStrictEqual(config.get(key), undefined, `vac.${key} has no default`);
    }
    const agents = config.get<Record<string, { command: string }>>('agents') ?? {};
    assert.ok(agents['Claude Code'], 'Claude Code is not configured by default');
    assert.ok(agents['Codex CLI'], 'Codex CLI is not configured by default');
  });

  // [CUSTOM- 2026-11-13] Regression: `getConfiguration('vac').inspect/update`
  // prefixes the section itself, so passing the full key produced
  // `vac.vac.autoAddWorkspaceFolders` ("not a registered configuration").
  test('setting panel keys are scoped to the vac section exactly once', () => {
    assert.strictEqual(configurationKey('vac.autoAddWorkspaceFolders'), 'autoAddWorkspaceFolders');
    assert.strictEqual(configurationKey('agents'), 'agents');
    const source = resolveSetting('vac.autoAddWorkspaceFolders', 'ide');
    const defaultLayer = source.layers.find(layer => layer.layer === 'default');
    assert.strictEqual(defaultLayer?.value, false, 'the package.json default is visible (no double prefix)');
  });
});
