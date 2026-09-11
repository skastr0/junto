import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  CanvasesLive,
  CanvasesService,
  type CanvasAuthorityStoredDocument,
} from "../src/main/vellum-command/canvases";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { StateEngine } from "../src/main/vellum-command/state/service";
import { WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum-command/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum-command/station/session-registry";
import { WorkLive, WorkService } from "../src/main/vellum-command/work/service";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum-command/settings/service";
import {
  makeContentServiceLive,
} from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import {
  applyMirrorLaw,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";
import {
  verifyCanvasIntentMaterial,
} from "../src/main/vellum-command/canvas-intent-identity";

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
          // A projected row, not an empty shell: an authorial sink may legally
          // carry `tasks: { items: [], contract }` (the contract is document
          // truth), so the guard reads projected rows, not the bag's presence.
          tasks: {
            items: [
              { id: "task-1", state: "submitted" as const, history: [] },
            ],
          },
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

  it("exposes coherent stored authority material with detached caller maps", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("alpha", noteDoc("one")));
    await runtime.runPromise(canvases.create("beta"));

    const material = await runtime.runPromise(
      canvases.authorityMaterialSnapshot(),
    );
    expect(material.generation).toBe("2");
    expect([...material.documents.keys()]).toEqual(["alpha", "beta"]);
    expect([...material.storedDocuments.keys()]).toEqual(["alpha", "beta"]);
    expect(material.storedDocuments.get("alpha")?.rawBody).toBe(
      serializeCanvas(material.documents.get("alpha")!),
    );
    expect(() => verifyCanvasIntentMaterial(material)).not.toThrow();

    const legacy = await runtime.runPromise(canvases.authoritySnapshot());
    expect(legacy).toMatchObject({
      generation: material.generation,
      intentSha256: material.intentSha256,
    });
    expect(legacy.documents).toEqual(material.documents);
    expect(legacy).not.toHaveProperty("storedDocuments");

    (material.documents as Map<string, CanvasDoc>).clear();
    expect(material.storedDocuments.size).toBe(2);
    (
      material.storedDocuments as Map<string, CanvasAuthorityStoredDocument>
    ).clear();

    const reread = await runtime.runPromise(
      canvases.authorityMaterialSnapshot(),
    );
    expect([...reread.documents.keys()]).toEqual(["alpha", "beta"]);
    expect([...reread.storedDocuments.keys()]).toEqual(["alpha", "beta"]);
    expect(() => verifyCanvasIntentMaterial(reread)).not.toThrow();
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
      () => taskSinkDoc().nodes[0]!.ether,
      "runtime work projection data",
    ],
    [
      "document-backed pad projection",
      () => padSinkDoc().nodes[0]!.ether,
      "runtime work projection data",
    ],
    [
      "an excess ether property",
      () => ({ entity: { kind: "note" }, mystery: true }),
      "failed validation",
    ],
    [
      "retired nested bindings",
      () => ({
        entity: { kind: "project", name: "demo" },
        bindings: [
          {
            source: "tower",
            ref: { type: "project", key: "demo" },
          },
        ],
      }),
      "failed validation",
    ],
  ] as const)("fails closed when an authority row contains %s", async (
    _case,
    invalidEther,
    expectedMessage
  ) => {
    await installEnv();
    const database = join(stateDir, "vellum-command.db");
    runtime = makeCanvasRuntime(database);
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("work", noteDoc("authorial")));

    // Corrupt the relational authority directly: the app write path can never
    // produce these rows, so the read path must fail closed rather than serve
    // or repair them.
    const state = await runtime.runPromise(StateEngine);
    await runtime.runPromise(
      state.transaction("test.inject-invalid-canvas", (writer) => {
        const canvasId = writer.get<{ readonly canvas_id: string }>(
          "SELECT canvas_id FROM canvas_documents WHERE canvas_name = 'work'",
        )?.canvas_id;
        if (canvasId === undefined) {
          throw new Error("expected work canvas_documents row");
        }
        writer.run(
          `UPDATE canvas_nodes SET ether_json = ? WHERE canvas_id = ?`,
          [JSON.stringify(invalidEther()), canvasId],
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

  it("keeps the authored board contract while stripping projected rows", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const authored = taskSinkDoc();
    await runtime.runPromise(
      canvases.write("work", {
        ...authored,
        nodes: authored.nodes.map((node) => ({
          ...node,
          ether: {
            ...node.ether,
            tasks: {
              ...node.ether?.tasks,
              items: node.ether?.tasks?.items ?? [],
              contract: {
                instructions: "review before sending on",
                rules: [{ id: "rule-1", text: "cite the source" }],
              },
            },
          },
        })),
      }),
    );

    const authority = await runtime.runPromise(canvases.authoritySnapshot());
    const tasks = authority.documents.get("work")?.nodes[0]?.ether?.tasks;
    expect(tasks?.items).toEqual([]);
    expect(tasks?.contract).toEqual({
      instructions: "review before sending on",
      rules: [{ id: "rule-1", text: "cite the source" }],
    });
  });

  it("stores exactly the current graph after many commits", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const state = await runtime.runPromise(StateEngine);

    const commits = 20;
    for (let i = 0; i < commits; i += 1) {
      await runtime.runPromise(canvases.write("alpha", noteDoc(`rev-${i}`)));
    }

    // Relational authority holds the head and nothing else: one document row,
    // exactly the current node set, zero growth with commit count.
    const counts = await runtime.runPromise(
      state.read("retention.counts", (reader) => ({
        documents: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_documents",
          )?.count ?? 0,
        ),
        nodes: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_nodes",
          )?.count ?? 0,
        ),
        edges: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_edges",
          )?.count ?? 0,
        ),
      })),
    );
    expect(counts).toEqual({ documents: 1, nodes: 1, edges: 0 });

    const head = await runtime.runPromise(canvases.authoritySnapshot());
    expect(head.generation).toBe(String(commits));
    expect(head.documents.get("alpha")?.nodes[0]).toMatchObject({
      text: `rev-${commits - 1}`,
    });
    const reread = await runtime.runPromise(canvases.read("alpha"));
    expect(reread.doc.nodes[0]).toMatchObject({ text: `rev-${commits - 1}` });

    await runtime.dispose();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const reopened = await runtime.runPromise(CanvasesService);
    expect(
      (await runtime.runPromise(reopened.read("alpha"))).doc.nodes[0],
    ).toMatchObject({ text: `rev-${commits - 1}` });
  });

  it("keeps a work-fact authorial basis as opaque history after later commits", async () => {
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
      state.read("retention.basis", (reader) =>
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

    const commits = 12;
    for (let i = 0; i < commits; i += 1) {
      await runtime.runPromise(canvases.write("alpha", noteDoc(`rev-${i}`)));
    }

    // The immutable fact keeps its founding basis generation verbatim while
    // the portfolio head advances past it; nothing references the retired
    // generation as a row, so no relational constraint can be violated.
    const survived = await runtime.runPromise(
      state.read("retention.basis.survived", (reader) => ({
        basis: reader.all<{ readonly generation: string }>(
          `
            SELECT DISTINCT basis_authorial_generation AS generation
            FROM work_facts
            WHERE basis_authorial_generation IS NOT NULL
          `,
        ),
        head: reader.get<{ readonly generation: string }>(
          "SELECT generation FROM canvas_portfolio_head WHERE singleton = 1",
        ),
        fkViolations: reader.all("PRAGMA foreign_key_check").length,
      })),
    );
    expect(survived.basis).toEqual(basis);
    expect(BigInt(survived.head?.generation ?? "0")).toBeGreaterThan(
      BigInt(basis[0]!.generation),
    );
    expect(survived.fkViolations).toBe(0);
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

  it("rejects a stale expectedRevision without advancing the generation", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const first = await runtime.runPromise(
      canvases.write("alpha", noteDoc("one")),
    );
    await runtime.runPromise(canvases.write("alpha", noteDoc("two")));
    await expect(
      runtime.runPromise(
        canvases.write("alpha", noteDoc("stale"), first.revision),
      ),
    ).rejects.toThrow("revision conflict");
    expect(await runtime.runPromise(canvases.liveAuthorityGeneration())).toBe(
      "2",
    );
    expect(
      (await runtime.runPromise(canvases.read("alpha"))).doc.nodes[0],
    ).toMatchObject({ text: "two" });
  });
});
