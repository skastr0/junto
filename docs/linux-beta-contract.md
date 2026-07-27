# Linux beta contract

This is the narrow fleet surface allowed to ship as the first Linux beta. It
does not weaken [linux-production-contract.md](linux-production-contract.md) or
[security-doctrine.md](security-doctrine.md).

## Supported

| Surface | Contract |
|---|---|
| Platform | Ubuntu 24.04 LTS x86_64 |
| Command Center | One Linux desktop installation of the same `.deb` |
| Remote | Manual `.deb` installation, user systemd unit, Xvfb launcher |
| Connectivity | Operator-enrolled OpenSSH route, Command Center to Remote |
| Durable state | One `~/.vellum/state/vellum.db` per installation |
| Fleet control | Fixed `vellum-station`; `pair`, `configure`, `project`, `report`, `status` |
| Projection | One complete replace-only Command Center projection |
| Station events | Per-home logical sequences and cumulative ACK cursors |
| Local work | Agents, chat, native terminal, browser pages, work control |

Command Center and Remote use the same schema. Role changes row residency and
execution, not the storage implementation.

## Explicitly disabled

| Capability | Contract |
|---|---|
| Managed Remote install/update | `managedRemoteDeploy` and `managedRemoteUpdate` remain false |
| Darwin Remote deploy | `darwinRemoteDeploy` remains false |
| Command Center transfer | `commandCenterTransfer` remains false |
| In-app administrator-password deploy | No entry point |
| Station-to-Station control | No protocol or route |

Manual `.deb` installation is the only beta package path.

## Operator sequence

```text
1. Install the exact signed beta .deb on the target.
2. Enable and start vellum-remote.service.
3. Enroll the target's SSH endpoint in Command Center.
4. Configure as Remote: status → pair → configure.
5. Confirm status reports the expected installation identity and database,
   work-control, and simulation readiness.
6. Let Command Center project the complete canvas and exchange logical events.
```

SSH exit zero alone is neither configuration nor synchronization. Command
Center accepts success only from a decoded Station API response whose
installation identity matches the enrolled target.

## One-way state contract

The beta has no file-store compatibility:

- no `.canvas` pull or watched canvas directory;
- no `settings.json`, `hosts.json`, or `station-status.json` state;
- no content-addressed projection store, manifest, or pointer file;
- no topology/hosts key or seal;
- no `incoming.frame`, `applied.ack`, staging directory, or bridge substitute
  for Station API product state; the packaged release bridge exists only for
  signed package transport and remains inactive while managed deployment is
  disabled;
- no SSH file write/read for configuration, projection, report, or status;
- no direct database open by `vellum-station` or another helper;
- no importer, dual read/write, feature flag, or rollback to those paths.

Finding any such product path blocks the beta.

## Projection and report behavior

Projection installation compares logical generation and content hash:

- newer installs;
- same generation and hash is idempotent;
- older is stale;
- same generation with different hash is a conflict.

Report exchanges send bounded pages after the peer's last cumulative ACK.
Contiguous sequence admission and durable cursors make interruption and retry
idempotent. Origin and received timestamps are display metadata, never ordering
keys.

Remote ticks execute only Remote-homed state. Command Center and Remote ticks
need no phase alignment. Current interval timers coalesce missed intervals into
at most one firing.

## Doctrine alignment

- one trusted operator and one Command Center per factory;
- role is operator-selected, never hardware-inferred;
- edges, ports, and process-bind remain the agent capability plane;
- OpenSSH remains the transport authority; Vellum does not absorb SSH keys;
- a Remote applies complete intent and never authors or merges it;
- a Remote continues its latest projection while Command Center is closed;
- unreachable is reported as unknown/stale, never inferred healthy.

## Beta release gates

Do not label an artifact beta-ready until native Ubuntu evidence proves:

- fresh Command Center and Remote boot the same SQLite schema;
- Station API configure and status succeed through the packaged helper;
- full projection survives Remote restart;
- interrupted projection and multi-page report reconverge;
- Remote local simulation continues with Command Center closed;
- only single-home work, watchers, and timers execute;
- no retired state path is present in source or the package;
- signed package and readiness qualification pass for the exact artifact.
