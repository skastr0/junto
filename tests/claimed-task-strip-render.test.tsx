/**
 * The strip's read cost must not scale with the canvas.
 *
 * One ClaimedTaskStrip mounts per seat (terminal card and agent text node), so
 * a strip that reads `state$.doc` and scans nodes x tasks costs
 * instances x nodes x tasks on every document write. This pins the shape that
 * removed it: rendering every strip on a claimed canvas touches the document
 * zero times, because the whole-canvas index was already built once.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { ActorRef } from "../src/shared/work-protocol";
import { ClaimedTaskStrip } from "../src/renderer/components/nodes/ClaimedTaskStrip";
import {
  claimedTask$,
  startClaimedTaskIndex,
  stopClaimedTaskIndex,
} from "../src/renderer/lib/claimed-task-index";
import { EMPTY_DOC, state$ } from "../src/renderer/lib/state";

const SEAT_COUNT = 48;

const seatId = (n: number): string =>
  `seat_${`${n}`.padStart(4, "0").repeat(16)}`;

const actorRefs = Array.from({ length: SEAT_COUNT }, (_unused, i) =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: seatId(i),
    canvasName: "factory",
    nodeId: `agent-${i}`,
  }),
);

const agentNode = (nodeId: string): CanvasNode =>
  ({ id: nodeId, type: "text", text: nodeId, x: 0, y: 0, width: 200, height: 100 }) as CanvasNode;

const tasksNode = (): CanvasNode =>
  ({
    id: "tasks",
    type: "text",
    text: "tasks",
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    ether: {
      entity: { kind: "task" },
      tasks: {
        items: actorRefs.map((actor, i) => ({
          id: `task-${i}`,
          state: "working" as const,
          claimedBy: actor.seatId,
          history: [
            {
              messageId: `task-${i}-brief`,
              role: "user" as const,
              parts: [{ kind: "text" as const, text: `brief ${i}` }],
              taskId: `task-${i}`,
            },
          ],
        })),
      },
    },
  }) as CanvasNode;

/** A document that reports every read of its node list. */
const countingDoc = (): { readonly doc: CanvasDoc; reads: () => number; reset: () => void } => {
  const nodes = [...actorRefs.map((actor) => agentNode(actor.nodeId)), tasksNode()];
  let reads = 0;
  const doc = {
    get nodes() {
      reads += 1;
      return nodes;
    },
    edges: [],
  } as unknown as CanvasDoc;
  return { doc, reads: () => reads, reset: () => { reads = 0; } };
};

describe("claimed task strip render cost", () => {
  beforeEach(() => {
    stopClaimedTaskIndex();
    claimedTask$.byNodeId.set({});
    state$.doc.set(EMPTY_DOC);
    state$.actorRefs.set([]);
    startClaimedTaskIndex();
  });

  afterEach(() => {
    stopClaimedTaskIndex();
    claimedTask$.byNodeId.set({});
    state$.doc.set(EMPTY_DOC);
    state$.actorRefs.set([]);
  });

  it("renders every seat's claim without reading the document", () => {
    const counting = countingDoc();
    state$.actorRefs.set(actorRefs);
    state$.doc.set(counting.doc);

    // The one whole-canvas scan already ran on the write above.
    counting.reset();

    const html = actorRefs
      .map((actor) => renderToStaticMarkup(<ClaimedTaskStrip node={agentNode(actor.nodeId)} />))
      .join("");

    expect(counting.reads()).toBe(0);
    expect(html.match(/data-testid="claimed-task"/gu)?.length).toBe(SEAT_COUNT);
    expect(html).toContain("brief 0");
    expect(html).toContain(`brief ${SEAT_COUNT - 1}`);
  });

  it("renders nothing for a seat holding no claim", () => {
    const counting = countingDoc();
    state$.actorRefs.set(actorRefs);
    state$.doc.set(counting.doc);
    counting.reset();

    const html = renderToStaticMarkup(<ClaimedTaskStrip node={agentNode("agent-unseated")} />);

    expect(html).toBe("");
    expect(counting.reads()).toBe(0);
  });
});
