import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { followDocument } from "../src/renderer/lib/model-from-document";
import { EMPTY_DOC, state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";

const seat = (id: string, text: string, x = 0): CanvasNode =>
  ({
    id,
    type: "text",
    text,
    x,
    y: 0,
    width: 216,
    height: 96,
    ether: {
      entity: { kind: "agent", name: `local:${id}` },
      terminal: { bindingId: `binding-${id}`, harness: "claude" },
    },
  }) as CanvasNode;

const doc = (...nodes: CanvasNode[]): CanvasDoc => ({ nodes, edges: [] });

describe("the store filled from the open document", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    state$.canvasName.set("");
    state$.doc.set(EMPTY_DOC);
  });

  it("holds each node as its kind and follows the document", () => {
    const lead = seat("lead", "canvas-lead");
    state$.canvasName.set("factory");
    state$.doc.set(doc(lead, seat("nodes", "canvas-nodes")));
    stop = followDocument();

    const canvas$ = modelStore.canvas$("factory");
    expect(canvas$.status.peek()).toBe("open");
    expect(canvas$.nodeIds.peek()).toEqual(["lead", "nodes"]);
    const before = modelStore.node$("factory", "lead").peek();
    expect(before).toMatchObject({ kind: "agent", label: "canvas-lead", harness: "claude", bindingId: "binding-lead" });

    state$.doc.set(doc(lead, seat("nodes", "canvas-nodes", 400)));
    expect(modelStore.node$("factory", "lead").peek()).toBe(before);
    expect(canvas$.nodes.nodes.x.peek()).toBe(400);

    state$.doc.set(doc(lead));
    expect(canvas$.nodeIds.peek()).toEqual(["lead"]);
  });

  it("lets go of a canvas when another one opens", () => {
    state$.canvasName.set("factory");
    state$.doc.set(doc(seat("lead", "canvas-lead")));
    stop = followDocument();
    state$.canvasName.set("other");
    state$.doc.set(doc(seat("solo", "solo")));
    expect(modelStore.canvas$("factory").status.peek()).toBe("closed");
    expect(modelStore.canvas$("other").nodeIds.peek()).toEqual(["solo"]);
  });
});
