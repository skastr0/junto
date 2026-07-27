# Fleet and Station architecture

**Status:** normative

**Governs:** Command Center-to-Station intent delivery, single-home execution,
logical propagation, and revocation

**Doctrine:** [security-doctrine.md](security-doctrine.md),
[state-architecture.md](state-architecture.md), and
[architecture-factory-physics.md](architecture-factory-physics.md)

## Product sentence

One sovereign operator; one Command Center per factory; every installation
runs the same SQLite-backed app; each Station independently executes the rows
homed there under the latest complete Command Center projection.

## Fleet invariants

1. Every installation has a durable installation identity and belongs to at
   most one factory and one role.
2. Role is chosen by the operator and stored in `vellum.db`; hardware and
   network discovery never infer it.
3. A machine is not both Command Center and Remote.
4. No Command Center is created through SSH, a canvas edit, or a Station API
   request.
5. No Station-to-Station control plane exists.
6. A work row, executable node, watcher, or timer has exactly one home.
7. A local tick operates only on locally homed state.
8. Timestamps are metadata. Route-local `(event_home, entity_home, seq)`
   identities order propagation.
9. Role, configured host identity, and fleet host-to-installation binding are
   immutable until an explicit transfer ceremony exists.

## Intent and work flow

```text
Command Center authors one full canvas generation
  → compiles one complete Station projection
  → invokes fixed vellum-station over the enrolled SSH route
  → Remote main validates and transactionally replaces station_projection
  → Remote simulation reads that projection and its locally homed work

Command Center persists a Remote-homed mutation as pending
  → report sends it on that host's canonical Work stream
  → Remote atomically applies or causally rejects it
  → Remote durably emits a disposition before acknowledging the command
  → Command Center materializes only an applied disposition
  → retries converge idempotently by route cursor
```

The projection is a replaceable cache of intent, not an independently
authoritative canvas. A Remote never merges or edits it. Projection bodies are
strict canonical portfolio envelopes: malformed, noncanonical, or
runtime-work-bearing canvases fail before persistence.

When Command Center is unavailable, a Remote continues under its installed
projection and local database. When a Remote is unavailable, Command Center
retains the last acknowledged generation and cursors and reports the route as
unreachable. Neither side invents synchronization.

## Station API boundary

`pair`, `configure`, `project`, `report`, and `status` are the complete fleet
protocol. Each request and response is bounded and decoded with Effect Schema.
An unconfigured installation rejects every work mutation. Once configured,
role and host identity cannot change. Removing a fleet target preserves the
host-to-installation tombstone; exact reactivation is permitted, but silently
substituting a fresh installation is not.

OpenSSH authenticates and transports the fixed `vellum-station` command. The
helper relays to the app's owner-local Station control socket. It accepts no
path, shell program, settings body, or database location from the caller.
There are no SSH file writes or reads in the coordination protocol.

## Scheduler behavior

Clock phase is not shared state. A Command Center tick and Remote tick may run
at different cadences without a correctness consequence because they do not
claim the same home.

For the current `everyMinutes` timer kind, missed intervals coalesce into at
most one firing. Restart schedules the next interval and never emits a latent
backlog. Future absolute-time timers are out of contract until they define an
explicit stale/catch-up policy.

## Capability and revocation

Edges and ports remain the Vellum capability plane. Placement chooses where a
node runs; it does not grant a capability.

- A missing edge or port denies the next Vellum action.
- Deleting a Station-homed resource updates Command Center intent; the
  reachable Station applies the next complete projection.
- An unreachable Station necessarily continues its last projection. Command
  Center reports that limit and never fabricates a revocation receipt.
- Process termination still accepts only Vellum-owned process capabilities.

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
- A Remote executes only its single-home watchers, timers, and work.
- Offline Remote simulation works with Command Center closed.
- No `.canvas` pull, settings stamp, manifest, frame, ACK file, or status JSON
  participates in the product path.
