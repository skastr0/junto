/**
 * SeatCard: the seat on the canvas, read from the node store by canvas and
 * id. It is given no document node, so what it shows is what the store holds.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import { SeatCard } from "../src/renderer/components/nodes/SeatCard";
import { holdCanvas } from "./support/hold-canvas";

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

const card = (id: string): string => renderToStaticMarkup(<SeatCard canvas="factory" id={id} />);

describe("SeatCard", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it("shows the seat's label, which is one line", () => {
    stop = holdCanvas("factory", [seat("lead", "canvas-lead\nnotes under the name")]);

    const html = card("lead");
    expect(html).toContain('data-testid="agent-seat"');
    expect(html).toContain('title="canvas-lead"');
    expect(html).not.toContain("notes under the name");
    expect(html).not.toContain("data-overseer");
  });

  it("marks an overseer seat", () => {
    stop = holdCanvas("factory", [seat("lead", "canvas-lead", { overseer: true })]);

    expect(card("lead")).toContain('data-overseer="true"');
  });

  it("follows a rename", () => {
    stop = holdCanvas("factory", [seat("lead", "canvas-lead")]);
    const renamed = holdCanvas("factory", [seat("lead", "lead")]);
    stop();
    stop = renamed;

    expect(card("lead")).toContain('title="lead"');
  });

  it("renders nothing for an id the store does not hold as a seat", () => {
    stop = holdCanvas("factory", [seat("lead", "canvas-lead")]);

    expect(card("absent")).toBe("");
  });
});
