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
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum-command/station/fleet-target-repository";
import { InstallationId } from "../src/shared/installation-id";
import { HostId } from "../src/shared/remote-hosts";
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

const mailboxNode = (id: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 400,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: {
      bindingId: `binding-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: "local",
  },
});

const artifactsNode = (id = "arts"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "artifacts",
  x: 600,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "artifacts" } },
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

const agentNode = (id: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 120,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: {
      bindingId: `binding-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: "local",
  },
});

const factoryDoc = (edges: CanvasDoc["edges"] = []): CanvasDoc => ({
  nodes: [taskNode(), padNode(), agentNode("boss"), agentNode("worker")],
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

const writeFactory = async (
  canvas: string,
  edges: CanvasDoc["edges"] = [],
) => {
  const canvases = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvases.write(canvas, factoryDoc(edges)));
  return canvases;
};

const grantOverseer = async (canvas: string, nodeId: string, overseer: boolean) => {
  const canvases = await runtime.runPromise(CanvasesService);
  const read = await runtime.runPromise(canvases.read(canvas));
  return runtime.runPromise(
    canvases.canvasOverseerSet({
      canvasName: canvas,
      nodeId,
      overseer,
      expectedRevision: read.revision,
    }),
  );
};

describe("overseer work authz", () => {
  it("treats the overseer envelope as not an edge grant", () => {
    expect(requiresConnection("overseer")).toBe(false);
    expect(requiresConnection("tasks.list")).toBe(true);
  });

  it("admits a live overseer without an edge and denies an ordinary agent", () => {
    const doc = {
      ...factoryDoc(),
      nodes: factoryDoc().nodes.map((node) =>
        node.id === "boss"
          ? { ...node, ether: { ...node.ether, overseer: true } }
          : node,
      ),
    };
    const overseer = admitOverseerWorkTarget(doc, "tasks", "tasks.list");
    expect(Result.isSuccess(overseer)).toBe(true);
    const ordinary = admitWorkTarget(doc, "worker", "tasks", "tasks.list");
    expect(Result.isFailure(ordinary)).toBe(true);
    if (Result.isFailure(ordinary)) {
      expect(ordinary.failure.type).toBe("ScopeError");
    }
  });

  it("refuses operator-seat impersonation and a revoked grant", () => {
    const granted = {
      ...factoryDoc(),
      nodes: factoryDoc().nodes.map((node) =>
        node.id === "boss"
          ? { ...node, ether: { ...node.ether, overseer: true } }
          : node,
      ),
    };
    const doc = granted;
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

    const revokedDoc = factoryDoc();
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
    await writeFactory("floor");
    await grantOverseer("floor", "boss", true);
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
    await writeFactory("denial");
    await grantOverseer("denial", "boss", true);
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
    await writeFactory("revoke");
    await grantOverseer("revoke", "boss", true);
    const { actor } = await actorOn("revoke", "boss");
    await grantOverseer("revoke", "boss", false);
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
    const canvases = await writeFactory("here");
    await grantOverseer("here", "boss", true);
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

  it("sends mail and publishes artifacts onto another canvas without an origin alias", async () => {
    const canvases = await writeFactory("origin-mail");
    await grantOverseer("origin-mail", "boss", true);
    await runtime.runPromise(
      canvases.write("target-mail", {
        nodes: [mailboxNode("peer"), artifactsNode()],
        edges: [],
      }),
    );
    const { actor } = await actorOn("origin-mail", "boss");
    const sent = await run(
      executeOverseerWork(
        { canvasName: "origin-mail", nodeId: "boss" },
        {
          operation: "msg.send",
          args: { canvas: "target-mail", target: "peer", text: "hello from origin" },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(sent).toMatchObject({ disposition: "applied" });
  });

  it("publishes artifacts on the origin canvas without an edge", async () => {
    const canvases = await writeFactory("origin-arts");
    await grantOverseer("origin-arts", "boss", true);
    await runtime.runPromise(
      canvases.write("origin-arts", {
        nodes: [taskNode(), padNode(), agentNode("boss"), agentNode("worker"), artifactsNode()],
        edges: [],
      }),
    );
    await grantOverseer("origin-arts", "boss", true);
    const { actor } = await actorOn("origin-arts", "boss");
    const published = await run(
      executeOverseerWork(
        { canvasName: "origin-arts", nodeId: "boss" },
        {
          operation: "artifact.publish",
          args: {
            target: "arts",
            parts: [{ kind: "text", text: "proof" }],
          },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(published).toMatchObject({ disposition: "applied" });
  });

  it("publishes artifacts onto another canvas with original publishedBy provenance", async () => {
    const canvases = await writeFactory("origin-xart");
    await grantOverseer("origin-xart", "boss", true);
    await runtime.runPromise(
      canvases.write("target-arts", {
        nodes: [artifactsNode()],
        edges: [],
      }),
    );
    const { actor } = await actorOn("origin-xart", "boss");
    const published = await run(
      executeOverseerWork(
        { canvasName: "origin-xart", nodeId: "boss" },
        {
          operation: "artifact.publish",
          args: {
            canvas: "target-arts",
            target: "arts",
            parts: [{ kind: "text", text: "proof" }],
          },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(published).toMatchObject({ disposition: "applied" });
    expect(actor.canvasName).toBe("origin-xart");
    expect((published as { readonly artifactId: string }).artifactId.length).toBeGreaterThan(0);
  });

  it("queues artifact.publish to a Remote publisher home from Command Center", async () => {
    const remoteHost = Schema.decodeUnknownSync(HostId)("remote-overseer");
    const remoteInstallation = Schema.decodeUnknownSync(InstallationId)(
      "remote-overseer-installation",
    );
    const fleet = await runtime.runPromise(StationFleetTargetRepository);
    await runtime.runPromise(
      fleet.bind(
        { hostId: remoteHost, stationInstallationId: remoteInstallation },
        "2026-09-11T00:00:00.000Z",
      ),
    );
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(
      canvases.write("remote-origin", {
        nodes: [
          {
            ...agentNode("boss"),
            ether: {
              ...agentNode("boss").ether,
              host: remoteHost,
            },
          },
          agentNode("worker"),
          taskNode(),
          padNode(),
        ],
        edges: [],
      }),
    );
    await grantOverseer("remote-origin", "boss", true);
    await runtime.runPromise(
      canvases.write("cc-arts", {
        nodes: [artifactsNode()],
        edges: [],
      }),
    );
    const { actor } = await actorOn("remote-origin", "boss");
    expect(actor.canvasName).toBe("remote-origin");
    const published = await run(
      executeOverseerWork(
        { canvasName: "remote-origin", nodeId: "boss" },
        {
          operation: "artifact.publish",
          args: {
            canvas: "cc-arts",
            target: "arts",
            parts: [{ kind: "text", text: "remote proof" }],
          },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(published).toMatchObject({ disposition: "queued" });
  });

  it("claims for an explicit assignee distinct from the overseer admin", async () => {
    const canvases = await writeFactory("claim-home");
    await grantOverseer("claim-home", "boss", true);
    await runtime.runPromise(
      canvases.write("claim-board", {
        nodes: [taskNode(), mailboxNode("assignee")],
        edges: [{ id: "e-claim", fromNode: "assignee", toNode: "tasks" }],
      }),
    );
    const { actor: boss } = await actorOn("claim-home", "boss");
    const created = await run(
      executeOverseerWork(
        { canvasName: "claim-home", nodeId: "boss" },
        {
          operation: "tasks.create",
          args: {
            canvas: "claim-board",
            target: "tasks",
            brief: "assign me",
            metadata: { details: "assign me" },
          },
        },
        overseerWorkAdmin(boss),
      ),
    );
    const taskId = (created as { readonly id: string }).id;
    const claimed = await run(
      executeOverseerWork(
        { canvasName: "claim-home", nodeId: "boss" },
        {
          operation: "tasks.claim",
          args: { canvas: "claim-board", target: "tasks", task: taskId, actor: "assignee" },
        },
        overseerWorkAdmin(boss),
      ),
    );
    expect(claimed).toMatchObject({ disposition: "applied" });
    const { actor: assignee } = await actorOn("claim-board", "assignee");
    expect((claimed as { readonly claimedBy?: string }).claimedBy ?? (claimed as { readonly id?: string }).id).toBeDefined();
    const listed = await run(
      executeOverseerWork(
        { canvasName: "claim-home", nodeId: "boss" },
        { operation: "tasks.list", args: { canvas: "claim-board", target: "tasks" } },
        overseerWorkAdmin(boss),
      ),
    );
    const row = (listed as { readonly items: ReadonlyArray<{ readonly id: string; readonly claimedBy?: string }> }).items.find(
      (item) => item.id === taskId,
    );
    expect(row?.claimedBy).toBe(assignee.seatId);
    expect(row?.claimedBy).not.toBe(boss.seatId);
  });

  it("patches pad ink as the real overseer actor, not the operator", async () => {
    await writeFactory("admin");
    await grantOverseer("admin", "boss", true);
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
    await writeFactory("bytes");
    await grantOverseer("bytes", "boss", true);
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
