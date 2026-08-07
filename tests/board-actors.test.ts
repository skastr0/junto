import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  composeBoardTagEnvelope,
  filterTagsToConnected,
  normalizeBoardTags,
  postTagsActor,
  resolveBoardConnectedActors,
  tagNotifyNodeIds,
} from "../src/shared/board-actors";

const doc = (
  partial: Partial<CanvasDoc> & Pick<CanvasDoc, "nodes" | "edges">,
): CanvasDoc => ({
  nodes: partial.nodes,
  edges: partial.edges,
});

describe("resolveBoardConnectedActors", () => {
  it("lists connected actors with wake default ON", () => {
    const canvas = doc({
      nodes: [
        {
          id: "board-1",
          type: "text",
          text: "board",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: { entity: { kind: "board" } },
        },
        {
          id: "agent-a",
          type: "text",
          text: "Alpha",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:alpha" },
            terminal: { bindingId: "b-a", harness: "claude" },
          },
        },
        {
          id: "agent-b",
          type: "text",
          text: "Beta",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:beta" },
            terminal: { bindingId: "b-b", harness: "claude" },
          },
        },
        {
          id: "note",
          type: "text",
          text: "furniture",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
        },
      ],
      edges: [
        { id: "e1", fromNode: "agent-a", toNode: "board-1" },
        {
          id: "e2",
          fromNode: "agent-b",
          toNode: "board-1",
          ether: { wake: false },
        },
        { id: "e3", fromNode: "note", toNode: "board-1" },
      ],
    });
    const actors = resolveBoardConnectedActors(canvas, "board-1");
    expect(actors.map((a) => a.nodeId)).toEqual(["agent-a", "agent-b"]);
    expect(actors.find((a) => a.nodeId === "agent-a")?.wake).toBe(true);
    expect(actors.find((a) => a.nodeId === "agent-b")?.wake).toBe(false);
    expect(actors.find((a) => a.nodeId === "agent-a")?.agentKey).toBe(
      "local:alpha",
    );
  });
});

describe("board tags", () => {
  it("normalizes and filters to connected actors", () => {
    expect(normalizeBoardTags(["  a ", "a", "", "b"])).toEqual(["a", "b"]);
    const actors = [
      { nodeId: "a", label: "A", wake: true },
      { nodeId: "b", label: "B", wake: false },
    ];
    expect(filterTagsToConnected(["a", "ghost", "b"], actors)).toEqual([
      "a",
      "b",
    ]);
    expect(tagNotifyNodeIds(["a", "b"], actors, "a")).toEqual([]);
    expect(tagNotifyNodeIds(["a", "b"], actors)).toEqual(["a"]);
    expect(postTagsActor(["a", "b"], "b")).toBe(true);
    expect(postTagsActor(["a"], "b")).toBe(false);
  });

  it("composes soft async tag envelope without middot", () => {
    const line = composeBoardTagEnvelope({
      topicTitle: "Collab",
      authorLabel: "alpha",
      excerptSource: "please review",
    });
    expect(line).toContain("board-tag");
    expect(line).toContain("no reply required");
    expect(line).toContain("alpha");
    expect(line.includes("\u00b7")).toBe(false);
  });
});
