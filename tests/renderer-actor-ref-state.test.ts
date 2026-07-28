import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { ActorRef } from "../src/shared/work-protocol";
import {
  applyWorkCanvasWrite,
  loadDoc,
  replaceActiveActorRefs,
} from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";

const actorRef = Schema.decodeUnknownSync(ActorRef);

const document = (text: string): CanvasDoc => ({
  nodes: [
    {
      id: "note",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text,
    },
  ],
  edges: [],
});

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
    loadDoc(document("authorial"), "revision-1", "factory");
    replaceActiveActorRefs([first]);
    expect(state$.actorRefs.peek()).toEqual([first]);

    applyWorkCanvasWrite(
      "factory",
      document("authorial"),
      "revision-work",
    );
    expect(state$.actorRefs.peek()).toEqual([first]);

    loadDoc(document("next-authorial"), "revision-2", "factory");
    expect(state$.actorRefs.peek()).toEqual([]);
    replaceActiveActorRefs([second]);
    expect(state$.actorRefs.peek()).toEqual([second]);
  });
});
