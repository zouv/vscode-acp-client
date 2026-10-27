// VS Code 配置的三层解析 + 跨 IDE 全局层：设置面板的 scope / source 都由这里算。
// 读取顺序（高 → 低）：工作区 > 用户 > 跨 IDE（~/.vac/config.json）> package.json 默认。
import * as vscode from 'vscode';
import { join } from 'node:path';

import {
  GLOBAL_SETTING_KEYS, ensureGlobalSettingsFile, firstSetLayer, getGlobalValue, globalSettingsPath, setGlobalValue,
  type SettingLayer, type SettingLayerInfo, type SettingSource, type SettingWriteTarget,
} from './GlobalSettings';

/** 设置面板能写的 VS Code 配置键（防止 webview 借 settingAction 写任意键）。 */
export const CONFIG_SETTING_KEYS: ReadonlySet<string> = new Set([
  'vac.autoConnectOnOpen',
  'vac.restoreSessionsOnOpen',
  'vac.defaultWorkingDirectory',
  'vac.autoApprovePermissions',
  'vac.logTraffic',
  'vac.customModels',
  'vac.agents',
]);

export function resolveSetting(key: string, defaultScope: 'global' | 'ide'): SettingSource {
  const inspect = vscode.workspace.getConfiguration('vac').inspect(key);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const layers: SettingLayerInfo[] = [
    {
      layer: 'workspace',
      value: inspect?.workspaceValue,
      file: folder ? join(folder, '.vscode', 'settings.json') : '.vscode/settings.json',
    },
    { layer: 'user', value: inspect?.globalValue, file: 'User settings.json' },
    { layer: 'global', value: GLOBAL_SETTING_KEYS.has(key) ? getGlobalValue(key) : undefined, file: globalSettingsPath() },
    { layer: 'default', value: inspect?.defaultValue, file: 'package.json' },
  ];
  const effective = firstSetLayer(layers);
  const writeTarget: SettingWriteTarget = effective === 'default'
    ? (defaultScope === 'global' ? 'global' : 'user')
    : effective;
  return { effective, writeTarget, layers };
}

/** 写进当前生效层（default 时写该项的默认层），避免"写了却被更高层盖住"。 */
export async function writeSetting(key: string, value: unknown, target: SettingWriteTarget): Promise<void> {
  if (target === 'global') {
    await setGlobalValue(key, value);
    return;
  }
  if (target === 'panel') {
    throw new Error(`not a VS Code setting: ${key}`);
  }
  const useWorkspace = target === 'workspace' && (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  await vscode.workspace.getConfiguration('vac').update(
    key,
    value,
    useWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
  );
}

export async function clearSettingLayer(
  key: string,
  layer: Exclude<SettingLayer, 'panel' | 'default'>,
): Promise<void> {
  if (layer === 'global') {
    await setGlobalValue(key, undefined);
    return;
  }
  await vscode.workspace.getConfiguration('vac').update(
    key,
    undefined,
    layer === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
  );
}

export async function openSettingFile(layer: Exclude<SettingLayer, 'panel' | 'default'>): Promise<void> {
  if (layer === 'workspace') {
    await vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
    return;
  }
  if (layer === 'user') {
    await vscode.commands.executeCommand('workbench.action.openSettingsJson');
    return;
  }
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(ensureGlobalSettingsFile()));
}

/** 设置面板的读写缝：默认走真实 VS Code / 全局文件；宿主测试注入桩，避免碰开发者配置。 */
export interface SettingIO {
  resolve(key: string, defaultScope: 'global' | 'ide'): SettingSource;
  write(key: string, value: unknown, target: SettingWriteTarget): Promise<void>;
  clear(key: string, layer: Exclude<SettingLayer, 'panel' | 'default'>): Promise<void>;
  open(layer: Exclude<SettingLayer, 'panel' | 'default'>): Promise<void>;
}

export function vscodeSettingIO(): SettingIO {
  return { resolve: resolveSetting, write: writeSetting, clear: clearSettingLayer, open: openSettingFile };
}
