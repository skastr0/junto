import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  workArtifactPublish,
  workMessageAppend,
  workRequestCreate,
  workRequestResolve,
  workTaskClaim,
  workTaskCreate,
  workTaskDescribe,
  workTaskRespond,
  workTaskTransition,
  WorkError,
} from "../src/shared/work";
import type { Artifact, CanvasDoc, Message } from "../src/shared/canvas";
import { canTransitionTaskState } from "../src/shared/task";
import {
  ActorRef,
  IntentFactBasis,
  type IntentFactBasis as IntentFactBasisValue,
} from "../src/shared/work-protocol";
import { InstallationId } from "../src/shared/installation-id";
import { HostId } from "../src/shared/remote-hosts";
import {
  ConfigureRequest,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
} from "../src/shared/station-api";

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

const actorRef = (
  digit: string,
  nodeId: string,
  canvasName = "alpha",
) =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: `seat_${digit.repeat(64)}`,
    canvasName,
    nodeId,
  });

const installationId = Schema.decodeUnknownSync(InstallationId);
const remoteHostId = Schema.decodeUnknownSync(HostId);
const stationHostId = Schema.decodeUnknownSync(StationHostId);
const logicalSequence = Schema.decodeUnknownSync(LogicalSequence);

const emptyTaskNode = (id = "tasks"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "task" } },
});

const emptyRequestsNode = (id = "req"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "0 pending",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "requests" } },
});

const agentNode = (
  id = "agent",
  hostId = "local",
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "mira",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `${hostId}:${id}` },
    terminal: {
      bindingId: `binding-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: hostId,
  },
});

describe("work pure transforms", () => {
  it("create → claim → transition, with contextId from canvas name", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship docs", undefined, ids);
    doc = created.doc;
    expect(created.task.state).toBe("submitted");
    expect(created.task.history[0]?.parts[0]).toEqual({ kind: "text", text: "ship docs" });
    expect(created.task.history[0]?.contextId).toBe("alpha");
    expect((doc.nodes[0] as { text: string }).text).toBe("ship docs");

    const worker = actorRef("1", "worker-1");
    const claimed = workTaskClaim(doc, "alpha", "tasks", created.task.id, worker, ids);
    doc = claimed.doc;
    expect(claimed.task.state).toBe("working");
    expect(claimed.task.claimedBy).toBe(worker.seatId);
    expect(claimed.claimedBy).toEqual(worker);

    const historyLength = claimed.task.history.length;
    const alias = actorRef("1", "worker-alias", "beta");
    const replayed = workTaskClaim(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      alias,
      ids,
    );
    doc = replayed.doc;
    expect(replayed.task.history).toHaveLength(historyLength);
    expect(replayed.task.claimedBy).toBe(worker.seatId);
    expect(replayed.claimedBy).toEqual(alias);

    expect(() =>
      workTaskClaim(
        doc,
        "alpha",
        "tasks",
        created.task.id,
        actorRef("2", "other-agent"),
        ids,
      ),
    ).toThrow(WorkError);
    try {
      workTaskClaim(
        doc,
        "alpha",
        "tasks",
        created.task.id,
        actorRef("2", "other-agent"),
        ids,
      );
    } catch (e) {
      expect(e).toBeInstanceOf(WorkError);
      expect((e as WorkError).code).toBe("claim_contention");
    }

    const done = workTaskTransition(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      "completed",
      "shipped",
      ids,
    );
    expect(done.task.state).toBe("completed");
    expect(done.task.history.at(-1)?.role).toBe("agent");
    expect(done.task.history.at(-1)?.parts[0]).toEqual({ kind: "text", text: "shipped" });
  });

  it("generic transition cannot turn unclaimed submitted work into attention", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "needs answer", undefined, ids);
    for (const state of ["input-required", "auth-required"] as const) {
      expect(() =>
        workTaskTransition(
          created.doc,
          "c",
          "tasks",
          created.task.id,
          state,
          undefined,
          ids,
        ),
      ).toThrowError(
        expect.objectContaining<Partial<WorkError>>({
          code: "illegal_transition",
        }),
      );
    }
  });

  it("releases active work back to Queue and clears its claimant atomically", () => {
    const created = workTaskCreate(
      { nodes: [emptyTaskNode()], edges: [] },
      "alpha",
      "tasks",
      "release me",
      undefined,
      ids,
    );
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids,
    );

    const released = workTaskTransition(
      claimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "submitted",
      undefined,
      ids,
    );

    expect(released.task.state).toBe("submitted");
    expect(released.task.claimedBy).toBeUndefined();
  });

  it("respond atomically records one operator message and resolves attention", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "need direction", undefined, ids);
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids,
    );
    const waiting = workTaskTransition(
      claimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "input-required",
      "need the deployment region",
      ids,
    );
    doc = waiting.doc;

    const responded = workTaskRespond(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      "  Deploy to us-east-1.  ",
      "working",
      ids,
    );

    expect(responded.task.state).toBe("working");
    expect(responded.task.history.at(-1)).toMatchObject({
      role: "user",
      taskId: created.task.id,
      parts: [{ kind: "text", text: "Deploy to us-east-1." }],
    });
    expect(() =>
      workTaskRespond(
        responded.doc,
        "alpha",
        "tasks",
        created.task.id,
        "another response",
        "working",
        ids,
      ),
    ).toThrowError(expect.objectContaining({ code: "illegal_transition" }));
    expect(
      (responded.doc.nodes[0]?.ether?.tasks?.items.find(
        (task) => task.id === created.task.id,
      )?.history.length),
    ).toBe(responded.task.history.length);
  });

  it("describe re-authors the brief in place, keeps later notes, updates mirror text", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship docs", undefined, ids);
    doc = created.doc;
    const noted = workTaskClaim(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids,
    );
    doc = noted.doc;

    const described = workTaskDescribe(doc, "alpha", "tasks", created.task.id, "ship the docs site", ids);
    doc = described.doc;
    expect(described.task.history[0]?.parts[0]).toEqual({ kind: "text", text: "ship the docs site" });
    expect(described.task.history[0]?.role).toBe("user");
    expect(described.task.history.at(-1)?.parts[0]).toEqual({
      kind: "text",
      text: `claimed by ${actorRef("1", "worker-1").seatId}`,
    });
    expect(described.task.state).toBe("working");
    expect((doc.nodes[0] as { text: string }).text).toBe("ship the docs site");
  });

  it("describe rejects empty briefs, terminal states, and unknown ids", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "x", undefined, ids);
    doc = created.doc;

    expect(() => workTaskDescribe(doc, "c", "tasks", created.task.id, "   ", ids)).toThrow(WorkError);
    expect(() => workTaskDescribe(doc, "c", "tasks", "nope", "y", ids)).toThrow(WorkError);

    const done = workTaskTransition(doc, "c", "tasks", created.task.id, "completed", undefined, ids);
    doc = done.doc;
    try {
      workTaskDescribe(doc, "c", "tasks", created.task.id, "rewrite history", ids);
      expect.unreachable("terminal task must not be re-described");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkError);
      expect((e as WorkError).code).toBe("illegal_transition");
    }
  });

  it("rejects illegal transitions and unknown ids", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "x", undefined, ids);
    doc = created.doc;
    expect(() =>
      workTaskTransition(
        doc,
        "c",
        "tasks",
        created.task.id,
        "working",
        undefined,
        ids,
      ),
    ).toThrow(/cannot transition/);
    const completed = workTaskTransition(
      doc,
      "c",
      "tasks",
      created.task.id,
      "completed",
      undefined,
      ids,
    );
    doc = completed.doc;
    expect(() =>
      workTaskTransition(doc, "c", "tasks", created.task.id, "working", undefined, ids),
    ).toThrow(/cannot transition/);
    expect(() => workTaskCreate(doc, "c", "missing", "x", undefined, ids)).toThrow(
      /not found/,
    );
  });

  it("rejects the retired metadata claimant instead of tolerating a dual shape", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    expect(() =>
      workTaskCreate(
        doc,
        "c",
        "tasks",
        "x",
        { claimedBy: actorRef("1", "worker-1", "c").seatId },
        ids,
      ),
    ).toThrow(/metadata\.claimedBy is retired/);
  });

  it("request raised by an actor is claimed by that actor at birth, with its reason", () => {
    const doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    const raised = workRequestCreate(
      doc,
      "c",
      "req",
      "need a key",
      undefined,
      ids,
      actorRef("7", "actor-7", "c"),
      "signing is gated on the operator's key",
    );
    expect(raised.task.state).toBe("input-required");
    expect(raised.task.claimedBy).toBe(actorRef("7", "actor-7", "c").seatId);
    expect(raised.task.reason).toBe("signing is gated on the operator's key");
  });

  it("task create records its reason first-class", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "port the map", undefined, ids, "fleet epic");
    expect(created.task.reason).toBe("fleet epic");
    const bare = workTaskCreate(doc, "c", "tasks", "port the map", undefined, ids);
    expect(bare.task.reason).toBeUndefined();
  });

  it("request create + resolve appends user message and clears input-required", () => {
    let doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    const created = workRequestCreate(
      doc,
      "c",
      "req",
      "need approval",
      { class: "review" },
      ids,
      actorRef("4", "actor-4", "c"),
    );
    doc = created.doc;
    expect(created.task.state).toBe("input-required");
    expect(created.task.metadata?.class).toBe("review");
    expect(created.task.claimedBy).toBe(actorRef("4", "actor-4", "c").seatId);
    expect((doc.nodes[0] as { text: string }).text.startsWith("1 pending")).toBe(true);

    const resolved = workRequestResolve(
      doc,
      "c",
      "req",
      created.task.id,
      "approved",
      "completed",
      ids,
    );
    expect(resolved.task.state).toBe("completed");
    expect(resolved.task.history.at(-1)?.role).toBe("user");
    // The answer is first-class on the item, not only buried in history.
    expect(resolved.task.response).toBe("approved");
    expect((resolved.doc.nodes[0] as { text: string }).text.startsWith("0 pending")).toBe(true);
  });

  it("message append to agent list and task history", () => {
    let doc: CanvasDoc = {
      nodes: [emptyTaskNode(), agentNode()],
      edges: [],
    };
    const created = workTaskCreate(doc, "c", "tasks", "brief", undefined, ids);
    doc = created.doc;
    const msg: Message = {
      messageId: "manual-1",
      role: "agent",
      parts: [{ kind: "text", text: "status note" }],
    };
    const onTask = workMessageAppend(doc, "c", "tasks", created.task.id, msg);
    doc = onTask.doc;
    const task = doc.nodes
      .find((n) => n.id === "tasks")
      ?.ether?.tasks?.items.find((t) => t.id === created.task.id);
    expect(task?.history.some((h) => h.messageId === "manual-1")).toBe(true);

    const onAgent = workMessageAppend(doc, "c", "agent", null, {
      messageId: "manual-2",
      role: "user",
      parts: [{ kind: "text", text: "ping" }],
    });
    const messages = onAgent.doc.nodes.find((n) => n.id === "agent")?.ether?.messages?.items;
    expect(messages?.some((m) => m.messageId === "manual-2")).toBe(true);
    expect(messages?.[0]?.contextId).toBe("c");
  });

  it("uses region label as contextId when node is inside a group", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "reg",
          type: "group",
          label: "forge-lane",
          x: 0,
          y: 0,
          width: 400,
          height: 300,
        },
        {
          id: "tasks",
          type: "text",
          text: "tasks",
          x: 40,
          y: 40,
          width: 120,
          height: 80,
          ether: { entity: { kind: "task" } },
        },
      ],
      edges: [],
    };
    const created = workTaskCreate(doc, "canvas-name", "tasks", "inside", undefined, ids);
    expect(created.task.history[0]?.contextId).toBe("forge-lane");
  });

  it("links artifacts only to an exact claimed task in the same canvas", () => {
    const artifactNode: CanvasDoc["nodes"][number] = {
      id: "artifacts",
      type: "text",
      text: "artifacts",
      x: 240,
      y: 0,
      width: 200,
      height: 100,
      ether: { entity: { kind: "artifacts" } },
    };
    let doc: CanvasDoc = {
      nodes: [emptyTaskNode(), artifactNode],
      edges: [],
    };
    const created = workTaskCreate(
      doc,
      "alpha",
      "tasks",
      "ship",
      undefined,
      ids,
    );
    doc = created.doc;

    const artifact = {
      artifactId: "artifact-task-proof",
      parts: [{ kind: "text" as const, text: "proof" }],
      task: {
        kind: "task" as const,
        itemId: created.task.id,
        sink: { canvasName: "alpha", nodeId: "tasks" },
      },
    };

    expect(() =>
      workArtifactPublish(doc, "alpha", "artifacts", artifact),
    ).toThrow(/must be claimed/);

    const claimed = workTaskClaim(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids,
    );
    doc = claimed.doc;
    expect(
      workArtifactPublish(doc, "alpha", "artifacts", artifact).artifact.task,
    ).toEqual(artifact.task);

    expect(() =>
      workArtifactPublish(doc, "alpha", "artifacts", {
        ...artifact,
        artifactId: "artifact-missing-task",
        task: { ...artifact.task, itemId: "missing" },
      }),
    ).toThrow(/not found/);

    expect(() =>
      workArtifactPublish(doc, "alpha", "artifacts", {
        ...artifact,
        artifactId: "artifact-cross-canvas",
        task: {
          ...artifact.task,
          sink: { ...artifact.task.sink, canvasName: "other" },
        },
      }),
    ).toThrow(/artifact canvas/);
  });

  it("state machine: terminal has no exits", () => {
    expect(canTransitionTaskState("completed", "working")).toBe(false);
    expect(canTransitionTaskState("submitted", "working")).toBe(false);
    expect(canTransitionTaskState("input-required", "rejected")).toBe(true);
    // Attention states are symmetric: both can fail, complete, or swap.
    expect(canTransitionTaskState("input-required", "failed")).toBe(true);
    expect(canTransitionTaskState("auth-required", "completed")).toBe(true);
    expect(canTransitionTaskState("auth-required", "input-required")).toBe(true);
  });
});

// --- service serialization under concurrent claims -------------------------

const mockCanvasesHome = join(tmpdir(), `vellum-work-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});

vi.mock("@shared/canvas", () => import("../src/shared/canvas"));
vi.mock("@shared/seed", () => import("../src/shared/seed"));

import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import {
  StationRepository,
  StationRepositoryLive,
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import {
  compileStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";

const makeWorkRuntime = (databasePath: string) => {
  const stateLive = makeStateEngineLive(databasePath);
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      SettingsLive,
    ),
    stateLive,
  );
  const canvasesLive = Layer.provideMerge(
    CanvasesLive,
    repositoriesLive,
  );
  return ManagedRuntime.make(
    Layer.provideMerge(
      WorkLive,
      Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive),
    ),
  );
};

const activeIntentBasis = async (
  runtime: ReturnType<typeof makeWorkRuntime>,
  kind: IntentFactBasisValue["kind"],
): Promise<IntentFactBasisValue> => {
  const canvases = await runtime.runPromise(CanvasesService);
  const witness = await runtime.runPromise(canvases.activeIntentWitness());
  return Schema.decodeUnknownSync(IntentFactBasis, {
    onExcessProperty: "error",
  })({
    kind,
    ...witness,
  });
};

const workRuntime = makeWorkRuntime(
  join(mockCanvasesHome, "state", "vellum.db"),
);
let work: Context.Tag.Service<typeof WorkService>;
let canvases: Context.Tag.Service<typeof CanvasesService>;
let repository: Context.Tag.Service<typeof WorkRepository>;

beforeAll(async () => {
  const settings = await workRuntime.runPromise(SettingsService);
  await workRuntime.runPromise(
    settings.setStationTopology({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    }),
  );
  work = await workRuntime.runPromise(WorkService);
  canvases = await workRuntime.runPromise(CanvasesService);
  repository = await workRuntime.runPromise(WorkRepository);
});

afterAll(async () => {
  await workRuntime.dispose();
  await rm(mockCanvasesHome, { recursive: true, force: true });
});

describe("WorkService — concurrent ops", () => {
  it("serializes concurrent claims; second actor loses with claim_contention", async () => {
    const name = "work-race";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "tasks",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          agentNode("actor-a"),
          agentNode("actor-b"),
          agentNode("actor-c"),
        ],
        edges: [
          { id: "edge-a", fromNode: "actor-a", toNode: "tasks" },
          { id: "edge-b", fromNode: "actor-b", toNode: "tasks" },
          { id: "edge-c", fromNode: "actor-c", toNode: "tasks" },
        ],
      }),
    );
    const authorialBefore = await workRuntime.runPromise(canvases.read(name));
    const actors = ["actor-a", "actor-b", "actor-c"].map((nodeId) => {
      const actor = authorialBefore.actorRefs.find(
        (candidate) => candidate.nodeId === nodeId,
      );
      if (actor === undefined) throw new Error(`missing actor ref for ${nodeId}`);
      return actor;
    });

    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "race me"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.disposition).toBe("applied");
    const taskId = created.data.id;

    // First claim must win; concurrent claims by different actors.
    const results = await Promise.all(
      actors.map((actor) =>
        workRuntime.runPromise(
          work.workTaskClaim(name, "tasks", taskId, actor),
        )
      ),
    );

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(2);
    expect(
      losses.every((result) => !result.ok && result.code === "claim_contention"),
    ).toBe(true);

    const snapshot = await workRuntime.runPromise(
      repository.readSnapshot(name, "tasks"),
    );
    const task = snapshot.tasks.items.find((item) => item.id === taskId);
    expect(task?.state).toBe("working");
    expect(actors.map((actor) => actor.seatId)).toContain(task?.claimedBy);

    // Explicit second claim by different actor after settle
    const other = await workRuntime.runPromise(
      work.workTaskClaim(
        name,
        "tasks",
        taskId,
        actors.find((actor) => actor.seatId !== task?.claimedBy)!,
      ),
    );
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("claim_contention");

    const authorialAfter = await workRuntime.runPromise(canvases.read(name));
    expect(authorialAfter.revision).toBe(authorialBefore.revision);
    const authority = await workRuntime.runPromise(canvases.authoritySnapshot());
    expect(
      authority.documents.get(name)?.nodes[0]?.ether?.tasks,
    ).toBeUndefined();
  });

  it("rejects bad canvas / node / illegal transition", async () => {
    const name = "work-errors";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "tasks",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            ether: { entity: { kind: "task" } },
          },
        ],
        edges: [],
      }),
    );
    const missingNode = await workRuntime.runPromise(
      work.workTaskCreate(name, "nope", "x"),
    );
    expect(missingNode.ok).toBe(false);
    if (!missingNode.ok) expect(missingNode.code).toBe("node_not_found");

    const created = await workRuntime.runPromise(work.workTaskCreate(name, "tasks", "t"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await workRuntime.runPromise(
      work.workTaskTransition(name, "tasks", created.data.id, "completed"),
    );
    const illegal = await workRuntime.runPromise(
      work.workTaskTransition(name, "tasks", created.data.id, "working"),
    );
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.code).toBe("illegal_transition");
  });

  it("records a Command Center operator response with its transition in one task fact", async () => {
    const name = "work-operator-response";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [emptyTaskNode(), agentNode("operator-response-worker")],
        edges: [{ id: "worker-tasks", fromNode: "operator-response-worker", toNode: "tasks" }],
      }),
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "need a deployment decision"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;
    const actor = (await workRuntime.runPromise(canvases.read(name))).actorRefs.find(
      (candidate) => candidate.nodeId === "operator-response-worker",
    );
    if (actor === undefined) throw new Error("missing operator response worker");
    await workRuntime.runPromise(work.workTaskClaim(name, "tasks", taskId, actor));
    const basis = await activeIntentBasis(
      workRuntime,
      "authorial-intent",
    );
    await workRuntime.runPromise(
      repository.transitionTask({
        sink: { canvasName: name, nodeId: "tasks" },
        taskId,
        state: "input-required",
        basis,
      }),
    );

    const result = await workRuntime.runPromise(
      work.workTaskRespond(
        name,
        "tasks",
        taskId,
        "Deploy to us-east-1.",
        "working",
      ),
    );
    expect(result).toMatchObject({ ok: true, disposition: "applied" });
    const snapshot = await workRuntime.runPromise(repository.readSnapshot(name, "tasks"));
    const task = snapshot.tasks.items.find((candidate) => candidate.id === taskId);
    expect(task).toMatchObject({ state: "working" });
    expect(task?.history.at(-1)).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "Deploy to us-east-1." }],
    });
    const historyLength = task?.history.length;

    const invalid = await workRuntime.runPromise(
      work.workTaskRespond(name, "tasks", taskId, "not accepted", "working"),
    );
    expect(invalid).toMatchObject({ ok: false, code: "illegal_transition" });
    const afterInvalid = await workRuntime.runPromise(repository.readSnapshot(name, "tasks"));
    expect(afterInvalid.tasks.items.find((candidate) => candidate.id === taskId)?.history)
      .toHaveLength(historyLength ?? 0);
  });

  it("persists requests, inbox messages, and artifacts without authorial generations", async () => {
    const name = "work-lanes";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyRequestsNode("requests"),
          agentNode("sender"),
          agentNode("recipient"),
          {
            id: "artifacts",
            type: "text",
            text: "artifacts",
            x: 420,
            y: 0,
            width: 200,
            height: 100,
            ether: {
              entity: { kind: "artifacts" },
            },
          },
        ],
        edges: [
          { id: "edge-request", fromNode: "sender", toNode: "requests" },
          {
            id: "edge-message",
            fromNode: "sender",
            toNode: "recipient",
            ether: { ports: ["msg.send"] },
          },
          { id: "edge-artifact", fromNode: "sender", toNode: "artifacts" },
        ],
      }),
    );
    const authorialBefore = await workRuntime.runPromise(canvases.read(name));
    const actor = authorialBefore.actorRefs.find(
      (candidate) => candidate.nodeId === "sender",
    );
    if (actor === undefined) throw new Error("missing actor ref for sender");

    const request = await workRuntime.runPromise(
      work.workRequestCreate(
        name,
        "requests",
        "approve release",
        undefined,
        actor,
      ),
    );
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const resolved = await workRuntime.runPromise(
      work.workRequestResolve(
        name,
        "requests",
        request.data.id,
        "approved",
        "completed",
      ),
    );
    expect(resolved.ok).toBe(true);

    const inboxMessage: Message = {
      messageId: "inbox-lane-1",
      role: "user",
      parts: [{ kind: "text", text: "start" }],
    };
    const appended = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "recipient",
        null,
        inboxMessage,
        actor,
      ),
    );
    if (!appended.ok) {
      throw new Error(`${appended.code}: ${appended.message}`);
    }
    expect(appended).toMatchObject({ ok: true });

    const artifact: Artifact = {
      artifactId: "artifact-lane-1",
      name: "release receipt",
      parts: [{ kind: "text", text: "sha256:abc" }],
    };
    const published = await workRuntime.runPromise(
      work.workArtifactPublish(name, "artifacts", artifact, actor),
    );
    expect(published.ok).toBe(true);

    const snapshots = await workRuntime.runPromise(
      repository.snapshotsForCanvas(name),
    );
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "requests")?.requests
        .items[0],
    ).toMatchObject({ state: "completed", response: "approved" });
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "recipient")?.messages
        .items,
    ).toEqual([expect.objectContaining({ messageId: "inbox-lane-1" })]);
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "artifacts")?.artifacts
        .items,
    ).toEqual([expect.objectContaining({ artifactId: "artifact-lane-1" })]);

    const authorialAfter = await workRuntime.runPromise(canvases.read(name));
    expect(authorialAfter.revision).toBe(authorialBefore.revision);
    const authority = await workRuntime.runPromise(canvases.authoritySnapshot());
    expect(
      authority.documents.get(name)?.nodes.find(
        (node) => node.id === "requests",
      )?.ether?.requests,
    ).toBeUndefined();
  });

  it("returns task and request notes from normalized thread history", async () => {
    const name = "work-thread-messages";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyTaskNode(),
          emptyRequestsNode("requests"),
          agentNode("sender"),
        ],
        edges: [
          {
            id: "task-note",
            fromNode: "sender",
            toNode: "tasks",
          },
          {
            id: "request-note",
            fromNode: "sender",
            toNode: "requests",
          },
        ],
      }),
    );
    const read = await workRuntime.runPromise(canvases.read(name));
    const sender = read.actorRefs.find(
      (candidate) => candidate.nodeId === "sender",
    );
    if (sender === undefined) throw new Error("missing sender actor");
    const task = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "Thread task"),
    );
    const request = await workRuntime.runPromise(
      work.workRequestCreate(
        name,
        "requests",
        "Thread request",
        undefined,
        sender,
      ),
    );
    if (!task.ok || !request.ok) {
      throw new Error("failed to seed thread work");
    }

    const taskNote = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "tasks",
        task.data.id,
        {
          messageId: "service-task-note",
          role: "agent",
          parts: [{ kind: "text", text: "Task progress" }],
          taskId: task.data.id,
        },
        sender,
      ),
    );
    const requestNote = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "requests",
        request.data.id,
        {
          messageId: "service-request-note",
          role: "agent",
          parts: [{ kind: "text", text: "Request context" }],
          taskId: request.data.id,
        },
        sender,
      ),
    );
    expect(taskNote).toMatchObject({ ok: true, disposition: "applied" });
    expect(requestNote).toMatchObject({
      ok: true,
      disposition: "applied",
    });
    if (!taskNote.ok || !requestNote.ok) return;
    expect(
      taskNote.doc.nodes
        .find((node) => node.id === "tasks")
        ?.ether?.tasks?.items[0]?.history.map(({ messageId }) => messageId),
    ).toContain("service-task-note");
    expect(
      requestNote.doc.nodes
        .find((node) => node.id === "requests")
        ?.ether?.requests?.items[0]?.history.map(({ messageId }) => messageId),
    ).toContain("service-request-note");
    expect(
      taskNote.doc.nodes.find((node) => node.id === "tasks")?.ether?.messages
        ?.items ?? [],
    ).toEqual([]);
    expect(
      requestNote.doc.nodes.find((node) => node.id === "requests")?.ether
        ?.messages?.items ?? [],
    ).toEqual([]);
  });

  it("rejects actor-originated work when the compiled actor is homed on another installation", async () => {
    const name = "work-cross-home-actor";
    const remoteHost = remoteHostId("remote-actor");
    const remoteInstallation = installationId("remote-actor-installation");
    const fleetTargets = await workRuntime.runPromise(
      StationFleetTargetRepository,
    );
    await workRuntime.runPromise(
      fleetTargets.bind(
        {
          hostId: remoteHost,
          stationInstallationId: remoteInstallation,
        },
        "2026-07-28T00:00:00.000Z",
      ),
    );
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyRequestsNode("requests"),
          agentNode("remote-sender", remoteHost),
          agentNode("recipient"),
          {
            id: "artifacts",
            type: "text",
            text: "artifacts",
            x: 420,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "artifacts" } },
          },
        ],
        edges: [
          {
            id: "request",
            fromNode: "remote-sender",
            toNode: "requests",
          },
          {
            id: "message",
            fromNode: "remote-sender",
            toNode: "recipient",
            ether: { ports: ["msg.send"] },
          },
          {
            id: "artifact",
            fromNode: "remote-sender",
            toNode: "artifacts",
          },
        ],
      }),
    );
    const read = await workRuntime.runPromise(canvases.read(name));
    const remoteActor = read.actorRefs.find(
      (candidate) => candidate.nodeId === "remote-sender",
    );
    if (remoteActor === undefined) throw new Error("missing Remote actor ref");

    const results = await Promise.all([
      workRuntime.runPromise(
        work.workMessageAppend(
          name,
          "recipient",
          null,
          {
            messageId: "cross-home-message",
            role: "agent",
            parts: [{ kind: "text", text: "forged locally" }],
          },
          remoteActor,
        ),
      ),
      workRuntime.runPromise(
        work.workRequestCreate(
          name,
          "requests",
          "forged request",
          undefined,
          remoteActor,
        ),
      ),
      workRuntime.runPromise(
        work.workArtifactPublish(
          name,
          "artifacts",
          {
            artifactId: "cross-home-artifact",
            parts: [{ kind: "text", text: "forged locally" }],
          },
          remoteActor,
        ),
      ),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, code: "invalid" });
      if (!result.ok) {
        expect(result.message).toContain(
          "must originate on the installation that owns actor",
        );
      }
    }
    const snapshots = await workRuntime.runPromise(
      repository.snapshotsForCanvas(name),
    );
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "recipient")?.messages
        .items ?? [],
    ).toEqual([]);
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "requests")?.requests
        .items ?? [],
    ).toEqual([]);
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "artifacts")?.artifacts
        .items ?? [],
    ).toEqual([]);
  });

  it("lets a Remote-local actor queue mail and create requests and artifacts offline", async () => {
    const isolatedRoot = join(
      tmpdir(),
      `vellum-work-remote-mail-${randomUUID()}`,
    );
    const runtime = makeWorkRuntime(
      join(isolatedRoot, "state", "vellum.db"),
    );
    const commandCenter = installationId("command-center-mail");
    const hostId = stationHostId("studio");

    try {
      const station = await runtime.runPromise(StationRepository);
      const local = await runtime.runPromise(station.installationId);
      await runtime.runPromise(
        station.pair(
          PairRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "pair",
            commandCenterInstallationId: commandCenter,
            stationInstallationId: local,
            stationLabel: "Studio",
            appVersion: "test",
          }),
        ),
      );
      await runtime.runPromise(
        station.configureRemote(
          ConfigureRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId: local,
            configuration: {
              role: "remote",
              hostId,
              agentHostId: hostId,
              commandCenterInstallationId: commandCenter,
              supervisedPreferred: true,
            },
            host: {
              id: hostId,
              label: "Studio",
              kind: "remote",
              capabilities: ["terminal"],
            },
          }),
        ),
      );

      const canvasName = "remote-mail";
      const body = compileStationPortfolioBody(
        new Map([
          [
            canvasName,
            {
              nodes: [
                agentNode("sender", hostId),
                agentNode("recipient", hostId),
                emptyTaskNode("tasks"),
                emptyRequestsNode("requests"),
                {
                  id: "artifacts",
                  type: "text",
                  text: "artifacts",
                  x: 420,
                  y: 0,
                  width: 200,
                  height: 100,
                  ether: { entity: { kind: "artifacts" } },
                },
              ],
              edges: [
                {
                  id: "mail",
                  fromNode: "sender",
                  toNode: "recipient",
                  ether: { ports: ["msg.send"] },
                },
                {
                  id: "request",
                  fromNode: "sender",
                  toNode: "requests",
                },
                {
                  id: "artifact",
                  fromNode: "sender",
                  toNode: "artifacts",
                },
              ],
            } satisfies CanvasDoc,
          ],
        ]),
        new Map([[hostId, local]]),
      );
      await runtime.runPromise(
        station.installProjection(
          ProjectRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: local,
            projection: {
              scope: "full",
              generation: logicalSequence("1"),
              sourceCanvasGeneration: logicalSequence("1"),
              sourceIntentSha256:
                stationProjectionContentSha256("remote work source"),
              body,
              contentSha256: stationProjectionContentSha256(body),
              createdAt: "2026-07-27T12:00:00.000Z",
            },
          }),
        ),
      );

      const canvases = await runtime.runPromise(CanvasesService);
      const read = await runtime.runPromise(canvases.read(canvasName));
      const sender = read.actorRefs.find(
        (candidate) => candidate.nodeId === "sender",
      );
      if (sender === undefined) throw new Error("missing Remote sender actor");
      const remoteWork = await runtime.runPromise(WorkService);
      const remoteRepository = await runtime.runPromise(WorkRepository);
      const basis = await activeIntentBasis(
        runtime,
        "projected-intent",
      );
      await runtime.runPromise(
        remoteRepository.createTask({
          sink: { canvasName, nodeId: "tasks" },
          task: {
            id: "remote-operator-response",
            state: "submitted",
            history: [
              {
                messageId: "remote-operator-response-brief",
                role: "agent",
                parts: [{ kind: "text", text: "need approval" }],
                taskId: "remote-operator-response",
                contextId: canvasName,
              },
            ],
          },
          basis,
        }),
      );
      await runtime.runPromise(
        remoteRepository.claimLocalTask({
          sink: { canvasName, nodeId: "tasks" },
          taskId: "remote-operator-response",
          actor: sender,
          basis,
        }),
      );
      await runtime.runPromise(
        remoteRepository.transitionTask({
          sink: { canvasName, nodeId: "tasks" },
          taskId: "remote-operator-response",
          state: "input-required",
          basis,
        }),
      );
      const deniedResponse = await runtime.runPromise(
        remoteWork.workTaskRespond(
          canvasName,
          "tasks",
          "remote-operator-response",
          "approved",
          "working",
        ),
      );
      expect(deniedResponse).toMatchObject({ ok: false, code: "invalid" });
      expect(
        (await runtime.runPromise(remoteRepository.readSnapshot(canvasName, "tasks")))
          .tasks.items[0]?.history,
      ).toHaveLength(1);
      const appended = await runtime.runPromise(
        remoteWork.workMessageAppend(
          canvasName,
          "recipient",
          null,
          {
            messageId: "remote-mail-1",
            role: "user",
            parts: [{ kind: "text", text: "from the station" }],
          },
          sender,
        ),
      );
      expect(appended).toMatchObject({
        ok: true,
        disposition: "queued",
      });
      const request = await runtime.runPromise(
        remoteWork.workRequestCreate(
          canvasName,
          "requests",
          "need operator input",
          undefined,
          sender,
        ),
      );
      expect(request).toMatchObject({
        ok: true,
        disposition: "applied",
      });
      const artifact = await runtime.runPromise(
        remoteWork.workArtifactPublish(
          canvasName,
          "artifacts",
          {
            artifactId: "remote-artifact-1",
            parts: [{ kind: "text", text: "created while offline" }],
          },
          sender,
        ),
      );
      expect(artifact).toMatchObject({
        ok: true,
        disposition: "applied",
      });

      const pending = await runtime.runPromise(
        remoteRepository.pendingCommands,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        resolution: undefined,
        command: {
          operation: "message.append",
          id: {
            route: {
              eventHome: local,
              entityHome: commandCenter,
            },
          },
          item: {
            kind: "message",
            itemId: "remote-mail-1",
            sink: { canvasName, nodeId: "recipient" },
          },
          body: {
            operation: "message.append",
            sentBy: sender,
          },
        },
      });
      const snapshots = await runtime.runPromise(
        remoteRepository.snapshotsForCanvas(canvasName),
      );
      expect(
        snapshots.find((snapshot) => snapshot.nodeId === "requests")?.requests
          .items,
      ).toEqual([
        expect.objectContaining({
          state: "input-required",
          claimedBy: sender.seatId,
        }),
      ]);
      expect(
        snapshots.find((snapshot) => snapshot.nodeId === "artifacts")?.artifacts
          .items,
      ).toEqual([
        expect.objectContaining({ artifactId: "remote-artifact-1" }),
      ]);
    } finally {
      await runtime.dispose();
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});
