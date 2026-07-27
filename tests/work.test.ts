import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  workMessageAppend,
  workRequestCreate,
  workRequestResolve,
  workTaskClaim,
  workTaskCreate,
  workTaskDescribe,
  workTaskTransition,
  WorkError,
} from "../src/shared/work";
import type { Artifact, CanvasDoc, Message } from "../src/shared/canvas";
import { canTransitionTaskState } from "../src/shared/task";

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

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

const agentNode = (id = "agent"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "mira",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "agent", name: "local:mira" } },
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

    const claimed = workTaskClaim(doc, "alpha", "tasks", created.task.id, "worker-1", ids);
    doc = claimed.doc;
    expect(claimed.task.state).toBe("working");
    expect(claimed.task.metadata?.claimedBy).toBe("worker-1");

    expect(() =>
      workTaskClaim(doc, "alpha", "tasks", created.task.id, "other-agent", ids),
    ).toThrow(WorkError);
    try {
      workTaskClaim(doc, "alpha", "tasks", created.task.id, "other-agent", ids);
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

  it("claim refuses attention states — an unclaimed human wait is never consumed", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "needs answer", undefined, ids);
    doc = created.doc;
    const waiting = workTaskTransition(
      doc,
      "c",
      "tasks",
      created.task.id,
      "input-required",
      undefined,
      ids,
    );
    doc = waiting.doc;
    try {
      workTaskClaim(doc, "c", "tasks", created.task.id, "worker-1", ids);
      expect.unreachable("claiming an unclaimed attention task must throw");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkError);
      expect((e as WorkError).code).toBe("illegal_transition");
    }
  });

  it("describe re-authors the brief in place, keeps later notes, updates mirror text", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship docs", undefined, ids);
    doc = created.doc;
    const noted = workTaskTransition(doc, "alpha", "tasks", created.task.id, "working", "on it", ids);
    doc = noted.doc;

    const described = workTaskDescribe(doc, "alpha", "tasks", created.task.id, "ship the docs site", ids);
    doc = described.doc;
    expect(described.task.history[0]?.parts[0]).toEqual({ kind: "text", text: "ship the docs site" });
    expect(described.task.history[0]?.role).toBe("user");
    expect(described.task.history.at(-1)?.parts[0]).toEqual({ kind: "text", text: "on it" });
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

  it("request raised by an actor is claimed by that actor at birth, with its reason", () => {
    const doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    const raised = workRequestCreate(
      doc,
      "c",
      "req",
      "need a key",
      undefined,
      ids,
      "actor-7",
      "signing is gated on the operator's key",
    );
    expect(raised.task.state).toBe("input-required");
    expect(raised.task.metadata?.claimedBy).toBe("actor-7");
    expect(raised.task.reason).toBe("signing is gated on the operator's key");

    expect(() =>
      workRequestCreate(doc, "c", "req", "need a key", undefined, ids, "operator"),
    ).toThrow(WorkError);
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
    const created = workRequestCreate(doc, "c", "req", "need approval", { class: "review" }, ids);
    doc = created.doc;
    expect(created.task.state).toBe("input-required");
    expect(created.task.metadata?.class).toBe("review");
    expect(created.task.metadata?.claimedBy).toBeUndefined();
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

  it("state machine: terminal has no exits", () => {
    expect(canTransitionTaskState("completed", "working")).toBe(false);
    expect(canTransitionTaskState("submitted", "working")).toBe(true);
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
import { StationRepositoryLive } from "../src/main/vellum/station/repository";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";

const stateLive = makeStateEngineLive(join(mockCanvasesHome, "state", "vellum.db"));
const repositoriesLive = Layer.provideMerge(
  Layer.mergeAll(
    WorkRepositoryLive,
    StationRepositoryLive,
    SettingsLive,
  ),
  stateLive,
);
const canvasesLive = Layer.provideMerge(
  CanvasesLive,
  repositoriesLive,
);
const workRuntime = ManagedRuntime.make(
  Layer.provideMerge(WorkLive, canvasesLive),
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
        ],
        edges: [],
      }),
    );
    const authorialBefore = await workRuntime.runPromise(canvases.read(name));

    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "race me"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.disposition).toBe("applied");
    const taskId = created.data.id;

    // First claim must win; concurrent claims by different actors.
    const results = await Promise.all([
      workRuntime.runPromise(work.workTaskClaim(name, "tasks", taskId, "actor-a")),
      workRuntime.runPromise(work.workTaskClaim(name, "tasks", taskId, "actor-b")),
      workRuntime.runPromise(work.workTaskClaim(name, "tasks", taskId, "actor-c")),
    ]);

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
    expect(typeof task?.metadata?.claimedBy).toBe("string");

    // Explicit second claim by different actor after settle
    const other = await workRuntime.runPromise(
      work.workTaskClaim(name, "tasks", taskId, "intruder"),
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

  it("persists requests, inbox messages, and artifacts without authorial generations", async () => {
    const name = "work-lanes";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyRequestsNode("requests"),
          agentNode("agent"),
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
        edges: [],
      }),
    );
    const authorialBefore = await workRuntime.runPromise(canvases.read(name));

    const request = await workRuntime.runPromise(
      work.workRequestCreate(name, "requests", "approve release"),
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
      work.workMessageAppend(name, "agent", null, inboxMessage),
    );
    expect(appended.ok).toBe(true);

    const artifact: Artifact = {
      artifactId: "artifact-lane-1",
      name: "release receipt",
      parts: [{ kind: "text", text: "sha256:abc" }],
    };
    const published = await workRuntime.runPromise(
      work.workArtifactPublish(name, "artifacts", artifact),
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
      snapshots.find((snapshot) => snapshot.nodeId === "agent")?.messages
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
});
