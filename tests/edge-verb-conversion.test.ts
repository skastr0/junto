import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  decodeCanvasDoc,
  scrubCanvasDocInput,
  serializeCanvas,
} from "../src/shared/canvas";

// The one-shot legacy conversion. A document written in the old wire areas —
// ports, wake, slot, when, does, flow, stops, and the phase mirror — comes back
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
    node({ id: "intake", kind: "task", x: 400 }),
    node({ id: "review", kind: "task", x: 600 }),
    node({ id: "inbox", kind: "requests", x: 800 }),
    node({ id: "shelf", kind: "artifacts", x: 1000 }),
    node({ id: "wall", kind: "board", x: 1200 }),
    node({ id: "sheet", kind: "pad", x: 1400 }),
    node({ id: "docs", kind: "page", x: 1600 }),
    node({ id: "tty", kind: "terminal", x: 1800 }),
    node({ id: "relay", kind: "relay", x: 2000 }),
    node({ id: "clock", kind: "cron", x: 2200 }),
    node({ id: "note", x: 2400 }),
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
      {
        id: "hop",
        fromNode: "intake",
        toNode: "review",
        ether: { flow: { source: "intake", destination: "review" } },
      },
      { id: "browse", fromNode: "seat", toNode: "docs", ether: { ports: ["browser.automate"] } },
      { id: "raise", fromNode: "seat", toNode: "inbox", ether: { ports: ["request.escalate"] } },
      { id: "ship", fromNode: "seat", toNode: "shelf", ether: { ports: ["artifact.publish"] } },
    ]);

    expect(edges.get("mail")?.ether).toEqual({ verb: "messages" });
    expect(edges.get("hop")?.ether).toEqual({ verb: "feeds" });
    expect(edges.get("browse")?.ether).toEqual({ verb: "navigates" });
    // The retired request port names no verb any more: the wire is dropped.
    expect(edges.has("raise")).toBe(false);
    expect(edges.get("ship")?.ether).toEqual({ verb: "publishes" });
  });

  it("converts an access wire drawn either way into the agent-first verb", () => {
    const edges = converted([
      { id: "drawn-out", fromNode: "seat", toNode: "intake", ether: { ports: ["tasks.claim"] } },
      { id: "drawn-in", fromNode: "sheet", toNode: "seat", ether: { ports: ["pad.patch"] } },
    ]);

    const out = edges.get("drawn-out");
    expect(out?.ether).toEqual({ verb: "contributes" });
    expect([out?.fromNode, out?.toNode]).toEqual(["seat", "intake"]);

    // Drawn sink→agent; the verb's own source is the agent, so storage flips.
    const back = edges.get("drawn-in");
    expect(back?.ether).toEqual({ verb: "edits" });
    expect([back?.fromNode, back?.toNode]).toEqual(["seat", "sheet"]);
  });

  it("carries side and end metadata across the storage flip", () => {
    const edges = converted([
      {
        id: "flip",
        fromNode: "wall",
        toNode: "seat",
        fromSide: "left",
        toSide: "right",
        fromEnd: "arrow",
        toEnd: "none",
        ether: { ports: ["board.post"] },
      },
    ]);

    const flipped = edges.get("flip");
    expect([flipped?.fromNode, flipped?.toNode]).toEqual(["seat", "wall"]);
    expect(flipped?.fromSide).toBe("right");
    expect(flipped?.toSide).toBe("left");
    expect(flipped?.fromEnd).toBe("none");
    expect(flipped?.toEnd).toBe("arrow");
  });

  it("normalizes a legacy flow to the direction the config named, not the drawn one", () => {
    const edges = converted([
      {
        id: "backwards",
        fromNode: "review",
        toNode: "intake",
        ether: { flow: { source: "intake", destination: "review" } },
      },
    ]);

    const hop = edges.get("backwards");
    expect(hop?.ether).toEqual({ verb: "feeds" });
    expect([hop?.fromNode, hop?.toNode]).toEqual(["intake", "review"]);
  });

  it("reads the board megaphone opt-out off the legacy wake word", () => {
    const edges = converted([
      { id: "loud", fromNode: "seat", toNode: "wall", ether: { ports: ["board.post"] } },
      { id: "quiet", fromNode: "seat", toNode: "wall", ether: { wake: false } },
    ]);

    expect(edges.get("loud")?.ether).toEqual({ verb: "participates" });
    expect(edges.get("quiet")?.ether).toEqual({ verb: "messages" });
  });

  it("tells a relay trigger from a relay watch by the slot the wire sat in", () => {
    const edges = converted([
      { id: "trigger", fromNode: "seat", toNode: "relay", ether: { slot: "trigger" } },
      { id: "minted", fromNode: "seat", toNode: "relay", ether: { ports: ["relay.trigger"] } },
      { id: "watch", fromNode: "seat", toNode: "relay", ether: { slot: "input" } },
    ]);

    expect(edges.get("trigger")?.ether).toEqual({ verb: "fires" });
    expect(edges.get("minted")?.ether).toEqual({ verb: "fires" });
    expect(edges.get("watch")?.ether).toEqual({ verb: "announces" });
  });

  it("converts watch and effect wires by the word they authored", () => {
    const edges = converted([
      {
        id: "sees",
        fromNode: "intake",
        toNode: "relay",
        ether: { slot: "input", when: { word: "completes" } },
      },
      {
        id: "enqueues",
        fromNode: "relay",
        toNode: "review",
        ether: { slot: "output", does: { mode: "enqueue_task", data: {} } },
      },
      {
        id: "wakes",
        fromNode: "clock",
        toNode: "seat",
        ether: { slot: "output", does: { mode: "inject_prompt" } },
      },
      {
        id: "flags",
        fromNode: "relay",
        toNode: "inbox",
        ether: {
          slot: "output",
          does: { mode: "set_flag", flag: "attention", enabled: true },
        },
      },
      {
        id: "posts",
        fromNode: "relay",
        toNode: "wall",
        ether: { slot: "output", does: { mode: "board_post", data: {} } },
      },
      { id: "chain", fromNode: "clock", toNode: "relay", ether: { slot: "trigger" } },
    ]);

    expect(edges.get("sees")?.ether).toEqual({ verb: "announces" });
    expect(edges.get("enqueues")?.ether).toEqual({ verb: "enqueues" });
    expect(edges.get("wakes")?.ether).toEqual({ verb: "wakes" });
    // The retired `flags` verb has nothing to convert to: those wires drop.
    expect(edges.get("flags")).toBeUndefined();
    expect(edges.get("posts")).toBeUndefined();
    expect(edges.get("chain")?.ether).toEqual({ verb: "chains" });
  });

  it("falls back on direction when the scheduler wire authored no word", () => {
    const edges = converted([
      { id: "in", fromNode: "shelf", toNode: "relay", ether: {} },
      { id: "out-task", fromNode: "relay", toNode: "intake", ether: {} },
      { id: "out-agent", fromNode: "clock", toNode: "seat", ether: {} },
      { id: "out-page", fromNode: "relay", toNode: "docs", ether: {} },
    ]);

    expect(edges.get("in")?.ether).toEqual({ verb: "announces" });
    expect(edges.get("out-task")?.ether).toEqual({ verb: "enqueues" });
    expect(edges.get("out-agent")?.ether).toEqual({ verb: "wakes" });
    // A scheduler reaches a page with no verb now: the wire drops.
    expect(edges.get("out-page")).toBeUndefined();
  });

  it("keeps an already-authored verb instead of re-widening it", () => {
    const edges = converted([
      { id: "narrow", fromNode: "seat", toNode: "intake", ether: { verb: "manages" } },
      { id: "read", fromNode: "seat", toNode: "sheet", ether: { verb: "reads" } },
    ]);

    expect(edges.get("narrow")?.ether).toEqual({ verb: "manages" });
    expect(edges.get("read")?.ether).toEqual({ verb: "reads" });
  });

  it("drops the legacy fields even when the verb is already authored", () => {
    const edges = converted([
      {
        id: "mixed",
        fromNode: "seat",
        toNode: "intake",
        ether: {
          verb: "contributes",
          ports: ["tasks.list"],
          stops: { mode: "tasks" },
          kind: "blocks",
          wake: true,
        },
      },
    ]);

    expect(edges.get("mixed")?.ether).toEqual({ verb: "contributes" });
    expect(Object.keys(edges.get("mixed")?.ether ?? {})).toEqual(["verb"]);
  });

  it("drops an authored verb the pair cannot hold rather than reading across", () => {
    // The wire already grants nothing in memory — `compileVerb` refuses a verb
    // its pair does not hold — so the load must not quietly re-read it as the
    // neighbouring relationship and mint pad writes the document never had.
    const edges = converted([
      { id: "alien", fromNode: "seat", toNode: "sheet", ether: { verb: "publishes" } },
      { id: "kind-changed", fromNode: "seat", toNode: "sheet", ether: { verb: "contributes" } },
    ]);

    expect(edges.size).toBe(0);
  });

  it("drops what the grammar cannot hold", () => {
    const edges = converted([
      // Geography end: a region note holds no verb.
      { id: "note-edge", fromNode: "seat", toNode: "note", ether: { ports: ["msg.send"] } },
      // Terminal publishes nothing and offers no port.
      { id: "tty-edge", fromNode: "seat", toNode: "tty", ether: { ports: ["msg.send"] } },
      // A sink pair the grammar never admitted.
      { id: "sink-pair", fromNode: "wall", toNode: "sheet", ether: { ports: ["pad.read"] } },
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
        { id: "flip", fromNode: "wall", toNode: "seat", ether: { ports: ["board.post"] } },
        {
          id: "hop",
          fromNode: "review",
          toNode: "intake",
          ether: { flow: { source: "intake", destination: "review" } },
        },
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
 * A board carrying every wire area the old grammar had, including the dual keys
 * the scrub used to collapse before it and the node body that carried a watch.
 * One of each pairing the verb table admits, drawn both ways round.
 */
const REALISTIC_LEGACY_EDGES: ReadonlyArray<unknown> = [
  // Access, drawn agent-first and sink-first, with port masks and the retired
  // authorial stop word riding along.
  {
    id: "a-mail",
    fromNode: "seat",
    toNode: "peer",
    ether: { ports: ["msg.list", "msg.send"], kind: "relates" },
  },
  {
    id: "a-claim",
    fromNode: "intake",
    toNode: "seat",
    fromSide: "left",
    toSide: "right",
    ether: { ports: ["tasks.claim", "tasks.list"], stops: true, kind: "blocks" },
  },
  {
    id: "a-megaphone",
    fromNode: "wall",
    toNode: "seat",
    ether: { ports: ["board.post"], notify: false },
  },
  { id: "a-room", fromNode: "peer", toNode: "wall", ether: { ports: ["board.post"] } },
  { id: "a-pad", fromNode: "seat", toNode: "sheet", ether: { ports: ["pad.patch"] } },
  { id: "a-page", fromNode: "docs", toNode: "seat", ether: { ports: ["browser.automate"] } },
  { id: "a-esc", fromNode: "seat", toNode: "inbox", ether: { ports: ["request.escalate"] } },
  { id: "a-pub", fromNode: "shelf", toNode: "peer", ether: { ports: ["artifact.publish"] } },
  // Pipeline hop, stored against the direction its config named.
  {
    id: "w-hop",
    fromNode: "review",
    toNode: "intake",
    ether: { flow: { source: "intake", destination: "review" } },
  },
  // Scheduler plane: trigger slot, watch predicates on both dual keys, and each
  // fire action the old `does` / `effect` pair could carry.
  { id: "s-fire", fromNode: "seat", toNode: "relay", ether: { slot: "trigger" } },
  {
    id: "s-watch",
    fromNode: "intake",
    toNode: "relay",
    ether: { slot: "input", when: { word: "completes", equals: "completed" } },
  },
  {
    id: "s-watch-dual",
    fromNode: "shelf",
    toNode: "relay",
    ether: { criteria: { word: "completes" }, when: { word: "completes" } },
  },
  {
    id: "s-enqueue",
    fromNode: "relay",
    toNode: "review",
    ether: { slot: "output", does: { mode: "enqueue_task", data: { brief: "go" } } },
  },
  {
    id: "s-wake",
    fromNode: "relay",
    toNode: "peer",
    ether: { slot: "recipient", effect: { mode: "inject_prompt", text: "look" } },
  },
  {
    id: "s-flag",
    fromNode: "clock",
    toNode: "wall",
    ether: { does: { mode: "set_flag", flag: "attention", enabled: true } },
  },
  { id: "s-chain", fromNode: "clock", toNode: "relay", ether: {} },
  // An edge already speaking the new grammar sits beside them untouched.
  { id: "v-works", fromNode: "intake", toNode: "peer", ether: { verb: "works" } },
];

/**
 * Every word the edge grammar used to carry, including the phase mirror. Read
 * against the `edges` subtree alone: `kind` is still a node word
 * (`ether.entity.kind`), and only an edge is forbidden to say it.
 */
const LEGACY_EDGE_KEYS = [
  "ports",
  "wake",
  "notify",
  "slot",
  "when",
  "criteria",
  "does",
  "effect",
  "flow",
  "stops",
  "kind",
];

describe("a whole legacy board, loaded and written back", () => {
  const raw = legacyDoc(REALISTIC_LEGACY_EDGES);
  // The node body that used to carry a watch predicate.
  const withNodeRelay = {
    ...raw,
    nodes: raw.nodes.map((node) =>
      node.id === "relay"
        ? { ...node, ether: { ...node.ether, relay: { when: { word: "completes" } } } }
        : node,
    ),
  };

  const doc = Result.getOrThrow(decodeCanvasDoc(withNodeRelay));
  const written = serializeCanvas(doc);
  const reread = JSON.parse(written) as unknown;

  it("keeps every edge the grammar can hold, in the verb's own order", () => {
    expect(doc.edges.map((edge) => [edge.id, edge.ether?.verb])).toEqual([
      ["a-mail", "messages"],
      ["a-claim", "contributes"],
      ["a-megaphone", "messages"],
      ["a-room", "participates"],
      ["a-pad", "edits"],
      ["a-page", "navigates"],
      ["a-pub", "publishes"],
      ["w-hop", "feeds"],
      ["s-fire", "fires"],
      ["s-watch", "announces"],
      ["s-watch-dual", "announces"],
      ["s-enqueue", "enqueues"],
      ["s-wake", "wakes"],
      ["s-chain", "chains"],
      ["v-works", "works"],
    ]);
    // Storage order is the verb's, whichever way the operator drew: the seat
    // leads its own access, the sink leads what it announces, the task leads
    // the seat it hands work to.
    const from = new Map(doc.edges.map((edge) => [edge.id, edge.fromNode]));
    expect(from.get("a-claim")).toBe("seat");
    expect(from.get("a-megaphone")).toBe("seat");
    expect(from.get("a-page")).toBe("seat");
    expect(from.get("a-pub")).toBe("peer");
    expect(from.get("w-hop")).toBe("intake");
    expect(from.get("v-works")).toBe("intake");
  });

  it("leaves one authored fact on every edge and nothing else", () => {
    for (const edge of doc.edges) {
      expect(Object.keys(edge.ether ?? {})).toEqual(["verb"]);
    }
  });

  it("writes back a document with no legacy word left in it", () => {
    const { nodes, edges } = reread as {
      readonly nodes: unknown;
      readonly edges: unknown;
    };
    const edgeKeys = keysIn(edges);
    for (const dead of LEGACY_EDGE_KEYS) {
      expect({ key: dead, onAnEdge: edgeKeys.has(dead) }).toEqual({
        key: dead,
        onAnEdge: false,
      });
    }
    expect(edgeKeys.has("verb")).toBe(true);
    // The node body that carried a watch predicate goes with them.
    expect(keysIn(nodes).has("relay")).toBe(false);
  });

  it("re-reads its own output unchanged — the conversion never runs twice", () => {
    const again = Result.getOrThrow(decodeCanvasDoc(reread));
    expect(serializeCanvas(again)).toBe(written);
  });
});
