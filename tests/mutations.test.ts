import { afterEach, describe, expect, it, vi } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc, type GroupNode } from "../src/shared/canvas";
import { addNode, commitDoc, deleteNode, editFileDetails, editGroupBackground, editLink, editText, loadDoc, promoteLinkToPage, redo, renameGroup, setFlagForNodes, setNodeColor, setNodeColorForNodes, setNodeHost, setPageBinding, setRegionDefaults, setRegionHold, toggleFlag, undo } from "../src/renderer/lib/mutations";
import { addEdge, connectAllToTarget, deleteEdges, editEdgeLabel, inferEdgeCriteria, planConnectToTarget, setEdgeColor, setEdgeCriteria, setEdgePorts, toggleEdgeArrow } from "../src/renderer/lib/edge-mutations";
import { dragHoldMemberIds, findOpenPosition, resizeNode, syncPositions } from "../src/renderer/lib/geometry";
import { clearGraphFilters, state$, toggleFlagFilter } from "../src/renderer/lib/state";
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
  vellum: {
    writeCanvas: async () => ({ revision: "test-revision" }),
    browserStop,
    browserSessionList: async () => ({ ok: true, data: [] }),
    chatClose,
    chatBeginNodeDelete,
    chatFinishNodeDelete,
  },
  setTimeout: globalThis.setTimeout,
  confirm: () => true,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

const doc: CanvasDoc = {
  nodes: [
    { id: "source", type: "text", text: "SOURCE", x: 0, y: 0, width: 200, height: 80 },
    { id: "target", type: "text", text: "TARGET", x: 300, y: 0, width: 200, height: 80 },
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
    dock$.stopErrorByRef.set({});
    state$.settings.station.hostId.set("local");
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
    expect(state$.doc.peek().nodes.map((node) => node.id)).toEqual(["page"]);
    expect(state$.error.peek()).toBe("Stop Page failed; the page node was not deleted.");
    expect(dock$.stopErrorByRef[ref].peek()).toBe("physical teardown not acknowledged");
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

    await waitFor(() => expect(state$.doc.peek().nodes).toHaveLength(0));
    expect(browserStop).toHaveBeenCalledWith("page-session");
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
    expect(state$.doc.peek().nodes.map((node) => node.id)).toEqual(["page"]);

    deleteNode("page");
    await waitFor(() => expect(state$.doc.peek().nodes).toHaveLength(0));
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
    expect(state$.doc.peek().nodes).toMatchObject([
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
        ether: { entity: { kind: "agent", name: "local:default" } },
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
        ether: { entity: { kind: "agent", name: "local:default" } },
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
    expect(state$.doc.peek().nodes).toMatchObject([
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
        ether: { entity: { kind: "agent", name: "local:default" } },
      } as const;
    loadDoc({
      nodes: [agentNode],
      edges: [],
    });
    openAgentChatSurface(agentNode);
    expect(dock$.registry.peek().surfaces).toMatchObject([
      { id: "chat:agent", kind: "chat", zone: "focus" },
    ]);

    deleteNode("agent");
    await waitFor(() => expect(state$.doc.peek().nodes).toEqual([]));
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

  it("creates schema-valid soft edges without criteria", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    addEdge({ source: "source", target: "target" });

    const edge = state$.doc.peek().edges[0];
    expect(edge).toMatchObject({ fromNode: "source", toNode: "target" });
    expect(edge?.ether?.criteria).toBeUndefined();
    expect(state$.selectedNodeId.peek()).toBe("");
    expect(state$.selectedEdgeId.peek()).toBe(edge?.id);
    expect(Object.hasOwn(edge ?? {}, "fromSide")).toBe(false);
    expect(Object.hasOwn(edge ?? {}, "toSide")).toBe(false);
    expect(Result.isSuccess(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
  });

  it("auto-binds tasks criteria when connecting from a tasks node", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        {
          id: "tasks",
          type: "text",
          text: "ops",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "task" },
            tasks: {
              items: [
                {
                  id: "i1",
                  state: "submitted",
                  history: [
                    {
                      messageId: "m1",
                      role: "user",
                      parts: [{ kind: "text", text: "ship" }],
                      taskId: "i1",
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          id: "proj",
          type: "text",
          text: "quasar",
          x: 300,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "project", name: "quasar" },
          },
        },
      ],
      edges: [],
    });
    expect(inferEdgeCriteria(state$.doc.peek().nodes[0])).toEqual({ mode: "tasks" });
    addEdge({ source: "tasks", target: "proj" });
    const edge = state$.doc.peek().edges[0];
    expect(edge?.ether?.criteria).toEqual({ mode: "tasks" });
    expect(edge?.ether?.kind).toBeUndefined();
    expect(Result.isSuccess(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
  });

  it("auto-binds tasks criteria when connecting from a requests node", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        {
          id: "req",
          type: "text",
          text: "1 pending",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "requests" },
            requests: {
              items: [
                {
                  id: "q1",
                  state: "input-required",
                  history: [
                    {
                      messageId: "m1",
                      role: "user",
                      parts: [{ kind: "text", text: "approve?" }],
                      taskId: "q1",
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          id: "proj",
          type: "text",
          text: "quasar",
          x: 300,
          y: 0,
          width: 200,
          height: 80,
          ether: { entity: { kind: "project", name: "quasar" } },
        },
      ],
      edges: [],
    });
    expect(inferEdgeCriteria(state$.doc.peek().nodes[0])).toEqual({ mode: "tasks" });
    addEdge({ source: "req", target: "proj" });
    expect(state$.doc.peek().edges[0]?.ether?.criteria).toEqual({ mode: "tasks" });
  });

  it("sets tasks criteria and strips ether when cleared", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      ...doc,
      edges: [
        {
          id: "edge-1",
          fromNode: "source",
          toNode: "target",
        },
      ],
    });

    setEdgeCriteria("edge-1", { mode: "tasks" });
    expect(state$.doc.peek().edges[0]?.ether?.criteria).toEqual({
      mode: "tasks",
    });

    setEdgeCriteria("edge-1", undefined);
    expect(state$.doc.peek().edges[0]?.ether).toBeUndefined();
    expect(Object.hasOwn(state$.doc.peek().edges[0] ?? {}, "ether")).toBe(false);
    expect(Result.isSuccess(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
  });

  it("setEdgePorts attenuates and clear removes the field", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      ...doc,
      edges: [
        {
          id: "edge-1",
          fromNode: "source",
          toNode: "target",
          ether: { criteria: { mode: "tasks" } },
        },
      ],
    });

    setEdgePorts("edge-1", ["msg.send", "browser.automate"]);
    expect(state$.doc.peek().edges[0]?.ether?.ports).toEqual([
      "msg.send",
      "browser.automate",
    ]);
    expect(state$.doc.peek().edges[0]?.ether?.criteria).toEqual({ mode: "tasks" });
    expect(Result.isSuccess(decodeCanvasDoc(state$.doc.peek()))).toBe(true);

    setEdgePorts("edge-1", undefined);
    expect(state$.doc.peek().edges[0]?.ether?.ports).toBeUndefined();
    expect(Object.hasOwn(state$.doc.peek().edges[0]?.ether ?? {}, "ports")).toBe(false);
    expect(state$.doc.peek().edges[0]?.ether?.criteria).toEqual({ mode: "tasks" });

    setEdgePorts("edge-1", ["msg.list"]);
    expect(state$.doc.peek().edges[0]?.ether?.ports).toEqual(["msg.list"]);
    setEdgePorts("edge-1", []);
    expect(state$.doc.peek().edges[0]?.ether?.ports).toBeUndefined();
    expect(state$.doc.peek().edges[0]?.ether?.criteria).toEqual({ mode: "tasks" });
    expect(Result.isSuccess(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
  });

  it("rejects a duplicate source-to-target relation", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    addEdge({ source: "source", target: "target" });
    addEdge({ source: "source", target: "target" });

    expect(state$.doc.peek().edges).toHaveLength(1);
    expect(state$.error.peek()).toBe("That relation already exists.");
  });

  it("toggles and clears the flag filter without touching the document", () => {
    loadDoc(doc);
    const before = state$.doc.peek();

    toggleFlagFilter("attention");

    expect(state$.flagFilter.peek()).toBe("attention");
    expect(state$.doc.peek()).toBe(before);

    clearGraphFilters();
    expect(state$.flagFilter.peek()).toBe("");
    expect(state$.selectedNodeId.peek()).toBe("");
    expect(state$.selectedEdgeId.peek()).toBe("");
  });

  it("surfaces self-connections instead of failing silently", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);

    addEdge({ source: "source", target: "source" });

    expect(state$.doc.peek().edges).toHaveLength(0);
    expect(state$.error.peek()).toBe("A node cannot connect to itself.");
  });

  describe("planConnectToTarget (pure edge-batch helper, RTS-006)", () => {
    const batchNodes: CanvasDoc["nodes"] = [
      { id: "a", type: "text", text: "A", x: 0, y: 0, width: 200, height: 80 },
      { id: "b", type: "text", text: "B", x: 100, y: 0, width: 200, height: 80 },
      { id: "c", type: "text", text: "C", x: 200, y: 0, width: 200, height: 80 },
      { id: "region", type: "group", label: "R", x: 0, y: 100, width: 400, height: 200 },
      {
        id: "tasks",
        type: "text",
        text: "ops",
        x: 0,
        y: 400,
        width: 200,
        height: 80,
        ether: {
          entity: { kind: "task" },
          tasks: {
            items: [
              {
                id: "i1",
                state: "submitted",
                history: [
                  {
                    messageId: "m1",
                    role: "user",
                    parts: [{ kind: "text", text: "ship" }],
                    taskId: "i1",
                  },
                ],
              },
            ],
          },
        },
      },
    ];

    it("plans soft relates from each source to the target", () => {
      const plan = planConnectToTarget(["a", "b"], "c", batchNodes, []);
      expect(plan.toAdd).toEqual([
        { fromNode: "a", toNode: "c" },
        { fromNode: "b", toNode: "c" },
      ]);
      expect(plan.skipped).toEqual([]);
      // Soft relates: no criteria key on candidates
      for (const candidate of plan.toAdd) {
        expect(Object.hasOwn(candidate, "criteria")).toBe(false);
      }
    });

    it("skips self, duplicates, groups, and missing sources", () => {
      const plan = planConnectToTarget(
        ["a", "a", "c", "region", "missing", "b"],
        "c",
        batchNodes,
        [{ id: "e1", fromNode: "b", toNode: "c" }],
      );
      expect(plan.toAdd).toEqual([{ fromNode: "a", toNode: "c" }]);
      expect(plan.skipped).toEqual([
        { source: "a", reason: "duplicate" },
        { source: "c", reason: "self" },
        { source: "region", reason: "group-source" },
        { source: "missing", reason: "missing-source" },
        { source: "b", reason: "duplicate" },
      ]);
    });

    it("rejects group targets and missing targets for every source", () => {
      expect(planConnectToTarget(["a", "b"], "region", batchNodes, []).skipped).toEqual([
        { source: "a", reason: "invalid-target" },
        { source: "b", reason: "invalid-target" },
      ]);
      expect(planConnectToTarget(["a"], "gone", batchNodes, []).toAdd).toEqual([]);
    });

    it("infers tasks criteria per source when connecting a tasks node", () => {
      const plan = planConnectToTarget(["tasks", "a"], "c", batchNodes, []);
      expect(plan.toAdd).toEqual([
        { fromNode: "tasks", toNode: "c", criteria: { mode: "tasks" } },
        { fromNode: "a", toNode: "c" },
      ]);
    });

    it("does not mutate inputs", () => {
      const sources = ["a", "b"] as const;
      const edges: CanvasDoc["edges"] = [];
      const plan = planConnectToTarget(sources, "c", batchNodes, edges);
      expect(plan.toAdd).toHaveLength(2);
      expect(edges).toHaveLength(0);
      expect(sources).toEqual(["a", "b"]);
    });
  });

  it("connectAllToTarget commits multi-source soft relates in one write", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        { id: "a", type: "text", text: "A", x: 0, y: 0, width: 200, height: 80 },
        { id: "b", type: "text", text: "B", x: 100, y: 0, width: 200, height: 80 },
        { id: "c", type: "text", text: "C", x: 200, y: 0, width: 200, height: 80 },
      ],
      edges: [],
    });

    const plan = connectAllToTarget(["a", "b"], "c");
    expect(plan.toAdd).toHaveLength(2);
    const next = state$.doc.peek().edges;
    expect(next).toHaveLength(2);
    expect(next.map((edge) => ({ from: edge.fromNode, to: edge.toNode }))).toEqual([
      { from: "a", to: "c" },
      { from: "b", to: "c" },
    ]);
    for (const edge of next) {
      expect(edge.ether?.criteria).toBeUndefined();
    }
    expect(state$.selectedNodeId.peek()).toBe("");
    expect(state$.selectedEdgeId.peek()).toBe(next[1]?.id);
    expect(Result.isSuccess(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
  });

  it("connectAllToTarget keepSelection leaves multi-select intact", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        { id: "a", type: "text", text: "A", x: 0, y: 0, width: 200, height: 80 },
        { id: "t1", type: "text", text: "T1", x: 100, y: 0, width: 200, height: 80 },
        { id: "t2", type: "text", text: "T2", x: 200, y: 0, width: 200, height: 80 },
      ],
      edges: [],
    });
    state$.selectedNodeId.set("a");
    state$.selectedNodeIds.set(["a"]);

    connectAllToTarget(["a"], "t1", { keepSelection: true });
    expect(state$.selectedNodeId.peek()).toBe("a");
    expect(state$.selectedNodeIds.peek()).toEqual(["a"]);
    connectAllToTarget(["a"], "t2", { keepSelection: true });
    expect(state$.doc.peek().edges).toHaveLength(2);
    expect(state$.selectedNodeIds.peek()).toEqual(["a"]);
  });

  it("requires confirmation before deleting signals and connected relations", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ ...doc, edges: [{ id: "edge-1", fromNode: "source", toNode: "target" }] });
    runtimeWindow.confirm = () => false;

    deleteNode("source");
    expect(state$.doc.peek().nodes).toHaveLength(2);
    expect(state$.doc.peek().edges).toHaveLength(1);

    runtimeWindow.confirm = () => true;
    deleteNode("source");
    expect(state$.doc.peek().nodes.map((node) => node.id)).toEqual(["target"]);
    expect(state$.doc.peek().edges).toHaveLength(0);
  });

  it("requires confirmation before deleting relations", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ ...doc, edges: [{ id: "edge-1", fromNode: "source", toNode: "target" }] });
    runtimeWindow.confirm = () => false;

    deleteEdges(["edge-1"]);
    expect(state$.doc.peek().edges).toHaveLength(1);

    runtimeWindow.confirm = () => true;
    deleteEdges(["edge-1"]);
    expect(state$.doc.peek().edges).toHaveLength(0);
  });

  it("keeps dragged positions integer-aligned in renderer state", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    syncPositions(new Map([["source", { x: 1.6, y: -2.4 }]]));

    expect(state$.doc.peek().nodes[0]).toMatchObject({ x: 2, y: -2 });
  });

  it("preserves CanvasNode identity for unmoved nodes so flow cache can reuse them", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    const before = state$.doc.peek().nodes;
    const sourceBefore = before[0];
    const targetBefore = before[1];
    // Source moves; target coords match current (rounded no-op).
    syncPositions(
      new Map([
        ["source", { x: 50, y: 60 }],
        ["target", { x: targetBefore!.x, y: targetBefore!.y }],
      ]),
    );
    const after = state$.doc.peek().nodes;
    expect(after[0]).not.toBe(sourceBefore);
    expect(after[0]).toMatchObject({ id: "source", x: 50, y: 60 });
    expect(after[1]).toBe(targetBefore);
  });

  it("skips commit entirely when no rounded position changed", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    const before = state$.doc.peek();
    const epoch = state$.docEpoch.peek();
    syncPositions(
      new Map(before.nodes.map((n) => [n.id, { x: n.x, y: n.y }])),
    );
    expect(state$.doc.peek()).toBe(before);
    expect(state$.docEpoch.peek()).toBe(epoch);
  });

  it("bumps docEpoch on undo and redo so generation fences observe history", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    commitDoc({
      nodes: [{ id: "source", type: "text", text: "EDITED", x: 0, y: 0, width: 200, height: 80 }],
      edges: [],
    });
    const afterCommit = state$.docEpoch.peek();
    undo();
    expect(state$.docEpoch.peek()).toBe(afterCommit + 1);
    expect(state$.doc.peek().nodes[0]).toMatchObject({ text: "SOURCE" });
    redo();
    expect(state$.docEpoch.peek()).toBe(afterCommit + 2);
    expect(state$.doc.peek().nodes[0]).toMatchObject({ text: "EDITED" });
  });

  it("persists region geometry changes without rebuilding the graph", () => {
    state$.canvasName.set("mutation-test");
    const regionDoc: CanvasDoc = { nodes: [{ id: "region", type: "group", label: "UI QA", x: 0, y: 0, width: 400, height: 200 }], edges: [] };
    loadDoc(regionDoc);
    resizeNode("region", { x: 12.6, y: -3.4, width: 525.8, height: 286.2 });

    expect(state$.doc.peek().nodes[0]).toMatchObject({ x: 13, y: -3, width: 526, height: 286 });
  });

  it("selects a newly created item before opening its editor", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    const node = { id: "new-note", type: "text" as const, text: "new note", x: 0, y: 0, width: 240, height: 100 };

    addNode(node);

    expect(state$.selectedNodeId.peek()).toBe("new-note");
    expect(state$.selectedEdgeId.peek()).toBe("");
    expect(state$.doc.peek().nodes.at(-1)).toEqual(node);
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

    addNode(region);
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

  it("toggles the full Ether flag vocabulary", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    toggleFlag("source", "attention");
    toggleFlag("source", "parked");

    expect(state$.doc.peek().nodes[0].ether?.flags).toEqual(["attention", "parked"]);

    toggleFlag("source", "attention");
    expect(state$.doc.peek().nodes[0].ether?.flags).toEqual(["parked"]);
  });

  it("sets and clears JSON Canvas accent colors", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    setNodeColor("source", "5");
    expect(state$.doc.peek().nodes[0].color).toBe("5");
    setNodeColor("source");
    expect(state$.doc.peek().nodes[0].color).toBeUndefined();
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
    const nodes = state$.doc.peek().nodes;
    expect(nodes.find((n) => n.id === "a")?.color).toBe("3");
    expect(nodes.find((n) => n.id === "b")?.color).toBe("3");
    expect(nodes.find((n) => n.id === "c")?.color).toBeUndefined();
    setNodeColorForNodes(["a", "b"], undefined);
    expect(state$.doc.peek().nodes.find((n) => n.id === "a")?.color).toBeUndefined();
  });

  it("bulk flag set and clear modes", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        { id: "a", type: "text", text: "a", x: 0, y: 0, width: 100, height: 40 },
        { id: "b", type: "text", text: "b", x: 20, y: 20, width: 100, height: 40 },
      ],
      edges: [],
    });
    setFlagForNodes(["a", "b"], "blocker");
    expect(state$.doc.peek().nodes.every((n) => n.ether?.flags?.includes("blocker"))).toBe(true);
    setFlagForNodes(["a", "b"], "blocker", "clear");
    expect(state$.doc.peek().nodes.every((n) => !n.ether?.flags?.includes("blocker"))).toBe(true);
  });

  it("sets and clears region plate accent colors", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [{ id: "region", type: "group", label: "Ops", x: 0, y: 0, width: 400, height: 200 }],
      edges: [],
    });
    setNodeColor("region", "6");
    const colored = state$.doc.peek().nodes[0];
    expect(colored?.type).toBe("group");
    expect(colored?.color).toBe("6");
    setNodeColor("region");
    expect(state$.doc.peek().nodes[0]?.color).toBeUndefined();
  });

  it("changes only a tasks sink queue home", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [
        {
          id: "tasks",
          type: "text",
          text: "tasks",
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          ether: {
            entity: { kind: "task" },
            host: "local",
            tasks: { items: [] },
          },
        },
        {
          id: "actor",
          type: "text",
          text: "agent",
          x: 300,
          y: 0,
          width: 260,
          height: 110,
          ether: {
            entity: { kind: "agent", name: "local:codex" },
            host: "local",
            terminal: {
              bindingId: "binding-1",
              harness: "codex",
              launch: { kind: "harness", argv: ["codex"] },
            },
          },
        },
      ],
      edges: [],
    });

    setNodeHost("tasks", "remote-a");
    setNodeHost("actor", "remote-a");

    expect(state$.doc.peek().nodes[0]?.ether?.host).toBe("remote-a");
    expect(state$.doc.peek().nodes[1]?.ether).toMatchObject({
      entity: { name: "local:codex" },
      host: "local",
    });

    setNodeHost("tasks", "-invalid");
    expect(state$.doc.peek().nodes[0]?.ether?.host).toBe("remote-a");
  });

  it("edits and clears native edge labels", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ ...doc, edges: [{ id: "edge-1", fromNode: "source", toNode: "target" }] });
    editEdgeLabel("edge-1", "in");
    expect(state$.doc.peek().edges[0]?.label).toBe("in");
    editEdgeLabel("edge-1", "  ");
    expect(state$.doc.peek().edges[0]?.label).toBeUndefined();
  });

  it("toggles source and target arrow ends", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ ...doc, edges: [{ id: "edge-1", fromNode: "source", toNode: "target" }] });
    toggleEdgeArrow("edge-1", "from");
    toggleEdgeArrow("edge-1", "to");
    expect(state$.doc.peek().edges[0]).toMatchObject({ fromEnd: "arrow", toEnd: "arrow" });
    toggleEdgeArrow("edge-1", "to");
    expect(state$.doc.peek().edges[0]?.toEnd).toBeUndefined();
  });

  it("sets and clears edge accent colors", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ ...doc, edges: [{ id: "edge-1", fromNode: "source", toNode: "target" }] });
    setEdgeColor("edge-1", "6");
    expect(state$.doc.peek().edges[0]?.color).toBe("6");
    setEdgeColor("edge-1");
    expect(state$.doc.peek().edges[0]?.color).toBeUndefined();
  });

  it("edits and clears region backgrounds with fit style", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ nodes: [{ id: "region", type: "group", label: "region", x: 0, y: 0, width: 400, height: 200 }], edges: [] });
    editGroupBackground("region", "https://example.com/field.png", "ratio");
    expect(state$.doc.peek().nodes[0]).toMatchObject({ background: "https://example.com/field.png", backgroundStyle: "ratio" });
    editGroupBackground("region", "", "cover");
    expect(Object.hasOwn(state$.doc.peek().nodes[0] ?? {}, "background")).toBe(false);
    expect(Object.hasOwn(state$.doc.peek().nodes[0] ?? {}, "backgroundStyle")).toBe(false);
  });

  it("edits file paths and subpaths together", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ nodes: [{ id: "file", type: "file", file: "docs/old.md", x: 0, y: 0, width: 200, height: 80 }], edges: [] });
    editFileDetails("file", "docs/readme.md", "#install");
    expect(state$.doc.peek().nodes[0]).toMatchObject({ file: "docs/readme.md", subpath: "#install" });
    editFileDetails("file", "docs/readme.md", "");
    expect(state$.doc.peek().nodes[0]).toMatchObject({ file: "docs/readme.md" });
    expect(Object.hasOwn(state$.doc.peek().nodes[0] ?? {}, "subpath")).toBe(false);
  });

  it("edits text, link, and region content through the shared mutation plane", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ nodes: [
      { id: "note", type: "text", text: "before", x: 0, y: 0, width: 200, height: 80 },
      { id: "link", type: "link", url: "https://before.example", x: 0, y: 100, width: 200, height: 80 },
      { id: "region", type: "group", label: "Before", x: 0, y: 200, width: 300, height: 160 },
    ], edges: [] });

    editText("note", "after");
    editLink("link", "https://after.example");
    renameGroup("region", "After");

    expect(state$.doc.peek().nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "note", text: "after" }),
      expect.objectContaining({ id: "link", url: "https://after.example" }),
      expect.objectContaining({ id: "region", label: "After" }),
    ]));
  });

  it("promotes a plain link node in place into a bound browser page work surface", () => {
    state$.canvasName.set("mutation-test");
    state$.settings.station.hostId.set("studio");
    loadDoc({ nodes: [
      { id: "link", type: "link", url: "https://before.example", x: 0, y: 0, width: 200, height: 80 },
    ], edges: [] });

    promoteLinkToPage("link", "work");
    state$.settings.station.hostId.set("local");

    const node = state$.doc.peek().nodes[0];
    expect(node).toMatchObject({
      id: "link",
      type: "link",
      url: "https://before.example", // url untouched — only ether is stamped
      ether: {
        entity: { kind: "page" },
        host: "studio",
        browser: { profile: "work", onDelete: "detach" },
      },
    });
    expect(Result.isSuccess(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
  });

  it("promoteLinkToPage is a no-op against a non-link node id", () => {
    state$.canvasName.set("mutation-test");
    const note = { id: "note", type: "text" as const, text: "hello", x: 0, y: 0, width: 200, height: 80 };
    loadDoc({ nodes: [note], edges: [] });

    promoteLinkToPage("note", "personal");

    expect(state$.doc.peek().nodes[0]).toEqual(note);
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
        flags: ["attention"],
        browser: { profile: "personal", onDelete: "kill-session" },
      },
    }], edges: [] });

    setPageBinding("page", { profile: "work", host: "studio" });

    expect(state$.doc.peek().nodes[0]).toMatchObject({
      url: "https://before.example",
      ether: {
        entity: { kind: "page" },
        host: "studio",
        flags: ["attention"],
        browser: { profile: "work", onDelete: "kill-session" },
      },
    });
    expect(Result.isSuccess(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
  });

  it("includes a node whose center lies inside the region and excludes one merely overlapping its edge", () => {
    const region: GroupNode = { id: "region", type: "group", label: "Hold", x: 0, y: 0, width: 400, height: 300 };
    // Center (140, 120) — squarely inside the 400x300 rect.
    const centered: CanvasDoc["nodes"][number] = { id: "centered", type: "text", text: "in", x: 100, y: 100, width: 80, height: 40 };
    // Spans x 380-460, overlapping the region's right edge (x=400), but its
    // center (420, 120) sits outside — geometric overlap is not membership.
    const edgeOverlap: CanvasDoc["nodes"][number] = { id: "edge-overlap", type: "text", text: "edge", x: 380, y: 100, width: 80, height: 40 };
    const doc: CanvasDoc = { nodes: [region, centered, edgeOverlap], edges: [] };

    const ids = dragHoldMemberIds(doc, region);

    expect(ids).toEqual(["centered"]);
  });

  it("includes a nested region whose center lies inside the outer region", () => {
    const outer: GroupNode = { id: "outer", type: "group", label: "Outer", x: 0, y: 0, width: 600, height: 600 };
    const inner: GroupNode = { id: "inner", type: "group", label: "Inner", x: 100, y: 100, width: 200, height: 200 };
    const doc: CanvasDoc = { nodes: [outer, inner], edges: [] };

    expect(dragHoldMemberIds(doc, outer)).toEqual(["inner"]);
  });

  it("never includes the region itself", () => {
    const region: GroupNode = { id: "self", type: "group", label: "Self", x: 0, y: 0, width: 200, height: 200 };
    const doc: CanvasDoc = { nodes: [region], edges: [] };

    expect(dragHoldMemberIds(doc, region)).toEqual([]);
  });

  it("writes and strips ether.region.hold following the flag-strip pattern", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ nodes: [{ id: "region", type: "group", label: "Hold", x: 0, y: 0, width: 400, height: 300 }], edges: [] });

    setRegionHold("region", true);
    expect(state$.doc.peek().nodes[0]?.ether?.region).toEqual({ hold: true });

    setRegionHold("region", false);
    expect(Object.hasOwn(state$.doc.peek().nodes[0] ?? {}, "ether")).toBe(false);
  });

  it("clears just the region key, keeping a sibling ether field intact", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({ nodes: [{ id: "region", type: "group", label: "Hold", x: 0, y: 0, width: 400, height: 300 }], edges: [] });

    toggleFlag("region", "attention");
    setRegionHold("region", true);
    setRegionHold("region", false);

    expect(state$.doc.peek().nodes[0]?.ether?.flags).toEqual(["attention"]);
    expect(Object.hasOwn(state$.doc.peek().nodes[0]?.ether ?? {}, "region")).toBe(false);
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
      herdr: { host: "local", session: null, workspaceId: "w1" },
      page: { url: "https://example.com", profile: "work" },
      paths: { local: "/Users/op/proj", "remote-a": "/home/op/proj" },
    });
    const withDefaults = state$.doc.peek().nodes[0];
    expect(withDefaults?.ether?.region?.hold).toBe(true);
    expect(withDefaults?.ether?.region?.instruction).toBe("ship the region");
    expect(withDefaults?.ether?.region?.defaults?.herdr?.host).toBe("local");
    expect(withDefaults?.ether?.region?.defaults?.page?.profile).toBe("work");
    expect(withDefaults?.ether?.region?.defaults?.paths).toEqual({
      local: "/Users/op/proj",
      "remote-a": "/home/op/proj",
    });

    setRegionDefaults("region", undefined);
    const cleared = state$.doc.peek().nodes[0];
    expect(cleared?.ether?.region).toEqual({ hold: true, instruction: "ship the region" });
    expect(Object.hasOwn(cleared?.ether?.region ?? {}, "defaults")).toBe(false);
  });

  it("setRegionDefaults ignores non-group nodes", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      nodes: [{ id: "note", type: "text", text: "x", x: 0, y: 0, width: 100, height: 80 }],
      edges: [],
    });
    setRegionDefaults("note", { herdr: { host: "local" } });
    expect(state$.doc.peek().nodes[0]?.ether).toBeUndefined();
  });
});
