import { describe, expect, it } from "vitest";
import { HashMap, HashSet } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import { canvasFromDocument } from "../../src/shared/model/from-document";
import {
  canvasDocToCapabilityView,
  canvasToCapabilityView,
  type VerbCapabilityView,
} from "../../src/shared/physics/view";

// The view built from a canvas answers what the view built from the document
// that canvas came from answers.

type DocNode = CanvasDoc["nodes"][number];

const at = (x: number, y: number) => ({ x, y, width: 120, height: 48 });

const seat = (id: string, x: number, y: number, host?: string): DocNode => ({
  id,
  type: "text",
  text: id,
  ...at(x, y),
  ether: {
    entity: { kind: "agent", name: `${host ?? "local"}:${id}` },
    terminal: { bindingId: `binding-${id}`, harness: "claude" },
    ...(host === undefined ? {} : { host }),
  },
});

const sink = (id: string, kind: string, x: number, y: number): DocNode => ({
  id,
  type: "text",
  text: id,
  ...at(x, y),
  ether: { entity: { kind } },
});

const doc: CanvasDoc = {
  nodes: [
    { id: "outer", type: "group", label: "outer", x: -50, y: -50, width: 900, height: 400, ether: { region: { hold: true } } },
    { id: "inner", type: "group", label: "inner", x: -20, y: -20, width: 420, height: 200, ether: { region: { hold: true } } },
    seat("lead", 0, 0),
    seat("builder", 200, 0),
    seat("remote", 500, 0, "box-a"),
    sink("tasks", "task", 0, 100),
    sink("files", "artifacts", 200, 100),
    sink("news", "board", 500, 100),
    { id: "page", type: "link", url: "https://example.com/", ...at(500, 200), ether: { entity: { kind: "page" }, browser: { profile: "personal" } } },
    { id: "note", type: "text", text: "a note", ...at(700, 200) },
    seat("outside", 2000, 2000),
  ],
  edges: [
    { id: "e1", fromNode: "lead", toNode: "builder", ether: { verb: "messages" } },
    { id: "e2", fromNode: "tasks", toNode: "builder", ether: { verb: "works" } },
    { id: "e3", fromNode: "lead", toNode: "tasks", ether: { verb: "manages" } },
    { id: "e4", fromNode: "lead", toNode: "builder", ether: { verb: "reviews" } },
    { id: "e5", fromNode: "remote", toNode: "news", ether: { verb: "participates" } },
    { id: "e6", fromNode: "remote", toNode: "page", ether: { verb: "navigates" } },
    { id: "e7", fromNode: "builder", toNode: "lead", ether: { verb: "messages" } },
    { id: "e8", fromNode: "outside", toNode: "lead", ether: { verb: "messages" } },
    { id: "e9", fromNode: "builder", toNode: "files", ether: { verb: "publishes" } },
  ],
} as unknown as CanvasDoc;

const sets = <V>(map: HashMap.HashMap<string, HashSet.HashSet<V>>) =>
  Object.fromEntries(
    [...HashMap.entries(map)]
      .map(([key, set]) => [key, [...set].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

const plain = (view: VerbCapabilityView) => ({
  nodeMeta: Object.fromEntries([...HashMap.entries(view.nodeMeta)].sort(([a], [b]) => a.localeCompare(b))),
  connected: sets(view.connected),
  regionPeers: sets(view.regionPeers),
  edgePortMask: sets(view.edgePortMask),
  directedEdgePortMask: sets(view.directedEdgePortMask ?? HashMap.empty()),
  claimable: [...view.claimable].sort(),
  placement: Object.fromEntries(
    [...HashMap.entries(view.placement ?? HashMap.empty())]
      .map(([key, value]) => [key, JSON.parse(JSON.stringify(value))] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  ),
});

describe("the capability view of a canvas", () => {
  it("is the view of the document the canvas came from", () => {
    const fromDocument = plain(canvasDocToCapabilityView(doc));
    const fromCanvas = plain(canvasToCapabilityView(canvasFromDocument("factory", doc)));
    expect(fromCanvas).toEqual(fromDocument);
    expect(Object.values(fromCanvas.edgePortMask).every((ports) => ports.length > 0)).toBe(true);
    expect(fromCanvas.claimable).toHaveLength(1);
    expect(fromCanvas.regionPeers["lead"]).toContain("remote");
    expect(fromCanvas.regionPeers["outside"]).toBeUndefined();
  });
});
