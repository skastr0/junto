import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import {
  applyMirrorLaw,
  type CanvasDoc,
} from "../src/shared/canvas";

const noteDoc = (text: string): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      {
        id: "n1",
        type: "text",
        text,
        x: 0,
        y: 0,
        width: 120,
        height: 60,
      },
    ],
    edges: [],
  });

const taskSinkDoc = (): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      {
        id: "sink",
        type: "text",
        text: "tasks",
        x: 0,
        y: 0,
        width: 240,
        height: 120,
        ether: {
          entity: { kind: "task" },
          tasks: { items: [] },
        },
      },
    ],
    edges: [],
  });

describe("CanvasesService SQLite authority", () => {
  let canvasesDir = "";
  let stateDir = "";
  let previousCanvases: string | undefined;
  const makeCanvasRuntime = (path: string) => {
    const repositories = Layer.provideMerge(
      Layer.mergeAll(WorkRepositoryLive, StationRepositoryLive),
      makeStateEngineLive(path),
    );
    const canvases = Layer.provideMerge(CanvasesLive, repositories);
    return ManagedRuntime.make(Layer.provideMerge(WorkLive, canvases));
  };
  let runtime: ReturnType<typeof makeCanvasRuntime> | undefined;

  const installEnv = async (): Promise<void> => {
    canvasesDir = await mkdtemp(join(tmpdir(), "vellum-canvases-"));
    stateDir = await mkdtemp(join(tmpdir(), "vellum-state-live-"));
    previousCanvases = process.env.VELLUM_CANVASES_DIR;
    process.env.VELLUM_CANVASES_DIR = canvasesDir;
  };

  const restoreEnv = async (): Promise<void> => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
    if (previousCanvases === undefined) delete process.env.VELLUM_CANVASES_DIR;
    else process.env.VELLUM_CANVASES_DIR = previousCanvases;
    if (canvasesDir) await rm(canvasesDir, { recursive: true, force: true });
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    canvasesDir = "";
    stateDir = "";
  };

  afterEach(async () => {
    await restoreEnv();
  });

  it("commits sequential authority generations on write and create", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum.db"));
    const canvases = await runtime.runPromise(CanvasesService);

    await runtime.runPromise(canvases.write("alpha", noteDoc("one")));

    const liveGen = await runtime.runPromise(canvases.liveAuthorityGeneration());
    expect(liveGen).toBe("1");

    const gen1 = await runtime.runPromise(canvases.authoritySnapshot());
    expect(gen1.generation).toBe("1");
    expect([...gen1.documents.keys()]).toEqual(["alpha"]);
    expect(gen1.documents.get("alpha")?.nodes[0]).toMatchObject({ text: "one" });

    await runtime.runPromise(canvases.write("alpha", noteDoc("two")));
    await runtime.runPromise(canvases.create("beta"));

    const gen3 = await runtime.runPromise(canvases.authoritySnapshot());
    expect(gen3.generation).toBe("3");
    expect([...gen3.documents.keys()].sort()).toEqual(["alpha", "beta"]);
    expect(gen3.documents.get("alpha")?.nodes[0]).toMatchObject({ text: "two" });

    const readBeta = await runtime.runPromise(canvases.read("beta"));
    expect(readBeta.doc.nodes).toEqual([]);
  });

  it("reloads the live map from SQLite across restart", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("alpha", noteDoc("authority-wins")));
    await runtime.dispose();
    runtime = undefined;

    runtime = makeCanvasRuntime(join(stateDir, "vellum.db"));
    const reloaded = await runtime.runPromise(CanvasesService);
    const list = await runtime.runPromise(reloaded.list);
    expect(list.map((row) => row.name)).toEqual(["alpha"]);

    const read = await runtime.runPromise(reloaded.read("alpha"));
    const text =
      read.doc.nodes[0] && read.doc.nodes[0].type === "text"
        ? read.doc.nodes[0].text
        : undefined;
    expect(text).toBe("authority-wins");
  });

  it("fails closed when an old authority body embeds document-backed work state", async () => {
    await installEnv();
    const database = join(stateDir, "vellum.db");
    runtime = makeCanvasRuntime(database);
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("work", noteDoc("authorial")));

    const legacyBody = JSON.stringify(taskSinkDoc());
    const bodySha256 = createHash("sha256")
      .update(legacyBody, "utf8")
      .digest("hex");
    const intentSha256 = createHash("sha256")
      .update(String(Buffer.byteLength("work", "utf8")))
      .update("\0")
      .update("work", "utf8")
      .update("\0")
      .update(bodySha256, "ascii")
      .update("\0")
      .digest("hex");
    const state = await runtime.runPromise(StateEngine);
    await runtime.runPromise(
      state.transaction("test.inject-retired-work-store", (writer) => {
        writer.run(
          `UPDATE canvas_generation_documents
           SET body = ?, sha256 = ?
           WHERE generation = '1' AND name = 'work'`,
          [legacyBody, bodySha256],
        );
        writer.run(
          `UPDATE canvas_generations
           SET intent_sha256 = ?
           WHERE generation = '1'`,
          [intentSha256],
        );
      }),
    );
    await runtime.dispose();
    runtime = undefined;

    runtime = makeCanvasRuntime(database);
    const reopened = await runtime.runPromise(CanvasesService);
    const result = await runtime.runPromise(Effect.either(reopened.list));
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        message: expect.stringContaining("runtime work projection data"),
      },
    });
  });

  it("keeps work rows out of authority while projecting committed work reads", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const work = await runtime.runPromise(WorkService);
    await runtime.runPromise(canvases.write("work", taskSinkDoc()));

    const authorial = await runtime.runPromise(canvases.authoritySnapshot());
    expect(authorial.generation).toBe("1");
    expect(authorial.documents.get("work")?.nodes[0]?.ether?.tasks).toBeUndefined();

    const changed: string[] = [];
    const unsubscribe = canvases.subscribeChanges((name) => changed.push(name));
    const created = await runtime.runPromise(
      work.workTaskCreate("work", "sink", "ship the SQLite cutover"),
    );
    unsubscribe();
    expect(created.ok).toBe(true);
    expect(changed).toEqual(["work"]);

    const projected = await runtime.runPromise(canvases.read("work"));
    expect(projected.doc.nodes[0]?.ether?.tasks?.items).toHaveLength(1);
    expect(projected.doc.nodes[0]).toMatchObject({
      text: "ship the SQLite cutover",
    });
    expect(await runtime.runPromise(canvases.liveAuthorityGeneration())).toBe(
      "1",
    );
    expect(
      (await runtime.runPromise(canvases.authoritySnapshot())).documents.get(
        "work",
      )?.nodes[0]?.ether?.tasks,
    ).toBeUndefined();
  });

  it("starts empty when the authority pointer is absent", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const list = await runtime.runPromise(canvases.list);
    expect(list).toEqual([]);

    await runtime.runPromise(canvases.write("first", noteDoc("minted")));
    const snap = await runtime.runPromise(canvases.authoritySnapshot());
    expect(snap.generation).toBe("1");
    expect([...snap.documents.keys()]).toEqual(["first"]);
  });

  it("remove drops the document from the next authority generation", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.create("keep"));
    await runtime.runPromise(canvases.create("drop"));
    await runtime.runPromise(canvases.remove("drop"));

    const snap = await runtime.runPromise(canvases.authoritySnapshot());
    expect(snap.generation).toBe("3");
    expect([...snap.documents.keys()]).toEqual(["keep"]);
    await expect(
      runtime.runPromise(Effect.either(canvases.read("drop"))),
    ).resolves.toMatchObject({ _tag: "Left" });
  });

  it("deduplicates identical maps and preserves a valid empty head", async () => {
    await installEnv();
    const database = join(stateDir, "vellum.db");
    runtime = makeCanvasRuntime(database);
    const canvases = await runtime.runPromise(CanvasesService);
    const doc = noteDoc("same");

    await runtime.runPromise(canvases.write("only", doc));
    await runtime.runPromise(canvases.write("only", doc));
    expect(await runtime.runPromise(canvases.liveAuthorityGeneration())).toBe(
      "1",
    );
    await runtime.runPromise(canvases.remove("only"));
    expect(await runtime.runPromise(canvases.authoritySnapshot())).toMatchObject({
      generation: "2",
    });
    expect(
      (await runtime.runPromise(canvases.authoritySnapshot())).documents.size,
    ).toBe(0);

    await runtime.dispose();
    runtime = makeCanvasRuntime(database);
    const reloaded = await runtime.runPromise(CanvasesService);
    expect(await runtime.runPromise(reloaded.list)).toEqual([]);
    expect(await runtime.runPromise(reloaded.liveAuthorityGeneration())).toBe(
      "2",
    );
  });
});
