import { describe, expect, it } from "vitest";
import type { Node, Wire } from "../src/shared/model";
import { seatNodeId, taskNodeId, type TaskId, type TaskState, type TaskView } from "../src/shared/task-model";
import { asNodeId } from "../src/shared/model";
import {
  buildLiveContext,
  coalesceLiveActivity,
  LIVE_CONTEXT_LIMITS,
  meaningfulLiveChanges,
  quietLiveContext,
  type LiveCanvasRead,
} from "../src/main/junto/overseer/live/context";
import { canvasOf, note, page, seat, taskBoard, wire } from "./support/model-nodes";

const assignee = seatNodeId(asNodeId("worker"));
const task = (id = "investigation", state: TaskState = "working"): TaskView => ({
  taskId: id as TaskId,
  title: "Investigate authentication failures",
  body: "Full history should stay private",
  current: {
    state, node: taskNodeId(asNodeId("queue")), epoch: 0, stampPolicy: { required: 0 }, reviewers: [], stamps: [],
    ...(state === "backlog" ? {} : { assignee }),
  },
  layers: [], dependsOn: [], createdAt: 1, updatedAt: 1, stateSince: 1,
});
const at = { x: 10, y: 20, width: 200, height: 100 };

/** A canvas and the work beside it, as the context reads them. */
const reading = (
  nodes: ReadonlyArray<Node>,
  wires: ReadonlyArray<Wire> = [],
  tasks: ReadonlyArray<readonly [string, ReadonlyArray<TaskView>]> = [],
  workRevision = "1",
): LiveCanvasRead => ({
  name: "factory",
  canvas: canvasOf(nodes, wires),
  tasks: new Map(tasks),
  artifacts: new Map(),
  revision: "authorial-revision",
  workRevision,
});

const fixture = (state: TaskState = "working", workRevision = "1"): LiveCanvasRead =>
  reading(
    [
      seat("worker", {
        ...at,
        agentKey: "local:API",
        label: "worker",
        launch: {
          kind: "command", argv: ["secret-shell-argument"], cwd: "/private/working/path", env: { API_KEY: "private-env-value" },
        },
      }),
      taskBoard("queue", { ...at, name: "Authentication" }),
      page("page", { ...at, url: "https://example.test?access_token=private-url-value" }),
    ],
    [wire("connection", "worker", "queue", "messages")],
    [["queue", [task("investigation", state)]]],
    workRevision,
  );
const attention = { canvasName: "factory", selectedNodeIds: ["worker"] };

describe("Live semantic context", () => {
  it("captures authorial/work revisions and legal edges separately from renderer attention", () => {
    const input = { ...attention, selectedNodeIds: ["worker"], viewport: { x: 0, y: 1, width: 800, height: 600 }, draft: { nodeId: "queue", text: "Uncommitted edit" } };
    const read = fixture("input-required");
    const context = buildLiveContext(read, input);
    expect(context.authoritative).toMatchObject({
      canvasName: "factory", revision: "authorial-revision", workRevision: "1", counts: { blocked: 1 },
      wires: [{ id: "connection", from: "worker", to: "queue", verb: "messages" }],
    });
    expect(context.authoritative.nodes[0]?.id).toBe("worker");
    expect(context.authoritative.nodes.find((item) => item.id === "queue")?.tasks[0]).toMatchObject({ state: "input-required", assignee });
    expect(context.attention).toMatchObject({ source: "renderer", draft: { text: "Uncommitted edit", committed: false } });
    input.selectedNodeIds[0] = "queue";
    input.viewport.x = 900;
    input.draft.text = "Changed later";
    expect(context.attention.selectedNodeIds).toEqual(["worker"]);
    expect(context.attention.viewport?.x).toBe(0);
    expect(context.attention.draft?.text).toBe("Uncommitted edit");
    expect(Object.isFrozen(context.authoritative.nodes)).toBe(true);
  });

  it("never includes launch environment, argv, paths, page tokens or complete task history", () => {
    const serialized = JSON.stringify(buildLiveContext(fixture(), attention));
    for (const withheld of ["private-env-value", "secret-shell-argument", "/private/working/path", "private-url-value", "Full history should stay private"]) {
      expect(serialized).not.toContain(withheld);
    }
    expect(serialized).toContain("Investigate authentication failures");
  });

  it("withholds recognizable credentials accidentally pasted into labels and drafts", () => {
    const secret = `sk-proj-${"Q".repeat(32)}`;
    const context = buildLiveContext(reading([note("secret-note", `API key: ${secret}`, at)]), {
      ...attention, draft: { nodeId: "secret-note", text: 'password="private password"\nBearer private.token.value' },
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private password");
    expect(serialized).not.toContain("private.token.value");
    expect(serialized).toContain("credential withheld");
  });

  it("does not resolve selection from another canvas or treat nonexistent ids as targets", () => {
    const context = buildLiveContext(fixture(), { canvasName: "other", selectedNodeIds: ["worker", "missing"] });
    expect(context.attention.selectedNodeIds).toEqual([]);
    expect(context.attention.unresolvedSelectionCount).toBe(2);
    expect(context.authoritative.canvasName).toBe("factory");
  });

  it("bounds large canvas context while retaining selected targets first", () => {
    const nodes = Array.from({ length: 200 }, (_, index) =>
      taskBoard(`node-${index}`, { ...at, name: "測".repeat(500) as never }));
    const context = buildLiveContext(
      reading(nodes, [], nodes.map((board, index) =>
        [board.id, Array.from({ length: 20 }, (_, taskIndex) => task(`${index}-${taskIndex}`))] as const)),
      { ...attention, selectedNodeIds: ["node-199"] },
    );
    expect(context.authoritative.nodes[0]?.id).toBe("node-199");
    expect(context.authoritative.omittedNodes).toBeGreaterThan(0);
    expect(context.authoritative.nodes.length).toBeLessThanOrEqual(LIVE_CONTEXT_LIMITS.nodes);
    expect(Buffer.byteLength(JSON.stringify(context), "utf8")).toBeLessThanOrEqual(LIVE_CONTEXT_LIMITS.bytes);
    expect(context.authoritative.nodes.every((item) => item.tasks.length <= LIVE_CONTEXT_LIMITS.tasksPerNode)).toBe(true);
  });

  it("keeps quiet context under the provider token ceiling including non-ASCII labels", () => {
    const nodes = Array.from({ length: 10 }, (_, index) => note(`node-${index}`, "界👩🏽‍💻".repeat(100), at));
    const context = buildLiveContext(reading(nodes), {
      ...attention, selectedNodeIds: nodes.map((item) => item.id), draft: { nodeId: "node-0", text: "A draft" },
    });
    const quiet = quietLiveContext(context);
    expect(Buffer.byteLength(quiet, "utf8")).toBeLessThanOrEqual(500);
    expect(quiet).not.toContain("�");
    expect(quiet).not.toContain("A draft");
    expect(quiet).toContain("Selected:");
  });

  it("derives completion and blockers from verified Work transitions, ignoring mere visibility", () => {
    const before = buildLiveContext(fixture(), attention);
    const blocked = buildLiveContext(fixture("input-required", "2"), attention);
    const completed = buildLiveContext(fixture("done", "3"), attention);
    expect(meaningfulLiveChanges(before, blocked)).toEqual([{
      kind: "task-blocked", canvasName: "factory", nodeId: "queue", itemId: "investigation", workRevision: "2",
    }]);
    expect(meaningfulLiveChanges(blocked, completed)[0]?.kind).toBe("task-completed");
    expect(meaningfulLiveChanges(before, before)).toEqual([]);
    const empty = buildLiveContext(reading([]), attention);
    expect(meaningfulLiveChanges(empty, completed)).toEqual([]);
  });

  it("coalesces a task's old blocker into its latest observed result", () => {
    const before = buildLiveContext(fixture(), attention);
    const blocked = buildLiveContext(fixture("input-required", "2"), attention);
    const completed = buildLiveContext(fixture("done", "3"), attention);
    const events = [...meaningfulLiveChanges(before, blocked), ...meaningfulLiveChanges(blocked, completed)];
    expect(coalesceLiveActivity(events)).toEqual([{
      kind: "task-completed", canvasName: "factory", nodeId: "queue", itemId: "investigation", workRevision: "3",
    }]);
  });
});
