/**
 * The magnifier's lens engine (docs/canvas-gpu-architecture.md, sections 3,
 * 4 and 16; CanvasMagnifier.tsx).
 *
 * A second `createEngine` on the magnifier's own surface, fed by the same
 * scene ops the main canvas takes — `gpu-canvas-api.ts` fans `applyScene`
 * out to it, so there is one feed and one set of observers, never a second
 * `startSceneBridge`. It draws from the page's one atlas and the shared
 * device keeper, so a cell rasterizes once for both views.
 *
 * The lens never sees pointer input: it is a renderer plus a pick oracle.
 * While the loupe is held the main engine asks `pick()` for what the lens
 * shows at its centre — near tier, so a seat inside a far-zoom cluster is
 * still hoverable, clickable and double-clickable. `setActive(false)`
 * hides the surface from the frame loop entirely: zero CPU, zero GPU while
 * the magnifier is closed (motion law).
 */

import { LENS_CENTER, LENS_ZOOM, type Hit, type Point, type SceneOp } from "../contract";
import { createEngine, type WireLayer } from "../engine/engine";
import { createWireLayer } from "../engine/wires";
import { measureRun } from "../engine/text";
import { paintCard } from "../paint";
import { themeMode$ } from "../../lib/theme-mode";
import { surfaceMotionLive$ } from "../../lib/surface-motion";
import { regionGlanceOpacity, subregionGlanceOpacity } from "../../lib/region-glance";
import { isMac } from "../../lib/platform";
import { pageDeviceKeeper } from "./gpu-device";
import { onGpuAtlasDirty, pageGpuAtlas } from "./gpu-atlas-page";
import { ownWireMode } from "./wire-mode";

const browserScheduler = {
  request: (frame: (now: number) => void): number => requestAnimationFrame(frame),
  cancel: (handle: number): void => cancelAnimationFrame(handle),
};

export interface GpuLensSession {
  /** The scene ops the main canvas took; the lens draws the same facts. */
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
  /** Centre the lens on a board point at the lens zoom. */
  readonly lookAt: (at: Point) => void;
  /** The hit at a board point in the lens's view — the crosshair's when absent. */
  readonly pick: (at?: Point) => Hit | undefined;
  /** Engage or release the lens; frames draw only while engaged. */
  readonly setActive: (active: boolean) => void;
  /** The lens scene has taken its first load. */
  readonly ready: () => boolean;
  readonly dispose: () => void;
}

/**
 * Mount a lens engine on `surface`. Undefined where the surface offers no
 * WebGPU context — the magnifier then keeps its own drawing.
 */
export const createGpuLensSession = (surface: HTMLCanvasElement): GpuLensSession | undefined => {
  // The DOM lib types WebGPU but not this overload of getContext.
  const context = surface.getContext("webgpu") as GPUCanvasContext | null;
  if (context === null) return undefined;

  const keeper = pageDeviceKeeper();
  const atlas = pageGpuAtlas();
  const reducedMotion =
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
  const textCtx = document.createElement("canvas").getContext("2d");

  let wires: ReturnType<typeof createWireLayer> | undefined;
  // Same delegate shape as GpuCanvas: the engine hosts the layer before it
  // exists, and every call lands on it once it is built just below.
  const wireHost: WireLayer = {
    apply: (ops) => wires?.apply(ops),
    frame: (facts) => {
      wires?.frame(facts);
    },
    upload: (device: GPUDevice) => wires?.upload(device),
    encodeRest: (pass: GPURenderPassEncoder) => wires?.encodeRest(pass),
    encodeTracks: (pass: GPURenderPassEncoder) => wires?.encodeTracks(pass),
    hit: (at: Point) => wires?.hit(at),
    busy: (now: number) => wires?.busy(now) ?? false,
    dispose: () => {
      wires?.dispose();
    },
  };

  const engine = createEngine({
    surface,
    context,
    device: keeper,
    scheduler: browserScheduler,
    clock: () => performance.now(),
    wallClock: () => Date.now(),
    mac: isMac(),
    painter: paintCard,
    wires: wireHost,
    atlas: atlas.binding,
    sourceOf: (quad, scale) => atlas.sourceFor(quad, scale),
    atlasRevision: () => atlas.revision(),
    motionLive: () => surfaceMotionLive$.peek(),
    glance: (zoom) => ({ region: regionGlanceOpacity(zoom), sub: subregionGlanceOpacity(zoom) }),
    ...(textCtx === null || typeof textCtx.measureText !== "function"
      ? {}
      : { measure: (run) => measureRun(textCtx, run, window.devicePixelRatio || 1) }),
    mode: themeMode$.peek(),
  });
  wires = createWireLayer({
    rectOf: (id) => engine.rectOf(id),
    device: keeper,
    mode: themeMode$.peek(),
    reducedMotion: () => reducedMotion?.matches ?? false,
  });

  let fed = false;
  let active = false;
  let docVisible = typeof document === "undefined" || document.visibilityState !== "hidden";
  const applyVisibility = (): void => {
    engine.input({ kind: "visibility", visible: active && docVisible });
  };

  const offTheme = themeMode$.onChange(({ value }) => {
    atlas.setMode(value);
    engine.apply([{ kind: "theme", mode: value }]);
  });
  // The loupe's wire mode reaches this engine the same way it reaches the
  // main one: every mounted canvas is a writer, strongest reason wins.
  const offWireMode = ownWireMode((mode) => engine.apply([{ kind: "wireMode", mode }]));
  const offMotion = surfaceMotionLive$.onChange(() => engine.invalidate());
  const offAtlasDirty = onGpuAtlasDirty(() => engine.invalidate());
  const onVisibility = (): void => {
    docVisible = document.visibilityState !== "hidden";
    applyVisibility();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  const resize = (): void => {
    const rect = surface.getBoundingClientRect();
    engine.input({
      kind: "resize",
      width: rect.width,
      height: rect.height,
      pixelRatio: window.devicePixelRatio || 1,
    });
  };
  const sizes = new ResizeObserver(resize);
  sizes.observe(surface);
  resize();

  applyVisibility();

  return {
    apply: (ops) => {
      for (const op of ops) {
        if (op.kind === "load") fed = true;
      }
      engine.apply(ops);
    },
    lookAt: (at) => {
      engine.moveCamera({ kind: "centre", at, zoom: LENS_ZOOM });
    },
    pick: (at) => {
      if (!fed) return undefined;
      // A board point maps through the lens's own camera, so the pick lands
      // where the lens draws that point — the crosshair when `at` is absent.
      const screen = at === undefined ? LENS_CENTER : engine.boardToScreen(at);
      return engine.pick(screen) ?? undefined;
    },
    setActive: (next) => {
      active = next;
      applyVisibility();
    },
    ready: () => fed,
    dispose: () => {
      sizes.disconnect();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      offAtlasDirty();
      offMotion();
      offWireMode();
      offTheme();
      engine.dispose();
    },
  };
};
