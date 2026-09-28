import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Result, Schema } from "effect";
import { ActorSeatId } from "../src/shared/actor-seat";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { OPERATOR_SEAT_ID, operatorActorRef } from "../src/shared/work-reference";
import {
  admitLiveOverseer,
  admitOverseerWorkTarget,
  admitWorkTarget,
  overseerWorkAdmin,
  requiresConnection,
} from "../src/main/junto/work/authz";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { WorkLive, WorkService } from "../src/main/junto/work/service";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/junto/station/fleet-target-repository";
import { InstallationId } from "../src/shared/installation-id";
import { HostId } from "../src/shared/remote-hosts";
import { StationLivePeerRegistryLive } from "../src/main/junto/station/session-registry";
import { makeSettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import {
  executeOverseerWork,
  overseerWorkRunsLocally,
} from "../src/main/junto/overseer/work";

const mockHome = join(tmpdir(), `junto-overseer-work-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockHome };
});



const mailboxNode = (
  id: string,
  canvas = "mailbox",
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 400,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `local:${canvas}-${id}` },
    terminal: {
      bindingId: `binding-${canvas}-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: "local",
  },
});

const agentNode = (
  id: string,
  canvas = "factory",
  hostId = "local",
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 120,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `${hostId}:${canvas}-${id}` },
    terminal: {
      bindingId: `binding-${canvas}-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: hostId,
  },
});

const factoryDoc = (
  canvas: string,
  edges: CanvasDoc["edges"] = [],
): CanvasDoc => ({
  nodes: [agentNode("boss", canvas), agentNode("worker", canvas)],
  edges,
});


const makeRuntime = () => {
  const databasePath = join(mockHome, "state", "junto.db");
  const installRoot = join(databasePath, "..");
  const stateLive = makeStateEngineLive(databasePath);
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
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
  await runtime.runPromise(canvases.write(canvas, factoryDoc(canvas, edges)));
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
    expect(requiresConnection("msg.send")).toBe(true);
  });

  it("admits a live overseer without an edge and denies an ordinary agent", () => {
    const doc = {
      ...factoryDoc("pure"),
      nodes: factoryDoc("pure").nodes.map((node) =>
        node.id === "boss"
          ? { ...node, ether: { ...node.ether, overseer: true } }
          : node,
      ),
    };
    const overseer = admitOverseerWorkTarget(doc, "worker", "msg.send");
    expect(Result.isSuccess(overseer)).toBe(true);
    const ordinary = admitWorkTarget(doc, "worker", "boss", "msg.send");
    expect(Result.isFailure(ordinary)).toBe(true);
    if (Result.isFailure(ordinary)) {
      expect(ordinary.failure.type).toBe("ScopeError");
    }
  });


  it("refuses operator-seat impersonation and a revoked grant", () => {
    const granted = {
      ...factoryDoc("pure"),
      nodes: factoryDoc("pure").nodes.map((node) =>
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

    const revokedDoc = factoryDoc("pure");
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
  it("lets a no-edge overseer send mail as the real actor", async () => {
    await writeFactory("floor");
    await grantOverseer("floor", "boss", true);
    const { actor } = await actorOn("floor", "boss");
    const sent = await run(
      executeOverseerWork(
        { canvasName: "floor", nodeId: "boss" },
        { operation: "msg.send", args: { target: "worker", text: "overseer note" } },
        overseerWorkAdmin(actor),
      ),
    );
    expect(sent).toMatchObject({ disposition: "applied" });
    expect(operatorActorRef("floor").seatId).not.toBe(actor.seatId);
  });

  it("denies an ordinary agent wrapping itself as overseer admin", async () => {
    await writeFactory("denial");
    await grantOverseer("denial", "boss", true);
    const { actor } = await actorOn("denial", "worker");
    const result = await run(
      executeOverseerWork(
        { canvasName: "denial", nodeId: "worker" },
        { operation: "msg.send", args: { target: "boss", text: "no grant" } },
        overseerWorkAdmin(actor),
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.type).toBe("AuthError");
  });

  it("fails after grant revocation at commit", async () => {
    await writeFactory("revoke");
    await grantOverseer("revoke", "boss", true);
    const { actor } = await actorOn("revoke", "boss");
    await grantOverseer("revoke", "boss", false);
    const result = await run(
      executeOverseerWork(
        { canvasName: "revoke", nodeId: "boss" },
        { operation: "msg.send", args: { target: "worker", text: "revoked" } },
        overseerWorkAdmin(actor),
      ).pipe(Effect.result),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.type).toBe("AuthError");
  });

  it("sends mail onto another canvas without an origin alias", async () => {
    const canvases = await writeFactory("origin-mail");
    await grantOverseer("origin-mail", "boss", true);
    await runtime.runPromise(
      canvases.write("target-mail", {
        nodes: [mailboxNode("peer", "target-mail")],
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

  it("lets a Remote overseer send Command Center mail without an edge", async () => {
    const remoteHost = Schema.decodeUnknownSync(HostId)("remote-admin-work");
    const remoteInstallation = Schema.decodeUnknownSync(InstallationId)(
      "remote-admin-work-installation",
    );
    const fleet = await runtime.runPromise(StationFleetTargetRepository);
    await runtime.runPromise(
      fleet.bind(
        { hostId: remoteHost, stationInstallationId: remoteInstallation },
        "2026-09-11T00:00:00.000Z",
      ),
    );
    const canvases = await writeFactory("remote-admin");
    await runtime.runPromise(
      canvases.write("remote-admin", {
        nodes: [
          mailboxNode("peer", "remote-admin"),
          agentNode("boss", "remote-admin", remoteHost),
          agentNode("worker", "remote-admin"),
        ],
        edges: [],
      }),
    );
    await grantOverseer("remote-admin", "boss", true);
    const { actor } = await actorOn("remote-admin", "boss");
    const sent = await run(
      executeOverseerWork(
        { canvasName: "remote-admin", nodeId: "boss" },
        {
          operation: "msg.send",
          args: { target: "peer", text: "hello from remote overseer" },
        },
        overseerWorkAdmin(actor),
      ),
    );
    expect(sent).toMatchObject({ disposition: "applied" });
  });

  it("ingests content locally and flags content ops as local-routing", async () => {
    expect(overseerWorkRunsLocally("content.ingest")).toBe(true);
    expect(overseerWorkRunsLocally("content.path")).toBe(true);
    expect(overseerWorkRunsLocally("msg.send")).toBe(false);
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
