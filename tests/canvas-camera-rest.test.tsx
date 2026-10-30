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

type CameraState = { transform: [number, number, number]; domNode: HTMLElement | null };
type CameraListener = (state: CameraState) => void;

const camera = vi.hoisted(() => {
  const listeners = new Set<CameraListener>();
  const state: CameraState = { transform: [0, 0, 1], domNode: null };
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

import { CanvasTierGate } from "../src/renderer/components/CanvasTierGate";
import { RegionGlanceGate } from "../src/renderer/components/RegionGlanceGate";
import {
  CAMERA_SETTLE_MS,
  FAR_SEAT_SCALE_VAR,
  NODE_SCALE_VAR,
  SEAT_FLOOR_SCALE_VAR,
  cameraSettled$,
  clearCanvasTier,
  farSeatScale,
  nodeScale,
  seatFloorScale,
} from "../src/renderer/lib/canvas-tier";
import { GLANCE_SUB_VAR, GLANCE_VAR, regionGlanceOpacity, subregionGlanceOpacity } from "../src/renderer/lib/region-glance";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let surface: HTMLDivElement;
let root: Root;

const value = (name: string): string => surface.style.getPropertyValue(name);
const text = (property: number): string => property.toFixed(1);
/** The glance writes "0" for none inked and two decimals otherwise (region-glance.ts). */
const opacity = (property: number): string => (property === 0 ? "0" : property.toFixed(2));

beforeEach(async () => {
  vi.useFakeTimers();
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
  it("publishes all five properties on the first paint", () => {
    expect(value(NODE_SCALE_VAR)).toBe(text(nodeScale(1)));
    expect(value(FAR_SEAT_SCALE_VAR)).toBe(text(farSeatScale(1)));
    expect(value(SEAT_FLOOR_SCALE_VAR)).toBe(text(seatFloorScale(1)));
    expect(value(GLANCE_VAR)).toBe(opacity(regionGlanceOpacity(1)));
    expect(value(GLANCE_SUB_VAR)).toBe(opacity(subregionGlanceOpacity(1)));
  });

  it("holds every write through a zoom gesture, then publishes once at rest", async () => {
    const written = vi.spyOn(surface.style, "setProperty");
    await gesture([0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.34, 0.3, 0.25, 0.2]);
    // Not one property moved while the camera was moving.
    expect(written).not.toHaveBeenCalled();
    expect(value(NODE_SCALE_VAR)).toBe(text(nodeScale(1)));

    await rest();
    // One write per property, all five of them, at the values of the rest.
    expect(written.mock.calls.map((call) => call.join("="))).toEqual([
      `${NODE_SCALE_VAR}=${text(nodeScale(0.2))}`,
      `${FAR_SEAT_SCALE_VAR}=${text(farSeatScale(0.2))}`,
      `${SEAT_FLOOR_SCALE_VAR}=${text(seatFloorScale(0.2))}`,
      `${GLANCE_VAR}=${opacity(regionGlanceOpacity(0.2))}`,
      `${GLANCE_SUB_VAR}=${opacity(subregionGlanceOpacity(0.2))}`,
    ]);
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
  const styles = readFileSync(join(__dirname, "..", "src/renderer/styles/canvas-lod.css"), "utf8");

  it("eases the far ring scale on the compositor, and jumps when motion is paused", () => {
    expect(styles).toMatch(
      /html:not\(\[data-surface-motion="paused"\]\)[^{]*\.junto-seat > \.junto-mark \{[^}]*transition: transform \d+ms/,
    );
  });
});
