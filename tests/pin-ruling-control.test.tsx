/**
 * Pinning an operator's answer as standing law.
 *
 * The control rides the answer surfaces (task escalation, request inbox), so
 * its region choice comes from the sink's own region stack — innermost first,
 * because the closest law is the one the answer most likely belongs to. With
 * no region around the sink there is nowhere for a ruling to stand.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { PinRulingControl } from "../src/renderer/components/rules/PinRulingControl";
import { EMPTY_DOC, state$ } from "../src/renderer/lib/state";

const region = (id: string, label: string, box: number): CanvasNode =>
  ({
    id,
    type: "group",
    label,
    x: 0,
    y: 0,
    width: box,
    height: box,
  }) as CanvasNode;

const sink = (id: string): CanvasNode =>
  ({
    id,
    type: "text",
    text: id,
    x: 40,
    y: 40,
    width: 120,
    height: 80,
    ether: { entity: { kind: "task" } },
  }) as CanvasNode;

const docOf = (...nodes: ReadonlyArray<CanvasNode>): CanvasDoc =>
  ({ nodes, edges: [] }) as CanvasDoc;

afterEach(() => {
  state$.doc.set(EMPTY_DOC);
});

describe("PinRulingControl", () => {
  it("offers the pin on the innermost region of the sink's stack", () => {
    state$.doc.set(
      docOf(region("outer", "Factory", 600), region("inner", "Review", 300), sink("tasks")),
    );

    const html = renderToStaticMarkup(
      <PinRulingControl nodeId="tasks" text="Ship it without the second review." />,
    );

    expect(html).toContain("Pin as ruling");
    expect(html).toContain("Region to pin this ruling on");
    expect(html).toContain("as a ruling on region Review");
  });

  it("names the single containing region instead of asking for a choice", () => {
    state$.doc.set(docOf(region("outer", "Factory", 600), sink("tasks")));

    const html = renderToStaticMarkup(
      <PinRulingControl nodeId="tasks" text="Ship it." />,
    );

    expect(html).toContain("Pin as ruling");
    expect(html).toContain("Factory");
    expect(html).not.toContain("Region to pin this ruling on");
  });

  it("stays silent when no region holds the sink", () => {
    state$.doc.set(docOf(sink("tasks")));

    expect(
      renderToStaticMarkup(<PinRulingControl nodeId="tasks" text="Ship it." />),
    ).toBe("");
  });

  it("holds the pin until there is an answer to pin", () => {
    state$.doc.set(docOf(region("outer", "Factory", 600), sink("tasks")));

    const html = renderToStaticMarkup(<PinRulingControl nodeId="tasks" text="   " />);

    expect(html).toContain("Pin as ruling");
    expect(html).toContain("disabled");
  });
});
