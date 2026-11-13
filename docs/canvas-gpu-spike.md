# GPU canvas: what the spike found

**Status:** closed. The spike answered its question and is not to be tuned
further. It is the evidence behind [canvas-gpu-architecture.md](canvas-gpu-architecture.md)
and [canvas-gpu-plan.md](canvas-gpu-plan.md).

**Code:** `lab/gpu-canvas/` (about 2,000 lines of plain JavaScript; see its
`README.md` for every flag). Commits `6991af5e9`, `591e9aa83`, `5432a7813`,
`1b8e440b0`, `af7006a87`.

## The question

Today's canvas is React Flow: every card is DOM, and moving the camera costs
main thread time in proportion to what is on the board. The question was what
the same board costs when the GPU draws it, on the same gesture and the same
instruments.

## What was built

The factory board's shape (441 nodes, 253 seats, 931 wires) drawn by WebGPU in
one render pass with four instanced pipelines: rectangles (regions, cards,
notes), wires (cubic curves, 20 segments each), marks (a ring and a portrait
per seat) and text (a signed-distance glyph atlas).

- Every drawn thing is a fixed-size record in a GPU buffer. A seat's report
  rewrites its record in place: 8 bytes of ring state, one 44 glyph line, 4
  bytes for a pulse on a wire. Nothing else moves.
- Rings turn and pulse in the shader from one time value. No script runs per
  ring, per frame.
- Detail levels are computed in the shader from the zoom, at the product's
  thresholds (0.62, 0.34, 0.2), so crossing one costs nothing and fades.
- The engine sits behind one message protocol (`port.js`) and ran unchanged in
  five places: the page's main thread, a worker, a frame from another site, a
  second view in the window, and a window of its own.

What it does not have: selection, drag, resize, connect, editing, the minimap,
the magnifier, routed wires, the real card designs, the design system's
colours, any text outside ASCII, a depth buffer or a camera matrix. It is a
flat 2D drawing of the board's shape and nothing more. None of its code is
product code.

## How smoothness was measured

One gesture script (`gesture.cjs`) is replayed into Chromium's input pipeline
at the display's rate: zooms from the whole board to reading distance and
back, small zooms inside one detail level, and pans. Both canvases replay the
same script (`e2e/scenarios/zz-zoom-smooth.spec.ts` drives today's).

The number is **dropped frames**: display refreshes during a gesture that
showed no new picture. It is read from a Chromium trace by
`lab/gpu-canvas/trace-nav.py`, from Chromium's own per-frame records, gesture
by gesture. A frame drawn is not a frame shown: the engine's own count of
frames it drew read smooth while the display repeated pictures, so that count
is not used.

`lab/gpu-canvas/trace-pace.py` follows one frame from the display's tick to
the screen, stage by stage.

## Results

### Cost of a frame

| | today's canvas | the spike |
| --- | --- | --- |
| main thread per camera frame, factory board | about 25 ms | 0.1 to 0.3 ms of script |
| GPU pass at 3360x1948 | not measured | 1.7 to 2.6 ms |
| 25 copies of the board (11,025 nodes) | not attempted | held |
| total memory | 2.2 to 2.4 GB (dev build) | about 510 MB (not like for like) |

A display frame is 8.3 ms at 120 Hz and 16.7 ms at 60 Hz. Today's canvas
cannot fit a camera move in either; the spike fits with room.

### Dropped frames, 120 Hz (M1 Max, built-in display, page as busy as a fleet makes it)

About 1,700 refreshes per run, each number one run.

| arrangement | dropped | tick to screen |
| --- | --- | --- |
| spike as first built (passive wheel listener) | 123 of 1,808 (6.8%) | 20 ms |
| canvas takes the wheel itself | 16, 12, 191, 231 (0.7% to 13.6%) | 12 to 20 ms |
| plus switch A | 0, 0, 1 | 20 to 28 ms |
| plus switch B | 3, 1, 0 | 17 to 33 ms |
| plus both switches | 0, 0 | 25 to 33 ms |
| own window plus switch B | 0, 1, 1 | 25 to 33 ms |
| own window, no switch | 298 of 1,694 (17.6%) | 12 ms |

Switch A is `--enable-features=VSyncAlignedPresentation,VSyncAlignedPresentationForScrolling`.
Switch B is `--enable-features=CADisplayLinkInGpu`. Both are Chromium features
present in Electron 43.8.4.

### Dropped frames, 60 Hz (M1 Mac mini, 1920x1080)

| arrangement | dropped |
| --- | --- |
| today's canvas, no seat reports | 303 of 645 (47%) |
| today's canvas, 30 reports a second | 247 of 313 (79%), waits up to 150 ms |
| spike as first built | 194 of 862 (22.5%) |
| spike, canvas takes the wheel, busy page | 7 (0.8%) |
| spike, canvas takes the wheel, quiet page | 9 (1.0%) |
| spike plus switch A | 0 of 839 |
| spike plus switch B | 0 of 849 |

Two or three runs per arrangement at 120 Hz and one per arrangement at 60 Hz.
The work stopped there by the operator's order. These numbers are enough to
choose a direction and not enough to quote as a guarantee.

## What causes a dropped frame when the drawing is this cheap

The drawing is never late. Every remaining drop is frame pacing inside
Chromium, between the canvas finishing a frame and macOS taking it.

1. **A passive wheel listener turns the wheel into a scroll.** Chromium then
   treats the gesture as scrolling, and during one its compositor holds some
   frames about 3 ms to wait for scroll input and not others. Each switch
   lands a frame on the other side of the display's cut-off, so one refresh
   shows two pictures and the next shows none. The fix is a wheel listener
   with `{ passive: false }` that calls `preventDefault()`
   (`lab/gpu-canvas/input.js`). This is a product requirement.
2. **The hand-off to macOS has a cut-off.** At 120 Hz a frame handed over
   later than about 1.5 to 2 ms after the display's tick is shown one refresh
   later. Chromium's default timing lands the hand-off right on that cut-off in
   some runs and well before it in others, which is why the same build dropped
   0.7% in one run and 13.6% in the next. Switches A and B both move the
   hand-off away from the cut-off, at the price of one more refresh of delay.
3. **A busy neighbour in the same window holds the frame.** When the canvas
   shares a window with the app's page, Chromium's display scheduler waits for
   every surface that owes a frame. In one trace 33 of 34 late draws were
   waiting on the page; when nothing else owed a frame there were 0 late draws
   in 2,864 refreshes.
4. **A window of its own is not the cure.** It removed the neighbour and made
   the cut-off problem worse (17.6% dropped) until switch B was added.

## Where the engine may run

| place | result |
| --- | --- |
| page main thread, quiet page | smooth |
| page main thread, busy page | stalls for as long as the page's long tasks (280 to 440 ms in the test load) |
| worker | underperformed; the cause was never established |
| frame from another site | own process, input still routed through the page |
| second view in the window | own process and own input; the arrangement the tables above measure |

The rewrite starts on the page main thread (operator's decision), which makes
the page's long tasks the first thing to measure there. See the plan's
measuring section.

## No GPU

With the GPU off (`--disable-gpu`) Chromium offered no WebGPU adapter at all,
the software adapter included: the log reads "No available adapters" and the
canvas does not start. There is no software path to fall back to in this
Electron build.

WebGPU runs on whatever real graphics a machine has, integrated graphics
included. Every Mac that runs Junto has Metal; both test machines are Apple
silicon. A macOS virtual machine with a virtual GPU was not measured.

Today's canvas on the same machine with the GPU off ran at 5.8 to 8.7 frames a
second, so "no GPU" is not a working arrangement today either.

## What carries into the product

- The data layout: fixed-size records, a report rewrites bytes in place, no
  per-frame allocation.
- Motion in the shader from one clock.
- Detail levels in the shader from the zoom.
- The engine behind a narrow message interface, so where it runs stays a
  later choice.
- The wheel listener that takes the wheel.
- The method: the gesture script, `trace-nav.py`, `trace-pace.py`, dropped
  frames per gesture.
- Switches A and B as candidates to ship, to be chosen by measurement on the
  real app.

## What does not carry

- The code. It is JavaScript with no types, a flat camera, no depth, ASCII
  text and invented colours.
- The cubic wires. The product routes wires around cards.
- Any number above as a product claim. They describe an empty shell beside a
  synthetic load.

## Where the raw results are

- Operator's Mac: `~/.junto/traces/pass-0.11.11/gpu-canvas/` (`gpu-lab-1` to
  `gpu-lab-4`, `local-120-visible` with six compressed traces and `rep/runs.txt`).
- Mac mini: `~/junto-perf/results/gpu-canvas-2026-11-09/lab-1` to `lab-6`.

## Run it again

    node_modules/.bin/electron lab/gpu-canvas/main.cjs --mode=view --load=fleet \
      --drive=1 --out=/tmp/run.json --tracefile=/tmp/run-trace.json
    python3 -I lab/gpu-canvas/trace-nav.py /tmp/run-trace.json
