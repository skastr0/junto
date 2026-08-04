import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  applyMirrorLaw,
  decodeCanvasDoc,
  scrubCanvasDocInput,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";

// A raw (unknown-typed) document exercising every JSON Canvas node type plus
// the ether extension on both nodes and edges.
const rawDoc = {
  nodes: [
    {
      id: "t1",
      type: "text",
      text: "Hello",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      color: "2",
      ether: {
        entity: { kind: "project" },
        flags: ["blocker"],
      },
    },
    {
      id: "f1",
      type: "file",
      file: "notes/todo.md",
      subpath: "#section",
      x: 300,
      y: 0,
      width: 200,
      height: 80,
      ether: { flags: ["parked"] },
    },
    {
      id: "l1",
      type: "link",
      url: "https://example.com",
      x: 600,
      y: 0,
      width: 200,
      height: 80,
    },
    {
      id: "grp1",
      type: "group",
      label: "Region",
      background: "#123456",
      backgroundStyle: "cover",
      x: 0,
      y: 200,
      width: 900,
      height: 300,
      ether: {},
    },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "t1",
      toNode: "f1",
      fromSide: "right",
      toSide: "left",
      color: "3",
      label: "link",
    },
  ],
};

describe("canvas contract", () => {
  it("round-trips decode -> serialize -> decode to an identical document", () => {
    const decoded1 = Result.getOrThrow(decodeCanvasDoc(rawDoc));
    const serialized = serializeCanvas(decoded1);
    const decoded2 = Result.getOrThrow(decodeCanvasDoc(JSON.parse(serialized)));
    expect(decoded2).toEqual(decoded1);
  });

  it("still decodes once every ether key is stripped", () => {
    const stripped = {
      nodes: rawDoc.nodes.map((node) => {
        const { ether: _ether, ...rest } = node as typeof node & { ether?: unknown };
        return rest;
      }),
      edges: rawDoc.edges.map((edge) => {
        const { ether: _ether, ...rest } = edge as typeof edge & { ether?: unknown };
        return rest;
      }),
    };
    const decoded = decodeCanvasDoc(stripped);
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("rejects excess top-level properties", () => {
    expect(
      Result.isFailure(
        decodeCanvasDoc({
          ...rawDoc,
          topMystery: true,
        }),
      ),
    ).toBe(true);
  });

  it("rejects retired nested bindings instead of stripping them", () => {
    const legacy = {
      nodes: [
        {
          id: "project",
          type: "text",
          text: "legacy project",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "project", name: "demo" },
            bindings: [
              { source: "tower", ref: { type: "project", key: "demo" } },
            ],
          },
        },
      ],
      edges: [],
    };

    expect(Result.isFailure(decodeCanvasDoc(legacy))).toBe(true);
  });

  it.each(["tower", "quasar", "booth"] as const)(
    "rejects retired watch source %s",
    (source) => {
      const legacy = {
        nodes: [
          {
            id: "watch",
            type: "text",
            text: "legacy watch",
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            ether: {
              entity: { kind: "watcher" },
              watch: {
                kind: "stat_threshold",
                source,
                key: "demo",
                stat: "signals",
                op: "gt",
                value: 10,
              },
            },
          },
        ],
        edges: [],
      };

      expect(Result.isFailure(decodeCanvasDoc(legacy))).toBe(true);
    },
  );

  it.each(["glyphs_done", "glyphs_entered_state"] as const)(
    "rejects retired watch kind %s",
    (kind) => {
      const legacy = {
        nodes: [
          {
            id: "watch",
            type: "text",
            text: "legacy watch",
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            ether: {
              entity: { kind: "watcher" },
              watch: {
                kind,
                project: "demo",
              },
            },
          },
        ],
        edges: [],
      };

      expect(Result.isFailure(decodeCanvasDoc(legacy))).toBe(true);
    },
  );

  it("rejects retired ether.view project slice", () => {
    const legacy = {
      nodes: [
        {
          id: "project",
          type: "text",
          text: "legacy project",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
          ether: {
            entity: { kind: "project", name: "demo" },
            view: { orbit: "forge", glyphQuery: "bug" },
          },
        },
      ],
      edges: [],
    };

    expect(Result.isFailure(decodeCanvasDoc(legacy))).toBe(true);
  });

  it.each(["glyphs", "wip"] as const)(
    "rejects retired edge criteria mode %s",
    (mode) => {
      const legacy = {
        nodes: [
          {
            id: "source",
            type: "text",
            text: "source",
            x: 0,
            y: 0,
            width: 200,
            height: 80,
          },
          {
            id: "target",
            type: "text",
            text: "target",
            x: 300,
            y: 0,
            width: 200,
            height: 80,
          },
        ],
        edges: [
          {
            id: "legacy",
            fromNode: "source",
            toNode: "target",
            ether: { stops: { mode } },
          },
        ],
      };

      expect(Result.isFailure(decodeCanvasDoc(legacy))).toBe(true);
    },
  );

  it("rejects retired edge kind depends", () => {
    const legacy = {
      nodes: [
        {
          id: "node",
          type: "text",
          text: "node",
          x: 0,
          y: 0,
          width: 200,
          height: 80,
        },
      ],
      edges: [
        {
          id: "legacy",
          fromNode: "node",
          toNode: "node",
          ether: { kind: "depends" },
        },
      ],
    };

    expect(Result.isFailure(decodeCanvasDoc(legacy))).toBe(true);
  });

  it("applyMirrorLaw mirrors color only and leaves labels authorial", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "n1", type: "text", text: "Blocker", x: 0, y: 0, width: 200, height: 80, ether: { flags: ["blocker"] } },
        { id: "n2", type: "text", text: "Plain", x: 0, y: 100, width: 200, height: 80 },
      ],
      edges: [
        { id: "e-blocks", fromNode: "n1", toNode: "n2", ether: { kind: "blocks", stops: { mode: "tasks" } } },
        { id: "e-relates", fromNode: "n1", toNode: "n2", ether: { kind: "relates", stops: { mode: "tasks" } } },
        { id: "e-relates-labeled", fromNode: "n1", toNode: "n2", label: "kept", ether: { kind: "relates" } },
        { id: "e-plain", fromNode: "n1", toNode: "n2" },
      ],
    };

    const mirrored = applyMirrorLaw(doc);

    const blocker = mirrored.nodes.find((n) => n.id === "n1");
    expect(blocker?.color).toBe("1");
    const plainNode = mirrored.nodes.find((n) => n.id === "n2");
    expect(plainNode?.color).toBeUndefined();

    const blocksEdge = mirrored.edges.find((e) => e.id === "e-blocks");
    expect(blocksEdge?.label).toBeUndefined();
    expect(blocksEdge?.color).toBe("1");

    // Phase never projects into the authorial label field.
    const relatesEdge = mirrored.edges.find((e) => e.id === "e-relates");
    expect(relatesEdge?.label).toBeUndefined();
    expect(relatesEdge?.color).toBeUndefined();

    const labeledEdge = mirrored.edges.find((e) => e.id === "e-relates-labeled");
    expect(labeledEdge?.label).toBe("kept");

    const plainEdge = mirrored.edges.find((e) => e.id === "e-plain");
    expect(plainEdge?.label).toBeUndefined();
    expect(plainEdge?.color).toBeUndefined();
  });

  it("applyMirrorLaw demotes stuck blocks color 1 when kind is no longer blocks", () => {
    const doc: CanvasDoc = {
      nodes: [{ id: "n1", type: "text", text: "A", x: 0, y: 0, width: 100, height: 50 }],
      edges: [
        {
          id: "e-stuck",
          fromNode: "n1",
          toNode: "n1",
          label: "depends",
          color: "1",
          ether: { kind: "relates", stops: { mode: "tasks" } },
        },
        {
          id: "e-soft",
          fromNode: "n1",
          toNode: "n1",
          label: "free",
          color: "4",
        },
      ],
    };
    const mirrored = applyMirrorLaw(doc);
    const stuck = mirrored.edges.find((e) => e.id === "e-stuck");
    expect(stuck?.color).toBeUndefined();
    // Native labels are authorial text, including retired extension vocabulary.
    expect(stuck?.label).toBe("depends");
    // Soft relates with no kind mirror: leave user color alone.
    const soft = mirrored.edges.find((e) => e.id === "e-soft");
    expect(soft?.color).toBe("4");
    expect(soft?.label).toBe("free");
  });

  it("serializeCanvas produces a stable key order and is idempotent", () => {
    const decoded = Result.getOrThrow(decodeCanvasDoc(rawDoc));
    const first = serializeCanvas(decoded);
    const second = serializeCanvas(decoded);
    expect(first).toBe(second);

    // Key order within a node follows the canonical NODE_KEY_ORDER.
    const idIndex = first.indexOf('"id"');
    const typeIndex = first.indexOf('"type"');
    const xIndex = first.indexOf('"x"');
    const etherIndex = first.indexOf('"ether"');
    expect(idIndex).toBeGreaterThanOrEqual(0);
    expect(idIndex).toBeLessThan(typeIndex);
    expect(typeIndex).toBeLessThan(xIndex);
    expect(xIndex).toBeLessThan(etherIndex);
    expect(first.endsWith("\n")).toBe(true);
  });

  describe("scrubCanvasDocInput dual-key collapse", () => {
    const dualLegacy = {
      nodes: [
        {
          id: "relay-n",
          type: "text",
          text: "relay",
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          ether: {
            entity: { kind: "relay" },
            // dead node-body surface — must drop before strict decode
            relay: { rising: true },
          },
        },
        {
          id: "task-n",
          type: "text",
          text: "tasks",
          x: 120,
          y: 0,
          width: 100,
          height: 40,
          ether: { entity: { kind: "task" }, tasks: { items: [] } },
        },
      ],
      edges: [
        {
          id: "e-legacy",
          fromNode: "task-n",
          toNode: "relay-n",
          ether: {
            criteria: { mode: "tasks" },
            effect: { mode: "enqueue_task", brief: "go" },
            notify: true,
            when: { word: "completes" },
            relayState: true,
            slot: "input",
          },
        },
      ],
    };

    it("maps criteria→stops, effect→does, notify→wake; drops relayState + node ether.relay", () => {
      const scrubbed = scrubCanvasDocInput(dualLegacy) as {
        nodes: Array<{ id: string; ether?: Record<string, unknown> }>;
        edges: Array<{ id: string; ether?: Record<string, unknown> }>;
      };
      const relayNode = scrubbed.nodes.find((n) => n.id === "relay-n");
      expect(relayNode?.ether).toEqual({ entity: { kind: "relay" } });
      expect(relayNode?.ether).not.toHaveProperty("relay");

      const eth = scrubbed.edges[0]!.ether!;
      expect(eth.stops).toEqual({ mode: "tasks" });
      expect(eth.does).toEqual({ mode: "enqueue_task", brief: "go" });
      expect(eth.wake).toBe(true);
      expect(eth.when).toEqual({ word: "completes" });
      expect(eth.slot).toBe("input");
      expect(eth).not.toHaveProperty("criteria");
      expect(eth).not.toHaveProperty("effect");
      expect(eth).not.toHaveProperty("notify");
      expect(eth).not.toHaveProperty("relayState");
    });

    it("decodeCanvasDoc accepts dual-key input and re-encode has no dual keys", () => {
      // Strip work projection so decode is allowed at persistence boundaries.
      const authorial = {
        ...dualLegacy,
        nodes: dualLegacy.nodes.map((n) => {
          if (n.id !== "task-n") return n;
          return {
            ...n,
            ether: { entity: { kind: "task" } },
          };
        }),
      };
      const decoded = Result.getOrThrow(decodeCanvasDoc(authorial));
      const edge = decoded.edges.find((e) => e.id === "e-legacy");
      expect(edge?.ether?.stops).toEqual({ mode: "tasks" });
      expect(edge?.ether?.does).toEqual({ mode: "enqueue_task", brief: "go" });
      expect(edge?.ether?.wake).toBe(true);
      expect(edge?.ether).not.toHaveProperty("criteria");
      expect(edge?.ether).not.toHaveProperty("effect");
      expect(edge?.ether).not.toHaveProperty("notify");
      expect(edge?.ether).not.toHaveProperty("relayState");
      const relay = decoded.nodes.find((n) => n.id === "relay-n");
      expect(relay?.ether).not.toHaveProperty("relay");

      const serialized = serializeCanvas(decoded);
      expect(serialized).not.toMatch(/"criteria"/);
      expect(serialized).not.toMatch(/"effect"/);
      expect(serialized).not.toMatch(/"notify"/);
      expect(serialized).not.toMatch(/"relayState"/);
      // node-body relay key must not reappear
      expect(serialized).not.toMatch(/"relay"\s*:/);
    });
  });
});
