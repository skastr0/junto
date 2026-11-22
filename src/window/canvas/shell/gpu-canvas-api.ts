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
  // The magnifier's lens (item 13 of issue 915): its surface draws this
  // canvas's engine a second time, through the lens's camera. It has no
  // scene of its own and takes no ops. One surface at a time; it reaches the
  // engine whenever both exist, in either order. A failed attach (no WebGPU
  // context) leaves the magnifier on its own path.
  type LensBox = {
    surface: HTMLCanvasElement | undefined;
    context: GPUCanvasContext | undefined;
    sizes: ResizeObserver | undefined;
    active: boolean;
    at: Point | undefined;
  };
  const lensBox: LensBox = { surface: undefined, context: undefined, sizes: undefined, active: false, at: undefined };

  const lensSize = (surface: HTMLCanvasElement): { width: number; height: number; pixelRatio: number } => {
    const rect = surface.getBoundingClientRect();
    return { width: rect.width, height: rect.height, pixelRatio: window.devicePixelRatio || 1 };
  };

  /** Hand the lens surface to the engine, when both are here. */
  const lensToEngine = (): void => {
    const surface = lensBox.surface;
    const context = lensBox.context;
    if (engine === undefined || surface === undefined || context === undefined) return;
    const size = lensSize(surface);
    engine.lens.attach(surface, context, size.width, size.height, size.pixelRatio);
    engine.lens.setActive(lensBox.active);
    if (lensBox.at !== undefined) engine.lens.lookAt(lensBox.at);
  };

  const setLensActive = (on: boolean): void => {
    lensBox.active = on;
    if (lensBox.surface !== undefined) engine?.lens.setActive(on);
  };

  const detachLens = (surface: HTMLCanvasElement): void => {
    if (lensBox.surface !== surface) return;
    lensBox.sizes?.disconnect();
    engine?.lens.detach(surface);
    lensBox.surface = undefined;
    lensBox.context = undefined;
    lensBox.sizes = undefined;
  };

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
    // The engine flies the move in its own frame (issue 915): one loop sets
    // the camera and draws, and the mirror follows the frames it presents.
    if (engine !== undefined) {
      engine.moveCamera({ kind: "camera", camera: to }, { durationMs, path: "straight" });
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
      lensToEngine();
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
    },
    lensPick: (screen) => {
      const lens = engine?.lens;
      if (!lensBox.active || lensBox.surface === undefined || lens === undefined) return undefined;
      // Engine points are canvas-local; the mirror's are page pixels.
      const element = mirror.element();
      const page =
        element === null
          ? screen
          : (() => {
              const rect = element.getBoundingClientRect();
              return { x: screen.x + rect.left, y: screen.y + rect.top };
            })();
      return lens.pick(mirror.screenToBoard(page));
    },
    lens: {
      attach: (surface) => {
        if (lensBox.surface !== undefined) detachLens(lensBox.surface);
        // The DOM lib types WebGPU but not this overload of getContext.
        const context = surface.getContext("webgpu") as GPUCanvasContext | null;
        if (context === null) return undefined;
        lensBox.surface = surface;
        lensBox.context = context;
        if (typeof ResizeObserver === "function") {
          const sizes = new ResizeObserver(() => {
            const size = lensSize(surface);
            engine?.lens.resize(size.width, size.height, size.pixelRatio);
          });
          sizes.observe(surface);
          lensBox.sizes = sizes;
        }
        lensToEngine();
        const handle: CanvasLensHandle = {
          lookAt: (at) => {
            lensBox.at = at;
            engine?.lens.lookAt(at);
          },
          pick: (at) => engine?.lens.pick(at),
          setActive: setLensActive,
          ready: () => engine?.lens.ready() ?? false,
          dispose: () => detachLens(surface),
        };
        return handle;
      },
      setActive: setLensActive,
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
      if (lensBox.surface !== undefined) detachLens(lensBox.surface);
      lensBox.active = false;
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
    ...(stats.blank === undefined ? {} : { blank: stats.blank }),
    ...(stats.bufferFailures === undefined ? {} : { bufferFailures: stats.bufferFailures }),
    ...(stats.gpuPass === undefined ? {} : { gpuPass: stats.gpuPass }),
    ...(stats.cull === undefined ? {} : { cull: stats.cull }),
    ...(stats.cullFrames === undefined ? {} : { cullFrames: stats.cullFrames }),
    ...(stats.frameMsTotal === undefined ? {} : { frameMsTotal: stats.frameMsTotal }),
    ...(stats.damage === undefined ? {} : { damage: stats.damage }),
  };
};

export type { NodeId, Rect };
