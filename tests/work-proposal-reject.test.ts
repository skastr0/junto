import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  workTaskApproveProposal,
  workTaskPropose,
  workTaskRejectProposal,
} from "../src/shared/work";
import type { CanvasDoc } from "../src/shared/canvas";
import { ActorRef } from "../src/shared/work-protocol";

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

const actorRef = (digit: string, nodeId: string, canvasName = "alpha") =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: `seat_${digit.repeat(64)}`,
    canvasName,
    nodeId,
  });

const emptyTaskNode = (id = "tasks"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "task" } },
});

describe("proposal reject pure policy", () => {
  it("rejects a pending proposal without minting a task", () => {
    const worker = actorRef("1", "worker-1");
    const initial: CanvasDoc = {
      nodes: [emptyTaskNode()],
      edges: [{ id: "edge", fromNode: "worker-1", toNode: "tasks" }],
    };
    const proposed = workTaskPropose(
      initial,
      "alpha",
      "tasks",
      "noise draft",
      { title: "Noise", details: "discard me" },
      ids,
      worker,
    );
    const rejected = workTaskRejectProposal(
      proposed.doc,
      "tasks",
      proposed.proposal.id,
    );
    expect(rejected.proposal.state).toBe("rejected");
    expect(rejected.proposal.approvedTaskId).toBeUndefined();
    expect(rejected.doc.nodes[0]?.ether?.tasks?.items).toEqual([]);
    expect(
      rejected.doc.nodes[0]?.ether?.tasks?.proposals?.find(
        (proposal) => proposal.id === proposed.proposal.id,
      )?.state,
    ).toBe("rejected");
    expect(() =>
      workTaskApproveProposal(
        rejected.doc,
        "alpha",
        "tasks",
        proposed.proposal.id,
        ids,
      ),
    ).toThrow(/not pending/);
  });
});
