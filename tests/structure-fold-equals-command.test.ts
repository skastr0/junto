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
import { Arbitrary, Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, describe, expect, it } from "vitest";
import { makeContentServiceLive } from "../src/core/content/service";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { makeMachineRepositoryLive } from "../src/core/machines/repository";
import { ModelService } from "../src/core/model/service";
import { StructureCapture } from "../src/core/model/structure-capture";
import { PausePlaneLive } from "../src/core/pause-plane-live";
import { FactoryPauseRepositoryLive } from "../src/core/pause/repository";
import { ReferencesRepositoryLive } from "../src/core/references/repository";
import { SeatGuidanceRepositoryLive } from "../src/core/seat-guidance/repository";
import { makeSettingsLive } from "../src/core/settings/service";
import { AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { WorkRepositoryLive } from "../src/core/work/repository";
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

/** A whole number from `min` to `max`, both included. */
const integer = (min: number, max: number) => Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: min, maximum: max })));

/** One of the values given. */
const constantFrom = <const A extends ReadonlyArray<unknown>>(...values: A): Arbitrary.Arbitrary<A[number]> =>
  Arbitrary.map(integer(0, values.length - 1), (index) => values[index] as A[number]);

/** One of the arbitraries given, each as likely as the others. */
const oneOf = <A>(...choices: ReadonlyArray<Arbitrary.Arbitrary<A>>): Arbitrary.Arbitrary<A> =>
  Arbitrary.flatMap(integer(0, choices.length - 1), (index) => choices[index] as Arbitrary.Arbitrary<A>);

/** Distinct items of `items`, in any order, from `minLength` to `maxLength` of them. */
const uniqueArray = <A>(items: ReadonlyArray<A>, minLength: number, maxLength: number): Arbitrary.Arbitrary<Array<A>> => {
  // The n-th pick takes one of the items still left, so no draw is thrown away for repeating one.
  const picks = Array.from({ length: items.length }, (_, taken) => integer(0, items.length - 1 - taken));
  return Arbitrary.flatMap(integer(minLength, Math.min(maxLength, items.length)), (length) =>
    Arbitrary.map(Arbitrary.all(picks.slice(0, length)), (indexes) => {
      const left = [...items];
      return indexes.map((index) => left.splice(index, 1)[0] as A);
    }));
};

/** A string of printable ASCII, at most `maxLength` characters. */
const text = (maxLength: number) =>
  Arbitrary.map(
    Arbitrary.array(constantFrom(...Array.from({ length: 95 }, (_, offset) => String.fromCharCode(0x20 + offset))), { maxLength }),
    (characters) => characters.join(""),
  );

/**
 * Checks a property under the pinned seed, and fails the test with the shrunk counterexample when it does not hold.
 * A property stops itself, as a failure, before its test times out: the case in flight finishes, and the next
 * one does not start past the budget.
 */
const holds = async <A>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => Promise<void>,
  { runs, size, budgetMs }: { readonly runs: number; readonly size: number; readonly budgetMs: number },
) => {
  const deadline = performance.now() + budgetMs;
  const result = await Effect.runPromise(
    Arbitrary.checkEffect(
      arbitrary,
      (value) =>
        Effect.gen(function* () {
          if (performance.now() > deadline) return yield* Effect.die(new Error(`the property ran past its budget of ${budgetMs} ms`));
          // A failed assertion is the property failing, so it shrinks and is reported with its input.
          yield* Effect.tryPromise({ try: () => property(value), catch: (error) => (error instanceof Error ? error.message : String(error)) });
          return true;
        }),
      { runs, size, seed: SEED },
    ),
  );
  const failure = Arbitrary.formatCheckFailure(result);
  if (failure !== undefined) throw new Error(failure);
};

const SEATS = ["a", "b", "c"] as const;
const NOTES = ["n1", "n2"] as const;
const seatOf = constantFrom(...SEATS);
const noteOf = constantFrom(...NOTES);
const ids = [...SEATS, ...NOTES];
const id = constantFrom(...ids);
const command: Arbitrary.Arbitrary<Command> = oneOf(
  Arbitrary.map(seatOf, (at): Command => ({ _tag: "Add", canvas: CANVAS, nodes: [seat(at)], wires: [] })),
  Arbitrary.map(noteOf, (at): Command => ({ _tag: "Add", canvas: CANVAS, nodes: [note(at)], wires: [] })),
  Arbitrary.map(Arbitrary.all([seatOf, seatOf]), ([from, to]): Command =>
    ({ _tag: "Add", canvas: CANVAS, nodes: [], wires: [wire(`${from}-${to}`, from, to, "messages")] })),
  Arbitrary.map(uniqueArray(ids, 1, 3), (picked): Command => ({ _tag: "Remove", canvas: CANVAS, nodes: picked.map(asNodeId), wires: [] })),
  Arbitrary.map(Arbitrary.all([seatOf, seatOf]), ([from, to]): Command =>
    ({ _tag: "Remove", canvas: CANVAS, nodes: [], wires: [asWireId(`${from}-${to}`)] })),
  Arbitrary.map(Arbitrary.all([id, integer(-400, 400), integer(-400, 400)]), ([at, x, y]): Command =>
    ({ _tag: "Move", canvas: CANVAS, moves: [{ id: asNodeId(at), x, y }] })),
  Arbitrary.map(Arbitrary.all([noteOf, text(12)]), ([at, body]): Command =>
    ({ _tag: "Edit", canvas: CANVAS, id: asNodeId(at), change: { kind: "note", text: body } })),
  Arbitrary.map(Arbitrary.all([uniqueArray(ids, 1, 2), constantFrom("front", "back")]), ([picked, to]): Command =>
    ({ _tag: "Restack", canvas: CANVAS, nodes: picked.map(asNodeId), to })),
  Arbitrary.map(seatOf, (at): Command => ({ _tag: "GrantOverseer", canvas: CANVAS, id: asNodeId(at), overseer: true })),
  Arbitrary.map(seatOf, (at): Command => ({ _tag: "GrantOverseer", canvas: CANVAS, id: asNodeId(at), overseer: false })),
);

describe("a structure entry folds as its command wrote it", () => {
  it(
    "directly, and judged then folded: the same rows, count and published changes",
    async () => {
      await holds(
        Arbitrary.array(command, { minLength: 1, maxLength: 14 }),
        async (commands) => {
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
        },
        { runs: 20 * RUNS, size: 14, budgetMs: BUDGET_MS * RUNS },
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
