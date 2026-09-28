import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { seatIdForActorNode } from "../src/renderer/lib/actor-ledger-work";
import { ActorRef } from "../src/shared/work-protocol";

const actor = Schema.decodeUnknownSync(ActorRef)({
  seatId: `seat_${"a".repeat(64)}`,
  canvasName: "factory",
  nodeId: "agent",
});

const otherActor = Schema.decodeUnknownSync(ActorRef)({
  seatId: `seat_${"b".repeat(64)}`,
  canvasName: "factory",
  nodeId: "other-agent",
});

describe("seatIdForActorNode", () => {
  it("resolves the compiled seat for an actor node", () => {
    expect(seatIdForActorNode([actor, otherActor], "agent")).toBe(actor.seatId);
    expect(seatIdForActorNode([actor], "nope")).toBeUndefined();
    expect(seatIdForActorNode([], "agent")).toBeUndefined();
  });
});
