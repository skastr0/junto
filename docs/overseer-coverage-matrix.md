# Overseer command acceptance matrix

Status: inventory of the frozen 97-op contract against integrated handlers
and owning suites. Native/composition lifecycle fixes and cross-canvas
artifact publisher-home routing are integrated. Coverage below distinguishes
executed behavior from catalog coverage; it does not claim every operation
has an end-to-end test.

Coverage column:

- `exercised` — a focused overseer suite invokes that operation.
  Does not mean the full repository suite is green.
- `catalog` — operation is in `OVERSEER_OPERATION_NAMES`, has a
  handler, and is covered by schema/CLI catalog tests only.

Parent-owned admission remains `tests/overseer-admission.test.ts`
plus outer socket `tests/work-control-transport.test.ts` and
`tests/main-authoring-gate.test.ts`. Do not duplicate those.

## Envelope

| item | contract |
| --- | --- |
| Outer Work op | `overseer` |
| Args | `OverseerRequest` `{operation, args?}` |
| Inner result | `OverseerResult` `{ok:true,operation,data}` or `{ok:false,operation,error}` |
| Transport success | `workOk('overseer', OverseerResult)` |
| Auth/bind/transport failure | outer Work error |
| CLI | unwrap inner result; nonzero exit on inner error |
| Admission seam | `onOverseer(args, {canvasName, nodeId}, AbortSignal)` after live process-bind and grant, before pause/blocked ordinary dispatch |
| Caller | admitting transport supplies `OverseerCaller`; never taken from args |
| Catalog | `OVERSEER_READ_ONLY_OPERATIONS` is the read set; `page.eval` is a mutation |
| Human toggle | `canvasOverseerSet` trusted renderer; not an `OverseerOperation` |
| Offline CLI | `schema` / `examples` / `skill` are not wire operations |
| Per-op args | `OverseerArgsSchemas[operation]` in the shared contract; unknown/excess fields fail |

## Authorization (every wire op)

Process-bind to a managed agent seat with live `ether.overseer`. Pause and
blocked do not deny administration. Ordinary agents stay edge-scoped
(`ScopeError` without a matching edge and port). Remote occupants send closed
Station `overseer` on the existing Command Center-opened duplex session;
Command Center validates the live grant and authenticated source installation
and performs authoring. Remotes do not author projection. Attribution stays
the real agent seat, never `OPERATOR_SEAT_ID`. Live grant is rechecked at
commit. Timeout or disconnect is uncertain completion with no automatic
replay.

## Owning suites

| plane | files |
| --- | --- |
| Contract / CLI catalog | `tests/overseer-control.test.ts`, `tests/overseer-cli.test.ts` |
| Admission / socket / gate | `tests/overseer-admission.test.ts`, `tests/work-socket-overseer.test.ts`, `tests/work-control-transport.test.ts`, `tests/main-authoring-gate.test.ts` |
| Dispatch | `tests/overseer-dispatch.test.ts` |
| Canvas / node / edge / sheet | `tests/overseer-canvas-commands.test.ts`, `tests/overseer-authoring.test.ts` |
| Work | `tests/overseer-work.test.ts` |
| Native | `tests/overseer-native.test.ts` |
| Composition | `tests/overseer-composition.test.ts`, `tests/overseer-composition-lifecycle.test.ts` |
| Station transport | `tests/station-overseer-transport.test.ts` |
| Human toggle / identity | `e2e/scenarios/overseer-acceptance.spec.ts`, `e2e/scenarios/overseer-seat.spec.ts`, `tests/overseer-set.test.ts`, `tests/overseer-toggle.test.tsx`, `tests/overseer-mark.test.tsx` |
| Stale save / grant strip | `tests/authorial-canvas-merge.test.ts`, `tests/canvas-save-durability.test.ts` |

## Wire operations (97)

| operation | catalog | owning service | coverage | suite |
| --- | --- | --- | --- | --- |
| `status` | read | main `executeOverseer` | catalog | tests/overseer-cli.test.ts; tests/overseer-control.test.ts |
| `canvas.list` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts; tests/overseer-dispatch.test.ts |
| `canvas.read` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `canvas.create` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts; tests/overseer-dispatch.test.ts |
| `canvas.delete` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `canvas.digest` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `canvas.render` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `canvas.screenshot` | mutation | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts; tests/overseer-dispatch.test.ts; honest PNG or RuntimeDown; Electron viewport not this op |
| `node.list` | read | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `node.get` | read | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `node.create` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts; tests/overseer-dispatch.test.ts |
| `node.configure` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `node.move` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `node.resize` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `node.delete` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts; tests/overseer-dispatch.test.ts |
| `edge.list` | read | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `edge.get` | read | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `edge.verbs` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `edge.connect` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `edge.configure` | mutation | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `edge.disconnect` | mutation | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `tasks.list` | read | work `executeOverseerWork` | exercised | tests/overseer-work.test.ts |
| `tasks.create` | mutation | work `executeOverseerWork` | exercised | tests/overseer-work.test.ts |
| `tasks.claim` | mutation | work `executeOverseerWork` | exercised | tests/overseer-work.test.ts |
| `tasks.describe` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `tasks.update` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `tasks.show` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `tasks.rules` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `tasks.check` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `tasks.promote` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `tasks.comment` | mutation | work `executeOverseerWork` | exercised | tests/overseer-work.test.ts |
| `tasks.respond` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `request.list` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `request.get` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `request.create` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `request.resolve` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `request.comment` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `artifact.list` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `artifact.get` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `artifact.publish` | mutation | work `executeOverseerWork` | exercised | tests/overseer-work.test.ts; tests/station-offline-work-roundtrip.test.ts; cross-canvas original publisher, publisher-home queue, correlated import after revoke |
| `artifact.archive` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `artifact.delete` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `msg.list` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `msg.send` | mutation | work `executeOverseerWork` | exercised | tests/overseer-work.test.ts |
| `msg.read` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `msg.reply` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `msg.react` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `board.list` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `board.create-topic` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `board.post` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `board.mark-read` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `board.tags` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `board.notify` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `pad.read` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `pad.patch` | mutation | work `executeOverseerWork` | exercised | tests/overseer-work.test.ts |
| `pad.digest` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `pad.render` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `pad.look-here` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `pad.get` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `pad.tagged` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `sheet.read` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `sheet.configure` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `content.ingest` | mutation | work `executeOverseerWork` | exercised | tests/overseer-work.test.ts; tests/overseer-dispatch.test.ts; local ingest exercised; Remote page/content stay on caller installation in dispatch |
| `content.path` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `content.stat` | read | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `content.materialize` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `agent.list` | read | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts |
| `agent.get` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `agent.reseat` | mutation | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts |
| `agent.start` | mutation | native `makeOverseerNativeLive` | exercised | tests/overseer-native.test.ts; target-host occupancy, cancellation and finalizer drain |
| `agent.wake` | mutation | native `makeOverseerNativeLive` | exercised | tests/overseer-native.test.ts; occupied-seat activation retains target host |
| `agent.prompt` | mutation | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts |
| `agent.output` | read | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts |
| `agent.interrupt` | mutation | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts |
| `agent.stop` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `terminal.list` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `terminal.get` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `terminal.start` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `terminal.input` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `terminal.output` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `terminal.resize` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `terminal.interrupt` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `terminal.stop` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `page.list` | read | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts; tests/overseer-dispatch.test.ts |
| `page.get` | read | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts |
| `page.open` | mutation | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts |
| `page.goto` | mutation | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts |
| `page.eval` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `page.screenshot` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `page.close` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `page.stop` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `scheduler.fire` | mutation | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `scheduler.status` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `scheduler.configure` | mutation | native `makeOverseerNative` | exercised | tests/overseer-native.test.ts; refuses silent write without canvas hook |
| `git.status` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `git.log` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `git.show` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |

## Human toggle (not a wire operation)

| action | schema | owning service | authorization | result | coverage |
| --- | --- | --- | --- | --- | --- |
| Grant or revoke overseer on a managed agent seat | `canvasOverseerSet({canvasName, nodeId, overseer, expectedRevision})` | canvases `canvasOverseerSet` under `runMainAuthoring("ipc.canvas.overseer-set")` | trusted renderer only; Command Center authorial; managed executable seat; aliases share one binding; copies do not inherit; agent commands and ordinary saves cannot mint | `{binding, overseer, affected}` | exercised: parent ran `e2e/scenarios/overseer-acceptance.spec.ts` (grant persisted, ordinary seat ungranted, viewport transform unchanged). Unit: `tests/overseer-set.test.ts`. Identity chrome: `e2e/scenarios/overseer-seat.spec.ts` (not a persistence proof). |

## Key risks

| risk | required proof | suite | status |
| --- | --- | --- | --- |
| Stale UI save/undo restoring revoked authority | delayed save, external reload, undo/redo cannot mint or restore `ether.overseer` | `tests/authorial-canvas-merge.test.ts`; `tests/canvas-save-durability.test.ts` ordinary save cannot mint/revoke | unit exercised; no undo/redo Electron proof |
| No-edge ordinary vs overseer distinction | overseer with zero edges exercises enabled families; ordinary agent without edges is `ScopeError` | `tests/overseer-work.test.ts`; `tests/overseer-native.test.ts`; `tests/overseer-admission.test.ts`; e2e grants without edges | unit exercised; integrated Work suite passes |
| Toggle copied aliases | copy/reseat/replace clears grant; aliases of the same binding toggle together | `tests/overseer-authoring.test.ts`; `tests/overseer-canvas-commands.test.ts` `canvasOverseerSet` alias toggle | unit exercised |
| Self-retirement via canvas delete/kind/binding | refuse own-seat delete, canvas delete that would retire the seat, kind/binding replacement that retires identity | `tests/overseer-canvas-commands.test.ts`; `tests/overseer-authoring.test.ts`; `tests/overseer-dispatch.test.ts` | unit exercised |
| Remote source impersonation | Command Center compares `deriveActorSeatId(authenticatedSourceInstallation, binding)` to compiled seatId; forged caller args ignored | `tests/overseer-admission.test.ts`; `tests/overseer-dispatch.test.ts`; `tests/station-overseer-transport.test.ts` | unit exercised |
| Uncertain completion, no automatic replay | timeout/disconnect reports uncertain completion and never replays mutations | `tests/station-overseer-transport.test.ts`; `tests/work-socket-overseer.test.ts` | unit exercised |
| Viewport invariance | overseer reads, writes, digest, render, screenshot never pan, zoom, focus, resize, or switch the operator view | parent-run `e2e/scenarios/overseer-acceptance.spec.ts` for human toggle; `tests/overseer-canvas-commands.test.ts` document reads; native capture still pending | Electron toggle exercised; screenshot/native capture not proven |

## Verification limits

- Cross-canvas `artifact.publish` retains publisher-home residency and the
  original ActorRef. Station tests exercise valid commands, wrong routes,
  revoked grants, and exact response import after revocation.
- Native lease release, occupy cleanup, and canvas hook cleanup are awaited
  on interruption. Composition grant checks retain immutable caller-source
  identity. Tests exercise a successful cross-canvas reseat, not just refusal.
- Catalog-only operations have handlers, not focused invocation tests.
- Full repository suite is not claimed green.
- Native Remote deletion retains the existing exact-teardown refusal in
  `TerminalRouter.deleteBinding`; it never reports an unproven stop as deletion.

## Explicit non-coverage

- Operator socket remains agent-denied.
- No fleet enrollment, credentials, or Command Center transfer.
- No arbitrary RPC tunnel and no Remote-initiated new dial.
- Ordinary edge-scoped work ops are unchanged.
- Parent `tests/overseer-admission.test.ts` owns `resolveOverseerActor` and watcher.
