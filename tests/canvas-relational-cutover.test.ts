import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum/canvases";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import {
  StateEngine,
  type StateWriter,
} from "../src/main/vellum/state/service";
import { WorkRepositoryLive } from "../src/main/vellum/work/repository";
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import {
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import { WorkLive } from "../src/main/vellum/work/service";
import { SettingsLive } from "../src/main/vellum/settings/service";
import { makeContentServiceLive } from "../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../src/main/vellum/install-ops/engine";
import {
  applyMirrorLaw,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";
import {
  persistRelationalPortfolio,
  reconstructCanvasDoc,
} from "../src/main/vellum/canvas/relational-records";
import { intentSha256Of } from "../src/main/vellum/canvas-intent-identity";

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

const factoryDoc = (): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      {
        id: "worker",
        type: "text",
        text: "worker",
        x: 40,
        y: 80,
        width: 220,
        height: 84,
        ether: {
          entity: { kind: "agent", name: "local:worker" },
          flags: ["blocker"],
        },
      },
      {
        id: "queue",
        type: "text",
        text: "queue",
        x: 320,
        y: 80,
        width: 220,
        height: 84,
        ether: { entity: { kind: "task" } },
      },
    ],
    edges: [
      {
        id: "e1",
        fromNode: "queue",
        toNode: "worker",
        ether: { verb: "works" },
      },
    ],
  });

const pipelineDoc = (sourceId: string): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      {
        id: sourceId,
        type: "text",
        text: "source",
        x: 0,
        y: 0,
        width: 160,
        height: 80,
        ether: { entity: { kind: "task" } },
      },
      {
        id: "target",
        type: "text",
        text: "target",
        x: 240,
        y: 0,
        width: 160,
        height: 80,
        ether: { entity: { kind: "task" } },
      },
    ],
    edges: [
      {
        id: "retained-edge",
        fromNode: sourceId,
        toNode: "target",
        ether: { verb: "feeds" },
      },
    ],
  });

const crashingWriter = (writer: StateWriter, after: number): StateWriter => {
  let writes = 0;
  return {
    get: (sql, bindings) => writer.get(sql, bindings),
    all: (sql, bindings) => writer.all(sql, bindings),
    run: (sql, bindings) => {
      writes += 1;
      if (writes >= after) {
        throw new Error(`injected crash after ${after} writes`);
      }
      return writer.run(sql, bindings);
    },
  };
};

describe("canvas relational authority cutover", () => {
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
    return ManagedRuntime.make(
      Layer.provideMerge(
        WorkLive,
        Layer.mergeAll(canvases, StationLivePeerRegistryLive) as never,
      ),
    );
  };
  let runtime: ReturnType<typeof makeCanvasRuntime> | undefined;

  const installEnv = async (): Promise<void> => {
    canvasesDir = await mkdtemp(join(tmpdir(), "vellum-canvases-"));
    stateDir = await mkdtemp(join(tmpdir(), "vellum-state-rel-"));
    previousCanvases = process.env.VELLUM_COMMAND_CANVASES_DIR;
    process.env.VELLUM_COMMAND_CANVASES_DIR = canvasesDir;
  };

  const restoreEnv = async (): Promise<void> => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
    if (previousCanvases === undefined) {
      delete process.env.VELLUM_COMMAND_CANVASES_DIR;
    } else {
      process.env.VELLUM_COMMAND_CANVASES_DIR = previousCanvases;
    }
    if (canvasesDir) await rm(canvasesDir, { recursive: true, force: true });
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    canvasesDir = "";
    stateDir = "";
  };

  afterEach(async () => {
    await restoreEnv();
  });

  it("reuses unchanged checkpoint bodies across generations", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const state = await runtime.runPromise(StateEngine);

    await runtime.runPromise(canvases.write("alpha", noteDoc("one")));
    await runtime.runPromise(canvases.write("beta", noteDoc("keep")));
    await runtime.runPromise(canvases.write("alpha", noteDoc("two")));

    const counts = await runtime.runPromise(
      state.read("cutover.reuse", (reader) => ({
        generations: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_generations",
          )?.count ?? 0,
        ),
        documents: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_generation_documents",
          )?.count ?? 0,
        ),
        checkpoints: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_checkpoints",
          )?.count ?? 0,
        ),
        manifests: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_generation_manifests",
          )?.count ?? 0,
        ),
        envelopes: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_commit_envelopes",
          )?.count ?? 0,
        ),
      })),
    );

    expect(counts.generations).toBe(3);
    expect(counts.envelopes).toBe(3);
    expect(counts.documents).toBe(1 + 2 + 2);
    expect(counts.manifests).toBe(1 + 2 + 2);
    expect(counts.checkpoints).toBe(3);

    const read = await runtime.runPromise(canvases.read("beta"));
    expect(read.doc.nodes[0]).toMatchObject({ text: "keep" });
  });

  it("round-trips relational rows to the canonical checkpoint bytes", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const state = await runtime.runPromise(StateEngine);
    const doc = factoryDoc();
    await runtime.runPromise(canvases.write("factory", doc));

    const row = await runtime.runPromise(
      state.read("cutover.roundtrip", (reader) => {
        const document = reader.get<{
          readonly canvas_id: string;
          readonly head_checkpoint_sha256: string;
        }>(
          "SELECT canvas_id, head_checkpoint_sha256 FROM canvas_documents WHERE canvas_name = ?",
          ["factory"],
        );
        if (document === undefined) {
          throw new Error("missing factory canvas_documents row");
        }
        const reconstructed = reconstructCanvasDoc(reader, document.canvas_id);
        const checkpoint = reader.get<{ readonly body: string }>(
          "SELECT body FROM canvas_checkpoints WHERE sha256 = ?",
          [document.head_checkpoint_sha256],
        );
        return {
          reconstructed: serializeCanvas(reconstructed),
          checkpoint: checkpoint?.body,
          expected: serializeCanvas(doc),
        };
      }),
    );
    expect(row.checkpoint).toBe(row.expected);
    expect(row.reconstructed).toBe(row.expected);
  });

  it("rewires a retained edge before deleting its former endpoint", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const state = await runtime.runPromise(StateEngine);

    await runtime.runPromise(canvases.write("pipeline", pipelineDoc("old-source")));
    await runtime.runPromise(canvases.write("pipeline", pipelineDoc("new-source")));

    const rows = await runtime.runPromise(
      state.read("cutover.rewire", (reader) => {
        const canvasId = reader.get<{ readonly canvas_id: string }>(
          "SELECT canvas_id FROM canvas_documents WHERE canvas_name = 'pipeline'",
        )?.canvas_id;
        if (canvasId === undefined) throw new Error("missing pipeline canvas");
        return {
          edge: reader.get<{
            readonly from_node_id: string;
            readonly to_node_id: string;
          }>(
            "SELECT from_node_id, to_node_id FROM canvas_edges WHERE canvas_id = ? AND edge_id = 'retained-edge'",
            [canvasId],
          ),
          oldNodeCount: Number(
            reader.get<{ readonly count: number | bigint }>(
              "SELECT count(*) AS count FROM canvas_nodes WHERE canvas_id = ? AND node_id = 'old-source'",
              [canvasId],
            )?.count ?? 0,
          ),
          oldDeletedGeneration: reader.get<{
            readonly deleted_generation: string | null;
          }>(
            "SELECT deleted_generation FROM canvas_objects WHERE canvas_id = ? AND object_id = 'old-source'",
            [canvasId],
          )?.deleted_generation,
        };
      }),
    );
    expect(rows.edge).toEqual({
      from_node_id: "new-source",
      to_node_id: "target",
    });
    expect(rows.oldNodeCount).toBe(0);
    expect(rows.oldDeletedGeneration).toBe("2");
  });

  it("rolls a crashed relational persist back to the previous generation", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const state = await runtime.runPromise(StateEngine);
    await runtime.runPromise(canvases.write("alpha", noteDoc("one")));

    const nextDoc = noteDoc("two");
    const nextBody = serializeCanvas(nextDoc);
    const revisionSha256 = createHash("sha256")
      .update(nextBody, "utf8")
      .digest("hex");
    const documents = new Map([
      [
        "alpha",
        {
          doc: nextDoc,
          body: nextBody,
          revisionSha256,
          modifiedAt: new Date().toISOString(),
        },
      ],
    ]);

    await expect(
      runtime.runPromise(
        state.transaction("cutover.crash", (writer) => {
          writer.run(
            `
              INSERT INTO canvas_generations(
                generation, created_at, cause, intent_sha256, document_count
              ) VALUES (?, ?, ?, ?, ?)
            `,
            [
              "2",
              new Date().toISOString(),
              "write",
              intentSha256Of(documents),
              1,
            ],
          );
          persistRelationalPortfolio(crashingWriter(writer, 3), {
            generation: "2",
            parentGeneration: "1",
            cause: "write",
            intentSha256: intentSha256Of(documents),
            createdAt: new Date().toISOString(),
            documents,
          });
        }),
      ),
    ).rejects.toThrow(/injected crash/);

    expect(await runtime.runPromise(canvases.liveAuthorityGeneration())).toBe(
      "1",
    );
    expect(
      (await runtime.runPromise(canvases.read("alpha"))).doc.nodes[0],
    ).toMatchObject({ text: "one" });

    const leftover = await runtime.runPromise(
      state.read("cutover.crash.leftover", (reader) => ({
        generations: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_generations",
          )?.count ?? 0,
        ),
        envelopes: Number(
          reader.get<{ readonly count: number }>(
            "SELECT count(*) AS count FROM canvas_commit_envelopes WHERE generation = '2'",
          )?.count ?? 0,
        ),
      })),
    );
    expect(leftover).toEqual({ generations: 1, envelopes: 0 });
  });
});
