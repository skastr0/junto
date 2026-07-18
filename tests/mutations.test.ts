import { afterEach, describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeCanvasDoc, type CanvasDoc, type GroupNode } from "../src/shared/canvas";
import { addNode, deleteNode, editFileDetails, editGroupBackground, editLink, editText, loadDoc, promoteLinkToPage, renameGroup, setNodeColor, setNodeView, setRegionDefaults, setRegionHold, toggleFlag } from "../src/renderer/lib/mutations";
import { addEdge, connectAllToTarget, deleteEdges, editEdgeLabel, inferEdgeCriteria, planConnectToTarget, setEdgeColor, setEdgeCriteria, toggleEdgeArrow } from "../src/renderer/lib/edge-mutations";
import { containedNodeIds, findOpenPosition, resizeNode, syncPositions } from "../src/renderer/lib/geometry";
import { clearGraphFilters, state$, toggleFlagFilter } from "../src/renderer/lib/state";

const runtimeWindow = {
  vellum: { writeCanvas: async () => undefined },
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
    clearGraphFilters();
    loadDoc({ nodes: [], edges: [] });
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
    expect(Either.isRight(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
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
            tasks: { items: [{ id: "i1", text: "ship", done: false }] },
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
    expect(Either.isRight(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
  });

  it("refuses empty glyphs criteria shells and strips them when cleared", () => {
    state$.canvasName.set("mutation-test");
    loadDoc({
      ...doc,
      edges: [
        {
          id: "edge-1",
          fromNode: "source",
          toNode: "target",
          ether: { criteria: { mode: "glyphs", glyphIds: ["g1"], project: "quasar" } },
        },
      ],
    });

    setEdgeCriteria("edge-1", { mode: "glyphs", glyphIds: [], project: "quasar" });
    expect(state$.doc.peek().edges[0]?.ether).toBeUndefined();
    expect(Object.hasOwn(state$.doc.peek().edges[0] ?? {}, "ether")).toBe(false);

    setEdgeCriteria("edge-1", { mode: "glyphs", glyphIds: ["g2"], project: "quasar" });
    expect(state$.doc.peek().edges[0]?.ether?.criteria).toEqual({
      mode: "glyphs",
      glyphIds: ["g2"],
      project: "quasar",
    });

    setEdgeCriteria("edge-1", undefined);
    expect(state$.doc.peek().edges[0]?.ether).toBeUndefined();
    expect(Either.isRight(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
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
          tasks: { items: [{ id: "i1", text: "ship", done: false }] },
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
    expect(Either.isRight(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
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

  it("writes a project slice view and strips empty fields off it", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);

    setNodeView("source", { orbit: "forge", glyphQuery: "  bug  ", states: ["building", "  ", "reviewing"] });
    expect(state$.doc.peek().nodes[0]?.ether?.view).toEqual({
      orbit: "forge",
      glyphQuery: "bug",
      states: ["building", "reviewing"],
    });

    // A blank orbit/glyphQuery and an all-blank states array all collapse to
    // "field absent" — never a field present-but-empty.
    setNodeView("source", { orbit: "  ", glyphQuery: "", states: ["  "] });
    expect(state$.doc.peek().nodes[0]?.ether?.view).toBeUndefined();
    expect(Object.hasOwn(state$.doc.peek().nodes[0]?.ether ?? {}, "view")).toBe(false);
  });

  it("clears the view key entirely, and drops ether itself once nothing is left", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);

    setNodeView("source", { orbit: "beacon" });
    expect(state$.doc.peek().nodes[0]?.ether?.view).toEqual({ orbit: "beacon" });

    setNodeView("source", undefined);
    expect(Object.hasOwn(state$.doc.peek().nodes[0] ?? {}, "ether")).toBe(false);

    // With a sibling ether field present, clearing the view keeps ether but
    // drops just the view key — same degradation toggleFlag relies on.
    toggleFlag("source", "attention");
    setNodeView("source", { orbit: "beacon" });
    setNodeView("source", undefined);
    expect(state$.doc.peek().nodes[0]?.ether?.flags).toEqual(["attention"]);
    expect(Object.hasOwn(state$.doc.peek().nodes[0]?.ether ?? {}, "view")).toBe(false);
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
    loadDoc({ nodes: [
      { id: "link", type: "link", url: "https://before.example", x: 0, y: 0, width: 200, height: 80 },
    ], edges: [] });

    promoteLinkToPage("link", "work");

    const node = state$.doc.peek().nodes[0];
    expect(node).toMatchObject({
      id: "link",
      type: "link",
      url: "https://before.example", // url untouched — only ether is stamped
      ether: { entity: { kind: "page" }, browser: { profile: "work", onDelete: "detach" } },
    });
    expect(Either.isRight(decodeCanvasDoc(state$.doc.peek()))).toBe(true);
  });

  it("promoteLinkToPage is a no-op against a non-link node id", () => {
    state$.canvasName.set("mutation-test");
    const note = { id: "note", type: "text" as const, text: "hello", x: 0, y: 0, width: 200, height: 80 };
    loadDoc({ nodes: [note], edges: [] });

    promoteLinkToPage("note", "personal");

    expect(state$.doc.peek().nodes[0]).toEqual(note);
  });

  it("includes a node whose center lies inside the region and excludes one merely overlapping its edge", () => {
    const region: GroupNode = { id: "region", type: "group", label: "Hold", x: 0, y: 0, width: 400, height: 300 };
    // Center (140, 120) — squarely inside the 400x300 rect.
    const centered: CanvasDoc["nodes"][number] = { id: "centered", type: "text", text: "in", x: 100, y: 100, width: 80, height: 40 };
    // Spans x 380-460, overlapping the region's right edge (x=400), but its
    // center (420, 120) sits outside — geometric overlap is not membership.
    const edgeOverlap: CanvasDoc["nodes"][number] = { id: "edge-overlap", type: "text", text: "edge", x: 380, y: 100, width: 80, height: 40 };
    const doc: CanvasDoc = { nodes: [region, centered, edgeOverlap], edges: [] };

    const ids = containedNodeIds(doc, region);

    expect(ids).toEqual(["centered"]);
  });

  it("includes a nested region whose center lies inside the outer region", () => {
    const outer: GroupNode = { id: "outer", type: "group", label: "Outer", x: 0, y: 0, width: 600, height: 600 };
    const inner: GroupNode = { id: "inner", type: "group", label: "Inner", x: 100, y: 100, width: 200, height: 200 };
    const doc: CanvasDoc = { nodes: [outer, inner], edges: [] };

    expect(containedNodeIds(doc, outer)).toEqual(["inner"]);
  });

  it("never includes the region itself", () => {
    const region: GroupNode = { id: "self", type: "group", label: "Self", x: 0, y: 0, width: 200, height: 200 };
    const doc: CanvasDoc = { nodes: [region], edges: [] };

    expect(containedNodeIds(doc, region)).toEqual([]);
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
        ether: { region: { hold: true, instruction: "pulse me" } },
      }],
      edges: [],
    });

    setRegionDefaults("region", {
      herdr: { host: "local", session: null, workspaceId: "w1" },
      page: { url: "https://example.com", profile: "work" },
    });
    const withDefaults = state$.doc.peek().nodes[0];
    expect(withDefaults?.ether?.region?.hold).toBe(true);
    expect(withDefaults?.ether?.region?.instruction).toBe("pulse me");
    expect(withDefaults?.ether?.region?.defaults?.herdr?.host).toBe("local");
    expect(withDefaults?.ether?.region?.defaults?.page?.profile).toBe("work");

    setRegionDefaults("region", undefined);
    const cleared = state$.doc.peek().nodes[0];
    expect(cleared?.ether?.region).toEqual({ hold: true, instruction: "pulse me" });
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
