/**
 * The GPU canvas engine (docs/canvas-gpu-architecture.md, sections 4, 5, 6,
 * 11, 14).
 *
 * Facts in, intents and frame facts out. The engine imports only from
 * `src/shared/` and its own folder, and touches no global: the canvas, the
 * device keeper, the frame scheduler, the clock and the wall clock are handed
 * to it, so a test hands it fakes and a worker could host it unchanged.
 *
 * One requestAnimationFrame loop owns everything visible. Each frame: step the
 * camera (animation, keyboard pan), take the visible set from the grid, upload
 * the byte ranges that changed, draw the bands in order, report frame facts.
 * The loop draws every display frame while anything visible moves (a ring, a
 * pulse, the camera, a drag) and draws nothing while the picture would be
 * identical. It holds no timer, never lowers its rate and stops when no one
 * can see the canvas. The clock and the scheduler are injected.
 */

import { themeRuntime, type ThemeMode } from "@shared/theme";
import { farSeatScale, hoverCardScale, nodeScale, seatFloorScale, tierForZoom, type CanvasTier } from "@shared/canvas-tier";
import { SEAT_CONTENT_CENTRE_DX, SEAT_RING_CENTRE } from "@shared/node-geometry";
import type {
  Camera,
  MotionPeaks,
  CameraMoveOptions,
  CameraTarget,
  CanvasInput,
  Engine,
  EngineStats,
  FrameFacts,
  FrameScheduler,
  Hit,
  Intent,
  NodeId,
  Point,
  Quad,
  Rect,
  ConnectionPreview,
  SceneOp,
  SpatialIndex,
  TextRun,
  WireId,
} from "../contract";
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, LENS_ZOOM, TIER_BIT } from "../contract";
import type { DeviceKeeper, DeviceState } from "./device";
import {
  CAMERA_SETTLE_MS,
  centreCamera,
  easeCubicInOut,
  fitCamera,
  interpolateCamera,
  panCamera,
  straightCamera,
  panKeyForCode,
  rectToScreen,
  sameCamera,
  screenToBoard as toBoard,
  boardToScreen as toScreen,
  viewRect,
  wheelCamera,
} from "./camera";
import { defaultPainter } from "./paint-default";
import { createScene, type CardPainter } from "./scene";
import { createRenderer, type AtlasBinding } from "./renderer";
import { createGpuTimer, type GpuTimer } from "./gpu-timing";
import { damageRects, type PixelRect } from "./damage";
import { createGroundFill } from "./ground";

/** WebGPU's texture-usage flags, by the numbers the spec gives them. */
const TEXTURE_USAGE = { COPY_SRC: 0x01, COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10 } as const;
import { hoverCardPoint, hoverCardRect, pickAt, type HoveredCard, type PickWorld } from "./pick";
import { POINTER_IDLE, stepPointer, type PointerEffect, type PointerState, type PointerWorld } from "./pointer";

export type { Camera, CanvasInput, FrameScheduler, SceneOp };

/** The surface the engine sizes: an HTML or offscreen canvas, or a fake. */
export interface DrawSurface {
  width: number;
  height: number;
}

/**
 * The wire layer (track D). It owns its own buffers and pipelines and draws
 * between the bands; the engine gives it the device, the pass and the frame's
 * request to keep drawing while a pulse or track runs.
 */
/** What the wire layer needs each drawn frame, before its upload. */
export type WireFrameFacts = {
  readonly camera: Camera;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly tier: CanvasTier;
  readonly wall: number;
  /** Cards whose live rectangle a pointer owns this frame: a drag or a resize. */
  readonly live?: ReadonlySet<NodeId>;
};

export interface WireLayer {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
  /** The frame's camera, viewport, tier and wall clock, before `upload`. */
  readonly frame?: (facts: WireFrameFacts) => void;
  readonly upload: (device: GPUDevice) => void;
  readonly encodeRest: (pass: GPURenderPassEncoder) => void;
  readonly encodeTracks: (pass: GPURenderPassEncoder) => void;
  /** The lens's camera for the same strips, then its draws (item 13 of issue 915). */
  readonly uploadLens?: (lens: { readonly camera: Camera; readonly width: number; readonly height: number; readonly pixelRatio: number }) => void;
  readonly encodeLensRest?: (pass: GPURenderPassEncoder) => void;
  readonly encodeLensTracks?: (pass: GPURenderPassEncoder) => void;
  readonly hit: (at: Point) => WireId | undefined;
  /** The wire whose label button covers the point, in board units. */
  readonly labelAt?: (at: Point, half: number) => WireId | undefined;
  readonly busy: (now: number) => boolean;
  /** The ranges the last `upload` wrote; any at all means wires changed this frame. */
  readonly lastUploads?: () => ReadonlyArray<unknown>;
  readonly dispose?: () => void;
}

export interface EngineHost {
  readonly surface: DrawSurface;
  /** The surface's WebGPU context, which the shell asks the canvas for. */
  readonly context: GPUCanvasContext;
  readonly device: DeviceKeeper;
  readonly scheduler: FrameScheduler;
  /** Monotonic milliseconds: the frame's script time and the camera's clock. */
  readonly clock: () => number;
  /** Epoch milliseconds, for ring phase and `land`. Defaults to `clock`. */
  readonly wallClock?: () => number;
  readonly camera?: Camera;
  /** True on macOS, where Meta is the zoom key and ctrl+wheel is a pinch. */
  readonly mac?: boolean;
  readonly mode?: ThemeMode;
  /** Track C's painter; the engine's default paints shapes and rings until it lands. */
  readonly painter?: CardPainter;
  /** Track D's wire layer; the engine calls its band hooks. */
  readonly wires?: WireLayer;
  /** Track B's atlas, once it exists. */
  readonly atlas?: AtlasBinding;
  /** The atlas's answer for a quad's text or sprite cell, or NO_ATLAS_CELL. */
  readonly sourceOf?: (quad: Quad, scale: number) => number;
  /** The atlas's cell-table revision; a change re-uploads the UV table. */
  readonly atlasRevision?: () => number;
  /**
   * The atlas's referenced cells (issue 911/issue 912): records take and let go of
   * cells, and the scene rasterizes an in-view cell with no image before the
   * frame is submitted. Wins over `sourceOf`.
   */
  readonly cells?: {
    acquire(quad: Quad, scale: number, previous?: number): number;
    release(cell: number): void;
    hasImage(cell: number): boolean;
    ensureNow(cell: number): unknown;
    recordVisibleBlank?(count: number): void;
    /** Decode a sprite's source ahead, held while any built quad uses it. */
    prepareSource?(quad: Quad): void;
    releaseSource?(quad: Quad): void;
  };
  /** Where the measured camera and raster peaks are kept between sessions. */
  readonly peaks?: {
    load(): MotionPeaks | undefined;
    save(peaks: MotionPeaks): void;
  };
  /**
   * The app's surface motion gate (hidden window, reduced motion). A ring's
   * rest pose draws only while motion is off, its moving parts only while it
   * runs. Defaults to live.
   */
  readonly motionLive?: () => boolean;
  /**
   * Region watermarks at a zoom (`region-glance.ts`): the outer and nested
   * opacities the region painter bakes into its name quads.
   */
  readonly glance?: (zoom: number) => { readonly region: number; readonly sub: number };
  /** Text measurement for the painter; the shell hands the browser's. */
  readonly measure?: (run: TextRun) => number;
  /**
   * The wire grammar and region hold the pointer machine asks about. The
   * shell supplies them from the model's own writers; without them a drag
   * moves cards and a connection needs the shell's verb list.
   */
  readonly hands?: {
    readonly canConnect: (source: NodeId, target: NodeId) => boolean;
    readonly verbsFor: (source: NodeId, target: NodeId) => ReadonlyArray<string>;
    readonly riders: (regionId: NodeId) => ReadonlyArray<NodeId>;
  };
  /**
   * The magnifier's lens, while the loupe is up: every pick — the pointer
   * machine's and the shell's — answers what the lens shows at the canvas
   * point asked, near tier, instead of this canvas's own hit. `undefined`
   * falls through to the canvas's own pick, so a lens that has not been fed
   * yet changes nothing. The screen point is canvas-local, as `pick` takes.
   */
  readonly lensPick?: (screen: Point) => Hit | undefined;
}

/** The seam's frame facts; now the contract's. */
export type SeamFrameFacts = FrameFacts;

/** The seam's counters; now the contract's. */
export type SeamStats = EngineStats;

/**
 * The seam's engine: the contract's `Engine`, with `moveCamera` also taking a
 * bare `Camera` while the shell's hand-over still hands one.
 */
export type SeamEngine = Omit<Engine, "moveCamera"> & {
  readonly moveCamera: (to: CameraTarget | Camera, options?: CameraMoveOptions) => void;
  /** The magnifier's lens: this engine's scene drawn again through the lens's camera (item 13 of issue 915). */
  readonly lens: EngineLens;
};

export interface EngineLens {
  readonly attach: (surface: DrawSurface, context: GPUCanvasContext, width: number, height: number, pixelRatio: number) => void;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  readonly detach: (surface: DrawSurface) => void;
  readonly setActive: (on: boolean) => void;
  readonly lookAt: (at: Point) => void;
  readonly pick: (at?: Point) => Hit | undefined;
  readonly ready: () => boolean;
}

const HOME: Camera = { x: 0, y: 0, zoom: 1 };

/** A theme colour, as the theme projects it for runtimes that cannot read CSS. */
const clearColour = (hex: string): GPUColorDict => {
  const digits = hex.replace("#", "");
  const channel = (at: number): number => parseInt(digits.slice(at, at + 2), 16) / 255;
  return { r: channel(0), g: channel(2), b: channel(4), a: 1 };
};

const isCameraTarget = (value: CameraTarget | Camera): value is CameraTarget =>
  "kind" in value && (value.kind === "camera" || value.kind === "fit" || value.kind === "centre" || value.kind === "zoomBy" || value.kind === "zoomTo");

export const createEngine = (host: EngineHost): SeamEngine => {
  const { surface, context, device: keeper, scheduler, clock } = host;
  const wallClock = host.wallClock ?? clock;
  const mac = host.mac ?? false;

  let camera: Camera = host.camera ?? HOME;
  let tier: CanvasTier = tierForZoom(camera.zoom);
  let ground = clearColour(themeRuntime(host.mode ?? "dark").ground ?? "");
  let size = { width: 0, height: 0, pixelRatio: 1 };
  let visible = true;
  let dirty = true;
  let disposed = false;
  let frames = 0;
  let pending: number | undefined;
  let configuredGeneration = 0;
  let lastFrameAt = 0;
  let lastFrameMs = 0;
  /** The frame the canvas shows, kept so a motion-only frame redraws only its damage. */
  let kept: { texture: GPUTexture; width: number; height: number; valid: boolean; atlasRevision: number } | undefined;
  /** The ground each damage rectangle starts from, as a cleared frame does. */
  const groundFill = createGroundFill();
  /** Device pixels the last frame shaded, and the running sums against the screen's. */
  let lastDrawnPixels = 0;
  let drawnPixelsTotal = 0;
  let screenPixelsTotal = 0;
  /** Every frame's CPU time summed, so a window's mean is a difference. */
  let frameMsTotal = 0;
  let lastRanges: ReadonlyArray<{ buffer: string; offset: number; size: number }> = [];

  let settled = true;
  let settleAt = 0;
  let animation:
    | { readonly from: Camera; readonly to: Camera; readonly start: number; readonly duration: number; readonly straight: boolean }
    | undefined;
  const keys = new Map<string, number>();
  let keyBoost = false;
  let pointerState: PointerState = POINTER_IDLE;
  let autoPan: Point | null = null;
  let preview: ConnectionPreview | null = null;
  /** The marquee box in board units; converted to screen at each frame. */
  let marquee: Rect | null = null;
  /** Cards whose drawn rectangle a pointer owns right now, for live anchors. */
  const draggingAnchors = new Set<NodeId>();

  const frameListeners = new Set<(facts: FrameFacts) => void>();
  const intentListeners = new Set<(intent: Intent) => void>();
  const anchored = new Set<NodeId>();

  const scene = createScene({
    painter: host.painter ?? defaultPainter,
    mode: host.mode ?? "dark",
    ...(host.measure === undefined ? {} : { measure: host.measure }),
    ...(host.sourceOf === undefined ? {} : { source: host.sourceOf }),
    ...(host.atlasRevision === undefined ? {} : { atlasRevision: host.atlasRevision }),
    ...(host.cells === undefined
      ? {}
      : {
          acquire: (quad: Quad, scale: number, previous?: number) => host.cells!.acquire(quad, scale, previous),
          release: (cell: number) => host.cells!.release(cell),
          hasImage: (cell: number) => host.cells!.hasImage(cell),
          ensureNow: (cell: number) => {
            host.cells!.ensureNow(cell);
          },
          ...(host.cells.prepareSource === undefined || host.cells.releaseSource === undefined
            ? {}
            : {
                prepareSource: (quad: Quad) => host.cells!.prepareSource!(quad),
                releaseSource: (quad: Quad) => host.cells!.releaseSource!(quad),
              }),
        }),
    ...(host.motionLive === undefined ? {} : { motionLive: host.motionLive }),
    ...(host.glance === undefined ? {} : { glance: host.glance }),
    // Section 8 rule 2: nothing re-rasterizes mid-gesture; every visible run
    // is exact once the camera rests.
    settled: () => settled,
    // The frame clock, for the margin measured from camera speed and raster latency.
    now: () => clock(),
    ...(() => {
      const kept = host.peaks?.load();
      return kept === undefined ? {} : { peaks: kept };
    })(),
    // The atlas keys a raster by device pixels per board unit, and a quad's
    // scale rule multiplies it (a far ring is drawn larger than the camera).
    scale: () => size.pixelRatio * camera.zoom,
    zoom: () => camera.zoom,
  });
  const renderer = createRenderer();

  const wallNow = (): number => wallClock();

  const sideOf = (handle: string): ConnectionPreview["fromSide"] => {
    if (handle.endsWith("top")) return "top";
    if (handle.endsWith("right")) return "right";
    if (handle.endsWith("bottom")) return "bottom";
    return "left";
  };

  /** The scene's index, with the wire layer's hit answering for wire candidates. */
  const spatialIndex: SpatialIndex = {
    ...scene.index,
    wiresAt: (at) => {
      const id = host.wires?.hit(at);
      return id === undefined ? [] : [id];
    },
  };

  /** The magnifier's answer while the loupe is up; undefined is the canvas's own pick. */
  const viaLens = (screen: Point): Hit | undefined => host.lensPick?.(screen);

  /**
   * The lens (item 13 of issue 915): the magnifier's surface draws this
   * engine's scene a second time, through a camera centred on the loupe's
   * board point at LENS_ZOOM, at that zoom's tier. One scene, one atlas, one
   * set of buffers: the lens adds a uniform, a short draw list and a pass.
   * Closed, it costs nothing; it never takes ops of its own.
   */
  type LensTarget = {
    readonly surface: DrawSurface;
    readonly context: GPUCanvasContext;
    width: number;
    height: number;
    pixelRatio: number;
    configured: number;
  };
  let lensTarget: LensTarget | undefined;
  let lensActive = false;
  let lensAt: Point | undefined;
  let loaded = false;
  const lensTier = tierForZoom(LENS_ZOOM);
  const lensOn = (): boolean => lensActive && lensAt !== undefined && lensTarget !== undefined && lensTarget.width > 0 && lensTarget.height > 0;
  const lensCamera = (): Camera | undefined =>
    lensOn() ? centreCamera({ width: lensTarget!.width, height: lensTarget!.height }, lensAt!, LENS_ZOOM) : undefined;
  const lensWorld = (): PickWorld => ({
    index: { ...spatialIndex, cardsAt: scene.lensIndex.cardsAt, cardsNear: scene.lensIndex.cardsNear },
    card: scene.cardOf,
    wire: scene.wire,
    selection: scene.selection(),
    scale: LENS_ZOOM,
    tier: lensTier,
    wireMode: scene.wireMode,
    rectOf: scene.rectOf,
  });

  /** Draw the lens's pass into its own surface, in the frame's encoder. */
  const encodeLens = (encoder: GPUCommandEncoder, device: GPUDevice, format: GPUTextureFormat, generation: number, lensCam: Camera, shaderNow: number): void => {
    const target = lensTarget!;
    if (target.configured !== generation) {
      target.context.configure({ device, format, alphaMode: "opaque" });
      target.configured = generation;
    }
    const pixelWidth = Math.max(1, Math.round(target.width * target.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(target.height * target.pixelRatio));
    if (target.surface.width !== pixelWidth) target.surface.width = pixelWidth;
    if (target.surface.height !== pixelHeight) target.surface.height = pixelHeight;
    renderer.uploadLens(scene, {
      width: target.width,
      height: target.height,
      pixelRatio: target.pixelRatio,
      wallMs: shaderNow,
      camera: lensCam,
      tierBit: TIER_BIT[lensTier],
      farSeat: farSeatScale(LENS_ZOOM),
      seatFloor: seatFloorScale(LENS_ZOOM),
      nodeScale: nodeScale(LENS_ZOOM),
      hoverScale: hoverCardScale(LENS_ZOOM),
    });
    host.wires?.uploadLens?.({ camera: lensCam, width: target.width, height: target.height, pixelRatio: target.pixelRatio });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.context.getCurrentTexture().createView(), clearValue: ground, loadOp: "clear", storeOp: "store" }],
    });
    renderer.encodeLens(pass, 0);
    host.wires?.encodeLensRest?.(pass);
    renderer.encodeLens(pass, 1);
    host.wires?.encodeLensTracks?.(pass);
    renderer.encodeLens(pass, 2);
    pass.end();
  };

  /** The bloomed hit box of the card under the pointer, at mid and far. */
  const hoveredPick = (): HoveredCard | undefined => {
    if (tier !== "mid" && tier !== "far") return undefined;
    const id = scene.hoveredId();
    // A hovered region (its title or frame) or any card without a bloom keeps
    // its drawn shape: only a bloom's box takes the points it covers.
    if (id === null || !scene.hoveredBloom()) return undefined;
    const rect = scene.rectOf(id);
    if (rect === undefined) return undefined;
    const origin = { x: rect.x + SEAT_RING_CENTRE.x, y: rect.y + SEAT_RING_CENTRE.y };
    // At far the ring is held on the card's content-box centre; the bloom
    // scales about the ring and lands that ring on the same held point.
    const base = tier === "far"
      ? { x: rect.x + rect.width / 2 + SEAT_CONTENT_CENTRE_DX, y: rect.y + rect.height / 2 }
      : origin;
    return {
      id,
      rect: hoverCardRect(rect, origin, base, camera.zoom),
      toCard: (at) => hoverCardPoint(at, origin, base, camera.zoom),
    };
  };

  const pickWorld = (): PickWorld => ({
    index: spatialIndex,
    card: scene.cardOf,
    wire: scene.wire,
    selection: scene.selection(),
    scale: camera.zoom,
    tier,
    wireMode: scene.wireMode,
    rectOf: scene.rectOf,
    ...(host.wires?.labelAt === undefined ? {} : { labelAt: host.wires.labelAt }),
    // Badges paint above cards, so their hit is tested first.
    clusterAt: scene.clusterAt,
    ...(tier === "far" || tier === "overview" ? { drawn: { reach: scene.drawnReach(), at: scene.drawnAt } } : {}),
    ...(hoveredPick() === undefined ? {} : { hovered: hoveredPick() }),
  });

  const pickBoard = (at: Point): Hit | null => pickAt(pickWorld(), at);

  const pointerWorld: PointerWorld = {
    pick: (screen) => viaLens(screen) ?? pickBoard(toBoard(camera, screen)),
    screenToBoard: (screen) => toBoard(camera, screen),
    viewport: () => size,
    rectOf: scene.rectOf,
    kindOf: (id) => scene.cardOf(id)?.row.kind,
    query: scene.query,
    selection: () => scene.selection().nodeIds,
    canConnect: (source, target) => host.hands?.canConnect(source, target) ?? source !== target,
    verbsFor: (source, target) => host.hands?.verbsFor(source, target) ?? [],
    riders: (regionId) => host.hands?.riders(regionId) ?? [],
  };

  const applyEffect = (effect: PointerEffect): void => {
    switch (effect.kind) {
      case "offset":
        if (effect.by === null) draggingAnchors.clear();
        else for (const id of effect.ids) draggingAnchors.add(id);
        for (const id of effect.ids) {
          if (effect.by === null) {
            scene.restoreCard(id);
            continue;
          }
          const fact = scene.cardOf(id);
          if (fact !== undefined) scene.moveCard(id, { x: fact.row.x + effect.by.x, y: fact.row.y + effect.by.y });
        }
        scene.setDragging(effect.by === null ? null : effect.ids);
        dirty = true;
        return;
      case "resizing":
        if (effect.rect === null) {
          draggingAnchors.delete(effect.id);
          scene.restoreCard(effect.id);
        } else {
          draggingAnchors.add(effect.id);
          scene.resizeCard(effect.id, effect.rect);
        }
        dirty = true;
        return;
      case "marquee":
        // The shell's overlay draws it outside React (track G): the frame
        // fact carries the box in screen pixels, converted here so it follows
        // an auto-pan between pointer moves. Null when the drag ends.
        marquee = effect.rect;
        dirty = true;
        return;
      case "connecting": {
        const next = effect.preview;
        preview = next === null
          ? null
          : { from: next.start, fromSide: sideOf(next.fromHandle), to: next.pointer };
        scene.setConnectTarget(next?.target ?? null);
        host.wires?.apply([{ kind: "preview", preview }]);
        dirty = true;
        return;
      }
      case "autoPan":
        autoPan = effect.perFrame;
        dirty = true;
        return;
      case "pan":
        setCamera({ x: camera.x + effect.by.x, y: camera.y + effect.by.y, zoom: camera.zoom }, clock());
        return;
      case "cluster": {
        const rects = effect.memberIds
          .map((id) => scene.rectOf(id))
          .filter((rect): rect is Rect => rect !== undefined);
        if (rects.length === 0) return;
        moveCamera({ kind: "fit", rects, padding: 0.35, maxZoom: 1 }, { durationMs: 260 });
        return;
      }
      default:
        return;
    }
  };

  const stepHand = (event: CanvasInput | { readonly kind: "tick" }): void => {
    const step = stepPointer(pointerState, event, pointerWorld);
    pointerState = step.state;
    for (const intent of step.intents) {
      if (intent.kind === "hover") {
        const part = intent.hit?.part;
        scene.setHover(
          intent.hit?.nodeId ?? null,
          part?.kind,
          intent.hit?.at,
          part?.kind === "handle" ? { side: part.side, role: part.role } : undefined,
        );
      }
      emit(intent);
    }
    for (const effect of step.effects) applyEffect(effect);
    if (step.intents.length > 0 || step.effects.length > 0) invalidate();
  };

  const emit = (intent: Intent): void => {
    for (const listener of [...intentListeners]) listener(intent);
  };

  let savedPeaks = "";
  let timer: GpuTimer | undefined;
  /**
   * Frames are timed once someone reads the stats (issue 915): a probe or the
   * proof asks, and the shell never does, so a session in use writes no
   * timestamps and maps no readback.
   */
  let timing = false;
  /** Keep the measured peaks when they move; a fresh boot starts from them. */
  const keepPeaks = (): void => {
    if (host.peaks === undefined) return;
    const peaks = scene.motionPeaks();
    const key = `${String(peaks.marginPx)}|${String(peaks.octaves)}|${String(peaks.latencyMs)}`;
    if (key === savedPeaks) return;
    savedPeaks = key;
    host.peaks.save(peaks);
  };

  const schedule = (): void => {
    if (disposed || !visible || pending !== undefined) return;
    if (keeper.state().kind !== "ready") return;
    const busy = dirty || lensOn() || animation !== undefined || keys.size > 0 || !settled || autoPan !== null || scene.hasMotion(clock()) || (host.wires?.busy(wallNow()) ?? false);
    if (!busy) return;
    pending = scheduler.request(frame);
  };

  const invalidate = (): void => {
    dirty = true;
    schedule();
  };

  const markCameraMoved = (now: number): void => {
    settleAt = now;
    settled = false;
  };

  const setCamera = (next: Camera, now: number): void => {
    if (sameCamera(camera, next)) return;
    camera = next;
    markCameraMoved(now);
    dirty = true;
    schedule();
  };

  const cancelAnimation = (): void => {
    if (animation !== undefined) scene.prefetch(null);
    animation = undefined;
  };

  const frame = (): void => {
    pending = undefined;
    if (disposed || !visible) return;
    const state = keeper.state();
    if (state.kind !== "ready") return;
    const start = clock();
    if (configuredGeneration !== state.generation) {
      // The canvas takes the kept frame by copy (damage, issue 915): RENDER_ATTACHMENT | COPY_DST.
      context.configure({ device: state.device, format: state.format, alphaMode: "opaque", usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_DST });
      kept?.texture.destroy();
      kept = undefined;
      renderer.configure(state.device, state.format, state.generation, scene, host.atlas);
      configuredGeneration = state.generation;
      timer?.destroy();
      timer = createGpuTimer(state.device);
      dirty = true;
    }
    const device = state.device;

    // 1–2: the camera.
    if (animation !== undefined) {
      const t = animation.duration <= 0 ? 1 : Math.min(1, (start - animation.start) / animation.duration);
      camera = animation.straight ? straightCamera(animation.from, animation.to, t) : interpolateCamera(animation.from, animation.to, size, easeCubicInOut(t));
      markCameraMoved(start);
      dirty = true;
      if (t >= 1) {
        animation = undefined;
        scene.prefetch(null);
      }
    }
    const frameMs = lastFrameAt === 0 ? 1000 / 60 : Math.max(0, start - lastFrameAt);
    lastFrameAt = start;
    if (keys.size > 0) {
      let oldest = start;
      for (const at of keys.values()) oldest = Math.min(oldest, at);
      const next = panCamera(camera, keys.keys(), frameMs, start - oldest, keyBoost);
      if (!sameCamera(camera, next)) {
        camera = next;
        markCameraMoved(start);
        dirty = true;
      }
    }
    if (!settled && start - settleAt >= CAMERA_SETTLE_MS) {
      settled = true;
      dirty = true;
    }
    if (autoPan !== null) {
      setCamera({ x: camera.x + autoPan.x, y: camera.y + autoPan.y, zoom: camera.zoom }, start);
      stepHand({ kind: "tick" });
    }
    const nextTier = tierForZoom(camera.zoom, tier);
    if (nextTier !== tier) {
      tier = nextTier;
      dirty = true;
    }

    // 3: the visible set and the order list (culling by whole cards). The
    // lens's view goes in first, so its cards take their cells in this pass.
    const lensCam = lensCamera();
    scene.setLens(lensCam === undefined ? undefined : { view: viewRect(lensCam, { width: lensTarget!.width, height: lensTarget!.height }), zoom: LENS_ZOOM });
    const prepared = scene.prepare(viewRect(camera, size), tier);
    const blank = scene.blankStats();
    keepPeaks();
    // The atlas's visibleBlank counter reads what this presented frame drew.
    host.cells?.recordVisibleBlank?.(blank.visibleBlank);
    const wall = wallNow();
    // The shader's clock is page-relative: `Date.now()` in a float32 uniform
    // quantizes to about two minutes, freezing every fade and every phase.
    const shaderNow = clock();
    scene.setClocks({ now: shaderNow, wall, frame: true });
    if (prepared.orderChanged) dirty = true;

    // 5: uploads.
    const bands = scene.bandEnds;
    renderer.beginFrame(bands);
    renderer.writeUniform(scene, {
      width: size.width,
      height: size.height,
      pixelRatio: size.pixelRatio,
      wallMs: shaderNow,
      camera,
      tierBit: TIER_BIT[tier],
      farSeat: farSeatScale(camera.zoom),
      seatFloor: seatFloorScale(camera.zoom),
      nodeScale: nodeScale(camera.zoom),
      hoverScale: hoverCardScale(camera.zoom),
    });
    renderer.upload(scene, prepared);
    host.wires?.frame?.({
      camera,
      width: size.width,
      height: size.height,
      pixelRatio: size.pixelRatio,
      tier,
      wall,
      // A card the pointer owns is drawn where the pointer holds it, not on
      // its row; the wire layer rebuilds only those wires from those ends.
      live: draggingAnchors,
    });
    host.wires?.upload(device);

    // 6: draw. Wires rest, then cards, then tracks, then lifted quads.
    const pixelWidth = Math.max(1, Math.round(size.width * size.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(size.height * size.pixelRatio));
    if (surface.width !== pixelWidth) surface.width = pixelWidth;
    if (surface.height !== pixelHeight) surface.height = pixelHeight;
    const encoder = device.createCommandEncoder();
    renderer.cull(encoder, () => (timing ? timer?.computeWrites() : undefined));
    const canvasTexture = context.getCurrentTexture();
    // Damage (issue 915): the frame is drawn into a kept texture and copied to the
    // canvas, so a frame that only motion drives redraws the pixels its
    // in-view movers reach and keeps the rest. Anything else (a camera move,
    // an op, an upload, a landed cell, a wire change, a style fade) draws whole.
    const keeping = typeof encoder.copyTextureToTexture === "function";
    let rects: PixelRect[] | undefined;
    if (keeping) {
      if (kept === undefined || kept.width !== pixelWidth || kept.height !== pixelHeight) {
        kept?.texture.destroy();
        kept = {
          texture: device.createTexture({
            size: [pixelWidth, pixelHeight, 1],
            format: state.format,
            usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC,
          }),
          width: pixelWidth,
          height: pixelHeight,
          valid: false,
          atlasRevision: -1,
        };
      }
      // A new atlas revision can rebind or rewrite texels no buffer range names.
      const uploaded =
        renderer.lastFrameRanges.some((range) => range.buffer !== "uniform") ||
        (host.wires?.lastUploads?.().length ?? 0) > 0 ||
        prepared.atlasRevision !== kept.atlasRevision;
      kept.atlasRevision = prepared.atlasRevision;
      const wholeFrame = dirty || !kept.valid || uploaded || (host.wires?.busy(wall) ?? false);
      const damage = wholeFrame ? undefined : scene.motionDamage(shaderNow);
      if (damage !== undefined) rects = damageRects(damage, camera, size.pixelRatio, { width: pixelWidth, height: pixelHeight });
      if (rects !== undefined) groundFill.prepare(device, state.format, ground);
    }
    const timestampWrites = timing ? timer?.writes() : undefined;
    const pass = encoder.beginRenderPass({
      ...(timestampWrites === undefined ? {} : { timestampWrites }),
      colorAttachments: [
        {
          view: (keeping ? kept!.texture : canvasTexture).createView(),
          clearValue: ground,
          loadOp: rects === undefined ? "clear" : "load",
          storeOp: "store",
        },
      ],
    });
    const drawAll = (): void => {
      renderer.encode(pass, 0);
      host.wires?.encodeRest(pass);
      renderer.encode(pass, 1);
      host.wires?.encodeTracks(pass);
      renderer.encode(pass, 2);
    };
    let drawnPixels = pixelWidth * pixelHeight;
    if (rects === undefined) {
      drawAll();
    } else {
      drawnPixels = 0;
      for (const rect of rects) {
        pass.setScissorRect(rect.x, rect.y, rect.width, rect.height);
        // The kept pixels under a rectangle are last frame's: the ground goes
        // back first, or every translucent fill there blends over itself.
        groundFill.encode(pass);
        drawAll();
        drawnPixels += rect.width * rect.height;
      }
    }
    pass.end();
    if (keeping) {
      encoder.copyTextureToTexture({ texture: kept!.texture }, { texture: canvasTexture }, [pixelWidth, pixelHeight, 1]);
      kept!.valid = true;
    }
    if (lensCam !== undefined) encodeLens(encoder, device, state.format, state.generation, lensCam, shaderNow);
    lastDrawnPixels = drawnPixels;
    drawnPixelsTotal += drawnPixels;
    screenPixelsTotal += pixelWidth * pixelHeight;
    timer?.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    timer?.collect();

    // 7: frame facts.
    const anchors: Array<{ id: NodeId; rect: Rect }> = [];
    const anchorIds = draggingAnchors.size === 0 ? anchored : new Set([...anchored, ...draggingAnchors]);
    for (const id of anchorIds) {
      const rect = scene.rectOf(id);
      if (rect !== undefined) anchors.push({ id, rect: rectToScreen(camera, rect) });
    }
    const facts: FrameFacts = {
      at: start,
      camera,
      tier,
      scales: { farSeat: farSeatScale(camera.zoom), seatFloor: seatFloorScale(camera.zoom), node: nodeScale(camera.zoom) },
      settled,
      anchors,
      marquee: marquee === null ? null : rectToScreen(camera, marquee),
    };
    for (const listener of [...frameListeners]) listener(facts);

    frames += 1;
    lastRanges = renderer.lastFrameRanges;
    lastFrameMs = clock() - start;
    frameMsTotal += lastFrameMs;
    dirty = false;

    // An open lens draws every display frame: its rings turn whatever the main view shows.
    const moving = lensOn() || scene.hasMotion(clock()) || (host.wires?.busy(wallNow()) ?? false);
    if (moving || animation !== undefined || keys.size > 0 || !settled || autoPan !== null) schedule();
  };

  const unsubscribe = keeper.subscribe((state: DeviceState) => {
    if (state.kind === "ready") invalidate();
  });

  const moveCamera = (to: CameraTarget | Camera, options?: CameraMoveOptions): void => {
    const now = clock();
    if (!isCameraTarget(to)) {
      cancelAnimation();
      setCamera(to, now);
      return;
    }
    let target: Camera;
    switch (to.kind) {
      case "camera":
        target = to.camera;
        break;
      case "fit": {
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (const rect of to.rects) {
          left = Math.min(left, rect.x);
          top = Math.min(top, rect.y);
          right = Math.max(right, rect.x + rect.width);
          bottom = Math.max(bottom, rect.y + rect.height);
        }
        if (!(right > left) || !(bottom > top)) return;
        target = fitCamera({ x: left, y: top, width: right - left, height: bottom - top }, size, to.padding, to.maxZoom);
        break;
      }
      case "centre":
        target = centreCamera(size, to.at, to.zoom ?? camera.zoom);
        break;
      case "zoomBy": {
        const about = to.about ?? { x: size.width / 2, y: size.height / 2 };
        const board = toBoard(camera, about);
        const zoom = Math.max(CAMERA_MIN_ZOOM, Math.min(CAMERA_MAX_ZOOM, camera.zoom * to.factor));
        target = { x: about.x - board.x * zoom, y: about.y - board.y * zoom, zoom };
        break;
      }
      case "zoomTo": {
        const about = to.about ?? { x: size.width / 2, y: size.height / 2 };
        const board = toBoard(camera, about);
        const zoom = Math.max(CAMERA_MIN_ZOOM, Math.min(CAMERA_MAX_ZOOM, to.zoom));
        target = { x: about.x - board.x * zoom, y: about.y - board.y * zoom, zoom };
        break;
      }
    }
    const duration = options?.durationMs ?? 0;
    if (duration > 0 && size.width > 0 && size.height > 0) {
      animation = { from: camera, to: target, start: now, duration, straight: options?.path === "straight" };
      // The destination's cards take their cells while the camera travels,
      // so the landing frame is never blank.
      scene.prefetch({ view: viewRect(target, size), zoom: target.zoom });
      markCameraMoved(now);
      dirty = true;
      schedule();
      return;
    }
    cancelAnimation();
    setCamera(target, now);
  };

  const pick = (screen: Point): Hit | null => viaLens(screen) ?? pickBoard(toBoard(camera, screen));

  const input = (event: CanvasInput): void => {
    switch (event.kind) {
      case "resize":
        size = { width: event.width, height: event.height, pixelRatio: event.pixelRatio };
        invalidate();
        return;
      case "visibility":
        visible = event.visible;
        stepHand(event);
        if (!visible && pending !== undefined) {
          scheduler.cancel(pending);
          pending = undefined;
        }
        if (visible) invalidate();
        return;
      case "wheel": {
        cancelAnimation();
        const outcome = wheelCamera(camera, {
          at: event.at,
          dx: event.dx,
          dy: event.dy,
          deltaMode: event.deltaMode,
          ctrl: event.modifiers.ctrl,
          meta: event.modifiers.meta,
          shift: event.modifiers.shift,
        }, mac);
        if (outcome.kind === "none") return;
        setCamera(outcome.camera, clock());
        return;
      }
      case "key": {
        if (event.modifiers.meta || event.modifiers.ctrl || event.modifiers.alt) {
          keys.clear();
          return;
        }
        const key = panKeyForCode(event.code);
        if (key === null) return;
        keyBoost = event.modifiers.shift;
        if (event.down) keys.set(key, clock());
        else keys.delete(key);
        dirty = true;
        schedule();
        return;
      }
      case "pointer":
        if (event.phase === "down" || event.phase === "move") cancelAnimation();
        stepHand(event);
        return;
    }
  };

  invalidate();

  return {
    apply: (ops) => {
      // A style change starts its transition at the wall clock of the fact,
      // not at the last frame's.
      scene.setClocks({ now: clock(), wall: wallNow() });
      for (const op of ops) {
        if (op.kind === "theme") ground = clearColour(themeRuntime(op.mode).ground ?? "");
        if (op.kind === "load") loaded = true;
        scene.apply(op);
      }
      host.wires?.apply(ops);
      invalidate();
    },
    input,
    invalidate,
    lens: {
      /** Draw the lens into this surface, sized in CSS pixels; false where it offers no WebGPU context. */
      attach: (surface: DrawSurface, context: GPUCanvasContext, width: number, height: number, pixelRatio: number): void => {
        lensTarget = { surface, context, width, height, pixelRatio, configured: -1 };
        schedule();
      },
      resize: (width: number, height: number, pixelRatio: number): void => {
        if (lensTarget === undefined) return;
        lensTarget.width = width;
        lensTarget.height = height;
        lensTarget.pixelRatio = pixelRatio;
        schedule();
      },
      detach: (surface: DrawSurface): void => {
        if (lensTarget?.surface !== surface) return;
        lensTarget.context.unconfigure?.();
        lensTarget = undefined;
        invalidate();
      },
      setActive: (on: boolean): void => {
        if (lensActive === on) return;
        lensActive = on;
        // Closing frees the lens's cells and list on the next frame.
        invalidate();
      },
      lookAt: (at: Point): void => {
        lensAt = at;
        schedule();
      },
      /** The hit at a board point in the lens's view, the crosshair's when absent; undefined until a board is loaded. */
      pick: (at?: Point): Hit | undefined => {
        const point = at ?? lensAt;
        if (!loaded || point === undefined) return undefined;
        return pickAt(lensWorld(), point);
      },
      ready: (): boolean => loaded,
    },
    camera: () => camera,
    moveCamera,
    screenToBoard: (screen) => toBoard(camera, screen),
    boardToScreen: (board) => toScreen(camera, board),
    pick,
    rectOf: (id) => scene.rectOf(id),
    surfaceOf: (id) => scene.surfaceOf(id),
    anchor: (id) => {
      anchored.add(id);
      invalidate();
      return () => {
        anchored.delete(id);
      };
    },
    onIntent: (listener) => {
      intentListeners.add(listener);
      return () => {
        intentListeners.delete(listener);
      };
    },
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    // At the wall clock when asked: the DOM phase test samples a live CSS
    // animation, and a last-frame angle can be a frame behind it.
    ringAngle: (id) => scene.ringAngle(id, wallNow()),
    partsOf: (id) => scene.partsOf(id),
    seatStats: () => scene.seatStats(),
    setCull: (mode) => {
      scene.setCullOnGpu(mode === "gpu");
      renderer.setCull(mode);
      invalidate();
    },
    badgePartsOf: (key) => scene.badgePartsOf(key),
    clusters: () => scene.clusters(),
    stats: (): EngineStats => ({
      frames,
      generation: configuredGeneration,
      uploadedBytes: renderer.totalBytes,
      lastUploadRanges: lastRanges,
      lastFrameMs,
      frameMsTotal,
      damage: { lastPixels: lastDrawnPixels, drawnPixelsTotal, screenPixelsTotal },
      rasterQueue: 0,
      blank: (({ visibleBlank, placeholders, ensuredNow, marginScreenPx, tierWindowOctaves }) => ({
        visibleBlank,
        placeholders,
        ensuredNow,
        marginScreenPx,
        tierWindowOctaves,
      }))(scene.blankStats()),
      bufferFailures: renderer.bufferFailures,
      gpuPass: (() => {
        timing = true;
        return timer?.times() ?? { available: false, samples: 0 };
      })(),
      cull: renderer.cullMode,
      cullFrames: renderer.cullFrames,
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      timer?.destroy();
      timer = undefined;
      groundFill.dispose();
      if (pending !== undefined) scheduler.cancel(pending);
      pending = undefined;
      animation = undefined;
      autoPan = null;
      pointerState = POINTER_IDLE;
      keys.clear();
      unsubscribe();
      frameListeners.clear();
      intentListeners.clear();
      anchored.clear();
      host.wires?.dispose?.();
      renderer.reset();
      context.unconfigure();
      configuredGeneration = 0;
    },
  };
};
