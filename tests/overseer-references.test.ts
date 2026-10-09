/**
 * An overseer reads and writes the operator's texts through the real
 * dispatcher: the app briefing, app-wide references and one region's, with
 * the overseer recorded as the author. Stores live in a temp folder.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import {
  grantOverseer,
  ModelStoresLive,
  readSeeded,
  seedCanvas,
} from "./support/seed-canvas";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { StationRepository, StationRepositoryLive } from "../src/main/junto/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { SettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { WorkLive } from "../src/main/junto/work/service";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { executeOverseer, type OverseerRuntime } from "../src/main/junto/overseer/dispatch";
import { onReferencesChanged } from "../src/main/junto/references/changes";
import { ReferencesRepository, ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import { RemoteConfiguration } from "../src/shared/station-api";
import {
  OVERSEER_CATALOG,
  OverseerReferencesWriteInput,
  decodeOverseerArgs,
} from "../src/shared/overseer-control";
import type { ReferencesChangedEvent } from "../src/shared/references";
import { region as regionNode, seat } from "./support/model-nodes";

const caller = { canvasName: "origin", nodeId: "boss" };
const layers = (root: string, withStore: boolean) => {
  const repositories = Layer.provideMerge(Layer.mergeAll(
    CrewRepositoryLive, WorkRepositoryLive, StationRepositoryLive, StationFleetTargetRepositoryLive,
    ...(withStore ? [ReferencesRepositoryLive] : []),
    SettingsLive, makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ), Layer.mergeAll(
    makeStateEngineLive(join(root, "state.db")),
    makeInstallOpsLive(join(root, "install-ops.db")),
  ));
  return Layer.provideMerge(WorkLive, Layer.mergeAll(
    Layer.provideMerge(ModelStoresLive, repositories),
  ));
};
const makeRuntime = (root: string, withStore: boolean) => ManagedRuntime.make(layers(root, withStore));
let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let stopListening: (() => void) | undefined;

afterEach(async () => {
  stopListening?.();
  stopListening = undefined;
  await runtime?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

const region = (id: string, label: string) => regionNode(id, { x: -500, y: -500, width: 2000, height: 2000 }, { label });

const boot = async (options: { readonly withStore?: boolean; readonly grant?: boolean } = {}) => {
  root = await mkdtemp(join(tmpdir(), "overseer-references-"));
  runtime = makeRuntime(root, options.withStore ?? true);
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(settings.setStationTopology({
    role: "command-center", hostId: "local", supervisedPreferred: false,
  }));
  await runtime.runPromise(seedCanvas("origin", [
    region("region-cli", "CLI"),
    seat("boss", { label: "Boss", x: 17, y: -31, width: 240, height: 120 }),
  ]));
  await runtime.runPromise(seedCanvas("target", [region("region-far", "Far")]));
  if (options.grant ?? true) {
    const read = await runtime.runPromise(readSeeded("origin"));
    await runtime.runPromise(grantOverseer(caller.canvasName, caller.nodeId, true));
  }
  const adapters: OverseerRuntime = {
    native: vi.fn(() => Effect.succeed({ observed: true })),

  };
  const run = (request: Parameters<typeof executeOverseer>[1]) =>
    runtime.runPromise(executeOverseer(caller, request, adapters)) as Promise<any>;
  return { run, adapters };
};

const authors = (): ReadonlyArray<Record<string, unknown>> => {
  const database = new DatabaseSync(join(root, "state.db"), { readOnly: true });
  try {
    return database
      .prepare("SELECT scope_kind, canvas_name, region_id, name, updated_by FROM app_texts ORDER BY scope_kind, canvas_name, region_id, name")
      .all() as ReadonlyArray<Record<string, unknown>>;
  } finally {
    database.close();
  }
};

describe("overseer references and briefing", () => {
  it("is in the catalog as two families, reads marked read", () => {
    const byOperation = Object.fromEntries(OVERSEER_CATALOG.map((entry) => [entry.operation, entry]));
    expect(
      ["references.list", "references.read", "references.write", "references.delete", "briefing.read", "briefing.write"].map(
        (operation) => [operation, byOperation[operation]?.family, byOperation[operation]?.mutation],
      ),
    ).toEqual([
      ["references.list", "references", false],
      ["references.read", "references", false],
      ["references.write", "references", true],
      ["references.delete", "references", true],
      ["briefing.read", "briefing", false],
      ["briefing.write", "briefing", true],
    ]);
    // The wire carries the body; the command's own argument need not.
    expect(Result.isFailure(decodeOverseerArgs("references.write", { name: "style" }))).toBe(true);
    expect(Result.isSuccess(Schema.decodeUnknownResult(OverseerReferencesWriteInput)({ name: "style" }))).toBe(true);
    expect(Result.isFailure(decodeOverseerArgs("references.read", { name: "style", extra: 1 }))).toBe(true);
  });

  it("needs the human grant", async () => {
    const { run } = await boot({ grant: false });
    expect(await run({ operation: "references.list" })).toMatchObject({ ok: false, error: { type: "Forbidden" } });
    expect(await run({ operation: "briefing.write", args: { body: "Mine now." } })).toMatchObject({ ok: false, error: { type: "Forbidden" } });
    expect(authors()).toEqual([]);
  });

  it("writes, lists, reads and deletes app-wide references as the overseer", async () => {
    const { run, adapters } = await boot();
    const events: ReferencesChangedEvent[] = [];
    stopListening = onReferencesChanged((event) => events.push(event));

    expect(await run({ operation: "references.list" })).toEqual({
      ok: true, operation: "references.list", data: { scope: "app", references: [] },
    });
    const written = await run({ operation: "references.write", args: { name: "Style", description: "How we write", body: "Plain wörds.\n" } });
    expect(written).toMatchObject({
      ok: true,
      data: { scope: "app", name: "style", description: "How we write", bytes: 13, written: true },
    });
    expect(written.data).not.toHaveProperty("body");
    const long = "x".repeat(400_000);
    expect(await run({ operation: "references.write", args: { name: "long", body: long } })).toMatchObject({ ok: true, data: { bytes: 400_000 } });

    const listed = await run({ operation: "references.list" });
    expect(listed.data.references.map((reference: any) => [reference.name, reference.bytes])).toEqual([["long", 400_000], ["style", 13]]);
    expect(JSON.stringify(listed)).not.toContain("Plain");
    expect(await run({ operation: "references.read", args: { name: "STYLE" } })).toMatchObject({
      ok: true, data: { scope: "app", name: "style", description: "How we write", body: "Plain wörds." },
    });
    expect((await run({ operation: "references.read", args: { name: "long" } })).data.body).toHaveLength(400_000);

    expect(authors()).toEqual([
      { scope_kind: "app", canvas_name: "", region_id: "", name: "long", updated_by: "overseer:boss" },
      { scope_kind: "app", canvas_name: "", region_id: "", name: "style", updated_by: "overseer:boss" },
    ]);

    expect(await run({ operation: "references.delete", args: { name: "style" } })).toMatchObject({ ok: true, data: { name: "style", deleted: true } });
    expect(await run({ operation: "references.delete", args: { name: "style" } })).toMatchObject({ ok: false, error: { type: "NotFound" } });
    expect(await run({ operation: "references.read", args: { name: "style" } })).toMatchObject({
      ok: false, error: { type: "NotFound", details: { hint: "junto overseer references list" } },
    });
    // Every committed write is announced once; a read or a refused delete is not.
    expect(events).toEqual([
      { kind: "reference", name: "style" },
      { kind: "reference", name: "long" },
      { kind: "reference", name: "style" },
    ]);

    expect(adapters.native).not.toHaveBeenCalled();
  });

  it("refuses a name that is not one, an empty body, and a canvas without a region, in plain words", async () => {
    const { run } = await boot();
    expect(await run({ operation: "references.write", args: { name: "two words", body: "b" } })).toMatchObject({
      ok: false, error: { type: "InvalidArguments", message: expect.stringContaining("not a usable name") },
    });
    expect(await run({ operation: "references.write", args: { name: "style", body: "  \n" } })).toMatchObject({
      ok: false, error: { type: "InvalidArguments", message: expect.stringContaining("delete it") },
    });
    expect(await run({ operation: "references.write", args: { name: "style" } })).toMatchObject({ ok: false, error: { type: "InvalidArguments" } });
    expect(await run({ operation: "references.list", args: { canvas: "target" } })).toMatchObject({
      ok: false, error: { type: "InvalidArguments", message: expect.stringContaining("regionId") },
    });
    expect(authors()).toEqual([]);
  });

  it("keeps a region's references on that region, on the overseer's canvas or a named one", async () => {
    const { run } = await boot();
    const events: ReferencesChangedEvent[] = [];
    stopListening = onReferencesChanged((event) => events.push(event));
    await run({ operation: "references.write", args: { name: "style", body: "App style." } });
    expect(await run({ operation: "references.write", args: { name: "style", regionId: "region-cli", body: "CLI style." } })).toMatchObject({
      ok: true, data: { scope: "region", canvas: "origin", region: { id: "region-cli", label: "CLI" }, name: "style", written: true },
    });
    expect(await run({ operation: "references.write", args: { name: "runbook", canvas: "target", regionId: "region-far", body: "Far runbook." } }))
      .toMatchObject({ ok: true, data: { scope: "region", canvas: "target", region: { id: "region-far", label: "Far" } } });

    expect((await run({ operation: "references.list" })).data.references.map((reference: any) => reference.name)).toEqual(["style"]);
    expect(await run({ operation: "references.list", args: { regionId: "region-cli" } })).toMatchObject({
      ok: true, data: { scope: "region", canvas: "origin", region: { id: "region-cli" }, references: [{ name: "style", bytes: 10 }] },
    });
    expect(await run({ operation: "references.read", args: { name: "style", regionId: "region-cli" } })).toMatchObject({ ok: true, data: { body: "CLI style." } });
    expect(await run({ operation: "references.read", args: { name: "style" } })).toMatchObject({ ok: true, data: { body: "App style." } });
    expect(await run({ operation: "references.read", args: { name: "runbook", regionId: "region-cli" } })).toMatchObject({ ok: false, error: { type: "NotFound" } });

    // A region that is not on the canvas, a node that is not a region, a canvas that does not exist.
    for (const args of [
      { name: "x", body: "b", regionId: "region-far" },
      { name: "x", body: "b", regionId: "boss" },
      { name: "x", body: "b", canvas: "nowhere", regionId: "region-cli" },
    ]) {
      expect(await run({ operation: "references.write", args })).toMatchObject({ ok: false, error: { type: "NotFound" } });
    }
    expect(await run({ operation: "references.delete", args: { name: "style", regionId: "region-cli" } })).toMatchObject({ ok: true, data: { deleted: true } });
    expect(authors().map((row) => [row.scope_kind, row.canvas_name, row.region_id, row.name])).toEqual([
      ["app", "", "", "style"],
      ["region", "target", "region-far", "runbook"],
    ]);
    expect(events.slice(1)).toEqual([
      { kind: "reference", name: "style", canvasName: "origin", regionId: "region-cli" },
      { kind: "reference", name: "runbook", canvasName: "target", regionId: "region-far" },
      { kind: "reference", name: "style", canvasName: "origin", regionId: "region-cli" },
    ]);
  });

  it("reads and replaces the app briefing, and does not clear it", async () => {
    const { run } = await boot();
    const events: ReferencesChangedEvent[] = [];
    stopListening = onReferencesChanged((event) => events.push(event));
    expect(await run({ operation: "briefing.read" })).toEqual({ ok: true, operation: "briefing.read", data: { body: null } });
    expect(await run({ operation: "briefing.write", args: { body: "# House rules\r\nCommit by path.\n" } })).toMatchObject({
      ok: true, data: { written: true, bytes: 29 },
    });
    expect(await run({ operation: "briefing.read" })).toMatchObject({ ok: true, data: { body: "# House rules\nCommit by path." } });
    expect(await run({ operation: "briefing.write", args: { body: "   " } })).toMatchObject({
      ok: false, error: { type: "InvalidArguments", message: expect.stringContaining("needs a body") },
    });
    expect((await run({ operation: "briefing.read" })).data.body).toBe("# House rules\nCommit by path.");
    expect(authors()).toEqual([{ scope_kind: "briefing", canvas_name: "", region_id: "", name: "", updated_by: "overseer:boss" }]);
    expect(events).toEqual([{ kind: "briefing" }]);
    // The store is what onboard reads.
    const stored = await (runtime as unknown as ManagedRuntime.ManagedRuntime<ReferencesRepository, unknown>).runPromise(
      Effect.flatMap(ReferencesRepository, (store) => store.briefingRead()),
    );
    expect(stored?.body).toBe("# House rules\nCommit by path.");
  });


});
