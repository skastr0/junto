# State architecture

**Status:** normative

**Scope:** durable product state, canvas history, work-plane residency, Station
coordination, scheduling, backup, and process ownership

**Protocol:** [vellum-protocol.md](vellum-protocol.md)

Vellum has one storage architecture:

```text
one installation
  └── ~/.vellum/state/vellum.db
        └── one Electron-main StateEngine connection
              ├── renderer IPC
              ├── owner-local canvas/work/browser/station controls
              └── typed Command Center → Station requests
```

There is no legacy store, compatibility mode, import-on-read, dual write, or
rollback to files.

## Ownership

- The state directory is mode `0700`; `vellum.db` is mode `0600`.
- The Electron main process is the only production process that opens the
  database.
- Effect owns one scoped `StateEngine` connection and supplies it to every
  repository. A service must consume that shared layer, never construct a
  second connection.
- Renderers, headless CLIs, packaged helpers, and SSH callers use app-owned
  IPC or control protocols.
- Test and proof programs may open an explicitly injected disposable database.
  That is not a product access path.

SQLite runs with WAL, `synchronous=NORMAL`, foreign keys enabled, a bounded busy
timeout, trusted-schema disabled, and extension loading disabled. Statements
are prepared once per connection. Atomic domain changes use one
`BEGIN IMMEDIATE` transaction. Bulk writes use small transactions with an
event-loop yield between chunks.

## One schema, different residency

Command Center and Remote run the same app and bootstrap the same current
schema. Role changes row residency and runtime behavior, not table shape.

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

The canvas document remains JSON Canvas 1.0 plus Vellum's `ether` extension,
but its live representation is stored in SQLite:

- `canvas_generations` records the logical generation, cause, creation time,
  intent hash, and document count;
- `canvas_generation_documents` stores every complete document in that
  generation with its content hash;
- `canvas_head` selects the one current generation.

Every authorial commit is a full-map transaction. A generation is either
complete and selected or absent; no pointer file or manifest can become
half-written. History is queryable database state. Retention is keep-all until
an explicit product policy changes it.

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

Command Center invokes the fixed `vellum-station` executable through the
operator's enrolled OpenSSH route. It is one persistent bounded framed session:
the helper accepts no arbitrary command or path, connects to the Remote app's
owner-local Station socket, and relays correlated frames without opening
`vellum.db`. Command Center initiates the connection; once authenticated, the
Remote may initiate only `report` on that same duplex session. It never dials
Command Center or another Remote. OpenSSH authenticates the Remote host and
operator account. The fixed helper's owner-local socket handoff is trusted
same-user containment, not cryptographic proof of the SSH peer inside Electron
main. Vellum adds no bearer token, pairing secret, or parallel credential
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
so restart does not create a latent pulse. Vellum currently has no
absolute-time timer kind. Any future timer kind must define its stale and
catch-up policy in schema and tests before runtime integration.

## Backup and recovery

The coherent backup primitive inside `StateEngine` is `VACUUM INTO` to a fresh
UUID-named, owner-only file under the engine-owned `state/backups/` directory.
The capability accepts no destination path: an operator, renderer, helper, or
future integration cannot redirect it into an arbitrary host directory or
cause StateEngine to change permissions outside its private state root. It may
run while the app owns the live database. Linux v1 does not currently expose
that primitive through an operator, CLI, IPC, or restore surface. Copying or
replacing `vellum.db`, its WAL, its shared-memory file, or the wider
`~/.vellum` directory is not a product backup or recovery workflow.

Any app-owned backup protects only the current SQLite architecture. It does
not preserve or restore a retired JSON, manifest, seal, or projection-file
layout, and it cannot become a compatibility path for one.

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
- a second product database, per-service SQLite file, or direct connection
  outside `StateEngine`;
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
10. repository search finds no retired product-state path.
