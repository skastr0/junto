/** THROWAWAY — rows written vs rows read per event. GATE_PROBE=1 guarded. */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { Effect, Schema } from "effect";
import { CanvasesService } from "../../src/main/vellum/canvases";
import { WorkRepository } from "../../src/main/vellum/work/repository";
import { StateEngine } from "../../src/main/vellum/state/service";
import { IntentFactBasis } from "../../src/shared/work-protocol";
import { openBenchRuntime } from "../scale-bench/fixture";

describe.skipIf(process.env.GATE_PROBE !== "1")("amp", () => {
  it("counts rows written by one event and rows read by the read it forces", async () => {
    const root = join(process.env.GATE_WORK as string, "amp");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "state"), { recursive: true });
    const dbp = join(root, "state", "vellum-command.db");
    copyFileSync(process.env.GATE_REAL_DB as string, dbp);
    const h = openBenchRuntime({ root, databasePath: dbp });
    const counts = (label: string) =>
      h.runtime.runPromise(
        Effect.gen(function* () {
          const state = yield* StateEngine;
          return yield* state.read(`amp.${label}`, (r) => ({
            messages: r.get<{ n: number }>("SELECT count(*) AS n FROM work_messages")?.n ?? 0,
            facts: r.get<{ n: number }>("SELECT count(*) AS n FROM work_facts")?.n ?? 0,
            events: r.get<{ n: number }>("SELECT count(*) AS n FROM work_events")?.n ?? 0,
            receipts: r.get<{ n: number }>("SELECT count(*) AS n FROM work_delivery_receipts")?.n ?? 0,
            revision: r.get<{ n: string }>("SELECT CAST(revision AS TEXT) AS n FROM work_canvas_revisions WHERE canvas_name='factory'")?.n ?? "0",
          }));
        }) as never,
      ) as Promise<Record<string, number | string>>;
    const out = await (async () => {
      const before = await counts("before");
      const basis = await (h.runtime.runPromise(
        Effect.gen(function* () {
          const c = yield* CanvasesService;
          yield* c.read("factory");
          const w = yield* c.activeIntentWitness();
          return Schema.decodeUnknownSync(IntentFactBasis, { onExcessProperty: "error" })({
            kind: "authorial-intent",
            generation: w.generation,
            contentSha256: w.contentSha256,
          });
        }) as never,
      ) as Promise<unknown>);
      const refs = (await h.runtime.runPromise(
        Effect.gen(function* () {
          const c = yield* CanvasesService;
          return yield* c.activeActorRefs();
        }) as never,
      )) as ReadonlyArray<{ nodeId: string }>;
      h.recorder.reset("frames");
      await h.runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* WorkRepository;
          return yield* repo.appendMessage({
            sink: { canvasName: "factory", nodeId: refs[0].nodeId },
            basis: basis as never,
            message: { messageId: "amp-1", role: "agent", parts: [{ kind: "text", text: "x" }] },
            sentBy: refs[0] as never,
            destination: { kind: "mailbox" },
          });
        }) as never,
      );
      const writeFrames = h.recorder.frames.map((f) => ({
        op: f.operation, kind: f.kind, ms: f.ms, statements: f.statements, runs: f.runs, gets: f.gets, alls: f.alls, rows: f.rows,
      }));
      h.recorder.frames.length = 0;
      await h.runtime.runPromise(
        Effect.gen(function* () {
          const c = yield* CanvasesService;
          return yield* c.read("factory");
        }) as never,
      );
      const readFrames = h.recorder.frames.map((f) => ({
        op: f.operation, ms: f.ms, statements: f.statements, rows: f.rows,
      }));
      h.recorder.reset("off");
      const after = await counts("after");
      return { before, after, writeFrames, readFrames };
    })();
    writeFileSync(join(process.env.GATE_WORK as string, "amp.json"), JSON.stringify(out, null, 1));
    await h.dispose();
    rmSync(root, { recursive: true, force: true });
  }, 300000);
});
