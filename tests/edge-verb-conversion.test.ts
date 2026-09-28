import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  decodeCanvasDoc,
  scrubCanvasDocInput,
  serializeCanvas,
} from "../src/shared/canvas";

// The one-shot legacy conversion. A document written in the old wire areas —
// ports, wake, notify, stops, and the phase mirror — comes back
// carrying nothing but the verb it always meant, stored in that verb's own
// order. There is no dual model to fall back to: what the grammar cannot hold
// does not survive the load.

type RawNode = {
  readonly id: string;
  readonly kind?: string;
  readonly x?: number;
};

const node = ({ id, kind, x = 0 }: RawNode) => ({
  id,
  type: "text",
  text: id,
  x,
  y: 0,
  width: 200,
  height: 80,
  ...(kind === undefined ? {} : { ether: { entity: { kind } } }),
});

const legacyDoc = (edges: ReadonlyArray<unknown>) => ({
  nodes: [
    node({ id: "seat", kind: "agent" }),
    node({ id: "peer", kind: "agent", x: 200 }),
    node({ id: "docs", kind: "page", x: 400 }),
    node({ id: "tty", kind: "terminal", x: 600 }),
    node({ id: "note", x: 800 }),
  ],
  edges,
});

/** Decode the legacy shape and index the surviving edges by id. */
const converted = (edges: ReadonlyArray<unknown>) => {
  const doc = Result.getOrThrow(decodeCanvasDoc(legacyDoc(edges)));
  return new Map(doc.edges.map((edge) => [edge.id, edge] as const));
};

describe("legacy edge conversion", () => {
  it("names the verb from the pair alone where the pair only holds one", () => {
    const edges = converted([
      { id: "mail", fromNode: "seat", toNode: "peer", ether: { ports: ["msg.send"] } },
      { id: "browse", fromNode: "seat", toNode: "docs", ether: { ports: ["browser.automate"] } },
    ]);

    expect(edges.get("mail")?.ether).toEqual({ verb: "messages" });
    expect(edges.get("browse")?.ether).toEqual({ verb: "navigates" });
  });

  it("converts an access wire drawn either way into the agent-first verb", () => {
    const edges = converted([
      { id: "drawn-out", fromNode: "seat", toNode: "docs", ether: { ports: ["browser.automate"] } },
      { id: "drawn-in", fromNode: "docs", toNode: "seat", ether: { ports: ["browser.automate"] } },
    ]);

    const out = edges.get("drawn-out");
    expect(out?.ether).toEqual({ verb: "navigates" });
    expect([out?.fromNode, out?.toNode]).toEqual(["seat", "docs"]);

    // Drawn page→agent; the verb's own source is the agent, so storage flips.
    const back = edges.get("drawn-in");
    expect(back?.ether).toEqual({ verb: "navigates" });
    expect([back?.fromNode, back?.toNode]).toEqual(["seat", "docs"]);
  });

  it("carries side and end metadata across the storage flip", () => {
    const edges = converted([
      {
        id: "flip",
        fromNode: "docs",
        toNode: "seat",
        fromSide: "left",
        toSide: "right",
        fromEnd: "arrow",
        toEnd: "none",
        ether: { ports: ["browser.automate"] },
      },
    ]);

    const flipped = edges.get("flip");
    expect([flipped?.fromNode, flipped?.toNode]).toEqual(["seat", "docs"]);
    expect(flipped?.fromSide).toBe("right");
    expect(flipped?.toSide).toBe("left");
    expect(flipped?.fromEnd).toBe("none");
    expect(flipped?.toEnd).toBe("arrow");
  });

  it("drops the legacy fields even when the verb is already authored", () => {
    const edges = converted([
      {
        id: "mixed",
        fromNode: "seat",
        toNode: "peer",
        ether: {
          verb: "messages",
          ports: ["msg.list"],
          stops: true,
          kind: "relates",
          wake: true,
        },
      },
    ]);

    expect(edges.get("mixed")?.ether).toEqual({ verb: "messages" });
    expect(Object.keys(edges.get("mixed")?.ether ?? {})).toEqual(["verb"]);
  });

  it("drops an authored verb the pair cannot hold rather than reading across", () => {
    // The wire already grants nothing in memory — `compileVerb` refuses a verb
    // its pair does not hold — so the load must not quietly re-read it as the
    // neighbouring relationship and mint page power the document never had.
    const edges = converted([
      { id: "alien", fromNode: "seat", toNode: "docs", ether: { verb: "publishes" } },
      { id: "kind-changed", fromNode: "seat", toNode: "docs", ether: { verb: "messages" } },
    ]);

    expect(edges.size).toBe(0);
  });

  it("drops what the grammar cannot hold", () => {
    const edges = converted([
      // Geography end: a region note holds no verb.
      { id: "note-edge", fromNode: "seat", toNode: "note", ether: { ports: ["msg.send"] } },
      // Terminal publishes nothing and offers no port.
      { id: "tty-edge", fromNode: "seat", toNode: "tty", ether: { ports: ["msg.send"] } },
      // A missing endpoint resolves to no kind at all.
      { id: "ghost", fromNode: "seat", toNode: "gone", ether: { ports: ["msg.send"] } },
    ]);

    expect(edges.size).toBe(0);
  });

  it("keeps the native edge fields the conversion does not own", () => {
    const edges = converted([
      {
        id: "decorated",
        fromNode: "seat",
        toNode: "peer",
        color: "3",
        label: "pairs on the migration",
        ether: { ports: ["msg.list"] },
      },
    ]);

    const decorated = edges.get("decorated");
    expect(decorated?.color).toBe("3");
    expect(decorated?.label).toBe("pairs on the migration");
    expect(decorated?.ether).toEqual({ verb: "messages" });
  });

  it("converts once: a second pass over its own output is a no-op", () => {
    const once = scrubCanvasDocInput(
      legacyDoc([
        { id: "flip", fromNode: "docs", toNode: "seat", ether: { ports: ["browser.automate"] } },
        { id: "mail", fromNode: "peer", toNode: "seat", ether: { ports: ["msg.send"], wake: true } },
      ]),
    );

    expect(scrubCanvasDocInput(once)).toEqual(once);
  });
});

// ---------------------------------------------------------------------------
// End to end: a whole board written in the old grammar, loaded and written back

/** Every key name that appears anywhere in a JSON tree. */
const keysIn = (value: unknown, out: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) keysIn(item, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      keysIn(child, out);
    }
  }
  return out;
};

/**
 * A board carrying every wire area the old grammar had on the live pairs:
 * seat to seat mail and seat to page navigation, drawn both ways round.
 */
const REALISTIC_LEGACY_EDGES: ReadonlyArray<unknown> = [
  // Access, drawn agent-first and page-first, with port masks and the retired
  // authorial stop word riding along.
  {
    id: "a-mail",
    fromNode: "seat",
    toNode: "peer",
    ether: { ports: ["msg.list", "msg.send"], kind: "relates" },
  },
  {
    id: "a-mail-back",
    fromNode: "peer",
    toNode: "seat",
    fromSide: "left",
    toSide: "right",
    ether: { ports: ["msg.prompt"], wake: true, notify: false, stops: true },
  },
  { id: "a-page", fromNode: "docs", toNode: "seat", ether: { ports: ["browser.automate"] } },
  // An edge already speaking the new grammar sits beside them untouched.
  { id: "v-nav", fromNode: "peer", toNode: "docs", ether: { verb: "navigates" } },
];

/**
 * Every word the edge grammar used to carry, including the phase mirror. Read
 * against the `edges` subtree alone: `kind` is still a node word
 * (`ether.entity.kind`), and only an edge is forbidden to say it.
 */
const LEGACY_EDGE_KEYS = ["ports", "wake", "notify", "stops", "kind"];

describe("a whole legacy board, loaded and written back", () => {
  const doc = Result.getOrThrow(decodeCanvasDoc(legacyDoc(REALISTIC_LEGACY_EDGES)));
  const written = serializeCanvas(doc);
  const reread = JSON.parse(written) as unknown;

  it("keeps every edge the grammar can hold, in the verb's own order", () => {
    expect(doc.edges.map((edge) => [edge.id, edge.ether?.verb])).toEqual([
      ["a-mail", "messages"],
      ["a-mail-back", "messages"],
      ["a-page", "navigates"],
      ["v-nav", "navigates"],
    ]);
    // Storage order is the verb's, whichever way the operator drew: the seat
    // leads its own page access.
    const from = new Map(doc.edges.map((edge) => [edge.id, edge.fromNode]));
    expect(from.get("a-page")).toBe("seat");
    expect(from.get("v-nav")).toBe("peer");
  });

  it("leaves one authored fact on every edge and nothing else", () => {
    for (const edge of doc.edges) {
      expect(Object.keys(edge.ether ?? {})).toEqual(["verb"]);
    }
  });

  it("writes back a document with no legacy word left in it", () => {
    const { edges } = reread as { readonly edges: unknown };
    const edgeKeys = keysIn(edges);
    for (const dead of LEGACY_EDGE_KEYS) {
      expect({ key: dead, onAnEdge: edgeKeys.has(dead) }).toEqual({
        key: dead,
        onAnEdge: false,
      });
    }
    expect(edgeKeys.has("verb")).toBe(true);
  });

  it("re-reads its own output unchanged — the conversion never runs twice", () => {
    const again = Result.getOrThrow(decodeCanvasDoc(reread));
    expect(serializeCanvas(again)).toBe(written);
  });
});
