/**
 * The GPU canvas shell (docs/canvas-gpu-architecture.md, sections 4, 5, 16 and
 * 19).
 *
 * React renders this once. Everything after that reaches the engine outside
 * React: the theme through an observer, size and visibility through the
 * browser's own observers, the camera through the hand-over and the CanvasApi,
 * the scene through the model bridge. Nothing here calls setState, so a camera
 * move, a drag or a seat report never renders.
 *
 * The shell's mirror answers every value the rest of the app asks for, so
 * `screenToBoard`, `rectOf`, the minimap and the magnifier work while a frame
 * is in flight. Anchors are written to their elements' styles from the mirror,
 * never through React.
 */

import { useContext, useEffect, useMemo, useRef } from "react";
import { selectNode, state$ } from "../../lib/state";
import { themeMode$ } from "../../lib/theme-mode";
import { canvasZoomRequest$ } from "../../lib/canvas-zoom";
import { createEngine, type SeamEngine, type WireLayer } from "../engine/engine";
import { createWireLayer, type WiresLayer } from "../engine/wires";
import type { Camera, Rect } from "../contract";
import { takeCamera, leaveCamera } from "./camera-handoff";
import { pageDeviceKeeper } from "./gpu-device";
import { CanvasApiProvider } from "./CanvasApiContext";
import { setCanvasApi, clearCanvasApi } from "./canvas-api";
import { createGpuCanvasApi, type GpuCanvasApi } from "./gpu-canvas-api";
import { createSurfaceMirror, type SurfaceMirror } from "./surface-mirror";
import { createGpuMinimapSource } from "./gpu-minimap-source";
import { clearMinimapSource, setMinimapSource } from "./minimap-source";
import { startSceneBridge } from "./scene-bridge";
import { installCanvasTestHook } from "./test-hook";
import { attachCanvasDelete, attachCanvasInput, mountHands } from "./hands";
import { canvasHands } from "./pointer-host";
import { CanvasMenus } from "./CanvasMenus";
import { clearCanvasTier, publishCanvasTier } from "../../lib/canvas-tier";
import { viewportForBounds } from "./camera-targets";
import { paintCard } from "../paint";
import { isMac } from "../../lib/platform";
import { WindowRuntimeContext } from "../../rpc/runtime";

type Props = {
  /** Heard once if this machine cannot run the GPU canvas, with the reason. */
  readonly onUnavailable: (reason: string) => void;
};

const browserScheduler = {
  request: (frame: (now: number) => void): number => requestAnimationFrame(frame),
  cancel: (handle: number): void => cancelAnimationFrame(handle),
};

/** The engine the mounted GPU canvas runs, for the test hook. */
let mounted: SeamEngine | undefined;
export const mountedGpuEngine = (): SeamEngine | undefined => mounted;

/** What a canvas opens on: its regions when named, else its first cards. */
const openingCamera = (mirror: SurfaceMirror): Camera | undefined => {
  const viewport = mirror.viewport();
  if (viewport.width <= 0 || viewport.height <= 0) return undefined;
  const all = mirror.cardIds().map((id) => mirror.card(id)!).filter(Boolean);
  const regions = all.filter((card) => card.row.kind === "region");
  const anchors = regions.length > 0 ? regions : all.slice(0, 24);
  if (anchors.length === 0) return undefined;
  const rects: Rect[] = anchors.map((card) => ({ x: card.row.x, y: card.row.y, width: card.row.width, height: card.row.height }));
  const bounds = rects.reduce<Rect>(
    (acc, rect) => ({
      x: Math.min(acc.x, rect.x),
      y: Math.min(acc.y, rect.y),
      width: Math.max(acc.x + acc.width, rect.x + rect.width) - Math.min(acc.x, rect.x),
      height: Math.max(acc.y + acc.height, rect.y + rect.height) - Math.min(acc.y, rect.y),
    }),
    { ...rects[0]! },
  );
  return viewportForBounds(bounds, viewport, 0.15, regions.length > 0 ? 1.15 : 1.35, 0.18);
};

export function GpuCanvas({ onUnavailable }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;
  const runtime = useContext(WindowRuntimeContext);
  const mirror = useMemo(() => createSurfaceMirror(), []);
  const api = useMemo<GpuCanvasApi>(() => createGpuCanvasApi(mirror), [mirror]);
  const engineRef = useRef<SeamEngine | undefined>(undefined);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const keeper = pageDeviceKeeper();
    // The DOM lib types WebGPU but not this overload of getContext.
    const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
    if (context === null) {
      unavailableRef.current("This canvas offers no WebGPU context.");
      return;
    }
    const canvasName = state$.canvasName.peek();
    const handed = takeCamera(canvasName);
    const reducedMotion = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : undefined;
    let wires: WiresLayer | undefined;
    // The engine hosts the wire layer before the layer exists: the delegate is
    // stable, and every call lands on the layer once it is built just below.
    const wireHost: WireLayer = {
      apply: (ops) => wires?.apply(ops),
      frame: (facts) => {
        wires?.frame(facts);
      },
      upload: (device) => wires?.upload(device),
      encodeRest: (pass) => wires?.encodeRest(pass),
      encodeTracks: (pass) => wires?.encodeTracks(pass),
      hit: (at) => wires?.hit(at),
      busy: (now) => wires?.busy(now) ?? false,
      dispose: () => {
        wires?.dispose();
      },
    };
    const engine = createEngine({
      surface: canvas,
      context,
      device: keeper,
      scheduler: browserScheduler,
      clock: () => performance.now(),
      // Wall clock for ring phase: the DOM ring's phase comes from Date.now().
      wallClock: () => Date.now(),
      mac: isMac(),
      painter: paintCard,
      hands: canvasHands(),
      wires: wireHost,
      ...(handed === undefined ? {} : { camera: handed }),
    });
    wires = createWireLayer({
      rectOf: (id) => engine.rectOf(id),
      device: keeper,
      mode: themeMode$.peek(),
      reducedMotion: () => reducedMotion?.matches ?? false,
    });
    mounted = engine;
    engineRef.current = engine;
    api.attachEngine(engine);
    // Real browser input reaches the engine; shortcuts stay in the one key
    // dispatcher, and the delete chord keeps the gates React Flow had.
    const offInput = attachCanvasInput(engine, canvas);
    const offHands = mountHands(engine, canvas);
    const offDelete = attachCanvasDelete();
    mirror.setElement(canvas);
    if (handed !== undefined) mirror.setCamera(handed);

    let placed = handed !== undefined;
    const placeOpeningCamera = (): void => {
      if (placed) return;
      const opening = openingCamera(mirror);
      if (opening === undefined) return;
      placed = true;
      api.moveCamera({ kind: "camera", camera: opening });
    };
    const offRects = mirror.onRects(placeOpeningCamera);
    const offViewport = mirror.onViewport(placeOpeningCamera);
    placeOpeningCamera();
    publishCanvasTier(mirror.camera().zoom);

    const told = { done: false };
    const tell = (): void => {
      const state = keeper.state();
      if (state.kind !== "unavailable" || told.done) return;
      told.done = true;
      unavailableRef.current(state.reason);
    };
    const offKeeper = keeper.subscribe(tell);
    tell();

    const offScene = startSceneBridge({
      apply: (ops) => api.applyScene(ops),
    }, runtime);

    engine.apply([{ kind: "theme", mode: themeMode$.peek() }]);
    const offTheme = themeMode$.onChange(({ value }) => engine.apply([{ kind: "theme", mode: value }]));

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      mirror.setViewport({ width: rect.width, height: rect.height });
      engine.input({ kind: "resize", width: rect.width, height: rect.height, pixelRatio: window.devicePixelRatio || 1 });
    };
    const sizes = new ResizeObserver(resize);
    sizes.observe(canvas);
    resize();

    const visibility = (): void => engine.input({ kind: "visibility", visible: document.visibilityState !== "hidden" });
    document.addEventListener("visibilitychange", visibility);
    visibility();

    // The pointer names the card under it for the native title, as the DOM did.
    const hover = (event: PointerEvent): void => {
      const hit = api.pick({ x: event.clientX, y: event.clientY });
      wires?.setHover(hit?.wireId);
      const title = hit?.nodeId === undefined ? "" : mirror.card(hit.nodeId)?.text ?? "";
      if (canvas.title !== title) canvas.title = title;
    };
    const leave = (): void => {
      wires?.setHover(undefined);
      canvas.title = "";
    };
    canvas.addEventListener("pointermove", hover, { passive: true });
    canvas.addEventListener("pointerleave", leave, { passive: true });

    // The camera the rest of the app asks for, and the focus target.
    const offFit = state$.fitViewRequest.onChange(() => api.fit());
    const offZoom = canvasZoomRequest$.onChange(() => {
      const asked = canvasZoomRequest$.peek();
      if (asked === null) return;
      if (asked.kind === "in") api.zoomBy(1.2, { durationMs: 160 });
      else if (asked.kind === "out") api.zoomBy(1 / 1.2, { durationMs: 160 });
      else api.zoomTo(1, { durationMs: 200 });
    });
    const runFocus = (id: string): void => {
      if (id === "") return;
      selectNode(id);
      api.focusNodes([id], { durationMs: 360 });
      state$.focusNodeId.set("");
    };
    const offFocus = state$.focusNodeId.onChange(() => runFocus(state$.focusNodeId.peek()));

    const minimap = createGpuMinimapSource(mirror, api);
    setCanvasApi(api);
    setMinimapSource(minimap);
    const offHook = installCanvasTestHook(mirror, () => engineRef.current);

    return () => {
      offDelete();
      offHands();
      offInput();
      offHook();
      offScene();
      offFocus();
      offZoom();
      offFit();
      offRects();
      offViewport();
      canvas.removeEventListener("pointermove", hover);
      canvas.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", visibility);
      sizes.disconnect();
      offTheme();
      offKeeper();
      clearMinimapSource(minimap);
      clearCanvasApi(api);
      // Only a camera this canvas was handed, or placed, goes back: one it
      // never showed must not stand in for the old canvas's opening camera.
      if (state$.canvasName.peek() === canvasName) leaveCamera(canvasName, engine.camera());
      clearCanvasTier();
      if (mounted === engine) mounted = undefined;
      engineRef.current = undefined;
      api.dispose();
      engine.dispose();
    };
  }, [api, mirror, runtime]);

  return (
    <CanvasApiProvider api={api}>
      <canvas
        ref={ref}
        className="junto-gpu-canvas junto-canvas block h-full w-full"
        data-canvas-scope
        data-testid="gpu-canvas"
        tabIndex={-1}
      />
      <CanvasMenus />
    </CanvasApiProvider>
  );
}

