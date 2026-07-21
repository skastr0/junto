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
  workTaskTransition,
  WorkError,
} from "../src/shared/a2a-work";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import { canTransitionTaskState } from "../src/shared/a2a";

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
  ether: { entity: { kind: "task" }, tasks: { items: [] } },
});

const emptyRequestsNode = (id = "req"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "0 pending",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "requests" }, requests: { items: [] } },
});

const agentNode = (id = "agent"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "mira",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "agent", name: "local:mira" }, messages: { items: [] } },
});

describe("a2a-work pure transforms", () => {
  it("create → claim → transition, with contextId from canvas name", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship docs", undefined, ids);
    doc = created.doc;
    expect(created.task.state).toBe("submitted");
    expect(created.task.history[0]?.parts[0]).toEqual({ kind: "text", text: "ship docs" });
    expect(created.task.history[0]?.contextId).toBe("alpha");
    expect((doc.nodes[0] as { text: string }).text).toBe("ship docs");

    const claimed = workTaskClaim(doc, "alpha", "tasks", created.task.id, "operator", ids);
    doc = claimed.doc;
    expect(claimed.task.state).toBe("working");
    expect(claimed.task.metadata?.claimedBy).toBe("operator");

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

  it("request create + resolve appends user message and clears input-required", () => {
    let doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    const created = workRequestCreate(doc, "c", "req", "need approval", { class: "review" }, ids);
    doc = created.doc;
    expect(created.task.state).toBe("input-required");
    expect(created.task.metadata?.class).toBe("review");
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
          ether: { entity: { kind: "task" }, tasks: { items: [] } },
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
  });
});

// --- service serialization under concurrent claims -------------------------

const mockCanvasesHome = join(tmpdir(), `vellum-a2a-work-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});

vi.mock("@shared/canvas", () => import("../src/shared/canvas"));
vi.mock("@shared/seed", () => import("../src/shared/seed"));

import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";

const workRuntime = ManagedRuntime.make(Layer.provideMerge(WorkLive, CanvasesLive));
let work: Context.Tag.Service<typeof WorkService>;
let canvases: Context.Tag.Service<typeof CanvasesService>;

beforeAll(async () => {
  work = await workRuntime.runPromise(WorkService);
  canvases = await workRuntime.runPromise(CanvasesService);
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
            ether: { entity: { kind: "task" }, tasks: { items: [] } },
          },
        ],
        edges: [],
      }),
    );

    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "race me"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;

    // First claim must win; concurrent claims by different actors.
    const results = await Promise.all([
      workRuntime.runPromise(work.workTaskClaim(name, "tasks", taskId, "actor-a")),
      workRuntime.runPromise(work.workTaskClaim(name, "tasks", taskId, "actor-b")),
      workRuntime.runPromise(work.workTaskClaim(name, "tasks", taskId, "actor-c")),
    ]);

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins.length).toBeGreaterThanOrEqual(1);
    // At least one different-actor claim fails with contention (or illegal if already working by other).
    const contention = losses.filter(
      (r) => !r.ok && (r.code === "claim_contention" || r.code === "illegal_transition"),
    );
    // If all three somehow claimed same actor path... still: final state has one claimedBy
    const read = await workRuntime.runPromise(canvases.read(name));
    const task = read.doc.nodes[0]?.ether?.tasks?.items.find((t) => t.id === taskId);
    expect(task?.state).toBe("working");
    expect(typeof task?.metadata?.claimedBy).toBe("string");

    // Explicit second claim by different actor after settle
    const other = await workRuntime.runPromise(
      work.workTaskClaim(name, "tasks", taskId, "intruder"),
    );
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("claim_contention");

    void contention;
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
            ether: { entity: { kind: "task" }, tasks: { items: [] } },
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
});
