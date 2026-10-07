import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import type { Canvas } from "../../src/shared/model";
import type { Task } from "../../src/shared/work-model";
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
import { workItemsFromDocument } from "../../src/shared/model/from-document";

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
    workItemsFromDocument(doc),
    trust,
  );

// ── The same fixtures for a canvas built from model nodes ───────────────────

/** One actor reference per seat on the canvas: a seat is the model's one actor. */
export const actorRefsForCanvas = (
  canvas: Pick<Canvas, "nodes">,
  canvasName = TEST_CANVAS_NAME,
): ReadonlyArray<ActorRefValue> =>
  [...canvas.nodes.values()]
    .filter((node) => node.kind === "agent")
    .map((node) => actorRefFixture(node.id, canvasName));

const NO_WORK = (): ReadonlyArray<Task> => [];

/** The execution context of a canvas, with the work its boards hold when a case has any. */
export const executionContextForCanvas = (
  canvas: Pick<Canvas, "nodes">,
  canvasName = TEST_CANVAS_NAME,
  itemsOf: (nodeId: string) => ReadonlyArray<Task> = NO_WORK,
  trust: LiveTrustViews = {},
): ExecutionGraphContext =>
  executionGraphContextFromActorRefs(canvasName, actorRefsForCanvas(canvas, canvasName), itemsOf, trust);
