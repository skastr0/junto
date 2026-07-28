# Remote Station end-to-end checklist

This is the operator proof for Command Center and Remote behavior on Linux and
macOS. It tests the canonical SQLite and Station API contract, including
offline and interrupted states.

## Evidence source

Run `vellum doctor` from an attached Vellum agent/tooling process so
process-bind admission is real. Fleet identity and synchronization truth come
from the live Remote `status` response, not a file read.

For every registered Remote, retain:

- expected and observed installation identity;
- role and hostId;
- current projection generation and hash;
- per-home received and peer-acknowledged logical cursors;
- database, work-control, and simulation readiness;
- current SSH reachability;
- last successful observation time.

Unknown or unreachable must remain unknown. A cached generation or cursor may
be shown as last acknowledged truth, but never as live health.

## 1. Local Command Center

1. Start a fresh Command Center with no Remote fleet target.
2. Confirm `~/.vellum/state/vellum.db` exists owner-only and no JSON state,
   canvas authority directory, projection directory, or seal material appears.
3. Create a canvas, local agent, work surfaces, watcher, timer, and region.
4. Draw the required edges and arm the region.
5. Confirm local work and pulses execute, and removing an edge denies the next
   action.
6. Confirm interval timers delayed past several slots fire at most once.
7. Run Doctor. Expect local database/work/simulation readiness and zero Remote
   rows.

## 2. Pair and configure a Remote

1. Install and start the same Vellum build on a disposable Remote.
2. Enroll its SSH endpoint in Command Center.
3. Configure it as Remote. Capture the `status → pair → configure` exchange.
4. Confirm the response installation identity is bound to that exact fleet
   target.
5. Run `status` again and confirm:
   - role is `remote`;
   - hostId and Command Center installation identity match;
   - database, work control, and simulation are ready.
6. Confirm SSH invoked only fixed `vellum-station`, and the helper relayed to
   the running app instead of opening or writing the database. Invoke the same
   helper directly as the enrolled operator account and confirm a strict
   correlated `status` response over the owner-local socket. This handoff does
   not claim to preserve the original SSH peer; Remote main still validates
   pairing, target, verb, transition, and work authority.

Pairing another Command Center, configuring a different installation identity,
or changing role through a settings surface must fail closed.

## 3. Complete projection

1. Author one canvas generation containing Remote-homed nodes.
2. Wait for Command Center fleet propagation.
3. Confirm Remote `status` reports the exact generation and content hash.
4. Restart the Remote and confirm the same projection remains active.
5. Repeat the same `project` request and confirm it is idempotent.
6. Send an older generation and confirm it is stale.
7. In a disposable database, send the same generation with a different hash
   and confirm it is a conflict without changing the active projection.

The Remote must never merge or author the projection.

## 4. Logical report convergence

1. Produce several Command Center-homed and Remote-homed events.
2. Confirm each home allocates contiguous decimal logical sequences.
3. Interrupt a multi-page report after at least one acknowledged page.
4. Reconnect and confirm exchange resumes strictly after durable cumulative
   cursors.
5. Repeat the last request and confirm already accepted events are idempotent.
6. Attempt a gap and an identity/content conflict in a disposable database;
   both must fail closed.
7. Compare origin timestamps out of order and confirm logical sequence still
   determines history order.

## 5. Offline Remote island

1. With a complete projection installed, stop only Command Center.
2. Keep the Remote app and service running.
3. Exercise Remote-homed work, a watcher whose source is locally available,
   and an interval timer.
4. Confirm the Remote uses its local database and never requires a Command
   Center RPC for locally homed execution.
5. Confirm Command Center-homed nodes do not execute on the Remote.
6. Restart Remote while Command Center remains closed. Confirm the projection
   and locally durable work resume; edge-detection re-baselines and no latent
   timer backlog fires.
7. Restart Command Center. Confirm projection and report retries converge by
   generation/hash and logical cursor.

## 6. Multiple machines and cadence

1. Enroll two Remotes with different Station tick cadences.
2. Home disjoint work and timers on Command Center, Remote A, and Remote B.
3. Run all installations long enough for their ticks to drift in phase.
4. Confirm each row and scheduler executes only at its home and never
   duplicates.
5. Confirm cross-machine cadence changes observation latency only.

## 7. Failure drills

- Stop SSH: mark the Remote unreachable while retaining clearly labeled
  last-acknowledged generation and cursors.
- Stop the Remote app: fixed `vellum-station` must report runtime down; it must
  not fall back to files or direct database access.
- Bind the endpoint to a different Station installation: identity mismatch
  must block propagation.
- Remove or change an enrolled endpoint: its persisted fleet target must be
  removed or rebound explicitly.
- Corrupt a disposable SQLite row or violate a schema constraint: the affected
  operation fails closed without rewriting from an alternate store.
- Make one Remote fail while another is healthy: one failure must not
  head-of-line block the independent fleet target.
- Close Command Center during propagation: no partial projection becomes
  active and acknowledged pages remain idempotent on retry.

## 8. No-residue audit

Search source, package contents, and disposable homes. Fail the release if any
live path creates or consumes:

- authorial `.canvas` files or a watched canvases directory;
- JSON settings, hosts, Station status, manifests, or current pointers;
- topology/hosts keys or seals;
- projection frames, ACK files, staging directories, or bridge binaries;
- SSH settings/projection/status file operations;
- a second production SQLite opener.

Explicit JSON Canvas exports, digest/SVG outputs, owner-local socket/token
transport, Chromium profile data, and package metadata are not product stores.

Linux package qualification remains governed by
[linux-package-qualification.md](linux-package-qualification.md); the macOS
deployment path remains in [macos-remote-e2e.md](macos-remote-e2e.md).
