import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  firstSetLayer,
  getGlobalValue,
  globalSettingsPath,
  parseGlobalSettings,
  readGlobalSettings,
  setGlobalValue,
  type SettingLayerInfo,
} from './GlobalSettings';

describe('GlobalSettings', () => {
  let home: string;
  let previous: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'vac-global-'));
    previous = process.env.VAC_HOME;
    process.env.VAC_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) { delete process.env.VAC_HOME; } else { process.env.VAC_HOME = previous; }
    rmSync(home, { recursive: true, force: true });
  });

  it('uses VAC_HOME and reads an empty map when the file is missing', () => {
    expect(globalSettingsPath()).toBe(join(home, 'config.json'));
    expect(readGlobalSettings()).toEqual({});
    expect(getGlobalValue('vac.customModels')).toBeUndefined();
  });

  it('writes and reads a whitelisted key', async () => {
    await setGlobalValue('vac.customModels', [{ modelId: 'm1', name: 'M' }]);
    expect(getGlobalValue('vac.customModels')).toEqual([{ modelId: 'm1', name: 'M' }]);
    const raw = JSON.parse(readFileSync(globalSettingsPath(), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.values['vac.customModels']).toEqual([{ modelId: 'm1', name: 'M' }]);
  });

  it('deletes the key when the value is undefined', async () => {
    await setGlobalValue('vac.customModels', [{ modelId: 'm1' }]);
    await setGlobalValue('vac.customModels', undefined);
    expect(getGlobalValue('vac.customModels')).toBeUndefined();
  });

  it('refuses keys that are not allowed in the cross-IDE file', async () => {
    await expect(setGlobalValue('vac.apiKey', 'secret')).rejects.toThrow();
    expect(readGlobalSettings()).toEqual({});
  });

  it('ignores malformed files and non-object values', () => {
    expect(parseGlobalSettings('not json')).toEqual({});
    expect(parseGlobalSettings('{"values":[]}')).toEqual({});
    expect(parseGlobalSettings('{"values":{"vac.customModels":[]}}')).toEqual({ 'vac.customModels': [] });
  });

  it('treats an explicit empty array as a set layer', () => {
    const layers: SettingLayerInfo[] = [
      { layer: 'workspace', value: undefined },
      { layer: 'user', value: [] },
      { layer: 'global', value: [{ modelId: 'm1' }] },
      { layer: 'default', value: [] },
    ];
    expect(firstSetLayer(layers)).toBe('user');
    expect(firstSetLayer([{ layer: 'default', value: [] }])).toBe('default');
  });
});
