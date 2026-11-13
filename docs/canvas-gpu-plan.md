# GPU canvas: plan

The work for replacing React Flow with the GPU canvas described in
[canvas-gpu-architecture.md](canvas-gpu-architecture.md). Section numbers below
refer to that document. What today's canvas does, with line receipts, is in
[canvas-gpu-inventory/](canvas-gpu-inventory/README.md).

**Owner:** the Canvas team. **Measuring:** the Performance team, on the first
version that carries the switch and on the version that makes it the default.

The operator's order: "I want this done fast and aggressively. We can have
milestone and slices, but I want the whole thing as soon as possible... We
know the code we want, we know what to write, we write it all."

## How the work runs

- **Everything starts now, at once.** The work is eight tracks. None waits
  for another to finish. Where a track needs another's output, the two agree
  the types first and build against them the same day.
- **Nothing waits on the operator.** Parity with today's canvas is the answer
  to every look and behaviour question. A real question goes up as a signal
  and the work continues on the parity answer.
- **Nothing waits on a measurement.** Performance measures the first version
  that carries the switch. Building does not pause for the result; the result
  only says whether the frame loop moves off the main thread.
- **No soak.** When the e2e suite and the look test pass under the switch, the
  new canvas becomes the default and React Flow is deleted in the same push.
- **The only ceremony is the done-test:** a run with a result. `bun run
  typecheck && bun run test` gate every change, as today.
- **Ship a version whenever one is ready.** Each carries whatever is behind
  the switch.
- Nothing is built that Junto does not use today.

## First: the contract

One file of types that every track builds against: the facts the feed sends,
the scene ops, the intents the engine emits, the frame facts, the hit a pick
returns, and the `CanvasApi` (sections 4, 15, 19). The Canvas lead settles it
on day one. It may change; it must exist.

## The tracks

| Track | Builds | Sections | Needs from others |
| --- | --- | --- | --- |
| A Engine | Scene, records, the order list, the quad pipeline, culling, the frame loop, the device (loss, dispose, StrictMode), the camera with every input, tiers | 5, 6, 11, 14 | The contract |
| B Look | `themeGpu(mode)`, `mixOklab`, the style table, the verb colours and the missing shadow, border and duration tokens in `src/shared/theme/`, text runs, the image atlas, the colour-literal lint | 7, 8, 9 | The contract |
| C Cards | A paint function for every card kind in every state at every tier; regions with names, fade and urgency; rings and bands with their motion; clusters; dimming; reach preview | 10, 11, 12 | A's records, B's styles and text |
| D Wires | The loom fed from the model, routes as points, strips, cables, opacity modes, tracks, pulses, labels, glow, wire picking, the connection preview | 13 | A's wire buffer |
| E Feed | Model and seat facts into the engine; the six derivations that live inside mounted cards today, moved to the stores; plain readers beside the four React hooks | 20 | The contract |
| F Hands | Picking with parts, the pointer machine, every gesture in the table, intents wired to today's writers | 15 | A's spatial index |
| G Shell | The experimental key and the host seam, the camera hand-over, the `CanvasApi`, the overlay and its anchoring, the minimap's source, the magnifier, every other reach into React Flow, the no-adapter path | 16, 17, 18, 19, 21 | The contract |
| H Proof | The e2e helper and the test hook, all 46 specs moved onto it, the look test gallery, the phase and frame tests, the motion-lock replacements, the dropped-frame probe's second arm | 10, 22 | G's hook |

Tracks B, E, G and H can land their first commits against today's canvas
before a single quad is drawn, and should.

## Done-tests

Each is a run. A track is done when its runs pass.

| Track | Done when |
| --- | --- |
| A | A moving ring is drawn on every tick, an idle scene is not, a hidden canvas stops (fake clock). Toggling the switch 20 times leaves one device and no error. Script time per camera frame on 25 copies of the `factory-like` fixture is no more than double one copy. A seat report uploads that seat's bytes and no others. At a set of zoom values the tier equals the old canvas's. |
| B | `bun run theme:build` output is unchanged for existing tokens. The lint finds no colour literal under `src/window/canvas/`. A theme switch rewrites the style table and no record. Text truncation matches the DOM's for the inventory's cases. |
| C | The look test passes for every card kind, in every state, at every tier, in both themes. At a frozen clock a DOM ring and the canvas ring of the same seat show the same angle. |
| D | The existing wire unit tests pass unchanged. A property test finds no self-overlap in any strip. The look test passes for wires at rest, shown and in a cone. Track and pulse phase tests pass. |
| E | With no card mounted, the minimap's seat colours and the regions' urgency still follow a seat report. `Changed` touches only the rows it names. |
| F | The pointer machine's table passes. A drag of three cards writes exactly one `Move` naming three cards; a resize writes one `Move` with `size`. Undo and redo pass under the switch. |
| G | With the switch on, no module in the mounted tree imports `@xyflow/react` (a walk of the import graph from the host). React commits nothing during a pan, a drag or a seat report. Minimap click, double click, drag and wheel pass in e2e. |
| H | No spec outside the harness names a `.react-flow` selector or an `rf__` test id. The whole e2e suite passes with the switch off and with it on. |

## The finish

When H's last line is true and C's look test passes:

1. The switch defaults to the new canvas.
2. Performance measures that version on both rigs (below).
3. React Flow is deleted (section 25): the dependency, the files, the
   selectors, the tests that go with it, the switch, and the helper's DOM
   branch.
4. The motion-law lock and the `AGENTS.md` wording change in a commit that
   names the operator (section 10). Prepare the commit early; it waits only for
   the name.

Done when a search for `@xyflow` and `react-flow` across `src`, `tests`, `e2e`
and `scripts` finds nothing and `bun run verify` passes.

## Measuring

Performance runs the spike's gesture script and reads Chromium's trace with
`lab/gpu-canvas/trace-nav.py`, on the M1 Max at 120 Hz and the Mac mini at
60 Hz:

1. Dropped frames per gesture, old canvas against new, same board, same
   script, 30 seat reports a second.
2. Dropped frames at rest while rings turn under fleet load. This is the
   motion law's question: do rings ever freeze on the page's main thread.
3. Both again with each of the two Chromium switches (section 21).

It runs on the first version that carries a board with seats, regions and
wires, and again at the finish. The first result decides whether track A moves
the frame loop to a worker. Mail `performance-lead` when that version exists.

## What goes to the operator

None of these stops the work.

| What | When |
| --- | --- |
| A place where the new canvas would look or behave differently (section 26) | As a signal, when hit; parity ships meanwhile |
| The first measurement's result | When it exists |
| What the no-canvas screen shows | Before React Flow is deleted |
| The motion-law commit | At the finish, for the name |
