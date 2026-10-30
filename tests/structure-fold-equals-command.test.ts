/**
 * The fold equals the command (docs/plans/0.11/06-fleet-state.md, F4): the
 * authority judges a canvas command in a savepoint it rolls back, keeps each
 * change it made as a `structure.changed` entry, and every listed machine
 * writes that change through `ModelService.fold`. So for any sequence of
 * canvas commands two stores must end the same:
 *
 * - direct: the command writes the canvas, as the editing machine does today;
 * - judged: the command runs with `StructureCapture` set inside a transaction
 *   that is rolled back, and the captured changes are then folded.
 *
 * Same rows, same count, and the same changes published in the same order.
 * A fold that does not follow the canvas count exactly is refused, never
 * skipped past.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { FastCheck as fc } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { StructureCapture } from "../src/main/junto/model/structure-capture";
import { PausePlaneLive } from "../src/main/junto/pause-plane-live";
import { FactoryPauseRepositoryLive } from "../src/main/junto/pause/repository";
import { ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import { SeatGuidanceRepositoryLive } from "../src/main/junto/seat-guidance/repository";
import { makeSettingsLive } from "../src/main/junto/settings/service";
import { AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import type { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, asNodeId, asWireId, type Changed, type Command } from "../src/shared/model";
import { note, seat, wire } from "./support/model-nodes";
import { ModelStoresLive } from "./support/seed-canvas";

const CANVAS = asCanvasName("factory");
const SELF = "mini" as InstallationId;
// CI replays the pinned seed; a nightly sweeps wider with JUNTO_FOLD_SEED and JUNTO_FOLD_RUNS.
const SEED = Number(process.env.JUNTO_FOLD_SEED ?? 20261029);
const RUNS = Number(process.env.JUNTO_FOLD_RUNS ?? 1);
const BUDGET_MS = 120_000;

type Store = {
  readonly root: string;
  readonly runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient | ModelService, unknown>;
  readonly published: Array<Changed>;
};
const stores: Array<Store> = [];

const makeStore = async (): Promise<Store> => {
  const root = await mkdtemp(join(tmpdir(), "junto-structure-fold-"));
  const runtime = ManagedRuntime.make(
    Layer.provideMerge(
      ModelStoresLive,
      Layer.provideMerge(
        Layer.mergeAll(
          WorkRepositoryLive,
          CrewRepositoryLive,
          makeSettingsLive(),
          makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
          SeatGuidanceRepositoryLive,
          AgentSignalRepositoryLive,
          ReferencesRepositoryLive,
          Layer.provideMerge(PausePlaneLive, FactoryPauseRepositoryLive),
          makeMachineRepositoryLive({ defaultName: () => SELF, makeInstallationId: () => SELF }),
        ),
        Layer.mergeAll(makeStateEngineLive(join(root, "junto.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
      ),
    ),
  ) as Store["runtime"];
  const store: Store = { root, runtime, published: [] };
  stores.push(store);
  await runtime.runPromise(
    Effect.gen(function* () {
      const model = yield* ModelService;
      yield* model.command({ _tag: "CreateCanvas", canvas: CANVAS }, "operator");
      model.subscribeChanges((event) => store.published.push(event));
    }),
  );
  return store;
};

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.runtime.dispose();
    await rm(store.root, { recursive: true, force: true });
  }
});

class Judged {
  readonly _tag = "Judged";
}

/** The command as the editing machine runs it. A refusal changes nothing, on either path. */
const direct = (store: Store, command: Command) =>
  store.runtime.runPromise(Effect.flatMap(ModelService, (model) => Effect.exit(model.command(command, "operator"))));

/** The command judged and rolled back, then each change it made folded, as every listed machine applies its entries. */
const judged = (store: Store, command: Command) =>
  store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const model = yield* ModelService;
      const changes: Array<Changed> = [];
      const exit = yield* Effect.exit(
        sql.withTransaction(Effect.flatMap(model.command(command, "operator"), () => Effect.fail(new Judged()))).pipe(
          Effect.provideService(StructureCapture, (change) => changes.push(change)),
        ),
      );
      if (Exit.isFailure(exit) && !(Cause.squash(exit.cause) instanceof Judged)) return exit;
      yield* sql.withTransaction(Effect.forEach(changes, (change) => model.fold(change), { discard: true }));
      return Exit.void;
    }),
  );

/** Every table, as sorted rows. */
const tablesOf = (store: Store) =>
  store.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const names = (yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .map((row) => row.name);
      const tables: Record<string, ReadonlyArray<string>> = {};
      for (const name of names) {
        const rows = yield* sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`);
        // Times and the canvas's minted id differ between any two stores; nothing else may.
        const kept = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !key.endsWith("_at") && key !== "canvas_id")));
        if (rows.length > 0) tables[name] = kept.map((row) => JSON.stringify(row)).sort();
      }
      return tables;
    }),
  );

const SEATS = ["a", "b", "c"] as const;
const NOTES = ["n1", "n2"] as const;
const id = fc.constantFrom(...SEATS, ...NOTES);
const command: fc.Arbitrary<Command> = fc.oneof(
  fc.constantFrom(...SEATS).map((at): Command => ({ _tag: "Add", canvas: CANVAS, nodes: [seat(at)], wires: [] })),
  fc.constantFrom(...NOTES).map((at): Command => ({ _tag: "Add", canvas: CANVAS, nodes: [note(at)], wires: [] })),
  fc.tuple(fc.constantFrom(...SEATS), fc.constantFrom(...SEATS)).map(([from, to]): Command =>
    ({ _tag: "Add", canvas: CANVAS, nodes: [], wires: [wire(`${from}-${to}`, from, to, "messages")] })),
  fc.uniqueArray(id, { minLength: 1, maxLength: 3 }).map((ids): Command => ({ _tag: "Remove", canvas: CANVAS, nodes: ids.map(asNodeId), wires: [] })),
  fc.tuple(fc.constantFrom(...SEATS), fc.constantFrom(...SEATS)).map(([from, to]): Command =>
    ({ _tag: "Remove", canvas: CANVAS, nodes: [], wires: [asWireId(`${from}-${to}`)] })),
  fc.tuple(id, fc.integer({ min: -400, max: 400 }), fc.integer({ min: -400, max: 400 })).map(([at, x, y]): Command =>
    ({ _tag: "Move", canvas: CANVAS, moves: [{ id: asNodeId(at), x, y }] })),
  fc.tuple(fc.constantFrom(...NOTES), fc.string({ maxLength: 12 })).map(([at, text]): Command =>
    ({ _tag: "Edit", canvas: CANVAS, id: asNodeId(at), change: { kind: "note", text } })),
  fc.tuple(fc.uniqueArray(id, { minLength: 1, maxLength: 2 }), fc.constantFrom("front", "back") as fc.Arbitrary<"front" | "back">).map(([ids, to]): Command =>
    ({ _tag: "Restack", canvas: CANVAS, nodes: ids.map(asNodeId), to })),
  fc.constantFrom(...SEATS).map((at): Command => ({ _tag: "GrantOverseer", canvas: CANVAS, id: asNodeId(at), overseer: true })),
  fc.constantFrom(...SEATS).map((at): Command => ({ _tag: "GrantOverseer", canvas: CANVAS, id: asNodeId(at), overseer: false })),
);

describe("a structure entry folds as its command wrote it", () => {
  it(
    "directly, and judged then folded: the same rows, count and published changes",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 14 }), async (commands) => {
          const one = await makeStore();
          const two = await makeStore();
          for (const step of commands) {
            const wrote = await direct(one, step);
            const folded = await judged(two, step);
            // A refusal on one path is a refusal on the other; an answer is the same answer.
            expect(Exit.isSuccess(folded)).toBe(Exit.isSuccess(wrote));
          }
          expect(await tablesOf(two)).toEqual(await tablesOf(one));
          expect(two.published).toEqual(one.published);
          for (const store of stores.splice(0)) {
            await store.runtime.dispose();
            await rm(store.root, { recursive: true, force: true });
          }
        }),
        { numRuns: 20 * RUNS, seed: SEED, interruptAfterTimeLimit: BUDGET_MS * RUNS, markInterruptAsFailure: true },
      );
    },
    BUDGET_MS * RUNS + 60_000,
  );

  it("refuses a change that does not follow the canvas count, and writes nothing", async () => {
    const store = await makeStore();
    const before = await tablesOf(store);
    const seq = await store.runtime.runPromise(Effect.map(Effect.flatMap(ModelService, (model) => model.canvas(CANVAS)), (canvas) => canvas.seq));
    const change = (at: number): Changed => ({ canvas: CANVAS, seq: at, nodes: [note("n1")], wires: [], removedNodes: [], removedWires: [] });
    for (const at of [seq, seq + 2]) {
      const exit = await store.runtime.runPromiseExit(Effect.flatMap(ModelService, (model) => model.fold(change(at))));
      expect(exit._tag).toBe("Failure");
      expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : "")).toMatch(/does not follow/);
    }
    expect(await tablesOf(store)).toEqual(before);
    expect(store.published).toEqual([]);
    expect(await store.runtime.runPromise(Effect.flatMap(ModelService, (model) => model.fold(change(seq + 1))))).toBe(seq + 1);
    expect(store.published.map((event) => event.seq)).toEqual([seq + 1]);
  });
});
