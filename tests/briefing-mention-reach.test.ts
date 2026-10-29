import { describe, expect, it } from "vitest";
import { artifactLink } from "../src/shared/artifact-link";
import { briefingLinksOf } from "../src/shared/briefing-mentions";
import { mentionLink, type MentionOf } from "../src/shared/mention";
import { briefingMentionableNodes } from "../src/shared/mention-reach";
import { mintItemId } from "../src/shared/resource-command";
import { candidatesOfNodes } from "../src/renderer/lib/mention-sources";
import * as model from "./support/model-nodes";
import { asNodeId } from "../src/shared/model";
import type { NodeKind } from "../src/shared/model/kinds";
import { asWireId, type Wire } from "../src/shared/model/wire";
import type { ReachNode } from "../src/shared/region-reach";

const node = (id: string, kind: NodeKind, x: number, y: number, width = 50, height = 50): ReachNode => ({
  id: asNodeId(id),
  kind,
  x,
  y,
  width,
  height,
});

const wire = (from: string, to: string): Wire => ({ id: asWireId(`${from}-${to}`), from: asNodeId(from), to: asNodeId(to), verb: "messages" });

// root: loose seat L, page P0
// A                       B (sibling of A)
// ├─ A1: S1, T1, note N1  └─ SB, TB, PB
// │  └─ A1a: D1a
// └─ SA, TA
// S1 is wired to SB and to PB.
const nodes = [
  node("L", "agent", -500, -500),
  node("P0", "page", -400, -500),
  node("A", "region", 0, 0, 1000, 1000),
  node("SA", "agent", 100, 800),
  node("TA", "task", 200, 800),
  node("A1", "region", 10, 10, 400, 400),
  node("S1", "agent", 20, 20),
  node("T1", "task", 100, 20),
  node("N1", "note", 200, 20),
  node("A1a", "region", 20, 200, 150, 150),
  node("D1a", "artifacts", 30, 210),
  node("B", "region", 2000, 0, 500, 500),
  node("SB", "agent", 2010, 10),
  node("TB", "task", 2100, 10),
  node("PB", "page", 2200, 10),
];
const canvas = {
  nodes: new Map(nodes.map((n) => [n.id, n])),
  wires: new Map([wire("S1", "SB"), wire("PB", "S1")].map((w) => [w.id, w])),
};
const ids = (regionId?: string): ReadonlyArray<string> =>
  briefingMentionableNodes(canvas, regionId === undefined ? undefined : asNodeId(regionId)).map((n) => n.id);

describe("briefingMentionableNodes", () => {
  it("offers the app's texts every node a mention can name, and nothing else", () => {
    expect(ids()).toEqual(["D1a", "L", "P0", "PB", "S1", "SA", "SB", "T1", "TA", "TB"]);
  });

  it("offers a region's texts its reach: its own, below, above and the root, never a sibling", () => {
    expect(ids("A1")).toEqual(expect.arrayContaining(["S1", "T1", "D1a", "SA", "TA", "L", "P0"]));
    expect(ids("A1")).not.toContain("TB");
    expect(ids("A1")).not.toContain("N1");
  });

  it("adds what a seat of the region is wired to, either way round", () => {
    expect(ids("A1")).toEqual(expect.arrayContaining(["SB", "PB"]));
    // SB sits in B, so B reaches S1 by the same wire; SA in A does not have one.
    expect(ids("B")).toEqual(expect.arrayContaining(["S1"]));
  });

  it("offers nothing for an id that is not a region", () => {
    expect(ids("S1")).toEqual([]);
    expect(ids("gone")).toEqual([]);
  });
});

describe("what a briefing's picker writes", () => {
  it("reads back as onboard parses it: an item only on a board or an Artifacts node", () => {
    const taskId = mintItemId();
    const artifactId = mintItemId();
    // The same places, as whole nodes, so each candidate has its title.
    const at = (id: string) => {
      const n = canvas.nodes.get(asNodeId(id))!;
      return { x: n.x, y: n.y, width: n.width, height: n.height };
    };
    const full = model.canvasOf([
      ...["L", "SA", "S1", "SB"].map((id) => model.seat(id, at(id))),
      ...["TA", "T1", "TB"].map((id) => model.taskBoard(id, at(id))),
      model.artifacts("D1a", at("D1a")),
      ...["P0", "PB"].map((id) => model.page(id, at(id))),
    ]);
    const candidates = candidatesOfNodes(full, briefingMentionableNodes(canvas), {
      tasksOf: (id) => (id === "T1" ? [{ id: taskId, title: "fix tabs", number: 42 }] : []),
      artifactsOf: (id) => (id === "D1a" ? [{ id: artifactId, title: "Launch plan" }] : []),
    });
    const linked: MentionOf<"artifact"> = { kind: "artifact", nodeId: asNodeId("D1a"), artifactId };
    const text = [...candidates.map((c) => mentionLink(c.ref, c.label, "factory")), artifactLink(linked, "Launch plan", "factory"), "https://example.com"].join(" ");
    const read = briefingLinksOf(text).map((link) => [link.target.nodeId, link.target.item ?? null]);
    expect(read).toEqual(
      expect.arrayContaining([
        ["T1", taskId],
        ["D1a", artifactId],
        ["S1", null],
        ["PB", null],
      ]),
    );
    // Seats and pages never carry an item; the plain link is text.
    for (const [nodeId, item] of read) if (!["T1", "D1a"].includes(nodeId as string)) expect(item).toBeNull();
    expect(read.some(([nodeId]) => String(nodeId).includes("example"))).toBe(false);
  });
});
