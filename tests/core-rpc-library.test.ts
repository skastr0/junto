/**
 * The library group (src/contract/core/library.ts) answered by its handlers,
 * called through the group's own client over the real stores in a temp
 * folder: squads, agent profiles and seat guidance, a signal a preview
 * names, a page box comment's shot, and the pull of a signal's files. What
 * main normalizes before it asks is held here too: a squad or profile body
 * through its shared decoder, seat guidance through its normalizer.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, ManagedRuntime, Result, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibraryRpcs } from "../src/contract/core/library";
import { LibraryHandlers } from "../src/core/ops/ipc-library";
import { makeContentServiceLive } from "../src/core/content/service";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { ProfileRepositoryLive } from "../src/core/profiles/repository";
import { SeatGuidanceRepositoryLive } from "../src/core/seat-guidance/repository";
import { AgentSignalRepositoryLive } from "../src/core/signals/repository";
import { SquadRepositoryLive } from "../src/core/squads/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { WorkLive } from "../src/core/work/service";
import { decodeProfileBody } from "../src/shared/agent-profiles";
import { normalizeSeatGuidance } from "../src/shared/seat-guidance";
import { decodeSquadBody } from "../src/shared/squads";
import { ModelStoresLive } from "./support/seed-canvas";

const clientOf = () => RpcTest.makeClient(LibraryRpcs);

const machineAt = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
      AgentSignalRepositoryLive,
      SeatGuidanceRepositoryLive,
      SquadRepositoryLive,
      ProfileRepositoryLive,
    ),
    Layer.mergeAll(makeStateEngineLive(join(root, "state", "junto.db")), makeInstallOpsLive(join(root, "state", "install-ops.db"))),
  );
  return Layer.provideMerge(WorkLive, Layer.provideMerge(ModelStoresLive, repositoriesLive));
};

let dir: string;
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof machineAt>>, unknown>;
let scope: Scope.Closeable;
let library: Effect.Success<ReturnType<typeof clientOf>>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "junto-core-rpc-library-"));
  runtime = ManagedRuntime.make(machineAt(dir));
  scope = await Effect.runPromise(Scope.make());
  const handlers = await runtime.runPromise(Layer.buildWithScope(LibraryHandlers, scope));
  library = await runtime.runPromise(clientOf().pipe(Effect.provide(handlers), Effect.provideService(Scope.Scope, scope)));
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await runtime.dispose();
  await rm(dir, { recursive: true, force: true });
});

const ask = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const refusedWith = async <A>(effect: Effect.Effect<A, { readonly _tag: string; readonly message: string }>) => {
  const exit = await Effect.runPromise(Effect.result(effect));
  if (Result.isSuccess(exit)) throw new Error("the call was not refused");
  return exit.failure;
};

const squadBody = (name: string) => {
  const body = decodeSquadBody({
    seats: [{ key: "s0", profile: { name, harness: "claude" }, dx: 0, dy: 0, width: 120, height: 48 }],
    edges: [],
  });
  if (Result.isFailure(body)) throw new Error(body.failure);
  return body.success;
};

describe("the library group", () => {
  it("saves, lists, renames and removes squads, and refuses a taken name in words", async () => {
    expect(await ask(library.LibrarySquadsList())).toEqual([]);
    const saved = await ask(library.LibrarySquadSave({ name: "Review crew", body: squadBody("Ada") }));
    expect(saved).toMatchObject({ name: "Review crew", seats: [{ key: "s0", profile: { name: "Ada", harness: "claude" } }], edges: [] });
    expect((await refusedWith(library.LibrarySquadSave({ name: "review crew", body: squadBody("Bo") })))).toMatchObject({
      _tag: "LibraryRefused",
      message: "a squad named review crew already exists",
    });
    const renamed = await ask(library.LibrarySquadRename({ squadId: saved.squadId, name: "Build crew" }));
    expect(renamed.name).toBe("Build crew");
    expect((await ask(library.LibrarySquadsList())).map((squad) => squad.name)).toEqual(["Build crew"]);
    expect(await ask(library.LibrarySquadRemove({ squadId: saved.squadId }))).toBe(saved.squadId);
    expect(await refusedWith(library.LibrarySquadRemove({ squadId: saved.squadId }))).toMatchObject({
      message: "that squad no longer exists",
    });
  });

  it("saves, lists, renames and removes agent profiles, with the character it carries", async () => {
    const body = decodeProfileBody({ name: "Ada", harness: "claude", model: "opus", portrait: { shape: "toast", eyes: "dot" } });
    if (body === null) throw new Error("the body did not decode");
    const saved = await ask(library.LibraryProfileSave({ body }));
    expect(saved).toMatchObject({ name: "Ada", harness: "claude", model: "opus", portrait: { shape: "toast", eyes: "dot" } });
    expect(await refusedWith(library.LibraryProfileSave({ body }))).toMatchObject({ message: "a profile named Ada already exists" });
    const renamed = await ask(library.LibraryProfileRename({ profileId: saved.profileId, name: "Grace" }));
    expect(renamed.name).toBe("Grace");
    expect((await ask(library.LibraryProfilesList())).map((profile) => profile.name)).toEqual(["Grace"]);
    expect(await ask(library.LibraryProfileRemove({ profileId: saved.profileId }))).toBe(saved.profileId);
    expect(await ask(library.LibraryProfilesList())).toEqual([]);
  });

  it("stores one seat's guidance, clears it with nothing, and lists what is held", async () => {
    expect(await ask(library.LibraryGuidanceList())).toEqual({});
    const normalized = normalizeSeatGuidance({ soul: "  Dry and exact.  ", instructions: "Ask before you delete." });
    if (!normalized.ok) throw new Error(normalized.message);
    expect(await ask(library.LibraryGuidanceSet({ seatId: "seat-a", guidance: normalized.guidance }))).toEqual({
      soul: "Dry and exact.",
      instructions: "Ask before you delete.",
    });
    expect(await ask(library.LibraryGuidanceList())).toEqual({ "seat-a": { soul: "Dry and exact.", instructions: "Ask before you delete." } });
    expect(await ask(library.LibraryGuidanceSet({ seatId: "seat-a", guidance: null }))).toBeNull();
    expect(await ask(library.LibraryGuidanceList())).toEqual({});
  });

  it("answers nothing for a signal that is not there, and a refusal for a comment that names no shot", async () => {
    expect(await ask(library.LibrarySignal({ signalId: "sig_missing" }))).toBeNull();
    expect(await ask(library.LibraryPageShot({ canvasName: "factory", nodeId: "page-1", messageId: "01M5F8P0000000000000000003" }))).toEqual({
      ok: false,
      reason: "not-named",
    });
  });
});

describe("what main normalizes before it asks the core", () => {
  it("refuses a squad or profile body that lacks its essentials, and seat guidance over its bound", () => {
    expect(Result.isFailure(decodeSquadBody({ seats: [], edges: [] }))).toBe(true);
    expect(Result.isFailure(decodeSquadBody({ seats: [{ key: "s0", profile: { name: "", harness: "claude" }, dx: 0, dy: 0, width: 1, height: 1 }], edges: [] }))).toBe(true);
    expect(decodeProfileBody({ name: "Ada" })).toBeNull();
    expect(normalizeSeatGuidance({ soul: "x".repeat(4001) })).toMatchObject({ ok: false });
    expect(normalizeSeatGuidance({ soul: "  " })).toEqual({ ok: true, guidance: null });
  });
});
