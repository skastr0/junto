import { describe, expect, it } from "vitest";
import { asNodeId, type Canvas, type Node } from "../src/shared/model";
import type { ItemId } from "../src/shared/work-ids";
import { candidatesOfNodes, resourceNodesInReach, withRegionDetail } from "../src/renderer/lib/mention-sources";

// Only the fields titleOf and reach read: kind, place, and the name fields.
const node = (id: string, kind: Node["kind"], x: number, y: number, extra: Record<string, unknown> = {}, size = 50): Node =>
  ({ id: asNodeId(id), kind, x, y, width: size, height: size, z: 0, ...extra }) as unknown as Node;

const canvasOf = (...nodes: ReadonlyArray<Node>): Pick<Canvas, "nodes"> => ({
  nodes: new Map(nodes.map((entry) => [entry.id, entry])),
});

const ITEM = "01M5ESSJRFWT6RVS5HMWMGJXGD" as ItemId;

// A holds seat S, task board T, page P; B (a sibling) holds page PB.
const canvas = canvasOf(
  node("A", "region", 0, 0, { label: "Product" }, 1000),
  node("B", "region", 2000, 0, { label: "Other" }, 1000),
  node("S", "agent", 10, 10, { label: "product-feed", agentKey: "claude" }),
  node("T", "task", 100, 10, { name: "Tabs" }),
  node("R", "artifacts", 200, 10, { label: "Docs" }),
  node("P", "page", 300, 10, { url: "https://example.com/a" }),
  node("PB", "page", 2100, 10, { url: "https://elsewhere.org" }),
  node("N", "note", 400, 10, { text: "hello" }),
  node("Q", "peer", 500, 10, { label: "remote", host: "mini" }),
);

describe("mention sources", () => {
  it("an agent is a seat @, a page an @ by its host, other nodes offer nothing", () => {
    const found = candidatesOfNodes(canvas, ["S", "P", "N", "Q"].map((id) => canvas.nodes.get(asNodeId(id))!));
    expect(found).toEqual([
      { ref: { kind: "seat", nodeId: "S" }, label: "@product-feed" },
      { ref: { kind: "page", nodeId: "P" }, label: "@example.com" },
    ]);
  });

  it("task boards and Artifacts nodes offer the items the composer gives, numbered first", () => {
    const found = candidatesOfNodes(
      canvas,
      [canvas.nodes.get(asNodeId("T"))!, canvas.nodes.get(asNodeId("R"))!],
      {
        tasksOf: () => [{ id: ITEM, title: "fix tabs", number: 42, note: "working" }],
        artifactsOf: () => [{ id: ITEM, title: "spec" }],
      },
    );
    expect(found).toEqual([
      { ref: { kind: "task", nodeId: "T", taskId: ITEM }, label: "#42 fix tabs", note: "working" },
      { ref: { kind: "artifact", nodeId: "R", artifactId: ITEM }, label: "#spec" },
    ]);
    expect(candidatesOfNodes(canvas, [canvas.nodes.get(asNodeId("T"))!])).toEqual([]);
  });

  it("resources in reach include pages in reach and leave out a sibling region's", () => {
    const ids = resourceNodesInReach(canvas, asNodeId("S")).map((entry) => entry.id);
    expect(ids).toContain("T");
    expect(ids).toContain("R");
    expect(ids).toContain("P");
    expect(ids).not.toContain("PB");
  });

  it("from a page, the tasks, artifacts and other pages in its reach, not itself and not a sibling region's", () => {
    const ids = resourceNodesInReach(canvas, asNodeId("P")).map((entry) => entry.id);
    expect(ids).toContain("T");
    expect(ids).toContain("R");
    expect(ids).not.toContain("P");
    expect(ids).not.toContain("PB");
    expect(ids).not.toContain("S");
  });

  it("two candidates with one label read apart by region path", () => {
    const twins = [
      { ref: { kind: "seat" as const, nodeId: asNodeId("S") }, label: "@x" },
      { ref: { kind: "seat" as const, nodeId: asNodeId("Q") }, label: "@x" },
      { ref: { kind: "seat" as const, nodeId: asNodeId("N") }, label: "@y" },
    ];
    const paths: Record<string, ReadonlyArray<string>> = { S: ["Product"], Q: ["Other", "Inner"], N: ["Product"] };
    expect(withRegionDetail(twins, (id) => paths[id] ?? []).map((entry) => entry.detail)).toEqual([
      "Product",
      "Other / Inner",
      undefined,
    ]);
  });
});
