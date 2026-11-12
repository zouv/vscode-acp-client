// [CUSTOM- Agent map（2026-11-09）：ACP `subagent_update` 的宿主侧注册表。
//
// 每个根会话一张表，键是子会话 id（ACP 外层的 sessionId 是父；`update.sessionId` 是子）。
// 纯逻辑、不 import vscode —— 与 TranscriptStore 同一条纪律，vitest 可直接驱动。
//
// 数据来自三条通道：
// · `subagent_update` 的身份 / 状态 / 能力，以及 `_meta["vac/agentMap"]` 的补充元数据；
// · 子会话自己的 `usage_update`（上下文、成本、模型）；
// · 子会话自己的 `tool_call` / `tool_call_update`（最后用过的工具）。
// 所有时间都是 epoch 毫秒；拿不到就是 undefined —— 不拿宿主时钟假装转录时刻。

export type AgentMapState =
  | 'running' | 'requires_action' | 'idle' | 'unknown' | 'failed' | 'cancelled';

/** One agent in the tree sent to the webview. Children are nested by `parentId`. */
export interface AgentMapNode {
  agentId: string;
  parentId: string;
  title?: string;
  description?: string;
  state: AgentMapState;
  error?: string;
  canCancel: boolean;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  totalTokens?: number;
  toolUses?: number;
  summary?: string;
  lastToolName?: string;
  contextUsed?: number;
  contextSize?: number;
  costUsd?: number;
  model?: string;
  /** Host clock at first announcement; stable ordering key. */
  announcedAt: number;
  /** Host clock of the latest update (not shown). */
  lastActivityAt: number;
  children: AgentMapNode[];
}

export interface AgentMapSnapshot {
  running: number;
  agents: AgentMapNode[];
}

/** Patch accepted from a `subagent_update` (meta fields already flattened by the host). */
export interface AgentMapPatch {
  agentId: string;
  parentId?: string;
  title?: string;
  description?: string;
  /** Raw RFD `state.state`: running | requires_action | idle | unknown. */
  state?: string;
  /** Raw RFD `state.stopReason`: cancelled | error. */
  stopReason?: string;
  error?: string;
  canCancel?: boolean;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  totalTokens?: number;
  toolUses?: number;
  summary?: string;
  lastToolName?: string;
}

export interface AgentMapUsage {
  used?: number;
  size?: number;
  cost?: { amount?: number; currency?: string } | null;
  model?: string;
}

type FlatNode = Omit<AgentMapNode, 'children'>;

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Map the RFD's open-ended state to what the map paints.
 *
 * `idle` is not terminal by itself (a child can be reused), but the adapter
 * flavours its terminal stop as `stopReason: 'cancelled' | 'error'` plus an
 * `error.message`. Those two are the difference between "finished" and "died".
 */
export function mapAgentState(raw: string | undefined, stopReason?: string, error?: string): AgentMapState {
  if (raw === 'running' || raw === 'requires_action' || raw === 'unknown') { return raw; }
  if (raw === 'idle') {
    if (stopReason === 'cancelled') { return 'cancelled'; }
    if (stopReason === 'error' || error) { return 'failed'; }
    return 'idle';
  }
  return 'unknown';
}

function isRunning(state: AgentMapState): boolean {
  return state === 'running' || state === 'requires_action';
}

export class AgentMapStore {
  private readonly byParent = new Map<string, Map<string, FlatNode>>();

  /** Add / merge one agent. Partial updates never wipe fields they omit. */
  upsert(parentSessionId: string, patch: AgentMapPatch): void {
    const agentId = patch.agentId;
    if (!agentId) { return; }
    const bucket = this.bucketFor(parentSessionId);
    const now = Date.now();
    let node = bucket.get(agentId);
    if (!node) {
      node = {
        agentId,
        parentId: patch.parentId ?? parentSessionId,
        state: 'unknown',
        canCancel: false,
        announcedAt: now,
        lastActivityAt: now,
      };
      bucket.set(agentId, node);
    }
    if (typeof patch.parentId === 'string' && patch.parentId) { node.parentId = patch.parentId; }
    if (typeof patch.title === 'string') { node.title = patch.title; }
    if (typeof patch.description === 'string') { node.description = patch.description; }
    if (typeof patch.state === 'string') {
      node.state = mapAgentState(patch.state, patch.stopReason, patch.error);
    }
    if (typeof patch.error === 'string') { node.error = patch.error; }
    if (typeof patch.canCancel === 'boolean') { node.canCancel = patch.canCancel; }
    const startedAt = asNumber(patch.startedAt);
    if (startedAt !== undefined) { node.startedAt = startedAt; }
    const endedAt = asNumber(patch.endedAt);
    if (endedAt !== undefined) { node.endedAt = endedAt; }
    const durationMs = asNumber(patch.durationMs);
    if (durationMs !== undefined) { node.durationMs = durationMs; }
    const totalTokens = asNumber(patch.totalTokens);
    if (totalTokens !== undefined) { node.totalTokens = totalTokens; }
    const toolUses = asNumber(patch.toolUses);
    if (toolUses !== undefined) { node.toolUses = toolUses; }
    if (typeof patch.summary === 'string') { node.summary = patch.summary; }
    if (typeof patch.lastToolName === 'string') { node.lastToolName = patch.lastToolName; }
    node.lastActivityAt = now;
  }

  /** Child `usage_update`: context ring, cost and model for one agent. */
  noteUsage(parentSessionId: string, agentId: string, usage: AgentMapUsage): void {
    if (!agentId) { return; }
    const node = this.ensure(parentSessionId, agentId);
    const used = asNumber(usage.used);
    if (used !== undefined) { node.contextUsed = used; }
    const size = asNumber(usage.size);
    if (size !== undefined) { node.contextSize = size; }
    const amount = asNumber(usage.cost?.amount);
    if (amount !== undefined) { node.costUsd = amount; }
    if (typeof usage.model === 'string' && usage.model) { node.model = usage.model; }
    node.lastActivityAt = Date.now();
  }

  /** Child `tool_call` / `tool_call_update`: remember the latest tool name. */
  noteTool(parentSessionId: string, agentId: string, toolName: string | undefined): void {
    if (!agentId) { return; }
    const node = this.ensure(parentSessionId, agentId);
    if (toolName) { node.lastToolName = toolName; }
    node.lastActivityAt = Date.now();
  }

  get(parentSessionId: string, agentId: string): AgentMapNode | undefined {
    const node = this.byParent.get(parentSessionId)?.get(agentId);
    return node ? this.clone(node) : undefined;
  }

  clear(parentSessionId: string): void {
    this.byParent.delete(parentSessionId);
  }

  /** Flat registry size (used by the host for cheap early exits). */
  size(parentSessionId: string): number {
    return this.byParent.get(parentSessionId)?.size ?? 0;
  }

  /**
   * [CUSTOM- 子 agent 的累计成本（USD）。上下文 Tip 的「子 agent」一行用它；
   * 扁平表遍历、不建快照 —— meta 推送频率高，克隆整棵树太贵。
   */
  totalCostUsd(parentSessionId: string): number | undefined {
    const bucket = this.byParent.get(parentSessionId);
    if (!bucket || bucket.size === 0) { return undefined; }
    let total = 0;
    let seen = false;
    for (const node of bucket.values()) {
      if (typeof node.costUsd === 'number' && Number.isFinite(node.costUsd)) {
        total += node.costUsd;
        seen = true;
      }
    }
    return seen ? total : undefined;
  }

  /** Nested snapshot, rebuilt on demand — never stored. */
  snapshot(parentSessionId: string): AgentMapSnapshot {
    const bucket = this.byParent.get(parentSessionId);
    if (!bucket || bucket.size === 0) { return { running: 0, agents: [] }; }

    const flat = Array.from(bucket.values());
    const clones = new Map<string, AgentMapNode>();
    let running = 0;
    for (const node of flat) {
      if (isRunning(node.state)) { running++; }
      clones.set(node.agentId, { ...node, children: [] });
    }

    const roots: AgentMapNode[] = [];
    for (const node of flat) {
      const child = clones.get(node.agentId)!;
      const parent = node.parentId && node.parentId !== parentSessionId
        ? clones.get(node.parentId)
        : undefined;
      if (parent && parent !== child && !this.wouldCycle(node, bucket)) {
        parent.children.push(child);
      } else {
        roots.push(child);
      }
    }
    const sort = (list: AgentMapNode[]) => {
      list.sort((a, b) => (a.announcedAt - b.announcedAt) || a.agentId.localeCompare(b.agentId));
      for (const child of list) { sort(child.children); }
    };
    sort(roots);
    return { running, agents: roots };
  }

  /**
   * Cheap change detector for coalesced pushes.
   *
   * Deliberately excludes `lastActivityAt` (it changes on every tool call) and
   * the host clock: the UI reads elapsed time from `startedAt` on its own tick,
   * so a push is only needed when something the panel paints changed.
   */
  signature(parentSessionId: string): string {
    const bucket = this.byParent.get(parentSessionId);
    if (!bucket || bucket.size === 0) { return ''; }
    const parts: string[] = [];
    for (const node of bucket.values()) {
      parts.push([
        node.agentId, node.parentId, node.state, node.title ?? '', node.description ?? '',
        node.error ?? '', node.canCancel ? 1 : 0, node.startedAt ?? '', node.endedAt ?? '',
        node.durationMs ?? '', node.totalTokens ?? '', node.toolUses ?? '',
        node.summary ?? '', node.lastToolName ?? '', node.contextUsed ?? '',
        node.contextSize ?? '', node.costUsd ?? '', node.model ?? '',
      ].join('|'));
    }
    return parts.join('\n');
  }

  private bucketFor(parentSessionId: string): Map<string, FlatNode> {
    let bucket = this.byParent.get(parentSessionId);
    if (!bucket) {
      bucket = new Map();
      this.byParent.set(parentSessionId, bucket);
    }
    return bucket;
  }

  /** Traffic that beat the announcement creates a placeholder; the upsert completes it. */
  private ensure(parentSessionId: string, agentId: string): FlatNode {
    const bucket = this.bucketFor(parentSessionId);
    let node = bucket.get(agentId);
    if (!node) {
      const now = Date.now();
      node = {
        agentId,
        parentId: parentSessionId,
        state: 'unknown',
        canCancel: false,
        announcedAt: now,
        lastActivityAt: now,
      };
      bucket.set(agentId, node);
    }
    return node;
  }

  /** Guard against a malformed parent chain turning the nested snapshot into a cycle. */
  private wouldCycle(node: FlatNode, bucket: Map<string, FlatNode>): boolean {
    let current = node.parentId;
    const seen = new Set<string>();
    while (current) {
      if (current === node.agentId) { return true; }
      if (seen.has(current)) { return true; }
      seen.add(current);
      const parent = bucket.get(current);
      if (!parent) { return false; }
      current = parent.parentId;
    }
    return false;
  }

  private clone(node: FlatNode): AgentMapNode {
    return { ...node, children: [] };
  }
}
