import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  CANVAS_GENERATION_BODY_RETENTION,
  CANVAS_GENERATION_COMPACTION_SLACK,
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum/canvases";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import {
  makeContentServiceLive,
} from "../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../src/main/vellum/install-ops/engine";
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

const padSinkDoc = (): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      {
        id: "sink",
        type: "text",
        text: "pad",
        x: 0,
        y: 0,
        width: 240,
        height: 120,
        ether: {
          entity: { kind: "pad" },
          pad: { revision: 0, shapeCount: 0, unreadPinCount: 0 },
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
    const contentRoot = join(stateDir || path, "..", "content");
    const installOpsPath = join(stateDir || path, "install-ops.db");
    const repositories = Layer.provideMerge(
      Layer.mergeAll(
        WorkRepositoryLive,
        StationRepositoryLive,
        StationFleetTargetRepositoryLive,
        SettingsLive,
        makeContentServiceLive({
          root: contentRoot,
          skipInlineMediaMigration: true,
        }),
      ),
      Layer.mergeAll(
        makeStateEngineLive(path),
        makeInstallOpsLive(installOpsPath),
      ),
    );
    const canvases = Layer.provideMerge(CanvasesLive, repositories);
    return ManagedRuntime.make((
      Layer.provideMerge(
        WorkLive,
        Layer.mergeAll(canvases, StationLivePeerRegistryLive) as never)
      )
    );
  };
  let runtime: ReturnType<typeof makeCanvasRuntime> | undefined;

  const installEnv = async (): Promise<void> => {
    canvasesDir = await mkdtemp(join(tmpdir(), "vellum-canvases-"));
    stateDir = await mkdtemp(join(tmpdir(), "vellum-state-live-"));
    previousCanvases = process.env.VELLUM_COMMAND_CANVASES_DIR;
    process.env.VELLUM_COMMAND_CANVASES_DIR = canvasesDir;
  };

  const restoreEnv = async (): Promise<void> => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
    if (previousCanvases === undefined) delete process.env.VELLUM_COMMAND_CANVASES_DIR;
    else process.env.VELLUM_COMMAND_CANVASES_DIR = previousCanvases;
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
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);

    await runtime.runPromise(canvases.write("alpha", noteDoc("one")));

    const liveGen = await runtime.runPromise(canvases.liveAuthorityGeneration());
    expect(liveGen).toBe("1");

    const gen1 = await runtime.runPromise(canvases.authoritySnapshot());
    expect(gen1.generation).toBe("1");
    expect([...gen1.documents.keys()]).toEqual(["alpha"]);
    expect(gen1.documents.get("alpha")?.nodes[0]).toMatchObject({ text: "one" });
    expect(
      await runtime.runPromise(
        canvases.readWithIntentWitness("alpha")
      )
    ).toMatchObject({
      read: { name: "alpha" },
      intentWitness: {
        generation: gen1.generation,
        contentSha256: gen1.intentSha256,
      },
    });

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
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("alpha", noteDoc("authority-wins")));
    await runtime.dispose();
    runtime = undefined;

    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
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

  it.each([
    [
      "document-backed work state",
      taskSinkDoc(),
      "runtime work projection data",
    ],
    [
      "document-backed pad projection",
      padSinkDoc(),
      "runtime work projection data",
    ],
    [
      "a top-level excess property",
      { ...noteDoc("authorial"), topMystery: true },
      "failed validation",
    ],
    [
      "retired nested bindings",
      {
        nodes: [
          {
            id: "legacy",
            type: "text",
            text: "legacy",
            x: 0,
            y: 0,
            width: 120,
            height: 60,
            ether: {
              entity: { kind: "project", name: "demo" },
              bindings: [
                {
                  source: "tower",
                  ref: { type: "project", key: "demo" },
                },
              ],
            },
          },
        ],
        edges: [],
      },
      "failed validation",
    ],
  ] as const)("fails closed when an authority body contains %s", async (
    _case,
    invalidDoc,
    expectedMessage
  ) => {
    await installEnv();
    const database = join(stateDir, "vellum-command.db");
    runtime = makeCanvasRuntime(database);
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("work", noteDoc("authorial")));

    const invalidBody = JSON.stringify(invalidDoc);
    const bodySha256 = createHash("sha256")
      .update(invalidBody, "utf8")
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
      state.transaction("test.inject-invalid-canvas", (writer) => {
        writer.run(
          `UPDATE canvas_generation_documents
           SET body = ?, sha256 = ?
           WHERE generation = '1' AND name = 'work'`,
          [invalidBody, bodySha256]
        );
        writer.run(
          `UPDATE canvas_generations
           SET intent_sha256 = ?
           WHERE generation = '1'`,
          [intentSha256]
        );
      })
    );
    await runtime.dispose();
    runtime = undefined;

    runtime = makeCanvasRuntime(database);
    const reopened = await runtime.runPromise(CanvasesService);
    const result = await runtime.runPromise(Effect.result(reopened.list));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        message: expect.stringContaining(expectedMessage),
      },
    });
  });

  it("keeps work rows out of authority while projecting committed work reads", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      })
    );
    const canvases = await runtime.runPromise(CanvasesService);
    const work = await runtime.runPromise(WorkService);
    await runtime.runPromise(canvases.write("work", taskSinkDoc()));

    const authorial = await runtime.runPromise(canvases.authoritySnapshot());
    expect(authorial.generation).toBe("1");
    expect(authorial.documents.get("work")?.nodes[0]?.ether?.tasks).toBeUndefined();
    const projectedBefore = await runtime.runPromise(canvases.read("work"));
    expect(projectedBefore.workRevision).toBe("0");

    const changed: string[] = [];
    const unsubscribe = canvases.subscribeChanges((name) => changed.push(name));
    const created = await runtime.runPromise(
      work.workTaskCreate("work", "sink", "ship the SQLite cutover", { details: "ship the SQLite cutover" })
    );
    unsubscribe();
    expect(created).toMatchObject({
      ok: true,
      disposition: "applied",
    });
    expect(changed).toEqual(["work"]);

    const projected = await runtime.runPromise(canvases.read("work"));
    expect(projected.revision).toBe(projectedBefore.revision);
    expect(BigInt(projected.workRevision)).toBeGreaterThan(
      BigInt(projectedBefore.workRevision)
    );
    expect(projected.doc.nodes[0]?.ether?.tasks?.items).toHaveLength(1);
    expect(projected.doc.nodes[0]).toMatchObject({
      text: "ship the SQLite cutover",
    });
    expect(await runtime.runPromise(canvases.liveAuthorityGeneration())).toBe(
      "1"
    );
    expect(
      (await runtime.runPromise(canvases.authoritySnapshot())).documents.get(
        "work"
      )?.nodes[0]?.ether?.tasks
    ).toBeUndefined();
  });

  it("compacts generation bodies to a bounded window and keeps the head", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const state = await runtime.runPromise(StateEngine);

    const commits =
      CANVAS_GENERATION_BODY_RETENTION + CANVAS_GENERATION_COMPACTION_SLACK + 8;
    for (let i = 0; i < commits; i += 1) {
      await runtime.runPromise(canvases.write("alpha", noteDoc(`rev-${i}`)));
    }

    const counts = await runtime.runPromise(
      state.read("compaction.counts", (reader) => ({
        ledger: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_generations",
          )?.count ?? 0,
        ),
        bodies: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_generation_documents",
          )?.count ?? 0,
        ),
      })),
    );

    // The ledger is append-only forever; only the payload is compacted.
    expect(counts.ledger).toBe(commits);
    expect(counts.bodies).toBeLessThanOrEqual(
      CANVAS_GENERATION_BODY_RETENTION + CANVAS_GENERATION_COMPACTION_SLACK,
    );
    expect(counts.bodies).toBeGreaterThanOrEqual(
      CANVAS_GENERATION_BODY_RETENTION,
    );

    // The head must always still resolve to a full document set.
    const head = await runtime.runPromise(canvases.authoritySnapshot());
    expect(head.generation).toBe(String(commits));
    expect(head.documents.get("alpha")?.nodes[0]).toMatchObject({
      text: `rev-${commits - 1}`,
    });
    const reread = await runtime.runPromise(canvases.read("alpha"));
    expect(reread.doc.nodes[0]).toMatchObject({ text: `rev-${commits - 1}` });

    // ... and a restart must be able to rebuild from what survived.
    await runtime.dispose();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const reopened = await runtime.runPromise(CanvasesService);
    expect(
      (await runtime.runPromise(reopened.read("alpha"))).doc.nodes[0],
    ).toMatchObject({ text: `rev-${commits - 1}` });
  });

  it("never compacts a generation a work fact is founded on", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const settings = await runtime.runPromise(SettingsService);
    await runtime.runPromise(
      settings.setStationTopology({
        role: "command-center",
        hostId: "local",
        supervisedPreferred: true,
      })
    );
    const canvases = await runtime.runPromise(CanvasesService);
    const work = await runtime.runPromise(WorkService);
    const state = await runtime.runPromise(StateEngine);

    await runtime.runPromise(canvases.write("work", taskSinkDoc()));
    await runtime.runPromise(
      work.workTaskCreate("work", "sink", "founded here", {
        details: "founded here",
      })
    );

    const basis = await runtime.runPromise(
      state.read("compaction.basis", (reader) =>
        reader.all<{ readonly generation: string }>(
          `
            SELECT DISTINCT basis_authorial_generation AS generation
            FROM work_facts
            WHERE basis_authorial_generation IS NOT NULL
          `,
        ),
      ),
    );
    expect(basis.length).toBeGreaterThan(0);

    const commits =
      CANVAS_GENERATION_BODY_RETENTION + CANVAS_GENERATION_COMPACTION_SLACK + 8;
    for (let i = 0; i < commits; i += 1) {
      await runtime.runPromise(canvases.write("alpha", noteDoc(`rev-${i}`)));
    }

    const survived = await runtime.runPromise(
      state.read("compaction.basis.survived", (reader) =>
        reader.all<{ readonly generation: string; readonly bodies: number }>(
          `
            SELECT generation, count(*) AS bodies
            FROM canvas_generation_documents
            GROUP BY generation
          `,
        ),
      ),
    );
    const held = new Set(survived.map((row) => row.generation));
    for (const row of basis) {
      expect(held.has(row.generation)).toBe(true);
    }
    // The point of the window: generations nothing pins did lose their bodies.
    expect(survived.length).toBeLessThan(commits);
  });

  it("starts empty when the authority pointer is absent", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
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
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.create("keep"));
    await runtime.runPromise(canvases.create("drop"));
    await runtime.runPromise(canvases.remove("drop"));

    const snap = await runtime.runPromise(canvases.authoritySnapshot());
    expect(snap.generation).toBe("3");
    expect([...snap.documents.keys()]).toEqual(["keep"]);
    await expect(
      runtime.runPromise(Effect.result(canvases.read("drop")))
    ).resolves.toMatchObject({ _tag: "Failure" });
  });

  it("deduplicates identical maps and preserves a valid empty head", async () => {
    await installEnv();
    const database = join(stateDir, "vellum-command.db");
    runtime = makeCanvasRuntime(database);
    const canvases = await runtime.runPromise(CanvasesService);
    const doc = noteDoc("same");

    await runtime.runPromise(canvases.write("only", doc));
    await runtime.runPromise(canvases.write("only", doc));
    expect(await runtime.runPromise(canvases.liveAuthorityGeneration())).toBe(
      "1"
    );
    await runtime.runPromise(canvases.remove("only"));
    expect(await runtime.runPromise(canvases.authoritySnapshot())).toMatchObject({
      generation: "2",
    });
    expect(
      (await runtime.runPromise(canvases.authoritySnapshot())).documents.size
    ).toBe(0);

    await runtime.dispose();
    runtime = makeCanvasRuntime(database);
    const reloaded = await runtime.runPromise(CanvasesService);
    expect(await runtime.runPromise(reloaded.list)).toEqual([]);
    expect(await runtime.runPromise(reloaded.liveAuthorityGeneration())).toBe(
      "2"
    );
  });
});
