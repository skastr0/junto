import { nodeOfDocument } from "../src/shared/model/from-document";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc, type GroupNode } from "../src/shared/canvas";
import { addNode, flushPendingCanvasSave, deleteNode, editLink, editText, redo, renameGroup, renameTerminalNode, setNodeColor, setNodeColorForNodes, setPageBinding, setRegionDefaults, setRegionEnvironment, setRegionHold, undo } from "../src/renderer/lib/mutations";
import { docNow, loadDoc } from "./support/open-document";
import { modelStore } from "../src/renderer/lib/use-model";
import { addEdge, connectAllToTarget, deleteEdges, targetPlanOn } from "../src/renderer/lib/edge-mutations";
import * as fixtures from "./support/model-nodes";
import { findOpenPosition, resizeNode, syncPositions } from "../src/renderer/lib/geometry";
import { clearGraphFilters, state$ } from "../src/renderer/lib/state";
import { browser$, cacheBrowserSession } from "../src/renderer/lib/browser-state";
import { dock$, openAgentChatSurface } from "../src/renderer/lib/dock-state";
import { initialWorkbenchState } from "../src/renderer/lib/surface-registry";
import { formatNodeRef } from "../src/shared/node-ref";

/** Bun's vitest shim lacks `vi.waitFor` — poll until assertion holds. */
const waitFor = async (
  assertion: () => void,
  { timeoutMs = 2000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const browserStop = vi.fn(async (): Promise<{
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
}> => ({ ok: true }));

const chatClose = vi.fn(async (): Promise<{ ok: boolean; clean?: boolean }> => ({
  ok: true,
  clean: true,
}));
const chatBeginNodeDelete = vi.fn(
  async (
    resources: ReadonlyArray<{ readonly kind: "agent"; readonly agentKey: string }>,
  ): Promise<{
    readonly ok: true;
    readonly leaseId: string;
    readonly closeResults: ReadonlyArray<{
      readonly agentKey: string;
      readonly ok: boolean;
      readonly clean: boolean;
    }>;
  } | { readonly ok: false; readonly error: string }> => ({
    ok: true,
    leaseId: "test-lease",
    closeResults: resources.map((resource) => ({
      agentKey: resource.agentKey,
      ok: true,
      clean: true,
    })),
  }),
);
const chatFinishNodeDelete = vi.fn(
  async (): Promise<{ readonly ok: true }> => ({ ok: true }),
);

const runtimeWindow = {
  junto: {
    modelCommand: async () => ({ seq: 1 }),
    browserStop,
    browserSessionList: async () => ({ ok: true, data: [] }),
    chatClose,
    chatBeginNodeDelete,
    chatFinishNodeDelete,
    // The base document's two nodes are real seats, and deleting a seat takes
    // a lease on its terminal first. These cases are not about that lease.
    terminalBeginNodeDelete: async () => ({ ok: true as const, leaseId: "terminal-lease" }),
    terminalFinishNodeDelete: async () => ({ ok: true as const }),
  },
  setTimeout: globalThis.setTimeout,
  confirm: (_message: string) => true,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

const doc: CanvasDoc = {
  nodes: [
    {
      id: "source",
      type: "text",
      text: "agent",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "agent", name: "local:worker" },
        host: "local",
        terminal: { bindingId: "binding-worker", harness: "claude" },
      },
    },
    {
      id: "target",
      type: "text",
      text: "peer",
      x: 300,
      y: 0,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "agent", name: "local:peer" },
        host: "local",
        terminal: { bindingId: "binding-peer", harness: "claude" },
      },
    },
  ],
  edges: [],
};

describe("renderer graph mutations", () => {
  afterEach(() => {
    runtimeWindow.confirm = () => true;
    state$.error.set("");
    browserStop.mockReset();
    browserStop.mockResolvedValue({ ok: true });
    chatClose.mockReset();
    chatClose.mockResolvedValue({ ok: true, clean: true });
    chatBeginNodeDelete.mockReset();
    chatBeginNodeDelete.mockImplementation(async (resources) => ({
      ok: true as const,
      leaseId: "test-lease",
      closeResults: resources.map((resource) => ({
        agentKey: resource.agentKey,
        ok: true,
        clean: true,
      })),
    }));
    chatFinishNodeDelete.mockReset();
    chatFinishNodeDelete.mockResolvedValue({ ok: true });
    browser$.sessionByRef.set({});
    dock$.registry.set(initialWorkbenchState());
    dock$.chatById.set({});
    dock$.opErrorByRef.set({});
    state$.settings.station.hostId.set("local");
    state$.settings.station.role.set("");
    clearGraphFilters();
    loadDoc({ nodes: [], edges: [] });
  });

  it("keeps a kill-session page node visible when Stop Page fails", async () => {
    state$.canvasName.set("mutation-test");
    const ref = formatNodeRef({ canvasName: "mutation-test", nodeId: "page" });
    loadDoc({
      nodes: [{
        id: "page",
        type: "link",
        url: "https://example.com",
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        ether: {
          entity: { kind: "page" },
          browser: { profile: "personal", onDelete: "kill-session" },
        },
      }],
      edges: [],
    });
    cacheBrowserSession({
      sessionId: "page-session",
      ref,
      nodeId: "page",
      url: "https://example.com",
      hostId: "local",
      profile: "personal",
      state: "ready",
      attached: false,
    });
    browserStop.mockResolvedValueOnce({
      ok: false,
      code: "failed",
      message: "physical teardown not acknowledged",
    });

    deleteNode("page");

    await waitFor(() => expect(browserStop).toHaveBeenCalledWith("page-session"));
    expect(docNow().nodes.map((node) => node.id)).toEqual(["page"]);
    expect(state$.error.peek()).toBe("Stop Page failed; the page node was not deleted.");
    expect(dock$.opErrorByRef[ref].peek()).toEqual({
      op: "stop",
      message: "physical teardown not acknowledged",
    });
  });

  it("deletes a kill-session page node only after Stop Page succeeds", async () => {
    state$.canvasName.set("mutation-test");
    const ref = formatNodeRef({ canvasName: "mutation-test", nodeId: "page" });
    loadDoc({
      nodes: [{
        id: "page",
        type: "link",
        url: "https://example.com",
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        ether: {
          entity: { kind: "page" },
          browser: { profile: "personal", onDelete: "kill-session" },
        },
      }],
      edges: [],
    });
    cacheBrowserSession({
      sessionId: "page-session",
      ref,
      nodeId: "page",
      url: "https://example.com",
      hostId: "local",
      profile: "personal",
      state: "ready",
      attached: false,
    });

    deleteNode("page");

    await waitFor(() => expect(docNow().nodes).toHaveLength(0));
    expect(browserStop).toHaveBeenCalledWith("page-session");
  });

  it("deletes a kill-session page when browserStop is feature-flagged off", async () => {
    // Prod build with BROWSER_ENABLED=false strips browser IPC from preload.
    // Historical page furniture must still be deletable.
    const api = runtimeWindow.junto as unknown as {
      browserStop?: typeof browserStop;
      browserSessionList?: () => Promise<{ ok: true; data: [] }>;
    };
    const savedStop = api.browserStop;
    const savedList = api.browserSessionList;
    delete api.browserStop;
    delete api.browserSessionList;

    state$.canvasName.set("mutation-test");
    const ref = formatNodeRef({ canvasName: "mutation-test", nodeId: "page" });
    loadDoc({
      nodes: [{
        id: "page",
        type: "link",
        url: "https://example.com",
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        ether: {
          entity: { kind: "page" },
          browser: { profile: "personal", onDelete: "kill-session" },
        },
      }],
      edges: [],
    });
    cacheBrowserSession({
      sessionId: "ghost-session",
      ref,
      nodeId: "page",
      url: "https://example.com",
      hostId: "local",
      profile: "personal",
      state: "ready",
      attached: false,
    });

    try {
      deleteNode("page");
      await waitFor(() => expect(docNow().nodes).toHaveLength(0));
      expect(state$.error.peek()).toBe("");
      expect(browser$.sessionByRef[ref].peek()).toBeUndefined();
    } finally {
      if (savedStop) api.browserStop = savedStop;
      if (savedList) api.browserSessionList = savedList;
    }
  });

  it("keeps a kill-session node after failure and deletes it only when Stop Page retry succeeds", async () => {
    state$.canvasName.set("mutation-test");
    const ref = formatNodeRef({ canvasName: "mutation-test", nodeId: "page" });
    loadDoc({
      nodes: [{
        id: "page",
        type: "link",
        url: "https://example.com",
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        ether: {
          entity: { kind: "page" },
          browser: { profile: "personal", onDelete: "kill-session" },
        },
      }],
      edges: [],
    });
    cacheBrowserSession({
      sessionId: "page-session",
      ref,
      nodeId: "page",
      url: "https://example.com",
      hostId: "local",
      profile: "personal",
      state: "ready",
      attached: false,
    });
    browserStop
      .mockResolvedValueOnce({ ok: false, code: "timeout", message: "still stopping" })
      .mockResolvedValueOnce({ ok: true });

    deleteNode("page");
    await waitFor(() => expect(browserStop).toHaveBeenCalledTimes(1));
    expect(docNow().nodes.map((node) => node.id)).toEqual(["page"]);

    deleteNode("page");
    await waitFor(() => expect(docNow().nodes).toHaveLength(0));
    expect(browserStop).toHaveBeenCalledTimes(2);
  });

  it("does not delete a replacement document node that reuses the id while Stop Page is pending", async () => {
    state$.canvasName.set("mutation-test");
    const ref = formatNodeRef({ canvasName: "mutation-test", nodeId: "page" });
    loadDoc({
      nodes: [{
        id: "page",
        type: "link",
        url: "https://old.example.com",
        x: 0,
        y: 0,
        width: 320,
        height: 180,
        ether: {
          entity: { kind: "page" },
          browser: { profile: "personal", onDelete: "kill-session" },
        },
      }],
      edges: [],
    });
    cacheBrowserSession({
      sessionId: "page-session",
      ref,
      nodeId: "page",
      url: "https://old.example.com",
      hostId: "local",
      profile: "personal",
      state: "ready",
      attached: false,
    });
    let finishStop!: (result: { readonly ok: boolean }) => void;
    browserStop.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishStop = resolve;
      }),
    );

    deleteNode("page");
    await waitFor(() => expect(browserStop).toHaveBeenCalledTimes(1));
    loadDoc({
      nodes: [{
        id: "page",
        type: "link",
        url: "https://replacement.example.com",
        x: 10,
        y: 10,
        width: 320,
        height: 180,
      }],
      edges: [],
    });
    finishStop({ ok: true });

    await waitFor(() => expect(state$.error.peek()).toBe(
      "Canvas changed before Stop Page completed; no nodes were deleted.",
    ));
    expect(docNow().nodes).toMatchObject([
      { id: "page", url: "https://replacement.example.com" },
    ]);
  });

  it("rechecks canvas epoch after agent close and refuses deletion on epoch drift", async () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [{
        id: "agent",
        type: "text",
        text: "agent",
        x: 0,
        y: 0,
        width: 220,
        height: 84,
        ether: {
          entity: { kind: "agent", name: "local:default" },
          host: "local",
          terminal: { bindingId: "binding-default", harness: "claude" },
        },
      }],
      edges: [],
    });
    let finishBegin!: (result: {
      readonly ok: true;
      readonly leaseId: string;
      readonly closeResults: ReadonlyArray<{
        readonly agentKey: string;
        readonly ok: boolean;
        readonly clean: boolean;
      }>;
    }) => void;
    chatBeginNodeDelete.mockImplementationOnce(
      () => new Promise((resolve) => {
        finishBegin = resolve;
      }),
    );

    deleteNode("agent");
    await waitFor(() =>
      expect(chatBeginNodeDelete).toHaveBeenCalledWith([
        { kind: "agent", agentKey: "local:default" },
      ]),
    );
    // Canvas switch / reload advances docEpoch while lease begin awaits.
    loadDoc({
      nodes: [{
        id: "agent",
        type: "text",
        text: "replacement",
        x: 10,
        y: 10,
        width: 220,
        height: 84,
        ether: {
          entity: { kind: "agent", name: "local:default" },
          host: "local",
          terminal: { bindingId: "binding-default", harness: "claude" },
        },
      }],
      edges: [],
    });
    finishBegin({
      ok: true,
      leaseId: "lease-epoch",
      closeResults: [{ agentKey: "local:default", ok: true, clean: true }],
    });

    await waitFor(() => expect(state$.error.peek()).toBe(
      "Canvas changed before deletion completed; no nodes were deleted.",
    ));
    expect(chatFinishNodeDelete).toHaveBeenCalledWith("lease-epoch", "aborted");
    expect(docNow().nodes).toMatchObject([
      { id: "agent", text: "replacement" },
    ]);
  });

  it("begins delete lease then finishes committed after document commit", async () => {
    state$.canvasName.set("mutation-test");
    const agentNode = {
        id: "agent",
        type: "text",
        text: "agent",
        x: 0,
        y: 0,
        width: 220,
        height: 84,
        ether: {
          entity: { kind: "agent", name: "local:default" },
          host: "local",
          terminal: { bindingId: "binding-agent", harness: "claude" },
        },
      } as const;
    loadDoc({
      nodes: [agentNode],
      edges: [],
    });
    // The chat opens on the seat the store holds.
    openAgentChatSurface("mutation-test", "agent");
    expect(dock$.registry.peek().surfaces).toMatchObject([
      { id: "chat:agent", kind: "chat", zone: "focus" },
    ]);

    deleteNode("agent");
    await waitFor(() => expect(docNow().nodes).toEqual([]));
    await waitFor(() => expect(dock$.registry.peek().surfaces).toEqual([]));
    expect(dock$.chatById.peek()).toEqual({});
    expect(chatBeginNodeDelete).toHaveBeenCalledWith([
      { kind: "agent", agentKey: "local:default" },
    ]);
    expect(chatFinishNodeDelete).toHaveBeenCalledWith("test-lease", "committed");
    const beginOrder = chatBeginNodeDelete.mock.invocationCallOrder[0]!;
    const finishOrder = chatFinishNodeDelete.mock.invocationCallOrder[0]!;
    expect(beginOrder).toBeLessThan(finishOrder);
  });

  it("rejects a duplicate source-to-target relation", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    addEdge({ source: "source", target: "target" });
    addEdge({ source: "source", target: "target" });

    expect(docNow().edges).toHaveLength(1);
    expect(state$.error.peek()).toBe("That relation already exists.");
  });

  it("clears the edge filter without touching the document", () => {
    loadDoc(doc);
    const before = docNow();

    state$.edgeFilter.set("blocks");
    clearGraphFilters();

    expect(state$.edgeFilter.peek()).toBe("");
    expect(docNow()).toEqual(before);
    expect(state$.selectedNodeId.peek()).toBe("");
    expect(state$.selectedEdgeId.peek()).toBe("");
  });

  it("surfaces self-connections instead of failing silently", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);

    addEdge({ source: "source", target: "source" });

    expect(docNow().edges).toHaveLength(0);
    expect(state$.error.peek()).toBe("A node cannot connect to itself.");
  });

  describe("targetPlanOn (the plan a batch connect follows, RTS-006)", () => {
    // Agents wire to agents; a note only sits there and takes no wire.
    const batch = (wires: Parameters<typeof fixtures.canvasOf>[1] = []) =>
      fixtures.canvasOf(
        [
          fixtures.seat("a"),
          fixtures.seat("b"),
          fixtures.seat("c"),
          fixtures.region("region", { x: 0, y: 100, width: 400, height: 200 }),
          fixtures.note("note", "geography note"),
        ],
        wires,
      );

    it("plans mail wires from each agent to the target agent", () => {
      const plan = targetPlanOn(batch(), ["a", "b"], "c");
      expect(plan.toAdd.map((c) => ({ from: c.fromNode, to: c.toNode }))).toEqual([
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ]);
      expect(plan.skipped).toEqual([]);
    });

    it("refuses geography notes as unwirable", () => {
      const plan = targetPlanOn(batch(), ["note"], "c");
      expect(plan.toAdd).toEqual([]);
      expect(plan.skipped).toEqual([{ source: "note", reason: "refused-pair" }]);
    });

    it("skips self, duplicates, groups, and missing sources", () => {
      const plan = targetPlanOn(
        batch([fixtures.wire("e1", "b", "c", "messages")]),
        ["a", "a", "c", "region", "missing", "b"],
        "c",
      );
      expect(plan.toAdd).toEqual([
        { fromNode: "a", toNode: "c", verb: "messages" },
      ]);
      expect(plan.skipped).toEqual([
        { source: "a", reason: "duplicate" },
        { source: "c", reason: "self" },
        { source: "region", reason: "group-source" },
        { source: "missing", reason: "missing-source" },
        { source: "b", reason: "duplicate" },
      ]);
    });

    it("rejects group targets and missing targets for every source", () => {
      expect(targetPlanOn(batch(), ["a", "b"], "region").skipped).toEqual([
        { source: "a", reason: "invalid-target" },
        { source: "b", reason: "invalid-target" },
      ]);
      expect(targetPlanOn(batch(), ["a"], "gone").toAdd).toEqual([]);
    });

    it("writes nothing and leaves what it was given as it was", () => {
      const sources = ["a", "b"] as const;
      const canvas = batch();
      const plan = targetPlanOn(canvas, sources, "c");
      expect(plan.toAdd).toHaveLength(2);
      expect(canvas.wires.size).toBe(0);
      expect(sources).toEqual(["a", "b"]);
    });
  });

  it("connectAllToTarget commits multi-source mail wires in one write", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        {
          id: "a",
          type: "text",
          text: "A",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent", name: "local:a" }, terminal: { bindingId: "bind-a", harness: "claude" } },
        },
        {
          id: "b",
          type: "text",
          text: "B",
          x: 100,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent", name: "local:b" }, terminal: { bindingId: "bind-b", harness: "claude" } },
        },
        {
          id: "c",
          type: "text",
          text: "C",
          x: 200,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent", name: "local:c" }, terminal: { bindingId: "bind-c", harness: "claude" } },
        },
      ],
      edges: [],
    });

    const plan = connectAllToTarget(["a", "b"], "c");
    expect(plan.toAdd).toHaveLength(2);
    const next = docNow().edges;
    expect(next).toHaveLength(2);
    expect(next.map((edge) => ({ from: edge.fromNode, to: edge.toNode }))).toEqual([
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ]);
    expect(state$.selectedNodeId.peek()).toBe("");
    expect(state$.selectedEdgeId.peek()).toBe(next[1]?.id);
    expect(Result.isSuccess(decodeCanvasDoc(docNow()))).toBe(true);
  });

  it("connectAllToTarget keepSelection leaves multi-select intact", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        {
          id: "a",
          type: "text",
          text: "A",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent", name: "local:a" }, terminal: { bindingId: "bind-a", harness: "claude" } },
        },
        {
          id: "t1",
          type: "text",
          text: "T1",
          x: 100,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent", name: "local:t1" }, terminal: { bindingId: "bind-t1", harness: "claude" } },
        },
        {
          id: "t2",
          type: "text",
          text: "T2",
          x: 200,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "agent", name: "local:t2" }, terminal: { bindingId: "bind-t2", harness: "claude" } },
        },
      ],
      edges: [],
    });
    state$.selectedNodeId.set("a");
    state$.selectedNodeIds.set(["a"]);

    connectAllToTarget(["a"], "t1", { keepSelection: true });
    expect(state$.selectedNodeId.peek()).toBe("a");
    expect(state$.selectedNodeIds.peek()).toEqual(["a"]);
    connectAllToTarget(["a"], "t2", { keepSelection: true });
    expect(docNow().edges).toHaveLength(2);
    expect(state$.selectedNodeIds.peek()).toEqual(["a"]);
  });

  it("removes deleted nodes from both selection channels", async () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set(["source", "target"]);

    deleteNode("target");

    await waitFor(() => expect(docNow().nodes.map((node) => node.id)).toEqual(["source"]));
    expect(state$.selectedNodeId.peek()).toBe("source");
    expect(state$.selectedNodeIds.peek()).toEqual(["source"]);
  });

  it("requires confirmation before deleting signals and connected relations", async () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ ...doc, edges: [{ id: "edge-1", fromNode: "source", toNode: "target", ether: { verb: "messages" } }] });
    runtimeWindow.confirm = () => false;

    // Deleting a seat runs its kill ceremony only once the operator confirms.
    deleteNode("target");
    expect(docNow().nodes).toHaveLength(2);
    expect(docNow().edges).toHaveLength(1);

    runtimeWindow.confirm = () => true;
    deleteNode("target");
    await waitFor(() => expect(docNow().nodes.map((node) => node.id)).toEqual(["source"]));
    expect(docNow().edges).toHaveLength(0);
  });

  it("requires confirmation before deleting relations", () => {
    state$.canvasName.set("mutation-test");
    // A wire the model holds: an edge with no verb is not one.
    loadDoc({ ...doc, edges: [{ id: "edge-1", fromNode: "source", toNode: "target", ether: { verb: "messages" } }] });
    const confirms: string[] = [];
    runtimeWindow.confirm = (message: string) => {
      confirms.push(message);
      return false;
    };

    deleteEdges(["edge-1"]);
    expect(docNow().edges).toHaveLength(1);
    expect(confirms).toEqual(["Delete this relation?"]);

    runtimeWindow.confirm = () => true;
    deleteEdges(["edge-1"]);
    expect(docNow().edges).toHaveLength(0);
  });

  it("keeps dragged positions integer-aligned in renderer state", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    syncPositions(new Map([["source", { x: 1.6, y: -2.4 }]]));

    expect(docNow().nodes[0]).toMatchObject({ x: 2, y: -2 });
  });

  it("preserves CanvasNode identity for unmoved nodes so flow cache can reuse them", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    const rows = () => modelStore.canvasOf("mutation-test").nodes;
    const sourceBefore = rows().get("source" as never);
    const targetBefore = rows().get("target" as never);
    // Source moves; target coords match current (rounded no-op).
    syncPositions(
      new Map([
        ["source", { x: 50, y: 60 }],
        ["target", { x: targetBefore!.x, y: targetBefore!.y }],
      ]),
    );
    expect(rows().get("source" as never)).not.toBe(sourceBefore);
    expect(rows().get("source" as never)).toMatchObject({ id: "source", x: 50, y: 60 });
    expect(rows().get("target" as never)).toBe(targetBefore);
  });

  it("skips commit entirely when no rounded position changed", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    const before = docNow();
    const epoch = state$.docEpoch.peek();
    syncPositions(
      new Map(before.nodes.map((n) => [n.id, { x: n.x, y: n.y }])),
    );
    expect(docNow()).toEqual(before);
    expect(state$.docEpoch.peek()).toBe(epoch);
  });

  it("bumps docEpoch on undo and redo so generation fences observe history", async () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    renameTerminalNode("source", "EDITED");
    const afterCommit = state$.docEpoch.peek();
    undo();
    await flushPendingCanvasSave();
    expect(state$.docEpoch.peek()).toBe(afterCommit + 1);
    expect(docNow().nodes[0]).toMatchObject({ text: "agent" });
    redo();
    await flushPendingCanvasSave();
    expect(state$.docEpoch.peek()).toBe(afterCommit + 2);
    expect(docNow().nodes[0]).toMatchObject({ text: "EDITED" });
  });

  it("refuses authorial commits on a Remote station", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    const before = docNow();
    const epoch = state$.docEpoch.peek();
    state$.settings.station.role.set("remote");
    const source = before.nodes[0];
    if (!source || source.type !== "text") {
      throw new Error("expected text source node");
    }
    editText("source", "REMOTE MUST NOT WRITE");
    syncPositions(new Map([["source", { x: 99, y: 99 }]]));
    expect(docNow()).toEqual(before);
    expect(state$.docEpoch.peek()).toBe(epoch);
  });

  it("persists region geometry changes without rebuilding the graph", () => {
    state$.canvasName.set("mutation-test");
    const regionDoc: CanvasDoc = { nodes: [{ id: "region", type: "group", label: "UI QA", x: 0, y: 0, width: 400, height: 200 }], edges: [] };
    loadDoc(regionDoc);
    resizeNode("region", { x: 12.6, y: -3.4, width: 525.8, height: 286.2 });

    expect(docNow().nodes[0]).toMatchObject({ x: 13, y: -3, width: 526, height: 286 });
  });

  it("selects a newly created item before opening its editor", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    const node = { id: "new-note", type: "text" as const, text: "new note", x: 0, y: 0, width: 240, height: 100 };

    addNode(nodeOfDocument("mutation-test", node, 9)!);

    expect(state$.selectedNodeId.peek()).toBe("new-note");
    expect(state$.selectedNodeIds.peek()).toEqual(["new-note"]);
    expect(state$.selectedEdgeId.peek()).toBe("");
    expect(docNow().nodes.at(-1)).toEqual(node);
  });

  it("addNode replaces a stale multi selection so the RTS command card targets the new node", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "b", x: 20, y: 20, width: 100, height: 40 },
      ],
      edges: [],
    });
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set(["a", "b"]);
    const node = { id: "c", type: "text" as const, text: "c", x: 40, y: 40, width: 100, height: 40 };

    addNode(nodeOfDocument("mutation-test", node, 9)!);

    expect(state$.selectedNodeId.peek()).toBe("c");
    expect(state$.selectedNodeIds.peek()).toEqual(["c"]);
  });

  it("opens folder-paths modal after creating a region (not label edit)", async () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    // Drain any pending addNode timeouts from earlier cases.
    await new Promise((resolve) => setTimeout(resolve, 0));
    state$.regionPathsNodeId.set("");
    state$.editNodeId.set("");
    const region = {
      id: "region-new",
      type: "group" as const,
      label: "new region",
      x: 0,
      y: 0,
      width: 560,
      height: 320,
    };

    addNode(nodeOfDocument("mutation-test", region, 9)!);
    expect(state$.selectedNodeId.peek()).toBe("region-new");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state$.regionPathsNodeId.peek()).toBe("region-new");
    expect(state$.editNodeId.peek()).toBe("");
  });

  it("finds a non-overlapping slot for additions near the viewport center", () => {
    const existing = [{ id: "occupied", type: "text" as const, text: "occupied", x: -120, y: -50, width: 240, height: 100 }];
    const position = findOpenPosition(existing, { x: 0, y: 0 }, { width: 240, height: 100 });

    expect(position).not.toEqual({ x: -120, y: -50 });
    expect(position.x + 240 <= existing[0].x || position.x >= existing[0].x + existing[0].width || position.y + 100 <= existing[0].y || position.y >= existing[0].y + existing[0].height).toBe(true);
  });

  it("sets and clears JSON Canvas accent colors", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    setNodeColor("source", "5");
    expect(docNow().nodes[0].color).toBe("5");
    setNodeColor("source");
    expect(docNow().nodes[0].color).toBeUndefined();
  });

  it("bulk-sets accent color across a multi-select", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "b", x: 20, y: 20, width: 100, height: 40 },
        { id: "c", type: "text", text: "c", x: 40, y: 40, width: 100, height: 40 },
      ],
      edges: [],
    });
    setNodeColorForNodes(["a", "b"], "3");
    const nodes = docNow().nodes;
    expect(nodes.find((n) => n.id === "a")?.color).toBe("3");
    expect(nodes.find((n) => n.id === "b")?.color).toBe("3");
    expect(nodes.find((n) => n.id === "c")?.color).toBeUndefined();
    setNodeColorForNodes(["a", "b"], undefined);
    expect(docNow().nodes.find((n) => n.id === "a")?.color).toBeUndefined();
  });

  it("sets and clears region plate accent colors", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [{ id: "region", type: "group", label: "Ops", x: 0, y: 0, width: 400, height: 200 }],
      edges: [],
    });
    setNodeColor("region", "6");
    const colored = docNow().nodes[0];
    expect(colored?.type).toBe("group");
    expect(colored?.color).toBe("6");
    setNodeColor("region");
    expect(docNow().nodes[0]?.color).toBeUndefined();
  });

  it("edits text, page url, and region content through the shared mutation plane", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ nodes: [
      { id: "note", type: "text", text: "before", x: 0, y: 0, width: 200, height: 80 },
      {
        id: "page",
        type: "link",
        url: "https://before.example",
        x: 0,
        y: 100,
        width: 200,
        height: 80,
        ether: {
          entity: { kind: "page" },
          host: "local",
          browser: { profile: "personal", onDelete: "kill-session" },
        },
      },
      { id: "region", type: "group", label: "Before", x: 0, y: 200, width: 300, height: 160 },
    ], edges: [] });

    editText("note", "after");
    editLink("page", "https://after.example");
    renameGroup("region", "After");

    expect(docNow().nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "note", text: "after" }),
      expect.objectContaining({ id: "page", url: "https://after.example" }),
      expect.objectContaining({ id: "region", label: "After" }),
    ]));
  });

  it("renames a terminal: its label, and nothing else about it", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        {
          id: "term",
          type: "text",
          text: "terminal\nnotes stay",
          x: 0,
          y: 0,
          width: 220,
          height: 84,
          ether: {
            entity: { kind: "terminal" },
            terminal: {
              bindingId: "bind-1",
              label: "terminal",
            },
          },
        },
      ],
      edges: [],
    });

    renameTerminalNode("term", "Dev shell");

    // A terminal is named by its label, one line; that is all a rename changes.
    const node = docNow().nodes.find((candidate) => candidate.id === "term");
    expect(node?.ether?.entity?.kind).toBe("terminal");
    expect(node?.ether?.terminal).toMatchObject({ bindingId: "bind-1" });
    expect(node === undefined ? undefined : nodeOfDocument("mutation-test", node, 0)).toMatchObject({
      kind: "terminal",
      label: "Dev shell",
      bindingId: "bind-1",
    });
    expect(node).toMatchObject({ x: 0, y: 0, width: 220, height: 84 });
  });

  it("editLink ignores plain (non-page) link furniture", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [{ id: "link", type: "link", url: "https://before.example", x: 0, y: 0, width: 200, height: 80 }],
      edges: [],
    });
    editLink("link", "https://after.example");
    expect(docNow().nodes[0]).toMatchObject({
      id: "link",
      url: "https://before.example",
    });
  });

  it("edits page host/profile without dropping URL, delete policy, or sibling ether", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ nodes: [{
      id: "page",
      type: "link",
      url: "https://before.example",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "page" },
        host: "local",
        browser: { profile: "personal", onDelete: "kill-session" },
      },
    }], edges: [] });

    setPageBinding("page", { profile: "work", host: "studio" });

    expect(docNow().nodes[0]).toMatchObject({
      url: "https://before.example",
      ether: {
        entity: { kind: "page" },
        host: "studio",
        browser: { profile: "work", onDelete: "kill-session" },
      },
    });
    expect(Result.isSuccess(decodeCanvasDoc(docNow()))).toBe(true);
  });

  it("turns a region's hold on and off, and off leaves nothing saying it holds", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ nodes: [{ id: "region", type: "group", label: "Hold", x: 0, y: 0, width: 400, height: 300 }], edges: [] });

    setRegionHold("region", true);
    expect(docNow().nodes[0]?.ether?.region?.hold).toBe(true);

    setRegionHold("region", false);
    expect(docNow().nodes[0]?.ether?.region?.hold ?? false).toBe(false);
  });

  it("changes only the hold: the region's briefing and its name stay as they were", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [{
        id: "region", type: "group", label: "Hold", x: 0, y: 0, width: 400, height: 300,
        ether: { region: { instruction: "ship the region" } },
      }],
      edges: [],
    });

    setRegionHold("region", true);
    setRegionHold("region", false);

    const region = docNow().nodes[0];
    expect(region?.ether?.region?.instruction).toBe("ship the region");
    expect(region?.type === "group" ? region.label : undefined).toBe("Hold");
    expect(region?.ether?.region?.hold ?? false).toBe(false);
  });

  it("setRegionDefaults writes bag and preserves hold + instruction on clear", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [{
        id: "region",
        type: "group",
        label: "Defaults",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        ether: { region: { hold: true, instruction: "ship the region" } },
      }],
      edges: [],
    });

    setRegionDefaults("region", {
      page: { url: "https://example.com", profile: "work" },
      paths: { local: "/Users/op/proj", "remote-a": "/home/op/proj" },
    });
    const withDefaults = docNow().nodes[0];
    expect(withDefaults?.ether?.region?.hold).toBe(true);
    expect(withDefaults?.ether?.region?.instruction).toBe("ship the region");
    expect(withDefaults?.ether?.region?.defaults?.page?.profile).toBe("work");
    expect(withDefaults?.ether?.region?.defaults?.paths).toEqual({
      local: "/Users/op/proj",
      "remote-a": "/home/op/proj",
    });

    setRegionDefaults("region", undefined);
    const cleared = docNow().nodes[0];
    expect(cleared?.ether?.region).toEqual({ hold: true, instruction: "ship the region" });
    expect(Object.hasOwn(cleared?.ether?.region ?? {}, "defaults")).toBe(false);
  });

  it("setRegionEnvironment writes names and references, keeps the rest of the region, and strips on clear", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [{
        id: "region",
        type: "group",
        label: "Payments",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        ether: { region: { hold: true, instruction: "ship the region", defaults: { paths: { local: "/Users/op/proj" } } } },
      }],
      edges: [],
    });

    setRegionEnvironment("region", {
      sealed: true,
      sources: [
        { id: "k1", kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: "test-region-credential" },
        { id: "s1", kind: "secret", name: "GITHUB_TOKEN", secretId: "8f0c1f0e-2f6f-4c7e-9f0a-3b1d2c4e5f60" },
      ],
      folders: ["~/.config/gcloud"],
    });
    const region = docNow().nodes[0]?.ether?.region;
    expect(region?.hold).toBe(true);
    expect(region?.instruction).toBe("ship the region");
    expect(region?.defaults?.paths).toEqual({ local: "/Users/op/proj" });
    expect(region?.environment?.sealed).toBe(true);
    expect(region?.environment?.sources?.map((source) => source.id)).toEqual(["k1", "s1"]);
    // What was written is a document the canvas schema accepts.
    expect(Result.isSuccess(decodeCanvasDoc(docNow()))).toBe(true);

    setRegionEnvironment("region", undefined);
    const cleared = docNow().nodes[0]?.ether?.region;
    expect(Object.hasOwn(cleared ?? {}, "environment")).toBe(false);
    expect(cleared?.hold).toBe(true);
    expect(cleared?.defaults?.paths).toEqual({ local: "/Users/op/proj" });
  });

  it("setRegionDefaults ignores non-group nodes", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [{ id: "note", type: "text", text: "x", x: 0, y: 0, width: 100, height: 80 }],
      edges: [],
    });
    setRegionDefaults("note", { page: { url: "https://example.com" } });
    expect(docNow().nodes[0]?.ether).toBeUndefined();
  });

});
