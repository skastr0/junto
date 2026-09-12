import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasReadResult } from "../src/shared/ipc";
import type { CanvasNode } from "../src/shared/canvas";
import type { Task, TaskState } from "../src/shared/work-model";
import {
  buildLiveContext,
  coalesceLiveActivity,
  LIVE_CONTEXT_LIMITS,
  meaningfulLiveChanges,
  quietLiveContext,
} from "../src/main/vellum-command/overseer/live/context";

const actor = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"a".repeat(64)}`);
const task = (id = "investigation", state: TaskState = "working"): Task => ({
  id, state,
  ...(state === "submitted" ? {} : { claimedBy: actor }),
  history: [{ messageId: "brief", role: "user", parts: [{ kind: "text", text: "Investigate authentication failures\nFull history should stay private" }] }],
});
const node = (id: string): CanvasNode => ({ id, type: "text", text: id, x: 10, y: 20, width: 200, height: 100 });
const fixture = (state: TaskState = "working", workRevision = "1"): CanvasReadResult => ({
  name: "factory", revision: "authorial-revision", workRevision, actorRefs: [],
  doc: {
    nodes: [
      { ...node("worker"), ether: {
        entity: { kind: "agent", name: "local:API" },
        terminal: {
          bindingId: "binding", harness: "claude", launch: {
            kind: "command", argv: ["secret-shell-argument"], cwd: "/private/working/path", env: { API_KEY: "private-env-value" },
          },
        },
      } },
      { ...node("queue"), ether: { entity: { kind: "task", name: "Authentication" }, tasks: { items: [task("investigation", state)] } } },
      { ...node("page"), type: "link", url: "https://example.test?access_token=private-url-value", ether: { entity: { kind: "page", name: "Docs" } } },
    ],
    edges: [{ id: "connection", fromNode: "worker", toNode: "queue", ether: { verb: "contributes" } }],
  },
});
const attention = { canvasName: "factory", selectedNodeIds: ["worker"] };

describe("Live semantic context", () => {
  it("captures authorial/work revisions and legal edges separately from renderer attention", () => {
    const input = { ...attention, selectedNodeIds: ["worker"], viewport: { x: 0, y: 1, width: 800, height: 600 }, draft: { nodeId: "queue", text: "Uncommitted edit" } };
    const read = fixture("input-required");
    const context = buildLiveContext(read, input);
    expect(context.authoritative).toMatchObject({
      canvasName: "factory", revision: "authorial-revision", workRevision: "1", counts: { blocked: 1 },
      edges: [{ id: "connection", fromNode: "worker", toNode: "queue", verb: "contributes" }],
    });
    expect(context.authoritative.nodes[0]?.id).toBe("worker");
    expect(context.authoritative.nodes.find((item) => item.id === "queue")?.tasks[0]).toMatchObject({ state: "input-required", claimedBy: actor });
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
    const read = fixture();
    const context = buildLiveContext({ ...read, doc: { ...read.doc, nodes: [{ ...node("secret-note"), text: `API key: ${secret}` }] } }, {
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
    const read = fixture();
    const nodes = Array.from({ length: 200 }, (_, index) => ({
      ...node(`node-${index}`),
      text: "測".repeat(500),
      ether: { tasks: { items: Array.from({ length: 20 }, (_, taskIndex) => task(`${index}-${taskIndex}`)) } },
    }));
    const context = buildLiveContext({ ...read, doc: { nodes, edges: [] } }, { ...attention, selectedNodeIds: ["node-199"] });
    expect(context.authoritative.nodes[0]?.id).toBe("node-199");
    expect(context.authoritative.omittedNodes).toBeGreaterThan(0);
    expect(context.authoritative.nodes.length).toBeLessThanOrEqual(LIVE_CONTEXT_LIMITS.nodes);
    expect(Buffer.byteLength(JSON.stringify(context), "utf8")).toBeLessThanOrEqual(LIVE_CONTEXT_LIMITS.bytes);
    expect(context.authoritative.nodes.every((item) => item.tasks.length <= LIVE_CONTEXT_LIMITS.tasksPerNode)).toBe(true);
  });

  it("keeps quiet context under the provider token ceiling including non-ASCII labels", () => {
    const read = fixture();
    const nodes = Array.from({ length: 10 }, (_, index) => ({ ...node(`node-${index}`), text: "界👩🏽‍💻".repeat(100) }));
    const context = buildLiveContext({ ...read, doc: { nodes, edges: [] } }, {
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
    const completed = buildLiveContext(fixture("completed", "3"), attention);
    expect(meaningfulLiveChanges(before, blocked)).toEqual([{
      kind: "task-blocked", canvasName: "factory", nodeId: "queue", itemId: "investigation", workRevision: "2",
    }]);
    expect(meaningfulLiveChanges(blocked, completed)[0]?.kind).toBe("task-completed");
    expect(meaningfulLiveChanges(before, before)).toEqual([]);
    const empty = buildLiveContext({ ...fixture(), doc: { nodes: [], edges: [] } }, attention);
    expect(meaningfulLiveChanges(empty, completed)).toEqual([]);
  });

  it("coalesces a task's old blocker into its latest observed result", () => {
    const before = buildLiveContext(fixture(), attention);
    const blocked = buildLiveContext(fixture("input-required", "2"), attention);
    const completed = buildLiveContext(fixture("completed", "3"), attention);
    const events = [...meaningfulLiveChanges(before, blocked), ...meaningfulLiveChanges(blocked, completed)];
    expect(coalesceLiveActivity(events)).toEqual([{
      kind: "task-completed", canvasName: "factory", nodeId: "queue", itemId: "investigation", workRevision: "3",
    }]);
  });
});
