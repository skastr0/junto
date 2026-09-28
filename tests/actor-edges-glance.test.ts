import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, TextNode } from "../src/shared/canvas";
import type { Verb } from "../src/shared/physics";
import {
  actorEdgePhaseLabel,
  actorEdgeRows,
} from "../src/renderer/lib/actor-edges";

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

const note = (id: string, text: string): TextNode => ({
  id,
  type: "text",
  text,
  x: 0,
  y: 0,
  width: 160,
  height: 60,
});

const edge = (
  id: string,
  from: string,
  to: string,
  verb?: Verb,
): CanvasEdge =>
  verb === undefined
    ? { id, fromNode: from, toNode: to }
    : { id, fromNode: from, toNode: to, ether: { verb } };

const docOf = (
  nodes: TextNode[],
  edges: CanvasEdge[],
): CanvasDoc => ({ nodes, edges });

describe("actorEdgeRows", () => {
  it("returns empty for non-actor nodes", () => {
    const doc = docOf(
      [note("m", "memo"), note("n", "hi")],
      [edge("e", "m", "n")],
    );
    expect(actorEdgeRows(doc, "m")).toEqual([]);
    expect(actorEdgeRows(doc, "missing")).toEqual([]);
  });

  it("lists directed incident edges with peer kind — no soft nature", () => {
    const doc = docOf(
      [
        agent("worker", "Grok"),
        agent("lead", "Claude"),
        agent("helper", "Codex"),
        note("memo", "note"),
      ],
      [
        edge("e-in", "lead", "worker", "messages"),
        edge("e-out", "worker", "helper", "messages"),
        edge("e-note", "worker", "memo"),
      ],
    );
    const rows = actorEdgeRows(doc, "worker");
    expect(rows.map((r) => r.edgeId).sort()).toEqual([
      "e-in",
      "e-note",
      "e-out",
    ]);

    const inRow = rows.find((r) => r.edgeId === "e-in")!;
    expect(inRow.direction).toBe("in");
    expect(inRow.peerKind).toBe("agent");
    expect(inRow.peerId).toBe("lead");
    expect(actorEdgePhaseLabel(inRow)).toBeNull();

    const outRow = rows.find((r) => r.edgeId === "e-out")!;
    expect(outRow.direction).toBe("out");
    expect(outRow.peerKind).toBe("agent");
    expect(outRow.peerId).toBe("helper");

    const noteRow = rows.find((r) => r.edgeId === "e-note")!;
    expect(noteRow.direction).toBe("out");
    expect(noteRow.peerKind).toBe("text");
  });
});
