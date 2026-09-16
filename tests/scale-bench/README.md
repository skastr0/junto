# Scale benchmark — the main-thread read path

The regression gate for the read-path refactor. It measures, against a **real
SQLite database** through the **real product services** (no reimplementation,
no mocks):

1. `CanvasesService.read(canvas)` — the full-world read
   (`src/main/vellum-command/canvases.ts` → `readCanvasWorkProjection`,
   `src/main/vellum-command/work/repository.ts:2624`): wall time, the synchronous block
   it occupies, CPU, SQL statement count, SQLite-vs-decode split, and the
   projected/stored document inflation.
2. `WorkRepository.readSnapshot(canvas, node)` — the exported entry to
   `loadSnapshot` (`repository.ts:2290`), per sink, with the SQL statement
   count per call.
3. The synchronous read path of one `wakeManagedSeat`
   (`src/main/vellum-command/kernel/service.ts` `wakeManagedSeatProgram`): full canvas
   read + station scope + active actor refs + registry compile. Seat process
   spawn is excluded on purpose — it is not main-thread synchronous work.

The governing invariant: **no synchronous operation on the main thread may
exceed ~4ms.** Every record carries a `budget` block scoring itself against it,
plus the cost at the target load (1000 nodes, ~133 events/sec).

## Run

```bash
JUNTO_SCALE_BENCH=1 \
JUNTO_SCALE_BENCH_REAL_DB=/path/to/a/copy/of/vellum-command.db \
JUNTO_SCALE_BENCH_OUT=/tmp/after.jsonl \
npx vitest run tests/scale-bench/scale.test.ts --reporter=verbose
```

Skipped by default, so `bun run test` is unaffected.

| env | meaning |
|---|---|
| `JUNTO_SCALE_BENCH=1` | enable (required) |
| `JUNTO_SCALE_BENCH_SCALES` | `real,500,1000` subset (default: all three) |
| `JUNTO_SCALE_BENCH_REAL_DB` | operator database; it is **copied**, never opened in place |
| `JUNTO_SCALE_BENCH_REAL_CANVAS` | canvas name in that database (default `factory`) |
| `JUNTO_SCALE_BENCH_DIR` | fixture cache root (default `<tmpdir>/vellum-scale-bench`) |
| `JUNTO_SCALE_BENCH_OUT` | JSONL file to append records to |
| `JUNTO_SCALE_BENCH_REGEN=1` | rebuild the synthetic fixtures from scratch |

Output is exactly one JSON line per scale, so two runs are easy to compare:

```bash
diff <(jq -S . /tmp/run-a.jsonl) <(jq -S . /tmp/run-b.jsonl)
```

## Scales

| scale | shape |
|---|---|
| `real` | the operator's canvas: 96 nodes, 99 edges, 71 sinks, 441 messages, 911 receipts |
| `synthetic-500` | 500 nodes = 100 agents + 400 sinks, 25k messages |
| `synthetic-1000` | 1000 nodes = 200 agents + 800 sinks, 50k messages — the target shape |

Synthetic fixtures are generated **through the product write path**
(`canvases.write`, `WorkRepository.appendMessage` / `createTask` /
`createRequest` / `publishArtifact` / `acceptDelivery` / board ops), so every
row is shaped exactly as the app shapes it — there is no hand-written INSERT in
this directory. Generation is slow (each write returns a full sink snapshot,
which is itself part of what the refactor must fix) and the databases are
large, so they are cached by spec hash + state schema version:

| fixture | measured build | database |
|---|---|---|
| `synthetic-500` | 162 s | 381 MB |
| `synthetic-1000` | 374 s (on a loaded machine) | 769 MB |

Delete `<tmpdir>/vellum-scale-bench` to reclaim the space.

## Reading a record

- `canvasRead.syncBlockMs` — the block the main thread cannot interrupt. This
  is the number the 4ms invariant is about.
- `canvasRead.statements` / `gets` / `alls` — the N+1 shows up here: the
  per-message receipt lookup (`loadInbox`, `repository.ts:1570`) is 3 single-row
  `get`s per message, so `gets` tracks `3 x messages`.
- `canvasRead.sqliteSharePercent` — SQLite vs schema-decode split of the block.
- `canvasRead.projectionInflation` — decoded bytes per stored byte.
- `loadSnapshot.wallMsPerSink` / `statementsPerSink` — per-sink cost; the read
  pays this for **every** sink on the canvas.
- `budget.msOfWorkPerSecondAtTarget` — canvas-read p50 x 133 events/sec. Above
  1000 means the target load cannot fit on one core at all.
