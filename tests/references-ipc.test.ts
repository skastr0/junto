/**
 * What the window calls for the app briefing and references: the handlers
 * behind the JuntoApi members, over a real store in a temp folder, with a
 * fake IPC registry and broadcast. The operator is the author.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { registerReferencesIpc } from "../src/main/junto/references/ipc";
import { ReferencesRepository, ReferencesRepositoryLive } from "../src/main/junto/references/repository";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ReferencesRepository, unknown>;
let stop: () => void;
let handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
let broadcasts: Array<readonly [string, unknown]>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-references-ipc-"));
  runtime = ManagedRuntime.make(ReferencesRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
  handlers = new Map();
  broadcasts = [];
  stop = registerReferencesIpc(
    { handle: (channel, handler) => void handlers.set(channel, handler as never) },
    (channel, payload) => broadcasts.push([channel, payload]),
    (effect) => runtime.runPromise(effect),
  );
});

afterEach(async () => {
  stop();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const invoke = (channel: string, ...args: unknown[]): Promise<any> =>
  Promise.resolve(handlers.get(channel)!({}, ...args));

const authors = () => {
  const database = new DatabaseSync(join(root, "junto.db"), { readOnly: true });
  try {
    return database.prepare("SELECT DISTINCT updated_by FROM app_texts").all();
  } finally {
    database.close();
  }
};

describe("the references IPC", () => {
  it("registers one handler per JuntoApi member", () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        IPC_CHANNELS.appBriefingRead,
        IPC_CHANNELS.appBriefingWrite,
        IPC_CHANNELS.referencesList,
        IPC_CHANNELS.referencesRead,
        IPC_CHANNELS.referencesWrite,
        IPC_CHANNELS.referencesDelete,
      ].sort(),
    );
  });

  it("reads and writes the briefing as the operator, clears it with nothing, and tells open pages", async () => {
    expect(await invoke(IPC_CHANNELS.appBriefingRead)).toBeNull();
    const long = `# House rules\r\n${"x".repeat(300_000)}`;
    const written = await invoke(IPC_CHANNELS.appBriefingWrite, long);
    expect(written).toMatchObject({ ok: true, briefing: { body: expect.stringContaining("# House rules\nxxx") } });
    expect(await invoke(IPC_CHANNELS.appBriefingRead)).toEqual(written.briefing);
    expect(authors()).toEqual([{ updated_by: "operator" }]);
    expect(await invoke(IPC_CHANNELS.appBriefingWrite, 7)).toEqual({ ok: false, message: "the briefing must be text" });
    expect(await invoke(IPC_CHANNELS.appBriefingWrite, "  ")).toEqual({ ok: true, briefing: null });
    expect(await invoke(IPC_CHANNELS.appBriefingRead)).toBeNull();
    expect(broadcasts).toEqual([
      [IPC_CHANNELS.referencesChanged, { kind: "briefing" }],
      [IPC_CHANNELS.referencesChanged, { kind: "briefing" }],
    ]);
  });

  it("writes, lists without bodies, reads and deletes app-wide references", async () => {
    expect(await invoke(IPC_CHANNELS.referencesList)).toEqual([]);
    const written = await invoke(IPC_CHANNELS.referencesWrite, { name: "Style", description: "How we write", body: "Plain wörds." });
    expect(written).toMatchObject({ ok: true, reference: { name: "style", description: "How we write", bytes: 13 } });
    expect(written.reference).not.toHaveProperty("body");
    await invoke(IPC_CHANNELS.referencesWrite, { name: "release", body: "Ship on green." });
    const listed = await invoke(IPC_CHANNELS.referencesList, {});
    expect(listed.map((reference: any) => [reference.name, reference.bytes])).toEqual([["release", 14], ["style", 13]]);
    expect(JSON.stringify(listed)).not.toContain("Plain");
    expect(await invoke(IPC_CHANNELS.referencesRead, { name: "style" })).toMatchObject({ name: "style", body: "Plain wörds." });
    expect(await invoke(IPC_CHANNELS.referencesRead, { name: "nope" })).toBeNull();
    expect(await invoke(IPC_CHANNELS.referencesDelete, { name: "style" })).toEqual({ ok: true, deleted: true });
    expect(await invoke(IPC_CHANNELS.referencesDelete, { name: "style" })).toEqual({ ok: true, deleted: false });
    expect(authors()).toEqual([{ updated_by: "operator" }]);
    expect(broadcasts.map(([, payload]) => payload)).toEqual([
      { kind: "reference", name: "style" },
      { kind: "reference", name: "release" },
      { kind: "reference", name: "style" },
    ]);
  });

  it("refuses in words, never by throwing, when a write cannot be saved", async () => {
    expect(await invoke(IPC_CHANNELS.referencesWrite, { name: "two words", body: "b" })).toMatchObject({
      ok: false, message: expect.stringContaining("not a usable name"),
    });
    expect(await invoke(IPC_CHANNELS.referencesWrite, { name: "style", body: "" })).toMatchObject({
      ok: false, message: expect.stringContaining("delete it"),
    });
    expect(await invoke(IPC_CHANNELS.referencesWrite, undefined)).toMatchObject({ ok: false });
    expect(await invoke(IPC_CHANNELS.referencesDelete, { name: "" })).toMatchObject({ ok: false });
    expect(await invoke(IPC_CHANNELS.referencesWrite, { name: "style", body: "b", regionId: "region-1" })).toEqual({
      ok: false, message: "a region's reference needs both its canvas and its region",
    });
    expect(broadcasts).toEqual([]);
  });

  it("keeps a region's references apart from the app's and from another region's", async () => {
    const cli = { canvasName: "factory", regionId: "region-cli" };
    await invoke(IPC_CHANNELS.referencesWrite, { name: "style", body: "App style." });
    expect(await invoke(IPC_CHANNELS.referencesWrite, { ...cli, name: "style", body: "CLI style." })).toMatchObject({ ok: true });
    expect((await invoke(IPC_CHANNELS.referencesList, cli)).map((reference: any) => reference.name)).toEqual(["style"]);
    expect(await invoke(IPC_CHANNELS.referencesList, { canvasName: "factory", regionId: "region-other" })).toEqual([]);
    expect(await invoke(IPC_CHANNELS.referencesRead, { ...cli, name: "style" })).toMatchObject({ body: "CLI style." });
    expect(await invoke(IPC_CHANNELS.referencesRead, { name: "style" })).toMatchObject({ body: "App style." });
    expect(await invoke(IPC_CHANNELS.referencesDelete, { ...cli, name: "style" })).toEqual({ ok: true, deleted: true });
    expect(await invoke(IPC_CHANNELS.referencesRead, { name: "style" })).toMatchObject({ body: "App style." });
    await expect(invoke(IPC_CHANNELS.referencesList, { canvasName: "factory" })).rejects.toThrow("both its canvas and its region");
    expect(broadcasts.at(-1)).toEqual([
      IPC_CHANNELS.referencesChanged,
      { kind: "reference", name: "style", canvasName: "factory", regionId: "region-cli" },
    ]);
  });

  it("stops telling pages once the registration is stopped", async () => {
    stop();
    await invoke(IPC_CHANNELS.appBriefingWrite, "Quiet.");
    expect(broadcasts).toEqual([]);
  });
});
