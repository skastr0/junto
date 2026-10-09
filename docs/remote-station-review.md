# Review: the Remote station feature

From the Remote region, 2026-10-09, at the operator's direction. A review of
state and fit. It prunes nothing and proposes no design.

Receipts are `path:line` at commit `c604aae01`. A claim marked *(audit)* comes
from a delegated read that I did not repeat. Everything else I opened myself.
What nobody ran is listed at the end.

## Verdict

1. **Two features are welded together under one name.**
   - A **host layer**: a host registry, a typed SSH plane, a remote terminal
     route, a macOS deployer and launchd supervision. This is the part that ran
     on a real second Mac in August.
   - A **replicated factory**: the Station protocol, a complete projection of
     every canvas to every Remote, and multi-home work convergence, built so a
     Remote could keep executing claimed tasks while the Command Center was
     closed.
2. **The replicated factory has no input, no payload and no user.** Its input
   was the canvas document, which no longer exists. Its payload is twelve work
   operations, of which two serve a feature that ships
   (`src/shared/work-protocol.ts:173-184`). The one work primitive
   that ships, mail, is the one it deliberately keeps off a Remote.
3. **The host layer fits the product and is fenced behind the other.** A seat
   cannot start on another machine until that machine acknowledges a
   projection, and no projection can be compiled.
4. **Nothing is operable end to end today, in any build, and the October
   switch-off is only one of several independent reasons** (section 4).
5. **Station identity cannot be pruned. Station protocol can.** The
   single-machine app depends on installation identity, the configured role and
   several station tables. It depends on none of the protocol.
6. **The carrying cost is about 100,000 lines**: roughly 12% of source, 17% of
   test lines, 36% of script lines and 45% of the docs.

## 1. Footprint

Measured by file name over tracked files. Shared plumbing is listed separately
because the shipping app needs it.

| Area | Files | Lines | Note |
|---|---|---|---|
| `src/main/junto/station/` | 27 | 14,005 | about 11,300 can do no useful work in ship *(audit)* |
| `src/main/junto/hosts/` | 29 | 10,839 | registry is live; deploy and host runtime are unreachable |
| `src/main/junto/ssh/` | 11 | 3,646 | no ship path dials it *(audit)* |
| `src/main/junto/box/` | 9 | 2,302 | provider is off in every build; its reconciler runs in ship |
| `src/main/junto/supervision/` | 7 | 1,580 | launchd observe is live; the systemd half serves only a Remote |
| Fleet update executor in `update/` | 3 | 569 | no importer |
| `src/renderer/components/fleet/` and fleet libs | about 20 | about 3,600 | all-on build only *(audit)* |
| Remote face (`components/remote/`, `lib/remote-station-face.ts`) | 2 | 283 | in the ship bundle |
| `src/shared/` station, fleet, remote, host, linux files | 30 | 7,122 | |
| Remote entries and status (`junto-remote.ts`, `remote-runtime.ts`, readiness, status store) | 5 | 1,344 | |
| **Source, feature only** | | **about 45,000** | 12% of 362,664 |
| Tests, core station, fleet, hosts, ssh, deploy, box | 123 | 34,455 | 16.7% of test lines, 912 cases *(audit)* |
| Scripts, linux, remote, station, host | 22 | 13,159 | 36% of script lines |
| Docs, station, fleet, remote, linux | 15 | 4,784 | 45% of doc lines, plus about 450 lines of the security doctrine |

Not counted above, and entangled: about 2,900 of the 12,240 lines in
`src/main/junto/work/repository.ts` exist only for multi-home convergence
*(audit)*, and the remote terminal route lives in `src/main/junto/term/`
(`control-client.ts` 881, `control-server.ts` 1,234, part of `router.ts`).

Adjacent and not this feature: the Mac and Linux desktop self-update
(`update/` minus the three fleet files), and the phone companion
(`src/main/junto/companion/`, `docs/companion-protocol.md`), which is a remote
viewer of local seats over an SSH forced command and is live.

## 2. What is switched off, layer by layer

Eight separate gates stand between an operator and a working Remote. They were
added at different times and do not know about each other.

| # | Gate | Where | What it stops | Applies to |
|---|---|---|---|---|
| 1 | Build flag `fleetUi` | `src/shared/feature-catalog.ts` `SHIP_FEATURES` | ingress only: hosts IPC (`src/main/junto/ipc.ts:408`), preload hosts API (`src/preload/index.ts:1000`), the Fleet overlay, the `fleet` and `qualification` CLI groups (`src/cli/command-runner.ts:36`), the remote terminal dial (`src/main/junto/term/router.ts:1027`) | ship |
| 2 | Release capabilities | `src/shared/release-capabilities.ts:49-56` | fresh enrollment, managed deploy, Darwin deploy, Linux deploy, Box | every build |
| 3 | Hard switch-off, 2026-10-07 | `src/main/junto/station/propagation.ts:522`, `station/api.ts:1905` and `:2342`, `station/repository.ts:816-877` | compiling a projection, the Command Center side of `report`, installing a projection, a first Remote configuration | every build |
| 4 | Supervisor never started | `src/main/junto/ipc.ts:2553` | any Command Center session to a Remote | every build |
| 5 | Qualification refusal | `src/main/junto/hosts/operator-qualification-work.ts` | the three qualification steps | every build |
| 6 | Release sentinel | `src/shared/remote-station-release.ts:16` | any contract version other than 1 | every build |
| 7 | Seat rules | `src/main/junto/term/actor-seat-occupy.ts:127-153`, `src/main/junto/model/records.ts:70-79` | starting a seat on another host without an acknowledged projection; placing a seat on a host that is not an enrolled fleet target | every build |
| 8 | Skipped tests | seven `it.skip` in `tests/station-propagation.test.ts` and `tests/station-repository.test.ts`; all of `e2e/scenarios/fleet-ship.spec.ts:67` | the tests that exercised the refused paths | every lane |

Gate 2 has no working override. The comment promises one for unpackaged
development, but nothing in `src` or `scripts` reads
`resolveReleaseCapabilities` or `JUNTO_ENABLE_LINUX_FLEET`.

Gate 3 is unconditional. An all-on build still compiles the Fleet UI, and
every action in it that needs a projection now ends in a refusal: Configure
Remote, fleet sync, the qualification commands and starting a seat on an
enrolled Remote. The host list, link test, peer discovery and plain remote
terminals are the parts that are real *(audit)*.

### The six closed operations today *(audit, refusal sites checked)*

| Operation | State |
|---|---|
| `status` | the only one that can complete, in an all-on build, against a packaged headless unenrolled peer |
| `pair` | handler intact; its only sender is behind `fleetUi` and reaches the wrong door (section 4, item 1) |
| `configure` | a first configuration is refused; an install already configured as a Remote can still reconfigure |
| `project` | always refused; `installProjection` has no caller |
| `report` | Command Center side always refused; Remote side needs a projection that can no longer arrive |
| `overseer` | needs a live Command Center session, which nothing opens |

## 3. What still runs in the shipping app

### Load-bearing, so it cannot be pruned

- **The configured role gates everything.** Every canvas mutation requires role
  `command-center` (`src/main/junto/ipc.ts:347-358`). Every work mutation
  requires a station configuration (`src/main/junto/work/service.ts:780-787`).
  First boot writes the role itself.
- **A seat's identity is a hash of the installation id and its binding**
  (`src/main/junto/station/actor-seat-compiler.ts:178-197`), imported by the
  kernel, model, overseer, term and work planes.
- **A seat's host is validated against station tables**
  (`src/main/junto/model/records.ts:70-79`).
- **The mail table carries a trigger that joins `station_configuration`**
  (`src/main/junto/work/state-schema.ts:1596-1613`).
- **`work_facts` has a foreign key into `station_projection_versions`**
  (`src/main/junto/work/state-schema.ts:572-575`), and work routes reference
  `station_known_installations` *(audit)*.
- **The live work repository imports the station's frozen document converter**
  (`src/main/junto/work/repository.ts:140`). The lint that exempts
  `src/main/junto/station/` says "nothing reaches it"
  (`scripts/lint-no-canvas-document.ts:84-86` at HEAD). That is not true.
- **Boot reads the station configuration to choose a door**
  (`src/main/index.ts:1487-1505`), builds every station, hosts, SSH and Box
  layer (`src/main/runtime.ts:156-210`) and keeps the fleet supervisor service
  for shutdown (`src/main/index.ts:1647`).
- **At least twenty-six files outside `station/` import it**, across eleven
  directories and four entry files.

### Runs for nothing

- **The Box activity reconciler** subscribes to every model, canvas and work
  change (`src/main/junto/box/activity-policy.ts:341-345`) for a provider that
  is off in every build.
- **The Remote face** replaces the whole app when the role is `remote`, with no
  flag (`src/renderer/App.tsx:561-563`). No fresh install can reach that role.
- **Every Linux desktop package stages the Remote runtime**
  (`scripts/package-app-linux.sh:83`), and the Ubuntu CI job builds and audits
  it on each push *(audit)*.

### Station words in ship copy

- "choose Command Center or Remote before mutating work"
  (`src/main/junto/work/service.ts:786`), a choice this build refuses.
- "Station role is unset; authorial canvas mutation is refused until protected
  topology establishes this installation as Command Center"
  (`src/main/junto/ipc.ts:356`).
- A "placement" section with `cc` and `local` chips on the agent kind strip, and
  "Factory must be playing with a station role set" in the kernel *(audit)*.

## 4. Broken apart from the switch-off

The first seven would each still stop a working Remote seat if gate 3 were
lifted tomorrow. The rest are defects found on the way.

1. **Fresh enrollment reaches the wrong door.** Read, not executed. The Command
   Center sends `pair` and `configure` through the peer exchange
   (`src/main/junto/hosts/configure-remote.ts:280-314`), which always resolves
   the helper in session mode (`src/main/junto/station/openssh-peer-exchange.ts:900-905`).
   Session mode is `station-stdio` with no argument
   (`src/main/junto/ssh/read-commands.ts:47-52`), which selects the peer socket
   (`src/cli/station-stdio.ts:29-32`). An unenrolled install binds only the
   enroll socket, the relay has no fallback
   (`src/main/junto/station/control-relay.ts`), and the peer door would refuse
   both verbs anyway (`src/main/junto/station/control-server.ts:323-328`). The
   split dates from `638e483c2`, 2026-08-13; the sender has not changed since.
   The Mac mini was enrolled on or about that day *(audit)*, which is
   consistent with this.
2. **Deploy is closed in every build**, with no override (gate 2).
3. **The Linux deployer is hollow.** Its copy step returns "Linux Remote Deploy
   is not enabled" unconditionally
   (`src/main/junto/hosts/host-ops-linux.ts:135-153`), and its artifact
   authority has no caller *(audit)*.
4. **A ship-profile Mac Remote could never report ready.** Deploy readiness
   waits for the term and browser sockets
   (`src/main/junto/hosts/deploy-darwin.ts:2120`), and the browser socket binds
   only when the browser feature is on (`src/main/index.ts:1891`), which it is
   not in ship. I checked the gate and the comment, not the wait loop.
5. **The projection has no source.** Nothing produces the authority snapshot it
   compiles from; both call sites substitute a failure. The model has a
   per-canvas sequence and no portfolio-wide generation or hash, and the
   station's own model-to-document converters have no caller *(audit)*.
6. **A Remote runtime has none of the seat features built since September.**
   It omits the signals, seat session, seat guidance and references
   repositories (`src/main/remote-runtime.ts:134-149` against
   `src/main/runtime.ts:136-160`). A seat there that raises its hand gets
   "agent signals are unavailable in this Junto runtime"
   (`src/main/junto/work/control.ts:2175-2181`).
7. **Mail cannot be typed into a seat on another machine.** Delivery writes the
   local host only, and the wake refuses a seat that is not local *(audit)*. A
   Remote composes no mail delivery at all (`src/main/junto-remote.ts:424-428`).
8. **The two-station runner cannot pass.** It calls the three qualification
   steps that now refuse *(audit)*.
9. **The fleet update executor has no importer.**
10. **Smaller defects.** Both copies of the systemd unit fuse two variable
    names into `JUNTO_E2EJUNTO_E2E_RENDERER_SURFACE_TIMEOUT_MS`
    (`build/linux/junto-remote.service.template:26`,
    `src/main/junto/supervision/systemd-user.ts:76`), so neither is unset.
    Configure contacts the Remote over SSH before it checks the release gate
    *(audit)*. Old seats keyed to a remote host with no explicit stamp were
    converted to host `local` *(audit)*.

## 5. Where it mismatches the product

Ship turns on agent seats, mail, regions, signals, overseer and sound. Tasks,
board, pad, sheet, requests, artifacts, cron, relay, browser and the deep
Hermes integration are all off (`src/shared/feature-catalog.ts` `SHIP_FEATURES`).

| The station design assumes | The product today |
|---|---|
| "One operator-owned factory" (`docs/junto-protocol.md:24`, `:192`) | a peer-agent workspace |
| The canvas is one document, projected whole to every Remote | no document; typed rows changed by commands. The projection body is still the frozen copy (`src/main/junto/station/frozen-document.ts:1-2`) |
| Work means tasks with claims, and a Remote is an offline authority over them | tasks are off. Ten of the twelve wire operations serve features that are off (`src/shared/work-protocol.ts:173-184`) |
| Mailboxes are Command Center homed; a Remote "cannot materialize that mailbox while Command Center is unavailable" (`docs/junto-protocol.md:832-833`) | mail is the product. Under the design, two seats on the same Remote cannot mail each other while the Command Center is closed |
| Attention arrives as requests and task states | attention arrives as signals, which have no home and no remote path |
| Session continuity is a field the Command Center authors on a node | seat sessions, notes, offboard and automatic offboard, stored with local absolute paths *(audit)* |
| Board, pad, requests and artifacts are Command Center homed sinks | all off |
| Schedulers fire only on their placement host | cron and relay are off, and nothing enforces the rule (`AGENTS.md:66-69`) |
| Hermes `<host>:<profile>` agent keys identify where an agent lives | the integration is off; every ship seat is keyed `local:<harness>` *(audit)* |
| The Fleet panel shows negotiated protocol, cursor routes and withheld semantics | "No mechanics in operator copy" (`AGENTS.md`, copy law) |

**Built after the station design, and unknown to it** *(audit, first-commit
dates)*: signals (09-25), seat guidance (09-26), seat sessions (09-28), the
onboard contract and region environment (10-05), references and the generation
credential (10-07). The protocol document has no occurrence of onboard,
offboard, signal, blocked, escalate or feedback.

**The gap, stated as an observation.** For a seat on another Mac to be a peer
on this canvas, what has to cross machines is small: the spawn intent, terminal
input and output, seat state, mail in and out, the onboard read, signals with
their attachments, and session notes. What the existing design moves instead is
every canvas as a serialized document plus an actor registry, and bidirectional
event convergence with cursors and acknowledgements, with terminal traffic on a
separate socket beside it. It moves none of the first list except terminal
traffic.

## 6. What is holding it back

Ranked by how much of the difficulty each explains.

1. **It replicates a factory that is gone.** Complete projection, single-home
   authority transfer, synchronous claims, dispositions and cursors all exist so
   a Remote can execute tasks offline. With tasks off and mail homed on the
   Command Center, a Remote has nothing to be an authority over.
2. **The part that worked is hostage to the part that did not.** The remote
   terminal route needs only a registered host, SSH and a running Junto on the
   target (`src/main/junto/term/router.ts:1091`). Seat start is the one path
   that also demands a projection.
3. **Station identity and station protocol were never separated.** Because the
   role, the installation id and the station tables are load-bearing for one
   machine, the feature cannot be removed as a unit, and that has protected the
   protocol code that depends on nothing live.
4. **Proof was built before operation.** Frozen protocol codecs, a golden
   corpus, a compatibility matrix, a release sentinel, a qualification receipt
   format and a 3,987-line two-station runner exist for a protocol that never
   carried one agent seat. About 1,250 lines negotiate a version policy fixed at
   1/1/1 *(audit)*. No test provides the real Station API handler, and no test
   runs two stations *(audit; the first I confirmed by search)*.
5. **Too many targets for a feature with no users.** A full Electron copy under
   a LaunchAgent on macOS, a displayless Node runtime under systemd on Linux,
   and provider virtual machines through Box: three runtimes, two trust stacks,
   two install paths.
6. **Investment continued while it was dormant.** Protocol codecs (08-27), the
   Remote overseer operation (09-11) and the move of station persistence to
   Effect SQL (09-29) all landed after it was switched off in ship.
7. **Each rework replaced the layer beneath the last.** Five in the first five
   weeks: an external multiplexer over SSH, file frames, SQLite with a Station
   API, a persistent framed session, then exclusive doors.
8. **The written contract misleads.** `AGENTS.md` and seven other normative
   documents say things the code contradicts (section 9), and about thirty
   tests pin source text of the current wiring.

## 7. History in brief

Hashes marked * I opened; the rest are from the history audit.

- **07-16 to 07-24.** First remote transport, an external terminal multiplexer
  CLI over SSH (removed 08-25, 25,000 lines). Typed SSH kernel and host
  registry. Command Center and Remote roles. macOS deploy. Linux deploy on a
  privileged package path. Projection as file frames. Fleet UI. First freeze.
- **07-27.** Files to SQLite and an app-owned Station API; the three-day-old
  file protocol deleted; identity split into host id and installation id; a
  persistent framed SSH session; causal work replication; the Box provider.
- **07-28 to 07-31.** Protocol negotiation, protocol 4, a rootless Node Remote
  replacing the privileged Linux path. Everything enabled for 0.1.1
  (`71d57822a`*), then Linux and Box descoped two days later (`50088bc26`*).
- **08-05.** Build profiles; `fleetUi` is born off in ship.
- **08-12 to 08-17.** On for the Mac mini run (`be2744a3f`*). Exclusive enroll
  and peer doors (`638e483c2`*). Protocol reset from 4 to 1 as "unreleased"
  (`86bc9d83c`*).
- **08-25.** Dormant (`997722ee0`*).
- **09-16.** Rename; schema and protocols collapsed to a baseline (`ebd18ca9c`*).
- **10-07.** The document is removed (`6edec1c0a`*), projection stopped
  (`1fa42023c`*), station conversion frozen (`783c86053`*).

**Cycles.** Three enable waves (07-29, 08-12, 08-17) and six disables. The
longest stretch enabled in ship was thirteen days.

**Was it ever operated?** Partly. A MacBook Command Center and a Mac mini Remote
ran from 08-13 to 08-17. A session from that run records: "Remote stations work
for PTY + Station hops. They do not yet work as actor seats", with `status`
ready and `project` and `report` succeeding, and the mini's agent occupied as a
plain terminal (session `grok:e6913dd8`). The seat fix was committed and never
installed on either machine before the 08-25 disable *(audit)*. No two-host pass
was ever recorded: `docs/remote-station-checklist.md:3-4` says "not yet a
recorded two-host pass". A Linux two-machine attempt on 07-31 failed at
"station status is not ready" *(audit)*.

**Churn** *(audit; my own path count gives 477)*. About 516 of 5,511 commits on
main touch the core paths, 9%. By type: 225 fixes, 166 features, 89 refactors.
The core added 67,564 lines and removed 31,931.

## 8. Decisions already on record

- **2026-08-25, operator** (session `grok:6df3de94`): "it is, frankly, a
  gigantic feature that I cannot afford to tackle while the app is not even yet
  hard launched ... right now it is enabled, but it basically doesnt work".
- **2026-09-23, operator** (session `claude:0731a975`): "I want to pivot Junto
  to be a multi agent workspace not necessarily a factory".
- **2026-10-07, operator** (session `claude:1e9aaf68`): "remote station, delete
  as whatever, I don't care. I would rather rebuild it from scratch over this
  new reality than suffer through maintaining or migrating stupidity."
- **2026-10-07, brief** (`docs/canvas-document-removal-brief.md:18-19`): "The
  remote station protocol is not a constraint. It will be rebuilt later on the
  real model."

## 9. Docs and tests

**Docs** *(audit, with the code side checked for the first two)*.

- `AGENTS.md:104` says the October migration dropped the station projection
  tables. It did not: the step removes only the five canvas tables
  (`src/main/junto/state/migrations.ts:377`), and
  `src/main/junto/station/state-schema.ts:86` and `:123` still declare them.
- `AGENTS.md:76-77` says the schema version is 1. It is 13
  (`src/main/junto/state/migrations.ts:235`).
- `AGENTS.md:253` says a Remote applies projections. It cannot.
- `AGENTS.md:262` lists `overseer` as a peer verb; `src/shared/station-mode.ts:23`
  does not.
- Six operations in three documents, five in seven others.
- `docs/macos-remote-e2e.md:14` says Darwin managed deploy is enabled in the
  ship profile. It is false in every build.
- `docs/junto-protocol.md` is the canonical contract, 2,282 lines, header dated
  07-28, and describes canvas storage two generations old.
- Wholly stale: `junto-protocol.md`, `fleet-station-architecture.md`,
  `remote-station-checklist.md`, `fleet-observability.md`, `macos-remote-e2e.md`,
  `linux-orbstack-two-station-runner.md`, `linux-beta-contract.md`,
  `linux-package-qualification.md`, `linux-release-changelog-template.md`.
  Partly stale: `AGENTS.md`, `security-doctrine.md`, `state-architecture.md`,
  `architecture-factory-physics.md`, `overseer-coverage-matrix.md`, four mixed
  Linux documents, `SECURITY.md`. `CHANGELOG.md` is silent on the 10-07
  switch-off.

**Tests** *(audit)*.

- 123 files, 34,455 lines, 912 cases. Another 30 or so tests of local features,
  the e2e sandbox and the terminal harness compose station layers.
- About thirty tests assert on source text and will fail on any prune. First to
  break: `features-fleet-gate`, `junto-remote-closure`,
  `remote-station-release-gate`, `ssh-architecture`, `startup-architecture`.
- Several host and Box tests reach their code only by mocking the release
  capabilities to true, a state no build has.
- Fixtures: a hand-kept protocol 1 golden corpus that the code already partly
  rejects; `remote-v1.db`; two orphaned database fixtures whose tests are gone;
  and two frozen copies of the old document types (1,393 and 937 lines).
- Independent of the document model, and worth keeping through a rebuild: the
  session, control stream, OpenSSH exchange, door and mode tests; the SSH
  kernel tests; the supervision tests; the Darwin deploy harness.

## 10. Prune map

An accounting of what the evidence supports, not a plan. Sizes are approximate.

| Bin | What is in it | Size |
|---|---|---|
| **A. Load-bearing in ship. Must survive.** | installation identity and `station_configuration`; the default Command Center path; the seat id derivation; the station tables that live foreign keys reference; the `local` host and host registry; status facts and doctor; desktop self-update; launchd observe | about 9,000 |
| **B. Host layer. Ran once, fits the product.** | the remote terminal route and its client and server; the SSH plane; host IPC, link test and one host picker; the Darwin deployer and host runtime; `host` on seats and terminals; per-host region paths | about 17,000 |
| **C. Factory replication. Nothing can feed it.** | projection compile, archive and install; the four frozen document files; work admission in `station/api.ts`; multi-home convergence in the work repository; the report pump; protocol negotiation, compatibility and qualification; the Remote overseer transport; the compatibility, sync and topology panels | about 12,000 |
| **D. Never reached a working state, or dead.** | Linux Remote deploy, trust and release bundle; the two-station runner and smoke scripts; the Node Remote entry and its systemd service; Box; the fleet update executor; the qualification CLI; `station-package-compatibility.ts` | about 17,000 |

The Station session transport and its fleet supervisor (about 4,600 lines in
six stacked pieces *(audit)*, with two implementations of request correlation
and a third mini-client for bootstrap) sit between B and C. Whether they are
kept depends on the first question below.

Nine documents and most of the 123 test files follow bins C and D.

## 11. Questions that set the prune line

1. **Does a Remote need any authority of its own?** If a remote seat's `junto`
   calls may fail while the Command Center is closed, the Command Center can
   stay the single store, and all of bin C has no reason to return. If they must
   succeed, some replication does, and it has to be designed for mail and
   signals, not tasks.
2. **Must a remote seat's process survive Command Center quit?** This is the one
   stated goal that still applies (`AGENTS.md:384-387`). It is what requires a
   supervised Junto on the target instead of a plain SSH terminal.
3. **Mac to Mac first, or Linux too?** The Linux Remote is most of bin D and has
   no recorded working run.
4. **Is Box in scope at all?**

## 12. Not verified

- Nothing was built or run. The enrollment door mismatch, the readiness wait and
  every "would fail" above are readings of the code.
- Bundle membership for ship is inferred from imports, not from a ship build.
- Session quotes are what the session recorded, read through search.
- Churn figures, test counts and the per-document ledger are from the audits. I
  checked the commit total, a path count, the skips and four document claims.
- Not read in full: `term/local-host.ts`, most of `station/api.ts` between
  lines 520 and 1830, the Linux release scripts, the Fleet panels.
- Other branches were not audited.
