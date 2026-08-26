import { describe, expect, it } from "vitest";
import { Result } from "effect";
import {
  applyMirrorLaw,
  decodeCanvasDoc,
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
        entity: { kind: "agent" },
        flags: ["blocker"],
      },
    },
    {
      id: "t2",
      type: "text",
      text: "Peer",
      x: 0,
      y: 100,
      width: 200,
      height: 80,
      ether: { entity: { kind: "agent" } },
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
      toNode: "t2",
      fromSide: "right",
      toSide: "left",
      color: "3",
      label: "link",
      ether: { verb: "messages" },
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

  it("rejects the retired work-role field", () => {
    const retired = structuredClone(rawDoc);
    retired.nodes[0]!.ether = {
      ...retired.nodes[0]!.ether,
      workRole: "builder",
    } as unknown as typeof retired.nodes[0]["ether"];

    expect(Result.isFailure(decodeCanvasDoc(retired))).toBe(true);
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

  it("applyMirrorLaw mirrors the blocker flag to color and leaves edges alone", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "n1", type: "text", text: "Blocker", x: 0, y: 0, width: 200, height: 80, ether: { flags: ["blocker"] } },
        { id: "n2", type: "text", text: "Plain", x: 0, y: 100, width: 200, height: 80 },
      ],
      edges: [
        { id: "e-verbed", fromNode: "n1", toNode: "n2", ether: { verb: "messages" } },
        { id: "e-labeled", fromNode: "n1", toNode: "n2", label: "kept" },
        { id: "e-colored", fromNode: "n1", toNode: "n2", color: "4" },
        { id: "e-plain", fromNode: "n1", toNode: "n2" },
      ],
    };

    const mirrored = applyMirrorLaw(doc);

    const blocker = mirrored.nodes.find((n) => n.id === "n1");
    expect(blocker?.color).toBe("1");
    const plainNode = mirrored.nodes.find((n) => n.id === "n2");
    expect(plainNode?.color).toBeUndefined();

    // There is no phase mirror on an edge any more: the verb is the whole
    // authored fact, and label and color stay exactly as the operator left them.
    expect(mirrored.edges).toEqual(doc.edges);
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

});
