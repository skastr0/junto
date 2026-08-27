# State architecture

**Status:** normative

**Scope:** durable product state, canvas history, work-plane residency, Station
coordination, scheduling, backup, and process ownership

**Protocol:** [vellum-protocol.md](vellum-protocol.md)

Vellum Command has one storage architecture:

```text
one installation
  └── ~/.vellum-command/state/vellum-command.db
        └── one normal-runtime app StateEngine connection
              ├── owner: Electron main (Command Center)
              │          or displayless packaged Node process (Remote)
              ├── renderer IPC
              ├── owner-local canvas/work/browser/station controls
              └── typed Command Center → Station requests
```

There is no legacy store, compatibility mode, import-on-read, dual write, or
rollback to files.

## Ownership

- The state directory is mode `0700`; `vellum-command.db` is mode `0600`.
- During normal operation each installation has one sole app runtime database
  owner: Electron main on Command Center or the displayless packaged Node
  Remote process on Remote.
- Effect owns one scoped `StateEngine` connection and supplies it to every
  repository. A service must consume that shared layer, never construct a
  second connection.
- Renderers, headless CLIs, packaged helpers, and SSH callers use app-owned
  IPC or control protocols.
- The sole packaged exception is the staged candidate's sealed
  process. Schema migration runs on normal app open; there is no sealed preflight opener. Historical note: older releases used a clone-readiness path for the fixed canonical path
  read-only, when it exists, only after the installer has fully quiesced the
  incumbent and proved that SQLite was released. It closes that source before
  migrating and inspecting a disposable clone, accepts no database-path
  argument or environment redirect, and starts no product runtime planes. A
  first install creates only a disposable empty candidate.
- Tests may open an explicitly injected disposable database. That is not a
  product access path.

SQLite runs with WAL, `synchronous=NORMAL`, foreign keys enabled, a bounded busy
timeout, trusted-schema disabled, and extension loading disabled. Statements
are prepared once per connection. Atomic domain changes use one
`BEGIN IMMEDIATE` transaction. Bulk writes use small transactions with an
event-loop yield between chunks.

## Schema evolution

`PRAGMA user_version` is the one forward-only schema cursor.
`state_schema_identity` is the independent exact-schema witness. They serve
different jobs and must not be collapsed:

- the integer version selects one known `N → N+1` migration;
- the identity proves that the live tables, constraints, indexes, and triggers
  are exactly the shape that migration expects.

Version 1 freezes the completed SQLite/work-protocol consolidation. A fresh
database executes the current composed DDL and is stamped at the current
version. A non-empty unversioned database is adopted only if its live and
recorded identities equal the frozen version-1 witness. Every later schema
change increments `CURRENT_STATE_SCHEMA_VERSION`, retains every prior witness,
and appends exactly one synchronous migration step. Once a migration ships,
its version, name, input witness, and behavior are immutable. A repair is a new
forward migration, never an edit to history, because an installation may skip
any number of releases before applying the chain.

The current source/runtime schema is version 20. `CURRENT_STATE_SCHEMA_VERSION`
and `STATE_SCHEMA_MIGRATIONS` in
`src/main/vellum/state/migrations.ts` are the sole head and chain authority, so
this document does not duplicate the migration table. The public macOS 0.1.14
package remains historical evidence for schema version 18; it does not define
the current source/runtime head. The frozen `18 → 19` and `19 → 20` migrations
must never be edited, squashed, renumbered, or reused. The next schema change
must append `20 → 21`.

The frozen version-1 Command Center and Remote fixtures carry representative
canvas, topology, projection, Work, cursor, and scheduler rows. Tests hash the
fixtures, migrate disposable copies through the entire chain, and prove the
installed rows and original column values survive before current repositories
decode them.

Routine startup evolution follows four explicit stages:

1. **Expand.** Add a representation beside the installed one.
2. **Preserve.** Copy forward into new columns or tables without rewriting any
   pre-existing value or changing row identity.
3. **Deprecate.** Stop consuming and producing the old representation after
   parity is proven, but keep its bytes and never reuse its name or meaning.
4. **Retire.** Physically remove only through a separate operator-approved
   compaction after a coherent backup, exact replacement parity, no current
   reader or writer, and fleet compatibility evidence.

The startup migration capability enforces the first three stages. It rejects
row deletion, insertion into an installed table, overwriting an installed
column, schema-object removal, table/column rename or drop, row replacement,
attached databases, transaction control, and direct schema-version mutation.
Each step also proves every installed table and column survives with the same
shape. New columns and tables may receive copy-forward data.

Startup work must remain bounded. A migration may perform additive metadata
DDL and a demonstrably bounded copy-forward required to open the current
schema. It may not hide an unbounded table rebuild, `VACUUM`, derived-index
rebuild, or long backfill in application bootstrap. When such work is actually
needed, it is one specifically designed, durable, resumable, idempotent
post-start evolution job with visible status—not a speculative general
migration framework.

The complete chain runs in one `BEGIN IMMEDIATE` and must end in the exact
fresh-compiled current schema with no foreign-key violations. Only then do the
final identity and `user_version` commit. Any error rolls back the entire
chain. Newer versions, gaps, branches, unknown version-zero shapes, identity
drift, and final-schema mismatch fail without mutation.

This is schema evolution of the sole current store, not compatibility mode.
There is no downgrade, old-schema runtime reader, dual write, file-store
importer, or “delete `vellum-command.db` and retry” product instruction. Every real
migration requires an old-version fixture and a repository-level proof that
meaningful existing rows and old column values survive byte-for-byte.

Installed SQLite state is a legitimate destructive-state compatibility
boundary. Retaining a deprecated column or table is therefore required data
protection, not permission to keep a second runtime domain model. Current code
reads and writes one canonical representation; retained old bytes are inert
until an explicit recovery or compaction workflow uses them.

## Gentle update transaction

A package update and a schema migration form one operator-visible update
transaction:

1. **Stage and audit.** Download, stage, verify, and audit the candidate while
   the incumbent may continue running. This phase does not open the canonical
   database.
2. **Quiesce.** Stop the incumbent and prove it released SQLite before another
   process opens `vellum-command.db`.
3. **Mint evidence.** Invoke the exact staged packaged product executable in
   normal app-open migration path. For installed state it is now the
   sole opener, reads the fixed canonical database without write authority,
   creates and verifies one retained owner-only `VACUUM INTO` backup, copies
   that backup to a disposable candidate database, and closes the canonical
   source. A first install instead creates a disposable empty candidate and has
   no backup to retain.
4. **Prove the candidate.** Run the candidate's exact migration chain against
   the clone, verify current schema identity and foreign keys, and exercise
   Canvas, Work, Station, kernel-state, scheduler, and active-intent repository
   decoders. Emit one strict readiness receipt. Do not start a renderer,
   control socket, actor, browser, terminal, provider, or fleet runtime.
5. **Choose reversibility.** If preflight fails or is interrupted before
   activation, delete only the disposable candidate tree and resume the
   unchanged incumbent. The verified backup remains retained.
6. **Cross the fence.** Only a valid receipt permits the installer to enter its
   existing one-way package-activation phase. The candidate then opens the live
   database and performs the same forward migration during ordinary startup.
7. **Recover forward.** After a live schema-version advance or
   candidate-authored durable write commits, retain or repair the candidate.
   Never launch an older binary against advanced state. Refusal is
   deterministic: the read-only `schema-version-probe` reads
   `PRAGMA user_version` before any write open and returns
   `newer-than-supported`, and `startup-schema-recovery` offers the operator a
   plain "Update required" path (quit, or install the newer feed build) without
   opening, migrating, downgrading, or partially decoding the advanced state.
8. **Retain evidence.** Keep the pre-migration backup through at least one
   fully healthy candidate launch. No automatic backup-retirement policy exists
   yet.

The preflight receipt is a closed local installer proof, not a fourth product
version axis or a Station protocol. Its `.../v1` discriminator freezes that
receipt shape; it is not negotiated and grants no fleet authority.

Remote rollout is one installation at a time. Clone preflight proves data
admission but not physical operation. A candidate is not fully healthy merely
because preflight passed or a socket opened: post-activation qualification
still includes package launch, Station round trips, simulation, and
projection/work cursor continuity.

## One schema, different residency

Command Center and Remote run the same application and, at a given release,
bootstrap the same role-independent schema. Because installations update
independently, a fleet may temporarily contain different recognized schema
versions. Those databases are never opened or attached across machines; wire
compatibility is handled by the Station protocol. Role changes row residency
and runtime behavior, not table shape.

| State | Command Center | Remote |
|---|---|---|
| Canvas intent | Full authored generations and head | No authorial canvas |
| Station projection | Immutable emitted versions + one desired head | Immutable installed versions + one active head |
| Settings and topology | Local preferences + CC configuration | Local preferences + paired Remote configuration |
| Hosts | Enrolled fleet registry | Local installation state only |
| Work | CC-homed rows, every actor mailbox row, and integrated Remote replicas | Remote-home task/request/artifact/thread rows; no mailbox material rows |
| Events and receipts | Route-scoped Work streams, pending commands, dispositions, and transport ACK cursors | Route-scoped Work streams, dispositions, and transport ACK cursors |
| Browser/process resources | Resources physically owned here | Resources physically owned here |

No row is concurrently authoritative in two installations. A move to another
home is an explicit transfer with one cutover point. Code must not approximate
that move with dual reads or dual writes.

## Canvas and history

The canvas document remains JSON Canvas 1.0 plus Vellum Command's `ether` extension,
but its live representation is stored in SQLite:

- `canvas_generations` records the logical generation, cause, creation time,
  intent hash, and document count;
- `canvas_generation_documents` stores every complete document in that
  generation with its content hash;
- `canvas_head` selects the one current generation.

Every authorial commit is a full-map transaction. A generation is either
complete and selected or absent; no pointer file or manifest can become
half-written. History is queryable database state. Retention is keep-all by
default; physical retirement is a separate operator-approved compaction.

Current-baseline caveat: `canvases.ts` compacts
`canvas_generation_documents` bodies outside a 256-generation window on commit
(`CANVAS_GENERATION_BODY_RETENTION`), always protecting the head and every
`work_facts` basis generation and never pruning the `canvas_generations`
ledger. This automatic body deletion is a known deviation from keep-all and is
scheduled for removal by the relational-authority canvas cutover; no new
persistence change may widen it in the meantime.

JSON Canvas files, digests, SVG renders, screenshots, diagnostic bundles, and
plugin payloads are deliberate outputs or interoperability formats. The app
does not watch or ingest them as live state.

## Work plane and ordering

Tasks, task transitions, requests, messages, artifacts, and receipts are
normalized rows. Canvas nodes author the existence and placement of work
surfaces; their live contents do not force a canvas generation.

`WorkRepository` is the sole durable work/event authority. Every event identity
is the route-local triple `(event_home, entity_home, seq)`. The sequence is
monotonic only within that route, so two Remotes may each originate sequence
one without ambiguity. Every Station API event has:

- exactly one event-origin `InstallationId` and entity-authority
  `InstallationId`;
- a monotonic decimal logical sequence allocated within that route;
- origin and received timestamps for display only;
- a stable semantic content hash for idempotence.

Ordering within a route compares logical sequences as integers. Wall-clock
timestamps never order fleet history. Actor mailbox messages remain Command
Center-homed; task/request thread messages share their exact parent row's
home.

Message append events carry an explicit closed destination:
`mailbox`, `task(itemId)`, or `request(itemId)`. Mailbox facts materialize only
in Command Center `work_messages`; a Remote that issued the corresponding
command retains the returned fact/disposition as event state without creating
a local mailbox row. Task and request appends materialize in
`work_task_messages` only when the exact parent exists at the same
`entity_home`. `Message.taskId` remains an A2A cross-reference and must not be
used to infer residency; for task/request appends it must be present and agree
with the explicit destination item ID.

Artifacts may carry `task?: TaskRef`, where the reference contains
`kind: "task"`, item ID, canvas name, and task-sink node ID. Unbound artifacts
remain valid. A linked artifact is admitted only when the installed projection
contains that canvas and a task-kind sink at the referenced node. Durable
materialization then requires an exact already-claimed task at the artifact's
`entity_home`. The artifact publisher seat is preserved independently and may
differ from the task claimant.

SQLite represents that optional reference as one nullable group:
`task_canvas_name`, `task_node_id`, `task_id`, and `task_entity_home`. A
composite foreign key targets
`work_tasks(canvas_name, node_id, task_id, entity_home)`; a trigger requires
the referenced task's claimant to be non-null. Partial references, missing or
wrong sinks, cross-home references, and reference rewrites fail closed. There
is no legacy artifact `taskId` decoder, item-ID-only lookup, or fallback path.

A Command Center mutation homed on a Remote is first persisted as a pending
command. It is not materialized at Command Center. The Remote atomically
applies or causally rejects the command under its installed projection and
emits an ordered durable disposition. An applied disposition materializes the
command at Command Center; a rejected disposition resolves it into the
rejection ledger. ACKs advance transport only and never confer material
authority. Work Doctor exposes the status of locally issued pending, applied,
and rejected commands; route rejection history remains an internal diagnostic
surface.

A submitted task claim is the one explicit work-home cutover. Claim is the
atomic start of work (`submitted → working` plus one claimant), never an
assignment backlog. A Command Center-home queue may fan out to a Remote actor
only through a live synchronous Command Center-to-Remote exchange. While that
session is live, Command Center transactionally reserves one exact task and
actor and persists the claim command; that commit is the attempt boundary. If
either installation is already unreachable, no future claim is queued. A
disconnect after commit may replay only the same unresolved identity. Once the
Remote accepts the claim, the task remains homed there through terminal state
and continues while Command Center is unavailable. A Remote-home queue may
claim locally. Requests and artifacts are homed with their raising/publishing
actor. Actor mailbox messages remain Command Center-homed; task/request thread
messages share their exact parent row's home.

## Station API

The fleet protocol has five bounded, schema-decoded operations:

| Verb | Purpose |
|---|---|
| `pair` | Bind one Remote installation to one Command Center installation |
| `configure` | Commit Remote topology (role, host identity, supervision) |
| `project` | Install one complete replace-only canvas projection |
| `report` | Duplex exchange of strict Work commands, facts, dispositions, receipts, and cumulative full-route ACK cursors |
| `status` | Report installation identity, configuration, projection, cursors, and readiness |

Command Center invokes the `vellum-command station-stdio` executable through the
operator's enrolled OpenSSH route. It is one persistent bounded framed session:
the helper accepts no arbitrary command or path, connects to the Remote app's
owner-local Station socket, and relays correlated frames without opening
`vellum-command.db`. Command Center initiates the connection; once authenticated, the
Remote may initiate only `report` on that same duplex session. It never dials
Command Center or another Remote. OpenSSH authenticates the Remote host and
operator account. The fixed helper's owner-local socket handoff is trusted
same-user containment, not cryptographic proof of the SSH peer inside Electron
main. Vellum Command adds no bearer token, pairing secret, or parallel credential
store; main strict-decodes and authorizes every request.

Session loss does not create a second polling protocol. Each side reconnects
and resumes from durable `(event_home, entity_home)` cursors. A future HTTPS
adapter uses mutual TLS but preserves the same dispatcher and five verbs.

The Station wire cannot represent `role: "command-center"`: `configure`
strictly decodes `RemoteConfiguration`, and excess fields fail instead of being
pruned. Command Center selection is a separate local main-process settings
operation. Pairing and Command Center configuration are mutually exclusive in
both directions and checked in the same transaction that would write either
row. A successful Remote configuration also deletes every authorial
`canvas_head`, generation document, and generation row in that transaction;
the projection selected by `station_projection_head` is the Remote's only
active canvas residency.

Projection installation is monotonic:

- a newer generation installs transactionally;
- the same generation and hash is idempotent;
- an older generation is stale;
- the same generation with a different hash is a conflict.

Reports send strict versioned Work records strictly after the peer's
acknowledged full-route sequence. Cursors retain both `event_home` and
`entity_home`; no transport context supplies a hidden half of identity. The
receiver accepts only contiguous progress; gaps fail closed. A Remote writes
the command disposition before acknowledging the command. Completed ACKs are
durable, so replay or losing an outer response cannot duplicate semantic work.

Before repository acceptance, Station admission checks any artifact
`TaskRef` against the installed projection and rejects an absent canvas,
absent sink, or non-task node. The repository remains authoritative for task
row existence, non-null claimant, and same-home checks. Either failure occurs
before incoming event persistence or cursor/ACK advancement.

Every installation must be explicitly configured before Work may mutate.
Configured role and host identity are immutable until an explicit transfer
ceremony exists. Fleet `hostId → stationInstallationId` bindings are also
immutable: removal retires the active target but preserves its identity
tombstone; exact reactivation is allowed, while replacing it with a fresh
installation requires a new host identity.

Station projections are complete, replace-only canonical portfolio envelopes.
Their canvas bodies pass the same strict authorial decoder as Command Center
storage. Malformed, noncanonical, or runtime-work-bearing bodies fail before
any projection or cursor state is persisted.

Projection identity has its own monotonic sequence. It is not borrowed from
`canvas_generations`, because fleet topology can change the compiled portfolio
without changing authorial canvas content. Every version records
`source_canvas_generation` and `source_intent_sha256` for audit.

Command Center archives an exact compiled version before transport. Remote
installation inserts that same immutable version and advances
`station_projection_head` in one transaction. Both roles retain
`station_projection_versions`; `(generation, content_sha256)` is a unique
durable witness used for response-loss reconciliation and projected-intent
fact validation. Replace-only therefore means one active head and no merge,
not deletion of prior audit history.

## Independent ticks

Ticks do not synchronize across installations. Each tick operates only on rows
and schedulers homed locally. Therefore station cadence and phase alignment can
affect only how soon an update is observed.

`everyMinutes` timers use an explicit coalescing catch-up rule: after a delayed
or sleeping interval, evaluate at most one firing and advance to the latest due
slot. A newly discovered or restarted timer begins one interval in the future,
so restart does not create a latent pulse. Vellum Command currently has no
absolute-time timer kind. Any future timer kind must define its stale and
catch-up policy in schema and tests before runtime integration.

## Backup and recovery

The coherent backup primitive inside `StateEngine` is `VACUUM INTO` to a fresh
UUID-named, owner-only file under the engine-owned `state/backups/` directory.
The capability accepts no destination path: an operator, renderer, helper, or
future integration cannot redirect it into an arbitrary host directory or
cause StateEngine to change permissions outside its private state root. It may
run while the app owns the live database. The sealed candidate-preflight mode
also uses it after exclusive quiescence, through a read-only canonical
connection, before it migrates a disposable clone.

The bounded forward-recovery surface is inventory and export:

- inventory scans only the fixed owner-only `state/backups/` directory and
  fails closed on an unexpected or unsafe entry;
- every listed backup must be a non-symlink owner-only regular file and pass
  SQLite quick-check, foreign-key, schema-version, and schema-identity checks;
- export selects one verified backup ID and copies it to an explicit absolute
  new operator destination using create-exclusive semantics;
- export refuses overwrite, verifies the copied size and schema witness, and
  returns a content SHA-256 receipt.

This is portability and forensic evidence, not restore. No product path
replaces `vellum-command.db`, launches an older binary, or downgrades installed state.
Copying the live database, its WAL, its shared-memory file, or the wider
`~/.vellum-command` directory is not a coherent product backup. Vellum Command currently has
no restore surface.

Any app-owned backup protects only the current SQLite architecture. It does
not preserve or restore a retired JSON, manifest, seal, or projection-file
layout, and it cannot become a compatibility path for one.

When the content store holds binary objects, a coherent product unit is the
StateEngine backup **plus** a content snapshot of every `content_refs` digest
(`~/.vellum-command/content/snapshots/content-snapshot-<uuid>/`). The snapshot hardlinks
or copies immutable objects and refuses to mint when a referenced object is
missing or corrupt. Export and forensic copy may carry both receipts; there is
still no automatic restore that replaces the live `vellum-command.db`.

## Forbidden paths

The following are architectural defects, not compatibility features:

- `canvas-authority-v1`, content-addressed generation directories, or
  `current.json`;
- `settings.json`, `hosts.json`, `station-status.json`, or per-record token
  JSON used as product state;
- `topology.key`, `topology.seal`, `hosts.key`, or `hosts.seal`;
- `incoming.frame`, `applied.ack`, drop directories, or SSH file mutation for
  fleet coordination;
- a renderer, CLI, bridge, or helper opening the production database;
- a concurrent second product opener, per-service SQLite file, or direct
  connection outside `StateEngine`, except for the exact quiesced
  packaged-candidate read-only preflight defined above;
- file-store importers, compatibility readers, dual writes, feature flags, or
  rollback instructions that keep an obsolete path alive.

## Release proof

A storage change is releasable only when:

1. the whole schema boots on Command Center and Remote;
2. one scoped `StateEngine` connection serves all repositories;
3. canvas commits, work changes, topology changes, projection installs, and
   ACK advancement are transactionally proven;
4. linked artifact references prove projected task-sink presence, exact
   claimed same-home SQLite identity, and publisher/claimant independence;
5. mailbox and task/request message destinations prove their distinct
   material residency without inference from `Message.taskId`;
6. a Remote can continue its local simulation from its database while Command
   Center is closed;
7. reconnect retries converge by generation, route cursor, and durable command
   disposition;
8. headless and SSH helpers are proven to reach the app rather than the file;
9. `VACUUM INTO` produces a coherent owner-only backup;
10. backup inventory and export verify source and copy without providing
    restore, overwrite, or downgrade;
11. an older recognized SQLite version migrates in place with representative
    rows and old column values preserved, while failure rolls back schema,
    data, identity, and version;
12. skipped-release fixtures prove the append-only chain from every supported
    installed version;
13. destructive SQL and structural contraction are rejected by the migration
    capability;
14. sealed candidate-clone preflight proves current repository decoding without
    starting product runtime planes;
15. package interruption tests prove a pre-activation failure resumes the
    unchanged incumbent and a post-advance failure never launches the older
    binary;
16. repository search finds no retired product-state path.
