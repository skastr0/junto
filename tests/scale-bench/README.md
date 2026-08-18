# Scale benchmark — the main-thread read path

The regression gate for the read-path refactor. It measures, against a **real
SQLite database** through the **real product services** (no reimplementation,
no mocks):

1. `CanvasesService.read(canvas)` — the full-world read
   (`src/main/vellum/canvases.ts` → `readCanvasWorkProjection`,
   `src/main/vellum/work/repository.ts:2624`): wall time, the synchronous block
   it occupies, CPU, SQL statement count, SQLite-vs-decode split, and the
   projected/stored document inflation.
2. `WorkRepository.readSnapshot(canvas, node)` — the exported entry to
   `loadSnapshot` (`repository.ts:2290`), per sink, with the SQL statement
   count per call.
3. The synchronous read path of one `wakeManagedSeat`
   (`src/main/vellum/kernel/service.ts` `wakeManagedSeatProgram`): full canvas
   read + station scope + active actor refs + registry compile. Seat process
   spawn is excluded on purpose — it is not main-thread synchronous work.

The governing invariant: **no synchronous operation on the main thread may
exceed ~4ms.** Every record carries a `budget` block scoring itself against it,
plus the cost at the target load (1000 nodes, ~133 events/sec).

## Run

```bash
VELLUM_SCALE_BENCH=1 \
VELLUM_SCALE_BENCH_REAL_DB=/path/to/a/copy/of/vellum-command.db \
VELLUM_SCALE_BENCH_OUT=/tmp/after.jsonl \
npx vitest run tests/scale-bench/scale.test.ts --reporter=verbose
```

Skipped by default, so `bun run test` is unaffected.

| env | meaning |
|---|---|
| `VELLUM_SCALE_BENCH=1` | enable (required) |
| `VELLUM_SCALE_BENCH_SCALES` | `real,500,1000` subset (default: all three) |
| `VELLUM_SCALE_BENCH_REAL_DB` | operator database; it is **copied**, never opened in place |
| `VELLUM_SCALE_BENCH_REAL_CANVAS` | canvas name in that database (default `factory`) |
| `VELLUM_SCALE_BENCH_DIR` | fixture cache root (default `<tmpdir>/vellum-scale-bench`) |
| `VELLUM_SCALE_BENCH_OUT` | JSONL file to append records to |
| `VELLUM_SCALE_BENCH_REGEN=1` | rebuild the synthetic fixtures from scratch |

Output is exactly one JSON line per scale, so before/after is a diff:

```bash
diff <(jq -S . baseline-before.jsonl) <(jq -S . /tmp/after.jsonl)
```

`baseline-before.jsonl` in this directory is the recorded "before" state.

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

## Baseline — before the refactor

Recorded from `baseline-before.jsonl` (Node 26.5.0 / V8 14.6 / darwin-arm64,
10 cores, working tree at `cfa1c27e` + uncommitted work). The machine was
shared with other agents at the time (1-minute load average 14-21), so wall
time is if anything pessimistic; `cpuMsPerCall` tracks it within ~10% and the
statement counts are load-independent.

| | real (96 nodes) | synthetic-500 | synthetic-1000 |
|---|---|---|---|
| sinks / messages | 71 / 441 | 500 / 25,000 | 1000 / 50,000 |
| `canvases.read` p50 | 42.7 ms | 1291 ms | 2173 ms |
| synchronous block p50 | 42.4 ms | 1298 ms | 2205 ms |
| CPU per call | 49.5 ms | 1107 ms | 2156 ms |
| SQL statements per call | 2,272 | 84,516 | 169,016 |
| of those, receipt lookups | 1,323 | 75,000 | 150,000 |
| SQLite / decode split | 41% / 59% | 59% / 41% | 61% / 39% |
| stored doc → decoded | 100 KB → 1.66 MB (16.6x) | 178 KB → 46 MB (260x) | 356 KB → 93 MB (260x) |
| `loadSnapshot` mean / max per sink | 0.66 / 9.5 ms | 2.08 / 13.2 ms | 2.54 / 13.6 ms |
| sinks over the 4 ms budget | 3 of 71 | 100 of 500 | 200 of 1000 |
| wake read path p50 | 48.6 ms | 1044 ms | 2494 ms |
| over the 4 ms invariant | 10.7x | 323x | 543x |
| cores needed at 133 events/s | 5.7 | 172 | 289 |

The receipt-lookup row is the N+1 in `loadInbox` (`repository.ts:1570`): three
single-row `work_delivery_receipts` lookups per message, so the statement count
is `3 x messages` regardless of how many receipts exist.
