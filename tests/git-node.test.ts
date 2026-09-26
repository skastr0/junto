import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CanvasDoc, WELL_KNOWN_ENTITY_KINDS } from "../src/shared/canvas";
import { resolveSpec, roleOf } from "../src/shared/physics";
import { toFlow } from "../src/renderer/lib/convert";
import { makeGitNode, makeTextNode } from "../src/renderer/lib/node-factories";
import { isGitNode } from "../src/renderer/lib/presentation";
import { planConnectToTarget } from "../src/renderer/lib/edge-mutations";
import { nodeSurfaceKind } from "../src/renderer/lib/activate-node-surface";
import { DEFAULT_NODE_CATALOG_ENTRIES } from "../src/renderer/components/node-palette/NodeCatalogGrid";

const emptyContext = {
  canvasName: "test",
  resolveActorRef: () => undefined,
};

describe("git geography node", () => {
  it("is a well-known entity kind but geography role (not physics KindSpecs)", () => {
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("git");
    const role = roleOf(resolveSpec({ isGroup: false, kind: "git" }));
    expect(role).toBe("geography");
  });

  it("makeGitNode stamps entity.kind git with cwd", () => {
    const node = makeGitNode(12, 34, "/tmp/repo");
    expect(isGitNode(node)).toBe(true);
    expect(node.type).toBe("text");
    expect(node.text).toBe("git");
    expect(node.ether?.entity?.kind).toBe("git");
    expect(node.ether?.git?.cwd).toBe("/tmp/repo");
    expect(node.id.startsWith("git-")).toBe(true);
    expect(node.ether?.tasks).toBeUndefined();
    expect(node.ether?.host).toBeUndefined();
  });

  it("decodes a git node in CanvasDoc", () => {
    const node = makeGitNode(0, 0, "/Users/me/proj");
    const decoded = Schema.decodeUnknownSync(CanvasDoc)({
      nodes: [node],
      edges: [],
    });
    expect(decoded.nodes[0]?.ether?.git?.cwd).toBe("/Users/me/proj");
  });

  it("toFlow marks git non-connectable", () => {
    const git = makeGitNode(0, 0, "/tmp/repo");
    const note = makeTextNode(100, 0);
    const { nodes } = toFlow({ nodes: [git, note], edges: [] }, emptyContext);
    expect(nodes.find((n) => n.id === git.id)?.connectable).toBe(false);
    expect(nodes.find((n) => n.id === note.id)?.connectable).toBe(true);
  });

  it("planConnectToTarget refuses git as source or target", () => {
    const git = makeGitNode(0, 0, "/tmp/repo");
    const a = { ...makeTextNode(10, 10), id: "a" };
    const nodes = [git, a];
    const asTarget = planConnectToTarget(["a"], git.id, nodes, []);
    expect(asTarget.toAdd).toEqual([]);
    expect(asTarget.skipped).toEqual([{ source: "a", reason: "invalid-target" }]);
    const asSource = planConnectToTarget([git.id], "a", nodes, []);
    expect(asSource.toAdd).toEqual([]);
    expect(asSource.skipped[0]?.reason).toBe("label-source");
  });

  it("opens the work surface", () => {
    expect(nodeSurfaceKind(makeGitNode(0, 0, "/tmp/repo"))).toBe("work");
  });

  it("sits in the work catalog", () => {
    const entry = DEFAULT_NODE_CATALOG_ENTRIES.find((c) => c.id === "git");
    expect(entry?.category).toBe("sinks");
    expect(entry?.label).toBe("Git");
  });
});
