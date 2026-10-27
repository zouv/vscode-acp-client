// 跨 IDE 的全局配置：`$VAC_HOME/config.json`（默认 `~/.vac/config.json`）。
// 与 VS Code 的用户/工作区设置分开，VS Code / Insiders / VSCodium 共用同一份值。
// 纯逻辑（只依赖 node fs / path），供 vitest 直接加载；VS Code 侧的解析在 SettingScope.ts。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type SettingLayer = 'workspace' | 'user' | 'global' | 'default' | 'panel';
export type SettingWriteTarget = 'workspace' | 'user' | 'global' | 'panel';
export type SettingScope = 'global' | 'ide' | 'panel';

export interface SettingLayerInfo {
  layer: Exclude<SettingLayer, 'panel'>;
  /** `undefined` = 这一层没有设置（与显式的 `[]` / `false` 区分）。 */
  value?: unknown;
  /** 这一层对应的文件（设置面板的 Inspect 用；实际路径以运行环境为准）。 */
  file?: string;
}

export interface SettingSource {
  effective: SettingLayer;
  /** 面板下次编辑会写进哪一层。 */
  writeTarget: SettingWriteTarget;
  /** 高 → 低：workspace / user / global / default。 */
  layers: SettingLayerInfo[];
}

/** 允许写进跨 IDE 文件的键。密钥类配置永远不进这里。 */
export const GLOBAL_SETTING_KEYS: ReadonlySet<string> = new Set(['vac.customModels']);

export function vacHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.VAC_HOME || join(homedir(), '.vac');
}

export function globalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(vacHome(env), 'config.json');
}

export function parseGlobalSettings(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as { values?: unknown } | null;
    const values = parsed && typeof parsed === 'object' ? parsed.values : undefined;
    return values && typeof values === 'object' && !Array.isArray(values)
      ? { ...(values as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

export function readGlobalSettings(): Record<string, unknown> {
  try {
    const file = globalSettingsPath();
    if (!existsSync(file)) { return {}; }
    return parseGlobalSettings(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function getGlobalValue(key: string): unknown {
  return readGlobalSettings()[key];
}

/** 高 → 低找第一层真正设过值的层；全都没设 = 内置默认。 */
export function firstSetLayer(layers: readonly SettingLayerInfo[]): Exclude<SettingLayer, 'panel'> {
  for (const entry of layers) {
    if (entry.value !== undefined) { return entry.layer; }
  }
  return 'default';
}

let writeChain: Promise<void> = Promise.resolve();

/** 串行化同一进程内的写，避免两项设置同时改时互相覆盖。 */
export function setGlobalValue(key: string, value: unknown): Promise<void> {
  if (!GLOBAL_SETTING_KEYS.has(key)) {
    return Promise.reject(new Error(`not a global setting: ${key}`));
  }
  writeChain = writeChain.catch(() => undefined).then(() => writeGlobal(key, value));
  return writeChain;
}

function writeGlobal(key: string, value: unknown): void {
  const values = readGlobalSettings();
  if (value === undefined) { delete values[key]; } else { values[key] = value; }
  const file = globalSettingsPath();
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, values }, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}

/** 设置面板的「Open」需要一个可打开的文件；不存在时先落一份空表。 */
export function ensureGlobalSettingsFile(): string {
  const file = globalSettingsPath();
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ version: 1, values: {} }, null, 2)}\n`, 'utf8');
  }
  return file;
}
