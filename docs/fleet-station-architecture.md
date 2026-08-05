# Fleet and Station architecture

**Status:** normative

**Governs:** Command Center-to-Station intent delivery, single-home execution,
logical propagation, and revocation

**Doctrine:** [security-doctrine.md](security-doctrine.md),
[state-architecture.md](state-architecture.md), and
[architecture-factory-physics.md](architecture-factory-physics.md)

**Canonical protocol:** [vellum-protocol.md](vellum-protocol.md)

## Product sentence

One sovereign operator; one Command Center per factory; every installation
runs the same SQLite-backed app; each Station independently executes the rows
homed there under the latest complete Command Center projection. Executable
actors and physical runtimes are always host-local; projected sink identity
does not make mutable work multi-writer.

## Fleet invariants

1. Every installation has a durable installation identity and belongs to at
   most one factory and one role.
2. Role is chosen by the operator and stored in `vellum.db`; hardware and
   network discovery never infer it.
3. A machine is not both Command Center and Remote.
4. No Command Center is created through SSH, a canvas edit, or a Station API
   request.
5. No Station-to-Station control plane exists.
6. A work entity and every event about it have one authoritative
   `InstallationId` home at a time.
7. An executable actor, browser page, terminal process, watcher, or timer runs
   only on its host installation.
8. A local tick operates only on locally homed state.
9. Timestamps are metadata. Route-local `(event_home, entity_home, seq)`
   identities order propagation.
10. Role, configured host identity, and fleet host-to-installation binding are
   immutable until an explicit transfer ceremony exists.

## Intent and work flow

```text
Command Center authors one full canvas generation
  → compiles one complete Station projection
  → invokes vellum station-stdio over the enrolled SSH route
  → Remote main validates, inserts station_projection_versions, and
    transactionally advances station_projection_head
  → Remote simulation reads that projection and its locally homed work

Command Center persists a Remote-homed mutation as pending
  → report sends it on that host's canonical Work stream
  → Remote atomically applies or causally rejects it
  → Remote durably emits a disposition before acknowledging the command
  → Command Center materializes only an applied disposition
  → retries converge idempotently by route cursor

Command Center selects an idle Remote actor for a CC-home submitted task
  → requires a live authenticated session to that Remote
  → while live, durably begins one exact task-and-actor claim attempt
  → sends that exact command identity
  → Remote atomically adopts the task as working and starts that actor
  → Remote returns the applied disposition in that live exchange
  → Remote continues the one claimed task locally while CC is closed
```

The pending command above is part of one synchronous claim transaction. It is
not an assignment state, a queued reservation, or an actor backlog. Claim means
`submitted → working`: one actor starts one task. If the connection becomes
uncertain, reconnect resolves that same command identity; Command Center does
not select another task or reserve future work for that actor.

The projection is a replaceable cache of intent, not an independently
authoritative canvas. A Remote never merges or edits it. Projection bodies are
strict canonical portfolio envelopes: malformed, noncanonical, or
runtime-work-bearing canvases fail before persistence.

When Command Center is unavailable, a Remote continues under its installed
projection and local database. When a Remote is unavailable, Command Center
retains the last acknowledged generation and cursors and reports the route as
unreachable. Neither side invents synchronization.

## Sink reach and row authority

Logical sinks are stable nodes in every admitted complete projection. An edged
actor may therefore address a permitted sink without requiring the sink's
physical runtime to share its host. The operation still follows the row's one
authority home:

| Operation | Required authority path |
|---|---|
| Claim a Command Center-home task from a Remote actor | Live synchronous Command Center-opened session; the accepted claim starts exactly one task and re-homes it to that Remote |
| Advance an already claimed task | The task's current authority installation; a Remote continues this offline |
| Claim a Remote-home task | Eligible process-bound actor on that same Remote; no Command Center round trip |
| Create a request or artifact | The creating actor's installation, when current edges and ports permit it |
| Append task/request thread history | The exact parent row's authority home |
| Send an actor mailbox message | Command Center, where actor mailboxes remain homed |
| Control a browser page | Same installation as the actor and page; page locality is a physical runtime requirement |

There is no shared offline queue claim, CRDT merge, last-write-wins row,
unclaim, steal, or lease expiry. Stable sink identity is routing; it is never a
second writer.

## Station API boundary

`pair`, `configure`, `project`, `report`, and `status` are the complete fleet
protocol. The contract is transport-neutral; OpenSSH is the first adapter.
Command Center opens one persistent authenticated session. The session is
duplex, but a configured Remote may initiate only `report` on that existing
connection; it never dials Command Center or another Remote. Reconnection is
also Command Center-owned, so a Remote needs no callback route, public listener,
or inbound reach to Command Center. Browser operations are never Station API
verbs. Each frame is bounded and decoded with Effect Schema. Identifiers are
routing facts, not credentials. An unconfigured installation rejects every
work mutation. Once configured, role and host identity cannot change. Removing
a fleet target preserves the host-to-installation tombstone; exact
reactivation is permitted, but silently substituting a fresh installation is
not.

OpenSSH authenticates and transports the `vellum station-stdio` command. The
helper relays bounded correlated frames to the app's owner-local Station
control socket. It accepts no path, shell program, settings body, or database
location from the caller. OpenSSH authenticates the Remote host and operator
account; the helper-to-app socket hop is trusted owner-local containment, not
cryptographic continuation of that SSH peer identity into Electron main.
Remote main strict-decodes and authorizes every request. The fixed helper
narrows the surface but makes no claim against an arbitrary malicious same-user
process. There are no SSH file writes or reads in the coordination protocol,
no Station bearer credential, and no local fallback. Tailscale may supply
connectivity; it is not authority.

Report cursors cover the full `(event_home, entity_home)` route. Work records
are a strict shared `Command | Fact | Disposition` sum, never an opaque
repository-private JSON body.

`configure` is Remote-only on this wire. Command Center selection exists only
in the local main-process settings path; paired and Command Center states are
transactionally mutually exclusive. Request and response decoders reject
excess fields. The first successful Remote configuration atomically removes
all local authorial canvas generations, leaving only replace-only projection
residency.

## Scheduler behavior

Clock phase is not shared state. A Command Center tick and Remote tick may run
at different cadences without a correctness consequence because they do not
claim the same home.

For the current `everyMinutes` timer kind, missed intervals coalesce into at
most one firing. Restart schedules the next interval and never emits a latent
backlog. Future absolute-time timers are out of contract until they define an
explicit stale/catch-up policy.

## Capability and revocation

Edges and ports remain the Vellum Command capability plane. Placement chooses where a
node runs; it does not grant a capability.

- A missing edge or port denies the next Vellum Command action.
- Deleting a Station-homed resource updates Command Center intent; the
  reachable Station applies the next complete projection.
- An unreachable Station necessarily continues its last projection. Command
  Center reports that limit and never fabricates a revocation receipt.
- Process termination still accepts only Vellum Command-owned process capabilities.

## Non-goals

- quorum, elections, consensus, or CRDT canvas authority;
- Station leases or delegated authorship;
- Station-to-Station routing;
- absorbing SSH, Tailscale, harness, or provider credentials;
- synchronizing clocks beyond the operating system's ordinary time service;
- restoring any file-based topology or projection protocol.

## Release gate

- Pair and configure persist only through the Remote Station API.
- Projection replacement survives restart and rejects stale/conflicting
  generations.
- Command/disposition exchange survives interruption and converges by logical
  route cursor.
- A CC-home task can start on a Remote actor only through a live synchronous
  claim exchange, then continues there with Command Center closed.
- A Remote cannot queue or perform a new claim against an unreachable
  Command Center-home queue.
- One actor never receives an assignment, reservation backlog, or more than
  one active task.
- A Remote-home task may be claimed locally, and permitted request/artifact
  creation remains available while Command Center is closed.
- A Remote executes only its single-home watchers, timers, and work.
- Offline Remote simulation works with Command Center closed.
- No Remote opens a control connection to Command Center or another Remote.
- No `.canvas` pull, settings stamp, manifest, frame, ACK file, or status JSON
  participates in the product path.

This list is the release contract, not evidence that a packaged two-host run
has already passed. Promotion requires an operator-recorded Command
Center-plus-Remote qualification bound to the exact packaged artifacts; CI
package and single-installation smoke cannot substitute for it.
