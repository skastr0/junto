# GPU canvas: inventory of today's canvas

What the React Flow canvas does today, file by file, with line receipts. It
exists so the rewrite in [../canvas-gpu-architecture.md](../canvas-gpu-architecture.md)
can be checked for parity without reading the old code twice.

| File | Covers |
| --- | --- |
| [cards.md](cards.md) | Every card kind and what it draws, states, zoom tiers, motion, DOM controls on cards, regions, the design system as seen by a consumer that is not CSS, sizes |
| [interaction.md](interaction.md) | Camera inputs, selection, drag, resize, connect, delete, menus, keys, and the write path from a gesture to a command |
| [wires.md](wires.md) | What a wire is, routing, cables, painting, tracks, pulses, hit testing |
| [integration.md](integration.md) | Minimap, magnifier, where the canvas sits in the app, state and change flow, settings and experimental flags, tests and e2e selectors, every place that reaches into React Flow |

## How far to trust it

- It is a snapshot of the tree at commit `af7006a87` (Junto 0.11.11,
  `@xyflow/react` 12.11.2). Line numbers drift; the code is the truth.
- Each file was written by a reading agent that opened the source and ran
  nothing in the app. Each says at its end what it did not read, and marks
  inferences and unverified claims where they occur.
- These claims were checked again against the source by the Performance lead
  and held: the wire router and loom import nothing from React or React Flow;
  rest opacity 0.07 and `WIRE_WIDTH = 1.2`; the pulse constants; the tier
  thresholds; the keyboard pan constants; `syncPositions` and `resizeNode`;
  `frameContains`; the act queue and `applyChanged`; where selection lives;
  the ring atlas mechanism in `activity-atlas.ts`; that seat urgency is
  published from inside a mounted `AgentSeat`; the seat facts path in
  `SeatCard.tsx`; `parseBlocks` and `parseInline` as exported pure functions;
  the experimental feature readers and the `files` catalog entry; the
  `RtsBottomBar` observer that writes region severity; the 27 files that
  import `@xyflow/react`; the 147 selector lines in 13 style sheets.
- Everything else is unverified until someone opens the receipt.
