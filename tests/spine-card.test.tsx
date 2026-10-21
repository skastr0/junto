// @vitest-environment jsdom
/**
 * The Spines node language (docs/node-card-language.md): what a kind hands
 * over is what the chip, tag, spine and far disc say. The drawing itself is
 * checked in frames; this locks the contract the kinds rely on.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPINE_STATUS, SpineCard, type SpineStatus } from "../src/renderer/components/nodes/SpineCard";
import { nodeScale } from "../src/renderer/lib/canvas-tier";
import { spokenNodeName } from "../src/renderer/lib/flow-nodes";
import { NodeBlockedContext, NodeIdContext, nodeSpokenKind$, nodeStatus$, shownStatus } from "../src/renderer/lib/node-status";
import { PeerCard, StubCard } from "../src/renderer/components/nodes/RemoteNodeCards";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = (node: React.ReactNode) => act(() => root.render(node));

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const glyph = <svg data-testid="glyph" />;

describe("SpineCard", () => {
  it("draws a chip with glyph, name and count, and no tag while idle", () => {
    render(<SpineCard glyph={glyph} hue="violet" name="Specs" count={3} />);
    expect(host.querySelector(".spine-chip__name")?.textContent).toBe("Specs");
    expect(host.querySelector(".spine-chip__count")?.textContent).toBe("3");
    expect(host.querySelector(".spine-chip")?.getAttribute("data-hue")).toBe("violet");
    expect(host.querySelector(".spine-tag")).toBeNull();
    expect(host.querySelector(".spine-pip")).toBeNull();
  });

  it("says every status as a word and a shape, and carries its tone for the spine and the far pip", () => {
    for (const status of Object.keys(SPINE_STATUS) as SpineStatus[]) {
      render(<SpineCard glyph={glyph} hue="green" name="Board" status={status} />);
      const look = SPINE_STATUS[status];
      expect(host.querySelector(".spine-tag")?.textContent).toBe(look.word);
      expect(host.querySelector(".spine-tag .spine-shape")?.getAttribute("data-shape")).toBe(look.shape);
      expect(host.querySelector(".spine-pip")?.getAttribute("data-shape")).toBe(look.shape);
      expect(host.querySelector(".spine-card")?.getAttribute("data-tone")).toBe(look.tone);
    }
  });

  it("hangs a meta line and at most four rows, then +N more", () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({ key: `r${index}`, text: `row ${index}` }));
    render(<SpineCard glyph={glyph} hue="green" name="Board" body={{ kind: "spine", meta: "6 open", rows, more: 2 }} />);
    expect(host.querySelector(".spine__meta")?.textContent).toBe("6 open");
    expect([...host.querySelectorAll(".spine__row")].map((row) => row.textContent)).toEqual(["row 0", "row 1", "row 2", "row 3"]);
    expect(host.querySelector(".spine__more")?.textContent).toBe("+4 more");
  });

  it("draws a row's dim detail and its flag tone", () => {
    render(
      <SpineCard
        glyph={glyph}
        hue="amber"
        name="Jobs"
        body={{ kind: "spine", meta: "1 on, 0 off", rows: [{ key: "a", text: "nightly", detail: "every day at 9", tone: "crimson" }] }}
      />,
    );
    expect(host.querySelector(".spine__detail")?.textContent).toBe("every day at 9");
    expect(host.querySelector(".spine__row")?.getAttribute("data-tone")).toBe("crimson");
  });

  it("gives a leaf one line and no spine; a dashed chip for peers and stubs", () => {
    render(<SpineCard glyph={glyph} hue="dim" name="report.pdf" dashed body={{ kind: "leaf", line: "docs/report.pdf" }} />);
    expect(host.querySelector(".spine-leaf")?.textContent).toBe("docs/report.pdf");
    expect(host.querySelector(".spine")).toBeNull();
    expect(host.querySelector(".spine-chip")?.getAttribute("data-dashed")).toBe("true");
  });
});

describe("node scale", () => {
  it("is the inverse zoom to a tenth, between 1 and the minimum zoom's", () => {
    expect(nodeScale(1)).toBe(1);
    expect(nodeScale(2)).toBe(1);
    expect(nodeScale(0.25)).toBe(4);
    expect(nodeScale(0.3)).toBe(3.4);
    expect(nodeScale(0.1)).toBe(6.7);
    expect(nodeScale(Number.NaN)).toBe(1);
  });
});

describe("spoken name", () => {
  it("is name, kind and blocked; a seat and a region keep their name alone", () => {
    expect(spokenNodeName("Board", "task", false)).toBe("Board, tasks");
    expect(spokenNodeName("Board", "task", true)).toBe("Board, tasks, blocked");
    expect(spokenNodeName("lead", "agent", true)).toBe("lead");
    expect(spokenNodeName("Junto", "region", false)).toBe("Junto");
    expect(spokenNodeName("example.com", "page", false, "working")).toBe("example.com, page, working");
    expect(spokenNodeName("Board", "task", true, "needs-you")).toBe("Board, tasks, needs you");
  });

  it("is published by the card drawn in a node, and cleared when it goes", () => {
    render(
      <NodeIdContext.Provider value="n1">
        <SpineCard glyph={glyph} hue="green" name="Board" status="failed" />
      </NodeIdContext.Provider>,
    );
    expect(nodeStatus$.n1.peek()).toBe("failed");
    render(<NodeIdContext.Provider value="n1"><SpineCard glyph={glyph} hue="green" name="Board" /></NodeIdContext.Provider>);
    expect(nodeStatus$.n1.peek()).toBeUndefined();
  });
});

describe("graph blocked", () => {
  it("outranks a calmer status, never failed or needs you", () => {
    expect(shownStatus(undefined, true)).toBe("blocked");
    expect(shownStatus("off", true)).toBe("blocked");
    expect(shownStatus("working", true)).toBe("blocked");
    expect(shownStatus("failed", true)).toBe("failed");
    expect(shownStatus("needs-you", true)).toBe("needs-you");
    expect(shownStatus("off", false)).toBe("off");
  });

  it("is what the card shows and says", () => {
    render(
      <NodeIdContext.Provider value="n2">
        <NodeBlockedContext.Provider value>
          <SpineCard glyph={glyph} hue="amber" name="Jobs" status="off" />
        </NodeBlockedContext.Provider>
      </NodeIdContext.Provider>,
    );
    expect(host.querySelector(".spine-tag")?.textContent).toBe("Blocked");
    expect(nodeStatus$.n2.peek()).toBe("blocked");
  });
});

describe("peer and stub", () => {
  const place = { x: 0, y: 0, width: 200, height: 40 };
  it("a peer is a dashed portrait chip, a seat on its machine", () => {
    render(
      <NodeIdContext.Provider value="p1">
        <PeerCard node={{ kind: "peer", id: "p1", ...place, label: "lead", host: "studio", seatId: "s1" } as never} />
      </NodeIdContext.Provider>,
    );
    expect(host.querySelector(".spine-portrait")?.textContent).toBe("L");
    expect(host.querySelector(".spine-leaf")?.textContent).toBe("seat on studio");
    expect(nodeSpokenKind$.p1.peek()).toBe("seat on studio");
  });

  it("a stub is its kind's chip, dashed, a copy on its machine", () => {
    render(
      <NodeIdContext.Provider value="s1">
        <StubCard node={{ kind: "stub", id: "s1", ...place, of: "page", host: "studio" } as never} />
      </NodeIdContext.Provider>,
    );
    expect(host.querySelector(".spine-chip")?.getAttribute("data-dashed")).toBe("true");
    expect(host.querySelector(".spine-leaf")?.textContent).toBe("page on studio");
    expect(nodeSpokenKind$.s1.peek()).toBe("page copy on studio");
  });
});
