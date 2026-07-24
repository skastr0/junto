import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  decodeCanvasDoc,
  resolveHerdrOnDelete,
  serializeCanvas,
  WELL_KNOWN_ENTITY_KINDS,
  type CanvasDoc,
} from "../src/shared/canvas";
import { isBlockableNode } from "../src/shared/execution-graph";

describe("herdr document model", () => {
  it("includes herdr in well-known entity kinds", () => {
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("herdr");
  });

  it("round-trips a herdr-bound text node", () => {
    const raw = {
      nodes: [
        {
          id: "h1",
          type: "text",
          text: "local · w11:pA",
          x: 10,
          y: 20,
          width: 260,
          height: 110,
          ether: {
            entity: { kind: "herdr" },
            herdr: {
              host: "local",
              session: null,
              workspaceId: "w11",
              tabId: "w11:t4",
              paneId: "w11:pA",
              terminalId: "term_abc",
              label: "grok",
            },
          },
        },
      ],
      edges: [],
    };
    const decoded1 = Either.getOrThrow(decodeCanvasDoc(raw));
    const serialized = serializeCanvas(decoded1);
    const decoded2 = Either.getOrThrow(decodeCanvasDoc(JSON.parse(serialized)));
    expect(decoded2).toEqual(decoded1);
    const node = decoded2.nodes[0]!;
    expect(node.type).toBe("text");
    expect(node.ether?.entity?.kind).toBe("herdr");
    expect(node.ether?.herdr?.host).toBe("local");
    expect(node.ether?.herdr?.paneId).toBe("w11:pA");
    expect(resolveHerdrOnDelete(node.ether?.herdr)).toBe("detach");
  });

  it("defaults onDelete to detach when omitted", () => {
    const raw = {
      nodes: [
        {
          id: "h2",
          type: "text",
          text: "herdr",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "herdr" },
            herdr: { host: "remote-a", paneId: "w1:p1" },
          },
        },
      ],
      edges: [],
    };
    const doc = Either.getOrThrow(decodeCanvasDoc(raw));
    expect(doc.nodes[0]?.ether?.herdr?.onDelete).toBeUndefined();
    expect(resolveHerdrOnDelete(doc.nodes[0]?.ether?.herdr)).toBe("detach");
  });

  it("accepts onDelete kill-pane when set", () => {
    const raw = {
      nodes: [
        {
          id: "h3",
          type: "text",
          text: "scratch",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "herdr" },
            herdr: { host: "local", paneId: "w1:p2", onDelete: "kill-pane" },
          },
        },
      ],
      edges: [],
    };
    const doc = Either.getOrThrow(decodeCanvasDoc(raw));
    expect(resolveHerdrOnDelete(doc.nodes[0]?.ether?.herdr)).toBe("kill-pane");
  });

  it("stripping ether leaves valid JSON Canvas 1.0", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "h1",
          type: "text",
          text: "herdr card",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          ether: {
            entity: { kind: "herdr" },
            herdr: { host: "local", paneId: "w1:p1" },
          },
        },
      ],
      edges: [],
    };
    const stripped = {
      nodes: doc.nodes.map(({ ether: _e, ...rest }) => rest),
      edges: doc.edges,
    };
    const redecoded = Either.getOrThrow(decodeCanvasDoc(stripped));
    expect(redecoded.nodes[0]?.type).toBe("text");
    expect(redecoded.nodes[0]?.ether).toBeUndefined();
  });

  it("phase membership follows physics roles (actors yes, sinks no)", () => {
    // Herdr binding shape is kind-specific; membership itself is role-level.
    const actorSeat = {
      id: "actor1",
      type: "text" as const,
      text: "actor",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "herdr" },
        herdr: { host: "local", paneId: "w1:p1" },
      },
    };
    const sinkSeat = {
      id: "sink1",
      type: "text" as const,
      text: "sink",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      ether: { entity: { kind: "task" } },
    };
    expect(isBlockableNode(actorSeat)).toBe(true);
    expect(isBlockableNode(sinkSeat)).toBe(false);
  });
});
