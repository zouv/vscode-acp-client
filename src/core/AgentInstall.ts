import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * [CUSTOM- 把 `npx <spec>` 拆成「包规格 + 透传参数」。
 *
 * 只有 npx 命令可以缓存：`npm exec` 每次启动都要重新做一遍包解析/reify，真机实测
 * 11–17s（`--offline` 也一样），而装好的入口用 `node` 直启只要 ~0.6s。
 * 非 npx 的命令（全局安装的 bin、脚本路径）原样启动，不碰。
 */
export interface NpxLaunch {
  spec: string;
  extraArgs: string[];
}

export interface InstalledAgent {
  spec: string;
  entry: string;
  version?: string;
  installedAt: number;
}

/** 本地安装超过这个时间就认为过期：下一轮启动先走 npx，同时后台刷新。 */
export const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function npxSpecOf(command: string, args: string[]): NpxLaunch | null {
  const base = (command.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(cmd|exe|bat)$/, '');
  if (base !== 'npx') { return null; }
  const index = args.findIndex(arg => !arg.startsWith('-'));
  if (index < 0) { return null; }
  return { spec: args[index], extraArgs: args.slice(index + 1) };
}

/** 每个 agent 一个固定目录：换 spec 时整棵 node_modules 会重建，不会越攒越多。 */
export function installDirFor(root: string, agentName: string): string {
  const key = agentName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'agent';
  return join(root, 'agents', key);
}

export function installedMarkerPath(dir: string): string {
  return join(dir, 'vac-install.json');
}

/** 读不到 / spec 不匹配 / 入口已被删 / 过期 ⇒ null（调用方回退到 npx）。 */
export function readInstalled(dir: string, spec: string, now = Date.now()): InstalledAgent | null {
  try {
    const marker = installedMarkerPath(dir);
    if (!existsSync(marker)) { return null; }
    const data = JSON.parse(readFileSync(marker, 'utf8')) as Partial<InstalledAgent>;
    if (data.spec !== spec) { return null; }
    if (typeof data.entry !== 'string' || !existsSync(data.entry)) { return null; }
    const installedAt = typeof data.installedAt === 'number' ? data.installedAt : 0;
    if (now - installedAt > REFRESH_AFTER_MS) { return null; }
    return {
      spec,
      entry: data.entry,
      ...(typeof data.version === 'string' ? { version: data.version } : {}),
      installedAt,
    };
  } catch {
    return null;
  }
}

export function writeInstalled(dir: string, data: InstalledAgent): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(installedMarkerPath(dir), JSON.stringify(data, null, 2));
}

/**
 * 安装完之后从 `package.json` 的 dependencies 找回包名，再读它的 `bin`。
 * `npm install --prefix <dir> <spec>` 会把 `<包名>: <spec>` 写进 `<dir>/package.json`，
 * 所以这里不需要知道 spec 对应哪个包名。
 */
export function entryFromInstall(dir: string, spec: string): { entry: string; version?: string } | null {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) { return null; }
  let pkg: { dependencies?: Record<string, unknown> } | null = null;
  try { pkg = JSON.parse(readFileSync(manifest, 'utf8')); } catch { return null; }
  const deps = pkg?.dependencies ?? {};
  const matches = Object.keys(deps).filter(name => deps[name] === spec);
  const names = matches.length > 0 ? matches : Object.keys(deps);
  for (const name of names) {
    const metaFile = join(dir, 'node_modules', name, 'package.json');
    if (!existsSync(metaFile)) { continue; }
    let meta: { bin?: unknown; version?: unknown } | null = null;
    try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { continue; }
    const relative = binPathOf(meta?.bin, name);
    if (!relative) { continue; }
    const entry = join(dir, 'node_modules', name, relative);
    if (!existsSync(entry)) { continue; }
    return {
      entry,
      ...(typeof meta?.version === 'string' ? { version: meta.version } : {}),
    };
  }
  return null;
}

function binPathOf(bin: unknown, packageName: string): string | null {
  if (typeof bin === 'string') { return bin; }
  if (!bin || typeof bin !== 'object') { return null; }
  const map = bin as Record<string, unknown>;
  const short = packageName.split('/').pop() || '';
  const key = Object.prototype.hasOwnProperty.call(map, short) ? short : Object.keys(map)[0];
  if (!key) { return null; }
  const value = map[key];
  return typeof value === 'string' ? value : null;
}
