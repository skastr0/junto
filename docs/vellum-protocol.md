# Vellum protocol

**Status:** normative contract; foundation implemented, package and
multi-installation qualification in progress

**Last revised:** 2026-07-28

**Audience:** Vellum contributors, reviewers, and operators qualifying
Command Center-to-Remote behavior

**Governs:** installation identity, intent projection, work ownership,
Command Center-to-Remote synchronization, offline execution, transport
adapters, and convergence

**Security doctrine:** [security-doctrine.md](security-doctrine.md)

**Storage contract:** [state-architecture.md](state-architecture.md)

**Factory capability model:**
[architecture-factory-physics.md](architecture-factory-physics.md)

## Summary

Vellum is one operator-owned factory with one Command Center and any number of
Remotes. Command Center is the sole author of factory intent. Each Remote keeps
one complete replace-only projection of that intent and independently executes
the actors, schedulers, physical resources, and work items whose authority is
homed there.

The Station API is the closed five-verb protocol connecting them:
`pair`, `configure`, `project`, `report`, and `status`. Command Center opens the
authenticated connection. Once a session exists, either side may send `report`
traffic on that same connection. A Remote never opens a fleet-control
connection to Command Center or another Remote.

This is not a shared-document protocol. It has no canvas merge, CRDT, election,
lease, shared offline queue, or clock-ordering algorithm. Correctness comes
from:

- one authorial Command Center;
- one durable authority home per mutable work item;
- one local executor per actor, scheduler, and physical resource;
- logical event identities and cumulative acknowledgements;
- complete replace-only intent projection;
- idempotent replay after reconnect.

This document names the canonical contract. A source implementation, fixture,
or unit test is evidence for its exact claim, not blanket release
qualification. The proof matrix and packaged multi-installation gate below
remain the authority for production claims.

## Version axes

Vellum exposes exactly three version facts:

1. **App release** identifies the shipped application bundle.
2. **SQLite schema version** identifies the local durable shape selected by
   `PRAGMA user_version`.
3. **Station protocol** is the one integer negotiated for a
   Command Center-to-Remote session.

App release and SQLite schema version are diagnostic facts. They do not select
a wire codec and they do not authorize a feature. Two installations may have
different app and schema versions while communicating through the same
Station protocol.

SQLite schema version 1 is the frozen durable baseline. The current local
schema is version 3, reached through the immutable chain:

```text
1 → 2  add-license-activation
2 → 3  bind-license-entitlement-to-dodo-product
```

Those numbers are local database facts. They are neither sent as migration
instructions nor negotiated as Station behavior.

Every release declares one contiguous Station-protocol support descriptor:

```text
StationProtocolSupport {
  preferred: integer
  compatibleFrom: integer
  warnBelow: integer
}
```

The invariant is:

```text
compatibleFrom <= warnBelow <= preferred
```

`preferred` is the highest exact Station codec the release implements and
prefers. `compatibleFrom` is the oldest exact codec it will accept.
`warnBelow` is the deprecation threshold: a selected protocol below either
peer's threshold remains compatible but produces an operator-visible upgrade
warning.

The current baseline is Station protocol **2**, with support policy:

```text
{ preferred: 2, compatibleFrom: 2, warnBelow: 2 }
```

This negotiation work does not invent protocol 3. A new Station protocol
number exists only when the actual closed wire bundle changes.

One negotiated integer selects the complete strict bundle: session framing,
control envelope, five Station API operations, Work records, projection
encoding, bounds, and failure semantics. Their current `.../v2` discriminators
are members of Station protocol 2, not independently negotiated versions.
There is no session-version array, Station-API-version array,
Work-version array, projection-version array, fallback-protocol number, or
capability array.

Likewise, literals such as `vellum/station-protocol-preface/v1` and
`vellum-state-update-preflight/v1` are closed message-shape discriminators.
They are not independently negotiated product version axes. Only the selected
Station protocol integer chooses cross-installation wire behavior; the state
preflight receipt is local to one package update and never enters Station API.

## Canonical end state

The canonical implementation has:

1. one `~/.vellum/state/vellum.db` per installation;
2. one normal-runtime Electron-main `StateEngine` connection per database,
   plus the exact quiesced packaged-candidate read-only preflight described
   below;
3. one role-independent schema per app version, migrated locally on each
   installation without requiring fleet-wide lockstep;
4. one Command Center authoring canvas and protected topology;
5. one complete replace-only authorial projection on each Remote;
6. normalized, single-home work rows outside canvas generations;
7. one transport-neutral Station dispatcher with exactly five verbs;
8. one Command Center-initiated persistent session per reachable Remote;
9. OpenSSH as the first authenticated session adapter;
10. a clean adapter boundary for future HTTPS with mutual TLS;
11. one negotiated Station protocol integer bound before domain mutation;
12. no file-store, polling-protocol, remote-browser, or retired internal
    compatibility path surviving beside that end state.

The file-store-to-SQLite change was a direct cutover. SQLite version 1 is now
the durable baseline: later releases migrate an installed `vellum.db`
forward in place through a contiguous transactionally applied chain. This
does not create protocol coexistence, legacy file import, dual reads/writes,
or downgrade support. Unknown, drifted, and newer database versions fail
closed without mutation; a recognized older version is upgraded and retained,
not deleted. Released migrations are append-only, and routine evolution is
expand/preserve/deprecate: installed rows, fields, names, and meanings survive.

### Local package update is not Station negotiation

Each installation upgrades its own package and database. Command Center never
opens, copies, attaches, or migrates a Remote database through the Station
wire, and a Remote never asks Command Center to interpret its local schema.

The local update transaction is:

1. stage, verify, and audit the candidate while the incumbent may run, without
   opening the canonical database;
2. fully quiesce the incumbent and prove that it released SQLite;
3. invoke the exact staged packaged Electron executable in sealed
   `--vellum-state-preflight` mode;
4. for installed state, let that sole proof process open the fixed canonical
   path read-only, create and verify a retained backup, clone it, and close the
   source; for a first install, create only a disposable empty candidate;
   migrate the candidate and decode Canvas, Work, Station, kernel-state,
   scheduler, and active intent through current repositories;
5. on failure before activation, resume the unchanged incumbent; on success,
   cross the installer activation fence and let the candidate migrate live
   state during ordinary startup;
6. after a live schema advance or candidate-authored durable write, recover
   forward and never launch an older binary against that state.

The proof process starts no actor, browser, terminal, socket, provider, or
fleet plane. Its strict receipt proves local state admission only. Post-update
Station compatibility is still decided exclusively by the Station protocol
preface and selected exact codec.

Verified pre-migration backups may be inventoried and exported as portability
or forensic evidence. They are not a restore, downgrade, alternate authority,
or substitute Station synchronization channel.

## Terminology

### Factory

One operator's Vellum system: one sovereign intent, one Command Center, and
zero or more enrolled Remotes.

### Installation

One installed Vellum app with one local database and one durable
`InstallationId`. Installation identity survives ordinary app restarts. It is
a routing and continuity fact, not a credential.

### Command Center

The only installation role that:

- accepts direct operator authoring of canvases and protected topology;
- owns the complete factory view;
- enrolls Remotes and owns their route locators;
- arbitrates claims from Command Center-home task queues;
- initiates every fleet transport connection.

### Remote

The installation role that:

- accepts complete Command Center projections;
- never authors or merges canvas intent;
- executes only its locally placed actors, schedulers, pages, and processes;
- owns the mutable work rows homed there;
- continues that work under its last projection while Command Center is
  unavailable;
- reports durable facts when the Command Center session returns.

`Station` is a topology and protocol noun. The two installation roles are
exactly `command-center` and `remote`; there is no third `station` role.

### Station API

The transport-neutral domain protocol between Command Center and one Remote.
Its operation union is exactly:

```text
pair | configure | project | report | status
```

Transport framing, SSH endpoints, HTTPS URLs, certificates, socket paths, and
process launch details are not Station API fields.

### HostId

An operator-visible placement key. A `HostId` is bound to one
`InstallationId` by fleet enrollment. It selects where projected actors and
physical resources run, but it is not itself a durable work-authority
identity. It is not:

- a network address;
- an SSH destination;
- a certificate;
- proof of peer identity;
- globally meaningful outside its factory.

### Route locator

Adapter-specific information Command Center uses to reach a Remote, such as an
OpenSSH destination or future HTTPS URL. Route locators live in Command Center
fleet state. They are not projected canvas intent, work authority, or
credentials by themselves.

### ActorRef, SinkRef, and TaskRef

Canvas node IDs are scoped by canvas. A sink reference is:

```text
SinkRef {
  canvasName: string
  nodeId: string
}
```

An actor additionally has one globally stable execution-seat identity:

```text
ActorSeatId = branded string

ActorRef {
  seatId: ActorSeatId
  canvasName: string
  nodeId: string
}

TaskRef {
  kind: "task"
  itemId: string
  sink: SinkRef
}
```

`ActorSeatId` is compiled, not authored. It is stable for one executable actor
principal on one authority installation and is included in each Station
projection. If more than one canvas reference resolves to the same executable
principal, those references must carry the same seat ID; an ambiguous or
conflicting compile fails closed. Active-task and pending-claim uniqueness key
on `ActorSeatId`, never an unqualified node ID or canvas-local `ActorRef`.

Task IDs are likewise sink-local. `TaskRef` is the only artifact-to-task
reference: the task item ID is inseparable from its canvas and task-sink node.
An artifact `taskId` field or any lookup by item ID alone is not a supported
contract.

### Event home and entity home

- `event_home` is the `InstallationId` that allocated and emitted an event.
- `entity_home` is the `InstallationId` whose authority lane the record
  addresses.
- `seq` is a canonical decimal logical sequence within that
  `(event_home, entity_home)` route.

For a fact, `entity_home` is the installation that committed and owns the
resulting material row. For a command, it is the prospective authority asked
to apply the mutation; the command alone does not transfer the underlying
item. For a disposition, it equals the referenced command's `entity_home`.
This one interpretation keeps command delivery, fact replay, dispositions,
and route cursors on the same stable route key.

The durable event identity is:

```text
(event_home, entity_home, seq)
```

The product must use `InstallationId` consistently. Legacy aliases such as
`originStationId` and `originInstallationId` must not survive beside canonical
`eventHome`; all three attempted to name the same concept. Command Center work
uses the Command Center's real `InstallationId`; there is no
`COMMAND_CENTER_WORK_HOME` sentinel. `HostId` remains a placement label whose
fleet enrollment resolves to an installation.

## The five governing planes

### 1. Intent plane

The Command Center canvas and protected topology are operator-authored intent.
They live in `canvas_generations`, `canvas_generation_documents`, and
`canvas_head`.

Agents cannot mutate this plane. A Remote cannot retain a hidden authorial
head or convert its projection into one.

### 2. Projection plane

A Remote stores one complete authorial portfolio projection:

- all canvases required to understand its factory;
- stable node and edge identities;
- actor, sink, scheduler, region, placement, and capability definitions;
- no runtime task/request/message/artifact contents;
- no SSH endpoint, transport credential, browser key, or peer-Remote route.

Projection is a replaceable cache. It is never merged.

### 3. Work plane

Tasks, task transitions, requests, messages, artifacts, command dispositions,
delivery receipts, and logical cursors are normalized SQLite state. They are
not authored canvas content.

Work uses single-item authority. A sink definition may be visible everywhere
while each mutable item still has exactly one authority home.

### 4. Runtime plane

Actors, browser pages, terminals, processes, profiles, and scheduler ticks run
on one physical installation. Runtime locality is not replicated away by a
global sink definition.

### 5. Transport plane

An authenticated connection carries Station API frames. Authentication proves
which network/process route delivered the frame. It does not itself grant a
verb, change a role, author intent, or satisfy an edge.

Transport acknowledgements describe contiguous delivery only. They never
decide work ownership.

## Placement, sinks, and item authority

Placement and capability are separate:

- placement answers **where does this executable thing run?**
- an edge plus port answers **may this actor use this sink?**
- item home answers **which installation may mutate this work item now?**

The canonical locality table is:

| Surface | Definition visibility | Execution or item authority |
|---|---|---|
| `agent` actor | complete projection | executes only on its placed host |
| `task` sink | complete projection | queue installation arbitrates submitted tasks; a claimed task transfers once to its actor's authority installation |
| `requests` sink | complete projection | each request is homed with its raising actor's authority installation |
| `artifacts` sink | complete projection | each artifact is homed with its publishing actor's authority installation |
| actor mailbox | projected actor seat | messages remain Command Center-homed |
| `page` sink | complete projection | executable and browser-profile local; actor and page must share an installation |
| `watcher` / `timer` | complete projection | evaluates only on its placed host |
| region / furniture | complete projection | no execution authority |

### Logical sinks are not executable hosts

`task`, `requests`, and `artifacts` nodes are stable logical destinations.
They are not forced to execute on the same host as every actor that can reach
them. A Remote actor with the required edge and port may address any such sink
present in its installed projection.

The sink's home still matters:

- it selects the default authority for newly submitted task backlog;
- it selects which installation may freely arbitrate an unclaimed task;
- it does not restrict where requests or artifacts may originate;
- it does not grant access without the current edge and port.

### Page is the deliberate exception

A browser page is a sink with a physical runtime requirement. It is always
host-local. Vellum never relays page operations through Command Center or the
Station API.

## Work authority laws

1. Every mutable work item has one authority home.
2. Only the authority home may perform its immediate material mutation.
3. A remote command is not material authority until the destination applies
   it and durably reports an applied disposition.
4. An accepted fact never causes two installations to become co-authoritative.
5. A work item never returns to an earlier home through retry.
6. A task claim may transfer authority exactly once, from its submitted queue
   installation to the claiming actor's authority installation.
7. Requests and artifacts are homed where their actor creates them.
8. Actor mailbox messages remain Command Center-homed; task/request thread
   messages share their exact parent row's home.
9. Timestamps are display facts, never ordering or ownership input.
10. Reconnect replays events; it does not merge rows.

## Task semantics

### State machine

The canonical task states remain:

```text
submitted
working
input-required
auth-required
completed
canceled
failed
rejected
```

Terminal states are:

```text
completed | canceled | failed | rejected
```

A task in `working`, `input-required`, or `auth-required` is active work owned
by exactly one actor.

### Claim is start

There is no `assigned` state, actor backlog, reservation queue, or batch of
tasks attached to one actor.

A successful claim atomically means:

```text
submitted + unclaimed
  → working + claimedBy(actor)
```

That transition is the start of work. An actor may own at most one active task
across its seat. A second claim fails with contention.

Only `task.claim` may perform the first `submitted → working` transition.
A generic task update cannot enter `working` from `submitted` or stamp the
first claimant. Resuming the same claimed task from `input-required` or
`auth-required` to `working` remains a normal owner-home transition.

The transport may expose a pending command during a live claim round trip or
while recovering its uncertain result after a connection loss. That is
delivery state, not a task assignment state. The task remains `submitted`
until the Remote transaction starts it.

When the selected actor is homed on Command Center, claim is one local SQLite
transaction and task authority remains on Command Center. The protocol flow
below exists only for the first claim of a Command Center-home task by an actor
whose authority installation is a Remote.

### Command Center-home queue to Remote actor

For a submitted task homed on Command Center:

1. Command Center's simulation selects one eligible, idle actor under the
   current canvas edges, ports, work role, pause state, and placement.
2. Command Center requires a live authenticated session to that actor's
   Remote. If the Remote is already unreachable, the claim attempt does not
   enqueue future work.
3. While that session is live, Command Center transactionally persists one
   pending `task.claim` command targeted at that Remote and reserves both the
   source task and actor.
4. Committing that transaction is the claim-attempt boundary. It proves that
   Command Center synchronously arbitrated this exact task/actor pair while
   the route was live, but it does not materialize a working task.
5. The Remote receives the command through `report`.
6. The Remote validates:
   - the command arrived through the active CC-opened session for its paired
     Command Center;
   - command identity and semantic content hash;
   - source queue home is that paired Command Center installation;
   - the embedded source task is canonical, `submitted`, and unclaimed;
   - target and adopted entity home are the local Remote installation;
   - installed projection contains the referenced sink, actor, edge, and port;
   - actor placement is local;
   - edge and port still permit the operation under its installed intent;
   - no conflicting local adoption exists for the task identity;
   - actor owns no other active task.
7. In one SQLite transaction, the Remote:
   - adopts the embedded canonical task snapshot as `working`;
   - stamps `claimedBy`;
   - adopts the task's entity home as its own `InstallationId`;
   - writes the resulting canonical fact;
   - writes an applied disposition for the Command Center command.
8. Only after that transaction may the Remote acknowledge the command.
9. Command Center receives the disposition in the same live exchange and
   materializes its integrated read model as `working` and Remote-homed.

If validation fails, the Remote writes an ordered causal rejection before
acknowledging. Command Center leaves the task submitted and exposes the
rejection.

If Command Center or the target Remote is unavailable before step 3, no claim
attempt exists and nothing is queued for a future actor. This is the precise
meaning of synchronous claim arbitration: Command Center must be live, must
select the actor, and must create the durable attempt while an active session
exists. Vellum does not pretend the two SQLite transactions are one distributed
transaction.

If the connection is lost after step 3, including after commit but before the
first frame write completes, the result is uncertain rather than failed.
Command Center does not reassign the task or select a replacement actor.
Reconnect may replay only that same command identity and content until the
Remote returns its durable applied/rejected disposition. This is recovery of a
live-arbitrated attempt, not delayed offline claiming.

The pending-command store must enforce:

- at most one unresolved claim attempt for a task identity;
- at most one unresolved claim attempt for an `ActorSeatId`;
- one active task for an `ActorSeatId` after adoption;
- exact identity/content replay or a hard conflict.

### Claim command payload

A `task.claim` command is self-contained because projection deliberately
excludes work rows. Its typed body contains:

```text
TaskClaimAction {
  operation: "task.claim"
  sourceQueueHome: InstallationId
  sourcePredecessor: WorkRecordId | null
  sourceTask: Task                     // exactly submitted and unclaimed
  sink: SinkRef                        // (canvasName, nodeId)
  actor: ActorRef                      // (seatId, canvasName, nodeId)
  targetHome: InstallationId
}
```

The outer `WorkCommand` supplies the command `WorkRecordId`, command content
hash, item identity, and adopted `entityHome`. The Remote is not expected to
reconstruct or independently prove the Command Center's source row: Command
Center is the authority that arbitrated it. The Remote instead proves the
strict admitted command and paired Command Center declaration, snapshot
coherence, local target and placement, installed capability edge/port, actor
idleness, and absence of a conflicting adoption. An exact prior
applied/rejected disposition is an idempotent replay.

### Station-home queue

A task sink may declare a Remote as its queue home. That Remote may create and
claim its submitted tasks locally while Command Center is unavailable.

Free local claim still requires:

- actor and queue authority on the same Remote;
- current projected edge and port;
- one submitted unclaimed task;
- one idle actor;
- one atomic `submitted → working` transition.

A different Remote never claims that queue. No Remote-to-Remote claim route
exists.

### After claim

Once claimed, the task remains homed with its actor's authority installation
through:

```text
working ↔ input-required
working ↔ auth-required
working → terminal
```

Command Center closing does not interrupt those transitions. The Remote
records them in its own database and reports them later.

There is no automatic:

- unclaim;
- steal;
- lease expiry;
- reassignment after timeout;
- return to submitted;
- speculative second executor.

If the actor or Remote is stalled, Vellum reports that fact. A future explicit
operator recovery operation must define one atomic authority cutover before it
can re-home active work.

Deleting an actor retires its stable seat and stops its Vellum-owned runtime;
it never deletes attribution, artifacts, receipts, or completed history. An
active task claimed by that seat stays claimed and single-home and is surfaced
as stalled/orphaned lifecycle state. Vellum does not silently turn actor
deletion into unclaim, requeue, steal, or reassignment.

### Starting the managed actor process

The durable task transition and process notification are distinct mechanisms,
but not distinct assignment states:

1. the claim transaction starts the task;
2. a durable delivery record identifies the exact task/actor/revision prompt;
3. the local runtime ensures that actor seat is running;
4. it delivers the prompt at the managed actor's turn boundary;
5. after the managed transport accepts the prompt, Vellum commits an accepted
   delivery receipt under the stable delivery ID;
6. a failed delivery retries without creating another claim.

After a process restart, delivery resumes from SQLite receipts. A durable
receipt suppresses every later retry after that acceptance is recorded; a
process-local `Set` is not product durability.

The transport send and SQLite receipt cannot be one atomic transaction. A
crash after transport acceptance but before receipt commit may therefore
redeliver the same stable delivery ID. Vellum must never write the receipt
before transport acceptance, because that would turn the same crash into
permanent prompt loss. Exact-once injection would require the managed actor
transport itself to accept and durably deduplicate the delivery ID; until that
contract exists, task prompt delivery is honestly at-least-once across that
single crash window and idempotently suppressed after the receipt.

## Request semantics

A request is an actor-originated item asking the operator or another supported
resolver for input.

Creation is local and offline-capable:

1. the actor must have the required edge and request port;
2. the Remote writes the request in its local database;
3. the request is homed on that actor's authority installation;
4. the raising actor is its claimant from creation;
5. its initial attention state is `input-required` or `auth-required`;
6. a later `report` sends the fact to Command Center.

Command Center resolution is a command to the request's authority home. If the
Remote is offline, the response remains visibly pending. The Remote applies or
causally rejects it under the same command/disposition rules as task changes.

A request sink may therefore be globally visible while its individual
requests remain safely single-home.

## Artifact semantics

An artifact is an actor-published fact:

- creation is local and offline-capable;
- authority home is the publishing actor's installation;
- identity is stable and idempotent;
- optional `task?: TaskRef` linkage does not change task ownership;
- unbound artifacts remain valid;
- a linked reference must name the same canvas as the artifact sink, but may
  name a different node because task and artifact sinks are distinct logical
  surfaces;
- Station admission requires that canvas and task-sink node to exist in the
  installed projection and requires the projected node kind to be `task`;
- the repository then requires the exact
  `(canvasName, taskNodeId, taskId, entityHome)` row to exist, to have a
  non-null claimant, and to share the artifact fact's entity home;
- the publisher is retained independently and need not be the task claimant;
- Command Center integrates the artifact after `report`;
- another installation does not overwrite it by last-write-wins.

The projection check proves intent shape. The repository check proves material
task existence, a completed claim (and first-home transfer when applicable),
and current authority. Neither check substitutes publisher identity for
claimant identity. Invalid incoming facts fail before event insertion, cursor
advancement, materialization, or acknowledgement.

```text
Artifact {
  artifactId: string
  name?: string
  parts: Part[]
  task?: TaskRef
  metadata?: WorkMetadata
}
```

The local control/CLI boundary accepts the ergonomic
`task: { target, id }` input and resolves it to a canonical `TaskRef` in the
caller's canvas. The retired artifact `taskId` input fails strict decode.

Artifact payloads remain bounded by the protocol and storage contract. A future
large-object transport must use an explicit content contract; it cannot smuggle
arbitrary filesystem paths into the Station API.

## Message semantics

Every message append carries an explicit destination:

```text
MessageAppendDestination =
  | { kind: "mailbox" }
  | { kind: "task", itemId: string }
  | { kind: "request", itemId: string }
```

The destination is event semantics, not transport context. A receiver never
infers mailbox versus thread residency from the optional A2A
`Message.taskId`, from the enclosing report, or from a repository-private
column.

Actor mailboxes are the first residency:

- messages are Command Center-homed;
- `destination: { kind: "mailbox" }` must address a projected actor node;
- they are not used to represent task assignment;
- every append command and resulting fact carries the exact projected
  `ActorRef` of its sender; the material mailbox row retains that immutable
  `ActorSeatId`;
- a Remote actor sends a mailbox command to Command Center and cannot
  materialize that mailbox while Command Center is unavailable;
- Command Center materializes the mailbox row and returns the correlated
  fact/disposition; the Remote stores that response as event/resolution state
  only and never creates a duplicate local mailbox row;
- persistent Station sessions improve delivery latency but do not change
  mailbox authority.

Task and request threads are the second residency:

- `destination.kind` must match the projected sink kind (`task` or
  `requests`);
- `destination.itemId` selects one exact material parent row;
- for a task/request append, `Message.taskId` must be present and equal the
  explicit destination item ID, but remains an A2A cross-reference rather than
  a storage-lane discriminator;
- the parent must exist at the same `entity_home` as the thread message;
- the authority installation materializes the thread, and Command Center may
  integrate a Remote-home thread fact into its replica;
- a non-authority Remote receiving the correlated result for a
  Command Center-home thread keeps the event/disposition only.

This split is one protocol with two explicit residencies, not parallel mailbox
and thread transports. `work_messages` holds Command Center mailbox rows;
`work_task_messages` holds exact task/request thread rows.

If offline Remote-to-Remote messaging becomes a requirement, it needs a new
single-home routing design. It must not be improvised as peer connectivity.

## Authorial projection

### Compilation

Command Center compiles one deterministic portfolio envelope from its current
authorial generation. Compilation:

- includes complete stable document structure;
- strips runtime work lane contents and derived live state;
- includes placement and capability intent needed by every Remote;
- excludes host endpoints, transport credentials, browser credentials,
  process IDs, and peer-Remote reachability;
- fails if a document is malformed, noncanonical, or already contains runtime
  work projection data.

Canvas generation and projection generation are deliberately different
sequences. The compiled candidate records its `sourceCanvasGeneration` and
`sourceIntentSha256` for audit, then Command Center archives it in
`station_projection_versions` before attempting transport. If the current
archived head has the same source identity and exact compiled body, that
version is reused. Otherwise one transaction allocates the next monotonic
projection generation, inserts the immutable version, and advances
`station_projection_head`.

This ordering makes a lost `ProjectResponse` reconcilable. The next session
can compare Remote status with the exact version Command Center durably
archived before send; it never recompiles a canvas generation into a newly
invented identity merely because an outer response was lost.

### Installation

`project` carries:

- target Remote `InstallationId`;
- canonical projection-specific logical generation;
- source canvas generation and source authorial intent SHA-256 as audit facts;
- complete encoded portfolio;
- semantic SHA-256;
- display timestamp.

The Remote decision is:

| Current vs incoming | Decision |
|---|---|
| no current projection | `install` |
| higher generation | `install` |
| same generation, same hash | `idempotent` |
| lower generation | `stale` |
| same generation, different hash | `conflict` |

An install inserts the immutable version and advances the active projection
head in one transaction. Prior versions remain retained for audit, replay
reconciliation, and exact work-fact basis validation. They are not alternate
active documents and cannot be selected by a stale `project` request.

### Projection replacement boundary

Projection replacement may replace only projected authorial intent. It must
not delete, rewrite, or merge:

- Remote-homed tasks, requests, artifacts, transitions, or receipts;
- pairing or configuration;
- logical event/cursor state;
- browser profiles, pages, cookies, or sessions;
- owned processes or runtime recovery records.

After replacement, the runtime reevaluates local eligibility against the new
projection. If a local resource is no longer authorized, Vellum performs the
strongest honest revocation available on that reachable Remote.

## Work events

### Canonical event

The shared contract first names a complete route and identity:

```text
WorkRoute {
  eventHome: InstallationId
  entityHome: InstallationId
}

WorkRecordId {
  route: WorkRoute
  seq: LogicalSequence
}

RouteCursor {
  eventHome: InstallationId
  entityHome: InstallationId
  through: LogicalSequence
}

WorkNodeRef {
  canvasName: string
  nodeId: string
}

WorkItemRef {
  kind: "task" | "request" | "message" | "artifact" | "delivery"
  itemId: string
  sink: WorkNodeRef
}

TaskRef {
  kind: "task"
  itemId: string
  sink: WorkNodeRef
}
```

Every record has the following exact common envelope:

```text
WorkRecordCommon {
  protocol: "vellum/work/v2"
  id: WorkRecordId
  recordType: "command" | "fact" | "disposition"
  item: WorkItemRef
  operation: WorkOperation
  contentSha256: Sha256
  originAt: DisplayTimestamp
}
```

`contentSha256` covers the canonical semantic record excluding
`contentSha256` and `originAt`. Receive time is not a wire field. The local
repository wraps a decoded record after acceptance:

```text
StoredWorkRecord {
  record: WorkRecord
  receivedAt: DisplayTimestamp
}
```

That distinction prevents one installation's local receive timestamp from
becoming another installation's forwarded wire value.

The exact operation vocabulary is:

```text
WorkOperation =
  | "task.create"
  | "task.describe"
  | "task.transition"
  | "task.claim"
  | "request.create"
  | "request.resolve"
  | "message.append"
  | "artifact.publish"
  | "delivery.accepted"
```

The command input is also a closed sum. Create operations carry pre-allocated
canonical objects so retries never mint new IDs:

```text
WorkAction =
  | { operation: "task.create", task: Task }
  | { operation: "task.describe", taskId: string, message: Message }
  | { operation: "task.transition", taskId: string,
      state: TaskState, message?: Message }
  | TaskClaimAction
  | { operation: "request.create", request: Task, raisedBy: ActorRef }
  | { operation: "request.resolve", requestId: string, response: string,
      disposition: "completed" | "rejected", message?: Message }
  | { operation: "message.append", message: Message,
      sentBy: ActorRef, destination: MessageAppendDestination }
  | { operation: "artifact.publish", artifact: Artifact,
      publishedBy: ActorRef }
  | { operation: "delivery.accepted", receipt: DeliveryReceipt }
```

`Task`, `TaskState`, `Message`, and `Artifact` are the strict shared domain
schemas in `src/shared/work-model.ts`; the wire never defines looser copies.
`Artifact.task`, when present, is exactly `TaskRef`; there is no artifact
`taskId` compatibility field. `MessageAppendDestination` is the closed
mailbox/task/request sum above.
`DeliveryReceipt` is:

```text
DeliveryReceipt {
  deliveryId: string
  deliveredItem: WorkItemRef
  actor: ActorRef
  acceptedAt: DisplayTimestamp
}
```

Facts carry the exact resulting domain snapshot, not a patch:

```text
WorkResult =
  | { operation: "task.create" | "task.describe" | "task.transition",
      task: Task }
  | { operation: "task.claim", task: Task, claimedBy: ActorRef,
      previousHome: InstallationId }
  | { operation: "request.create" | "request.resolve", request: Task }
  | { operation: "message.append", message: Message,
      sentBy: ActorRef, destination: MessageAppendDestination }
  | { operation: "artifact.publish", artifact: Artifact,
      publishedBy: ActorRef }
  | { operation: "delivery.accepted", receipt: DeliveryReceipt }
```

The versioned wire record is:

```text
WorkCommand = WorkRecordCommon & {
  recordType: "command"
  predecessor: WorkRecordId | null
  body: WorkAction
}

WorkFact = WorkRecordCommon & {
  recordType: "fact"
  predecessor: WorkRecordId | null
  body: WorkResult
}

WorkDisposition = WorkRecordCommon & {
  recordType: "disposition"
  body:
    | {
        status: "applied"
        command: WorkRecordId
        commandSha256: Sha256
        fact: WorkRecordId
        factSha256: Sha256
      }
    | {
        status: "rejected"
        command: WorkRecordId
        commandSha256: Sha256
        reason: WorkRejectionReason
        message: BoundedDiagnostic
      }
}

WorkRecord = WorkCommand | WorkFact | WorkDisposition
```

`WorkRejectionReason` is closed:

```text
authority-mismatch
| capability-denied
| causal-conflict
| claim-contention
| identity-conflict
| invalid-transition
| locality-mismatch
| missing-entity
| projection-conflict
| target-mismatch
```

The outer `operation` must equal the inner action/result operation or the
referenced command's operation. The item identity must equal the typed body
identity. Event payloads are strict-decoded. Unknown operations, unknown
rejection reasons, excess fields, invalid state transitions, and
identity/content reuse fail closed.

`kind: string` plus repository-private JSON is not the canonical boundary.
Transport adapters and Station API clients must not need repository internals
to understand a record.

### Predecessor law

`WorkCommand.predecessor` and `WorkFact.predecessor` name the prior material
fact for that item on the record's `entityHome` authority lane. A normal
command is applied only when that predecessor matches the target's local row.
A disposition needs no second predecessor because it already references the
exact command identity and hash.

First adoption is the deliberate exception with two different lineages:

- the `task.claim` command's outer `predecessor` is `null`, because the
  prospective Remote authority lane has no material task row;
- `TaskClaimAction.sourcePredecessor` names the last Command Center-authority
  fact frozen by Command Center during arbitration;
- the Remote validates the embedded source snapshot and command coherence but
  does not match `sourcePredecessor` against a nonexistent local source row;
- the resulting first Remote `task.claim` fact also has `predecessor: null`;
- later Remote facts name the preceding fact in the Remote authority lane.

### Logical ordering

Sequences are canonical decimal strings and compare as integers. Each route
allocates monotonically:

```text
(event_home, entity_home) → 1, 2, 3, ...
```

No global sequence is required. Two Remotes may each emit sequence `1` without
conflict because their event homes differ.

Origin and receive time are retained for operator history. They never:

- order events;
- select a winner;
- prove freshness;
- expire authority;
- coordinate ticks.

### Commands, facts, and dispositions

The same event substrate carries three semantic classes:

**Fact**

A mutation already committed at the event's entity home. A Remote reports
local task progress, requests, artifacts, and receipts as facts.

**Command**

A requested mutation whose entity home is another installation. The sender
persists it as pending and does not materialize its requested state.

**Disposition**

The authority home's durable result for one command:

```text
applied | rejected
```

An applied disposition references the exact command identity and content hash.
A rejection includes a stable reason class and bounded diagnostic message.

Transport delivery alone never converts a command into a fact.

### Causal application

For each incoming event, the receiver verifies:

1. the active transport session is admitted for the expected paired route;
2. event direction is legal for that peer;
3. entity home matches the local authority required by the operation;
4. sequence is contiguous or an idempotent replay;
5. identity/content hash has not been reused;
6. an ordinary command/fact predecessor matches the target authority lane, or
   the exact first-adoption rule above applies;
7. explicit message destination matches projected sink kind and exact parent
   residency;
8. a linked artifact's `TaskRef` resolves to a projected task sink, then to an
   exact claimed same-home task row;
9. domain transition and actor/sink rules hold.

The receiver then transactionally:

- remembers or verifies the event;
- materializes the fact or command;
- writes any disposition;
- advances its durable received cursor.

Any failure leaves the previous material state and cursor intact.

## Acknowledgements and reconnect

An acknowledgement means:

> Every event on this exact `(eventHome, entityHome)` route through this
> logical sequence has been durably handled contiguously.

It does not mean:

- a task was assigned;
- an actor saw a prompt;
- an operator approved work;
- a projection is current;
- a Remote remains reachable.

Each side stores:

- received-through `RouteCursor` values containing both homes;
- peer-acknowledged `RouteCursor` values containing both homes;
- pending commands and their dispositions;
- content hashes for idempotence/conflict detection.

On reconnect:

1. transport authenticates the Remote;
2. Command Center verifies its enrolled `InstallationId`;
3. each side reads durable cursors;
4. each side sends events strictly after the peer's ACK;
5. duplicate events verify identity and content then no-op;
6. gaps stop that route without advancing its cursor;
7. independent Remotes continue without head-of-line blocking.

Delivery is at least once. Semantic materialization is exactly once per event
identity and content.

### Report batch contract

Reports are symmetric: the initiator and responder each send one bounded
batch. No half of event identity is inferred from the SSH route, session, or
array that contained it.

```text
ReportBatch {
  records: readonly WorkRecord[]       // at most 256
  acknowledge: readonly RouteCursor[]  // at most 256
  hasMore: boolean
}

ReportRequest {
  protocol: "vellum/station-api/v2"
  op: "report"
  senderInstallationId: InstallationId
  targetInstallationId: InstallationId
  batch: ReportBatch
}

ReportResponse {
  protocol: "vellum/station-api/v2"
  op: "report"
  senderInstallationId: InstallationId
  targetInstallationId: InstallationId
  batch: ReportBatch
}
```

The response swaps sender and target. `hasMore` means the batch sender has
additional records after the final included route position; it is not an ACK
and carries no authority. A peer with more than one active route pages fairly
instead of draining one route without bound. A batch is additionally bounded
by encoded byte size. Empty records with non-empty ACKs are valid.

The decoded batch must also satisfy:

- every `record.id.route.eventHome` equals `senderInstallationId`;
- every `acknowledge.eventHome` equals `targetInstallationId`;
- sender and target equal the paired installations for this session;
- each record direction and `entityHome` is legal for its operation;
- the response swaps the request's sender and target exactly.

Every ACK is a `RouteCursor`. ACK lookup, status, replay, paging, and gap
detection all key on the complete `(eventHome, entityHome)` route. A cursor
that stores only peer or event home is invalid.

A report request may contain at most 64 unresolved first-delivery
`task.claim` commands. The responder reserves response capacity before adding
ordinary backlog records. For every such claim, the correlated response must
contain exactly one durable disposition; an applied disposition's referenced
`task.claim` fact must be present in that same response. A claim command cannot
be cumulatively acknowledged past its sequence until those required records
are durable and included. If the mandatory response cannot fit the record or
byte bound, the request fails without advancing its ACK. On replay, the same
fact/disposition identities are returned.

## Station API operations

### `pair`

Purpose: bind one currently unenrolled Remote installation to one Command
Center declaration after the adapter's actual transport-authentication
boundary has succeeded.

Laws:

- Command Center initiates it.
- It cannot create a Command Center role.
- Exact replay is idempotent.
- A different Command Center conflicts.
- Pairing identity is not a bearer credential.
- Pairing alone grants no work or authoring capability.

### `configure`

Purpose: install the exact Remote topology and enrolled host registration.

Laws:

- Command Center initiates it after pairing.
- The wire can represent only `role: "remote"`.
- Host ID and Command Center installation must match enrollment.
- The transaction removes any dormant local authorial canvas head.
- It does not install SSH keys, browser trust, reverse routes, or peer routes.
- Exact replay is idempotent; identity/role change conflicts.

### `project`

Purpose: install one complete replace-only authorial projection.

Laws:

- Command Center initiates it.
- It is generation/hash monotonic.
- It does not carry runtime work.
- It does not erase local work or resources.
- It never merges.

### `report`

Purpose: exchange ordered work events, dispositions, delivery receipts, and
cumulative acknowledgements.

Laws:

- either side may initiate `report` **on an authenticated session that Command
  Center opened**;
- a Remote cannot open a separate connection back to Command Center;
- each report is bounded and pageable;
- events retain their own logical identities independent of session ordering;
- ACKs are cumulative and contiguous;
- Remote commands receive a disposition before acknowledgement;
- report replay is idempotent.

`report` is the only Station API operation a configured Remote may initiate on
the established session.

### `status`

Purpose: expose bounded current facts needed for fleet supervision.

Status includes:

- installation identity;
- application release and local SQLite schema version for diagnosis;
- local `StationProtocolSupport`, selected Station protocol, and any
  deprecated/update-required state observed for the live route;
- role and host configuration;
- paired Command Center identity;
- active projection generation/hash;
- received and peer-acknowledged cursors;
- database, work-control, simulation, and session readiness;
- current observation timestamp.

Cached status must be labelled last-observed. An unreachable Remote is
`unknown/unreachable`, never optimistically healthy.

These compatibility facts belong to the session supervisor and operator
status surfaces. They do not widen the frozen Station protocol 2
`StatusResponse`; a legacy v2 peer proves its version through the narrowly
bounded compatibility path below.

## Closed protocol surface

The Station API must never gain a generic:

- shell command;
- arbitrary RPC name;
- filesystem path operation;
- database query;
- HTTP proxy;
- browser verb;
- tunnel or port-forward request;
- peer-Remote forward;
- plugin-defined untyped payload.

If a new product operation is genuinely required, it needs an explicit
contract review. It cannot hide inside `report.kind`, an excess JSON field, or
an adapter-specific escape hatch.

## Session contract

### Direction

Command Center always initiates the network/process connection:

```text
Command Center ── authenticated connect ──► Remote
Command Center ◄════ bounded duplex frames ════► Remote
```

The established stream is duplex. Remote facts travel back immediately on
that stream. This provides real-time behavior without:

- an inbound listener on the operator's Mac;
- a public Command Center address;
- a Remote-held Command Center route;
- Tailscale as an authority dependency;
- polling every few seconds.

### Framing

The transport carries strict bounded frames with:

- the discriminator required by the selected Station protocol codec;
- request ID;
- frame kind (`request` or `response`);
- one Station API request or control envelope;
- correlation to exactly one response.

Framing may use bounded newline-delimited JSON or another explicit
length-delimited encoding. Encoding is an adapter concern; it cannot alter
domain semantics.

Transport heartbeat and close frames are session mechanics, not extra Station
API verbs. They carry no domain payload or authority.

### Concurrency

The session may have multiple in-flight requests when request IDs make
correlation unambiguous. Domain ordering still comes exclusively from
projection generation and event sequence.

Backpressure rules:

- bound total frame size;
- bound report event count;
- bound queued outbound bytes per Remote;
- pause reading or producing rather than buffering without limit;
- keep each Remote's queue independent;
- close malformed or over-limit sessions;
- reconnect with exponential backoff and jitter.

### Session loss

Session identity is ephemeral and never authority state. On loss:

- no SQLite transaction is rolled back after commit;
- unsent events remain after the peer ACK cursor;
- unacknowledged events replay;
- an unresolved claim command may replay only if its durable attempt was
  created while the prior session was live; reconnect never creates or
  retargets a claim attempt;
- Remote simulation continues locally;
- Command Center marks the Remote unreachable;
- reconnect creates a new session and resumes from durable cursors.

No polling protocol survives as a permanent parallel fallback after the
persistent session cutover. Reconnection is the one recovery path.

### Version skew and compatibility

Command Center and Remotes are installed applications and cannot be updated
atomically. That is a proven runtime-skew constraint, not speculative backward
compatibility.

The exact Station protocol 2 bundle is the first installed compatibility
floor. Its session, Station API, control, Work, and projection codecs are
immutable and are never widened in place.

The committed protocol-2 golden corpus freezes accepted and rejected preface,
session, five-verb, projection, Work, disposition, ACK, and status shapes.
Changing a v2 decoder so that this corpus changes is a protocol change, not an
internal refactor.

Every negotiation-aware connection begins with one frozen compatibility
preface before domain traffic:

```text
CompatibilityOffer {
  protocol: "vellum/station-protocol-preface/v1"
  frame: "offer"
  appVersion                 // display/diagnostic only
  stateSchemaVersion         // display/diagnostic only
  support: StationProtocolSupport
}

CompatibilityAccept {
  protocol: "vellum/station-protocol-preface/v1"
  frame: "accept"
  appVersion
  stateSchemaVersion
  support: StationProtocolSupport
  selected: integer
}

CompatibilityReject {
  protocol: "vellum/station-protocol-preface/v1"
  frame: "reject"
  appVersion
  stateSchemaVersion
  support: StationProtocolSupport
  reason: "no-common-version"
  retryable: false
}
```

For local support `L` and peer support `P`:

```text
lower = max(L.compatibleFrom, P.compatibleFrom)
upper = min(L.preferred, P.preferred)
```

If `lower <= upper`, the selected Station protocol is `upper`: the highest
common exact codec. Each peer recomputes and verifies that selection before
binding it to the live session. If the selected number is below either
`warnBelow`, the session works and the operator sees a deprecation warning.

If there is no overlap, the result is a typed, non-retryable
`update-required` software state. The Remote keeps its local factory running
under its last valid projection. Command Center sends no domain mutation,
does not reserve a task or actor, does not create a claim command, and does
not acknowledge past an unsupported route head.

The bound Station protocol integer is the only evidence used to select a wire
codec. App release, SQLite schema version, cached host metadata, and mere
socket liveness are not compatibility authority.

Rules:

1. Use the highest mutually supported exact Station protocol.
2. Keep closed version-specific decoders; never ignore excess fields.
3. One selected protocol activates one complete codec bundle. Unsupported
   behavior means the peers do not share that protocol; it is never repaired
   with a capability array or partial down-conversion.
4. New Remote accepts a currently supported older Command Center protocol.
5. Gate durable mutation before reservation. An unsupported remote claim
   leaves task submitted, actor free, and creates no command row.
6. Never down-convert or partially install a projection. Retain the last valid
   projection and report update-required.
7. Never skip an unsupported record in a contiguous route. Retain it at the
   durable head and leave the acknowledgement unchanged.
8. One incompatible Remote does not block synchronization with another.
9. No-common-protocol is a typed, non-retryable software state, not network
   unavailability.

#### Narrow pre-negotiation v2 boundary

Protocol 2 shipped before the compatibility preface. Independently updated
installed Stations make one temporary boundary unavoidable:

- A negotiation-aware Remote that receives a strict protocol 2 domain frame
  as the first frame may bind protocol 2 and process that same frame, but only
  when its support interval includes 2.
- A negotiation-aware Command Center uses one sealed compatibility-mode
  invocation of the packaged SSH helper and sends the compatibility offer
  first. It may open exactly one fresh authenticated protocol 2 connection
  only when that fixed invocation observes zero peer stdout bytes and exits
  with reserved code `64`. The offer may race with this immediate rejection
  and is not part of the proof. The old helper uses that code when it rejects
  the unknown fixed argument before reaching the owner-local relay; this
  complete witness is the only evidence of a pre-negotiation-v2 peer.
- Any peer byte, explicit rejection, malformed frame, timeout, authentication,
  setup, write, identity, authorization, integrity, relay, or domain failure,
  or any exit code other than `64`, forbids fallback.
- Successful exact protocol 2 identity/status exchange binds the expected
  enrolled installation before any mutation.

This is a bounded runtime-skew exception, not a second permanent session
design. Its canonical end state is that every connection uses the
compatibility preface. The **fleet protocol owner** owns deletion. The
objective retirement trigger is: every enrolled Station has successfully used
the compatibility preface at least once or has been explicitly retired, and
no enrolled route remains recorded as legacy-v2. Elapsed time or a new app
release is not evidence.

The exact protocol 2 codec has its own later retirement trigger. It may be
removed only after every enrolled Station selecting 2 has upgraded or been
explicitly retired and every durable protocol-2 record has been reconciled.
The fleet protocol owner owns that retirement too.

Before Vellum ships its second installed release, release qualification must
exercise real packaged skew in both directions:

1. candidate Command Center against the previous installed Remote;
2. previous installed Command Center against the candidate Remote.

Both runs must select their highest common exact Station protocol and preserve
offline Remote work plus ordered reconciliation. Local SQLite schema versions
may differ and remain diagnostic only. This gate does not justify a new
Station protocol number: that number changes only when the closed wire bundle
changes.

## OpenSSH adapter

OpenSSH is the first production transport because it already supplies:

- authenticated operator-machine access;
- encryption and integrity;
- host-key policy;
- route configuration;
- support across ordinary VPS and private networks;
- no inbound Command Center listener.

The canonical SSH shape is:

```text
Command Center
  └── opens one persistent SSH command session
        └── fixed packaged vellum-station helper on Remote
              └── owner-local Remote control socket
                    └── Remote main Station dispatcher
```

### Fresh enrollment identity discovery

An enrolled SSH route can be authenticated before Command Center knows the
fresh Remote database's `InstallationId`. That first identity lookup is an
explicit bootstrap phase, not a reason to retain the retired one-request
Station client.

The OpenSSH adapter performs bootstrap as follows:

1. the operator has already registered the exact Remote host and SSH route;
2. Command Center resolves the packaged Remote platform and opens the same
   fixed `vellum-station` framed SSH command used by ordinary sessions;
3. the bootstrap session admits exactly one correlated `status` request;
4. Remote main returns its strict `StatusResponse`;
5. Command Center records the returned `InstallationId` only as the identity
   observed on that authenticated operator-controlled route;
6. the bootstrap session closes;
7. Command Center mints the enrolled known-peer route and opens a normal
   persistent session for `pair`, `configure`, projection, and work traffic.

The bootstrap session does not accept `pair`, `configure`, `project`, or
`report`; it does not create fleet authority; and it does not leave a generic
one-shot request path behind. A malformed response, a second frame, a timeout,
or an identity/configuration conflict closes it without binding a fleet
target. Once a host is bound, later sessions require that exact
`InstallationId`; bootstrap discovery is not rerun as identity repair.

This ceremony deliberately does not claim that `InstallationId` authenticates
the Remote. OpenSSH authenticates the route at the boundary it owns. Pairing
then records which logical installation the operator accepted over that
route.

The helper:

- accepts no arbitrary command, path, database location, or shell payload;
- does not open `vellum.db`;
- does not read or write settings/projection/status files;
- carries bounded Station frames between stdio and the owner-local socket;
- exits when the SSH session or Remote app disappears.

OpenSSH owns SSH private keys, host-key verification, known hosts, and account
authentication. Vellum does not copy or reissue those credentials.

The security boundary is stated narrowly:

- Command Center's SSH client authenticates the Remote host under configured
  host-key policy;
- the Remote SSH daemon authenticates the operator account and starts the
  fixed helper;
- the helper-to-app owner-local socket handoff is trusted same-user
  containment;
- Remote main does **not** receive cryptographic proof of the original SSH peer
  through process ancestry or the local socket.

The fixed command removes arbitrary shell arguments and narrows the reachable
surface. It is not a second credential or channel binding. Under Vellum's
single-operator threat model, an arbitrary malicious process already running
as that same Remote account is outside the promised isolation boundary.
Remote main still strict-decodes every frame and validates pairing, target,
verb, state transition, and work authority. Future HTTPS may terminate mTLS in
an adapter capable of supplying real authenticated peer evidence, but it may
not retroactively overstate what the SSH helper proves.

Tailscale, a VPN, a public IP, a provider private network, or a bastion may
provide reachability to the SSH endpoint. None of them changes Station API
authority.

## Future HTTPS adapter

Vellum must not be architected so SSH endpoints are embedded in domain
identity or work contracts.

A future public-network adapter must use HTTPS with mutual authentication.
Plain HTTP is not an acceptable fleet transport outside an owner-local
boundary.

The HTTPS adapter must:

1. keep Command Center as connection initiator;
2. authenticate both peers before Station API decode or dispatch;
3. bind the authenticated Remote credential to its enrolled
   `InstallationId`;
4. encrypt and integrity-protect the complete session;
5. use the same five verbs, event identities, dispositions, and cursors;
6. support certificate replacement and revocation without changing factory
   identity;
7. keep private key custody explicit and browser-independent;
8. expose no generic web application, admin API, or browser relay.

Mutual TLS is the expected mechanism. The exact bootstrap ceremony, certificate
authority model, OS-keychain/private-key custody, rotation, and permanent-loss
recovery require a separate security decision before implementation.

Those credentials authenticate transport. They do not turn
`InstallationId`, `HostId`, route URL, certificate fingerprint, pairing row, or
canvas ID into a secret.

The retired browser signing system is not a template for HTTPS. Any future
transport credential belongs to the Station transport adapter and protects all
five verbs uniformly.

A future mobile app acting as a standalone Command Center uses this same
Station protocol over the HTTPS adapter to control its enrolled Remotes. A
mobile app acting as a mirror of a sovereign desktop Command Center is a
different product relationship: its future control/synchronization API is not
the Station protocol, does not add a Station verb, and does not make two
Command Centers sovereign over the same factory. That mirror API requires its
own contract and security decision before implementation.

## Authorization

Transport authentication is necessary but insufficient.

Before dispatch, Remote main verifies:

- the request arrived through the configured adapter's admitted local handoff;
- request target matches this installation;
- paired Command Center identity matches;
- operation is legal for current enrollment/configuration state;
- role transition is representable;
- strict schema decode succeeds;
- payload bounds and content hashes hold.

Before work materialization, `WorkService`/`WorkRepository` verifies:

- entity home and event direction;
- local installation authority;
- current projected node identities;
- actor placement;
- edge and port;
- process-bind for actor-originated local tools;
- predecessor and state transition;
- one-task-per-actor invariant.

For OpenSSH, the first bullet is owner-local helper containment, not
cryptographic continuation of SSH identity into Electron main. For future
mTLS, it may include a real authenticated peer binding. No adapter bypasses
the dispatcher. No dispatcher bypasses domain services to write SQLite.

## Scheduler and clock semantics

Actors, watchers, and timers execute only on their placement home. Command
Center and Remote ticks do not coordinate phases or share a clock.

`everyMinutes` uses coalesced catch-up:

- sleeping through multiple intervals yields at most one firing;
- restart establishes a new next interval;
- no latent backlog replays.

Any future absolute/calendar timer must declare:

- due-time interpretation;
- stale threshold;
- catch-up or skip behavior;
- time-zone behavior;
- restart behavior.

Wall-clock timestamps remain display/due metadata. They never order work or
choose an authority.

## Offline behavior matrix

| Situation | Required behavior |
|---|---|
| Command Center closed after Remote task claim | Remote continues transitions and execution locally |
| Command Center closed before CC-home task claim | Remote cannot claim that shared submitted task |
| Target Remote unreachable before CC-home claim | Do not queue a future claim; leave the task submitted |
| Remote creates request/artifact while CC closed | Persist locally; report later |
| Remote runs Station-home queue while CC closed | Local eligible actor may claim and execute |
| Remote tries to claim another Remote's queue | Deny; no peer route |
| Command Center edits intent while Remote unreachable | Record new intent locally; show Remote stale until projection reaches it |
| Edge revoked while Remote unreachable | Remote continues last projection; CC must not claim revocation arrived |
| Session drops after event commit before ACK | Replay event; receiver verifies identity/hash and no-ops |
| Two ticks drift in phase | Latency may differ; ownership and ordering do not |
| Actor process restarts during working task | Recover task and delivery receipt locally; do not create another claim |

## Effect architecture

The implementation follows a policy/mechanism/orchestration split.

### Pure policy

Pure shared modules own:

- Effect Schemas for every Station frame and work payload;
- projection install decisions;
- sequence/ACK decisions;
- task transition and claim eligibility;
- placement/locality rules;
- content hashing inputs;
- retry classification.

Pure policy has no SQLite, SSH, socket, Electron, or clock I/O.

### Repositories

Effect repository services own transactional SQLite mechanisms:

- `StateEngine`;
- canvas authority;
- Station enrollment/configuration/projection/cursors;
- work rows/events/pending commands/rejections;
- durable actor-delivery receipts.

Repositories accept domain values, not raw network JSON.

### Dispatcher

One `StationApiDispatcher` owns the five verb handlers. Every transport adapter
delivers its admitted transport context plus a decoded request to this
dispatcher. The context may contain cryptographic peer evidence only when the
adapter can actually provide it.

The dispatcher does not know SSH command strings, HTTPS URLs, socket paths, or
certificate storage formats.

### Peer exchange

One transport-neutral `StationPeerExchange` Effect service exposes the
Command Center side of an authenticated session:

- connect/disconnect lifecycle;
- correlated request/response;
- Remote-initiated report delivery on an existing session;
- typed transport failures;
- cancellation and backpressure.

Callers pass an enrolled peer/route capability, not raw arbitrary shell
arguments.

### Adapters

OpenSSH and future HTTPS implement the same peer-exchange port. They own:

- dialing;
- authentication evidence;
- framing;
- timeouts;
- connection lifecycle;
- adapter-specific route validation.

They do not own Station domain decisions or work materialization.

### Orchestration

Fleet propagation supervises one independent scoped session per enrolled
Remote. It:

- projects new intent immediately;
- drains durable outbound events;
- accepts inbound reports;
- reconciles status;
- reconnects with bounded backoff;
- prevents one failing Remote from blocking another.

## SQLite residency

The composed exact-current schema contains the canonical categories:

### Canvas authority

- `canvas_generations`
- `canvas_generation_documents`
- `canvas_head`

Authorial rows exist only on Command Center.

### Station state

- `station_installation`
- `station_pairing`
- `station_configuration`
- `station_projection_versions`
- `station_projection_head`
- `station_received_cursors`
- `station_peer_ack_cursors`
- `station_fleet_targets`

### Work state

- `work_event_sequences`
- `work_events`
- `work_pending_commands`
- `work_tasks`
- `work_requests`
- `work_task_messages`
- `work_messages`
- `work_artifacts`
- `work_task_transitions`
- `work_rejections`
- target durable actor-delivery receipts

The exact schema must enforce:

- one monotonic projection generation independent of canvas generation;
- immutable retained projection versions, with a unique
  `(generation, content_sha256)` identity and one composite-FK active head;
- projection source canvas generation and source intent hash as audit fields;
- one canonical event identity;
- legal row state;
- content hash presence;
- immutable item home except the first submitted-to-working task claim;
- immutable request/artifact home;
- entity and event homes reference installation identities, never HostId or a
  Command Center sentinel;
- at most one unresolved claim command per task identity;
- at most one unresolved claim command per `ActorSeatId`;
- database-enforced uniqueness preventing one `ActorSeatId` from owning two
  active tasks;
- valid pending-command lifecycle;
- exact message destination residency: Command Center-only mailbox rows and
  same-home task/request thread parents;
- immutable actor-seat provenance for every material mailbox message;
- nullable-as-a-group artifact task reference columns
  `(task_canvas_name, task_node_id, task_id, task_entity_home)`;
- a composite artifact-to-task foreign key on
  `(canvas_name, node_id, task_id, entity_home)`;
- linked artifact rejection unless the exact task is already claimed and
  same-home, without coupling artifact publisher seat to task claimant seat;
- indexes for route replay and node projection.

No second database or direct helper connection is permitted.

## Failure semantics

### Retryable

- transport unavailable;
- session reset;
- bounded timeout before a response;
- Remote app temporarily down;
- transient SQLite busy within the configured retry contract.

Retry reuses the same semantic request/event identity where applicable.

### Non-retryable until state changes

- strict decode failure;
- unknown verb or excess field;
- target installation mismatch;
- role/topology conflict;
- projection generation/hash conflict;
- event identity/content conflict;
- sequence gap;
- causal predecessor conflict;
- illegal task transition;
- actor claim contention;
- missing edge/port/locality.

The error contract marks retryability explicitly. Callers do not infer it from
message text.

### Partial failure

Every durable operation is transactionally all-or-nothing at one installation.
There is no distributed transaction between Command Center and Remote.

Cross-installation completion is represented explicitly:

```text
pending command
  → Remote applied/rejected disposition
  → Command Center integrated result
```

The UI and Doctor report that lifecycle honestly.

## Forbidden residue

The canonical protocol blocks release while any live path preserves:

- remote browser operations or browser trust on the Station wire;
- browser-specific keypairs, pins, certificates, session handles, or relays;
- Station-to-Station routes or credentials;
- Remote-opened or reverse fleet connections to Command Center;
- file-written settings, projections, status, frames, or ACKs;
- direct SQLite access from a helper, renderer, CLI, fleet caller, concurrent
  second process, or any proof process outside the exact quiesced sealed
  packaged-candidate preflight;
- canvas mutation for tasks, requests, messages, artifacts, claims, or
  transitions;
- shared offline task claiming;
- task assignment distinct from starting work;
- actor backlogs or more than one active task;
- unclaim, steal, lease expiry, or implicit re-home;
- wall-clock ordering;
- polling as a permanent peer-exchange implementation after stream cutover;
- the retired Station v1 protocol;
- permissive or unbounded compatibility decoding;
- an older Station codec retained without an enrolled peer or unreconciled
  record that proves the runtime-skew exception;
- dual reads/writes, legacy imports, or fallback stores;
- artifact `taskId` fields or item-ID-only artifact/task joins;
- inferred message residency without an explicit mailbox/task/request
  destination.

## Implementation status

Station protocol 2 is the sole live Station contract in source. Its
implementation cut is closed:

- the wire has exactly `pair | configure | project | report | status`;
- every request, response, Work record, handshake, frame, cursor, and
  disposition is strictly decoded with bounded Effect schemas;
- negotiation selects the highest common exact Station protocol from declared
  support and fails before mutation when there is no overlap;
- Work uses canonical installation/event/entity identity, logical sequences,
  exact causal predecessors, immutable content identities, and one durable
  home per row;
- a task claim is the start of work, is synchronously authorized by its current
  home, and is limited to one active task per actor seat;
- a Remote can continue an adopted working task from its local SQLite database
  while Command Center is unavailable, including after a full Remote runtime
  restart;
- projection installation is replace-only for authorial intent and cannot
  erase or rewrite Work rows, delivery receipts, or synchronization cursors;
- `StationPeerExchange` is transport-neutral, while the shipped OpenSSH
  adapter keeps one bounded Command Center-opened duplex session with
  reconnect and cursor-based replay;
- Remote-originated traffic is limited to `report`; Remotes receive no peer
  route and never open fleet connections;
- `configure` carries only the Remote installation registration. SSH endpoint,
  identity-file path, host-key policy, and Command Center presentation state
  remain Command Center-local and are rejected as excess Station fields;
- browser control is host-local and no browser operation or browser trust
  system exists on the Station wire;
- there is no Station v1 runtime, permanent one-shot polling path, alternate
  JSON/file store, Work-in-canvas durability path, or compatibility dual write.

This closes the protocol implementation, not all product qualification.
Before declaring a packaged fleet release operationally qualified, run and
retain the signed macOS Command Center ↔ signed Linux Remote matrix, including
candidate/previous-version interoperability and real reconnect interruption.
That matrix validates packaging and deployed OpenSSH behavior; it does not
authorize a second protocol or storage path.

HTTPS remains a future transport adapter over the same five verbs and Station
protocol version. Its design must keep route, authentication, and framing out
of the domain contract; it must not add placeholder credentials, a dormant
listener, or SSH-shaped fields to Station messages.

## Proof matrix

| Claim | Required proof |
|---|---|
| Remote works with CC closed | claimed task progresses through terminal state from local SQLite after CC shutdown |
| CC queue is not double-claimed | two Remotes cannot both start one submitted CC-home task |
| One actor means one task | active and pending second claims fail across canvases |
| Projection is non-authorial | Remote cannot call canvas mutate; replacement never changes local work rows |
| Reconnect is idempotent | repeated report yields one semantic materialization |
| Gaps fail closed | cursor and material state remain unchanged |
| Artifact provenance is exact | linked artifacts require a projected task sink and an exact claimed same-home SQLite task row; publisher may differ from claimant |
| Message residency is explicit | mailbox and task/request destinations materialize only in their declared authority lane |
| Clocks do not order | out-of-order timestamps retain logical event order |
| Browser is local | no Station schema/dispatcher/runtime path represents page control |
| No lateral fleet reach | Remote receives no peer endpoint/credential and opens no fleet connection |
| Transport can evolve | dispatcher/work tests run without an SSH process |
| Persistent SSH is bounded | malformed/oversize frames close only that Remote session |
| Failure is isolated | one unreachable Remote does not block another |
| Version skew is bounded | peers select the highest common exact Station protocol; no overlap mutates nothing |
| Installed releases interoperate | candidate CC→previous Remote and previous CC→candidate Remote both converge over their highest common exact protocol |
| Incompatible Remote keeps working | local simulation continues under the last valid projection while CC reports update-required |
| Ordered data survives skew | unsupported route-head record remains durable and unacknowledged until upgrade |
| Installed state survives updates | frozen versioned fixtures migrate through the contiguous chain with original rows and columns preserved |
| Failed candidate is reversible | clone preflight failure occurs before package activation and resumes the unchanged incumbent |
| Advanced state never downgrades | after live schema advance or candidate-authored durable work, no older binary is launched |

## Validation discipline

During protocol development:

- run TypeScript typecheck;
- run focused unit and integration tests for changed contracts/services;
- keep every completed cut committed;
- do not run the Electron app, dev server, package build, or E2E while the
  operator's beta build is active.

The strict source-level v2 corpus and local state fixtures are committed
evidence. They do not prove a packaged two-installation deployment. Packaged
and real multi-machine qualification remain required before a production
release claim and are not claimed complete by this document.

Before the second installed release, qualification additionally requires the
candidate/previous package matrix in both directions. Passing same-build
source tests is not evidence for installed version skew.

## Contract change process

This document names one canonical end state. A protocol change must:

1. state the invariant or product need being changed;
2. update schemas, producers, consumers, tests, and this document in one cut;
3. delete the superseded internal contract;
4. avoid parallel version support unless an external runtime-skew constraint
   is proven;
5. treat installed enrolled Stations as that proven constraint and keep the
   exception inside strict wire codecs;
6. name every supported version, owner, and objective fleet-evidence
   retirement trigger.

“Keep the old path just in case” is not an accepted protocol design.
