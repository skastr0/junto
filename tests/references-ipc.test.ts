/**
 * What the window calls for the app briefing and references: the core
 * operations behind the JuntoApi members, over a real store in a temp folder,
 * with the push bus main forwards from. The operator is the author.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ReferencesRepository, ReferencesRepositoryLive } from "../src/main/junto/references/repository";
import { runCoreOp } from "../src/main/core-process/serve";
import { subscribe as onCorePush } from "../src/main/core-process/push";
import { coreOpBody } from "../src/main/core-process/ops";
import "../src/main/core-process/ops/index";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<ReferencesRepository, unknown>;
let stop: () => void;
let broadcasts: Array<readonly [string, unknown]>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-references-ipc-"));
  runtime = ManagedRuntime.make(ReferencesRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))));
  broadcasts = [];
  const watching = await runCoreOp(runtime, "ipc.references.watch", {});
  expect(watching.ok).toBe(true);
  stop = onCorePush(IPC_CHANNELS.referencesChanged, (payload) =>
    broadcasts.push([IPC_CHANNELS.referencesChanged, payload]),
  );
});

afterEach(async () => {
  stop();
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

/** The operation as the IPC handler calls it: the answer, or the failure's words. */
const invoke = async (name: string, input?: unknown): Promise<any> => {
  const answer = await runCoreOp(runtime, name, input === undefined ? {} : { input });
  if (!answer.ok) throw new Error(answer.failure.message);
  return answer.value;
};

const authors = () => {
  const database = new DatabaseSync(join(root, "junto.db"), { readOnly: true });
  try {
    return database.prepare("SELECT DISTINCT updated_by FROM app_texts").all();
  } finally {
    database.close();
  }
};

describe("the references core operations", () => {
  it("registers one operation per JuntoApi member, and the watch", () => {
    for (const name of [
      "ipc.references.briefingRead",
      "ipc.references.briefingWrite",
      "ipc.references.list",
      "ipc.references.read",
      "ipc.references.write",
      "ipc.references.delete",
      "ipc.references.watch",
    ]) {
      expect(coreOpBody(name), name).toBeTypeOf("function");
    }
  });

  it("reads and writes the briefing as the operator, clears it with nothing, and tells open pages", async () => {
    expect(await invoke("ipc.references.briefingRead")).toBeNull();
    const long = `# House rules\r\n${"x".repeat(300_000)}`;
    const written = await invoke("ipc.references.briefingWrite", long);
    expect(written).toMatchObject({ ok: true, briefing: { body: expect.stringContaining("# House rules\nxxx") } });
    expect(await invoke("ipc.references.briefingRead")).toEqual(written.briefing);
    expect(authors()).toEqual([{ updated_by: "operator" }]);
    expect(await invoke("ipc.references.briefingWrite", 7)).toEqual({ ok: false, message: "the briefing must be text" });
    expect(await invoke("ipc.references.briefingWrite", "  ")).toEqual({ ok: true, briefing: null });
    expect(await invoke("ipc.references.briefingRead")).toBeNull();
    expect(broadcasts).toEqual([
      [IPC_CHANNELS.referencesChanged, { kind: "briefing" }],
      [IPC_CHANNELS.referencesChanged, { kind: "briefing" }],
    ]);
  });

  it("writes, lists without bodies, reads and deletes app-wide references", async () => {
    expect(await invoke("ipc.references.list", {})).toEqual([]);
    const written = await invoke("ipc.references.write", { name: "Style", description: "How we write", body: "Plain wörds." });
    expect(written).toMatchObject({ ok: true, reference: { name: "style", description: "How we write", bytes: 13 } });
    expect(written.reference).not.toHaveProperty("body");
    await invoke("ipc.references.write", { name: "release", body: "Ship on green." });
    const listed = await invoke("ipc.references.list", {});
    expect(listed.map((reference: any) => [reference.name, reference.bytes])).toEqual([["release", 14], ["style", 13]]);
    expect(JSON.stringify(listed)).not.toContain("Plain");
    expect(await invoke("ipc.references.read", { name: "style" })).toMatchObject({ name: "style", body: "Plain wörds." });
    expect(await invoke("ipc.references.read", { name: "nope" })).toBeNull();
    expect(await invoke("ipc.references.delete", { name: "style" })).toEqual({ ok: true, deleted: true });
    expect(await invoke("ipc.references.delete", { name: "style" })).toEqual({ ok: true, deleted: false });
    expect(authors()).toEqual([{ updated_by: "operator" }]);
    expect(broadcasts.map(([, payload]) => payload)).toEqual([
      { kind: "reference", name: "style" },
      { kind: "reference", name: "release" },
      { kind: "reference", name: "style" },
    ]);
  });

  it("refuses in words, never by throwing, when a write cannot be saved", async () => {
    expect(await invoke("ipc.references.write", { name: "two words", body: "b" })).toMatchObject({
      ok: false, message: expect.stringContaining("not a usable name"),
    });
    expect(await invoke("ipc.references.write", { name: "style", body: "" })).toMatchObject({
      ok: false, message: expect.stringContaining("delete it"),
    });
    expect(await invoke("ipc.references.write", undefined)).toMatchObject({ ok: false });
    expect(await invoke("ipc.references.delete", { name: "" })).toMatchObject({ ok: false });
    expect(await invoke("ipc.references.write", { name: "style", body: "b", regionId: "region-1" })).toEqual({
      ok: false, message: "a region's reference needs both its canvas and its region",
    });
    expect(broadcasts).toEqual([]);
  });

  it("keeps a region's references apart from the app's and from another region's", async () => {
    const cli = { canvasName: "factory", regionId: "region-cli" };
    await invoke("ipc.references.write", { name: "style", body: "App style." });
    expect(await invoke("ipc.references.write", { ...cli, name: "style", body: "CLI style." })).toMatchObject({ ok: true });
    expect((await invoke("ipc.references.list", cli)).map((reference: any) => reference.name)).toEqual(["style"]);
    expect(await invoke("ipc.references.list", { canvasName: "factory", regionId: "region-other" })).toEqual([]);
    expect(await invoke("ipc.references.read", { ...cli, name: "style" })).toMatchObject({ body: "CLI style." });
    expect(await invoke("ipc.references.read", { name: "style" })).toMatchObject({ body: "App style." });
    expect(await invoke("ipc.references.delete", { ...cli, name: "style" })).toEqual({ ok: true, deleted: true });
    expect(await invoke("ipc.references.read", { name: "style" })).toMatchObject({ body: "App style." });
    await expect(invoke("ipc.references.list", { canvasName: "factory" })).rejects.toThrow("both its canvas and its region");
    expect(broadcasts.at(-1)).toEqual([
      IPC_CHANNELS.referencesChanged,
      { kind: "reference", name: "style", canvasName: "factory", regionId: "region-cli" },
    ]);
  });

  it("stops telling pages once main's forwarder is stopped", async () => {
    stop();
    await invoke("ipc.references.briefingWrite", "Quiet.");
    expect(broadcasts).toEqual([]);
  });
});
