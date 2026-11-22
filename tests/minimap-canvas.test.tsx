// @vitest-environment jsdom
/**
 * The minimap draws its cards and dots on one canvas (issue 912): at 100x one
 * SVG child per card was 45,201 children, placed one at a time by React. A
 * click still finds its card, through a grid of the rectangles, with the
 * answer the SVG's own hit test gave: seats over cards, later over earlier.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { FactoryMinimap, minimapHits, type MinimapNodeRect } from "../src/window/components/FactoryMinimap";
import type { MinimapRect, MinimapSource } from "../src/window/canvas/shell/minimap-source";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card = (id: string, x: number, y: number, width: number, height: number, seat?: boolean): MinimapNodeRect => ({
  id,
  x,
  y,
  width,
  height,
  fill: "#123",
  stroke: "#456",
  ...(seat ? { seat: {} } : {}),
});

/** Every rectangle tested, topmost first: the rule the grid must keep. */
const scan = (rects: ReadonlyArray<MinimapNodeRect>, point: { x: number; y: number }, unit: number): string | undefined => {
  const floor = 2.2 * unit;
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const rect = rects[i]!;
    if (!rect.seat) continue;
    const r = Math.max(Math.min(rect.width, rect.height) / 2, floor);
    if ((point.x - rect.x - rect.width / 2) ** 2 + (point.y - rect.y - rect.height / 2) ** 2 <= r * r) return rect.id;
  }
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const rect = rects[i]!;
    if (rect.seat) continue;
    if (point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height) return rect.id;
  }
  return undefined;
};

const random = (seed: number) => () => {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
  return seed / 2 ** 32;
};

describe("the minimap's hit grid", () => {
  it("answers every point as a test of every rectangle does, seats over cards, later over earlier", () => {
    const next = random(912);
    const rects: MinimapNodeRect[] = [card("board", -20_000, -20_000, 40_000, 40_000)];
    for (let i = 0; i < 400; i += 1) {
      const seat = next() < 0.5;
      rects.push(card(`c${String(i)}`, (next() - 0.5) * 30_000, (next() - 0.5) * 30_000, seat ? 216 : 200 + next() * 3000, seat ? 56 : 200 + next() * 2000, seat));
    }
    const hits = minimapHits(rects);
    for (const unit of [1, 40, 120]) {
      for (let i = 0; i < 3000; i += 1) {
        const point = { x: (next() - 0.5) * 32_000, y: (next() - 0.5) * 32_000 };
        expect(hits.at(point, unit), `${String(point.x)},${String(point.y)} at ${String(unit)}`).toBe(scan(rects, point, unit));
      }
    }
  });

  it("answers nothing on an empty map", () => {
    expect(minimapHits([]).at({ x: 0, y: 0 }, 1)).toBeUndefined();
  });
});

const source = (rects: ReadonlyArray<MinimapRect>): MinimapSource => ({
  rects: () => rects,
  onRects: () => () => undefined,
  camera: () => ({ x: 0, y: 0, zoom: 1 }),
  onCamera: () => () => undefined,
  viewport: () => ({ width: 1024, height: 768 }),
  onViewport: () => () => undefined,
  setCamera: () => undefined,
  zoomBy: () => undefined,
  moveCamera: () => undefined,
  screenToBoard: (screen) => screen,
  element: () => null,
});

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("the minimap's drawing", () => {
  it("mounts no element per card: the SVG holds the mask, the canvas the cards", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const rects: MinimapRect[] = Array.from({ length: 2000 }, (_, i) => ({ id: `n${String(i)}`, kind: i % 2 === 0 ? "agent" : "note", x: i * 300, y: 0, width: 216, height: 56 }));
    act(() => {
      root!.render(
        <FactoryMinimap
          source={source(rects)}
          nodeColor={() => "#123"}
          nodeStrokeColor={() => "#456"}
          seatMarkOf={(rect) => (rect.kind === "agent" ? {} : undefined)}
          maskColor="#000"
          ariaLabel="map"
        />,
      );
    });
    const svg = host.querySelector("svg")!;
    expect(svg.children.length).toBe(1);
    expect(svg.querySelector("path.react-flow__minimap-mask")).not.toBeNull();
    const canvas = host.querySelector("canvas.junto-minimap-canvas")!;
    expect(canvas.getAttribute("aria-label")).toBe("map");
    expect(host.querySelectorAll("*").length).toBeLessThan(12);
  });
});
