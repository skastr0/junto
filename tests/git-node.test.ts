import { newGit, newNote } from "../src/renderer/lib/model-factories";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { Node, NODE_KINDS } from "../src/shared/model";
import { resolveSpec, roleOf } from "../src/shared/physics";
import { toFlowOfCanvas } from "../src/renderer/lib/convert";
import { targetPlanOn } from "../src/renderer/lib/edge-mutations";
import { canvasOf, seat } from "./support/model-nodes";
import { nodeSurfaceKind } from "../src/renderer/lib/activate-node-surface";
import { DEFAULT_NODE_CATALOG_ENTRIES } from "../src/renderer/components/node-palette/NodeCatalogGrid";

const emptyContext = {
  canvasName: "test",
  resolveActorRef: () => undefined,
  itemsOf: () => [],
};

describe("git geography node", () => {
  it("is a well-known entity kind but geography role (not physics KindSpecs)", () => {
    expect(NODE_KINDS).toContain("git");
    const role = roleOf(resolveSpec({ isGroup: false, kind: "git" }));
    expect(role).toBe("geography");
  });

  it("newGit makes a git node with its folder", () => {
    const node = newGit({ x: 12, y: 34, z: 0 }, "/tmp/repo");
    expect(node.kind).toBe("git");
    expect(node.cwd).toBe("/tmp/repo");
    expect(node.id.startsWith("git-")).toBe(true);
    expect(node).not.toHaveProperty("items");
    expect(node).not.toHaveProperty("host");
  });

  it("decodes a git node in its own schema", () => {
    const node = newGit({ x: 0, y: 0, z: 0 }, "/Users/me/proj");
    expect(Schema.decodeUnknownSync(Node)(node)).toEqual(node);
  });

  it("toFlow marks git non-connectable", () => {
    const git = newGit({ x: 0, y: 0, z: 0 }, "/tmp/repo");
    const note = newNote({ x: 100, y: 0, z: 1 });
    const { nodes } = toFlowOfCanvas(canvasOf([git, note]), emptyContext);
    expect(nodes.find((n) => n.id === git.id)?.connectable).toBe(false);
    expect(nodes.find((n) => n.id === note.id)?.connectable).toBe(true);
  });

  it("a batch connect refuses git as source or target", () => {
    const git = newGit({ x: 0, y: 0, z: 0 }, "/tmp/repo");
    const canvas = canvasOf([git, seat("a")]);
    const asTarget = targetPlanOn(canvas, ["a"], git.id);
    expect(asTarget.toAdd).toEqual([]);
    expect(asTarget.skipped).toEqual([{ source: "a", reason: "invalid-target" }]);
    const asSource = targetPlanOn(canvas, [git.id], "a");
    expect(asSource.toAdd).toEqual([]);
    expect(asSource.skipped[0]?.reason).toBe("label-source");
  });

  it("opens the work surface", () => {
    expect(nodeSurfaceKind(newGit({ x: 0, y: 0, z: 0 }, "/tmp/repo"))).toBe("work");
  });

  it("sits in the work catalog", () => {
    const entry = DEFAULT_NODE_CATALOG_ENTRIES.find((c) => c.id === "git");
    expect(entry?.category).toBe("sinks");
    expect(entry?.label).toBe("Git");
  });
});
