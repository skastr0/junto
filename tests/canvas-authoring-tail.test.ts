import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
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
import { WorkLive } from "../src/main/vellum/work/service";
import { SettingsLive } from "../src/main/vellum/settings/service";
import { makeContentServiceLive } from "../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../src/main/vellum/install-ops/engine";
import {
  applyMirrorLaw,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";
import { DOCUMENT_REPLACE_V1 } from "../src/shared/canvas-authoring";
import { nodeSemanticHash } from "../src/main/vellum/canvas/relational-backfill";

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

describe("canvas authoring change tail", () => {
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
    stateDir = await mkdtemp(join(tmpdir(), "vellum-state-auth-"));
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

  it("commits a duplicate client change ID once", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const doc = noteDoc("once");
    const first = await runtime.runPromise(
      canvases.applyAuthoringCommand({
        kind: DOCUMENT_REPLACE_V1,
        changeId: "chg_duplicate",
        canvasName: "alpha",
        doc,
      }),
    );
    const second = await runtime.runPromise(
      canvases.applyAuthoringCommand({
        kind: DOCUMENT_REPLACE_V1,
        changeId: "chg_duplicate",
        canvasName: "alpha",
        doc: noteDoc("different"),
      }),
    );
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.generation).toBe(first.generation);
    expect(second.revision).toBe(first.revision);
    expect(await runtime.runPromise(canvases.liveAuthorityGeneration())).toBe(
      "1",
    );
    expect(
      (await runtime.runPromise(canvases.read("alpha"))).doc.nodes[0],
    ).toMatchObject({ text: "once" });
  });

  it("fails stale object hashes deterministically", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const firstDoc = noteDoc("fresh");
    await runtime.runPromise(
      canvases.applyAuthoringCommand({
        kind: DOCUMENT_REPLACE_V1,
        changeId: "chg_1",
        canvasName: "alpha",
        doc: firstDoc,
      }),
    );
    const result = await runtime.runPromise(
      Effect.result(
        canvases.applyAuthoringCommand({
          kind: DOCUMENT_REPLACE_V1,
          changeId: "chg_2",
          canvasName: "alpha",
          doc: noteDoc("next"),
          objectHashes: { n1: "a".repeat(64) },
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("stale object hash") },
    });
  });

  it("materializes the same canonical bytes as a full document replace", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const doc = noteDoc("parity");
    const command = await runtime.runPromise(
      canvases.applyAuthoringCommand({
        kind: DOCUMENT_REPLACE_V1,
        changeId: "chg_parity",
        canvasName: "alpha",
        doc,
      }),
    );
    const viaWrite = await runtime.runPromise(
      canvases.write("beta", doc),
    );
    const readAlpha = await runtime.runPromise(canvases.read("alpha"));
    const readBeta = await runtime.runPromise(canvases.read("beta"));
    expect(serializeCanvas(readAlpha.doc)).toBe(serializeCanvas(applyMirrorLaw(doc)));
    expect(serializeCanvas(readBeta.doc)).toBe(serializeCanvas(readAlpha.doc));
    expect(viaWrite.revision).toBe(command.revision);
    expect(readAlpha.revision).toBe(command.revision);
    const liveHash = nodeSemanticHash(readAlpha.doc.nodes[0]!);
    await runtime.runPromise(
      canvases.applyAuthoringCommand({
        kind: DOCUMENT_REPLACE_V1,
        changeId: "chg_admit",
        canvasName: "alpha",
        doc: noteDoc("admitted"),
        objectHashes: { n1: liveHash },
      }),
    );
    expect(
      (await runtime.runPromise(canvases.read("alpha"))).doc.nodes[0],
    ).toMatchObject({ text: "admitted" });
  });

  it("refuses payload-supplied provenance", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const result = await runtime.runPromise(
      Effect.result(
        canvases.applyAuthoringCommand({
          kind: DOCUMENT_REPLACE_V1,
          changeId: "chg_origin",
          canvasName: "alpha",
          doc: noteDoc("x"),
          origin: "spoofed-seat",
          author: "agent",
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: expect.stringContaining("authoring command refused") },
    });
  });

  it("returns checkpoint-required for a client behind the tail floor", async () => {
    await installEnv();
    runtime = makeCanvasRuntime(join(stateDir, "vellum-command.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    const state = await runtime.runPromise(StateEngine);
    const first = await runtime.runPromise(
      canvases.applyAuthoringCommand({
        kind: DOCUMENT_REPLACE_V1,
        changeId: "chg_old",
        canvasName: "alpha",
        doc: noteDoc("old"),
      }),
    );
    await runtime.runPromise(
      canvases.applyAuthoringCommand({
        kind: DOCUMENT_REPLACE_V1,
        changeId: "chg_new",
        canvasName: "alpha",
        doc: noteDoc("new"),
      }),
    );
    await runtime.runPromise(
      state.transaction("test.raise-tail-floor", (writer) => {
        writer.run(
          `
            UPDATE canvas_authoring_tail_state
            SET tail_floor_generation = '2', tail_floor_change_id = 'chg_new'
            WHERE singleton = 1
          `,
        );
      }),
    );
    const behind = await runtime.runPromise(
      canvases.readAuthoringTail({ afterChangeId: first.changeId }),
    );
    expect(behind.kind).toBe("checkpoint-required");
    if (behind.kind === "checkpoint-required") {
      expect(behind.generation).toBe("2");
      expect(behind.checkpointSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const live = await runtime.runPromise(
      canvases.readAuthoringTail({ afterChangeId: "chg_new" }),
    );
    expect(live.kind).toBe("commands");
  });
});
