# Linux production contract

**Status:** normative release contract

**Scope:** Ubuntu 24.04 LTS x86_64 only. ARM64 and other distributions are out
of v1.

This document freezes the production meaning of ready, durable, and secure for
the Linux path. It derives from
[security-doctrine.md](security-doctrine.md),
[state-architecture.md](state-architecture.md), and
[fleet-station-architecture.md](fleet-station-architecture.md).

## Production scope

One `.deb` supports:

- Linux Command Center with desktop parity;
- Linux Remote running unattended under user systemd and Xvfb;
- macOS Command Center to Linux Remote;
- Linux Command Center to Linux Remote.

Explicit exclusions:

- ARM64 and non-Ubuntu distributions;
- Station-to-Station control;
- multi-tenant or multi-operator RBAC;
- Command Center transfer;
- SSH, Tailscale, provider, or harness credentials absorbed into Vellum.

## Durable state

Every installation uses `~/.vellum/state/vellum.db`, mode `0600`, inside an
owner-only state directory. The Electron main process owns the one Effect
`StateEngine` connection. All services share that connection; renderers, CLIs,
packaged helpers, and SSH callers reach main through typed control surfaces.

The same schema boots for Command Center and Remote. Command Center persists
authorial canvas generations, fleet enrollment, and Command Center-homed work.
A Remote persists its configuration, one complete projection, local work,
events, receipts, and cursors. Logical sink identities may appear in every
projection, but each mutable work entity and event has one authoritative
installation home. Actor mailbox messages remain Command Center-homed;
task/request thread messages share their exact parent row's home.

The following are release blockers:

- JSON or content-addressed directories used as live product state;
- settings, hosts, status, manifest, frame, ACK, pointer, or seal files used
  for coordination;
- SSH reading or writing durable Vellum state;
- more than one production process or more than one connection opening the
  database;
- dual read/write, legacy import, or rollback to a retired store.

The coherent backup mechanism is `StateEngine`'s `VACUUM INTO`. Settings →
Advanced lists verified retained backups and can export one to a new
operator-selected file without overwriting it. Export is portability/evidence,
not restore: Linux v1 has no operation that replaces `vellum.db`, activates an
older binary, or downgrades product state. Forward repair uses a newer signed
release.

## Boot ready

Boot ready is structural and true only for the current systemd unit generation:

1. `vellum-remote.service` is active with a 32-hex `InvocationID`.
2. Work control publishes the private readiness receipt
   `$XDG_RUNTIME_DIR/vellum-remote/ready-$INVOCATION_ID` with body
   `${INVOCATION_ID}\n`.
3. Fresh owner-only work and Station control sockets are listening.
4. The packaged launcher owns the MainPID and notifies systemd only after
   observing readiness.
5. The app reports SQLite database readiness.

The readiness receipt is transport for one boot transaction, not durable
product state.

Boot ready gates:

- systemd unit start success;
- managed install/update activation;
- deploy preflight `ready=1`.

## Doctor observation

Terminal control, browser composition, canvas projection, scheduler simulation,
display, sandbox, and capability probes are Doctor observations. They may warn
or fail release qualification but do not become filesystem boot receipts.

Remote identity, configuration, projection generation, logical ACK cursors, and
database/work/simulation readiness come from the live `status` Station API
operation. Unknown or unreachable remains unknown; it is never converted into
success from a stale status file.

## Fleet contract

OpenSSH is the authenticated Command Center-to-Remote transport. Command Center
invokes only the fixed `vellum-station` command and exchanges bounded, typed
requests with the running Remote app.

- `pair` binds installation identities.
- `configure` commits role-specific topology.
- `project` replaces the complete projection transactionally.
- `report` exchanges route-local canonical Work events, dispositions, and
  cumulative ACKs.
- `status` observes identity, projection, cursors, and readiness.

No fleet request accepts a remote path or shell body. The helper never opens
the database. No settings stamp, canvas pull, drop file, or status-file read is
part of the contract.

Command Center owns the OpenSSH connection and every reconnect. A configured
Remote may send bounded `report` traffic over that already authenticated
duplex session, but it never opens a callback route to Command Center and never
connects to another Remote. Tailscale may provide reachability to SSH; it is
optional and grants no Vellum authority. Browser and actor control are
host-local and never become Station API verbs.

Each executable actor, physical runtime, work entity, work event, watcher, and
timer has one installation home. A Command Center-home task may start on a
Remote actor only through a live synchronous claim exchange. Claim is
`submitted → working`, not assignment or backlog reservation; after acceptance
that exact task advances on the Remote while Command Center is closed.
Remote-home tasks may be claimed locally, and permitted requests/artifacts may
be created locally. Each installation's tick operates only its local home.
Cross-machine tick alignment affects latency, not correctness.
`everyMinutes` timers coalesce missed intervals into at most one firing.

## Secure

A boundary Vellum advertises is a boundary Vellum enforces:

- edges, ports, and process-bind form the agent capability plane;
- no ambient host-destructive API accepts a bare PID or broad path;
- credentials remain owned by the operator, operating system, or provider;
- a Remote never authors, merges, negotiates, or vetoes Command Center intent;
- no Station-to-Station route exists;
- an unreachable Remote is reported honestly under its last installed
  projection.

## Package and readiness receipt

The one permitted filesystem readiness receipt is:

```text
path   := $XDG_RUNTIME_DIR/vellum-remote/ready-$INVOCATION_ID
body   := <32 hex INVOCATION_ID> + "\n"
mode   := 0600 regular file, owner-only, no symlink
writer := work-control after token rotation + listener bind
delete := RuntimeDirectory teardown on unit stop
```

Launcher, deploy preflight, and privileged installer must agree on this exact
receipt. `/run/user/$UID/vellum/station-ready.json` and deep JSON readiness
files are forbidden.

## Exit gates

Linux is production-ready only when:

- the same qualified artifact runs as desktop Command Center and unattended
  Remote on native Ubuntu 24.04 x86_64;
- package install/update complete without readiness timeout;
- fresh install creates only the canonical SQLite state architecture;
- pair/configure/project/report/status pass over the fixed command;
- interrupted projection and report exchanges converge idempotently;
- Remote restart resumes its projection and host-local work;
- Remote simulation continues while Command Center is closed;
- each Station fires only single-home watchers and timers;
- agents exercise only current edge/port capabilities;
- no retired state or SSH file protocol exists in the packaged tree;
- UI and Doctor report reachability, projection, cursors, and residual limits
  truthfully.

CI package construction and single-installation smoke are necessary evidence,
but do not satisfy these exit gates. Production qualification requires a real
two-installation Command Center/Remote run bound to the exact source commit and
`deb` SHA-256. Until that operator receipt exists, the artifact is explicitly
unqualified rather than implicitly passed.
