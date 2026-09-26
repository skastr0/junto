import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { SquadRepository, SquadRepositoryLive } from "../src/main/junto/squads/repository";
import type { SquadBody } from "../src/shared/squads";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<SquadRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-squads-"));
  runtime = ManagedRuntime.make(
    SquadRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, SquadRepository>) => runtime.runPromise(effect);
const failure = <A, E>(effect: Effect.Effect<A, E, SquadRepository>) =>
  runtime.runPromise(Effect.flip(effect));

const body = (name = "Scout"): SquadBody => ({
  seats: [
    {
      key: "s0",
      profile: { name, harness: "claude", model: "opus" },
      dx: 0,
      dy: 0,
      width: 280,
      height: 180,
    },
  ],
  edges: [],
  prompt: "Say hello.",
});

describe("SquadRepository", () => {
  it("saves, lists by name, and replaces a squad", async () => {
    const listed = await run(
      Effect.gen(function* () {
        const r = yield* SquadRepository;
        const zeta = yield* r.save({ name: "  zeta  ", body: body() });
        yield* r.save({ name: "alpha", body: body() });
        yield* r.save({ squadId: zeta.squadId, name: "zeta", body: body("Builder") });
        return yield* r.list();
      }),
    );
    expect(listed.map((squad) => squad.name)).toEqual(["alpha", "zeta"]);
    expect(listed[1]?.seats[0]?.profile.name).toBe("Builder");
    expect(listed[1]?.prompt).toBe("Say hello.");
  });

  it("refuses a taken name regardless of case, a blank name, and a bad template", async () => {
    await run(Effect.flatMap(SquadRepository, (r) => r.save({ name: "Review", body: body() })));
    const taken = await failure(Effect.flatMap(SquadRepository, (r) => r.save({ name: "review", body: body() })));
    expect(taken).toMatchObject({ _tag: "SquadRefused", message: "a squad named review already exists" });
    const blank = await failure(Effect.flatMap(SquadRepository, (r) => r.save({ name: "  ", body: body() })));
    expect(blank._tag).toBe("SquadRefused");
    const empty = await failure(
      Effect.flatMap(SquadRepository, (r) => r.save({ name: "Empty", body: { seats: [], edges: [] } })),
    );
    expect(empty).toMatchObject({ _tag: "SquadRefused", message: "the squad template is not valid" });
  });

  it("renames and deletes, refusing a squad that is gone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const r = yield* SquadRepository;
        const squad = yield* r.save({ name: "One", body: body() });
        const renamed = yield* r.rename(squad.squadId, "Two");
        yield* r.remove(squad.squadId);
        return { renamed, after: yield* r.list() };
      }),
    );
    expect(result.renamed.name).toBe("Two");
    expect(result.after).toEqual([]);
    const gone = await failure(Effect.flatMap(SquadRepository, (r) => r.remove("squad-missing")));
    expect(gone).toMatchObject({ _tag: "SquadRefused", message: "that squad no longer exists" });
  });

  it("skips a stored body a later build can no longer read", async () => {
    await run(Effect.flatMap(SquadRepository, (r) => r.save({ name: "Good", body: body() })));
    await runtime.dispose();
    const database = new DatabaseSync(join(root, "junto.db"));
    database
      .prepare("INSERT INTO squads(squad_id, name, body_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
      .run("squad-old", "Old", JSON.stringify({ seats: "not a list" }));
    database.close();
    runtime = ManagedRuntime.make(
      SquadRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))),
    );
    const listed = await run(Effect.flatMap(SquadRepository, (r) => r.list()));
    expect(listed.map((squad) => squad.name)).toEqual(["Good"]);
  });

  it("lists a squad saved before profiles, its seats read as profiles", async () => {
    await run(Effect.flatMap(SquadRepository, (r) => r.list()));
    await runtime.dispose();
    const database = new DatabaseSync(join(root, "junto.db"));
    database
      .prepare("INSERT INTO squads(squad_id, name, body_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
      .run("squad-legacy", "Legacy", JSON.stringify({
        seats: [{
          key: "s0",
          harness: "codex",
          label: "builder",
          entityName: "local:codex",
          host: "local",
          launch: { argv: ["codex", "-m", "gpt-5"], cwd: "~/src" },
          dx: 0,
          dy: 0,
          width: 280,
          height: 180,
        }],
        edges: [],
      }));
    database.close();
    runtime = ManagedRuntime.make(
      SquadRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))),
    );
    const [legacy] = await run(Effect.flatMap(SquadRepository, (r) => r.list()));
    expect(legacy?.seats[0]?.profile).toMatchObject({ name: "builder", harness: "codex" });
  });

  it("keeps unknown harness and verb strings for placement to judge", async () => {
    const squad = await run(
      Effect.flatMap(SquadRepository, (r) =>
        r.save({
          name: "Future",
          body: {
            ...body(),
            seats: [{ ...body().seats[0]!, profile: { name: "Scout", harness: "harness-from-later" } }],
            edges: [{ from: "s0", to: "s0", verb: "verb-from-later" }],
          },
        }),
      ),
    );
    expect(squad.seats[0]?.profile.harness).toBe("harness-from-later");
    expect(squad.edges[0]?.verb).toBe("verb-from-later");
  });
});
