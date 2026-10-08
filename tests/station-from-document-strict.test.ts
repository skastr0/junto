import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/main/junto/station/frozen-document";
import { stationCanvasOf, nodeOfDocument, nodesFromDocument } from "../src/main/junto/station/frozen-from-document";
import { convertLegacyRow } from "../src/shared/model/from-legacy-row";

const note = (id: string): CanvasNode => ({ id, type: "text", text: id, x: 0, y: 0, width: 200, height: 80 }) as CanvasNode;
const seat = (id: string): CanvasNode =>
  ({
    id, type: "text", text: id, x: 40, y: 60, width: 216, height: 56,
    ether: {
      entity: { kind: "agent", name: `local:${id}` }, host: "local",
      terminal: { bindingId: `binding-${id}`, harness: "claude" },
    },
  }) as CanvasNode;
/** A seat that lost its session binding: an agent the model does not hold. */
const unseated = (id: string): CanvasNode => {
  const whole = seat(id);
  return { ...whole, ether: { ...whole.ether, terminal: { harness: "claude" } } } as CanvasNode;
};
/** A seat of no size, as a view of a node without placement would give. */
const sizeless = (id: string): CanvasNode => ({ ...seat(id), x: 0, y: 0, width: 0, height: 0 }) as CanvasNode;

describe("a document node the model cannot hold is refused, never kept as a note", () => {
  it("answers nothing for the node alone, where it used to answer a note", () => {
    expect(nodeOfDocument("factory", unseated("s"), 0)).toBeUndefined();
    expect(nodeOfDocument("factory", sizeless("s"), 0)).toBeUndefined();
    expect(nodeOfDocument("factory", seat("s"), 0)?.kind).toBe("agent");
    expect(nodeOfDocument("factory", note("n"), 0)?.kind).toBe("note");
  });

  it("fails a whole canvas that mixes good nodes with one it cannot hold, naming the node", () => {
    const doc: CanvasDoc = { nodes: [note("n"), seat("ok"), unseated("bad")], edges: [] };
    expect(() => stationCanvasOf("factory", doc)).toThrow(/"bad"/);
    expect(() => nodesFromDocument(doc)).toThrow(/"bad"/);
  });

  it("fails every read of that document, not only the first", () => {
    const doc: CanvasDoc = { nodes: [seat("ok"), sizeless("bad")], edges: [] };
    for (let read = 0; read < 3; read += 1) {
      expect(() => stationCanvasOf("factory", doc)).toThrow(/"bad"/);
      expect(() => nodesFromDocument(doc)).toThrow(/"bad"/);
    }
  });

  it("reads the same document once the node is made whole", () => {
    const canvas = stationCanvasOf("factory", { nodes: [note("n"), seat("ok")], edges: [] });
    expect([...canvas.nodes.values()].map((node) => node.kind).sort()).toEqual(["agent", "note"]);
  });
});

describe("the one-time migration still keeps what it cannot read", () => {
  it("keeps a stored seat with no binding as a note, with a report of what it was", () => {
    const converted = convertLegacyRow({
      canvas_name: "factory", node_id: "old", type: "text",
      x: 10, y: 20, width: 200, height: 80, z_index: 3, color: undefined,
      ether_json: JSON.stringify({ entity: { kind: "agent", name: "local:old" } }),
      text_content: "old seat",
    } as never);
    expect(converted.node.kind).toBe("note");
    expect(converted.node).toMatchObject({ id: "old", x: 10, y: 20, width: 200, height: 80 });
    expect(converted.downgraded).toMatchObject({ canvas: "factory", id: "old" });
  });
});
