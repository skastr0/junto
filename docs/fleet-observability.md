# Fleet observability and qualification

**Status:** normative operator runbook

**Covers:** managed deployments, Station sessions, complete projections, work
report convergence, actor and sink placement, and macOS Command Center to
Remote qualification

**Architecture:** [Fleet and Station architecture](fleet-station-architecture.md)
and [Junto protocol](vellum-protocol.md)

## What a green Fleet view proves

A Remote is ready for end-to-end qualification only when one fresh observation
proves all of these layers:

1. the enrolled SSH route reaches the expected installation;
2. the local and Remote Station protocol ranges overlap;
3. the persistent session is open and its supervisor phase is `ready`;
4. the Remote reports database, work control, simulation, and session ready;
5. the Remote has acknowledged the current complete projection generation and
   content hash;
6. the last bounded work report has no remaining pages and no rejected inbound
   records;
7. the projected topology contains the intended Remote actors, sinks,
   schedulers, and Command Center to Remote access edges;
8. the Remote lease is active;
9. a managed deployment receipt exists when Command Center installed the
   package.

These facts answer different questions. SSH reachability does not prove Station
readiness. A matching projection does not prove work-report convergence. A
converged report does not prove the route remained connected after its receipt.

## Operator surfaces

### Fleet detail

Open Fleet, select a Remote, and use **Test link**. The probe asks the persistent
fleet supervisor to reconcile that target. It does not read Remote files or
open the Remote database.

The detail panel presents:

| Section | Evidence |
|---|---|
| Connectivity | SSH reachability, latency, both protocol ranges, negotiated protocol |
| Station diagnostics | expected and observed installation, role, host, Command Center binding, session state, readiness, lease, projection receipt, logical cursors |
| Last synchronization | projection decision, exact generation and hash, report rounds, sent and received totals, accepted, idempotent, rejected, remaining-page flags |
| Projected topology | complete portfolio counts and per-Remote actor, sink, scheduler, and access-edge counts |
| Remote deploy | live in-process stages plus the final result and recovery guidance |

`converged` means the last bounded report ended with no outbound or inbound
pages remaining and no rejected inbound record. It is a receipt for that
exchange, not a permanent liveness claim.

The logical cursor disclosure lists each `(event home, entity home)` route and
its cumulative decimal sequence. Counts are useful at a glance; route rows are
the evidence used to diagnose which authority lane is behind.

The projected-topology section is compiled from the exact complete portfolio
that the Remote acknowledged. It is count-only and contains no canvas names,
node references, prompts, work bodies, or credentials. Its edge counters mean:

| Counter | Meaning |
|---|---|
| Remote-local actor to sink | both endpoints execute on the selected Remote |
| Remote actor to Command Center sink | logical cross-install access from the selected Remote |
| Command Center actor to Remote sink | logical cross-install access toward the selected Remote |
| Station to Station | an edge crosses two non-Command-Center hosts; the runtime route law denies direct Station peer control |
| Dangling | an edge endpoint is absent from its canvas |

Logical access still requires the edge ports and a process-bound seat. A count
does not grant capability. Mutable work remains single-home even when a sink
identity appears in every complete projection.

### Doctor

From a process-bound Junto agent, run:

```sh
vellum-command doctor
```

Doctor is the machine-readable aggregate. Its Station and Remote-host checks
include exact per-Remote metadata for identity, protocol support, route phase,
projection generation and hash, cursor routes, readiness, lease, observation
freshness, deployment receipt, and recovery guidance.

Interpret severity as follows:

| State | Meaning |
|---|---|
| `ok` | fresh evidence satisfies the current checks |
| `warning` | usable but incomplete, stale, deprecated, or missing a deployment receipt |
| `error` | identity conflict, unreachable route, expired lease, or another fail-closed condition |
| fleet-blind | Command Center cannot obtain current Remote Station truth; retained facts are history only |

Unknown stays unknown. Junto never turns a cached receipt into live
health.

### Remote logs and supervised process

The managed macOS Remote LaunchAgent writes:

```text
~/Library/Logs/Junto/vellum-command.out.log
~/Library/Logs/Junto/vellum-command.err.log
```

Use logs only after Fleet has named the failing layer. Logs are supporting
diagnostics, not authority for identity, projection, or logical cursors.

Read-only host checks that do not stop the app:

```sh
ssh <endpoint> 'launchctl print gui/$(id -u)/skastr0.vellumcommand'
ssh <endpoint> 'test -S ~/.junto/station/control.sock && echo station-ready'
ssh <endpoint> 'test -S ~/.junto/term/control.sock && echo terminal-ready'
ssh <endpoint> 'test -S ~/.junto/browser/control.sock && echo browser-ready'
```

Tailscale may provide route reachability, but it supplies no identity or
Station authority. `tailscale status` and `tailscale ping <host>` diagnose the
network layer only.

## Evidence hierarchy

When facts disagree, use this order:

1. a fresh strict Station `status` response from the expected installation;
2. the last successful persistent-supervisor synchronization receipt;
3. the durable deployment receipt;
4. process and socket observations;
5. logs.

Never infer current Remote state from a package existing in `/Applications`, a
LaunchAgent plist, an old socket pathname, or a previous successful deploy.

## Layer-by-layer failure isolation

### Deployment

The deploy panel records each bounded stage. A successful macOS activation
currently requires the supervised process plus Station, terminal, and browser
control readiness. The final activation witness is strict:

```text
STATION_READY pid=<pid> term=1 browser=1
```

If deployment is indeterminate, preserve the previous package and role facts,
inspect the named recovery action, and do not treat a visible app bundle as a
successful deployment.

### Identity and configuration

The enrolled installation must equal the installation returned by the Remote.
The Remote configuration must name its enrolled host and this Command Center.
Any mismatch is an error, not an invitation to overwrite identity.

### Protocol and session

App release, SQLite schema, and Station protocol are separate facts. Only the
Station protocol support ranges select wire behavior. No overlap means
`update-required`; the Remote continues locally under its last projection and
Command Center sends no partial down-conversion.

The route phase explains the supervisor:

| Phase | Meaning |
|---|---|
| `connecting` | opening the enrolled transport |
| `synchronizing` | status, projection, and report are in flight |
| `ready` | the last exchange completed and the persistent session is open |
| `update-required` | protocol ranges do not overlap |
| `backoff` | a bounded attempt failed; `nextRetryAt` names the retry |
| `stopped` | supervisor admission is closed |

### Projection

Compare both generation and SHA-256. Equal generation with different content
is a conflict. A Remote ahead of Command Center is stale from the authority
perspective and must fail closed. A successful receipt is `install`,
`idempotent`, or `unchanged` and names the exact active generation and hash.

### Work convergence

The report receipt separates transport volume from durable admission:

- `outboundSent`: records sent from Command Center;
- `inboundReceived`: records returned by Remote;
- `inboundAccepted`: new records durably admitted;
- `inboundIdempotent`: already-known identical records;
- `inboundRejected`: causal or authority violations;
- `hasMoreOutbound` and `hasMoreInbound`: whether the bounded exchange stopped
  before draining both sides.

Any rejected record or remaining page makes the receipt incomplete. Reconnect
resumes from durable cumulative route cursors; it does not use timestamps.

### Actor and sink routing

Use projected topology to confirm intent before executing work:

- the selected Remote has the expected actor count;
- required sinks and schedulers are placed on the intended installation;
- Remote actors have the intended access edges to Command Center-homed sinks;
- no unintended Station-to-Station edge is present;
- no dangling edge exists.

Then use the actor ledger and work surfaces for row-level proof: submitted to
working claim, current authority home, activity, request and artifact creation,
and delivery receipts. Fleet proves installation transport and projected
topology; the actor ledger proves one seat's work-plane standing.

## Qualification evidence record

Before calling a two-host run passed, retain one record containing:

```text
source commit:
Command Center package version and digest:
Remote package version and digest:
Command Center installation identity:
Remote enrolled and observed installation identity:
SSH endpoint label:
protocol local range / peer range / negotiated:
route phase / session open / observation time:
projection generation / SHA-256 / decision:
report rounds / sent / received / accepted / idempotent / rejected:
has more outbound / inbound:
received cursor routes:
peer-acknowledged cursor routes:
Remote database / work / simulation / session readiness:
terminal / browser readiness:
lease state / expiry:
topology counts:
deployment outcome / receipt time:
offline-island result:
reconnect result:
operator verdict:
```

Do not include bearer tokens, socket tokens, local filesystem paths, canvas
node references, task bodies, prompts, or license secrets. Diagnostic
boundaries redact those values, but the qualification record should never seek
them.

## Required end-to-end sequence

Run the concrete macOS flow in [macOS Remote end to end](macos-remote-e2e.md)
and the authority and offline drills in the
[Remote Station checklist](remote-station-checklist.md). A source test run, a
single machine smoke, or a green deployment alone cannot close the two-host
qualification.
