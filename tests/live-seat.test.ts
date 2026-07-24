import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { proveLiveSeat } from "../src/main/vellum/work/live-seat";

const agentDoc = (id: string, agentKey: string): CanvasDoc =>
  ({
    nodes: [
      {
        id,
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        text: agentKey,
        ether: { entity: { kind: "agent", name: agentKey } },
      },
    ],
    edges: [],
  }) as CanvasDoc;

describe("proveLiveSeat", () => {
  it("refuses terminal kind", () => {
    const proof = proveLiveSeat(
      [{ canvasName: "c", doc: agentDoc("n1", "local:worker") }],
      {
        kind: "terminal",
        canvasName: "c",
        nodeId: "n1",
      },
    );
    expect(proof.ok).toBe(false);
    if (!proof.ok) expect(proof.code).toBe("invalid");
  });

  it("refuses missing seat", () => {
    const proof = proveLiveSeat(
      [{ canvasName: "c", doc: agentDoc("n1", "local:worker") }],
      {
        kind: "agent",
        canvasName: "c",
        nodeId: "missing",
        agentKey: "local:worker",
      },
    );
    expect(proof.ok).toBe(false);
  });

  it("refuses agentKey mismatch on same node id", () => {
    const proof = proveLiveSeat(
      [{ canvasName: "c", doc: agentDoc("n1", "local:worker") }],
      {
        kind: "agent",
        canvasName: "c",
        nodeId: "n1",
        agentKey: "local:other",
      },
    );
    expect(proof.ok).toBe(false);
  });

  it("admits live agent seat with matching id + agentKey", () => {
    const proof = proveLiveSeat(
      [{ canvasName: "c", doc: agentDoc("n1", "local:worker") }],
      {
        kind: "agent",
        canvasName: "c",
        nodeId: "n1",
        agentKey: "local:worker",
      },
    );
    expect(proof.ok).toBe(true);
    if (proof.ok) {
      expect(proof.principal.nodeId).toBe("n1");
      expect(proof.principal.agentKey).toBe("local:worker");
    }
  });
});
