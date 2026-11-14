/**
 * The GPU canvas's CanvasApi (docs/canvas-gpu-architecture.md, sections 16 and
 * 19). Values come from the shell's mirror, never from the engine on demand,
 * so they are synchronous even while a frame is pending. Camera moves are
 * eased here and handed to the engine; the engine's frame facts feed the
 * camera back, so an input-driven move and a requested one land in the same
 * listeners.
 */

import type {
  Camera,
  CameraMoveOptions,
  CameraTarget,
  CanvasApi,
  CanvasLensHandle,
  CanvasTier,
  EngineStats,
  Hit,
  NodeId,
  Point,
  Rect,
  SceneOp,
  WireMode,
} from "../contract";
import type { SeamEngine } from "../engine/engine";
import { cameraForTarget, interpolateCamera, sameCamera } from "./camera-targets";
import { createGpuLensSession, type GpuLensSession } from "./gpu-lens";
import type { SurfaceMirror } from "./surface-mirror";

type Scheduler = {
  readonly request: (frame: (now: number) => void) => number;
  readonly cancel: (handle: number) => void;
};

const browserScheduler: Scheduler = {
  request: (frame) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(frame) : setTimeout(() => frame(Date.now()), 16) as unknown as number),
  cancel: (handle) => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
    else clearTimeout(handle);
  },
};

const EMPTY_STATS: EngineStats = {
  frames: 0,
  generation: 0,
  uploadedBytes: 0,
  lastUploadRanges: [],
  lastFrameMs: 0,
  rasterQueue: 0,
};

export type GpuCanvasApi = CanvasApi & {
  readonly attachEngine: (engine: SeamEngine) => void;
  readonly applyScene: (ops: ReadonlyArray<SceneOp>) => void;
  /** While the loupe is held, what the lens shows at a canvas-local screen point — the engine's pick override. */
  readonly lensPick: (screen: Point) => Hit | undefined;
  readonly dispose: () => void;
};

export const createGpuCanvasApi = (
  mirror: SurfaceMirror,
  options: { readonly scheduler?: Scheduler } = {},
): GpuCanvasApi => {
  const scheduler = options.scheduler ?? browserScheduler;
  let engine: SeamEngine | undefined;
  let offFrame: (() => void) | undefined;
  let animation: number | undefined;
  let disposed = false;
  // The magnifier's lens: one session at a time, fed by applyScene's fan-out.
  // The lens portals in a frame after this canvas's effect starts the feed,
  // so ops collect in `lensBuffer` until the first attach flushes them; once
  // a session exists ops go straight to it, and a failed attach (no WebGPU
  // context) closes the buffer for good — the magnifier keeps its own path.
  const lensBox: { session: GpuLensSession | undefined; active: boolean } = {
    session: undefined,
    active: false,
  };
  let lensBuffer: SceneOp[] | null = [];
  const LENS_BUFFER_MAX = 50_000;

  const viewport = () => mirror.viewport();

  const applyCamera = (camera: Camera): void => {
    mirror.setCamera(camera);
    engine?.moveCamera(camera);
  };

  const stopAnimation = (): void => {
    if (animation !== undefined) scheduler.cancel(animation);
    animation = undefined;
  };

  const animateTo = (to: Camera, durationMs: number | undefined): void => {
    stopAnimation();
    const from = mirror.camera();
    if (durationMs === undefined || durationMs <= 0 || sameCamera(from, to)) {
      applyCamera(to);
      return;
    }
    const started = typeof performance === "undefined" ? Date.now() : performance.now();
    const step = (now: number): void => {
      animation = undefined;
      if (disposed) return;
      const t = Math.min(1, (now - started) / durationMs);
      applyCamera(interpolateCamera(from, to, t));
      if (t < 1) animation = scheduler.request(step);
    };
    animation = scheduler.request(step);
  };

  const cameraTo = (target: CameraTarget, options?: CameraMoveOptions): Camera =>
    cameraForTarget(target, mirror.camera(), viewport(), (ids) => mirror.boundsOf(ids));

  const api: GpuCanvasApi = {
    attachEngine: (next) => {
      offFrame?.();
      engine = next;
      // The mirror follows the engine's frames: the camera, and the live
      // rectangle of every card a pointer is dragging or resizing. Overlays
      // and anchors read those rectangles, so they cannot stay where the row
      // left the card.
      offFrame = mirror.attachLive({
        rectOf: (id) => next.rectOf(id),
        onFrame: (listener) => next.onFrame(listener),
      });
    },
    applyScene: (ops) => {
      mirror.apply(ops);
      engine?.apply(ops);
      const session = lensBox.session;
      if (session !== undefined) {
        session.apply(ops);
      } else if (lensBuffer !== null) {
        lensBuffer.push(...ops);
        if (lensBuffer.length > LENS_BUFFER_MAX) {
          lensBuffer.splice(0, lensBuffer.length - LENS_BUFFER_MAX);
        }
      }
    },
    lensPick: (screen) => {
      const session = lensBox.session;
      if (!lensBox.active || session === undefined) return undefined;
      // Engine points are canvas-local; the mirror's are page pixels.
      const element = mirror.element();
      const page =
        element === null
          ? screen
          : (() => {
              const rect = element.getBoundingClientRect();
              return { x: screen.x + rect.left, y: screen.y + rect.top };
            })();
      return session.pick(mirror.screenToBoard(page));
    },
    lens: {
      attach: (surface) => {
        lensBox.session?.dispose();
        const session = createGpuLensSession(surface);
        lensBox.session = session;
        const buffered = lensBuffer;
        lensBuffer = null;
        if (session === undefined) return undefined;
        if (buffered !== null && buffered.length > 0) session.apply(buffered);
        session.setActive(lensBox.active);
        const handle: CanvasLensHandle = {
          lookAt: (at) => session.lookAt(at),
          pick: (at) => session.pick(at),
          setActive: (on) => session.setActive(on),
          ready: () => session.ready(),
          dispose: () => {
            if (lensBox.session === session) lensBox.session = undefined;
            session.dispose();
          },
        };
        return handle;
      },
      setActive: (on) => {
        lensBox.active = on;
        lensBox.session?.setActive(on);
      },
    },
    screenToBoard: (screen) => mirror.screenToBoard(screen),
    boardToScreen: (board) => mirror.boardToScreen(board),
    camera: () => mirror.camera(),
    onCamera: (listener) => mirror.onCamera(listener),
    moveCamera: (target, options) => {
      animateTo(cameraTo(target, options), options?.durationMs);
    },
    fit: (options) => {
      const rects = mirror.cardIds().map((id) => mirror.boardRectOf(id)).filter((rect): rect is Rect => rect !== undefined);
      if (rects.length === 0) return;
      const regions = mirror.regionIds().length > 0;
      const to = cameraForTarget(
        { kind: "fit", rects, padding: 0.18, maxZoom: regions ? 1.15 : 1.35 },
        mirror.camera(),
        viewport(),
        () => undefined,
      );
      animateTo(to, options?.durationMs ?? 320);
    },
    focusNodes: (ids, options) => {
      const rects = ids.map((id) => mirror.boardRectOf(id)).filter((rect): rect is Rect => rect !== undefined);
      if (rects.length === 0) return;
      const to = cameraForTarget(
        { kind: "fit", rects, padding: options?.padding ?? 0.35, maxZoom: options?.maxZoom ?? 1.45 },
        mirror.camera(),
        viewport(),
        () => undefined,
      );
      animateTo(to, options?.durationMs ?? 360);
    },
    zoomBy: (factor, options) => {
      animateTo(cameraTo({ kind: "zoomBy", factor }, options), options?.durationMs);
    },
    zoomTo: (zoom, options) => {
      animateTo(cameraTo({ kind: "zoomTo", zoom }, options), options?.durationMs);
    },
    rectOf: (id) => mirror.boardRectOf(id),
    boundsOf: (ids) => mirror.boundsOf(ids),
    screenRectOf: (id) => mirror.screenRectOf(id),
    pick: (screen) => {
      const full = engine as (SeamEngine & { readonly pick?: (at: Point) => Hit | null }) | undefined;
      if (full?.pick === undefined) return mirror.pick(screen);
      // The engine's input points are relative to the canvas element; the
      // CanvasApi's are page pixels. Subtract the canvas origin here, once.
      const element = mirror.element();
      const local = element === null
        ? screen
        : (() => {
            const rect = element.getBoundingClientRect();
            return { x: screen.x - rect.left, y: screen.y - rect.top };
          })();
      return full.pick(local);
    },
    anchor: (id, element) => mirror.anchor(id, element),
    setWireMode: (mode: WireMode) => {
      mirror.setWireMode(mode);
      engine?.apply([{ kind: "wireMode", mode }]);
    },
    tier: () => mirror.tier() as CanvasTier,
    element: () => mirror.element(),
    previewMoves: (moves) => {
      if (moves === null) return;
      const at = new Map(moves.map((move) => [move.id, move]));
      const ops: SceneOp[] = [];
      for (const id of mirror.cardIds()) {
        const move = at.get(id);
        const card = mirror.card(id);
        if (move === undefined || card === undefined) continue;
        ops.push({ kind: "card", fact: { id, row: { ...card.row, x: move.x, y: move.y }, derived: card.derived } });
      }
      if (ops.length > 0) api.applyScene(ops);
    },
    dispose: () => {
      disposed = true;
      stopAnimation();
      offFrame?.();
      offFrame = undefined;
      lensBox.session?.dispose();
      lensBox.session = undefined;
      lensBox.active = false;
      lensBuffer = null;
      engine = undefined;
    },
  };

  return api;
};

/** The engine's counters, with the fields a seam engine does not carry yet. */
export const engineStats = (engine: SeamEngine | undefined): EngineStats => {
  if (engine === undefined) return EMPTY_STATS;
  const stats = engine.stats() as unknown as Partial<EngineStats>;
  return {
    frames: stats.frames ?? 0,
    generation: stats.generation ?? 0,
    uploadedBytes: stats.uploadedBytes ?? 0,
    lastUploadRanges: stats.lastUploadRanges ?? [],
    lastFrameMs: stats.lastFrameMs ?? 0,
    rasterQueue: stats.rasterQueue ?? 0,
  };
};

export type { NodeId, Rect };
