/**
 * What the window calls for the app briefing and references: the core's
 * references group (src/contract/core/references.ts) answered by its handlers
 * over a real store in a temp folder, with the push bus main forwards from.
 * The operator is the author. What main decodes and places before it asks
 * (the shared decoders) is held here too.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Exit, Layer, ManagedRuntime, Result, Scope } from "effect";
import { RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import {
  APP_REFERENCE_PLACE,
  decodeReferenceReadInput,
  decodeReferenceWriteInput,
  referencePlaceOf,
  type ReferencePlace,
} from "../src/shared/references";
import { ReferencesRpcs } from "../src/contract/core/references";
import { makeStateEngineLive } from "../src/core/state/engine";
import { ReferencesRepository, ReferencesRepositoryLive } from "../src/core/references/repository";
import { ReferencesHandlers } from "../src/core/ops/ipc-references";
import { inProcessPushes } from "./support/in-process-pushes";
import { subscribe as onCorePush } from "../src/app/core-process/main-side/core-pushes";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ReferencesRepository, unknown>;
let scope: Scope.Closeable;
let references: Effect.Success<ReturnType<typeof clientOf>>;
let stop: () => void;
let broadcasts: Array<readonly [string, unknown]>;

const clientOf = () => RpcTest.makeClient(ReferencesRpcs);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-references-ipc-"));
  runtime = ManagedRuntime.make(ReferencesRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
  scope = await Effect.runPromise(Scope.make());
  broadcasts = [];
  // The handlers listen for changes while this scope is open, as the core's server does.
  const handlers = await runtime.runPromise(Layer.buildWithScope(Layer.provide(ReferencesHandlers, inProcessPushes), scope));
  references = await runtime.runPromise(clientOf().pipe(Effect.provide(handlers), Effect.provideService(Scope.Scope, scope)));
  stop = onCorePush(IPC_CHANNELS.referencesChanged, (payload) =>
    broadcasts.push([IPC_CHANNELS.referencesChanged, payload]),
  );
});

afterEach(async () => {
  stop();
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const ask = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const region = (canvasName: string, regionId: string): ReferencePlace => ({ kind: "region", canvasName, regionId });

const authors = () => {
  const database = new DatabaseSync(join(root, "junto.db"), { readOnly: true });
  try {
    return database.prepare("SELECT DISTINCT updated_by FROM app_texts").all();
  } finally {
    database.close();
  }
};

describe("the references group", () => {
  it("reads and writes the briefing as the operator, clears it with nothing, and tells open pages", async () => {
    expect(await ask(references.ReferencesBriefingRead())).toBeNull();
    const long = `# House rules\r\n${"x".repeat(300_000)}`;
    const written = await ask(references.ReferencesBriefingWrite({ body: long }));
    expect(written).toMatchObject({ ok: true, briefing: { body: expect.stringContaining("# House rules\nxxx") } });
    if (!written.ok) throw new Error("the briefing was refused");
    expect(await ask(references.ReferencesBriefingRead())).toEqual(written.briefing);
    expect(authors()).toEqual([{ updated_by: "operator" }]);
    expect(await ask(references.ReferencesBriefingWrite({ body: "  " }))).toEqual({ ok: true, briefing: null });
    expect(await ask(references.ReferencesBriefingRead())).toBeNull();
    expect(broadcasts).toEqual([
      [IPC_CHANNELS.referencesChanged, { kind: "briefing" }],
      [IPC_CHANNELS.referencesChanged, { kind: "briefing" }],
    ]);
  });

  it("writes, lists without bodies, reads and deletes app-wide references", async () => {
    const app = APP_REFERENCE_PLACE;
    expect(await ask(references.ReferencesList({ place: app }))).toEqual([]);
    const written = await ask(
      references.ReferencesWrite({ place: app, name: "Style", description: "How we write", body: "Plain wörds." }),
    );
    expect(written).toMatchObject({ ok: true, reference: { name: "style", description: "How we write", bytes: 13 } });
    if (!written.ok) throw new Error("the reference was refused");
    expect(written.reference).not.toHaveProperty("body");
    await ask(references.ReferencesWrite({ place: app, name: "release", body: "Ship on green." }));
    const listed = await ask(references.ReferencesList({ place: app }));
    expect(listed.map((reference) => [reference.name, reference.bytes])).toEqual([["release", 14], ["style", 13]]);
    expect(JSON.stringify(listed)).not.toContain("Plain");
    expect(await ask(references.ReferencesRead({ place: app, name: "style" }))).toMatchObject({ name: "style", body: "Plain wörds." });
    expect(await ask(references.ReferencesRead({ place: app, name: "nope" }))).toBeNull();
    expect(await ask(references.ReferencesDelete({ place: app, name: "style" }))).toEqual({ ok: true, deleted: true });
    expect(await ask(references.ReferencesDelete({ place: app, name: "style" }))).toEqual({ ok: true, deleted: false });
    expect(authors()).toEqual([{ updated_by: "operator" }]);
    expect(broadcasts.map(([, payload]) => payload)).toEqual([
      { kind: "reference", name: "style" },
      { kind: "reference", name: "release" },
      { kind: "reference", name: "style" },
    ]);
  });

  it("refuses in words, never by throwing, when a write cannot be saved", async () => {
    const app = APP_REFERENCE_PLACE;
    expect(await ask(references.ReferencesWrite({ place: app, name: "two words", body: "b" }))).toMatchObject({
      ok: false, message: expect.stringContaining("not a usable name"),
    });
    expect(await ask(references.ReferencesWrite({ place: app, name: "style", body: "" }))).toMatchObject({
      ok: false, message: expect.stringContaining("delete it"),
    });
    expect(await ask(references.ReferencesDelete({ place: app, name: "" }))).toMatchObject({ ok: false });
    expect(broadcasts).toEqual([]);
  });

  it("keeps a region's references apart from the app's and from another region's", async () => {
    const app = APP_REFERENCE_PLACE;
    const cli = region("factory", "region-cli");
    await ask(references.ReferencesWrite({ place: app, name: "style", body: "App style." }));
    expect(await ask(references.ReferencesWrite({ place: cli, name: "style", body: "CLI style." }))).toMatchObject({ ok: true });
    expect((await ask(references.ReferencesList({ place: cli }))).map((reference) => reference.name)).toEqual(["style"]);
    expect(await ask(references.ReferencesList({ place: region("factory", "region-other") }))).toEqual([]);
    expect(await ask(references.ReferencesRead({ place: cli, name: "style" }))).toMatchObject({ body: "CLI style." });
    expect(await ask(references.ReferencesRead({ place: app, name: "style" }))).toMatchObject({ body: "App style." });
    expect(await ask(references.ReferencesDelete({ place: cli, name: "style" }))).toEqual({ ok: true, deleted: true });
    expect(await ask(references.ReferencesRead({ place: app, name: "style" }))).toMatchObject({ body: "App style." });
    expect(broadcasts.at(-1)).toEqual([
      IPC_CHANNELS.referencesChanged,
      { kind: "reference", name: "style", canvasName: "factory", regionId: "region-cli" },
    ]);
  });

  it("stops telling pages once the server's scope closes", async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.runPromise(Effect.flatMap(ReferencesRepository, (repository) => repository.briefingWrite("Quiet.", "operator")));
    expect(broadcasts).toEqual([]);
  });
});

describe("what main decodes and places before it asks the core", () => {
  it("names the app with nothing, a region with both its canvas and its region, and refuses one alone", () => {
    expect(referencePlaceOf({})).toEqual({ ok: true, place: APP_REFERENCE_PLACE });
    expect(referencePlaceOf({ canvasName: "factory", regionId: "region-1" })).toEqual({
      ok: true,
      place: region("factory", "region-1"),
    });
    expect(referencePlaceOf({ canvasName: "factory" })).toEqual({
      ok: false, message: "a region's reference needs both its canvas and its region",
    });
    expect(referencePlaceOf({ canvasName: "", regionId: "region-1" }).ok).toBe(false);
  });

  it("reads what the window sends closed: a missing name, a field of no build's, or nothing is refused", () => {
    expect(Result.isSuccess(decodeReferenceWriteInput({ name: "style", body: "b" }))).toBe(true);
    expect(Result.isSuccess(decodeReferenceWriteInput({ name: "style", description: undefined, body: "b" }))).toBe(true);
    expect(Result.isFailure(decodeReferenceWriteInput(undefined))).toBe(true);
    expect(Result.isFailure(decodeReferenceWriteInput({ body: "b" }))).toBe(true);
    expect(Result.isFailure(decodeReferenceWriteInput({ name: "style", body: "b", regionId: 7 }))).toBe(true);
    expect(Result.isFailure(decodeReferenceReadInput({ name: "style", stray: true }))).toBe(true);
  });
});
