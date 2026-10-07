# Overseer command acceptance matrix

Status: inventory of the 113-op contract against integrated handlers
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
| Human toggle | `GrantOverseer` through trusted renderer `modelCommand`; not an `OverseerOperation` |
| Offline CLI | `schema` / `examples` / `skill` are not wire operations |
| Per-op args | `OverseerArgsSchemas[operation]` in the shared contract; unknown/excess fields fail |

## Authorization (every wire op)

Process-bind to a managed agent seat whose `overseer` flag is on. Pause and
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
| Canvas / node / wire | `tests/overseer-canvas-commands.test.ts` |
| Work | `tests/overseer-work.test.ts` |
| Operator offboard | `tests/overseer-offboard.test.ts`, `tests/overseer-dispatch.test.ts`, `tests/overseer-cli.test.ts` |
| Region environment / secrets | `tests/overseer-env-secret.test.ts`, `tests/overseer-canvas-commands.test.ts`, `tests/overseer-dispatch.test.ts`, `tests/overseer-cli.test.ts` |
| Native | `tests/overseer-native.test.ts` |
| Composition | `tests/overseer-composition.test.ts`, `tests/overseer-composition-lifecycle.test.ts` |
| Station transport | `tests/station-overseer-transport.test.ts` |
| Human toggle / identity | `e2e/scenarios/overseer-acceptance.spec.ts`, `e2e/scenarios/overseer-seat.spec.ts`, `tests/overseer-set.test.ts`, `tests/overseer-toggle.test.tsx`, `tests/overseer-mark.test.tsx` |
| Canvas edits / grant isolation | `tests/canvas-edit-commands.test.ts`, `tests/overseer-set.test.ts` |

## Wire operations (120)

| operation | catalog | owning service | coverage | suite |
| --- | --- | --- | --- | --- |
| `status` | read | main `executeOverseer` | catalog | tests/overseer-cli.test.ts; tests/overseer-control.test.ts |
| `canvas.list` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts; tests/overseer-dispatch.test.ts |
| `canvas.read` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `canvas.create` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts; tests/overseer-dispatch.test.ts |
| `canvas.batch` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts; tests/overseer-control.test.ts; one validated single-canvas commit |
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
| `node.recolor` | mutation | canvas `executeOverseerCanvas` | catalog | contract tests/overseer-control.test.ts; handler lands with the model-kinds main change |
| `node.delete` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts; tests/overseer-dispatch.test.ts |
| `wire.list` | read | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `wire.get` | read | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `wire.verbs` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `wire.connect` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-canvas-commands.test.ts |
| `wire.configure` | mutation | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `wire.disconnect` | mutation | canvas `executeOverseerCanvas` | catalog | handler `overseer/canvas.ts`; catalog tests/overseer-control.test.ts |
| `tasks.list` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.create` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.claim` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.describe` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.update` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.show` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.rules` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.check` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.promote` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.comment` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `tasks.respond` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `request.list` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `request.get` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `request.create` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `request.resolve` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `request.comment` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `artifact.list` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `artifact.get` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `artifact.publish` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `artifact.archive` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `artifact.delete` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `msg.list` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `msg.send` | mutation | work `executeOverseerWork` | exercised | tests/overseer-work.test.ts |
| `msg.read` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `msg.reply` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `msg.react` | mutation | work `executeOverseerWork` | catalog | handler `overseer/work.ts`; catalog tests/overseer-control.test.ts |
| `board.list` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `board.create-topic` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `board.post` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `board.mark-read` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `board.tags` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `board.notify` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `pad.read` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `pad.patch` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `pad.digest` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `pad.render` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `pad.look-here` | mutation | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `pad.get` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `pad.tagged` | read | work `executeOverseerWork` | retired | handler `overseer/work.ts`; retired surface, suite removed |
| `sheet.read` | read | canvas `executeOverseerCanvas` | retired | handler `overseer/canvas.ts`; retired surface, suite removed |
| `sheet.configure` | mutation | canvas `executeOverseerCanvas` | retired | handler `overseer/canvas.ts`; retired surface, suite removed |
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
| `scheduler.fire` | mutation | native `makeOverseerNative` | retired | handler `overseer/native.ts`; retired surface, suite removed |
| `scheduler.status` | read | native `makeOverseerNative` | retired | handler `overseer/native.ts`; retired surface, suite removed |
| `scheduler.configure` | mutation | native `makeOverseerNative` | retired | handler `overseer/native.ts`; retired surface, suite removed |
| `git.status` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `git.log` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `git.show` | read | native `makeOverseerNative` | catalog | handler `overseer/native.ts`; catalog tests/overseer-control.test.ts |
| `env.show` | read | canvas `executeOverseerCanvas` | exercised | tests/overseer-env-secret.test.ts; tests/overseer-canvas-commands.test.ts |
| `env.source-add` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-env-secret.test.ts; tests/overseer-canvas-commands.test.ts; tests/overseer-cli.test.ts |
| `env.source-edit` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-env-secret.test.ts; tests/overseer-canvas-commands.test.ts |
| `env.source-remove` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-env-secret.test.ts; tests/overseer-canvas-commands.test.ts |
| `env.source-reorder` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-env-secret.test.ts; tests/overseer-canvas-commands.test.ts |
| `env.seal` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-env-secret.test.ts; tests/overseer-canvas-commands.test.ts; tests/overseer-dispatch.test.ts |
| `env.folders` | mutation | canvas `executeOverseerCanvas` | exercised | tests/overseer-env-secret.test.ts; tests/overseer-canvas-commands.test.ts |
| `env.doctor` | read | main `executeOverseer` over the resolver seam | exercised | tests/overseer-dispatch.test.ts; tests/overseer-cli.test.ts; fake resolver only |
| `secret.put` | mutation | main `executeOverseerSecret` over the store seam | exercised | tests/overseer-env-secret.test.ts; tests/overseer-dispatch.test.ts; tests/overseer-cli.test.ts; fake store only |
| `secret.delete` | mutation | main `executeOverseerSecret` over the store seam | exercised | tests/overseer-env-secret.test.ts; tests/overseer-dispatch.test.ts; fake store only |
| `secret.list` | read | main `executeOverseerSecret` over the store seam | exercised | tests/overseer-env-secret.test.ts; tests/overseer-dispatch.test.ts; fake store only |
| `agent.offboard` | mutation | main `executeOverseerOffboard` over the offboard seam | exercised | tests/overseer-offboard.test.ts; tests/overseer-dispatch.test.ts; tests/overseer-cli.test.ts; fake entry point only |
| `agent.offboard-status` | read | main `executeOverseerOffboard` over the offboard seam | exercised | tests/overseer-offboard.test.ts; tests/overseer-dispatch.test.ts; fake entry point only |
| `agent.offboard-rules` | read | main `executeOverseerOffboard` over the offboard seam | exercised | tests/overseer-offboard.test.ts; tests/overseer-dispatch.test.ts; fake entry point only |
| `agent.offboard-configure` | mutation | main `executeOverseerOffboard` over the offboard seam | exercised | tests/overseer-offboard.test.ts; tests/overseer-dispatch.test.ts; fake entry point only |
| `references.list` | read | main `executeOverseerReferences` over the references store | exercised | tests/overseer-references.test.ts; tests/overseer-cli.test.ts |
| `references.read` | read | main `executeOverseerReferences` over the references store | exercised | tests/overseer-references.test.ts; tests/overseer-cli.test.ts |
| `references.write` | mutation | main `executeOverseerReferences` over the references store | exercised | tests/overseer-references.test.ts; tests/overseer-cli.test.ts |
| `references.delete` | mutation | main `executeOverseerReferences` over the references store | exercised | tests/overseer-references.test.ts; tests/overseer-cli.test.ts |
| `briefing.read` | read | main `executeOverseerReferences` over the references store | exercised | tests/overseer-references.test.ts; tests/overseer-cli.test.ts |
| `briefing.write` | mutation | main `executeOverseerReferences` over the references store | exercised | tests/overseer-references.test.ts; tests/overseer-cli.test.ts |

## Canvas reads and overseer seats

| item | contract |
| --- | --- |
| Vocabulary | the wire carries the model's own types from `src/shared/model`: a node told by `kind` with that kind's flat fields, a wire by `from`, `to`, `verb`; args schemas in `src/shared/overseer-control.ts` are built from the model's exported schemas (`NodeDraft`, `SeatDraft`, `NodeEdit`, `WireDraft`, `WireEdit`, `Seq`) |
| `canvas.read` | `{name, seq, nodes, wires}`, nodes in paint order; `seq` is a number |
| `canvas.read`, `node.list`, `node.get`, `wire.list`, `wire.get` | structure only; no tasks, requests, artifacts, mail or board topics ride on a node; work is read with its own command |
| `node.create`, `wire.connect` | a draft: `id` optional and minted by main, no `z`; the answer carries the node or wire with its id |
| Seats | created and reseated by naming what they run: `harness` required, `profile`, `model`, `effort`, `mode`, `permissionMode`, `host` optional (and `cwd`, `label`, `onRemove` on create); main builds the launch, agent key and session; a seat draft carrying `launch`, `agentKey`, `bindingId`, `sessionId` or `overseer` is `InvalidArguments`; a terminal draft keeps `launch` |
| `node.configure`, `scheduler.configure` | `change` is the model edit for the node's kind; a kind that is not the node's is `InvalidArguments` naming the actual kind |
| `node.recolor`, `node.delete` | take `nodeIds`, one or many |
| `canvas.batch` | `{canvas?, expectedSeq?, steps}`; a canvas that moved since `expectedSeq` is `Conflict` |
| Retired names | the six `edge.*` operations are `wire.*`; no alias and no old shape is accepted; the CLI answers an `edge` invocation in one line naming `wire`; a stored receipt of an old name still reads, since `overseer_live_operations.operation` is text |
| `canvas.list` | one `{name}` per canvas, nothing else |
| `canvas.digest` | the model digest main also writes for the window and the canvas CLI (`readModelDigest`), read without adapter snapshot data |
| `canvas.render` | an SVG of the canvas, with task rows marked on their boards |
| Writes | one transaction: a batch all lands or none of it does |
| Overseer seats | an overseer may rename, move, resize and recolor an overseer seat, its own included; changing what it runs (agent, session, harness, host, launch), removing it or reseating it is refused by the model as `Forbidden`: "Only the operator can change what an overseer seat runs or remove it." |

## Human toggle (not a wire operation)

| action | schema | owning service | authorization | result | coverage |
| --- | --- | --- | --- | --- | --- |
| Grant or revoke overseer on a managed agent seat | `{_tag: "GrantOverseer", canvas, id, overseer}` | ModelService under `runMainAuthoring("ipc.model.command")` | trusted renderer only; Command Center authorial; managed executable seat; aliases share one binding; copies do not inherit; agent commands and ordinary saves cannot mint | `{seq}` | exercised: parent ran `e2e/scenarios/overseer-acceptance.spec.ts` (grant persisted, ordinary seat ungranted, viewport transform unchanged). Unit: `tests/overseer-set.test.ts`. Identity chrome: `e2e/scenarios/overseer-seat.spec.ts` (not a persistence proof). |
## Operator offboard

| item | contract |
| --- | --- |
| Shapes | all from `src/shared/seat-offboard.ts`; nothing is redeclared |
| `agent.offboard` | one call to main's entry point as `"overseer"` for the whole list (1 to 200 seats); `ask` by default, `mode` only with `ask`; the result is `SeatOffboardRunResult` unchanged |
| Refused seats | rows, not errors: an unknown node, a node that is not a seat, a seat that cannot be ended now; the caller's own seat is passed through like any other |
| Exit rule | the CLI prints the result whole and exits non-zero when `refused` is above zero |
| `agent.offboard-status` | `SeatOffboardStatus[]` unchanged |
| Rules | `agent.offboard-rules` answers `{rules, effective}`; `agent.offboard-configure` takes `OffboardRulesPatch`, main applies, checks and saves it, and a refused change is `InvalidArguments` with main's message unchanged |
| One entry point | `src/main/junto/overseer/offboard-seam.ts`; the handler adds no idle test, no ask wording, no rows and no retry |

The seam is bound to main's `runSeatOffboard`, `seatOffboardStatus`,
`readOffboardRules` and `patchOffboardRules`. Tests replace it with a fake
entry point, and one test drives the real operation module over fake ports.

## Region environment and secrets

| item | contract |
| --- | --- |
| Environment edits | an `Edit` of one region's `environment`, sent as `node.configure` under its grant and stale-`seq` rules; a node that is not a region is refused |
| Source shape | the canvas document's own `EnvSource`; `env.source-add` and `env.source-edit` derive an input where `id` may be omitted |
| `env.doctor` | the resolver's `RegionEnvironmentReport`, unchanged, narrowed by `nodeId`; CLI exits non-zero when a `required` source is `missing` or `error` and still prints the report |
| `secret.put` | value enters by stdin only at the CLI; a `value` key in the argument, a terminal on stdin, or an empty value is an `InputError`; exactly one trailing newline is stripped |
| No echo | `decodeOverseerArgs` answers a fixed sentence for `secret.put`; the CLI omits `received` for it; results carry ids and the store name only |
| Locality | `secret.*` runs on the caller's installation and is never forwarded |
| `junto env report` | ordinary command; a seat reads its own `SeatEnvironmentReport` from work op `env.report`; same exit rule |

## Briefing and references

| item | contract |
| --- | --- |
| Store | `app_texts` in `junto.db`: one briefing, app-wide references, and a region's references keyed by canvas name and region node id as plain values |
| Place | no `regionId` is the app-wide references; with one, that region's on `canvas` or the overseer's own canvas; `canvas` without `regionId` is refused; a region that is not on the canvas is `NotFound` |
| Body | `references write` and `briefing write` take the body from `--body <text or @file or ->`, or as `body` in the argument; given twice, or empty, is an `InputError` at the CLI |
| Author | a write records `overseer:<node id>`; the operator's own writes record `operator` |
| Name | lower-cased; 1 to 80 characters of letters, digits, dot, underscore and dash; no bound on description or body beyond the 1 MiB overseer request |
| Residency | forwarded to Command Center from a Remote like other authoring |
| `junto references list` and `read` | ordinary commands; a seat reads its own scope from work ops `references.list` and `references.read` |

Product bindings sit behind one import each:
`src/main/junto/overseer/secret-store-seam.ts` (the platform secret store) and
`src/main/junto/overseer/env-report-seam.ts` (the resolver). Tests replace
both with a fake store and a fake resolver. No test reads the platform
Keychain, the keyring, or the operator's home.

## Key risks

| risk | required proof | suite | status |
| --- | --- | --- | --- |
| Stale UI save/undo restoring revoked authority | the window saves no document; edits and undo/redo never emit `GrantOverseer`, and undo restores removed seats without their grant; the operator toggle sends a dedicated command | `tests/canvas-edit-commands.test.ts`; `tests/model-undo.test.ts`; `tests/overseer-set.test.ts` | unit exercised; no undo/redo Electron proof |
| No-edge ordinary vs overseer distinction | overseer with zero edges exercises enabled families; ordinary agent without edges is `ScopeError` | `tests/overseer-work.test.ts`; `tests/overseer-native.test.ts`; `tests/overseer-admission.test.ts`; e2e grants without edges | unit exercised; integrated Work suite passes |
| Toggle copied aliases | copy/reseat/replace clears grant; aliases of the same binding toggle together | `src/shared/model/model.test.ts` (an edit cannot grant); `tests/model-factories.test.ts` (a new seat is never an overseer); `tests/model-service.test.ts` `GrantOverseer` alias toggle | unit exercised |
| Self-retirement via canvas delete/kind/binding | refuse own-seat delete, canvas delete that would retire the seat, kind/binding replacement that retires identity | `tests/overseer-canvas-commands.test.ts`; `tests/overseer-dispatch.test.ts` | unit exercised |
| Remote source impersonation | Command Center compares `deriveActorSeatId(authenticatedSourceInstallation, binding)` to compiled seatId; forged caller args ignored | `tests/overseer-admission.test.ts`; `tests/overseer-dispatch.test.ts`; `tests/station-overseer-transport.test.ts` | unit exercised |
| Uncertain completion, no automatic replay | timeout/disconnect reports uncertain completion and never replays mutations | `tests/station-overseer-transport.test.ts`; `tests/work-socket-overseer.test.ts` | unit exercised |
| Secret value echoed back | a value given to `secret.put` never appears in a result, an error, a schema failure, or CLI output | `tests/overseer-env-secret.test.ts`; `tests/overseer-dispatch.test.ts`; `tests/overseer-cli.test.ts` | unit and spawned-CLI exercised with a fake store |
| Viewport invariance | overseer reads, writes, digest, render, screenshot never pan, zoom, focus, resize, or switch the operator view | parent-run `e2e/scenarios/overseer-acceptance.spec.ts` for human toggle; `tests/overseer-canvas-commands.test.ts` document reads; native capture still pending | Electron toggle exercised; screenshot/native capture not proven |

## Verification limits

- Native lease release, occupy cleanup, and canvas hook cleanup are awaited
  on interruption. Composition grant checks retain immutable caller-source
  identity. Tests exercise a successful cross-canvas reseat, not just refusal.
- Catalog-only operations have handlers, not focused invocation tests.
- Retired operations (tasks, request, artifact, board, pad, sheet, scheduler)
  keep their switched-off handlers and have no suite.
- Full repository suite is not claimed green.
- Native Remote deletion retains the existing exact-teardown refusal in
  `TerminalRouter.deleteBinding`; it never reports an unproven stop as deletion.

## Explicit non-coverage

- Operator socket remains agent-denied.
- No fleet enrollment, credentials, or Command Center transfer.
- No arbitrary RPC tunnel and no Remote-initiated new dial.
- Ordinary edge-scoped work ops are unchanged.
- Parent `tests/overseer-admission.test.ts` owns `resolveOverseerActor` and watcher.
