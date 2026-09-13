# Overseer implementation plan

Status: grounded design. The three authority decisions below are settled by
the operator. This document does not describe shipped functionality.

## Product contract

An overseer is an existing agent seat with explicitly delegated administrative
authority and a distinctive appearance, not another actor kind. Its
process-bound occupant can author the canvas and operate every supported node
API without requiring connecting edges. Ordinary agents retain their current
edge-scoped capabilities.

The two requested limits are enforced by main, not merely CLI advice:

- An overseer cannot delete its own seat, including indirect removal through a
  canvas deletion or replacement of the seat's identity.
- Overseer operations never pan, zoom, focus, resize, or switch the operator's
  canvas view. Screenshots observe; they do not reposition it.

The new user instruction supersedes the blanket prohibition on agent canvas
authorship for overseers only. Update the governing documentation alongside
implementation. Database ownership, machine safety, truthful attribution,
resource ownership, and legal graph physics remain intact.

## Settled authority decisions

The operator settled these. Older recommendations in this file do not override
them.

1. **Execution placement.** Overseers may occupy Command Center or Remote.
   Remotes do not author projection. Command Center validates the live grant
   and authenticated source installation and performs authoring. Closed
   Station `overseer` uses the existing Command Center-opened duplex session.
   Protocol remains prerelease 1. No arbitrary RPC tunnel, no Remote-initiated
   new dial, no operator impersonation.
2. **Delegation.** Only humans grant or revoke. Overseers cannot propagate
   overseer authority. Copied aliases do not inherit the grant. A new binding
   created by reseating does not inherit automatically.
3. **Pause.** Factory pause and play have no bearing on overseer
   administration. Pause applies to automated factory execution only. Turning
   off overseer authority revokes administration.

Operator equivalence covers canvas, nodes, and work, including already-enrolled
hosts. Factory identity transfer, enrollment, package administration, and
credentials remain separate operator facilities. The agent does not gain the
operator socket. An overseer cannot delete its own seat or move the operator
viewport.

Command inventory and tests: [`overseer-coverage-matrix.md`](overseer-coverage-matrix.md).

## Evidence and required corrections

### Concurrent structural authorship is currently unsafe

`src/renderer/lib/mutations.ts`, `rebaseLocalOverDisk`, reads the latest document
after a revision conflict, merges the stale local snapshot over it, and saves
at the new revision. `src/shared/work-canvas-merge.ts`,
`mergeLocalCanvasWithWorkWrite`, explicitly retains local node membership and
all local edges. This can erase overseer-created nodes, restore deleted nodes,
and restore stale authority fields.

Replace automatic structural overwrite with a saved authorial base and a
three-way structural merge: merge disjoint changes and preserve the local draft
with a visible conflict for competing changes. Runtime work overlays remain a
separate concern. Cover delayed saves, external reloads, undo, and redo. Do not
change the operator's viewport during reconciliation.

### Main already owns the authorial transaction

`src/main/vellum-command/canvases.ts` exposes revision-checked `write` and
transactional `mutate`. The callback runs synchronously against current
authority. Extend the internal transaction seam to check caller delegation and
target changes against the same portfolio snapshot, including cross-canvas
targets. Neither CLI nor renderer opens the database.

The same file's `assertAuthorialInstallation` rejects Remote authoring.
`docs/security-doctrine.md`, Command Center-to-Station protocol, prohibits an
agent tunnel or generic RPC capability inside the five Station verbs. Remote
overseers therefore require the explicit decision above.

### Authority is not attribution

Keep the existing work socket and process-bind path. Introduce a main-derived
administrative context, separate from initiating ActorRef and target/assignee.
Audit both work-control ingress and WorkService checks: bypassing an edge check
alone does not expose operator-only task views, transitions, pad ink/images,
notifications, request resolution, or artifact administration.

An overseer remains the author of its actions; it never becomes
`OPERATOR_SEAT_ID`. Ordinary operations and kernel task claiming do not gain
ambient reach. Do not widen all agents' kind-level ports or manufacture edges.

### Seat identity and native resources need coherent revocation

`src/main/vellum-command/station/actor-seat-compiler.ts` groups references by
installation and binding and rejects conflicting executable descriptors.
Delegation must agree across references to the same seat; do not infer it from
whichever reference happens to be found first.

Recheck live delegation before durable commits, queued commands, and native
effects after asynchronous boundaries. Invalidate queued operations and cached
browser grants when authority changes. Preserve process-generation, host,
profile, and target-binding checks.

Reuse `TerminalNodeDeleteService` and the existing chat/page teardown owners.
Main validates the complete removal plan, fences resources, performs teardown,
revalidates authority, commits, and releases fences. Native side effects cannot
be rolled back with SQLite; report partial failures honestly.

Self-preservation follows actual seat retirement, including aliases and binding
replacement. Region containment alone is not removal: current group deletion
does not implicitly delete every geometrically contained node. Ordinary self
move, rename, configuration, interrupt, and stop are not self-deletion.

## Command architecture

Use closed `overseer.*` operations over the existing work envelope and socket,
with shared schemas and typed dispatch. No arbitrary IPC forwarding, generic
method invocation, raw full-document replacement, caller-supplied principal, or
second credential/admission path.

The CLI is `vellum-command overseer`. Use canonical canvas/node references,
defaulting to the caller's canvas where unambiguous. Follow existing JSON,
stdin, and file-input conventions. Results distinguish applied mutations from
queued commands. Structural batches validate and commit atomically per canvas;
native effects expose their separate completion semantics.

| Family | Required surface |
| --- | --- |
| Discovery | status, capabilities, schema, examples, embedded skill |
| Canvas | list, read, create, batch, delete, digest, render, screenshot |
| Nodes | list, get, create, configure, move, resize, delete |
| Edges | list, get, legal verbs, connect, configure, disconnect |
| Tasks | create, list, claim, describe, transition, promote, comment, respond, full view, rules, checks |
| Requests | create, read/list, resolve, thread operations |
| Artifacts | publish, read/list, archive, delete, content access |
| Messages | mailbox and thread operations with real agent attribution |
| Boards | topics, posts, read state, tags, operator-equivalent notification |
| Pads | read, patch, render, operator-equivalent ink/image operations |
| Sheets | read and existing operator grid-authoring operations |
| Agents/terminals | configure, supported reseat, start/wake, prompt/input, inspect/output, interrupt/stop |
| Pages | configure, open, navigate, interact/evaluate, screenshot, close/stop |
| Schedulers | configure, status, fire, selected pause semantics |
| Other nodes | notes, labels, images, regions/defaults/rulings, existing Git APIs |
| Content | ingest, inspect, materialize through existing ContentService ownership |

Before dispatching implementation, expand this table into a command acceptance
matrix: operator action, exact schema, owning service, authorization, result,
and test. Every enabled operator node API needs a row. Unsupported operations
and feature-disabled APIs report explicit reasons; do not invent unsupported
task transitions or resurrect dormant features.

The embedded `overseer skill` works without a daemon. Its command inventory
comes from the dispatch schemas and includes authored workflows, addressing,
physics, error recovery, authority, and screenshots versus document rendering.
Onboarding and injected agent guidance advertise it when authority is enabled.

`renderCanvasSvg` is a document projection, not a live UI screenshot. Provide
separate commands for whole-document rendering and read-only capture of the
current app view. Capture must not alter the view or claim availability in a
runtime without capture support.

### Structural batch

`canvas.batch` is one closed Overseer mutation on one existing canvas. It accepts
1–100 `operations`: `node.create`, `node.configure`, `node.move`, `edge.connect`,
`edge.configure`, and `edge.disconnect`. Each step carries its own typed fields;
steps cannot select another canvas or invoke arbitrary Overseer operations.
Client-assigned IDs let later steps refer to newly created nodes and edges.

Main checks the live grant and optional `expectedRevision` against authoritative
state inside `CanvasesService.mutatePortfolio`. It validates the complete final
graph, including legal endpoint verbs and task/scheduler DAGs, and commits once.
A rejected step or graph leaves the whole canvas unchanged. Structural batches
preserve existing native identities and configuration, cannot grant authority,
and contain no resource deletion, native action, credential mutation, or document
replacement. Task creation and worker execution remain separate operations.

## Parallel implementation ownership

Freeze contracts first, then use disjoint ownership:

1. **Lead:** shared delegation/command schemas, admission and dispatch wiring,
   runtime/IPC registration, shutdown admission, governing documentation.
2. **Canvas:** shared pure node/edge authoring, main command service,
   transactional authorization, deletion orchestration, self-preservation.
3. **Work:** WorkService parity, authorization versus provenance, work adapters,
   operator-equivalent pad/task/request/artifact/board behavior.
4. **Native runtime:** browser grants/revocation, terminal/chat adapters,
   screenshot service, resource lifecycle integration.
5. **CLI:** commands, discovery, embedded skill, standalone packaging tests.
6. **Renderer:** toggle, distinctive card/session chrome, authorial conflict
   handling, external reload, undo/redo, shared-authoring integration.
7. **Verification:** independently owned acceptance tests and Electron E2E
   scenarios; test complete command coverage rather than only handler mocks.

The lead owns shared schema changes and registration files throughout. The
renderer worker owns renderer imports during extraction of pure authoring
logic; the canvas worker owns its new shared destination. Commit verified
stages locally; push, PR, deployment, and release remain separately authorized.

## Completion evidence

- Real managed process to CLI to socket to main to durable state to renderer:
  enable one overseer and keep one ordinary agent; exercise every enabled
  command family with no connecting edges on the overseer.
- Build and operate a mixed-node workflow, including tasks, content, legal
  edges, runtime operations, rendering/capture, and deletion.
- Exercise stale operator saves, disjoint/conflicting edits, external deletion,
  revocation, and undo/redo. No stale write may restore authority.
- Revoke during delayed work, native admission, and batches. Prove no new
  unauthorized effect lands after revocation at the relevant boundary.
- Test direct/indirect self-retirement and aliases, while allowing operations
  that do not retire the seat. Test illegal edges, semantic orientation,
  cycles, stale resource generations, teardown failure, and shutdown.
- Prove normal edge-scoped agents remain restricted, operator-control still
  rejects agent trees, and work attribution remains the real initiator.
- Assert unchanged viewport, zoom, focus, and selected canvas for background
  authoring, reads, and capture.
- Render and inspect dark/bright overseer identity, selection, pause, attention,
  and session states without hiding existing severity signals.
- Run repository lint/typecheck/test/build gates, dedicated Electron E2E/design
  audit, and packaged CLI/runtime checks. Qualify two installations if Remote
  overseers are selected. Report unavailable capabilities and failed checks.
