import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { ActorSeatId } from "../src/shared/actor-seat";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { OPERATOR_SEAT_ID, operatorActorRef } from "../src/shared/work-reference";
import { asPadElementId } from "../src/shared/pad";
import {
  admitLiveOverseer,
  admitOverseerWorkTarget,
  admitWorkTarget,
  overseerWorkAdmin,
  requiresConnection,
} from "../src/main/vellum-command/work/authz";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { WorkLive, WorkService } from "../src/main/vellum-command/work/service";
import { WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum-command/station/session-registry";
import { makeSettingsLive, SettingsService } from "../src/main/vellum-command/settings/service";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import {
  executeOverseerWork,
  overseerWorkRunsLocally,
} from "../src/main/vellum-command/overseer/work";

const mockHome = join(tmpdir(), `vellum-command-overseer-work-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHome };
});

const taskNode = (id = "tasks"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "task" } },
});

const padNode = (id = "pad-1"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "pad",
  x: 200,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "pad" } },
});

const agentNode = (
  id: string,
  overseer = false,
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 120,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    ...(overseer ? { overseer: true } : {}),
    terminal: {
      bindingId: `binding-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: "local",
  },
});

const factoryDoc = (overseer: boolean, edges: CanvasDoc["edges"]): CanvasDoc => ({
  nodes: [taskNode(), padNode(), agentNode("boss", overseer), agentNode("worker")],
  edges,
});

const makeRuntime = () => {
  const databasePath = join(mockHome, "state", "vellum-command.db");
  const installRoot = join(databasePath, "..");
  const stateLive = makeStateEngineLive(databasePath);
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({
        root: join(installRoot, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(installRoot, "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(CanvasesLive, repositoriesLive);
  return ManagedRuntime.make(
    Layer.provideMerge(
      WorkLive,
      Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive) as never,
    ) as never,
  );
};

const runtime = makeRuntime();
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  runtime.runPromise(effect as Effect.Effect<A, E, never>);

beforeAll(async () => {
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(
    settings.setStationTopology({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
  await rm(mockHome, { recursive: true, force: true });
});

const actorOn = async (canvas: string, nodeId: string) => {
  const canvases = await runtime.runPromise(CanvasesService);
  const read = await runtime.runPromise(canvases.read(canvas));
  const actor = read.actorRefs.find((candidate) => candidate.nodeId === nodeId);
  if (actor === undefined) throw new Error(`missing actor ${nodeId}`);
  return { canvases, read, actor };
};

describe("overseer work authz", () => {
  it("treats the overseer envelope as not an edge grant", () => {
    expect(requiresConnection("overseer")).toBe(false);
    expect(requiresConnection("tasks.list")).toBe(true);
  });

  it("admits a live overseer without an edge and denies an ordinary agent", () => {
    const doc = factoryDoc(true, []);
    const overseer = admitOverseerWorkTarget(doc, "tasks", "tasks.list");
    expect(Result.isSuccess(overseer)).toBe(true);
    const ordinary = admitWorkTarget(doc, "worker", "tasks", "tasks.list");
    expect(Result.isFailure(ordinary)).toBe(true);
    if (Result.isFailure(ordinary)) {
      expect(ordinary.failure.type).toBe("ScopeError");
    }
  });

  it("refuses operator-seat impersonation and a revoked grant", () => {
    const doc = factoryDoc(true, []);
    const live = {
      seatId: Schema.decodeUnknownSync(ActorSeatId)("seat_" + "a".repeat(64)),
      canvasName: "floor",
      nodeId: "boss",
    };
    const forged = admitLiveOverseer(
      doc,
      [live],
      { canvasName: "floor", nodeId: "boss" },
      {
        kind: "overseer",
        actor: { seatId: OPERATOR_SEAT_ID, canvasName: "floor", nodeId: "operator" },
      },
    );
    expect(Result.isFailure(forged)).toBe(true);

    const revokedDoc = factoryDoc(false, []);
    const revoked = admitLiveOverseer(
      revokedDoc,
      [live],
      { canvasName: "floor", nodeId: "boss" },
      overseerWorkAdmin(live),
    );
    expect(Result.isFailure(revoked)).toBe(true);
  });
});

describe("executeOverseerWork", () => {
  it("lets a no-edge overseer create and comment as the real actor, not the operator", async () => {
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("floor", factoryDoc(true, [])));
    const { actor } = await actorOn("floor", "boss");
    const created = await run(
      executeOverseerWork(
        { canvasName: "floor", nodeId: "boss" },
        {
          operation: "tasks.create",
          args: { target: "tasks", brief: "overseer brief", metadata: { details: "overseer brief" } },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(created).toMatchObject({ disposition: "applied" });
    const taskId = (created as { readonly id: string }).id;
    const commented = await run(
      executeOverseerWork(
        { canvasName: "floor", nodeId: "boss" },
        {
          operation: "tasks.comment",
          args: { target: "tasks", task: taskId, text: "overseer note" },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(commented).toMatchObject({ disposition: "applied" });
    const message = commented as { readonly metadata?: { readonly fromSeat?: string } };
    expect(message.metadata?.fromSeat).toBe("boss");
    expect(message.metadata?.fromSeat).not.toBe("operator");
    expect(operatorActorRef("floor").seatId).not.toBe(actor.seatId);
  });

  it("denies an ordinary agent wrapping itself as overseer admin", async () => {
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("denial", factoryDoc(true, [])));
    const { actor } = await actorOn("denial", "worker");
    await expect(
      run(
        executeOverseerWork(
          { canvasName: "denial", nodeId: "worker" },
          { operation: "tasks.list", args: { target: "tasks" } },
          overseerWorkAdmin(actor),
        ).pipe(Effect.result),
      ).then((result) => {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.type).toBe("AuthError");
        }
      }),
    ).resolves.toBeUndefined();
  });

  it("fails after grant revocation at commit", async () => {
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("revoke", factoryDoc(true, [])));
    const { actor } = await actorOn("revoke", "boss");
    await runtime.runPromise(canvases.write("revoke", factoryDoc(false, [])));
    const result = await run(
      executeOverseerWork(
        { canvasName: "revoke", nodeId: "boss" },
        { operation: "tasks.list", args: { target: "tasks" } },
        overseerWorkAdmin(actor),
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.type).toBe("AuthError");
  });

  it("operates on another canvas while keeping origin actor provenance", async () => {
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("here", factoryDoc(true, [])));
    await runtime.runPromise(
      canvases.write("there", {
        nodes: [taskNode(), padNode()],
        edges: [],
      }),
    );
    const { actor } = await actorOn("here", "boss");
    expect(actor.canvasName).toBe("here");
    const created = await run(
      executeOverseerWork(
        { canvasName: "here", nodeId: "boss" },
        {
          operation: "tasks.create",
          args: {
            canvas: "there",
            target: "tasks",
            brief: "cross canvas",
            metadata: { details: "cross canvas" },
          },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(created).toMatchObject({ disposition: "applied" });
    const taskId = (created as { readonly id: string }).id;
    const listed = await run(
      executeOverseerWork(
        { canvasName: "here", nodeId: "boss" },
        { operation: "tasks.list", args: { canvas: "there", target: "tasks" } },
        overseerWorkAdmin(actor),
      ),
    );
    expect((listed as { readonly items: ReadonlyArray<{ readonly id: string }> }).items.some(
      (item) => item.id === taskId,
    )).toBe(true);
  });

  it("patches pad ink as the real overseer actor, not the operator", async () => {
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(
      canvases.write("admin", {
        nodes: [taskNode(), padNode(), agentNode("boss", true)],
        edges: [],
      }),
    );
    const { actor } = await actorOn("admin", "boss");
    const patched = await run(
      executeOverseerWork(
        { canvasName: "admin", nodeId: "boss" },
        {
          operation: "pad.patch",
          args: {
            target: "pad-1",
            patches: [
              {
                op: "upsert",
                layer: "ink",
                ink: {
                  id: asPadElementId("k-overseer"),
                  z: 0,
                  color: "#fff",
                  width: 2,
                  points: [
                    { x: 0, y: 0 },
                    { x: 4, y: 4 },
                  ],
                },
              },
            ],
          },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(patched).toMatchObject({ disposition: "applied" });
    const pad = patched as { readonly pad: { readonly inks: ReadonlyArray<{ readonly id: string }> } };
    expect(pad.pad.inks.some((stroke) => stroke.id === "k-overseer")).toBe(true);
  });

  it("ingests content locally and flags content ops as local-routing", async () => {
    expect(overseerWorkRunsLocally("content.ingest")).toBe(true);
    expect(overseerWorkRunsLocally("content.path")).toBe(true);
    expect(overseerWorkRunsLocally("tasks.create")).toBe(false);
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("bytes", factoryDoc(true, [])));
    const { actor } = await actorOn("bytes", "boss");
    const ingested = await run(
      executeOverseerWork(
        { canvasName: "bytes", nodeId: "boss" },
        {
          operation: "content.ingest",
          args: {
            bytesBase64: Buffer.from("overseer-bytes").toString("base64"),
            mediaType: "text/plain",
            displayName: "note.txt",
          },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(ingested).toMatchObject({ disposition: "applied" });
    expect((ingested as { readonly ref: { readonly sha256: string } }).ref.sha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
});
