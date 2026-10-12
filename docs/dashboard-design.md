# Dashboard (side-bar webview) — design

Feature target: view id `vac-dashboard` in the existing `vac-client` container. Usage statistics plus
quick actions. No `retainContextWhenHidden`, no bundler for webview code, no new dependencies.

## Data sources

| Agent | Root | Status |
|-------|------|--------|
| Claude Code | `~/.claude/projects/**/*.jsonl` (override: setting `vac.dashboard.claudeProjectsDir`) | verified against real files |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | verified against real files |

Claude line shape (observed): one JSON object per line, `type: "assistant"`, `message.model`,
`message.id`, `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens,
cache_read_input_tokens}`, plus `timestamp`, `cwd`, `sessionId`, optional `requestId`, `isSidechain`.
Also present: `type: "user"`, `"attachment"`, `"queue-operation"` records — skipped. Some records
carry an empty/near-empty `usage`; entries with all-zero tokens are not counted. `requestId` is
absent in many transcripts, so the dedupe key must work without it. Sub-agent transcripts live under
`<session>/subagents/*.jsonl` and must be walked too.

Codex line shape (observed): `session_meta` (has `payload.id`/`session_id`, `cwd`,
`forked_from_id`), `turn_context` (`payload.model`, `payload.turn_id`), and
`event_msg` with `payload.type = "token_count"` carrying `info.total_token_usage` +
`info.last_token_usage` as **cumulative** counters. `info` can be `null` early in a session.
Model lives only in `turn_context`; it is not in the token records.

## Dedupe rules

* Claude key: `c|<message.id>|<requestId ?? ''>`. Streaming writes grow `output_tokens` for the same
  id, so the parser keeps a `Map` keyed by id and **last write wins**. Same key seen in a later scan
  replaces the earlier event.
* Codex key: `x|<session id>|n<ordinal>` (ordinal is unique per line and skips replays).
* A forked Codex rollout re-logs earlier turns. The parser marks a file as *replay* while the current
  turn's UUIDv7 timestamp is older than `session_meta.forked_from_id`'s own timestamp, and does not
  emit those samples (they already belong to the parent session).
* Every event carries its key; `UsageIndex` upserts by key, so re-reading a file (truncate/replace
  rescan, process restart without cursors) never double counts.

## Incremental index

* Per-file cursor `{size, mtimeMs, offset, extra?}` is JSON-serialisable and persisted; `extra` holds
  Codex session/model/cwd context so an appended tail keeps its identity.
* Unchanged `(size, mtimeMs)` → file not read at all. Grown → read only `[offset, EOF)` with a
  `FileHandle` read loop in 1 MB chunks; a trailing fragment without `\n` is held back and resumed on
  the next scan. Shrunk, same size with a different mtime (rewritten in place), or offset > size →
  rescan from 0.
* Files are scanned with bounded concurrency (4) and a `setImmediate` yield after each file and
  after every 8 ms of continuous parsing, so the extension host is never blocked. Measured on this
  machine: 2 148 files / 2.2 GB → ~5 s first scan, ~0.2 s rescan, no full-history stall.
* `UsageIndex` never stores raw events. It aggregates into `(day, agent, model, project)` rows plus a
  bounded recent-key map (default 20 000) used for last-wins upserts. Days older than 60 days are
  folded into a single `0000-00-00` archive bucket, which keeps all-time totals exact while the row
  count stays flat (and it fixes the day-bucketing once a day outlives the 30-day window).
* Persistence: one JSON file (`usage-index.json`) holding `{version, savedAt, states, index}`,
  written atomically (temp file + rename, 3 retries for Windows sharing violations), throttled to one
  write per 5 s during a scan and one at the end. Missing/corrupt/version-mismatched file → rebuild
  from scratch, never throw.

## Cost estimate caveat

`estimateCost` prices tokens at **list API prices** as an *equivalent* cost, per-million-token, keyed
by longest matching model prefix (`opus`/`sonnet`/`haiku`, cache write ×1.25 input, cache read ×0.1
input). Subscription (Pro/Max) users are not billed this way — the UI labels every figure `est.` and
carries a tooltip saying so. `PRICING_AS_OF` is exported and the table is a plain array so it can be
edited without touching logic. Models without an entry cost 0, are marked `priced: false`, and their
tokens are reported in an `unpriced` bucket (rendered as a footnote) — an under-estimate, never a
silent wrong number. Provider prefixes (`anthropic/…`) and suffixes (`[1m]`, `-YYYYMMDD`) are stripped.

## UI sections

1. Quick actions: New conversation (`vac.newConversation`), Open chat in editor
   (`vac.openChatInEditor`), Connect agent (`vac.connectAgent`), Refresh (`vac.refreshDashboard`).
2. Connections: one row per agent with a status dot and open-session count.
3. Usage cards: Today / 7d / 30d / all-time — tokens in/out/cache, `est. $` with tooltip.
4. 30-day sparkline: inline SVG bars, `currentColor` + VS Code chart variables, `<title>`/`<desc>`.
5. Top models / top projects (30d), token bars, `n/a` for unpriced models.
6. Recent sessions: click posts `{type:'openSession', agentName, sessionId}` → `vac.openSession`.
7. Status line: "scanning…" during the first pass, file counts, or the last source error; friendly
   empty state when no transcripts are found.

Webview→host messages: `{type:'command', id}` (id whitelisted against the four command ids, anything
else dropped), `{type:'openSession', …}`, `{type:'refresh'}`. Host→webview: `{type:'snapshot', usage,
connections, sessions}` posted only while the view is visible; becoming visible triggers a fresh pass
and a post. Strict CSP (`default-src 'none'`, nonce'd inline script, `style-src` limited to the
webview source), no remote resources, VS Code variables only.

## Extension points

* Add an agent: implement `UsageSource` (`agent`, `scan(state, options)`, `watchRoots()`) and push it
  into `UsageService.sources` — the index, persistence and UI need no changes.
* Real Codex support: `CodexUsageSource` already parses the observed rollout format; swap it in by
  pointing `codexSessionsDir` at `~/.codex/sessions` (done by default).
* More sections: extend `DashboardSnapshot` and the `render()` function inside `renderDashboardHtml`.
* `UsageService` accepts `now`, `debounceMs`, `pollMs`, `persistIntervalMs`, `indexOptions` and a
  `watchFactory` for tests; `createUsageService({storageDir, claudeProjectsDir?, now?})` is the
  production entry point.
