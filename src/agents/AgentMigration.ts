export interface MigratableAgentEntry {
  command?: string;
  args?: string[];
}

/** Adapter packages that were deprecated upstream, and what replaces them. */
const REPLACEMENTS: ReadonlyArray<{ from: RegExp; to: string }> = [
  // Archived 2026-07; npm marks it deprecated and it is frozen at 0.16.0.
  { from: /^@zed-industries\/codex-acp(@.*)?$/, to: '@agentclientprotocol/codex-acp' },
];

const isNpx = (command: string | undefined): boolean =>
  (command?.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(cmd|exe|bat)$/, '') === 'npx';

/** The entry with deprecated adapter specs swapped out, or null when nothing changes. */
export function migrateAgentEntry<T extends MigratableAgentEntry>(entry: T): T | null {
  const args = entry.args ?? [];
  let changed = false;
  const next = args.map(arg => {
    const hit = REPLACEMENTS.find(r => r.from.test(arg));
    if (!hit) { return arg; }
    changed = true;
    return hit.to;
  });
  if (!changed) { return null; }
  // `-y` keeps npx from stopping at an install prompt the first time it fetches the new package.
  if (isNpx(entry.command) && !next.includes('-y') && !next.includes('--yes')) { next.unshift('-y'); }
  return { ...entry, args: next };
}

/** Every agent whose entry needs migrating, with the migrated map. */
export function migrateAgents<T extends MigratableAgentEntry>(
  agents: Record<string, T>,
): { agents: Record<string, T>; changed: string[] } {
  const out: Record<string, T> = {};
  const changed: string[] = [];
  for (const [name, entry] of Object.entries(agents)) {
    const migrated = entry && typeof entry === 'object' ? migrateAgentEntry(entry) : null;
    out[name] = migrated ?? entry;
    if (migrated) { changed.push(name); }
  }
  return { agents: out, changed };
}
