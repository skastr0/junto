/**
 * SeatCard: the seat on the canvas, read from the node store by canvas and
 * id. It is given no document node, so what it shows is what the store holds.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { SeatCard } from "../src/renderer/components/nodes/SeatCard";
import { followDocument } from "../src/renderer/lib/model-from-document";
import { EMPTY_DOC, state$ } from "../src/renderer/lib/state";

const seat = (id: string, text: string, extra: Record<string, unknown> = {}): CanvasNode =>
  ({
    id,
    type: "text",
    text,
    x: 0,
    y: 0,
    width: 216,
    height: 96,
    ether: {
      entity: { kind: "agent", name: `local:${id}` },
      terminal: { bindingId: `binding-${id}`, harness: "claude" },
      ...extra,
    },
  }) as CanvasNode;

const doc = (...nodes: CanvasNode[]): CanvasDoc => ({ nodes, edges: [] });

const card = (id: string): string => renderToStaticMarkup(<SeatCard canvas="factory" id={id} />);

describe("SeatCard", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
    state$.canvasName.set("");
    state$.doc.set(EMPTY_DOC);
  });

  it("shows the first line of the seat's label", () => {
    state$.canvasName.set("factory");
    state$.doc.set(doc(seat("lead", "canvas-lead\nnotes under the name")));
    stop = followDocument();

    const html = card("lead");
    expect(html).toContain('data-testid="agent-seat"');
    expect(html).toContain('title="canvas-lead"');
    expect(html).not.toContain("notes under the name");
    expect(html).not.toContain("data-overseer");
  });

  it("marks an overseer seat", () => {
    state$.canvasName.set("factory");
    state$.doc.set(doc(seat("lead", "canvas-lead", { overseer: true })));
    stop = followDocument();

    expect(card("lead")).toContain('data-overseer="true"');
  });

  it("follows a rename", () => {
    state$.canvasName.set("factory");
    state$.doc.set(doc(seat("lead", "canvas-lead")));
    stop = followDocument();
    state$.doc.set(doc(seat("lead", "lead")));

    expect(card("lead")).toContain('title="lead"');
  });

  it("renders nothing for an id the store does not hold as a seat", () => {
    state$.canvasName.set("factory");
    state$.doc.set(doc(seat("lead", "canvas-lead")));
    stop = followDocument();

    expect(card("absent")).toBe("");
  });
});
