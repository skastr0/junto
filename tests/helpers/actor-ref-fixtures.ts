import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { CanvasDoc, Task } from "../../src/shared/canvas";
import type {
  ExecutionGraphContext,
  LiveTrustViews,
} from "../../src/shared/execution-graph";
import { executionGraphContextFromActorRefs } from "../../src/shared/graph";
import { resolveSpec, roleOf } from "../../src/shared/physics";
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

export const actorRefsForDoc = (
  doc: CanvasDoc,
  canvasName = TEST_CANVAS_NAME,
): ReadonlyArray<ActorRefValue> =>
  doc.nodes
    .filter(
      (node) =>
        roleOf(
          resolveSpec({
            isGroup: node.type === "group",
            kind: node.ether?.entity?.kind,
          }),
        ) === "actor",
    )
    .map((node) => actorRefFixture(node.id, canvasName));

export const executionContextForDoc = (
  doc: CanvasDoc,
  canvasName = TEST_CANVAS_NAME,
  trust: LiveTrustViews = {},
): ExecutionGraphContext =>
  executionGraphContextFromActorRefs(
    canvasName,
    actorRefsForDoc(doc, canvasName),
    trust,
  );

export const claimedByNode = (
  task: Task,
  nodeId: string,
  canvasName = TEST_CANVAS_NAME,
): Task => ({
  ...task,
  claimedBy: actorRefFixture(nodeId, canvasName).seatId,
});
