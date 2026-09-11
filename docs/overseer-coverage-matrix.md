# Overseer command acceptance matrix

Status: inventory against the frozen shared contract in
`src/shared/overseer-control.ts` (`OVERSEER_OPERATION_NAMES`,
`OVERSEER_READ_ONLY_OPERATIONS`, `OverseerArgsSchemas`). This file does not
claim handlers, CLI wiring, or runtime behavior are shipped.

Parent-owned admission coverage lives in `tests/overseer-admission.test.ts`
plus outer socket edits in `tests/work-control-transport.test.ts` and
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

## Wire operations (97)

| operation | catalog | owning service | test |
| --- | --- | --- | --- |
| `status` | read | main `executeOverseer` | inventory; handler pending peer |
| `canvas.list` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `canvas.read` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `canvas.create` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `canvas.delete` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `canvas.digest` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `canvas.render` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `canvas.screenshot` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `node.list` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `node.get` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `node.create` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `node.configure` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `node.move` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `node.resize` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `node.delete` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `edge.list` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `edge.get` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `edge.verbs` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `edge.connect` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `edge.configure` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `edge.disconnect` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `tasks.list` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.create` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.claim` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.describe` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.update` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.show` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.rules` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.check` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.promote` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.comment` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `tasks.respond` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `request.list` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `request.get` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `request.create` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `request.resolve` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `request.comment` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `artifact.list` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `artifact.get` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `artifact.publish` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `artifact.archive` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `artifact.delete` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `msg.list` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `msg.send` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `msg.read` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `msg.reply` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `msg.react` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `board.list` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `board.create-topic` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `board.post` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `board.mark-read` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `board.tags` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `board.notify` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `pad.read` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `pad.patch` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `pad.digest` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `pad.render` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `pad.look-here` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `pad.get` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `pad.tagged` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `sheet.read` | read | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `sheet.configure` | mutation | canvas `executeOverseerCanvas` | inventory; handler pending peer |
| `content.ingest` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `content.path` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `content.stat` | read | work `executeOverseerWork` | inventory; handler pending peer |
| `content.materialize` | mutation | work `executeOverseerWork` | inventory; handler pending peer |
| `agent.list` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `agent.get` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `agent.reseat` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `agent.start` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `agent.wake` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `agent.prompt` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `agent.output` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `agent.interrupt` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `agent.stop` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `terminal.list` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `terminal.get` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `terminal.start` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `terminal.input` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `terminal.output` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `terminal.resize` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `terminal.interrupt` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `terminal.stop` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `page.list` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `page.get` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `page.open` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `page.goto` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `page.eval` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `page.screenshot` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `page.close` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `page.stop` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `scheduler.fire` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `scheduler.status` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `scheduler.configure` | mutation | native `makeOverseerNative` | inventory; handler pending peer |
| `git.status` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `git.log` | read | native `makeOverseerNative` | inventory; handler pending peer |
| `git.show` | read | native `makeOverseerNative` | inventory; handler pending peer |

## Human toggle (not a wire operation)

| action | schema | owning service | authorization | result | test |
| --- | --- | --- | --- | --- | --- |
| Grant or revoke overseer on a managed agent seat | `canvasOverseerSet({canvasName, nodeId, overseer, expectedRevision})` | canvases `canvasOverseerSet` under `runMainAuthoring("ipc.canvas.overseer-set")` | trusted renderer only; Command Center authorial; managed executable seat; aliases share one binding; copies do not inherit; agent commands and ordinary document saves cannot mint | `{binding, overseer, affected}` | parent IPC; not this suite |

## Key risks

| risk | required proof | test owner | status |
| --- | --- | --- | --- |
| Stale UI save/undo restoring revoked authority | delayed save, external reload, undo/redo cannot mint or restore `ether.overseer` | renderer/canvas | missing |
| No-edge ordinary vs overseer distinction | overseer with zero edges exercises enabled families; ordinary agent without edges is `ScopeError` | parent admission + e2e when CLI exists | missing |
| Toggle copied aliases | copy/reseat/replace clears grant; aliases of the same binding toggle together | canvas | missing |
| Self-retirement via canvas delete/kind/binding | refuse own-seat delete, canvas delete that would retire the seat, kind/binding replacement that retires identity | canvas | missing |
| Remote source impersonation | Command Center compares `deriveActorSeatId(authenticatedSourceInstallation, binding)` to compiled seatId; forged caller args ignored | Station + parent `executeOverseer` | missing |
| Uncertain completion, no automatic replay | timeout/disconnect reports uncertain completion and never replays mutations | Station dispatcher | missing |
| Viewport invariance | overseer reads, writes, digest, render, screenshot never pan, zoom, focus, resize, or switch the operator view | native capture + renderer | missing |

## Explicit non-coverage

- Operator socket remains agent-denied.
- No fleet enrollment, credentials, or Command Center transfer.
- No arbitrary RPC tunnel and no Remote-initiated new dial.
- Ordinary edge-scoped work ops are unchanged.
- Parent `tests/overseer-admission.test.ts` owns `resolveOverseerActor` and watcher.
