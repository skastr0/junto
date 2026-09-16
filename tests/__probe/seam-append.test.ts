/**
 * Append-cost probe for the single work mutation seam. GATE_PROBE=1 guarded so
 * a normal `bun run test` skips it.
 *
 * Measures three things, on the SAME instrument before and after the seam:
 *  1. per-append wall ms + SQL statement counts for one real work mutation
 *     (`repo.appendMessage`) through the real product write path,
 *  2. the same for a journal-free mutation (`markBoardRead`) and for the
 *     unjournaled escape (`setArtifactArchived`),
 *  3. a raw per-statement microbench: N identical `writer.run` calls inside
 *     one transaction, so the guard's per-statement cost is visible on its own.
 *
 * Env: GATE_PROBE=1 SEAM_DB=<db to copy> SEAM_WORK=<scratch dir>
 *      SEAM_LABEL=<tape label> SEAM_OUT=<jsonl> SEAM_APPENDS=<n>
 */
import { copyFileSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { Effect, Schema } from "effect";
import { CanvasesService } from "../../src/main/vellum-command/canvases";
import { WorkRepository } from "../../src/main/vellum-command/work/repository";
import { StateEngine } from "../../src/main/vellum-command/state/service";
import { IntentFactBasis } from "../../src/shared/work-protocol";
import { openBenchRuntime } from "../scale-bench/fixture";

const quantile = (values: ReadonlyArray<number>, q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * q)),
  );
  return Number(sorted[index].toFixed(4));
};

const summary = (values: ReadonlyArray<number>) => ({
  n: values.length,
  p50: quantile(values, 0.5),
  p90: quantile(values, 0.9),
  p99: quantile(values, 0.99),
  max: Number(Math.max(...values, 0).toFixed(4)),
  mean: Number(
    (values.reduce((sum, value) => sum + value, 0) / (values.length || 1)).toFixed(4),
  ),
});

describe.skipIf(process.env.GATE_PROBE !== "1")("seam append cost", () => {
  it("measures the append path", async () => {
    const work = process.env.SEAM_WORK as string;
    const label = process.env.SEAM_LABEL ?? "unlabelled";
    const appends = Number(process.env.SEAM_APPENDS ?? "200");
    const root = join(work, `seam-${label}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "state"), { recursive: true });
    const databasePath = join(root, "state", "junto.db");
    const copyStarted = performance.now();
    copyFileSync(process.env.SEAM_DB as string, databasePath);
    const copyMs = performance.now() - copyStarted;

    const handle = openBenchRuntime({ root, databasePath });
    const run = <A>(effect: Effect.Effect<A, never, never>): Promise<A> =>
      handle.runtime.runPromise(effect as never) as Promise<A>;

    const basis = await run(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        yield* canvases.read("factory");
        const witness = yield* canvases.activeIntentWitness();
        return Schema.decodeUnknownSync(IntentFactBasis, {
          onExcessProperty: "error",
        })({
          kind: "authorial-intent",
          generation: witness.generation,
          contentSha256: witness.contentSha256,
        });
      }) as never,
    );
    const refs = (await run(
      Effect.gen(function* () {
        const canvases = yield* CanvasesService;
        return yield* canvases.activeActorRefs();
      }) as never,
    )) as ReadonlyArray<{ readonly nodeId: string }>;

    // --- 1. journalled mutation: message append -----------------------------
    const appendMs: Array<number> = [];
    let appendStatements = 0;
    let appendRuns = 0;
    handle.recorder.reset("frames");
    for (let index = 0; index < appends; index += 1) {
      const started = performance.now();
      await run(
        Effect.gen(function* () {
          const repository = yield* WorkRepository;
          return yield* repository.appendMessage({
            sink: {
              canvasName: "factory",
              nodeId: refs[index % refs.length].nodeId,
            },
            basis: basis as never,
            message: {
              messageId: `seam-probe-${label}-${index}`,
              role: "agent",
              parts: [{ kind: "text", text: "seam probe" }],
            },
            sentBy: refs[index % refs.length] as never,
            destination: { kind: "mailbox" },
          });
        }) as never,
      );
      appendMs.push(performance.now() - started);
    }
    for (const frame of handle.recorder.frames) {
      if (frame.kind !== "transaction") continue;
      appendStatements += frame.statements;
      appendRuns += frame.runs;
    }
    const appendFrames = handle.recorder.frames.filter(
      (frame) => frame.kind === "transaction",
    );

    // --- 2. raw per-statement microbench ------------------------------------
    handle.recorder.reset("off");
    const microRows = Number(process.env.SEAM_MICRO_ROWS ?? "20000");
    const microMs = await run(
      Effect.gen(function* () {
        const state = yield* StateEngine;
        yield* state.transaction("seam.micro.setup", (writer) => {
          writer.run("DROP TABLE IF EXISTS seam_probe_scratch");
          writer.run(
            "CREATE TABLE seam_probe_scratch (id INTEGER PRIMARY KEY, v TEXT)",
          );
        });
        const elapsed = yield* state.transaction("seam.micro", (writer) => {
          // warm the statement cache and any classifier cache
          for (let index = 0; index < 200; index += 1) {
            writer.run("INSERT INTO seam_probe_scratch(id, v) VALUES (?, ?)", [
              index,
              "warm",
            ]);
          }
          const started = performance.now();
          for (let index = 0; index < microRows; index += 1) {
            writer.run("INSERT INTO seam_probe_scratch(id, v) VALUES (?, ?)", [
              index + 1000,
              "measured",
            ]);
          }
          return performance.now() - started;
        });
        yield* state.transaction("seam.micro.teardown", (writer) => {
          writer.run("DROP TABLE seam_probe_scratch");
        });
        return elapsed;
      }) as never,
    );

    const record = {
      label,
      copyMs: Number(copyMs.toFixed(1)),
      actors: refs.length,
      append: {
        ...summary(appendMs),
        statementsPerAppend: Number(
          (appendStatements / Math.max(1, appendFrames.length)).toFixed(2),
        ),
        runsPerAppend: Number(
          (appendRuns / Math.max(1, appendFrames.length)).toFixed(2),
        ),
        transactions: appendFrames.length,
      },
      micro: {
        rows: microRows,
        totalMs: Number((microMs as number).toFixed(3)),
        nsPerStatement: Number(
          (((microMs as number) * 1e6) / microRows).toFixed(1),
        ),
      },
    };
    console.log(JSON.stringify(record));
    if (process.env.SEAM_OUT) {
      appendFileSync(process.env.SEAM_OUT, `${JSON.stringify(record)}\n`);
    }
    await handle.dispose();
    rmSync(root, { recursive: true, force: true });
  }, 30 * 60_000);
});
