export interface MigratableAgentEntry {
  command?: string;
  args?: string[];
}

/** Adapter packages that were deprecated upstream, and what replaces them. */
const CODEX_FORK = 'github:zouv/codex-acp#main';

const REPLACEMENTS: ReadonlyArray<{ from: RegExp; to: string }> = [
  // Archived 2026-07; npm marks it deprecated and it is frozen at 0.16.0.
  { from: /^@zed-industries\/codex-acp(@.*)?$/, to: CODEX_FORK },
  // The VAC fork tracks upstream main and only carries adapter-side fixes that
  // upstream has not accepted yet; the default config points here for both agents.
  { from: /^@agentclientprotocol\/codex-acp(@.*)?$/, to: CODEX_FORK },
  { from: /^github:zouv\/codex-acp$/, to: CODEX_FORK },
  // 0.91.0's session/load replayed only the post-compaction effective chain; upstream
  // 0.109.0 now rebuilds it (`readHistoryAcrossCompactions`). The fork is still pinned
  // for its VAC `_meta` extensions (extraModels / usage split / agent map).
  // Use the fork's main branch rather than a commit pin: npm 10.8.2 fails to pack
  // a github spec pinned to a commit ("GitFetcher requires an Arborist constructor").
  {
    from: /^github:zouv\/claude-agent-acp#dfcefd33ff9ef785a6072f3f44eae1fe757038ca$/,
    to: 'github:zouv/claude-agent-acp#main',
  },
  {
    from: /^github:zouv\/claude-agent-acp$/,
    to: 'github:zouv/claude-agent-acp#main',
  },
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
