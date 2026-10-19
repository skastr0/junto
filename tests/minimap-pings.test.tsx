// @vitest-environment jsdom
/**
 * Minimap pings run on the compositor (motion law).
 *
 * They were SVG circles animating transform and opacity. Chromium cannot
 * composite an animation on an SVG child, so the main thread restyled and
 * re-laid out the map every frame: 2549 layouts in 29.5 s on a nested board
 * (canvas-verifier, trace at d7a56b713). This holds them to HTML elements
 * outside the SVG, animated by keyframes that touch transform and opacity
 * only, with the paused rule kept as it was.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ReactFlowProvider, type Node } from "@xyflow/react";
import { FactoryMinimap, pingLayerTransform, type SeatMark } from "../src/renderer/components/FactoryMinimap";
import { RegionUrgency } from "../src/shared/wire/urgency";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CSS = readFileSync(resolve(__dirname, "../src/renderer/components/factory-minimap.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const seat = (id: string, x: number): Node => ({ id, position: { x, y: 0 }, width: 216, height: 56, data: {} });
const MARKS: Record<string, SeatMark | undefined> = {
  stuck: { urgency: RegionUrgency.group.blocked },
  asking: { urgency: RegionUrgency.group["needs-you"] },
  review: { urgency: RegionUrgency.group.review },
  calm: {},
};

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

const mount = (): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const nodes = [seat("stuck", 0), seat("asking", 300), seat("review", 600), seat("calm", 900), seat("note", 1200)];
  act(() => {
    root!.render(
      <ReactFlowProvider initialNodes={nodes}>
        <FactoryMinimap nodeColor={() => "#123"} nodeStrokeColor={() => "#456"} seatMarkOf={(node) => MARKS[node.id]} maskColor="#000" />
      </ReactFlowProvider>,
    );
  });
  return host;
};

describe("minimap pings", () => {
  it("are HTML elements outside the SVG, one per blocked or needs-you seat", () => {
    const host = mount();
    const pings = [...host.querySelectorAll<HTMLElement>(".junto-minimap-ping")];
    expect(pings.map((ping) => ping.dataset.urgency)).toEqual(["blocked", "needs-you"]);
    for (const ping of pings) {
      expect(ping).toBeInstanceOf(HTMLElement);
      expect(ping).not.toBeInstanceOf(SVGElement);
      expect(ping.closest("svg")).toBeNull();
    }
    expect(host.querySelector("svg .junto-minimap-ping, svg [class*='ping']")).toBeNull();
  });

  it("animate transform and opacity only, and the paused rule stays", () => {
    const names = [...CSS.matchAll(/\.junto-minimap-ping[^{]*\{([^}]*)\}/g)]
      .flatMap(([, body]) => [...body!.matchAll(/animation(?:-name)?\s*:\s*([\w-]+)/g)].map(([, name]) => name!))
      .filter((name) => name !== "none");
    expect(new Set(names)).toEqual(new Set(["juntoMinimapPingBlocked", "juntoMinimapPingNeedsYou"]));
    for (const name of names) {
      const block = CSS.match(new RegExp(`@keyframes ${name}\\s*\\{((?:[^{}]*\\{[^}]*\\})*)\\s*\\}`))?.[1];
      expect(block, name).toBeDefined();
      const properties = [...block!.matchAll(/([\w-]+)\s*:/g)].map(([, property]) => property);
      expect(properties.length, name).toBeGreaterThan(0);
      for (const property of properties) expect(["transform", "opacity"], `${name} animates ${property}`).toContain(property);
    }
    expect(CSS).not.toMatch(/\.junto-minimap-ping[^{]*\{[^}]*transition/);
    expect(CSS).toContain(`html[data-surface-motion="paused"] .junto-minimap-ping { animation: none; }`);
  });

  it("place flow units on the SVG's own pixels (viewBox, xMidYMid meet)", () => {
    // A 400 by 100 box in a 200 by 150 map: half scale, centred vertically.
    expect(pingLayerTransform({ x: 0, y: 0, width: 400, height: 100 }, 200, 150)).toBe("translate(0px, 50px) scale(0.5)");
    // Offset box: the box origin lands on the map's top left once fitted.
    expect(pingLayerTransform({ x: 100, y: -20, width: 300, height: 300 }, 150, 150)).toBe("translate(-50px, 10px) scale(0.5)");
    expect(pingLayerTransform({ x: 0, y: 0, width: 0, height: 0 }, 200, 150)).toBe("scale(0)");
  });
});
