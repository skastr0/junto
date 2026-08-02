import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  decodeCanvasDoc,
  resolveBrowserOnDelete,
  serializeCanvas,
  WELL_KNOWN_ENTITY_KINDS,
  type CanvasDoc,
} from "../src/shared/canvas";
import { isBlockableNode } from "../src/shared/execution-graph";
import { makePageNode } from "../src/renderer/lib/node-factories";

describe("browser page document model", () => {
  it("includes page in well-known entity kinds", () => {
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("page");
  });

  it("round-trips a page-bound link node", () => {
    const raw = {
      nodes: [
        {
          id: "p1",
          type: "link",
          url: "https://docs.example.com/guide",
          x: 10,
          y: 20,
          width: 260,
          height: 110,
          ether: {
            entity: { kind: "page" },
            browser: {
              profile: "work",
            },
          },
        },
      ],
      edges: [],
    };
    const decoded1 = Result.getOrThrow(decodeCanvasDoc(raw));
    const serialized = serializeCanvas(decoded1);
    const decoded2 = Result.getOrThrow(decodeCanvasDoc(JSON.parse(serialized)));
    expect(decoded2).toEqual(decoded1);
    const node = decoded2.nodes[0]!;
    expect(node.type).toBe("link");
    if (node.type !== "link") throw new Error("expected link");
    expect(node.url).toBe("https://docs.example.com/guide");
    expect(node.ether?.entity?.kind).toBe("page");
    expect(node.ether?.browser?.profile).toBe("work");
    expect(resolveBrowserOnDelete(node.ether?.browser)).toBe("kill-session");
  });

  it("defaults onDelete to kill-session when omitted", () => {
    const raw = {
      nodes: [
        {
          id: "p2",
          type: "link",
          url: "https://example.com",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "page" },
            browser: { profile: "personal" },
          },
        },
      ],
      edges: [],
    };
    const doc = Result.getOrThrow(decodeCanvasDoc(raw));
    expect(doc.nodes[0]?.ether?.browser?.onDelete).toBeUndefined();
    expect(resolveBrowserOnDelete(doc.nodes[0]?.ether?.browser)).toBe(
      "kill-session",
    );
  });

  it("accepts onDelete kill-session when set", () => {
    const raw = {
      nodes: [
        {
          id: "p3",
          type: "link",
          url: "https://example.com/scratch",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "page" },
            browser: { profile: "personal", onDelete: "kill-session" },
          },
        },
      ],
      edges: [],
    };
    const doc = Result.getOrThrow(decodeCanvasDoc(raw));
    expect(resolveBrowserOnDelete(doc.nodes[0]?.ether?.browser)).toBe("kill-session");
  });

  it("stripping ether leaves valid JSON Canvas 1.0 link", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "p1",
          type: "link",
          url: "https://example.com",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          ether: {
            entity: { kind: "page" },
            browser: { profile: "work" },
          },
        },
      ],
      edges: [],
    };
    const stripped = {
      nodes: doc.nodes.map(({ ether: _e, ...rest }) => rest),
      edges: doc.edges,
    };
    const redecoded = Result.getOrThrow(decodeCanvasDoc(stripped));
    expect(redecoded.nodes[0]?.type).toBe("link");
    expect(redecoded.nodes[0]?.ether).toBeUndefined();
  });

  it("sink seats (incl. page registry kind) are not phase-blockable", () => {
    const sinkSeat = {
      id: "p1",
      type: "link" as const,
      url: "https://example.com",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "page" },
        browser: { profile: "personal" },
      },
    };
    expect(isBlockableNode(sinkSeat)).toBe(false);
  });

  it("makePageNode stamps kind page, profile, and kill-session", () => {
    const node = makePageNode(12.4, 8.9, "https://example.com/a");
    expect(node.type).toBe("link");
    expect(node.url).toBe("https://example.com/a");
    expect(node.x).toBe(12);
    expect(node.y).toBe(9);
    expect(node.ether?.entity?.kind).toBe("page");
    expect(node.ether?.browser?.profile).toBe("personal");
    expect(node.ether?.browser?.onDelete).toBe("kill-session");
    expect(node.ether?.host).toBe("local");
  });

  it("makePageNode accepts profile and onDelete override", () => {
    const node = makePageNode(0, 0, "https://example.com", {
      profile: "work",
      onDelete: "detach",
    }, "studio");
    expect(node.ether?.browser?.profile).toBe("work");
    expect(node.ether?.browser?.onDelete).toBe("detach");
    expect(node.ether?.host).toBe("studio");
  });
});
