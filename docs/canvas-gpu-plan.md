# GPU canvas: plan

The ordered work for replacing React Flow with the GPU canvas described in
[canvas-gpu-architecture.md](canvas-gpu-architecture.md). Section numbers below
refer to that document. What today's canvas does, with line receipts, is in
[canvas-gpu-inventory/](canvas-gpu-inventory/README.md).

**Owner:** the Canvas team. **Measuring:** the Performance team, on shipped
versions only, at milestones 1 and 6.

## Rules of the plan

- Every milestone ships behind the experimental switch. The old canvas is not
  touched until milestone 7, except where a milestone says so.
- A done-test is a run with a result, not an opinion. A milestone is done when
  its done-tests have been run and seen to pass.
- `bun run typecheck && bun run test` gate every change, and `bun run verify`
  gates a version, as today.
- Parity is the default. Any difference in look or behaviour goes on the
  deviation list (section 26) and waits for the operator's yes.
- Nothing is built that Junto does not use today.

## Order

```
0 Ground ──> 1 A board to look at ──┬──> 2 Every card, every state ──┐
                (first measurement)  ├──> 3 Hands ──> 5 Around it ────┼──> 6 Default on ──> 7 Delete React Flow
                                     └──> 4 Wires at parity ──────────┘     (second measurement)
```

Milestones 2, 3 and 4 touch different folders and can run at the same time.

## Milestone 0: Ground

No visible change. Four pieces, independent of each other.

| Piece | Work | Section |
| --- | --- | --- |
| 0.1 e2e helper | Add `e2e/harness/canvas.ts`. Move all 46 specs that read React Flow's DOM onto it, still against today's canvas. Add a launch option that sets an experimental key. | 22 |
| 0.2 Derived state leaves the cards | Seat urgency, node status and urgency, a seat's session hydration, and region severity are computed from the stores with no card mounted. Plain readers beside the four React hooks. The old canvas runs on top of the new derivations. | 20 |
| 0.3 The seam | The experimental key, the host at `App.tsx:634-637`, the camera hand-over. With the key on: one `<canvas>` cleared to the ground token, a device that survives loss, dispose and StrictMode, and the no-adapter path. | 5, 21 |
| 0.4 Theme for the GPU | `themeGpu(mode)`, `mixOklab`, the wire verb colours and the missing shadow, border and duration tokens in `src/shared/theme/`. The lint against colour literals under `src/window/canvas/`. | 7 |

Done when:

- The whole e2e suite passes through the helper with the key off, and no spec
  outside the harness names a `.react-flow` selector or an `rf__` test id.
- With every canvas card unmounted in a unit test, the minimap's seat colours
  and the regions' urgency still follow a seat report.
- With the key on, the app starts, shows the ground, and everything outside
  the canvas works. Toggling the key 20 times with the app open leaves one
  device, no error, and the camera where it was.
- `bun run theme:build` output is unchanged for existing tokens.

## Milestone 1: A board to look at

Read-only. This is the first version worth shipping behind the switch, and the
first measurement.

| Work | Section |
| --- | --- |
| Engine core: scene, records, the order list, the quad pipeline, the style table, culling | 6, 7 |
| Camera with every input in the table | 14 |
| Tiers, published to `canvasTier$` and `data-canvas-tier` | 11 |
| Text runs and the image atlas | 8, 9 |
| The ring atlas as a texture, the five motions, the shared clock | 10 |
| Drawn: regions (fill, border, title), agent seats (shell, ring, portrait, name, line), kind seats (ring, icon, name, line), wires at rest as planned routes and fallback elbows | 11, 12, 13 |
| Feed: the model and seat facts, live | 20 |

Ship as soon as seats, regions and wires draw. Anything in the table that is
late moves to milestone 2.

Done when:

- The `factory-like` fixture opens under the switch and answers every camera
  input. At a set of zoom values the tier equals the old canvas's (a test).
- The look test passes for the agent seat and the kind seat at near, mid and
  far, in both themes.
- The phase test passes: at a frozen clock, a DOM ring and the canvas ring of
  the same seat show the same angle.
- The frame test passes: a moving ring is drawn on every tick, an idle scene
  is not, a hidden canvas stops.
- Script time per camera frame on 25 copies of the fixture is no more than
  double the time on one copy, by the engine's own counters.
- A seat report uploads that seat's bytes and no others (a test on the
  upload ranges).

**First measurement (Performance, on the shipped version, both rigs).** With
the spike's gesture script and `lab/gpu-canvas/trace-nav.py`:

1. Dropped frames per gesture, old canvas against new, same board, same
   script, 30 seat reports a second.
2. Dropped frames at rest while rings turn under fleet load. This is the
   motion law's question: do rings ever freeze.
3. Both again with each of the two Chromium switches.

What it decides: whether the frame loop stays on the page's main thread or the
worker investigation starts, and whether a Chromium switch ships. It is a
finding for the operator, pass or fail, in dropped frames.

## Milestone 2: Every card, every state

| Work | Section |
| --- | --- |
| Spine cards, notes with markdown layout, labels, image files | 8, 11 |
| Every state in the cards inventory's table 2.7: selected, hovered, focused, blocked, working, idle, needs attention, done, overseer, not running, error, dimmed | 11 |
| Harness badge, overseer crest, task strip, preamble bubble, kind bands with their motion | 10, 11 |
| Region names and their fade, urgency rollups, nested depth | 12 |
| Seat clusters, far discs and ticks, name tags, urgency halos | 11 |
| Focus dimming, reach preview | 7, 10 |

Done when:

- The look test covers every card kind, in every state, at every tier, in both
  themes, and passes.
- The operator has reviewed old against new with the switch, and every item on
  the deviation list has a yes or a no.

## Milestone 3: Hands

| Work | Section |
| --- | --- |
| Picking with parts; hover | 15 |
| The pointer machine: select, Shift, marquee, drag, region drag with riders, resize, connect with verb zones, edge auto-pan | 15 |
| Delete, context menus, double click to open, keys through the existing dispatcher | 15 |
| The overlay: toolbar, editors, hover cards, menus, a host for work detail surfaces, anchoring without a render | 16 |
| Intents wired to today's writers | 3, 15 |

Done when:

- The pointer machine's table passes.
- The whole e2e suite passes with the switch on.
- A drag of three cards writes exactly one `Move` naming three cards, read
  back from the model; a resize writes one `Move` with `size`.
- Undo and redo pass under the switch (`canvas-undo-redo`).
- React commits nothing during a pan, a drag or a seat report, by the
  existing render counters.

## Milestone 4: Wires at parity

| Work | Section |
| --- | --- |
| The loom fed from the model; routes carried as points | 13 |
| Strips with rounded corners; cables; the fallback elbow of our own | 13 |
| Opacity modes: rest, loupe, connecting, focus cone, far, overview | 13 |
| Flow tracks and pulses on the wall clock | 13 |
| Wire labels, selection, hover glow, wire picking, the connection preview | 13 |

Done when:

- The existing wire unit tests (`wire-route`, `wire-loom`, `wire-pulse`,
  `loom-invalidation`) pass unchanged.
- A property test finds no self-overlap in any strip the router's routes
  produce.
- The look test passes for wires at rest, shown and in a cone.
- Track and pulse phase tests pass at a frozen clock.
- `wire-writers` passes with the switch on.

## Milestone 5: Around the canvas

| Work | Section |
| --- | --- |
| The minimap on its source interface; the bottom bar mounted beside the canvas | 17 |
| The magnifier on the `CanvasApi` | 18 |
| Every other reach into React Flow: keyboard pan, the demo's camera bridge, sound panning, tooltips, the focus law's scope, the modal stack, urgency step, impact mode, reach preview | 19 |
| The performance harness counts the engine's frames, uploads and raster queue | 22 |

Done when:

- With the switch on, no module in the mounted tree imports `@xyflow/react`
  (a test that walks the import graph from the canvas host, as
  `renderer-boot-graph` does today).
- e2e covers minimap click, double click, drag and wheel, and the magnifier,
  under the switch.

## Milestone 6: Default on

| Work | Section |
| --- | --- |
| The switch defaults to the new canvas; the old one stays one version behind it | 21 |
| The no-canvas screen, once the operator has said what it shows | 21, 26 |
| The Linux check | 21 |
| The dropped-frame gate becomes a gate | 22, 26 |

Done when:

- **Second measurement (Performance, on the shipped version, both rigs)**
  passes the gate the operator set.
- The operator has run a version on the new canvas.

## Milestone 7: Delete React Flow

| Work | Section |
| --- | --- |
| Remove the dependency, the files and the selectors | 25 |
| Replace or delete the tests that go with it | 22 |
| The motion-law lock and the `AGENTS.md` wording, in a commit that names the operator | 10 |
| Remove the switch and the helper's DOM branch | 21, 22 |
| Bring `docs/node-card-language.md` and `docs/architecture-canvas-physics.md` up to date | |

Done when:

- A search for `@xyflow` and `react-flow` across `src`, `tests`, `e2e` and
  `scripts` finds nothing.
- `bun run verify` passes.
- The size of the main chunk before and after is recorded.

## What to raise with the operator, and when

| When | What |
| --- | --- |
| Before milestone 1 ships | Nothing. The decisions in section 2 cover it. |
| At the first measurement | The result, and the choice it forces: main thread, worker, or a view of its own. |
| At the look review (milestone 2) | The deviation list. |
| During milestone 3 | Whether a card keeps keyboard focus. |
| Before milestone 6 | What the no-canvas screen shows; the gate's number; Linux. |
| Milestone 7 | The motion-law changes, for a named sign-off. |
