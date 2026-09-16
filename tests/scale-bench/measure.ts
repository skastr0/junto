/**
 * One scale → one benchmark record.
 *
 * Measures three things against a real SQLite database through the real
 * product services:
 *
 *   1. CanvasesService.read(canvas)  — the full-world read that every wake,
 *      hydrate, IPC read and work-control call pays for
 *      (src/main/junto/canvases.ts readWithIntentWitness → readCanvasWorkProjection).
 *   2. WorkRepository.readSnapshot(canvas, node) per sink — the exported entry
 *      to loadSnapshot (src/main/junto/work/repository.ts:2290), with the SQL
 *      statement count per call.
 *   3. The synchronous read path of one wakeManagedSeat
 *      (src/main/junto/kernel/service.ts wakeManagedSeatProgram): the full
 *      canvas read + active actor refs + station scope + registry compile that
 *      run before any seat process is touched. Process spawn is deliberately
 *      excluded — it is not main-thread synchronous work.
 */
import { cpus, loadavg } from "node:os";
import { Effect } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import type { ActorRef } from "../../src/shared/work-protocol";
import { CanvasesService } from "../../src/main/junto/canvases";
import { activeActorRegistry } from "../../src/main/junto/kernel/service";
import { StationRepository } from "../../src/main/junto/station/repository";
import { StateEngine } from "../../src/main/junto/state/service";
import { WorkRepository } from "../../src/main/junto/work/repository";
import type { BenchRuntimeHandle, FixtureShape } from "./fixture";
import { measure, roundTo, summarize, type Summary } from "./harness";

/** The invariant the refactor must reach: no synchronous main-thread block above this. */
export const SYNC_BLOCK_BUDGET_MS = 4;
/** Operator's target load: 1000 nodes, one event per node every 5-10s. */
export const TARGET_EVENTS_PER_SECOND = 133;

export type BenchRecord = {
  readonly schema: "junto.scale-bench/1";
  readonly scale: string;
  readonly label: string;
  readonly recordedAt: string;
  readonly runtime: {
    readonly node: string;
    readonly v8: string;
    readonly platform: string;
    readonly arch: string;
    readonly cpus: number;
    /**
     * 1-minute load average at record time. This machine is shared with other
     * agents; a high value means wall time is contended and `cpuMsPerCall` /
     * `minMs` are the honest comparands.
     */
    readonly loadAverage1m: number;
  };
  readonly git: { readonly head: string; readonly dirty: boolean };
  readonly shape: FixtureShape;
  readonly canvasRead: {
    readonly iterations: number;
    readonly wallMs: Summary;
    readonly syncBlockMs: Summary;
    readonly cpuMsPerCall: number;
    readonly statements: number;
    readonly gets: number;
    readonly alls: number;
    readonly rowsRead: number;
    readonly storedDocumentBytes: number;
    readonly projectedDocumentBytes: number;
    readonly projectionInflation: number;
    /**
     * Measured on the instrumented pass: SQLite time is the sum of the timed
     * statements, the remainder of the bracketed block is JS (schema decode +
     * projection). Per-statement timing inflates the block slightly, so this
     * is a share, not a second time source.
     */
    readonly instrumentedBlockMs: number;
    readonly sqliteMs: number;
    readonly decodeAndProjectMs: number;
    readonly sqliteSharePercent: number;
    readonly topStatements: ReadonlyArray<{
      readonly sql: string;
      readonly kind: string;
      readonly calls: number;
      readonly ms: number;
      readonly rows: number;
    }>;
  };
  readonly loadSnapshot: {
    readonly sinks: number;
    readonly wallMsPerSink: Summary;
    readonly statementsTotal: number;
    readonly statementsPerSink: { readonly mean: number; readonly max: number };
    readonly overBudgetSinks: number;
    readonly worstSinks: ReadonlyArray<{
      readonly nodeId: string;
      readonly ms: number;
      readonly statements: number;
    }>;
  };
  readonly wakeManagedSeat: {
    readonly nodeId: string;
    readonly iterations: number;
    readonly wallMs: Summary;
    readonly cpuMsPerCall: number;
    readonly breakdownMs: {
      readonly canvasRead: number;
      readonly activeActorRefs: number;
      readonly stationScope: number;
      readonly registryCompile: number;
    };
  };
  readonly budget: {
    readonly syncBlockBudgetMs: number;
    readonly canvasReadOverBudget: number;
    readonly worstSinkOverBudget: number;
    readonly targetEventsPerSecond: number;
    readonly msOfWorkPerSecondAtTarget: number;
    readonly coresRequiredAtTarget: number;
  };
};

const runtimeFacts = (): BenchRecord["runtime"] => ({
  node: process.versions.node,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
  cpus: cpus().length,
  loadAverage1m: Math.round((loadavg()[0] ?? 0) * 10) / 10,
});

export const listSinkNodes = async (
  handle: BenchRuntimeHandle,
  canvasName: string,
): Promise<ReadonlyArray<string>> => {
  const rows = (await handle.runtime.runPromise(
    Effect.gen(function* () {
      const state = yield* StateEngine;
      return yield* state.read("bench.sinks", (reader) =>
        reader.all<{ readonly node_id: string }>(
          `
            SELECT node_id FROM work_tasks WHERE canvas_name = ?1
            UNION SELECT node_id FROM work_requests WHERE canvas_name = ?1
            UNION SELECT node_id FROM work_messages WHERE canvas_name = ?1
            UNION SELECT node_id FROM work_artifacts WHERE canvas_name = ?1
            UNION SELECT node_id FROM work_board_topics WHERE canvas_name = ?1
            UNION SELECT node_id FROM work_pad_meta WHERE canvas_name = ?1
            ORDER BY node_id
          `,
          [canvasName],
        ),
      );
    }) as never,
  )) as ReadonlyArray<{ readonly node_id: string }>;
  return rows.map((row) => row.node_id);
};

/** Enough iterations to be stable, few enough to stay inside a few seconds. */
const iterationsFor = (probeMs: number): number =>
  Math.max(3, Math.min(20, Math.ceil(3000 / Math.max(1, probeMs))));

type ReadResult = {
  readonly doc: CanvasDoc;
  readonly actorRefs: ReadonlyArray<ActorRef>;
};

export const benchmarkScale = async (options: {
  readonly handle: BenchRuntimeHandle;
  readonly scale: string;
  readonly label: string;
  readonly canvasName: string;
  readonly shape: FixtureShape;
  readonly git: BenchRecord["git"];
  readonly log?: (line: string) => void;
}): Promise<BenchRecord> => {
  const { handle, canvasName, shape } = options;
  const log = options.log ?? (() => {});
  const recorder = handle.recorder;
  const runtime = handle.runtime;

  const readCanvas = (): Promise<ReadResult> =>
    runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.read(canvasName);
      }) as never,
    ) as Promise<ReadResult>;

  // ---- 1. canvases.read -----------------------------------------------------
  recorder.reset("off");
  const probeStartedAt = performance.now();
  const firstRead = await readCanvas();
  const probeMs = performance.now() - probeStartedAt;
  const iterations = iterationsFor(probeMs);
  log(`[bench] ${options.scale}: canvases.read probe ${probeMs.toFixed(1)}ms, ${iterations} iterations`);
  const readTiming = await measure(iterations, () => readCanvas());

  // Separate instrumented pass: statement counts + the synchronous block the
  // state.read body occupies. Kept out of the timing pass above.
  recorder.reset("statements");
  await readCanvas();
  // `canvases.read` runs exactly one state.read, named "canvas.read".
  const readFrames = recorder.frames.filter(
    (frame) => frame.kind === "read" && frame.operation === "canvas.read",
  );
  const readFrame = readFrames[readFrames.length - 1];
  const readStatements = recorder.statements();
  const instrumentedBlockMs = readFrame?.ms ?? 0;
  const sqliteMs = readStatements.reduce((sum, stat) => sum + stat.ms, 0);
  recorder.reset("frames");
  const syncSamples: Array<number> = [];
  for (let index = 0; index < iterations; index += 1) {
    recorder.frames.length = 0;
    await readCanvas();
    const frame = recorder.frames.find((entry) => entry.operation === "canvas.read");
    if (frame !== undefined) syncSamples.push(frame.ms);
  }
  recorder.reset("off");

  const projectedDocumentBytes = JSON.stringify(firstRead.doc).length;

  // ---- 2. loadSnapshot per sink --------------------------------------------
  const sinks = await listSinkNodes(handle, canvasName);
  const readSnapshot = (nodeId: string): Promise<unknown> =>
    runtime.runPromise(
      Effect.gen(function* () {
        const repository = yield* WorkRepository;
        return yield* repository.readSnapshot(canvasName, nodeId);
      }) as never,
    ) as Promise<unknown>;

  recorder.reset("off");
  for (const nodeId of sinks.slice(0, 8)) await readSnapshot(nodeId);
  const perSinkMs: Array<{ readonly nodeId: string; readonly ms: number }> = [];
  for (const nodeId of sinks) {
    const startedAt = performance.now();
    await readSnapshot(nodeId);
    perSinkMs.push({ nodeId, ms: performance.now() - startedAt });
  }
  recorder.reset("frames");
  const perSinkStatements = new Map<string, number>();
  for (const nodeId of sinks) {
    recorder.frames.length = 0;
    await readSnapshot(nodeId);
    const frame = recorder.frames.find(
      (entry) => entry.operation === "work.readSnapshot",
    );
    perSinkStatements.set(nodeId, frame?.statements ?? 0);
  }
  recorder.reset("off");
  const statementsTotal = [...perSinkStatements.values()].reduce((sum, n) => sum + n, 0);
  const worstSinks = [...perSinkMs]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map(({ nodeId, ms }) => ({
      nodeId,
      ms: roundTo(ms),
      statements: perSinkStatements.get(nodeId) ?? 0,
    }));

  // ---- 3. wakeManagedSeat read path ----------------------------------------
  const wakeNode = firstRead.actorRefs[0];
  if (wakeNode === undefined) throw new Error("no actor on canvas — cannot bench a wake");
  const wakeNodeId = wakeNode.nodeId;
  const stepMs = { canvasRead: 0, activeActorRefs: 0, stationScope: 0, registryCompile: 0 };
  const wakeReadPath = (record: boolean): Promise<boolean> =>
    runtime.runPromise(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        const stations = yield* StationRepository;
        const t0 = performance.now();
        const read = yield* canvases.read(canvasName);
        const t1 = performance.now();
        const node = read.doc.nodes.find((candidate) => candidate.id === wakeNodeId);
        const installationId = yield* stations.installationId;
        const configuration = yield* stations.configuration;
        const t2 = performance.now();
        const actorRefs = yield* canvases.activeActorRefs();
        const t3 = performance.now();
        const registry = activeActorRegistry(actorRefs);
        const resolved = registry.resolve({ canvasName, nodeId: wakeNodeId });
        const t4 = performance.now();
        if (record) {
          stepMs.canvasRead = t1 - t0;
          stepMs.stationScope = t2 - t1;
          stepMs.activeActorRefs = t3 - t2;
          stepMs.registryCompile = t4 - t3;
        }
        return (
          node !== undefined &&
          resolved !== undefined &&
          installationId.length > 0 &&
          configuration !== undefined
        );
      }) as never,
    ) as Promise<boolean>;

  const wakeTiming = await measure(
    Math.max(3, Math.min(10, iterations)),
    (index) => wakeReadPath(index === 0),
  );

  const worstSink = perSinkMs.reduce((max, entry) => Math.max(max, entry.ms), 0);
  const readP50 = readTiming.wall.p50Ms;

  return {
    schema: "junto.scale-bench/1",
    scale: options.scale,
    label: options.label,
    recordedAt: new Date().toISOString(),
    runtime: runtimeFacts(),
    git: options.git,
    shape,
    canvasRead: {
      iterations,
      wallMs: readTiming.wall,
      syncBlockMs: summarize(syncSamples),
      cpuMsPerCall: readTiming.cpuMsPerIteration,
      statements: readFrame?.statements ?? 0,
      gets: readFrame?.gets ?? 0,
      alls: readFrame?.alls ?? 0,
      rowsRead: readFrame?.rows ?? 0,
      storedDocumentBytes: shape.storedDocumentBytes,
      projectedDocumentBytes,
      projectionInflation: roundTo(
        projectedDocumentBytes / Math.max(1, shape.storedDocumentBytes),
        2,
      ),
      instrumentedBlockMs: roundTo(instrumentedBlockMs),
      sqliteMs: roundTo(sqliteMs),
      decodeAndProjectMs: roundTo(Math.max(0, instrumentedBlockMs - sqliteMs)),
      sqliteSharePercent: roundTo(
        (sqliteMs / Math.max(1e-9, instrumentedBlockMs)) * 100,
        1,
      ),
      topStatements: readStatements.slice(0, 8).map((stat) => ({
        sql: stat.sql,
        kind: stat.kind,
        calls: stat.calls,
        ms: roundTo(stat.ms),
        rows: stat.rows,
      })),
    },
    loadSnapshot: {
      sinks: sinks.length,
      wallMsPerSink: summarize(perSinkMs.map((entry) => entry.ms)),
      statementsTotal,
      statementsPerSink: {
        mean: roundTo(statementsTotal / Math.max(1, sinks.length), 1),
        max: Math.max(0, ...perSinkStatements.values()),
      },
      overBudgetSinks: perSinkMs.filter((entry) => entry.ms > SYNC_BLOCK_BUDGET_MS).length,
      worstSinks,
    },
    wakeManagedSeat: {
      nodeId: wakeNodeId,
      iterations: wakeTiming.wall.samples,
      wallMs: wakeTiming.wall,
      cpuMsPerCall: wakeTiming.cpuMsPerIteration,
      breakdownMs: {
        canvasRead: roundTo(stepMs.canvasRead),
        activeActorRefs: roundTo(stepMs.activeActorRefs),
        stationScope: roundTo(stepMs.stationScope),
        registryCompile: roundTo(stepMs.registryCompile),
      },
    },
    budget: {
      syncBlockBudgetMs: SYNC_BLOCK_BUDGET_MS,
      canvasReadOverBudget: roundTo(readP50 / SYNC_BLOCK_BUDGET_MS, 1),
      worstSinkOverBudget: roundTo(worstSink / SYNC_BLOCK_BUDGET_MS, 1),
      targetEventsPerSecond: TARGET_EVENTS_PER_SECOND,
      msOfWorkPerSecondAtTarget: roundTo(readP50 * TARGET_EVENTS_PER_SECOND, 1),
      coresRequiredAtTarget: roundTo((readP50 * TARGET_EVENTS_PER_SECOND) / 1000, 2),
    },
  };
};
