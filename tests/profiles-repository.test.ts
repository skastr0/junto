import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ProfileRepository, ProfileRepositoryLive } from "../src/main/junto/profiles/repository";
import { SeatGuidanceRepository, SeatGuidanceRepositoryLive } from "../src/main/junto/seat-guidance/repository";
import type { AgentProfileBody } from "../src/shared/agent-profiles";

type Stores = ProfileRepository | SeatGuidanceRepository;
let root: string;
let runtime: ManagedRuntime.ManagedRuntime<Stores, unknown>;

const make = () =>
  ManagedRuntime.make(
    Layer.mergeAll(ProfileRepositoryLive, SeatGuidanceRepositoryLive).pipe(
      Layer.provide(makeStateEngineLive(join(root, "junto.db"))),
    ),
  );

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-profiles-"));
  runtime = make();
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, Stores>) => runtime.runPromise(effect);
const failure = <A, E>(effect: Effect.Effect<A, E, Stores>) => runtime.runPromise(Effect.flip(effect));

const body = (name = "Reviewer"): AgentProfileBody => ({
  name,
  harness: "claude",
  model: "opus",
  effort: "high",
  soul: "Careful.",
});

describe("ProfileRepository", () => {
  it("saves, lists by name, replaces, renames, and deletes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const r = yield* ProfileRepository;
        const zed = yield* r.save({ body: body("Zed") });
        yield* r.save({ body: body("Ada") });
        yield* r.save({ profileId: zed.profileId, body: { ...body("Zed"), model: "sonnet" } });
        const renamed = yield* r.rename(zed.profileId, "  Zoe  ");
        const listed = yield* r.list();
        yield* r.remove(zed.profileId);
        return { renamed, listed, after: yield* r.list() };
      }),
    );
    expect(result.listed.map((p) => [p.name, p.model])).toEqual([["Ada", "opus"], ["Zoe", "sonnet"]]);
    expect(result.renamed).toMatchObject({ name: "Zoe", soul: "Careful." });
    expect(result.after.map((p) => p.name)).toEqual(["Ada"]);
  });

  it("refuses a taken name regardless of case, a body without essentials, and a gone profile", async () => {
    await run(Effect.flatMap(ProfileRepository, (r) => r.save({ body: body("Reviewer") })));
    const taken = await failure(Effect.flatMap(ProfileRepository, (r) => r.save({ body: body("reviewer") })));
    expect(taken).toMatchObject({ _tag: "ProfileRefused", message: "a profile named reviewer already exists" });
    const bare = await failure(
      Effect.flatMap(ProfileRepository, (r) => r.save({ body: { name: "No harness" } as unknown as AgentProfileBody })),
    );
    expect(bare._tag).toBe("ProfileRefused");
    const gone = await failure(Effect.flatMap(ProfileRepository, (r) => r.remove("profile-missing")));
    expect(gone).toMatchObject({ _tag: "ProfileRefused", message: "that profile no longer exists" });
  });

  it("skips a stored body a later build can no longer read", async () => {
    await run(Effect.flatMap(ProfileRepository, (r) => r.save({ body: body("Good") })));
    await runtime.dispose();
    const database = new DatabaseSync(join(root, "junto.db"));
    database
      .prepare("INSERT INTO agent_profiles(profile_id, name, body_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
      .run("profile-old", "Old", JSON.stringify({ harness: 42 }));
    database.close();
    runtime = make();
    const listed = await run(Effect.flatMap(ProfileRepository, (r) => r.list()));
    expect(listed.map((p) => p.name)).toEqual(["Good"]);
  });
});

describe("SeatGuidanceRepository", () => {
  it("sets, reads, lists, and clears one seat's soul and instructions", async () => {
    const result = await run(
      Effect.gen(function* () {
        const r = yield* SeatGuidanceRepository;
        const stored = yield* r.set("agent-1", { soul: " Calm. ", instructions: "" });
        yield* r.set("agent-2", { instructions: "Test first." });
        const one = yield* r.get("agent-1");
        const cleared = yield* r.set("agent-2", { soul: "", instructions: " " });
        return { stored, one, cleared, all: yield* r.list() };
      }),
    );
    expect(result.stored).toEqual({ soul: "Calm." });
    expect(result.one).toEqual({ soul: "Calm." });
    expect(result.cleared).toBeNull();
    expect(result.all).toEqual({ "agent-1": { soul: "Calm." } });
  });

  it("refuses over-long text with the reason and changes nothing", async () => {
    const refused = await failure(
      Effect.flatMap(SeatGuidanceRepository, (r) => r.set("agent-1", { soul: "s".repeat(4001) })),
    );
    expect(refused._tag).toBe("SeatGuidanceRefused");
    expect(await run(Effect.flatMap(SeatGuidanceRepository, (r) => r.get("agent-1")))).toBeNull();
  });
});
