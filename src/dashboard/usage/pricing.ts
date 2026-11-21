import { UsageTokens } from './types';

export const PRICING_AS_OF = '2026-01';

export interface ModelPrice {
  prefix: string;
  inputPerM: number;
  outputPerM: number;
  cacheWriteMult?: number;
  cacheReadMult?: number;
}

const DEFAULT_CACHE_WRITE_MULT = 1.25;
const DEFAULT_CACHE_READ_MULT = 0.1;

// USD per million tokens, list API prices. Longest matching prefix wins; edit freely.
export const PRICE_TABLE: ModelPrice[] = [
  { prefix: 'claude-opus', inputPerM: 5, outputPerM: 25 },
  { prefix: 'claude-opus-4-1', inputPerM: 15, outputPerM: 75 },
  { prefix: 'claude-opus-4-0', inputPerM: 15, outputPerM: 75 },
  { prefix: 'claude-opus-4-2025', inputPerM: 15, outputPerM: 75 },
  { prefix: 'claude-3-opus', inputPerM: 15, outputPerM: 75 },
  { prefix: 'claude-sonnet', inputPerM: 3, outputPerM: 15 },
  { prefix: 'claude-3-7-sonnet', inputPerM: 3, outputPerM: 15 },
  { prefix: 'claude-3-5-sonnet', inputPerM: 3, outputPerM: 15 },
  { prefix: 'claude-haiku', inputPerM: 1, outputPerM: 5 },
  { prefix: 'claude-3-5-haiku', inputPerM: 0.8, outputPerM: 4 },
  { prefix: 'claude-3-haiku', inputPerM: 0.25, outputPerM: 1.25 },
  { prefix: 'opus', inputPerM: 5, outputPerM: 25 },
  { prefix: 'sonnet', inputPerM: 3, outputPerM: 15 },
  { prefix: 'haiku', inputPerM: 1, outputPerM: 5 },
  // OpenAI (Codex) list prices. Cached input has no write premium; cacheReadMult is
  // 0.1x for GPT-5 family and 0.25x for o-series / codex-mini.
  { prefix: 'gpt-5', inputPerM: 1.25, outputPerM: 10, cacheWriteMult: 1, cacheReadMult: 0.1 },
  { prefix: 'gpt-5-1-codex-mini', inputPerM: 0.25, outputPerM: 2, cacheWriteMult: 1, cacheReadMult: 0.1 },
  { prefix: 'gpt-5-1-codex', inputPerM: 1.25, outputPerM: 10, cacheWriteMult: 1, cacheReadMult: 0.1 },
  { prefix: 'gpt-5-codex', inputPerM: 1.25, outputPerM: 10, cacheWriteMult: 1, cacheReadMult: 0.1 },
  { prefix: 'gpt-5-mini', inputPerM: 0.25, outputPerM: 2, cacheWriteMult: 1, cacheReadMult: 0.1 },
  { prefix: 'gpt-5-nano', inputPerM: 0.05, outputPerM: 0.4, cacheWriteMult: 1, cacheReadMult: 0.1 },
  { prefix: 'codex-mini', inputPerM: 1.5, outputPerM: 6, cacheWriteMult: 1, cacheReadMult: 0.25 },
  { prefix: 'o4-mini', inputPerM: 1.1, outputPerM: 4.4, cacheWriteMult: 1, cacheReadMult: 0.25 },
  { prefix: 'o3-mini', inputPerM: 1.1, outputPerM: 4.4, cacheWriteMult: 1, cacheReadMult: 0.25 },
  { prefix: 'o3', inputPerM: 2, outputPerM: 8, cacheWriteMult: 1, cacheReadMult: 0.25 },
];

function normalize(model: string): string {
  let m = model.toLowerCase().trim();
  const slash = m.lastIndexOf('/');
  if (slash >= 0) {
    m = m.slice(slash + 1);
  }
  const bracket = m.indexOf('[');
  if (bracket >= 0) {
    m = m.slice(0, bracket);
  }
  return m.replace(/\./g, '-');
}

export function findPrice(model: string, table: ModelPrice[] = PRICE_TABLE): ModelPrice | undefined {
  const m = normalize(model);
  let best: ModelPrice | undefined;
  for (const p of table) {
    if (m.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) {
      best = p;
    }
  }
  return best;
}

export function isPriced(model: string): boolean {
  return findPrice(model) !== undefined;
}

export function estimateCost(e: UsageTokens & { model: string }): number {
  const p = findPrice(e.model);
  if (!p) {
    return 0;
  }
  const w = p.cacheWriteMult ?? DEFAULT_CACHE_WRITE_MULT;
  const r = p.cacheReadMult ?? DEFAULT_CACHE_READ_MULT;
  return (
    (e.input * p.inputPerM + e.output * p.outputPerM + e.cacheCreate * p.inputPerM * w + e.cacheRead * p.inputPerM * r) /
    1_000_000
  );
}
