// @vitest-environment jsdom
/**
 * Level-of-detail custom properties wait for the camera to rest.
 *
 * The five properties CanvasTierGate and RegionGlanceGate write are inherited
 * by every node, so a write on each zoom frame restyled the whole board on 42
 * to 70% of the frames of a sweep; --node-s sizes also laid out again. They
 * are held through the gesture and published once the camera rests
 * (cameraSettled$): one write per property, then the ring size eases on the
 * compositor (canvas-lod.css) instead of snapping. These tests lock that
 * contract.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CameraState = { transform: [number, number, number]; domNode: HTMLElement | null; width: number; height: number };
type CameraListener = (state: CameraState) => void;

const camera = vi.hoisted(() => {
  const listeners = new Set<CameraListener>();
  const state: CameraState = { transform: [0, 0, 1], domNode: null, width: 1200, height: 800 };
  return {
    state,
    getState: (): CameraState => state,
    subscribe: (listener: CameraListener): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    move: (zoom: number): void => {
      state.transform = [0, 0, zoom];
      for (const listener of [...listeners]) listener(state);
    },
    pan: (x: number, y: number): void => {
      state.transform = [x, y, state.transform[2]];
      for (const listener of [...listeners]) listener(state);
    },
    listeners: (): number => listeners.size,
  };
});

vi.mock("@xyflow/react", () => ({ useStoreApi: () => camera }));

import { CanvasTierGate } from "../src/window/components/CanvasTierGate";
import { RegionGlanceGate } from "../src/window/components/RegionGlanceGate";
import {
  CAMERA_SETTLE_MS,
  FAR_SEAT_SCALE_VAR,
  NODE_SCALE_VAR,
  SEAT_EASE_CURVE,
  SEAT_EASE_ID,
  SEAT_EASE_MS,
  SEAT_FLOOR_SCALE_VAR,
  cameraSettled$,
  clearCanvasTier,
  farSeatScale,
  nodeScale,
  seatEaseRatio,
  seatFloorScale,
} from "../src/window/lib/canvas-tier";
import { GLANCE_SUB_VAR, GLANCE_VAR, regionGlanceOpacity, subregionGlanceOpacity } from "../src/window/lib/region-glance";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let surface: HTMLDivElement;
let root: Root;

/** Every ease started by the gate: the Web Animations call, as it was made. */
type EaseCall = {
  readonly el: Element;
  readonly keyframes: unknown;
  readonly options: { readonly id?: string; readonly duration?: number; readonly easing?: string };
};
const eases: EaseCall[] = [];

/** One seat mark in the camera's plane, with the room cap its node carries. */
const addMark = (cap = 1.75, id?: string): HTMLElement => {
  const viewport = document.createElement("div");
  viewport.className = "react-flow__viewport";
  const node = document.createElement("div");
  node.className = "react-flow__node";
  if (id !== undefined) node.dataset.id = id;
  node.style.setProperty("--ring-cap", String(cap));
  const seat = document.createElement("div");
  seat.className = "junto-seat";
  const mark = document.createElement("span");
  mark.className = "junto-mark";
  seat.append(mark);
  node.append(seat);
  viewport.append(node);
  surface.append(viewport);
  return mark;
};

const value = (name: string): string => surface.style.getPropertyValue(name);
const text = (property: number): string => property.toFixed(1);
/** The glance writes "0" for none inked and two decimals otherwise (region-glance.ts). */
const opacity = (property: number): string => (property === 0 ? "0" : property.toFixed(2));

beforeEach(async () => {
  vi.useFakeTimers();
  eases.length = 0;
  document.documentElement.removeAttribute("data-surface-motion");
  // jsdom has no Web Animations; record the calls instead.
  (Element.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: unknown, options: EaseCall["options"]) {
    eases.push({ el: this, keyframes, options: options ?? {} });
    return { id: options?.id ?? "", cancel: () => undefined, finished: Promise.resolve() };
  };
  host = document.createElement("div");
  surface = document.createElement("div");
  document.body.append(host, surface);
  camera.state.domNode = surface;
  camera.state.transform = [0, 0, 1];
  root = createRoot(host);
  await act(async () => {
    root.render(
      <>
        <CanvasTierGate />
        <RegionGlanceGate />
      </>,
    );
  });
});

afterEach(async () => {
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
  document.documentElement.removeAttribute("data-surface-motion");
  await act(async () => {
    root.unmount();
  });
  host.remove();
  surface.remove();
  clearCanvasTier();
  cameraSettled$.set(0);
  vi.useRealTimers();
});

/** One wheel-burst gesture: several zoom frames closer together than the settle. */
const gesture = async (zooms: readonly number[]): Promise<void> => {
  await act(async () => {
    for (const zoom of zooms) {
      camera.move(zoom);
      await vi.advanceTimersByTimeAsync(8);
    }
  });
};

const rest = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CAMERA_SETTLE_MS);
  });
};

describe("level-of-detail properties wait for the camera to rest", () => {
  it("keeps the scale properties off the ReactFlow root, and still publishes the glance there", () => {
    // The root is inherited by every element on the board. A scale write
    // there restyled all 17,843 of them at a rest; the scales now travel on
    // the marks and instruments that read them.
    expect(value(NODE_SCALE_VAR)).toBe("");
    expect(value(FAR_SEAT_SCALE_VAR)).toBe("");
    expect(value(SEAT_FLOOR_SCALE_VAR)).toBe("");
    expect(value(GLANCE_VAR)).toBe(opacity(regionGlanceOpacity(1)));
    expect(value(GLANCE_SUB_VAR)).toBe(opacity(subregionGlanceOpacity(1)));
  });

  it("holds every write through a zoom gesture, then publishes the mark and glance once", async () => {
    const mark = addMark();
    const rootWritten = vi.spyOn(surface.style, "setProperty");
    const markWritten = vi.spyOn(mark.style, "setProperty");
    await gesture([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.34, 0.3, 0.25, 0.2]);
    // Not one property moved while the camera was moving.
    expect(rootWritten).not.toHaveBeenCalled();
    expect(markWritten).not.toHaveBeenCalled();

    await rest();
    // The mark gets the capped far size; the root gets only the two glance
    // values. The scale publish never reaches the root.
    expect(markWritten.mock.calls.map((call) => call.join("="))).toEqual(["--seat-s=1.75"]);
    expect(rootWritten.mock.calls.map((call) => call.join("="))).toEqual([
      `${GLANCE_VAR}=${opacity(regionGlanceOpacity(0.2))}`,
      `${GLANCE_SUB_VAR}=${opacity(subregionGlanceOpacity(0.2))}`,
    ]);
  });

  it("writes a seat that the cluster sheet has released by the time the rest lands", async () => {
    const mark = addMark(2, "returns-at-rest");
    const sheet = document.createElement("style");
    sheet.id = "junto-seat-clusters";
    sheet.textContent = ".react-flow__node[data-id=\"returns-at-rest\"] { visibility: hidden !important; }";
    document.head.append(sheet);
    await gesture([0.2]);
    // The cluster layer rewrites the sheet in the same task as the rest; the
    // publish reads it after that write, so the seat that comes out is sized
    // in this rest, not the next one.
    sheet.remove();
    await rest();
    expect(mark.style.getPropertyValue("--seat-s")).not.toBe("");
  });

  it("skips a gathered seat and writes the cluster body's transform directly", async () => {
    const hidden = addMark(2, "hidden-seat");
    const shown = addMark(2, "shown-seat");
    const sheet = document.createElement("style");
    sheet.id = "junto-seat-clusters";
    sheet.textContent = ".react-flow__node[data-id=\"hidden-seat\"] { visibility: hidden !important; }";
    document.head.append(sheet);
    const body = document.createElement("div");
    body.className = "junto-seat-cluster__body";
    document.body.append(body);
    await gesture([0.2]);
    await rest();
    expect(hidden.style.getPropertyValue("--seat-s")).toBe("");
    expect(shown.style.getPropertyValue("--seat-s")).not.toBe("");
    expect(body.style.transform).toBe(`translate(-50%, -50%) scale(${text(farSeatScale(0.2))})`);
    sheet.remove();
    body.remove();
  });

  it("starts the ring's size ease in the publish task, from the size it drew at", async () => {
    addMark(2);
    await gesture([0.2]);
    // Entering far: the ease runs from the near size to the published scale.
    const near = { far: 1, floor: 1 };
    // As written: a scale is stored to one decimal, and the ease reads that.
    const written = (value: number): number => Number(value.toFixed(1));
    const published = { far: written(farSeatScale(1)), floor: written(seatFloorScale(1)) };
    expect(eases).toHaveLength(1);
    expect(eases[0]!.options).toEqual({ id: SEAT_EASE_ID, duration: SEAT_EASE_MS, easing: SEAT_EASE_CURVE });
    expect(eases[0]!.keyframes).toEqual([
      { transform: `scale(${String(seatEaseRatio("far", near, published, 2))})` },
      { transform: "none" },
    ]);
    // At rest the new size is published and the ring eases from the old one.
    await rest();
    expect(eases).toHaveLength(2);
    expect(eases[1]!.el).toBe(eases[0]!.el);
    const rested = { far: written(farSeatScale(0.2)), floor: written(seatFloorScale(0.2)) };
    expect(eases[1]!.keyframes).toEqual([
      { transform: `scale(${String(seatEaseRatio("far", published, rested, 2))})` },
      { transform: "none" },
    ]);
    expect(eases[1]!.options).toEqual({ id: SEAT_EASE_ID, duration: SEAT_EASE_MS, easing: SEAT_EASE_CURVE });
  });

  it("eases a resting seat's ring, leaves a capped ring still, and skips paused motion", async () => {
    // Not data-mark-visible: a resting ring on screen changes size too.
    addMark(2);
    await gesture([0.2]);
    await rest();
    expect(eases).toHaveLength(2);

    eases.length = 0;
    document.documentElement.setAttribute("data-surface-motion", "paused");
    await gesture([0.15]);
    await rest();
    expect(eases).toHaveLength(0);
    document.documentElement.removeAttribute("data-surface-motion");

    // A ring with no room to grow keeps its size: ratio 1, no animation.
    surface.replaceChildren();
    addMark(1);
    eases.length = 0;
    await gesture([0.9]);
    await gesture([0.2]);
    await rest();
    expect(eases).toHaveLength(0);
  });

  it("moves the tier with the camera, so the detail under the hand stays true", async () => {
    await gesture([0.5]);
    expect(document.documentElement.getAttribute("data-canvas-tier")).toBe("mid");
    await gesture([0.2]);
    expect(document.documentElement.getAttribute("data-canvas-tier")).toBe("far");
  });

  it("counts one rest per gesture, however many frames it took", async () => {
    let rests = 0;
    const dispose = cameraSettled$.onChange(() => {
      rests += 1;
    });
    await gesture([0.9, 0.8, 0.7]);
    expect(rests).toBe(0);
    await rest();
    expect(rests).toBe(1);
    await gesture([0.6, 0.5]);
    await rest();
    expect(rests).toBe(2);
    dispose();
  });

  it("writes nothing at rest when a pan left the values as they were", async () => {
    await gesture([0.2]);
    await rest();
    const written = vi.spyOn(surface.style, "setProperty");
    await act(async () => {
      camera.pan(120, -40);
    });
    await rest();
    expect(written).not.toHaveBeenCalled();
  });
});

describe("ring size easing", () => {
  const styles = readFileSync(join(__dirname, "..", "src/window/styles", "canvas-lod.css"), "utf8");

  it("no longer eases with a CSS keyframe that restyles every mark", () => {
    // The keyframe read --seat-s in its from/to, so Blink treated it as a
    // main-thread animation and restyled every mark it started on (2304
    // Animation invalidations in a zoom sweep). The ease is a WAAPI transform
    // animation now, asserted by the gate tests above.
    expect(styles).not.toMatch(/junto-seat-ease/);
  });

  it("sizes a far ring by its unit, never by a scale transform at rest", () => {
    // A scale over the turning parts drew every ring offscreen every frame.
    expect(styles).not.toMatch(/\.junto-seat > \.junto-mark \{[^}]*transform: scale\(var\(--seat-s\)\)/);
    expect(styles).toMatch(/\.junto-seat > \.junto-mark \{\s*--mark-u: calc\(52px \* var\(--seat-s\)\);\s*margin: calc\(26px \* \(1 - var\(--seat-s\)\)\);/);
  });
});
