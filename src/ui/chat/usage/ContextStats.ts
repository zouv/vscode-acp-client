// [CUSTOM- 上下文用量统计（2026-11-12）：输入卡右下角圆环点开的 Tip 面板的数据源。
//
// 圆环本身只认 `usage_update`（见 ChatPanelHost 的 usage/used 注释）。这里在它之上
// 再记三样**只增不改的观察值**：每轮结束时的上下文采样（画增长曲线）、本轮 token 构成、
// 以及压缩发生时的轮次（在曲线上标 ▼）。
//
// `PromptResponse.usage` 是**本轮累计**（claude-agent-acp 在轮次激活时重置
// `session.accumulatedUsage`，一轮内多条 assistant result 会 `+=`），所以直接当作
// "本轮构成"使用；只有 `_meta.quota` / `cost` 才是会话累计量，费用增量按差值算。
//
// 纯逻辑、不 import vscode —— 与 AgentMapStore 同一条纪律，vitest 可直接驱动。
import type {
  ContextRateLimit, ContextSample, ContextUsageParts, SessionMeta, TurnUsage,
} from '../protocol';

export interface ContextUsageInput {
  used?: number;
  size?: number;
  costAmount?: number;
  costCurrency?: string;
  thoughtTokens?: number;
  model?: string;
  /** [CUSTOM- 最近一次调用的四项拆分（适配器 `_meta["_claude/usage"]`）。 */
  parts?: ContextUsageParts;
}

/** ACP `Usage`（本轮的累计值）；字段缺失按 0 处理。 */
export interface PromptUsageInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
  thoughtTokens?: number | null;
}

/** `usage_update._meta["_claude/rateLimit"]`（SDK 的 `SDKRateLimitInfo` 子集）。 */
export interface RateLimitInput {
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
}

const HISTORY_LIMIT = 48;
const COMPACTION_LIMIT = 12;

interface SessionState {
  used: number;
  size: number;
  costAmount?: number;
  costCurrency?: string;
  thoughtTokens?: number;
  model?: string;
  parts?: ContextUsageParts;
  turns: number;
  lastTurn?: TurnUsage;
  /** 上一次轮次结束时的会话累计成本（算本轮费用增量）。 */
  costAtTurn?: number;
  history: ContextSample[];
  compactions: number[];
  rateLimits: Map<string, ContextRateLimit>;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function tally(usage: PromptUsageInput): TurnUsage {
  return {
    inputTokens: finite(usage.inputTokens) ?? 0,
    outputTokens: finite(usage.outputTokens) ?? 0,
    cachedReadTokens: finite(usage.cachedReadTokens) ?? 0,
    cachedWriteTokens: finite(usage.cachedWriteTokens) ?? 0,
  };
}

export class ContextStats {
  private readonly bySession = new Map<string, SessionState>();

  private stateFor(sessionId: string): SessionState {
    let state = this.bySession.get(sessionId);
    if (!state) {
      state = {
        used: 0,
        size: 0,
        turns: 0,
        history: [],
        compactions: [],
        rateLimits: new Map(),
      };
      this.bySession.set(sessionId, state);
    }
    return state;
  }

  /** One `usage_update`. Leaves the curve alone — samples belong to finished turns. */
  noteUsage(sessionId: string, usage: ContextUsageInput): void {
    const state = this.stateFor(sessionId);
    const used = finite(usage.used);
    const size = finite(usage.size);
    if (used !== undefined) { state.used = used; }
    if (size !== undefined) { state.size = size; }
    const costAmount = finite(usage.costAmount);
    if (costAmount !== undefined) { state.costAmount = costAmount; }
    if (typeof usage.costCurrency === 'string' && usage.costCurrency) { state.costCurrency = usage.costCurrency; }
    const thought = finite(usage.thoughtTokens);
    if (thought !== undefined) { state.thoughtTokens = thought; }
    if (typeof usage.model === 'string' && usage.model) { state.model = usage.model; }
    // [CUSTOM- 无条件赋值：`used` 与拆分必须同源。压缩后的 usage_update 只带 post_tokens、
    // 不带拆分（适配器的 lastAssistantUsage 已清空），此时旧拆分必须一起作废，
    // 否则圆环会拿压缩前的 output 去解释压缩后的 used。
    state.parts = usage.parts
      ? {
        inputTokens: usage.parts.inputTokens,
        outputTokens: usage.parts.outputTokens,
        cachedReadTokens: usage.parts.cachedReadTokens,
        cachedWriteTokens: usage.parts.cachedWriteTokens,
      }
      : undefined;
  }

  /**
   * One finished prompt: increments the turn counter, records this turn's token mix
   * from the prompt response, and appends a context sample.
   */
  noteTurn(sessionId: string, usage: PromptUsageInput | undefined): void {
    const state = this.stateFor(sessionId);
    state.turns += 1;
    if (usage) {
      const next = tally(usage);
      const thought = finite(usage.thoughtTokens);
      state.lastTurn = thought === undefined ? next : { ...next, thoughtTokens: thought };
    }
    // [CUSTOM- 本轮费用 = 会话累计 cost 的相邻差（reason 同 token：那个字段是累计量）。
    if (state.costAmount !== undefined && state.lastTurn) {
      const previous = state.costAtTurn;
      const delta = previous === undefined || state.costAmount < previous
        ? state.costAmount : state.costAmount - previous;
      state.lastTurn.costAmount = Math.max(0, delta);
      state.costAtTurn = state.costAmount;
    }
    if (state.size > 0) {
      state.history.push({ turn: state.turns, used: state.used, size: state.size });
      if (state.history.length > HISTORY_LIMIT) { state.history.splice(0, state.history.length - HISTORY_LIMIT); }
    }
  }

  /** A finished compaction; the mark sits at the turn it followed. */
  noteCompaction(sessionId: string): void {
    const state = this.stateFor(sessionId);
    if (state.compactions[state.compactions.length - 1] === state.turns) { return; }
    state.compactions.push(state.turns);
    if (state.compactions.length > COMPACTION_LIMIT) { state.compactions.shift(); }
  }

  /** Latest snapshot per limit type; `five_hour` and `seven_day` never overwrite each other. */
  noteRateLimit(sessionId: string, info: RateLimitInput): void {
    const status = typeof info.status === 'string' ? info.status : '';
    if (!status) { return; }
    const type = typeof info.rateLimitType === 'string' && info.rateLimitType
      ? info.rateLimitType : 'unknown';
    const state = this.stateFor(sessionId);
    const snapshot: ContextRateLimit = { type, status };
    const utilization = finite(info.utilization);
    if (utilization !== undefined) { snapshot.utilization = Math.max(0, Math.min(1, utilization)); }
    const resetsAt = finite(info.resetsAt);
    if (resetsAt !== undefined) { snapshot.resetsAt = resetsAt; }
    state.rateLimits.set(type, snapshot);
  }

  /** Wire payload for `SessionMeta.usage`; null when there is no window to draw. */
  snapshot(sessionId: string): SessionMeta['usage'] {
    const state = this.bySession.get(sessionId);
    if (!state || !state.size) { return null; }
    const snapshot: NonNullable<SessionMeta['usage']> = {
      used: state.used,
      size: state.size,
      turns: state.turns,
      history: state.history.slice(),
    };
    if (state.costAmount !== undefined) { snapshot.costAmount = state.costAmount; }
    if (state.costCurrency) { snapshot.costCurrency = state.costCurrency; }
    if (state.thoughtTokens !== undefined) { snapshot.thoughtTokens = state.thoughtTokens; }
    if (state.model) { snapshot.model = state.model; }
    if (state.parts) { snapshot.parts = { ...state.parts }; }
    if (state.lastTurn) { snapshot.lastTurn = state.lastTurn; }
    if (state.compactions.length > 0) { snapshot.compactions = state.compactions.slice(); }
    if (state.rateLimits.size > 0) { snapshot.rateLimits = Array.from(state.rateLimits.values()); }
    return snapshot;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
