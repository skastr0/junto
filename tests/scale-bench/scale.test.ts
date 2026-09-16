/**
 * THE SCALE BENCHMARK — the before/after gate for the main-thread refactor.
 *
 * Skipped by default so `bun run test` stays fast. Run it explicitly:
 *
 *   JUNTO_SCALE_BENCH=1 \
 *   JUNTO_SCALE_BENCH_REAL_DB=/path/to/a/copy/of/vellum-command.db \
 *   npx vitest run tests/scale-bench/scale.test.ts --reporter=verbose
 *
 * Env:
 *   JUNTO_SCALE_BENCH=1          enable (required)
 *   JUNTO_SCALE_BENCH_SCALES     comma list of real,500,1000 (default: all)
 *   JUNTO_SCALE_BENCH_REAL_DB    operator database to COPY and measure
 *   JUNTO_SCALE_BENCH_DIR        fixture cache root (default <tmpdir>/vellum-scale-bench)
 *   JUNTO_SCALE_BENCH_OUT        JSONL file to append each record to
 *   JUNTO_SCALE_BENCH_REGEN=1    rebuild synthetic fixtures from scratch
 *
 * Output: exactly one JSON line per scale on stdout, so a before/after diff is
 * `diff <(jq -S . before.jsonl) <(jq -S . after.jsonl)`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BENCH_CANVAS_NAME,
  copyRealFixture,
  ensureSyntheticFixture,
  openBenchRuntime,
  probeShape,
  scaleNodeCount,
  type ScaleSpec,
} from "./fixture";
import { benchmarkScale, type BenchRecord } from "./measure";

const enabled = process.env.JUNTO_SCALE_BENCH === "1";
const requested = (process.env.JUNTO_SCALE_BENCH_SCALES ?? "real,500,1000")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const regenerate = process.env.JUNTO_SCALE_BENCH_REGEN === "1";
const outPath = process.env.JUNTO_SCALE_BENCH_OUT;
const SCALE_TIMEOUT_MS = 45 * 60_000;

/**
 * Synthetic scales are the operator's stated target shape, halved for the mid
 * scale. Per-sink depth is held constant across both so the difference between
 * them is node count alone.
 */
const SPEC_1000: ScaleSpec = {
  id: "synthetic-1000",
  label: "1000 nodes / 200 agents / 800 sinks / 50k messages",
  agents: 200,
  taskSinks: 400,
  requestSinks: 200,
  artifactSinks: 199,
  boardSinks: 1,
  regions: 0,
  labels: 0,
  messagesPerAgent: 250,
  receiptFraction: 0.6,
  tasksPerTaskSink: 20,
  requestsPerRequestSink: 5,
  artifactsPerArtifactSink: 10,
  topicsPerBoard: 8,
  postsPerTopic: 3,
  messageBytes: 1200,
};

const SPEC_500: ScaleSpec = {
  ...SPEC_1000,
  id: "synthetic-500",
  label: "500 nodes / 100 agents / 400 sinks / 25k messages",
  agents: 100,
  taskSinks: 200,
  requestSinks: 100,
  artifactSinks: 99,
};

const gitFacts = (): BenchRecord["git"] => {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim();
    return { head, dirty: status.length > 0 };
  } catch {
    return { head: "unknown", dirty: false };
  }
};

const emit = (record: BenchRecord): void => {
  const line = JSON.stringify(record);
  console.log(line);
  if (outPath !== undefined) appendFileSync(outPath, `${line}\n`);
};

const assertRecord = (record: BenchRecord): void => {
  expect(record.shape.nodes).toBeGreaterThan(0);
  expect(record.canvasRead.wallMs.p50Ms).toBeGreaterThan(0);
  expect(Number.isFinite(record.canvasRead.cpuMsPerCall)).toBe(true);
  expect(record.loadSnapshot.sinks).toBeGreaterThan(0);
  expect(record.loadSnapshot.statementsTotal).toBeGreaterThan(0);
  expect(record.wakeManagedSeat.wallMs.p50Ms).toBeGreaterThan(0);
};

const runSynthetic = async (spec: ScaleSpec): Promise<BenchRecord> => {
  const fixture = await ensureSyntheticFixture(spec, {
    regenerate,
    log: (line) => console.log(line),
  });
  const handle = openBenchRuntime({
    root: fixture.root,
    databasePath: fixture.databasePath,
  });
  try {
    const shape = await probeShape(handle, BENCH_CANVAS_NAME, fixture.databasePath);
    expect(shape.nodes).toBe(scaleNodeCount(spec));
    return await benchmarkScale({
      handle,
      scale: spec.id,
      label: spec.label,
      canvasName: BENCH_CANVAS_NAME,
      shape,
      git: gitFacts(),
      log: (line) => console.log(line),
    });
  } finally {
    await handle.dispose();
  }
};

describe.skipIf(!enabled)("scale benchmark", () => {
  it.skipIf(!requested.includes("real"))(
    "real operator canvas",
    async () => {
      const source = process.env.JUNTO_SCALE_BENCH_REAL_DB;
      if (source === undefined || !existsSync(source)) {
        throw new Error(
          "JUNTO_SCALE_BENCH_REAL_DB must point at a database file (it is copied, never opened in place)",
        );
      }
      const fixture = copyRealFixture(
        source,
        join(tmpdir(), "vellum-scale-bench-real"),
      );
      const handle = openBenchRuntime({
        root: fixture.root,
        databasePath: fixture.databasePath,
      });
      try {
        const canvasName = process.env.JUNTO_SCALE_BENCH_REAL_CANVAS ?? BENCH_CANVAS_NAME;
        const shape = await probeShape(handle, canvasName, fixture.databasePath);
        const record = await benchmarkScale({
          handle,
          scale: "real",
          label: `operator canvas "${canvasName}"`,
          canvasName,
          shape,
          git: gitFacts(),
          log: (line) => console.log(line),
        });
        assertRecord(record);
        emit(record);
      } finally {
        await handle.dispose();
      }
    },
    SCALE_TIMEOUT_MS,
  );

  it.skipIf(!requested.includes("500"))(
    "synthetic 500 nodes",
    async () => {
      const record = await runSynthetic(SPEC_500);
      assertRecord(record);
      emit(record);
    },
    SCALE_TIMEOUT_MS,
  );

  it.skipIf(!requested.includes("1000"))(
    "synthetic 1000 nodes / 200 agents / 800 sinks",
    async () => {
      const record = await runSynthetic(SPEC_1000);
      assertRecord(record);
      emit(record);
    },
    SCALE_TIMEOUT_MS,
  );
});
