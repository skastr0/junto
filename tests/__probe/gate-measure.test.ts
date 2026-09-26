/**
 * THROWAWAY — decision-gate scale measurement. GATE_PROBE=1 guarded.
 *
 * Measures the read path AS IT IS AFTER the memo (e859d58a), separating the
 * four states a read can be in, because the memo makes "a canvas read" no
 * longer one number:
 *
 *   boot        first read on a fresh runtime (includes ensureReady)
 *   warm        world unchanged since the last read — both memos hit
 *   afterWork   one work fact appended, then read — work memo MISSES
 *               (this is the steady state of a live factory)
 *   afterEdit   one canvas edit, then read — portfolio memo MISSES
 *   coldBoth    work fact + canvas edit, then read — BOTH miss
 *   nodeRead    canvases.readNodeStructure (the routing / wake path)
 *
 * Plus the write itself, and an event-loop simulation that records EVERY
 * synchronous state.read/state.transaction block so the longest one is
 * measured rather than inferred.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { cpus, loadavg } from "node:os";
import { describe, it } from "vitest";
import { Effect } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import { groupMembers } from "../../src/shared/graph";
import { CanvasesService } from "../../src/main/junto/canvases";
import { WorkRepository } from "../../src/main/junto/work/repository";
import { StateEngine } from "../../src/main/junto/state/service";
import { IntentFactBasis } from "../../src/shared/work-protocol";
import { Schema } from "effect";
import {
  BENCH_CANVAS_NAME,
  benchCacheRoot,
  ensureSyntheticFixture,
  openBenchRuntime,
  probeShape,
  type BenchRuntimeHandle,
  type ScaleSpec,
} from "../scale-bench/fixture";
import { SPEC_500, SPEC_1000, SPEC_5000 } from "./gate-specs";

const enabled = process.env.GATE_PROBE === "1";
const OUT = process.env.GATE_OUT;
const SCALES = (process.env.GATE_SCALES ?? "real,500,1000,5000").split(",").map((s) => s.trim());
const BUDGET_MS = 4;
const TARGET_EVENTS_PER_SECOND = 133;

const round = (v: number, d = 3): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

const summarize = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0, total: 0 };
  const s = [...values].sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  const at = (f: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(f * s.length) - 1))] as number;
  return {
    n: s.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    min: round(s[0] as number),
    max: round(s[s.length - 1] as number),
    mean: round(total / s.length),
    total: round(total),
  };
};

type Mode = "boot" | "warm" | "afterWork" | "afterEdit" | "coldBoth" | "nodeRead";

const emit = (record: unknown): void => {
  const line = JSON.stringify(record);
  console.log(`GATEREC ${line}`);
  if (OUT !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("node:fs").appendFileSync(OUT, `${line}\n`);
  }
};

const basisOf = (handle: BenchRuntimeHandle) =>
  handle.runtime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      const witness = yield* canvases.activeIntentWitness();
      return Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
        kind: "authorial-intent",
        generation: witness.generation,
        contentSha256: witness.contentSha256,
      });
    }) as never,
  ) as Promise<unknown>;

const measureScale = async (options: {
  readonly scale: string;
  readonly label: string;
  readonly root: string;
  readonly databasePath: string;
  readonly canvasName: string;
}) => {
  const { scale, root, databasePath, canvasName } = options;
  // Open, read once, dispose. This runs any pending schema migration and warms
  // the OS page cache so the `boot` number below is a cold PROCESS, not a cold
  // disk and not a migration.
  {
    const warmup = openBenchRuntime({ root, databasePath });
    await warmup.runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(canvasName);
      }) as never,
    );
    await warmup.dispose();
  }
  const handle = openBenchRuntime({ root, databasePath });
  const recorder = handle.recorder;

  const readFull = (): Promise<{ doc: unknown }> =>
    handle.runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(canvasName);
      }) as never,
    ) as Promise<{ doc: unknown }>;

  const readNode = (nodeId: string): Promise<unknown> =>
    handle.runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.readNodeStructure(canvasName, nodeId);
      }) as never,
    ) as Promise<unknown>;

  // ---- boot: first read on this fresh runtime -------------------------------
  // Heap is bracketed around the boot read so `retainedBytes` is the cost of
  // holding ONE projected world (the memo and `firstRead` both point at it).
  const gc = (globalThis as { gc?: () => void }).gc;
  const heapBase = (() => {
    if (typeof gc !== "function") return 0;
    gc(); gc();
    return process.memoryUsage().heapUsed;
  })();
  recorder.reset("frames");
  const bootStart = performance.now();
  const firstRead = await readFull();
  const bootWall = performance.now() - bootStart;
  const bootFrames = [...recorder.frames];
  const bootReadFrame = bootFrames.filter((f) => f.operation === "canvas.read").at(-1);
  recorder.reset("off");
  const heap = { available: typeof gc === "function", baseBytes: heapBase, retainedBytes: 0, rssBytes: 0, cloneMs: -1 };
  if (typeof gc === "function") {
    gc(); gc();
    heap.retainedBytes = process.memoryUsage().heapUsed - heapBase;
    heap.rssBytes = process.memoryUsage().rss;
  }

  const shape = await probeShape(handle, canvasName, databasePath);
  // Chunked: at 5000 nodes one JSON.stringify of the whole world approaches
  // V8's max string length, so the size is summed per node instead.
  const projectedBytes = (() => {
    const doc = (firstRead as { doc: { nodes?: ReadonlyArray<unknown>; edges?: ReadonlyArray<unknown> } }).doc;
    try {
      return JSON.stringify(doc).length;
    } catch {
      let total = 2;
      for (const node of doc.nodes ?? []) total += JSON.stringify(node).length + 1;
      for (const edge of doc.edges ?? []) total += JSON.stringify(edge).length + 1;
      return total;
    }
  })();
  if (projectedBytes < 150_000_000) {
    // Proxy for the structured clone `ipc.readCanvas` makes of this same
    // object on every renderer read.
    const t0 = performance.now();
    const clone = JSON.parse(JSON.stringify((firstRead as { doc: unknown }).doc));
    heap.cloneMs = round(performance.now() - t0);
    void clone;
  }

  // Where the materialized bytes actually live.
  const bodyBytes = (await handle.runtime.runPromise(
    Effect.gen(function* () {
      const state = yield* StateEngine;
      return yield* state.read("gate.bytes", (reader) => ({
        messageParts:
          reader.get<{ readonly n: number }>(
            "SELECT COALESCE(sum(length(parts_json)),0) AS n FROM work_messages WHERE canvas_name = ?",
            [canvasName],
          )?.n ?? 0,
        taskMessageParts:
          reader.get<{ readonly n: number }>(
            "SELECT COALESCE(sum(length(parts_json)),0) AS n FROM work_task_messages WHERE canvas_name = ?",
            [canvasName],
          )?.n ?? 0,
        artifactParts:
          reader.get<{ readonly n: number }>(
            "SELECT COALESCE(sum(length(parts_json)),0) AS n FROM work_artifacts WHERE canvas_name = ?",
            [canvasName],
          )?.n ?? 0,
        generationBodies:
          reader.get<{ readonly n: number }>(
            "SELECT COALESCE(sum(length(ether_json)),0) AS n FROM canvas_nodes",
          )?.n ?? 0,
        generationRows:
          reader.get<{ readonly n: number }>("SELECT count(*) AS n FROM canvas_documents")?.n ?? 0,
      }));
    }) as never,
  )) as Record<string, number>;

  const actorRefs = (await handle.runtime.runPromise(
    Effect.gen(function* () {
      const canvases = yield* CanvasesService;
      return yield* canvases.activeActorRefs();
    }) as never,
  )) as ReadonlyArray<{ readonly nodeId: string; readonly canvasName: string }>;
  const agentNodes = actorRefs.filter((a) => a.canvasName === canvasName).map((a) => a.nodeId);
  let basis = await basisOf(handle);
  let basisDirty = false;
  const refreshBasisIfDirty = async (): Promise<void> => {
    if (!basisDirty) return;
    basis = await basisOf(handle);
    basisDirty = false;
  };

  let seq = 0;
  const appendOne = (nodeId: string): Promise<unknown> =>
    handle.runtime.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkRepository;
        seq += 1;
        return yield* repository.appendMessage({
          sink: { canvasName, nodeId },
          basis: basis as never,
          message: {
            messageId: `gate-msg-${String(seq).padStart(6, "0")}`,
            role: "agent",
            parts: [{ kind: "text", text: `gate probe event ${seq} ${"x".repeat(1100)}` }],
          },
          sentBy: actorRefs[0] as never,
          destination: { kind: "mailbox" },
        });
      }) as never,
    ) as Promise<unknown>;

  const editCanvas = async (): Promise<unknown> => {
    const result = await handle.runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        seq += 1;
        return yield* canvases.mutate(canvasName, (doc) => ({
          ...doc,
          nodes: doc.nodes.map((node, index) =>
            index === 0 ? { ...node, x: (node.x ?? 0) + (seq % 2 === 0 ? 1 : -1) } : node,
          ),
        }));
      }) as never,
    );
    // A canvas commit moves the intent generation, so every Work fact written
    // after it must be based on the new one. The refresh itself READS the
    // portfolio, which would warm the memo, so it is deferred to just before
    // the next append rather than run here.
    basisDirty = true;
    return result;
  };

  // ---- timed modes ----------------------------------------------------------
  const sampleMode = async (
    mode: Mode,
    iterations: number,
  ): Promise<Record<string, unknown>> => {
    const prepare = async (): Promise<void> => {
      if (mode === "afterWork" || mode === "coldBoth") {
        await refreshBasisIfDirty();
        await appendOne(agentNodes[seq % agentNodes.length] as string);
      }
      // The edit is LAST so the portfolio memo is cold when `act` runs.
      if (mode === "afterEdit" || mode === "coldBoth") await editCanvas();
    };
    const act = async (): Promise<void> => {
      if (mode === "nodeRead") await readNode(agentNodes[0] as string);
      else await readFull();
    };
    // warm-up
    await prepare();
    await act();

    const wall: Array<number> = [];
    recorder.reset("off");
    let cpuUserUs = 0;
    let cpuSystemUs = 0;
    for (let i = 0; i < iterations; i += 1) {
      await prepare();
      const cpuBefore = process.cpuUsage();
      const t0 = performance.now();
      await act();
      wall.push(performance.now() - t0);
      const cpu = process.cpuUsage(cpuBefore);
      cpuUserUs += cpu.user;
      cpuSystemUs += cpu.system;
    }
    const cpu = { user: cpuUserUs, system: cpuSystemUs };

    // instrumented pass for statements / rows / block
    recorder.reset("statements");
    await prepare();
    await act();
    const opName = mode === "nodeRead" ? "canvas.readNodeStructure" : "canvas.read";
    const frame = recorder.frames.filter((f) => f.operation === opName).at(-1);
    const statementStats = recorder.statements();
    const sqliteMs = statementStats.reduce((s, x) => s + x.ms, 0);
    const top = statementStats.slice(0, 6).map((s) => ({
      sql: s.sql.slice(0, 70),
      calls: s.calls,
      ms: round(s.ms),
      rows: s.rows,
    }));

    // separate frames-only pass for the honest (uninstrumented-statement) block
    recorder.reset("frames");
    const blocks: Array<number> = [];
    for (let i = 0; i < Math.min(iterations, 6); i += 1) {
      recorder.frames.length = 0;
      await prepare();
      await act();
      const f = recorder.frames.filter((x) => x.operation === opName).at(-1);
      if (f !== undefined) blocks.push(f.ms);
    }
    recorder.reset("off");

    return {
      mode,
      wallMs: summarize(wall),
      cpuMsPerCall: round((cpu.user + cpu.system) / 1000 / Math.max(1, iterations)),
      syncBlockMs: summarize(blocks),
      statements: frame?.statements ?? 0,
      gets: frame?.gets ?? 0,
      alls: frame?.alls ?? 0,
      rowsRead: frame?.rows ?? 0,
      instrumentedBlockMs: round(frame?.ms ?? 0),
      sqliteMs: round(sqliteMs),
      decodeMs: round(Math.max(0, (frame?.ms ?? 0) - sqliteMs)),
      overBudget: round((summarize(blocks).p50 || 0) / BUDGET_MS, 1),
      topStatements: top,
    };
  };

  const iterFor = (probeMs: number): number =>
    Math.max(3, Math.min(12, Math.ceil(2000 / Math.max(1, probeMs))));
  const iters = iterFor(bootWall);

  const warm = await sampleMode("warm", Math.max(iters, 5));
  const afterWork = await sampleMode("afterWork", iters);
  const afterEdit = await sampleMode("afterEdit", iters);
  const coldBoth = await sampleMode("coldBoth", iters);
  const nodeRead = await sampleMode("nodeRead", Math.max(iters, 5));

  // ---- one sink, rebuilt alone ---------------------------------------------
  // The ceiling for any design that rebuilds only what changed: WorkRepository
  // .readSnapshot is the exported entry to loadSnapshot for a single sink.
  const readOneSnapshot = (nodeId: string): Promise<unknown> =>
    handle.runtime.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkRepository;
        return yield* repository.readSnapshot(canvasName, nodeId);
      }) as never,
    ) as Promise<unknown>;
  const sinkNode = agentNodes[0] as string;
  recorder.reset("off");
  await readOneSnapshot(sinkNode);
  const sinkWall: Array<number> = [];
  for (let i = 0; i < 8; i += 1) {
    const t0 = performance.now();
    await readOneSnapshot(sinkNode);
    sinkWall.push(performance.now() - t0);
  }
  recorder.reset("frames");
  recorder.frames.length = 0;
  await readOneSnapshot(sinkNode);
  const sinkFrame = recorder.frames.filter((f) => f.operation === "work.readSnapshot").at(-1);
  recorder.reset("off");
  const oneSink = {
    nodeId: sinkNode,
    wallMs: summarize(sinkWall),
    statements: sinkFrame?.statements ?? 0,
    rowsRead: sinkFrame?.rows ?? 0,
    blockMs: round(sinkFrame?.ms ?? 0),
  };

  // ---- per-lane sink cost ---------------------------------------------------
  // The full read is the SUM of loadSnapshot over every sink, so the growth
  // curve is only fittable if the per-sink cost is known PER LANE. One
  // representative sink is sampled from each lane that has rows, plus the
  // count of sinks in that lane, so `lane cost x lane population` can be
  // summed and checked against the measured whole-canvas read.
  const laneSinks = (await handle.runtime.runPromise(
    Effect.gen(function* () {
      const state = yield* StateEngine;
      return yield* state.read("gate.lanes", (reader) => {
        const lanes: Array<[string, string]> = [
          ["messages", "work_messages"],
          ["tasks", "work_tasks"],
          ["requests", "work_requests"],
          ["artifacts", "work_artifacts"],
          ["board", "work_board_topics"],
        ];
        return lanes.map(([lane, table]) => {
          const sample = reader.get<{ readonly node_id: string; readonly n: number }>(
            `SELECT node_id, count(*) AS n FROM ${table} WHERE canvas_name = ?
             GROUP BY node_id ORDER BY n DESC LIMIT 1`,
            [canvasName],
          );
          const population = reader.get<{ readonly n: number }>(
            `SELECT count(DISTINCT node_id) AS n FROM ${table} WHERE canvas_name = ?`,
            [canvasName],
          );
          return {
            lane,
            nodeId: sample?.node_id ?? "",
            rowsOnThatSink: Number(sample?.n ?? 0),
            sinksInLane: Number(population?.n ?? 0),
          };
        });
      });
    }) as never,
  )) as ReadonlyArray<{
    readonly lane: string;
    readonly nodeId: string;
    readonly rowsOnThatSink: number;
    readonly sinksInLane: number;
  }>;

  const sinkLanes: Array<Record<string, unknown>> = [];
  for (const lane of laneSinks) {
    if (lane.nodeId === "") {
      sinkLanes.push({ ...lane, wallMs: summarize([]), statements: 0, rowsRead: 0 });
      continue;
    }
    recorder.reset("off");
    await readOneSnapshot(lane.nodeId);
    const wall: Array<number> = [];
    for (let i = 0; i < 6; i += 1) {
      const t0 = performance.now();
      await readOneSnapshot(lane.nodeId);
      wall.push(performance.now() - t0);
    }
    recorder.reset("frames");
    recorder.frames.length = 0;
    await readOneSnapshot(lane.nodeId);
    const frame = recorder.frames.filter((f) => f.operation === "work.readSnapshot").at(-1);
    recorder.reset("off");
    const summary = summarize(wall);
    sinkLanes.push({
      ...lane,
      wallMs: summary,
      statements: frame?.statements ?? 0,
      rowsRead: frame?.rows ?? 0,
      blockMs: round(frame?.ms ?? 0),
      laneTotalMsIfEverySinkCostThis: round(summary.p50 * lane.sinksInLane),
    });
  }

  // ---- derived-index cost, in memory, with no SQLite involved ---------------
  // Moving the world into memory does not by itself make a point query cheap.
  // These three are recomputed from scratch on every call TODAY, against the
  // already-in-memory document, so they measure what an in-memory world still
  // owes if it ships without maintained indexes.
  const derivedDoc = (firstRead as { doc: CanvasDoc }).doc;
  const timeSync = (times: number, body: () => void): number => {
    body();
    const samples: Array<number> = [];
    for (let i = 0; i < times; i += 1) {
      const t0 = performance.now();
      body();
      samples.push(performance.now() - t0);
    }
    return summarize(samples).p50;
  };
  const probeNodeId = (derivedDoc.nodes[derivedDoc.nodes.length - 1]?.id ?? "") as string;
  const derivedIndexes = {
    nodes: derivedDoc.nodes.length,
    regions: derivedDoc.nodes.filter((n) => n.type === "group").length,
    // O(regions x nodes) geometric containment, rebuilt per call (graph.ts:90).
    groupMembersMs: round(timeSync(5, () => void groupMembers(derivedDoc))),
    // The linear node scan the kernel runs INSIDE its per-task loop
    // (kernel/service.ts deliverWorkingClaims).
    nodeFindMs: round(timeSync(20, () => void derivedDoc.nodes.find((n) => n.id === probeNodeId))),
  };

  // ---- the write itself -----------------------------------------------------
  recorder.reset("off");
  const writeWall: Array<number> = [];
  const cpuBeforeWrite = process.cpuUsage();
  await refreshBasisIfDirty();
  for (let i = 0; i < Math.max(iters, 5); i += 1) {
    const t0 = performance.now();
    await appendOne(agentNodes[i % agentNodes.length] as string);
    writeWall.push(performance.now() - t0);
  }
  const writeCpu = process.cpuUsage(cpuBeforeWrite);
  recorder.reset("frames");
  const writeBlocks: Array<number> = [];
  let writeStatements = 0;
  for (let i = 0; i < 5; i += 1) {
    recorder.frames.length = 0;
    await appendOne(agentNodes[i % agentNodes.length] as string);
    const frames = recorder.frames;
    writeBlocks.push(frames.reduce((m, f) => Math.max(m, f.ms), 0));
    writeStatements = frames.reduce((s, f) => s + f.statements, 0);
  }
  recorder.reset("off");

  // ---- event-loop simulation ------------------------------------------------
  // One factory event = one work fact appended, then the reads the current
  // code performs for it: the node-scoped routing read (wake) and ONE full
  // read (delivery scan / kernel resync both still read the full projection).
  // The live tape at e859d58a shows ~3 full reads per delivered message, so
  // one is the conservative floor.
  const events = Math.max(5, Math.min(40, Math.ceil(20000 / Math.max(1, (afterWork as { wallMs: { p50: number } }).wallMs.p50))));
  await refreshBasisIfDirty();
  recorder.reset("frames");
  const loopStart = performance.now();
  for (let i = 0; i < events; i += 1) {
    const nodeId = agentNodes[i % agentNodes.length] as string;
    await appendOne(nodeId);
    await readNode(nodeId);
    await readFull();
  }
  const loopWall = performance.now() - loopStart;
  const loopFrames = [...recorder.frames];
  recorder.reset("off");
  const byOp = new Map<string, Array<number>>();
  for (const f of loopFrames) {
    const list = byOp.get(f.operation) ?? [];
    list.push(f.ms);
    byOp.set(f.operation, list);
  }
  const loopBlockMs = loopFrames.map((f) => f.ms);
  const worstFrame = loopFrames.reduce((m, f) => (f.ms > m.ms ? f : m), loopFrames[0] as (typeof loopFrames)[number]);

  const record = {
    schema: "junto.gate/1",
    scale,
    label: options.label,
    recordedAt: new Date().toISOString(),
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      loadAverage1m: round(loadavg()[0] ?? 0, 1),
    },
    shape,
    projectedDocumentBytes: projectedBytes,
    heap,
    bodyBytes,
    projectionInflation: round(projectedBytes / Math.max(1, shape.storedDocumentBytes), 2),
    databaseBytes: statSync(databasePath).size,
    boot: {
      wallMs: round(bootWall),
      statements: bootReadFrame?.statements ?? 0,
      rowsRead: bootReadFrame?.rows ?? 0,
      canvasReadBlockMs: round(bootReadFrame?.ms ?? 0),
      longestBootBlockMs: round(bootFrames.reduce((m, f) => Math.max(m, f.ms), 0)),
      bootFrames: bootFrames.length,
    },
    modes: { warm, afterWork, afterEdit, coldBoth, nodeRead },
    oneSink,
    sinkLanes,
    derivedIndexes,
    write: {
      wallMs: summarize(writeWall),
      cpuMsPerCall: round((writeCpu.user + writeCpu.system) / 1000 / Math.max(1, writeWall.length)),
      longestBlockMs: summarize(writeBlocks),
      statementsPerWrite: writeStatements,
    },
    eventLoop: {
      events,
      wallMs: round(loopWall),
      msPerEvent: round(loopWall / events),
      blockMs: summarize(loopBlockMs),
      longestBlock: {
        ms: round(worstFrame?.ms ?? 0),
        operation: worstFrame?.operation ?? "none",
        kind: worstFrame?.kind ?? "none",
        statements: worstFrame?.statements ?? 0,
        rows: worstFrame?.rows ?? 0,
      },
      framesOverBudget: loopBlockMs.filter((m) => m > BUDGET_MS).length,
      framesTotal: loopBlockMs.length,
      byOperation: [...byOp.entries()]
        .map(([operation, values]) => ({ operation, ...summarize(values) }))
        .sort((a, b) => b.total - a.total),
      coresAtTarget: round(((loopWall / events) * TARGET_EVENTS_PER_SECOND) / 1000, 2),
    },
  };

  await handle.dispose();
  return record;
};

describe.skipIf(!enabled)("decision gate: does the read path scale", () => {
  const specs: ReadonlyArray<readonly [string, ScaleSpec]> = [
    ["500", SPEC_500],
    ["1000", SPEC_1000],
    ["5000", SPEC_5000],
  ];

  it.skipIf(!SCALES.includes("real"))(
    "real operator canvas",
    async () => {
      const source = process.env.GATE_REAL_DB;
      if (source === undefined || !existsSync(source)) throw new Error("GATE_REAL_DB required");
      const root = join(process.env.GATE_WORK ?? "/tmp", "gate-real");
      rmSync(root, { recursive: true, force: true });
      mkdirSync(join(root, "state"), { recursive: true });
      const databasePath = join(root, "state", "junto.db");
      copyFileSync(source, databasePath);
      const record = await measureScale({
        scale: "real",
        label: "operator canvas",
        root,
        databasePath,
        canvasName: process.env.GATE_REAL_CANVAS ?? BENCH_CANVAS_NAME,
      });
      emit(record);
      rmSync(root, { recursive: true, force: true });
    },
    60 * 60_000,
  );

  for (const [key, spec] of specs) {
    it.skipIf(!SCALES.includes(key))(
      `synthetic ${spec.id}`,
      async () => {
        const fixture = await ensureSyntheticFixture(spec, { log: (l) => console.log(l) });
        // Copy so the cached fixture is never mutated by the probe's writes.
        const root = join(process.env.GATE_WORK ?? "/tmp", `gate-${spec.id}`);
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
        cpSync(fixture.root, root, { recursive: true });
        const databasePath = join(root, "state", "junto.db");
        const record = await measureScale({
          scale: spec.id,
          label: spec.label,
          root,
          databasePath,
          canvasName: BENCH_CANVAS_NAME,
        });
        emit(record);
        rmSync(root, { recursive: true, force: true });
      },
      120 * 60_000,
    );
  }
});
