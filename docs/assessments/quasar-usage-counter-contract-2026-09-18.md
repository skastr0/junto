# Quasar usage-counter contract (fixture-backed)

Source of truth read: `github.com/skastr0/quasar` clone at `.local/quasar-reference`
(read-only; not modified, not committed). Adapters: `packages/cli/src/adapters/*.ts`
plus `*-schema.ts`, `common.ts`, `packages/protocol/src/normalized-session.ts`.
Fixtures/tests: `packages/cli/test/` (harness builds fixtures in temp dirs;
`fixtures/goldens/*.json` lock the full adapter stream).

## The protocol gap

`UsageRecord` (`packages/protocol/src/normalized-session.ts`) is a flat bag:
`inputTokens`, `outputTokens`, `reasoningTokens`, `cacheCreationInputTokens`,
`cacheReadInputTokens`, `totalTokens`, `cost`, `currency` — all optional
non-negative integers/numbers. It carries **no scope tag** (per-turn vs
cumulative) and no cost basis tag (estimated vs actual). Every consumer must
know the provider's semantics out-of-band. `packages/cli/src/map.ts` uses
usage records only for model attribution; `packages/protocol/src/atif.ts`
explicitly refuses to aggregate: `core_fields_omitted: "multiple source usage
records cannot be safely aggregated"`.

## Summary matrix

| Provider | Root (default) | Native usage location | I | O | R | CC | CR | T | Scope | Cost | Model field | Timestamp |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude | `~/.claude/projects/**/*.jsonl` (+ `subagents/`) | `message.usage` on assistant records | Y | Y | – | Y | Y | derived | per-turn | none | `message.model` | `timestamp` (ISO) |
| codex | `~/.codex/{sessions/YYYY/MM/DD,archived_sessions}/rollout-*.jsonl` | `event_msg.payload.info.total_token_usage` | Y | Y | Y | Y | Y | Y | **cumulative snapshot** | none | `payload.model` / `usage.model` | `timestamp` (ISO) |
| opencode | `~/.local/share/opencode/opencode.db` (`message.data`) | `tokens.*`, `cost` | Y | Y | Y | Y | Y | Y(opt) | per-turn | estimate (Copilot actual) | `modelID` | `time.created` (ms) |
| amp | remote `https://ampcode.com/threads` via `amp threads export` | `messages[].usage` | Y | Y | – | Y | Y | – | per-message (assumed) | none | `usage.model` | `usage.timestamp` |
| grok | `~/.grok/sessions/<cwd>/<uuid>/updates.jsonl` | `params.update.usage` on `turn_completed` | Y | Y | Y | – | Y | Y | per-turn | `costUsdTicks` (dropped from record) | `modelUsage` key | `timestamp`/`ts` |
| hermes | `~/.hermes/state.db` (+ `profiles/*/state.db`) | `sessions.*` (snapshot) **and** `messages.token_count` | Y | Y | Y | Y | Y | derived | **mixed: session snapshot + per-message** | `actual_cost_usd ?? estimated_cost_usd` | `sessions.model` | `messages.timestamp` / `ended_at`/`started_at` |
| kimi | `~/.kimi-code/sessions/**` | `usage.record` → `usage.*` | Y | Y | – | Y | Y | – | per-turn (assumed; `usageScope` dropped) | none | `model` | `time` (ms) |
| pi | `~/.pi/agent/sessions/**/*.jsonl` | assistant `message.usage` | Y | Y | – | Y | Y | Y | per-turn | `cost.total` (USD) | `message.model` | `message.timestamp` (ms) |
| prime | `~/.prime/agent/sessions/*.jsonl` (+ `session-artifacts`) | assistant `message.usage` | Y | Y | – | Y | Y | Y | per-turn | `cost.total` (USD) | `message.model` | `message.timestamp` (ms) |
| omp | `~/.omp/agent/sessions/**/*.jsonl` | assistant `message.usage` | Y | Y | Y | Y | Y | Y | per-turn | `cost.total` (USD) | `message.model` | `message.timestamp` (ms) |
| cursor | `~/.cursor/chats/**`, `~/.cursor/acp-sessions/*/store.db` | reasoning block `providerOptions.cursor.modelName` | – | – | – | – | – | – | n/a | none | that field | none |
| devin | `~/.local/share/devin/cli/sessions.db` | `sessions.metadata.total_acu_cost`/`total_credit_cost` (decoded, **not emitted**) | – | – | – | – | – | – | n/a | ACU/credit, not USD | – | – |
| antigravity | `~/.gemini/antigravity-cli/brain/**` | none (zero "usage" tokens in adapter+schema) | – | – | – | – | – | – | n/a | none | – | – |

`derived` = the adapter computes `totalTokens` as a sum; `–` = counter absent.

## Per-provider field paths

- **claude** — `message.usage.{input_tokens|inputTokens, output_tokens|outputTokens,
  cache_creation_input_tokens|cacheCreationInputTokens,
  cache_read_input_tokens|cacheReadInputTokens}`; `modelProvider` hardcoded
  `"anthropic"`; `totalTokens = sum(4)`.
- **codex** — `payload.info.total_token_usage` (preferred) else `payload.info`
  else `payload`; keys `input_tokens|inputTokens|prompt_tokens`,
  `output_tokens|outputTokens|completion_tokens`,
  `reasoning_output_tokens|reasoning_tokens`, `cache_write_input_tokens|
  cache_creation_input_tokens`, `cached_input_tokens|cache_read_input_tokens`,
  `total_tokens`. `info.last_token_usage` is **never read**.
- **opencode** — `message.data.tokens.{input,output,reasoning,total,cache.read,cache.write}`,
  `message.data.cost`, `modelID`, `providerID`, `time.created`.
- **amp** — `messages[].usage.{model,timestamp,inputTokens,outputTokens,
  cacheReadInputTokens,cacheCreationInputTokens}`; `totalInputTokens`/`maxInputTokens`
  go to an `Artifact(kind:"usage_metadata")`, not the usage record.
- **grok** — `params.update.sessionUpdate=="turn_completed"` →
  `usage.modelUsage[model].{inputTokens,outputTokens,totalTokens,cachedReadTokens,
  reasoningTokens}` (else `usage` itself). `costUsdTicks` is in the schema but
  **not projected into any UsageRecord** (asserted: `every(usage => usage.cost === undefined)`).
- **hermes** — snapshot: `sessions.{input_tokens,output_tokens,cache_read_tokens,
  cache_write_tokens,reasoning_tokens,actual_cost_usd,estimated_cost_usd,model,
  billing_provider,ended_at,started_at}`; per-message: `messages.token_count`.
- **kimi** — `usage.record.{model, usageScope, usage.{inputOther,output,
  inputCacheRead,inputCacheCreation}, time}`; `usageScope` is **dropped**.
- **pi / prime** — `message.usage.{input,output,cacheRead,cacheWrite,totalTokens,
  cost.total}`; `message.{model,provider}`.
- **omp** — `message.usage.{input,output,cacheRead,cacheWrite,totalTokens,
  reasoningTokens,cost.total}`.
- **cursor** — `block.providerOptions.cursor.modelName` only.

## Missing vs zero, and partial lines

- Every adapter reads counters through `numberValue` / `nonNegativeInteger` /
  `nonNegativeNumber`, which return `undefined` for `null`/absent/wrong-type.
  Optional fields are omitted when absent; `0` is preserved as `0` (the hermes
  golden carries an explicit all-zero snapshot record).
- A usage *record* can exist with *no* counters: codex emits one for any
  `token_count` payload even when `info` is missing; amp emits a model-only
  record. Record presence ≠ counter presence.
- Line adapters (claude, codex, grok, kimi, antigravity, omp, pi, prime): a
  torn/truncated final line fails `JSON.parse`, is dropped, and emits
  `<provider>.line.invalid_json`; earlier records survive
  (`adapter-hostile.test.ts` "truncated tail"). SQLite adapters
  (opencode, hermes, cursor, devin) read a consistent snapshot; a corrupt file
  yields `<provider>.sqlite.unreadable` or `cursor.store.snapshot_failed`.
  Amp parses the whole export stdout as one JSON document.

## Aggregation rules

- **claude**: sum records. `total = input + output + cacheCreation + cacheRead`
  (Anthropic: "Total input tokens in a request is the summation of
  `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`";
  `output_tokens` is the inclusive billed total, thinking ⊂ output). Never add
  reasoning (unmapped).
- **codex**: **last** `total_token_usage` record, never the sum.
  `total = input + output`; `cached_input_tokens` ⊂ `input_tokens`,
  `reasoning_output_tokens` ⊂ `output_tokens`, `cache_write_input_tokens` ⊂ input
  (codex-rs `TokenUsage::add_assign`, `non_cached_input()`). Quasar's fallback
  `sum(input,output,reasoning,cacheCreation,cacheRead)` when `total_tokens` is
  absent is **wrong for codex semantics**. Per-turn delta = native
  `info.last_token_usage` (not exposed) or successive-snapshot diff.
- **opencode**: sum records. `total = input + output + reasoning + cacheRead +
  cacheWrite` (stored `input` is non-cached-adjusted, `output` excludes
  reasoning; `total` optional). Never add cache into input or reasoning into output.
  `cost` is a local models.dev estimate except Copilot `totalNanoAiu`.
- **amp**: sum records; no total field. Assume per-message.
- **grok**: sum per-model records across `turn_completed` events; prefer native
  `totalTokens`. Never also add the aggregate `usage` row when `modelUsage`
  rows exist (adapter already picks one). `costUsdTicks` scale unverified.
- **hermes**: **pick one source**. Session total = the snapshot record
  (`eventId` absent, id sequence `-1`). Per-turn = the `token_count` message
  records. Summing both double counts. Snapshot `totalTokens` sums all five
  counters (may overcount if `input_tokens` includes cache — unverified).
- **kimi**: sum records; `total = inputOther + output + inputCacheRead +
  inputCacheCreation`; no native total. `usageScope` unavailable → cannot tell
  turn from session scope.
- **pi / prime / omp**: sum records; `total = input + output + cacheRead +
  cacheWrite` (fixture arithmetic); reasoning ⊂ output. prime
  `child_usage_attributed` carries `childUsage`/`aggregateUsage` as opaque
  lifecycle event JSON — never sum it.
- **cursor / devin / antigravity**: no token/cost aggregation possible from the
  usage surface.

## Fixture evidence

| Provider | Fixture | Expected |
|---|---|---|
| claude | `claude-adapter.test.ts` ~861-890 (decode-level; golden has `usageRecords: []`) | `{input_tokens:11, output_tokens:7, cache_read_input_tokens:3}` → `{inputTokens:11, outputTokens:7, cacheReadInputTokens:3}`; bad usage → `claude.usage.decode_failed` |
| codex | `codex-adapter.test.ts` ~600-780 | rec0 `{I55,O22,R7,CC3,CR11,T77}`; rec1 `{I101,O23,R13,CC5,CR17,T124}`; 55+22=77, 101+23=124 (cache/reasoning excluded from total) |
| pi | `pi-adapter.test.ts` ~20-40, ~128-136 | `usageRecords` length 2; `{I12,O8,CR3,CC2,T25,cost:0.033,USD,model:"fabricated-model"}`; 12+8+3+2=25 |
| omp | `omp-adapter.test.ts` ~85-110, ~291-303; golden `omp.adapter-stream.golden.json` ~216 | `{I11,O7,R2,CR5,CC3,T26,cost:0.037,USD}`; 11+7+5+3=26; golden `{I1,O1,CR0,CC0,T2,cost:0}` |
| prime | `prime-adapter.test.ts` ~31, ~167-174; golden ~724 | `{I12,O8,CR3,CC2,T25,cost:0.033,USD}` |
| amp | `amp-adapter.test.ts` ~669-711 | `{I12,O34,CR5,CC6}`, artifact `{totalInputTokens:23,maxInputTokens:100}`; 12+5+6=23 |
| grok | `grok-adapter.test.ts` ~739-909 | 2 per-model records (`grok-alpha` I11/O7/T20, `grok-beta` I5/O3/T9) + 1 model-less aggregate (I5/O6/T12); every record `cost === undefined` |
| hermes | golden `hermes.adapter-stream.golden.json` ~123-140 | one all-zero snapshot `{I0,O0,R0,CC0,CR0,T0}` |
| kimi | `kimi-adapter.test.ts` ~1073-1081, ~1363-1365 | `usageScope:"turn"`, `{inputOther:10,output:5,inputCacheRead:2,inputCacheCreation:1}` → `inputTokens:10` |
| cursor | `cursor-adapter.test.ts` ~299-300 | one record `{model:"cursor-model", modelProvider:"cursor"}` |
| opencode / devin / antigravity | none | no fixture asserts a token/cost value |

## Unverified claims

1. Grok `costUsdTicks` scale (USD/tick) — Junto's own comment says unverified.
   Verify: real `updates.jsonl` + Grok billing UI/docs.
2. Grok `turn_completed.usage` scope (per-turn vs cumulative) — fixture is
   synthetic and not arithmetically self-consistent. Verify: real updates.jsonl
   with ≥2 turns.
3. Amp per-message vs cumulative usage; `totalInputTokens` semantics. Verify:
   real `amp threads export` with ≥2 assistant messages.
4. Kimi `usageScope` values and whether session-scope records exist (adapter
   drops the field). Verify: real `~/.kimi-code` wire samples.
5. Hermes: whether `input_tokens` includes cache_read/cache_write and whether
   `reasoning_tokens` ⊂ `output_tokens`; whether `actual_cost_usd` is ever
   populated. Verify: real state.db + hermes docs.
6. Claude Code transcript never writes cumulative usage (per-message API shape).
   Verify: real `~/.claude` JSONL.
7. pi/prime/omp `input` excludes cache and `reasoning ⊂ output` in all cases.
   Verify: real session files.
8. opencode multi-step message: `tokens` = last step while `cost` sums steps.
   Verify: real opencode.db.
9. Codex `total_token_usage` reset/estimate paths in live rollouts. Verify: real
   rollouts with compaction.
10. Devin `total_acu_cost`/`total_credit_cost` units. Verify: Devin docs/real db.
11. Antigravity has no usage anywhere in the native format. Verify: real brain
    transcripts.
