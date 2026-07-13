import { afterEach, describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { addNode, deleteNode, editFileDetails, editGroupBackground, editLink, editText, loadDoc, renameGroup, setNodeColor, setNodeView, toggleFlag } from "../src/renderer/lib/mutations";
import { addEdge, deleteEdges, editEdgeLabel, setEdgeColor, toggleEdgeArrow } from "../src/renderer/lib/edge-mutations";
import { findOpenPosition, resizeNode, syncPositions } from "../src/renderer/lib/geometry";
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

  it("creates schema-valid edges without explicit undefined side fields", () => {
    state$.canvasName.set("mutation-test");
    loadDoc(doc);
    addEdge({ source: "source", target: "target", kind: "blocks" });

    const edge = state$.doc.peek().edges[0];
    expect(edge).toMatchObject({ fromNode: "source", toNode: "target", ether: { kind: "blocks" } });
    expect(state$.selectedNodeId.peek()).toBe("");
    expect(state$.selectedEdgeId.peek()).toBe(edge?.id);
    expect(Object.hasOwn(edge ?? {}, "fromSide")).toBe(false);
    expect(Object.hasOwn(edge ?? {}, "toSide")).toBe(false);
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
    loadDoc({ ...doc, edges: [{ id: "edge-1", fromNode: "source", toNode: "target", ether: { kind: "relates" } }] });
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
});
