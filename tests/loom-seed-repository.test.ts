/**
 * The loom seed store on the real state engine and the production DDL: a
 * meta row, one row per card and per wire, a save writes only its rows, and
 * a canvas's delete takes every part.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/core/state/engine";
import { LoomSeedRepository, LoomSeedRepositoryLive } from "../src/core/loom-seed/repository";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<LoomSeedRepository | SqlClient.SqlClient, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-loom-seed-"));
  runtime = ManagedRuntime.make(
    LoomSeedRepositoryLive.pipe(Layer.provideMerge(makeStateEngineLive(join(root, "junto.db")))),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO canvases (canvas_name, canvas_id, created_at, updated_at)
        VALUES ('main', 'canvas-main', 't', 't')`;
    }),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, LoomSeedRepository>) => runtime.runPromise(effect);

const meta = { routerVersion: 1, fingerprint: 9, specsKey: "a|b", geometryKey: 4 };
const card = { nodeId: "a", x: 0, y: 0, width: 216, height: 96, obstacle: true };
const wire = { wireId: "ab", specKey: "ab|a|right|b|left", fact: '{"id":"ab"}' };

describe("LoomSeedRepository", () => {
  it("keeps the seed in parts, and writes only what a save names", async () => {
    const empty = await run(Effect.gen(function* () {
      const store = yield* LoomSeedRepository;
      return yield* store.load("main");
    }));
    expect(empty).toEqual({ meta: undefined, cards: [], wires: [] });

    await run(Effect.gen(function* () {
      const store = yield* LoomSeedRepository;
      yield* store.save("main", { meta, cards: [card], wires: [wire], removedCards: [], removedWires: [] });
    }));
    const first = await run(Effect.gen(function* () {
      const store = yield* LoomSeedRepository;
      return yield* store.load("main");
    }));
    expect(first).toEqual({ meta, cards: [card], wires: [wire] });

    // A moved card and one wire: only those rows are written.
    const moved = { ...card, x: 40 };
    const wireTwo = { wireId: "bc", specKey: "bc|b|right|c|left", fact: '{"id":"bc"}' };
    await run(Effect.gen(function* () {
      const store = yield* LoomSeedRepository;
      yield* store.save("main", { meta: { ...meta, fingerprint: 10 }, cards: [moved], wires: [wireTwo], removedCards: [], removedWires: [] });
    }));
    const second = await run(Effect.gen(function* () {
      const store = yield* LoomSeedRepository;
      return yield* store.load("main");
    }));
    expect(second.meta).toEqual({ ...meta, fingerprint: 10 });
    expect(second.cards).toEqual([moved]);
    expect(second.wires.map((row) => row.wireId)).toEqual(["ab", "bc"]);
  });

  it("a canvas's delete takes every part", async () => {
    await run(Effect.gen(function* () {
      const store = yield* LoomSeedRepository;
      yield* store.save("main", { meta, cards: [card], wires: [wire], removedCards: [], removedWires: [] });
    }));
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM canvases WHERE canvas_name = 'main'`;
      }),
    );
    const after = await run(Effect.gen(function* () {
      const store = yield* LoomSeedRepository;
      return yield* store.load("main");
    }));
    expect(after).toEqual({ meta: undefined, cards: [], wires: [] });
  });
});
