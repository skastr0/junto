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
events, receipts, and cursors. Messages remain Command Center-homed.

The following are release blockers:

- JSON or content-addressed directories used as live product state;
- settings, hosts, status, manifest, frame, ACK, pointer, or seal files used
  for coordination;
- SSH reading or writing durable Vellum state;
- more than one production process or more than one connection opening the
  database;
- dual read/write, legacy import, or rollback to a retired store.

The only coherent backup mechanism implemented in `StateEngine` is `VACUUM
INTO`; Linux v1 exposes no operator backup or restore command. Linux release
cutover is one-way: an older binary is never activated. Forward repair uses a
newer signed release and never restores, replaces, or downgrades product state.

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

Each executable node and work row has one home. Each installation's tick
operates only its local home. Cross-machine tick alignment affects latency,
not correctness. `everyMinutes` timers coalesce missed intervals into at most
one firing.

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
