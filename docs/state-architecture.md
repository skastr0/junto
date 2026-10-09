# State architecture

**Status:** normative

**Scope:** durable product state, canvases, scheduling, backup, and process
ownership

**Machines:** [machines.md](machines.md)

Junto has one storage architecture:

```text
one installation
  └── ~/.junto/state/junto.db
        └── one normal-runtime app StateEngine connection
              ├── owner: the Junto core on that machine
              ├── renderer IPC
              ├── owner-local canvas/work/browser controls
              └── a link to another machine's core
```

There is no legacy store, compatibility mode, import-on-read, dual write, or
rollback to files.

## Ownership

- The state directory is mode `0700`; `junto.db` is mode `0600`.
- During normal operation each installation has one sole app runtime database
  owner: the Junto core on that machine.
- `makeStateEngineLive` owns one scoped, private `node:sqlite` connection and
  publishes one Effect `SqlClient` alongside `StateEngine` metadata and backup.
  Repositories consume that shared client through typed services, never open
  another connection or run an Effect runtime internally.
- Renderers, headless CLIs, packaged helpers, and SSH callers use app-owned
  IPC or control protocols.
- The sole packaged exception is the staged candidate's sealed
  process. Schema migration runs on normal app open; there is no sealed preflight opener.
- Tests may open an explicitly injected disposable database. That is not a
  product access path.

SQLite runs with WAL, `synchronous=NORMAL`, foreign keys enabled, a bounded busy
timeout, trusted-schema disabled, and extension loading disabled. Statements
are prepared once per connection. Atomic domain changes use one
`BEGIN IMMEDIATE` transaction. Bulk writes use small transactions with an
event-loop yield between chunks.

## SQL ownership and transaction participants

Each repository owns its tables and decodes persisted rows at its SQL boundary.
Cross-domain operations call typed participants such as `CanvasRecords`,
`ContentManifest`, and the Crew/Live
`...Within` operations instead of reaching into another owner's tables.
Participants join the caller's transaction; the orchestrator selects the
atomic boundary with `sql.withTransaction`. Nested owners use savepoints.

The driver's single semaphore covers statements, read leases, transactions,
and backups. `withSqlRead` keeps multi-query reads coherent without issuing
BEGIN and reuses the connection inside a transaction. A yielding transaction
retains its lease; concurrent callers cannot see its uncommitted rows.
Failure, defects, and interruption release scoped resources and roll back.

`StateTransactionOperation` carries the owning operation into Live authority
checks, receipts, and diagnostics. Work admission is fiber-local and still
requires a journal record or an explicit closed journal-free reason.
`afterSqlCommit` publishes Work notifications only after the outer commit;
savepoint rollback discards its callbacks. Canvas/World caches do not publish
snapshots read from a caller-owned write that could still roll back.

The main-thread budget times each synchronous driver call, not the elapsed
time of an Effect transaction that can yield. Effect spans retain transaction
timing. Slow transaction-control statements report without throwing after a
successful BEGIN/COMMIT; ordinary statements retain strict-budget failures and
never replace an original SQL error with a timing error.

Raw SQLite remains confined to connection ownership, bootstrap/migrations,
schema inspection, backup/recovery, the separate install-ops store, external
read-only adapters, and disposable fixtures/tooling. Repositories expose no
raw reader/writer callbacks. This SQL consolidation changes no DDL, schema
version, or schema-identity witness.

## Schema evolution

`PRAGMA user_version` is the one forward-only schema cursor, and
`state_schema_identity` is the exact-schema witness. The version selects one
known `N → N+1` step; the identity proves the live tables, constraints,
indexes and triggers are exactly the shape that step expects.

Version 1 is the baseline. A fresh database executes the current DDL and is
stamped at the head. Every schema change increments
`CURRENT_STATE_SCHEMA_VERSION` (`src/main/junto/state/migrations.ts`) and
appends one synchronous step. A shipped step is immutable: its version, its
input witness, its behaviour and the DDL it creates never follow the head. A
repair is a new step.

There are two kinds of step, and the migration connection enforces which:

- **Expand only.** Adds tables, columns, indexes or triggers. It may not
  delete or overwrite a row, drop or rename anything, or write into a table
  that existed before it.
- **Consolidate.** Also drops the tables it names in `removesTables` and
  rebuilds the ones in `replacesTables`, copying every kept row. It needs the
  operator's approval for that work.

Every step proves that each table and column it does not name survives with
the same shape.

The whole chain runs in one `BEGIN IMMEDIATE` and must end in the exact
current schema with no foreign-key violation. Only then do the identity and
`user_version` commit. Any error rolls the whole chain back. A newer version,
a gap, an unknown shape or an identity drift fails without changing anything.

There is no downgrade, no old-schema runtime reader, no dual write, and no
instruction to delete `junto.db`. Every step ships with a proof on the frozen
version-1 databases that existing rows survive; a consolidate step is also
proven on a disposable copy of an installed database.

Startup work stays bounded. A long backfill is a separate, resumable job that
runs after the engine is up, never a step.

## Gentle update transaction

A package update and a schema migration form one operator-visible update
transaction:

1. **Stage and audit.** Download, stage, verify, and audit the candidate while
   the incumbent may continue running. This phase does not open the canonical
   database.
2. **Quiesce.** Stop the incumbent and prove it released SQLite before another
   process opens `junto.db`.
3. **Mint evidence.** Invoke the exact staged packaged product executable in
   normal app-open migration path. For installed state it is now the
   sole opener, reads the fixed canonical database without write authority,
   creates and verifies one retained owner-only `VACUUM INTO` backup, copies
   that backup to a disposable candidate database, and closes the canonical
   source. A first install instead creates a disposable empty candidate and has
   no backup to retain.
4. **Prove the candidate.** Run the candidate's exact migration chain against
   the clone, verify current schema identity and foreign keys, and exercise
   Canvas, Work, kernel-state, scheduler, and active-intent repository
   decoders. Emit one strict readiness receipt. Do not start a renderer,
   control socket, actor, browser, terminal, or provider runtime.
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

The preflight receipt is a closed local installer proof. Its `.../v1`
discriminator freezes that receipt shape; it is not negotiated.

Clone preflight proves data admission but not physical operation. A candidate
is not fully healthy merely because preflight passed or a socket opened.

## Canvases

Facts older than the document cutover keep their original hash and are not re-verifiable.

There is no canvas document. A canvas is a name and the rows on it: one table
per kind of node (seats, regions, terminals, pages, task boards and the rest)
and one for wires, each with real columns for exactly that kind's fields
(`src/shared/model/`). There is no extension column and no stored body.

A change is a command that names the rows it touches. It commits in one
transaction, advances that canvas's `seq` by one, and main emits one event
carrying the rows that changed. Nothing reads, writes, compares or hashes a
canvas as one value, and no history of whole canvases is kept.

## Independent ticks

Ticks do not synchronize across machines. Each tick operates only on rows and
schedulers on its own machine.

`everyMinutes` timers use an explicit coalescing catch-up rule: after a delayed
or sleeping interval, evaluate at most one firing and advance to the latest due
slot. A newly discovered or restarted timer begins one interval in the future,
so restart does not create a latent pulse. Junto currently has no
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
replaces `junto.db`, launches an older binary, or downgrades installed state.
Copying the live database, its WAL, its shared-memory file, or the wider
`~/.junto` directory is not a coherent product backup. Junto currently has
no restore surface.

Any app-owned backup protects only the current SQLite architecture. It does
not preserve or restore a JSON, manifest or seal file layout, and it cannot
become a compatibility path for one.

When the content store holds binary objects, a coherent product unit is the
StateEngine backup **plus** a content snapshot of every `content_refs` digest
(`~/.junto/content/snapshots/content-snapshot-<uuid>/`). The snapshot hardlinks
or copies immutable objects and refuses to mint when a referenced object is
missing or corrupt. Export and forensic copy may carry both receipts; there is
still no automatic restore that replaces the live `junto.db`.

## Forbidden paths

The following are architectural defects, not compatibility features:

- `canvas-authority-v1`, content-addressed generation directories, or
  `current.json`;
- `settings.json`, `hosts.json`, `station-status.json`, or per-record token
  JSON used as product state;
- `topology.key`, `topology.seal`, `hosts.key`, or `hosts.seal`;
- `incoming.frame`, `applied.ack`, drop directories, or SSH file mutation for
  coordination between machines;
- a renderer, CLI, bridge, or helper opening the production database;
- a concurrent second product opener, per-service SQLite file, or direct
  connection outside `StateEngine`, except for the exact quiesced
  packaged-candidate read-only preflight defined above;
- file-store importers, compatibility readers, dual writes, feature flags, or
  rollback instructions that keep an obsolete path alive.

## Release proof

A storage change is releasable only when:

1. the whole schema boots on every machine;
2. one scoped `StateEngine` connection serves all repositories;
3. canvas commits and work changes are transactionally proven;
4. headless and SSH helpers are proven to reach the app rather than the file;
5. `VACUUM INTO` produces a coherent owner-only backup;
6. backup inventory and export verify source and copy without providing
   restore, overwrite, or downgrade;
7. an older recognized SQLite version migrates in place with representative
   rows and old column values preserved, while failure rolls back schema,
   data, identity, and version;
8. skipped-release fixtures prove the append-only chain from every supported
   installed version;
9. sealed candidate-clone preflight proves current repository decoding without
   starting product runtime planes;
10. package interruption tests prove a pre-activation failure resumes the
    unchanged incumbent and a post-advance failure never launches the older
    binary.
