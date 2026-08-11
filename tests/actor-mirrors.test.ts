import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, TextNode } from "../src/shared/canvas";
import {
  actorRingOf,
  isMirrorablePeer,
  mirrorPeerIds,
  nextInRing,
  resolveRing,
} from "../src/renderer/lib/actor-mirrors";

const agent = (id: string, label: string): TextNode => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId: `local:${id}`, harness: "codex" },
  },
});

/** Actor by kind, but no native terminal binding — not swappable. */
const unboundAgent = (id: string, label: string): TextNode => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "agent", name: `local:${id}` } },
});

const shell = (id: string): TextNode => ({
  id,
  type: "text",
  text: "shell",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "terminal" },
    terminal: { bindingId: `shell:${id}` },
  },
});

const tasks = (id: string): TextNode => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "task" }, tasks: { items: [] } },
});

const edge = (id: string, from: string, to: string): CanvasEdge => ({
  id,
  fromNode: from,
  toNode: to,
});

const docOf = (
  nodes: readonly TextNode[],
  edges: readonly CanvasEdge[],
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });

/** Hub-and-spoke: hub wired to three actor peers that are not wired to each other. */
const hubDoc = docOf(
  [
    agent("hub", "Alpha hub"),
    agent("bravo", "Bravo"),
    agent("charlie", "Charlie"),
    agent("delta", "Delta"),
  ],
  [
    edge("e-b", "hub", "bravo"),
    edge("e-c", "hub", "charlie"),
    edge("e-d", "delta", "hub"),
  ],
);

describe("isMirrorablePeer", () => {
  it("accepts only actors with a native terminal binding", () => {
    expect(isMirrorablePeer(agent("a", "A"))).toBe(true);
    expect(isMirrorablePeer(unboundAgent("u", "U"))).toBe(false);
    expect(isMirrorablePeer(shell("s"))).toBe(false);
    expect(isMirrorablePeer(tasks("t"))).toBe(false);
    expect(isMirrorablePeer(undefined)).toBe(false);
  });
});

describe("mirrorPeerIds", () => {
  it("keeps rail order (peer title) across both edge directions", () => {
    expect(mirrorPeerIds(hubDoc, "hub")).toEqual(["bravo", "charlie", "delta"]);
  });

  it("dedupes multiple edges to the same peer", () => {
    const doc = docOf(
      [agent("hub", "Hub"), agent("bravo", "Bravo")],
      [
        edge("e-1", "hub", "bravo"),
        edge("e-2", "bravo", "hub"),
        edge("e-3", "hub", "bravo"),
      ],
    );
    expect(mirrorPeerIds(doc, "hub")).toEqual(["bravo"]);
  });

  it("excludes shells, sinks, and unbound actors", () => {
    const doc = docOf(
      [
        agent("hub", "Hub"),
        agent("bravo", "Bravo"),
        shell("sh"),
        tasks("tk"),
        unboundAgent("ub", "Unbound"),
      ],
      [
        edge("e-1", "hub", "bravo"),
        edge("e-2", "hub", "sh"),
        edge("e-3", "tk", "hub"),
        edge("e-4", "hub", "ub"),
      ],
    );
    expect(mirrorPeerIds(doc, "hub")).toEqual(["bravo"]);
  });

  it("is empty for a non-actor node", () => {
    const doc = docOf(
      [shell("sh"), agent("bravo", "Bravo")],
      [edge("e-1", "sh", "bravo")],
    );
    expect(mirrorPeerIds(doc, "sh")).toEqual([]);
  });
});

describe("actorRingOf", () => {
  it("puts the anchor first, then peers in rail order", () => {
    expect(actorRingOf(hubDoc, "hub")?.memberIds).toEqual([
      "hub",
      "bravo",
      "charlie",
      "delta",
    ]);
  });

  it("is null when the anchor has no mirrorable peers", () => {
    const doc = docOf(
      [agent("solo", "Solo"), tasks("tk")],
      [edge("e-1", "solo", "tk")],
    );
    expect(actorRingOf(doc, "solo")).toBeNull();
  });

  it("is null for a missing or non-actor anchor", () => {
    expect(actorRingOf(hubDoc, "ghost")).toBeNull();
    const doc = docOf(
      [shell("sh"), agent("bravo", "Bravo")],
      [edge("e-1", "sh", "bravo")],
    );
    expect(actorRingOf(doc, "sh")).toBeNull();
  });
});

describe("resolveRing (sticky anchor)", () => {
  it("keeps the standing ring while the current node is inside it", () => {
    // Standing at a spoke, ring still spans every spoke of the hub.
    const ring = resolveRing(hubDoc, "bravo", "hub");
    expect(ring?.anchorId).toBe("hub");
    expect(ring?.memberIds).toEqual(["hub", "bravo", "charlie", "delta"]);
  });

  it("re-anchors at the current node when outside the standing ring", () => {
    const doc = docOf(
      [
        agent("hub", "Hub"),
        agent("bravo", "Bravo"),
        agent("east", "East"),
        agent("west", "West"),
      ],
      [edge("e-1", "hub", "bravo"), edge("e-2", "east", "west")],
    );
    const ring = resolveRing(doc, "east", "hub");
    expect(ring?.anchorId).toBe("east");
    expect(ring?.memberIds).toEqual(["east", "west"]);
  });

  it("re-anchors when the standing anchor lost its edge to the current node", () => {
    // Anchor ring no longer contains charlie (edge removed) — charlie anchors.
    const doc = docOf(
      [agent("hub", "Hub"), agent("bravo", "Bravo"), agent("charlie", "Charlie")],
      [edge("e-1", "hub", "bravo"), edge("e-2", "bravo", "charlie")],
    );
    const ring = resolveRing(doc, "charlie", "hub");
    expect(ring?.anchorId).toBe("charlie");
    expect(ring?.memberIds).toEqual(["charlie", "bravo"]);
  });

  it("falls back to the current node with no standing anchor", () => {
    const ring = resolveRing(hubDoc, "hub", null);
    expect(ring?.anchorId).toBe("hub");
  });
});

describe("nextInRing", () => {
  const members = ["hub", "bravo", "charlie", "delta"] as const;

  it("wraps forward and backward", () => {
    expect(nextInRing(members, "hub", 1)).toBe("bravo");
    expect(nextInRing(members, "delta", 1)).toBe("hub");
    expect(nextInRing(members, "hub", -1)).toBe("delta");
    expect(nextInRing(members, "bravo", -1)).toBe("hub");
  });

  it("is null when the current node is not a member", () => {
    expect(nextInRing(members, "ghost", 1)).toBeNull();
  });

  it("is null on degenerate rings", () => {
    expect(nextInRing(["hub"], "hub", 1)).toBeNull();
    expect(nextInRing([], "hub", 1)).toBeNull();
  });
});
