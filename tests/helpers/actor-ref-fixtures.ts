import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { Canvas } from "../../src/shared/model";
import type {
  ExecutionGraphContext,
  LiveTrustViews,
  SeatTaskIndex,
} from "../../src/shared/execution-graph";
import { executionGraphContextFromActorRefs } from "../../src/shared/graph";
import {
  ActorRef,
  type ActorRef as ActorRefValue,
} from "../../src/shared/work-protocol";

export const TEST_CANVAS_NAME = "c";

const decodeActorRef = Schema.decodeUnknownSync(ActorRef);

export const actorRefFixture = (
  nodeId: string,
  canvasName = TEST_CANVAS_NAME,
): ActorRefValue =>
  decodeActorRef({
    seatId: `seat_${createHash("sha256")
      .update(`${canvasName}\u0000${nodeId}`)
      .digest("hex")}`,
    canvasName,
    nodeId,
  });

/** One actor reference per seat on the canvas: a seat is the model's one actor. */
export const actorRefsForCanvas = (
  canvas: Pick<Canvas, "nodes">,
  canvasName = TEST_CANVAS_NAME,
): ReadonlyArray<ActorRefValue> =>
  [...canvas.nodes.values()]
    .filter((node) => node.kind === "agent")
    .map((node) => actorRefFixture(node.id, canvasName));

/** The execution context of a canvas, with the task each seat holds when a case has any. */
export const executionContextForCanvas = (
  canvas: Pick<Canvas, "nodes">,
  canvasName = TEST_CANVAS_NAME,
  heldBy: SeatTaskIndex = {},
  trust: LiveTrustViews = {},
): ExecutionGraphContext =>
  executionGraphContextFromActorRefs(canvasName, actorRefsForCanvas(canvas, canvasName), heldBy, trust);
