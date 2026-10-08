import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorRef } from "../src/shared/work-protocol";
import {
  replaceActiveActorRefs,
} from "../src/renderer/lib/mutations";
import { note } from "./support/model-nodes";
import { openCanvas } from "./support/open-canvas";
import { state$ } from "../src/renderer/lib/state";

const actorRef = Schema.decodeUnknownSync(ActorRef);

describe("renderer ActorRef projection state", () => {
  it("retains refs through work-only refreshes and replaces them on authoritative loads", () => {
    const first = actorRef({
      seatId:
        "seat_1111111111111111111111111111111111111111111111111111111111111111",
      canvasName: "factory",
      nodeId: "agent-a",
    });
    const second = actorRef({
      seatId:
        "seat_2222222222222222222222222222222222222222222222222222222222222222",
      canvasName: "factory",
      nodeId: "agent-b",
    });

    state$.canvasName.set("factory");
    openCanvas("factory", [note("note", "authorial")]);
    replaceActiveActorRefs([first]);
    expect(state$.actorRefs.peek()).toEqual([first]);

    openCanvas("factory", [note("note", "next-authorial")]);
    expect(state$.actorRefs.peek()).toEqual([]);
    replaceActiveActorRefs([second]);
    expect(state$.actorRefs.peek()).toEqual([second]);
  });
});
