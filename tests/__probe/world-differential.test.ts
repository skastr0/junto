/**
 * MEMORY vs SQLITE ON A REAL DATABASE. `GATE_PROBE=1` guarded.
 *
 * `tests/work-world.test.ts` proves equivalence on a canvas this repository
 * builds. That canvas is exactly as rich as I thought to make it. This probe
 * asks the same question of a database nobody designed for the test — the
 * operator's own, or a generated fixture at scale — where the sinks, the
 * archived rows, the receipts and the pads are whatever twenty days of real
 * use left behind.
 *
 * It asserts three things per canvas:
 *
 *   1. BOOT HYDRATION — a world that has never seen this database serves,
 *      sink for sink, exactly what the SQLite read path builds.
 *   2. INCREMENTAL — after a real message append through the real write path,
 *      the world still equals SQLite, and re-read only the announced sink.
 *   3. RESIDENT — a second read with nothing changed touches no sink at all.
 *
 * Run it against a COPY. It appends real work records.
 *
 *   GATE_PROBE=1 WORLD_DB=<path/to/vellum-command.db> \
 *     npx vitest run tests/__probe/world-differential.test.ts
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { describe, it, expect } from "vitest";
import { StateEngine } from "../../src/main/vellum/state/service";
import {
  WorkRepository,
  readCanvasWorkProjection,
  readCanvasWorkRevision,
} from "../../src/main/vellum/work/repository";
import { makeWorkWorld } from "../../src/main/vellum/work/world";
import { IntentFactBasis } from "../../src/shared/work-protocol";
import { ActorSeatId } from "../../src/shared/actor-seat";
import { openBenchRuntime } from "../scale-bench/fixture";

const enabled = process.env.GATE_PROBE === "1";
const SOURCE = process.env.WORLD_DB;

const line = (record: unknown): void => {
  console.log(JSON.stringify(record));
};

describe.skipIf(!enabled || SOURCE === undefined)(
  "in-memory world vs SQLite, on a real database",
  () => {
    it("serves boot hydration, one append, and a resident read identically", async () => {
      const root = join(tmpdir(), `vellum-world-diff-${randomUUID()}`);
      mkdirSync(join(root, "state"), { recursive: true });
      const databasePath = join(root, "state", "vellum-command.db");
      cpSync(SOURCE as string, databasePath);
      const handle = openBenchRuntime({ root, databasePath });
      const world = makeWorkWorld();
      try {
        const state = await handle.runtime.runPromise(StateEngine);
        const repository = await handle.runtime.runPromise(WorkRepository);

        const canvases = await handle.runtime.runPromise(
          state.read("probe.canvases", (reader) =>
            reader
              .all<{ readonly canvas_name: string }>(
                `SELECT canvas_name FROM work_canvas_revisions ORDER BY canvas_name`,
              )
              .map((row) => row.canvas_name),
          ),
        );
        expect(canvases.length).toBeGreaterThan(0);

        const readBoth = (canvasName: string) =>
          handle.runtime.runPromise(
            state.read("probe.world-differential", (reader) => {
              const workRevision = readCanvasWorkRevision(reader, canvasName);
              const startMemory = performance.now();
              const memory = world.projection(reader, canvasName, workRevision);
              const memoryMs = performance.now() - startMemory;
              const startSqlite = performance.now();
              const sqlite = readCanvasWorkProjection(reader, canvasName);
              const sqliteMs = performance.now() - startSqlite;
              return { workRevision, memory, sqlite, memoryMs, sqliteMs };
            }),
          );

        // 1. BOOT HYDRATION.
        for (const canvasName of canvases) {
          const before = world.stats();
          const read = await readBoth(canvasName);
          expect(read.memory.workRevision).toBe(read.sqlite.workRevision);
          expect(read.memory.snapshots).toEqual(read.sqlite.snapshots);
          const after = world.stats();
          line({
            phase: "hydrate",
            canvas: canvasName,
            sinks: read.sqlite.snapshots.length,
            hydrated: after.hydrate - before.hydrate,
            memoryMs: Number(read.memoryMs.toFixed(3)),
            sqliteMs: Number(read.sqliteMs.toFixed(3)),
          });
        }

        // 2. RESIDENT — nothing changed.
        for (const canvasName of canvases) {
          const before = world.stats();
          const read = await readBoth(canvasName);
          expect(read.memory.snapshots).toEqual(read.sqlite.snapshots);
          const after = world.stats();
          expect(after.resident - before.resident).toBe(1);
          expect(after.sinksReloaded).toBe(before.sinksReloaded);
          line({
            phase: "resident",
            canvas: canvasName,
            memoryMs: Number(read.memoryMs.toFixed(3)),
            sqliteMs: Number(read.sqliteMs.toFixed(3)),
          });
        }

        // 3. INCREMENTAL — one real append on the busiest mailbox sink.
        const busiest = await handle.runtime.runPromise(
          state.read("probe.busiest", (reader) =>
            reader.get<{
              readonly canvas_name: string;
              readonly node_id: string;
              readonly n: number;
            }>(
              `SELECT canvas_name, node_id, count(*) AS n
               FROM work_messages GROUP BY canvas_name, node_id
               ORDER BY n DESC LIMIT 1`,
            ),
          ),
        );
        if (busiest === undefined) {
          line({ phase: "incremental", skipped: "no mailbox sink" });
          return;
        }
        const witness = await handle.runtime.runPromise(
          state.read("probe.witness", (reader) =>
            reader.get<{
              readonly generation: string;
              readonly intent_sha256: string;
            }>(
              `SELECT generation, intent_sha256 FROM canvas_generations
               WHERE generation = (
                 SELECT generation FROM canvas_head WHERE singleton = 1
               )`,
            ),
          ),
        );
        expect(witness).toBeDefined();
        const basis = Schema.decodeUnknownSync(IntentFactBasis, {
          onExcessProperty: "error",
        })({
          kind: "authorial-intent",
          generation: (witness as { readonly generation: string }).generation,
          contentSha256: (witness as { readonly intent_sha256: string })
            .intent_sha256,
        });
        const sink = {
          canvasName: busiest.canvas_name,
          nodeId: busiest.node_id,
        };
        const at = new Date().toISOString();
        for (let round = 0; round < 3; round += 1) {
          const before = world.stats();
          await handle.runtime.runPromise(
            repository.appendMessage({
              sink,
              basis,
              message: {
                messageId: `world-probe-${round}-${randomUUID()}`,
                role: "agent",
                parts: [{ kind: "text", text: "world differential probe" }],
                contextId: sink.canvasName,
              },
              sentBy: {
                seatId: Schema.decodeUnknownSync(ActorSeatId)(
                  `seat_${"a".repeat(64)}`,
                ),
                canvasName: sink.canvasName,
                nodeId: sink.nodeId,
              },
              destination: { kind: "mailbox" },
              originAt: at,
              receivedAt: at,
            }),
          );
          const read = await readBoth(sink.canvasName);
          expect(read.memory.workRevision).toBe(read.sqlite.workRevision);
          expect(read.memory.snapshots).toEqual(read.sqlite.snapshots);
          const after = world.stats();
          expect(after.hydrate).toBe(before.hydrate);
          expect(after.sinksReloaded - before.sinksReloaded).toBe(1);
          line({
            phase: "incremental",
            canvas: sink.canvasName,
            node: sink.nodeId,
            messagesOnSink: busiest.n + round + 1,
            sinksReloaded: after.sinksReloaded - before.sinksReloaded,
            memoryMs: Number(read.memoryMs.toFixed(3)),
            sqliteMs: Number(read.sqliteMs.toFixed(3)),
          });
        }
        line({ phase: "stats", ...world.stats() });
      } finally {
        world.close();
        await handle.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    }, 600_000);
  },
);
