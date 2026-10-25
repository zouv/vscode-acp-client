export type AgentKind = 'claude' | 'codex' | 'generic';

export interface AgentProfile {
  readonly kind: AgentKind;
  readonly label: string;
  /**
   * Whose private on-disk transcripts may supplement the history list and replay
   * (times, attachments). A vendor storage format, so opt-in per kind.
   */
  readonly transcriptStore: 'claude' | null;
  /** How tool calls are grouped under the call that delegated them (see `ui/chat/nesting`). */
  readonly nesting: 'claude-code' | 'flat';
  /** Extra `_meta` merged into session/new | load | resume requests. */
  sessionMeta(opts: { customModelIds: readonly string[] }): Record<string, unknown> | undefined;
}

const claudeProfile: AgentProfile = {
  kind: 'claude',
  label: 'Claude Code',
  transcriptStore: 'claude',
  nesting: 'claude-code',
  sessionMeta({ customModelIds }) {
    return customModelIds.length > 0 ? { extraModels: [...customModelIds] } : undefined;
  },
};

const codexProfile: AgentProfile = {
  kind: 'codex',
  label: 'Codex',
  transcriptStore: null,
  nesting: 'flat',
  sessionMeta: () => undefined,
};

const genericProfile: AgentProfile = {
  kind: 'generic',
  label: 'Agent',
  transcriptStore: null,
  nesting: 'flat',
  sessionMeta: () => undefined,
};

const PROFILES: Record<AgentKind, AgentProfile> = {
  claude: claudeProfile,
  codex: codexProfile,
  generic: genericProfile,
};

export function isAgentKind(value: unknown): value is AgentKind {
  return value === 'claude' || value === 'codex' || value === 'generic';
}

/** Explicit `kind` wins; otherwise infer from the agent name and launch command. */
export function inferAgentKind(
  name: string,
  entry: { kind?: unknown; command?: string; args?: readonly string[] } | undefined,
): AgentKind {
  if (isAgentKind(entry?.kind)) { return entry.kind; }
  const haystack = [name, entry?.command ?? '', ...(entry?.args ?? [])].join(' ').toLowerCase();
  if (haystack.includes('claude')) { return 'claude'; }
  if (haystack.includes('codex')) { return 'codex'; }
  return 'generic';
}

export function profileFor(kind: AgentKind): AgentProfile {
  return PROFILES[kind];
}
