# State architecture

**Status:** normative

**Scope:** durable product state, canvas history, work-plane residency, Station
coordination, scheduling, backup, and process ownership

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
| Station projection | Optional coordination state | One complete current projection |
| Settings and topology | Local preferences + CC configuration | Local preferences + paired Remote configuration |
| Hosts | Enrolled fleet registry | Local installation state only |
| Work | CC-homed rows; messages always here | Rows single-homed to this Station |
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

- exactly one event origin and entity home;
- a monotonic decimal logical sequence allocated within that route;
- origin and received timestamps for display only;
- a stable semantic content hash for idempotence.

Ordering within a route compares logical sequences as integers. Wall-clock
timestamps never order fleet history. Messages remain Command Center-homed
because Command Center manages seat mailboxes.

A Command Center mutation homed on a Remote is first persisted as a pending
command. It is not materialized at Command Center. The Remote atomically
applies or causally rejects the command under its installed projection and
emits an ordered durable disposition. An applied disposition materializes the
command at Command Center; a rejected disposition resolves it into the
rejection ledger. ACKs advance transport only and never confer material
authority. Work Doctor exposes the status of locally issued pending, applied,
and rejected commands; route rejection history remains an internal diagnostic
surface.

## Station API

The fleet protocol has five bounded, schema-decoded operations:

| Verb | Purpose |
|---|---|
| `pair` | Bind one Remote installation to one Command Center installation |
| `configure` | Commit role-specific topology and projected browser trust |
| `project` | Install one complete replace-only canvas projection |
| `report` | Exchange canonical Work events and dispositions after cumulative route ACK cursors |
| `status` | Report installation identity, configuration, projection, cursors, and readiness |

Command Center invokes the fixed `vellum-station` executable through the
operator's enrolled OpenSSH route. The executable accepts no arguments, reads
one JSON request from stdin, connects to the Remote app's owner-local station
control socket, and returns one JSON response. It never opens `vellum.db`.

Projection installation is monotonic:

- a newer generation installs transactionally;
- the same generation and hash is idempotent;
- an older generation is stale;
- the same generation with a different hash is a conflict.

Reports send canonical Work events strictly after the peer's acknowledged
route sequence. The receiver accepts only contiguous progress; gaps fail
closed. A Remote writes the command disposition before acknowledging the
command. Completed ACKs are durable, so repeating a tick or losing an outer
response cannot duplicate semantic work.

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

The coherent backup primitive inside `StateEngine` is `VACUUM INTO` to a new
owner-only file. It may run while the app owns the live database. Linux v1
does not currently expose that primitive through an operator, CLI, IPC, or
restore surface. Copying or replacing `vellum.db`, its WAL, its shared-memory
file, or the wider `~/.vellum` directory is not a product backup or recovery
workflow.

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
4. a Remote can continue its local simulation from its database while Command
   Center is closed;
5. reconnect retries converge by generation, route cursor, and durable command
   disposition;
6. headless and SSH helpers are proven to reach the app rather than the file;
7. `VACUUM INTO` produces a coherent owner-only backup;
8. repository search finds no retired product-state path.
