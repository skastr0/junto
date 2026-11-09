# GPU canvas lab

A spike, not product code: the factory board's shape (441 nodes, 931 wires)
drawn by WebGPU, to measure what a GPU canvas costs per frame against today's
canvas, on the same board, the same gesture and the same instruments.

## What it draws

Regions, seat cards, notes, wires (cubic curves), a ring and portrait per
seat, and all text, in one render pass with four instanced pipelines.

- Rings turn and pulse in the shader from one time value. No script runs per ring.
- Detail levels are computed in the shader from the zoom, at the product's
  thresholds (0.62, 0.34, 0.2), so crossing one costs nothing and fades.
- Text is a signed-distance glyph atlas built once from the system font.
- A seat's report rewrites fixed slots in place: 8 bytes of ring state, one
  44 glyph line, 4 bytes for a pulse on a wire.
- Every frame logs its script time and, where the adapter allows, its GPU time.

Not here: card activation, selection, drag, editing, the minimap.

## Run it

    node_modules/.bin/electron lab/gpu-canvas/main.cjs

Pinch or ctrl+wheel zooms, wheel or drag pans. Flags:

| flag | values | default |
| --- | --- | --- |
| `--mode` | `view` (a second view in the window: its own process and its own input), `frame` (a frame from another site: its own process, input still routed through the page), `worker` (a worker; input arrives on the page), `main` (the page's main thread) | `view` |
| `--scale` | copies of the board | `1` |
| `--rate` | seat reports per second | `30` |
| `--load` | `none`, `fleet` (page main thread 47% busy, a 280 ms task every 4 s), `storm` (80%, 440 ms) | `none` |
| `--size` | window content size | `1320x900` |
| `--soft=1` | ask for the software adapter, what a machine with no GPU gets | off |
| `--overlay=1`, `--pump=1` | page chrome over the canvas; an empty frame loop on the page | off |
| `--drive=1` | replay `gesture.cjs`, print a summary, exit | off |
| `--out`, `--tracefile` | where the summary and a Chromium trace go | none |
| `--shots=<prefix>` | with `--drive=1`, pictures far out, at the script's end and close in | none |
| `--show=0` | hidden window, for a smoke run only (use `--mode=main`: a hidden view draws no frames) | shown |

Chromium switches pass straight through, such as `--force-device-scale-factor=2`
or `--disable-gpu`.

The board comes from `e2e/scenarios/zz-idle-probe.factory.json` (not in git);
without it a synthetic board of the same shape is used.

## The comparison

Both arms replay `gesture.cjs` through `Input.dispatchMouseEvent`, which
enters Chromium's input pipeline in the browser process as a wheel event
does, and both are summarised by `summarize.cjs`:

    # GPU canvas
    lab/gpu-canvas/run-matrix.sh /tmp/gpu-lab
    # today's canvas, on a dev build
    scripts/run-e2e.sh e2e/scenarios/zz-zoom-smooth.spec.ts

The number to compare is `duringGestures.movesPerSecond`: frames that showed
the canvas somewhere new, per second of gesture. `inputDelivery` says how
often a wheel event reached the canvas and how old it was when it did.
`trace-nav.py` reads either arm's Chromium trace and says where the time went.
