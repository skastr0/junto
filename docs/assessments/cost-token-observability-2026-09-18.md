# Cost and token observability — session ledger, seat association, task attribution

Date: 2026-09-18
Status: design only. No production schema or collector ships with this note.
Subject: durable usage observations at session grain, attributed to seats and to tasks, with observational task budgets.

This design is the first product schema change after the version-1 re-baseline. It adds tables beside existing storage, leaves `usage_state` and the work-operation CHECK set untouched, and treats session identity — not seat identity — as the ledger primary key.

Operator-established measurements cited below (seat/session census, Codex descendant split, per-harness cost fields) were not re-measured in this orb. They are used as given. Every load-bearing claim about *this* repository is cited to a file and line that was opened here.

---

## Verdict

Junto can already collect a true session-grain ledger from Claude, Codex (root rollout), Grok, Pi, and Hermes without Quasar running. Cursor, Devin, and Antigravity still have no session-grain usage on disk. Cost-in-dollars is harness-reported only for Pi; Hermes writes an estimated USD that is often zero on subscription; Grok writes `costUsdTicks` whose scale is unverified in-tree. Task cost is a join, not a stored fact: claim interval × seat-session association × session observations. Subagent lineage is the largest correctness hole — the 2026-09-16 Codex effort hid 59% of tokens in 15 descendant rollouts. Budgets start as observational targets. The smallest honest operator number is observed direct usage for one named session through one read, descendants not included.

---

## Grounded present tense

### Quota plane is not a usage ledger

[`src/shared/usage.ts`](src/shared/usage.ts) is quota windows only. `UsageState` is `{ snapshots, stale?, lastLiveAt?, lastError? }` (lines 107–116). `UsageSnapshot` has `source`, `fetchedAt`, `ok`, `quotas` — no seat, session, or task field (lines 66–84). Comment at lines 3–4: quotas never bind to canvas nodes.

The sole durable usage row is singleton `usage_state` ([`src/main/junto/usage/state-schema.ts`](src/main/junto/usage/state-schema.ts) lines 2–13): `snapshots_json`, `last_live_at`, `updated_at`. [`UsageCache.saveLastGood`](src/main/junto/usage/usage-cache.ts) upserts that singleton (lines 152–166) and refuses to persist a payload with no quotas (line 145).

This plane stays. The session ledger is a separate bounded context. Do not dual-write session tokens into `usage_state.extras`.

### Session identity already exists; it is not a ledger

- Canvas: `ether.terminal.sessionId` ([`src/shared/canvas.ts`](src/shared/canvas.ts) lines 178–185). `bindingId` is the stable authorial identity (line 167); session id is the harness thread for cold wake.
- Projection: `ProjectedActorSeat` carries `harness` and optional `sessionId` ([`src/main/junto/station/actor-seat-compiler.ts`](src/main/junto/station/actor-seat-compiler.ts) lines 30–39). `actor_seat_id = "seat_" + sha256(JSON.stringify(["junto/actor-seat/v1", installationId, bindingId]))` (lines 175–191). Historical Remote projections store that registry in `station_projection_versions.body` ([`src/main/junto/station/state-schema.ts`](src/main/junto/station/state-schema.ts) lines 86–119; [`portfolio.ts`](src/main/junto/station/portfolio.ts) lines 47–52, 235–241).
- Capture proof: PTY text is untrusted. Nothing is written until `harnessSessionExists` finds harness-local durable state ([`session-capture-persist.ts`](src/main/junto/term/session-capture-persist.ts) lines 16–19, 114–147). Capture cannot replace a seat's named session or assign one session to two seats ([`seat-session-id.ts`](src/main/junto/term/seat-session-id.ts) lines 76–83).
- Process-local only: `session-id-store.ts` is an observation map, never a claim (lines 1–8). Seat state, turn progress, and agent-state rules are process-local ([`agent-state/runtime.ts`](src/main/junto/term/agent-state/runtime.ts) lines 1–4). [`seat-observation.ts`](src/main/junto/work/seat-observation.ts) is a read port over that stream (lines 1–12). There is no seat-observation table.

A seat can be given a fresh pin id on isolated spawn ([`managed-spawn-plan.ts`](src/main/junto/term/managed-spawn-plan.ts) lines 417–424). A canvas node can be deleted while the harness session remains on disk. Therefore the ledger key is the harness session, and seat association is a separate, evidenced, time-scoped relation.

### Attribution spine already exists

- Task identity is sink-local: `PRIMARY KEY (canvas_name, node_id, task_id)` ([`work/state-schema.ts`](src/main/junto/work/state-schema.ts) lines 795–844). `TaskRef` is `{ kind: "task", itemId, sink }` ([`src/shared/work-reference.ts`](src/shared/work-reference.ts) lines 82–90).
- `ActorRef` is `{ seatId, canvasName, nodeId }` (same file, lines 38–43). The claim fact stores that full ref: `TaskClaimResult.claimedBy: ActorRef` ([`src/shared/work-protocol.ts`](src/shared/work-protocol.ts) lines 395–405). `claimLocalTask` writes `claimedBy: input.actor` into the fact body ([`repository.ts`](src/main/junto/work/repository.ts) lines 8506–8519).
- `work_task_transitions` is append-only INSERT keyed by `(canvas_name, node_id, item_id, lane, ordinal)` with `from_state`, `to_state`, `actor_seat_id`, `operation`, `origin_at` ([`state-schema.ts`](src/main/junto/work/state-schema.ts) lines 1094–1160; write at [`repository.ts`](src/main/junto/work/repository.ts) lines 4883–4916). Ordinal is `coalesce(max(ordinal)+1, 0)` (lines 4870–4880). That ordinal — not `origin_at` — is ordering authority.
- `originAt` is display metadata and does not participate in `contentSha256` ([`repository.ts`](src/main/junto/work/repository.ts) lines 818–821).
- Concurrent active claims on one seat are already forbidden: `work_tasks_one_active_per_actor` unique on `actor_seat_id` where `state IN ('working', 'input-required', 'auth-required')` ([`state-schema.ts`](src/main/junto/work/state-schema.ts) lines 1259–1262). Active states require `claimedBy` ([`work-model.ts`](src/shared/work-model.ts) lines 411–418). No new allocation policy.
- Returning to `submitted` clears `claimedBy` in the same fact ([`src/shared/task.ts`](src/shared/task.ts) lines 129–138).
- `work_events` / `work_facts` / `work_commands` / `work_dispositions` abort UPDATE and DELETE ([`state-schema.ts`](src/main/junto/work/state-schema.ts) lines 1288–1345). Their operation CHECK is closed on nine names (lines 325–338). This design does not add a tenth.

### Schema law

[`migrations.ts`](src/main/junto/state/migrations.ts): `CURRENT_STATE_SCHEMA_VERSION = 1` (line 106), `STATE_SCHEMA_MIGRATIONS = []` (line 121). Next edit is `1 → 2`. Expand-only: add beside, copy forward, never drop or reuse a durable name (AGENTS.md SQLite evolution law; `STATE_SCHEMA_MIGRATION_SAFETY = "expand-only"` at line 23). Fresh installs exec `currentSchemaSql`; existing v1 databases run the chain inside `BEGIN IMMEDIATE` (lines 710–802). `usage_state` is already composed into version 1 ([`schema.ts`](src/main/junto/state/schema.ts) line 80).

### Station freeze vs in-place v1

Closed operations: `pair`, `configure`, `project`, `report`, `overseer`, `status` ([`docs/junto-protocol.md`](docs/junto-protocol.md) lines 31–34). `ReportBatch` is `{ records: WorkRecord[], acknowledge, hasMore }` with `onExcessProperty: "error"` ([`station-api.ts`](src/shared/station-api.ts) lines 387–401; [`api.ts`](src/main/junto/station/api.ts) line 91). Remote Stations are unreleased, so the wire contract stays version 1 and **may evolve in place** ([`remote-station-release.ts`](src/shared/remote-station-release.ts) lines 1–17, 29–48; support `1/1/1` at [`station-protocol.ts`](src/shared/station-protocol.ts) lines 38–42). Do not add a seventh operation, a capability array, or a parallel usage protocol integer.

### Harness files Junto already knows

Existence probes in [`session-existence.ts`](src/main/junto/term/session-existence.ts) `harnessSessionExists` (lines 96–144):

| harness | proof on disk | sessionId badge |
|---|---|---|
| grok | `~/.grok/sessions/<cwd-enc>/<id>/` (lines 163–176) | pin |
| claude | `~/.claude/projects/<cwd-enc>/<id>.jsonl` or dir (lines 191–200) | pin |
| codex | `~/.codex/sessions` tree, filename contains id (lines 282–285) | capture |
| hermes | read-only `~/.hermes/state.db` `sessions.id` (lines 229–263) | capture |
| pi | `~/.pi/agent/sessions/--<cwd>--/<ts>_<uuidv7>.jsonl` (lines 310–357) | pin |
| prime-agent, kimi, muse, fx, omp, devin, cursor, agy | harness-local trees (lines 121–144) | capture / pin / provision |

Quota readers that already parse tokens (still aggregated into `usage_state`, not a ledger):

- Hermes: `input_tokens`, `output_tokens`, `cache_read_tokens`, `reasoning_tokens`, `estimated_cost_usd` from `sessions` ([`hermes-source.ts`](src/main/junto/usage/hermes-source.ts) lines 10–12, 123–133). Subscription plans report estimated cost 0.
- Grok: per-`turn_completed` `inputTokens` / `outputTokens` / `totalTokens` / `costUsdTicks` from `updates.jsonl` ([`grok-source.ts`](src/main/junto/usage/grok-source.ts) lines 22–24, 50–72). Scale of ticks is unverified in-tree.
- Codex / Claude usage sources are **plan windows**, not session files ([`codex-source.ts`](src/main/junto/usage/codex-source.ts) lines 7–9; [`claude-source.ts`](src/main/junto/usage/claude-source.ts) lines 17–27).

Operator-established session-file facts (not re-opened here): Claude jsonl carries per-turn input / output / cache_read / cache_creation plus model, no cost. Codex rollouts carry `token_count` with a full breakdown, no cost. Pi jsonl carries `cost.total` in dollars. Cursor, Devin, Antigravity expose nothing at session grain.

Precedent: [`docs/assessments/token-usage-2026-09-16.md`](docs/assessments/token-usage-2026-09-16.md) — Codex effort 704.6M tokens; root session 285.9M (40.6%); 15 descendant rollouts 418.8M (59.4%) via `session_meta.source.subagent.thread_spawn.parent_thread_id`. Cache was 97.23% of root input. Two Codex counters disagreed 1.7% (`thread_total` vs `event_msg/token_count`).

Adapters remain read-only (AGENTS.md). Hermes-over-SSH profile enumeration is **not** a collection path for this ledger.

---

## 1. Observation record shape

The ledger row is one native usage event (or one cumulative snapshot when the harness has no event grain). It never stores a seat id or a task id.

### Identity (primary key)

`(source_namespace, harness_session_id, native_event_id)`

- `source_namespace` — Junto collector family, not a provider HUD id. Closed set at v2: `junto/usage/claude/jsonl`, `junto/usage/codex/rollout`, `junto/usage/grok/updates`, `junto/usage/pi/jsonl`, `junto/usage/hermes/sessions`. Adding a namespace is a later expand. Do not reuse quota-source ids (`claude`, `codex`) so the HUD and the ledger cannot be joined by accident.
- `harness_session_id` — the same string `ether.terminal.sessionId` names. For Codex, the rollout / thread id, **not** the seat binding.
- `native_event_id` — stable inside that namespace:
  - Claude: the transcript line's own uuid / message id when present; otherwise the sha256 of the canonical jsonl line. Not a synthesized `turn_index`.
  - Codex: `(rollout_id, ordinal, type)` as the harness wrote it. Ordinal here is Codex's native record identity, not a Junto turn counter.
  - Grok: a field the line already names, or sha256 of the canonical `turn_completed` line.
  - Pi: the jsonl event's own id, else sha256 of the canonical line.
  - Hermes: the `sessions` row is cumulative. Native id is `sessions.id` plus a content digest of the counter vector so a later counter change is a new row, not an UPDATE.

Never `(seat, session)`. Never an assumed `turn_index`. Idempotent ingest is `INSERT OR IGNORE` on this triple.

### Provenance

| field | meaning |
|---|---|
| `collected_by_installation_id` | the installation whose runtime read the file (FK `station_known_installations`) |
| `harness` | `HarnessId` literal |
| `source_path` | host-local path or `state.db` identifier; observational, not a capability |
| `model` | NULL if the event does not name one (missing, not empty string) |
| `parent_session_id` | Codex (and any future) descendant pointer; NULL for roots |
| `descendants_included` | always `0` on a ledger row. Inclusive rollups are projections |
| `extras_json` | leftover native fields; never a second schema |

Quasar may supply parser fixtures and field maps. Junto does not call Quasar at collect time, and does not write Junto seat / task / installation ids into any Quasar model.

### Delta versus cumulative

`counter_semantics` is `'delta'` or `'cumulative'`.

- Native delta (Claude turn, Grok `turn_completed`): store the native counters in the token columns. Leave `delta_*` NULL — they would duplicate.
- Native cumulative (Hermes session row, Codex `thread_total` snapshots): store the native cumulative counters in the token columns. Compute `delta_*` against the previous row of the same `(source_namespace, harness_session_id)` ordered by native identity, not by ingest time.
- Counter reset: a cumulative value that decreases on any reported counter. Do not emit a negative delta. Persist `coverage = 'reset'`, `delta_* = NULL`, and start a new cumulative series from this row.
- Gap: missing native identities in a known sequence (truncated jsonl, skipped ordinals). Persist `coverage = 'gapped'` on the first row after the hole. Do not interpolate zeros. Zeros would collapse missing into observed-empty.
- Snapshot-only sources (Hermes): `coverage = 'snapshot'`. The operator-visible session total is the latest cumulative row through this read, labeled as such.

Ingest time never substitutes for native order.

### Native versus ingestion timestamp

- `native_at` — timestamp the harness wrote, NULL if absent. Observational bound only. Never ordering authority.
- `ingested_at` — local collector clock. Display / freshness only. Never attribution. Never a Command Center receive time written by the Remote's peer.

Work already makes this distinction: `origin_at` vs `received_at` on every work row, with `originAt` excluded from content hash ([`repository.ts`](src/main/junto/work/repository.ts) lines 818–821). The usage ledger copies that split and does not reuse work timestamps as usage timestamps.

### Missing distinct from zero

Every token and cost column is NULLABLE. NULL = the source did not report the category. `0` = the source reported zero. Collectors must not `?? 0` (the current Hermes/Grok quota parsers do; that is acceptable for a HUD percentage and **forbidden** on this ledger).

A display total may sum non-NULL categories only when labeled with the inclusion rule that produced it. A stored `total_tokens` is written only when the harness itself reported a total. Codex's two counters (thread ledger vs `event_msg/token_count`, 1.7% apart) stay as separate namespaces or as two native events, never averaged.

### Cache and reasoning inclusion rules

Default operator unit is **raw token categories**, not a single “tokens” number.

| category | inclusion rule |
|---|---|
| `input_tokens` | source-reported input. Does **not** strip cache. If the source already excludes cache, that is the source's definition and is preserved, not “fixed” |
| `cache_read_tokens` | Claude `cache_read`; Codex cached input. Not added again into a derived uncached-input unless the UI asks for uncached and labels it |
| `cache_creation_tokens` | Claude `cache_creation`. Distinct from cache read. Missing on Codex/Grok/Hermes until a source writes it |
| `output_tokens` | source-reported output. Codex reasoning may be a subset of output (precedent: 202,318 reasoning of 683,799 output on the 2026-09-16 root). Do not subtract unless the source says reasoning is outside output |
| `reasoning_tokens` | Hermes separate column; Codex reasoning output. NULL when absent |
| `total_tokens` | source-reported total only |

Documented derived views (not stored as if native):

- `uncached_input = input - cache_read` when both are non-NULL and the source counts cache inside input (Codex precedent: 280,736,459 input − 272,969,472 cached = 7,766,987). Label: `derived/uncached-input; cohort=codex-thread_total`.
- Observed-token share of a named cohort (e.g. “59.4% of this effort”) is legitimate only with cohort identity and coverage. It is **not** share of a subscription allowance.
- API-price equivalent is an optional labeled model (`cost_provenance = 'api-price-equivalent'`). It is not money spent.
- A dollar the harness wrote is `harness-reported`. Whether it is estimated is `cost_estimated`. Hermes `estimated_cost_usd` is estimated. Pi `cost.total` is harness-reported. Grok `costUsdTicks` is harness-reported in currency `usd-ticks` with scale unverified — never converted to USD in this ledger.

### Optional cost

Cost is present only when all of `cost_amount`, `cost_currency`, `cost_provenance` are present (SQL CHECK). `cost_estimated` is 0/1 when cost is present, NULL when cost is absent.

`cost_amount` is TEXT to preserve harness precision (decimal dollars, integer ticks) without float.

---

## 2. Seat-to-session association

A separate append-mostly table. Observations do not point at seats. Attribution looks up which seat held which session with which evidence during which observational window.

### How the association is established

Write an association row when Junto **proves** a session id for a seat, not when PTY text merely resembles one.

| evidence_kind | when | source of truth already in tree |
|---|---|---|
| `pin-authorial` | pin harness mint / resume of `ether.terminal.sessionId` (Claude, Grok, Pi, Cursor) | [`session-existence.ts`](src/main/junto/term/session-existence.ts) lines 768–775; canvas field at [`canvas.ts`](src/shared/canvas.ts) 178–185 |
| `capture-proven` | capture harness id survived `harnessSessionExists` and was stored | [`session-capture-persist.ts`](src/main/junto/term/session-capture-persist.ts) 114–147; uniqueness at [`seat-session-id.ts`](src/main/junto/term/seat-session-id.ts) 76–83 |
| `provision-minted` | Amp thread minted before PTY | [`amp-seat-thread.ts`](src/main/junto/term/amp-seat-thread.ts) 7, 103–123 |
| `projection-snapshot` | Remote applied a portfolio whose `actorSeats[].sessionId` named this pair | [`portfolio.ts`](src/main/junto/station/portfolio.ts) 47–52 |
| `checkpoint-backfill` | later walk of historical canvas checkpoints / projection bodies | install-ops marker, never a product completeness claim |

`checkpoint-backfill` is lower confidence. Live attribution never prefers it over `capture-proven` / `pin-authorial` / `provision-minted`.

Do not reconstruct “the seat’s session” from the current canvas node. The claim fact’s `claimedBy: ActorRef` already froze canvas and node identity at claim time ([`work-protocol.ts`](src/shared/work-protocol.ts) 395–405). The association table freezes session identity with evidence at proof time. Those are independent.

### What evidence it carries

- `actor_seat_id` — derived seat id, same encoding as work rows.
- `binding_id` — survives node deletion; seat id is a function of `(installationId, bindingId)` ([`actor-seat-compiler.ts`](src/main/junto/station/actor-seat-compiler.ts) 175–191).
- `harness`, `source_namespace`, `harness_session_id`.
- `canvas_name`, `node_id` — nullable. NULL means the node was already gone and only binding/seat remained. Never filled in later from a different node.
- `evidence_kind`, `evidence_at` (when Junto accepted the proof).
- `collected_by_installation_id`.

### Temporal scope

Each row is one open or closed interval:

- `scope_from` — observational start. Pin: authoring/mint time. Capture: proof time (not the first PTY scrape). Projection: projection `created_at`.
- `scope_until` — NULL means still current. Set when a later proven session replaces it, when the seat is observed to have started a fresh session, or when a close event is recorded.

The only permitted UPDATE on this table is `scope_until` from NULL to a timestamp (same exception class as `work_tasks` actor release, [`state-schema.ts`](src/main/junto/work/state-schema.ts) 1518–1533). Every other column is immutable. A replacement session is a new row.

Partial unique index: at most one open association per `actor_seat_id` (`WHERE scope_until IS NULL`). That matches “one executable principal, one current session” without pretending a deleted canvas node still owns it.

A session may appear on more than one seat **only** as a data defect; capture already refuses it. The ledger still keys observations by session, so a defective double association makes attribution ambiguous (listed below) rather than double-counting tokens in the session readout.

---

## 3. Version 2 migration

Place a new SQL fragment beside [`USAGE_STATE_SCHEMA_SQL`](src/main/junto/usage/state-schema.ts). Compose it into `STATE_SCHEMA_SQL` for fresh installs. Append one expand-only step `1 → 2` to `STATE_SCHEMA_MIGRATIONS`. Do not edit version-1 fragments. Do not change `usage_state`. Do not change any `operation IN (...)` CHECK on `work_events`, `work_commands`, `work_pending_commands`, or `work_task_transitions`.

Collection watermarks (jsonl byte offset, last Codex ordinal consumed) are install-local walk completeness. They belong in `install-ops.db` under a new marker id, **not** in `junto.db` (AGENTS.md: do not fold backfill completeness into product rows). Re-ingest against the product ledger is `INSERT OR IGNORE` on the observation triple, so a missing watermark cannot invent product facts.

### Exact expand-only DDL

```sql
-- usage_observations: session-grain ledger. No seat. No task.
CREATE TABLE IF NOT EXISTS usage_observations (
  source_namespace TEXT NOT NULL
    CHECK (length(source_namespace) BETWEEN 1 AND 128),
  harness_session_id TEXT NOT NULL
    CHECK (length(harness_session_id) BETWEEN 1 AND 512),
  native_event_id TEXT NOT NULL
    CHECK (length(native_event_id) BETWEEN 1 AND 512),
  collected_by_installation_id TEXT NOT NULL,
  harness TEXT NOT NULL
    CHECK (length(harness) BETWEEN 1 AND 64),
  model TEXT
    CHECK (model IS NULL OR length(model) BETWEEN 1 AND 256),
  counter_semantics TEXT NOT NULL
    CHECK (counter_semantics IN ('delta', 'cumulative')),
  coverage TEXT NOT NULL
    CHECK (coverage IN ('contiguous', 'gapped', 'reset', 'snapshot')),
  input_tokens INTEGER
    CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER
    CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER
    CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_creation_tokens INTEGER
    CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
  reasoning_tokens INTEGER
    CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER
    CHECK (total_tokens IS NULL OR total_tokens >= 0),
  delta_input_tokens INTEGER
    CHECK (delta_input_tokens IS NULL OR delta_input_tokens >= 0),
  delta_output_tokens INTEGER
    CHECK (delta_output_tokens IS NULL OR delta_output_tokens >= 0),
  delta_cache_read_tokens INTEGER
    CHECK (delta_cache_read_tokens IS NULL OR delta_cache_read_tokens >= 0),
  delta_cache_creation_tokens INTEGER
    CHECK (delta_cache_creation_tokens IS NULL OR delta_cache_creation_tokens >= 0),
  delta_reasoning_tokens INTEGER
    CHECK (delta_reasoning_tokens IS NULL OR delta_reasoning_tokens >= 0),
  delta_total_tokens INTEGER
    CHECK (delta_total_tokens IS NULL OR delta_total_tokens >= 0),
  native_at TEXT
    CHECK (native_at IS NULL OR length(native_at) BETWEEN 1 AND 64),
  ingested_at TEXT NOT NULL
    CHECK (length(ingested_at) BETWEEN 1 AND 64),
  cost_amount TEXT
    CHECK (cost_amount IS NULL OR length(cost_amount) BETWEEN 1 AND 64),
  cost_currency TEXT
    CHECK (cost_currency IS NULL OR length(cost_currency) BETWEEN 1 AND 32),
  cost_provenance TEXT
    CHECK (
      cost_provenance IS NULL
      OR cost_provenance IN (
        'harness-reported',
        'harness-estimated',
        'api-price-equivalent'
      )
    ),
  cost_estimated INTEGER
    CHECK (cost_estimated IS NULL OR cost_estimated IN (0, 1)),
  descendants_included INTEGER NOT NULL
    CHECK (descendants_included IN (0, 1)),
  parent_session_id TEXT
    CHECK (
      parent_session_id IS NULL
      OR length(parent_session_id) BETWEEN 1 AND 512
    ),
  source_path TEXT
    CHECK (source_path IS NULL OR length(source_path) BETWEEN 1 AND 2048),
  extras_json TEXT
    CHECK (extras_json IS NULL OR json_valid(extras_json)),
  PRIMARY KEY (source_namespace, harness_session_id, native_event_id),
  CHECK ((cost_amount IS NULL) = (cost_currency IS NULL)),
  CHECK ((cost_amount IS NULL) = (cost_provenance IS NULL)),
  CHECK (cost_estimated IS NULL OR cost_amount IS NOT NULL),
  CHECK (descendants_included = 0),
  FOREIGN KEY (collected_by_installation_id)
    REFERENCES station_known_installations(installation_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS usage_observations_session_native
  ON usage_observations(
    source_namespace,
    harness_session_id,
    native_at,
    native_event_id
  );
CREATE INDEX IF NOT EXISTS usage_observations_parent
  ON usage_observations(parent_session_id)
  WHERE parent_session_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS usage_observations_immutable_update
BEFORE UPDATE ON usage_observations
BEGIN
  SELECT RAISE(ABORT, 'usage observations are immutable');
END;

CREATE TRIGGER IF NOT EXISTS usage_observations_immutable_delete
BEFORE DELETE ON usage_observations
BEGIN
  SELECT RAISE(ABORT, 'usage observations are immutable');
END;

-- usage_seat_session_associations: evidenced, time-scoped. Not the ledger key.
CREATE TABLE IF NOT EXISTS usage_seat_session_associations (
  actor_seat_id TEXT NOT NULL
    CHECK (
      length(actor_seat_id) = 69
      AND substr(actor_seat_id, 1, 5) = 'seat_'
      AND substr(actor_seat_id, 6) NOT GLOB '*[^a-f0-9]*'
    ),
  source_namespace TEXT NOT NULL
    CHECK (length(source_namespace) BETWEEN 1 AND 128),
  harness_session_id TEXT NOT NULL
    CHECK (length(harness_session_id) BETWEEN 1 AND 512),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  binding_id TEXT NOT NULL
    CHECK (length(binding_id) BETWEEN 1 AND 512),
  harness TEXT NOT NULL
    CHECK (length(harness) BETWEEN 1 AND 64),
  canvas_name TEXT
    CHECK (
      canvas_name IS NULL
      OR length(canvas_name) BETWEEN 1 AND 256
    ),
  node_id TEXT
    CHECK (
      node_id IS NULL
      OR length(node_id) BETWEEN 1 AND 256
    ),
  evidence_kind TEXT NOT NULL
    CHECK (
      evidence_kind IN (
        'pin-authorial',
        'capture-proven',
        'provision-minted',
        'projection-snapshot',
        'checkpoint-backfill'
      )
    ),
  evidence_at TEXT NOT NULL
    CHECK (length(evidence_at) BETWEEN 1 AND 64),
  scope_from TEXT NOT NULL
    CHECK (length(scope_from) BETWEEN 1 AND 64),
  scope_until TEXT
    CHECK (
      scope_until IS NULL
      OR length(scope_until) BETWEEN 1 AND 64
    ),
  collected_by_installation_id TEXT NOT NULL,
  PRIMARY KEY (
    actor_seat_id,
    source_namespace,
    harness_session_id,
    ordinal
  ),
  CHECK (
    (canvas_name IS NULL) = (node_id IS NULL)
  ),
  FOREIGN KEY (collected_by_installation_id)
    REFERENCES station_known_installations(installation_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS usage_seat_session_one_open
  ON usage_seat_session_associations(actor_seat_id)
  WHERE scope_until IS NULL;

CREATE INDEX IF NOT EXISTS usage_seat_session_by_session
  ON usage_seat_session_associations(
    source_namespace,
    harness_session_id,
    actor_seat_id
  );

CREATE TRIGGER IF NOT EXISTS usage_seat_session_immutable_update
BEFORE UPDATE ON usage_seat_session_associations
WHEN
  OLD.scope_until IS NOT NULL
  OR NEW.scope_until IS NULL
  OR OLD.actor_seat_id IS NOT NEW.actor_seat_id
  OR OLD.source_namespace IS NOT NEW.source_namespace
  OR OLD.harness_session_id IS NOT NEW.harness_session_id
  OR OLD.ordinal IS NOT NEW.ordinal
  OR OLD.binding_id IS NOT NEW.binding_id
  OR OLD.harness IS NOT NEW.harness
  OR OLD.canvas_name IS NOT NEW.canvas_name
  OR OLD.node_id IS NOT NEW.node_id
  OR OLD.evidence_kind IS NOT NEW.evidence_kind
  OR OLD.evidence_at IS NOT NEW.evidence_at
  OR OLD.scope_from IS NOT NEW.scope_from
  OR OLD.collected_by_installation_id IS NOT NEW.collected_by_installation_id
BEGIN
  SELECT RAISE(
    ABORT,
    'usage seat-session association is immutable except closing scope_until'
  );
END;

CREATE TRIGGER IF NOT EXISTS usage_seat_session_immutable_delete
BEFORE DELETE ON usage_seat_session_associations
BEGIN
  SELECT RAISE(ABORT, 'usage seat-session associations are immutable');
END;

-- Observational budgets. Append-only revisions. Current = max(ordinal).
CREATE TABLE IF NOT EXISTS usage_task_budget_revisions (
  canvas_name TEXT NOT NULL
    CHECK (length(canvas_name) BETWEEN 1 AND 256),
  node_id TEXT NOT NULL
    CHECK (length(node_id) BETWEEN 1 AND 256),
  task_id TEXT NOT NULL
    CHECK (length(task_id) BETWEEN 1 AND 256),
  entity_home TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target_input_tokens INTEGER
    CHECK (target_input_tokens IS NULL OR target_input_tokens >= 0),
  target_total_tokens INTEGER
    CHECK (target_total_tokens IS NULL OR target_total_tokens >= 0),
  target_cost_amount TEXT
    CHECK (
      target_cost_amount IS NULL
      OR length(target_cost_amount) BETWEEN 1 AND 64
    ),
  target_cost_currency TEXT
    CHECK (
      target_cost_currency IS NULL
      OR length(target_cost_currency) BETWEEN 1 AND 32
    ),
  inclusion_rule TEXT NOT NULL
    CHECK (length(inclusion_rule) BETWEEN 1 AND 128),
  set_at TEXT NOT NULL
    CHECK (length(set_at) BETWEEN 1 AND 64),
  PRIMARY KEY (canvas_name, node_id, task_id, entity_home, ordinal),
  CHECK (
    target_input_tokens IS NOT NULL
    OR target_total_tokens IS NOT NULL
    OR target_cost_amount IS NOT NULL
  ),
  CHECK (
    (target_cost_amount IS NULL) = (target_cost_currency IS NULL)
  ),
  FOREIGN KEY (entity_home)
    REFERENCES station_known_installations(installation_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  FOREIGN KEY (canvas_name, node_id, task_id, entity_home)
    REFERENCES work_tasks(canvas_name, node_id, task_id, entity_home)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
) STRICT, WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS usage_task_budget_immutable_update
BEFORE UPDATE ON usage_task_budget_revisions
BEGIN
  SELECT RAISE(ABORT, 'usage task budget revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS usage_task_budget_immutable_delete
BEFORE DELETE ON usage_task_budget_revisions
BEGIN
  SELECT RAISE(ABORT, 'usage task budget revisions are immutable');
END;
```

No task-rollup table in v2. A stored rollup would dual-write a join that is already determined by observations + associations + `work_task_transitions`. Compute it. If a later version needs a cache, that is a new expand with an explicit rebuild rule — not this step.

`CHECK (descendants_included = 0)` makes it impossible to smuggle an inclusive fleet total into the ledger. Inclusive numbers live in projections and must say so.

### Migration test plan

Follow [`tests/state-migrations.test.ts`](tests/state-migrations.test.ts) (in-memory `DatabaseSync`, `verifyAndStampStateSchema`, `PRAGMA user_version`) but on **production** DDL, not the toy `migration_items` schema.

Setup:

1. `database.exec(STATE_SCHEMA_V1_SQL)`; stamp `STATE_SCHEMA_V1_IDENTITY`; `PRAGMA user_version = 1`.
2. Insert a `station_known_installations` / `station_installation` pair (FK parent for work).
3. Insert one singleton `usage_state` row with a known `snapshots_json` byte string.
4. Insert a closed work triangle: `work_event_sequences`, then matching `work_events` + `work_facts` (and commands/dispositions if the CHECKs require the pair) for `task.create` then `task.claim`, plus the `work_tasks` current row and two `work_task_transitions` ordinals 0 and 1. Use the real CHECK-closed operation names. Do not UPDATE those log tables after insert.

Act: run `migrateStateSchema` with the real `1 → 2` plan (`safety: "expand-only"`, `fromIdentity: STATE_SCHEMA_V1_IDENTITY`).

Independent proofs (each assertion is a separate test):

| proof | assertion |
|---|---|
| existing product rows survive | `SELECT snapshots_json, last_live_at, updated_at FROM usage_state` byte-equal; `work_events` / `work_facts` / `work_commands` / `work_dispositions` / `work_tasks` / `work_task_transitions` row hashes equal to pre-migration snapshots |
| `usage_state` DDL untouched | `sqlite_schema.sql` for `name = 'usage_state'` equals the version-1 text (the `CREATE TABLE` in [`usage/state-schema.ts`](src/main/junto/usage/state-schema.ts) lines 3–13) |
| work-operation CHECK untouched | `sqlite_schema.sql` for `work_events` still contains exactly the nine operations listed at [`work/state-schema.ts`](src/main/junto/work/state-schema.ts) 327–337; same list still on `work_pending_commands` and `work_task_transitions`; no `usage.` prefix |
| expand-only | new tables exist and are empty; `PRAGMA user_version = 2`; `state_schema_identity.actual_schema_sha256` equals `expectedStateSchemaIdentity(STATE_SCHEMA_SQL)` after the v2 fragment is composed |
| immutability | `UPDATE usage_observations` / `DELETE` abort; association UPDATE that is not a `scope_until` close aborts; budget UPDATE/DELETE abort |
| missing ≠ zero | INSERT with `input_tokens = NULL` succeeds; a CHECK rejects negative tokens |
| cost CHECK | INSERT with `cost_amount` and NULL currency aborts |
| one open association | two rows with `scope_until IS NULL` for one `actor_seat_id` abort |
| log tables still immutable | `UPDATE work_events` still raises `work records are immutable` after the migration |

Fresh-install proof (separate test): empty db + `migrateStateSchema` at currentVersion 2 creates both `usage_state` and the three new tables; `usage_state` still has no seat/session/task columns.

Do not run this migration against the operator's `~/.junto/state/junto.db` from this orb.

---

## 4. Attribution algorithm

Task cost is a **read-time join**. Nothing in the observation row names a task.

```diagram
┌─────────────┐     prove      ┌──────────────────┐
│ harness     │───────────────▶│ usage_observations│  PK (namespace, session, native_id)
│ session file│                └─────────┬────────┘
└─────────────┘                          │ session
                                         ▼
┌─────────────┐     evidence    ┌───────────────────────────┐
│ pin/capture │───────────────▶│ usage_seat_session_assoc. │  scoped to seat, not a PK of usage
│ /provision  │                └─────────────┬─────────────┘
└─────────────┘                              │ actor_seat_id
                                             ▼
┌─────────────┐     claim fact  ┌───────────────────────────┐
│ ActorRef    │───────────────▶│ claim interval on task    │  ordered by transition ordinal
│ claimedBy   │                └───────────────────────────┘
└─────────────┘
```

### Claim interval (corrected)

Work over `work_task_transitions` where `lane = 'task'`, ordered by `ordinal` ascending. Ignore `origin_at` / `received_at` for sequence. Use `origin_at` only as an observational time bound after the interval is identified.

An interval **opens** on a row with `operation = 'task.claim'` and `to_state = 'working'`. Claimant is the **claim fact** `result_json.claimedBy` (`ActorRef`: seat + canvas + node), not a reconstruction from today's node, and not `work_tasks.actor_seat_id` alone (that column is current-row and is cleared on release).

While open, the interval **stays open** through:

- `to_state = 'working'` (self-transition)
- `to_state = 'input-required'`
- `to_state = 'auth-required'` (residual durable value; [`task.ts`](src/shared/task.ts) lines 98–105, [`work-model.ts`](src/shared/work-model.ts) 411–418)

The interval **closes** on the first later transition with:

- `to_state IN ('completed', 'canceled', 'failed', 'rejected')` — terminal disposition ([`task.ts`](src/shared/task.ts) `isTerminalTaskState`, lines 60–66; `archived` is a subsequent soft-delete and is not required to close attribution)
- or `to_state = 'submitted'` — explicit operator release, which also clears `claimedBy` ([`task.ts`](src/shared/task.ts) 129–138)

It does **not** close merely because the task left `working`. Closing at “next transition off working” would drop all `input-required` wait time and residual `auth-required` rows.

If no closer exists, the interval is still open. Open intervals attribute observations through “this read”.

Cross-home first adoption ([`repository.ts`](src/main/junto/work/repository.ts) 7070–7163) does not split the interval: the claim fact is still the open. Send-on to another board creates a **different** sink primary key `(canvas_name, node_id, task_id)` and therefore a different task identity; a later claim there is a new interval. Do not stitch them by task id alone.

### Binding an observation to an interval

An observation O attributes to interval I iff all of:

1. O.`harness_session_id` + O.`source_namespace` has an association A with `A.actor_seat_id = I.claimedBy.seatId`.
2. A's scope overlaps O. Overlap uses `native_at` when non-NULL; if `native_at` is NULL, overlap uses native-identity order inside the session together with `A.scope_from` / `scope_until` as observational bounds — and if that does not uniquely place O, O is **unattributed** (not guessed).
3. O falls inside I's ordinal window, bounded observationally by the claim fact's `origin_at` and the closer's `origin_at` (NULL closer → unbounded end). **Never** `received_at`. **Never** Command Center clock for a Remote-collected row.

Coverage of a task rollup is the fraction of O in the overlapping session stream that satisfied (1)–(3), plus an explicit descendants flag.

Concurrent claims cannot overlap on one seat ([`work_tasks_one_active_per_actor`](src/main/junto/work/state-schema.ts) 1259–1262). No split-brain allocation.

### Ambiguous cases (do not attribute; surface as coverage holes)

1. **No association** during the interval (operator-established: some seats have no `sessionId` — Codex capture 6/6, agy 5/5, prime-agent 1/2 on the measured board). Session readout may still exist; task cost does not.
2. **Association after the fact** from the current node rather than claim-time `ActorRef` — forbidden as a source; if only that exists, ambiguous.
3. **Fresh session mid-claim.** Capture currently refuses to replace a named session ([`seat-session-id.ts`](src/main/junto/term/seat-session-id.ts) 81–83), but pin isolation mints a new UUID ([`managed-spawn-plan.ts`](src/main/junto/term/managed-spawn-plan.ts) 417–424). Observations after `scope_until` of the previous association do not silently follow the seat. Until a new proven association exists, they are unattributed.
4. **Native timestamp missing** and native identity order does not sit cleanly inside `[scope_from, scope_until]` and `[claim.origin_at, close.origin_at]`.
5. **Descendant rollouts** whose `parent_session_id` equals the seat's named session. They are not the named session. Default task rollup excludes them. Including them is a separately labeled projection (`descendants=included`, coverage names the walk).
6. **Idle session usage** between claims (operator chat, compaction, a turn that started before claim). Same session, not in any interval → session readout only.
7. **Usage after close** on a session that continues. Not the closed task.
8. **Double association** of one session to two seats (defect). Session readout remains well-defined; task attribution is ambiguous.
9. **Cursor / Devin / Antigravity / Amp** — no session-grain events to join. Quota HUD is not a substitute.
10. **Grok `costUsdTicks`** as dollars. Currency stays `usd-ticks`. Converting is ambiguous until scale is verified.
11. **Hermes `estimated_cost_usd = 0`** on subscription. That is reported zero, not missing, when the column is present — and it is **not** “free”. Label estimated. Do not treat it as plan consumption.
12. **Command Center receive time** vs Remote `native_at` / Remote `ingested_at`. If only CC receive time is available, attribution is ambiguous.
13. **Checkpoint-backfill** associations overlapping a live capture/pin for the same seat. Live evidence wins; if they disagree on session id, ambiguous.
14. **Two Codex counters** for the same ordinal. Do not merge. Pick one namespace for the default readout (`junto/usage/codex/rollout` = thread ledger) and keep the other out of the default sum.
15. **Send-on / re-home.** Same `task_id` string on a new sink is a different identity. Summing by `task_id` alone is wrong.

---

## 5. Task-rollup projection and observational budget

### Rollup (computed, not stored)

For one task identity `(entity_home, canvas_name, node_id, task_id)` and one read:

```
direct = Σ delta-or-native-delta of observations attributed to its claim interval(s)
         where parent_session_id IS NULL
         descendants_included = 0
```

Emit:

- raw categories (NULL if every contributing row had NULL in that category; 0 if at least one row reported 0 and none reported NULL? **No.** If any contributing row has NULL in a category, the rollup category is NULL unless the inclusion rule says “treat missing as 0 for this source”, which no default rule does. Mixed NULL/0 in one category → NULL + `coverage = 'partial-category'`.)
- `through_read`: max `(native_at, native_event_id)` included
- `descendants = not-included` (literal)
- `coverage`: `complete` / `gapped` / `unassociated` / `open-interval`
- optional labeled views: uncached-input, api-price-equivalent, harness-reported cost — each with provenance

The smallest operator-visible number on a **seat** is not this rollup. It is:

> Observed direct usage for session `<id>` (`<source_namespace>`), through `<through_read>`: input=… output=… cache_read=… cache_creation=… reasoning=… total=… (native total, or omitted). Descendants not included.

Seat-lifetime spend, task cost, and plan-consumption share are all larger claims and must not be the default chip.

### Observational budget

`usage_task_budget_revisions` is operator intent, not a claim-time lock. Current target = max(`ordinal`) for that task identity.

Compare the computed rollup to the current target in the HUD. Exceeding the target does **not** reject `task.claim` in v2.

A later claim gate, if ever added, may honestly mean: **do not start another attempt after the observed target is exceeded**. That gate reads the last *closed* interval's rollup. It cannot cap an in-flight attempt (the collector is observational, descendants may be unseen, and cache/reasoning rules are labeled). It is not a hard cap, not a provider rate-limit, and not a subscription remaining-balance.

`inclusion_rule` on the budget row must name the same rule the rollup uses (`raw-categories/direct/descendants-excluded` by default). A budget in dollars is only valid when the attributed observations carry harness-reported cost in that currency (Pi). A budget in `usd-ticks` is not dollars.

---

## 6. Remote collection boundary

```diagram
Command Center                         Remote
┌─────────────────────┐                ┌──────────────────────────┐
│ usage_state (quota) │                │ harness files on disk    │
│ work_* (authority)  │                │ Remote runtime collector │
│ associations (CC    │     report     │ usage_observations       │
│  seats only)        │◀────extended───│ associations (Remote     │
│ bounded observation │     Station    │  seats)                  │
│ copies (display)    │                │ install-ops watermarks   │
└─────────────────────┘                └──────────────────────────┘
        ▲                                      ▲
        │ never SSH-scrape harness files       │ never write CC
        │                                      │ task/seat ids into
        └──────── OpenSSH adapter is           │ Quasar
                  transport for Station
                  ops only
```

Laws:

- Collect where the files are: Command Center runtime for CC-placed seats, Remote runtime for Remote-placed seats. The Remote already has a displayless Node process as the sole opener of its `junto.db` (AGENTS.md).
- Report bounded observation batches on the existing CC-opened session by **in-place extending** `ReportBatch` while Remote Stations remain unreleased ([`remote-station-release.ts`](src/shared/remote-station-release.ts) lines 1–7). Proposed sibling field: `usageObservations` (array, optional, default absent). `records` remains `WorkRecord[]` only. Do not add `usage.observe` to the work-operation CHECK. Do not add a seventh Station op. Do not add a capability array.
- Bound the new array so the existing 8 MiB / 256-record admission still holds ([`station-api.ts`](src/shared/station-api.ts) lines 43–51, 387–401). Practical cap: remaining bytes after work records, and a hard max (e.g. 256) observation envelopes per batch. `hasMore` already exists; reuse it rather than a second cursor type if the usage cursor can be expressed as a `RouteCursor`-shaped `(eventHome=collector, entityHome=collector, throughSequence=ingest ordinal)`. If that overloads Work identity, add `usageAcknowledge: RouteCursor[]` in the same in-place v1 extend — still not a new op.
- Decode stays `onExcessProperty: "error"`. Both peers must ship the extend together. That is acceptable before release; after `REMOTE_STATIONS_RELEASE_STATE` flips, this field is a protocol bump and is forbidden until then.
- The collecting installation is the ledger of record (`collected_by_installation_id`). CC may store copies for fleet display; it does not become entity home of a Remote session.
- No ambient SSH file scrape. Hermes adapter SSH ([`AGENTS.md`](AGENTS.md) Sources) stays a read-only profile enumerator. It is not a usage collector.
- Quasar is optional knowledge, not a runtime. Parsers live in the Junto process. Fixtures may be copied from Quasar later; the wire and the SQLite rows never mention Quasar.

Home-owned capture already notes that Remote cannot use the CC canvas writer ([`seat-session-id.ts`](src/main/junto/term/seat-session-id.ts) lines 36–39). Remote association writes go to the Remote's `usage_seat_session_associations`, then optionally ride the same extended report. They do not author `ether.terminal.sessionId` on CC canvases from this path.

---

## 7. Sequence (one independent proof per step)

Each step ships only when its proof is green. Later steps may not be used to justify earlier ones.

| step | ships | independent proof |
|---|---|---|
| **S0** | This document | Review: DDL does not mention `usage_state` columns or work operations; claim interval includes `input-required` |
| **S1** | Schema `1 → 2`, empty tables, identity hash | Migration tests in §3 on production DDL with populated immutable work logs and a `usage_state` row |
| **S2** | Local collector, one namespace (`junto/usage/grok/updates` or `junto/usage/claude/jsonl`), writes observations only | Fixture jsonl: INSERT OR IGNORE is idempotent; a missing field stores NULL not 0; a cumulative decrease (Hermes later) stores `coverage='reset'` |
| **S3** | Association write on proven pin/capture/provision | Test: `persistCapturedSessionId` → one open association; second session for the same seat closes `scope_until` and opens a new row; unverified PTY scrape writes nothing |
| **S4** | Session readout UI/API | Golden: number equals Σ of that session's ledger through the named read; payload contains the literal `descendants not included`; no `actor_seat_id` in the observation query |
| **S5** | Attribution join | Fixture: claim → input-required → working → completed attributes turns in all three active states; a turn after `submitted` is excluded; ordering by `ordinal` not `origin_at` (swap clocks, same ordinal, assertion holds) |
| **S6** | Task rollup (computed) | Same fixture: mixed NULL/0 in `cache_creation` yields NULL category + `partial-category`; Codex parent-only sum ≠ parent+descendants unless the label says included |
| **S7** | Observational budget HUD | Claim of a task whose rollup exceeds target still succeeds; HUD shows exceeded; no change to `task.claim` admission |
| **S8** | Remote collect + extended `ReportBatch` | Remote writes its own `junto.db`; CC receives a bounded batch; a test that SSH-reads `~/.codex/sessions` on the Remote from CC is refused; `WorkRecord` schema unchanged |
| **S9** | Optional later claim gate | Separate change: reject a *new* claim when the last **closed** interval's labeled rollup exceeds the current budget revision. In-flight work unaffected. Not part of v2. |

S2 before S3 proves the smallest true number without seats. S4 before S5 prevents task cost from becoming the default chip. S8 is blocked on the in-place Station extend, which is legal only while Remote Stations are unreleased — land it before the release-state flip.

---

## How far existing harnesses actually go

| harness | session-grain ledger | cost | descendants | task cost |
|---|---|---|---|---|
| claude | yes (jsonl turns) | no (subscription; no dollar in file) | unverified in this orb | yes, direct-only, once sessionId is pinned |
| codex | yes (root rollout `token_count`) | no | **must walk `parent_thread_id`**; default excludes them | yes for the named thread; dishonest as “effort cost” without descendants |
| grok | yes (`updates.jsonl` turns) | `costUsdTicks` only, scale unverified | unverified | yes as tokens; not as USD |
| pi | yes (jsonl) | `cost.total` harness-reported USD | unverified | yes, tokens + reported USD |
| hermes | yes as **session snapshots** from `state.db`, not turns | `estimated_cost_usd` (often 0) | unverified | weak grain (snapshot), estimated cost |
| cursor | no session file usage | quota HUD list-price extras only | n/a | no |
| devin | no | no | n/a | no |
| agy / antigravity | no | quota HUD only | n/a | no |
| kimi, muse, fx, omp, prime-agent, amp | session proof exists; **session-grain usage unverified in this orb** | unverified | unverified | blocked on a parser |

Quota HUD (`usage_state`) and this ledger answer different questions. Mixing them produces fake “share of plan” numbers. Do not.

---

## Unverified in this orb

- Live `~/.junto/state/junto.db` contents (seat census, task counts) — used as operator-established, not re-queried.
- Literal Claude / Codex / Pi jsonl schemas beyond what [`session-existence.ts`](src/main/junto/term/session-existence.ts), the 2026-09-16 assessment, and the usage-source parsers show.
- Hermes `sessions` table beyond columns in the aggregate SQL ([`hermes-source.ts`](src/main/junto/usage/hermes-source.ts) 123–133) and the existence probe (`id` / `session_id`).
- Whether Claude / Grok / Pi spawn descendant sessions analogous to Codex `parent_thread_id`.
- Grok `costUsdTicks` scale.
- Amp thread usage surfaces.
- `work_task_transitions` has no full UPDATE/DELETE immutability trigger (only `entity_home` immutable, lines 1680–1684). Repository only INSERTs (lines 4883–4916). This design reads them and does not change that.

---

## Non-goals (v2)

- Changing `usage_state`, quota polling, or HUD fail-open.
- A new Work operation or Station operation.
- Hard claim-time token caps.
- SSH scraping of Remote harness homes.
- Persisted task rollups.
- Putting Junto identity into Quasar.
- Physical DROP of anything.
- Treating observed-token share as subscription consumption.
