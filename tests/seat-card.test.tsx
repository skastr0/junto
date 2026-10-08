/**
 * SeatCard: the seat on the canvas, read from the node store by canvas and
 * id. It is given no document node, so what it shows is what the store holds.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decodeNode, type Node } from "../src/shared/model";
import { SeatCard } from "../src/renderer/components/nodes/SeatCard";
import { holdModelCanvas as holdCanvas } from "./support/hold-canvas";

const seat = (id: string, label: string, extra: Record<string, unknown> = {}): Node =>
  Effect.runSync(decodeNode({
    kind: "agent", id, label, x: 0, y: 0, width: 216, height: 96, z: 0,
    agentKey: `local:${id}`, host: "local", overseer: false, onRemove: "detach",
    bindingId: `binding-${id}`, harness: "claude", ...extra,
  }));

const card = (id: string): string => renderToStaticMarkup(<SeatCard canvas="factory" id={id} />);

describe("SeatCard", () => {
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
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
