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
import { farSeatScale, nodeScale, seatFloorScale, tierForZoom, type CanvasTier } from "@shared/canvas-tier";
import type {
  Camera,
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
import { CAMERA_MAX_ZOOM, CAMERA_MIN_ZOOM, TIER_BIT } from "../contract";
import type { DeviceKeeper, DeviceState } from "./device";
import {
  CAMERA_SETTLE_MS,
  centreCamera,
  easeCubicInOut,
  fitCamera,
  interpolateCamera,
  panCamera,
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
import { pickAt, type PickWorld } from "./pick";
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
};

export interface WireLayer {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
  /** The frame's camera, viewport, tier and wall clock, before `upload`. */
  readonly frame?: (facts: WireFrameFacts) => void;
  readonly upload: (device: GPUDevice) => void;
  readonly encodeRest: (pass: GPURenderPassEncoder) => void;
  readonly encodeTracks: (pass: GPURenderPassEncoder) => void;
  readonly hit: (at: Point) => WireId | undefined;
  readonly busy: (now: number) => boolean;
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
};

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
  let lastRanges: ReadonlyArray<{ buffer: string; offset: number; size: number }> = [];

  let settled = true;
  let settleAt = 0;
  let animation: { readonly from: Camera; readonly to: Camera; readonly start: number; readonly duration: number } | undefined;
  const keys = new Map<string, number>();
  let keyBoost = false;
  let pointerState: PointerState = POINTER_IDLE;
  let autoPan: Point | null = null;
  let preview: ConnectionPreview | null = null;
  /** The marquee box in board units; converted to screen at each frame. */
  let marquee: Rect | null = null;

  const frameListeners = new Set<(facts: FrameFacts) => void>();
  const intentListeners = new Set<(intent: Intent) => void>();
  const anchored = new Set<NodeId>();

  const scene = createScene({
    painter: host.painter ?? defaultPainter,
    mode: host.mode ?? "dark",
    ...(host.measure === undefined ? {} : { measure: host.measure }),
    ...(host.sourceOf === undefined ? {} : { source: host.sourceOf }),
    ...(host.atlasRevision === undefined ? {} : { atlasRevision: host.atlasRevision }),
    // The atlas keys a text raster by device pixels per board unit.
    scale: () => size.pixelRatio * camera.zoom,
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

  const pointerWorld: PointerWorld = {
    pick: (screen) => pickAt({ index: spatialIndex, card: scene.cardOf, wire: scene.wire, selection: scene.selection(), scale: camera.zoom, tier, wireMode: scene.wireMode, rectOf: scene.rectOf }, toBoard(camera, screen)),
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
        if (effect.rect === null) scene.restoreCard(effect.id);
        else scene.resizeCard(effect.id, effect.rect);
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
      if (intent.kind === "hover") scene.setHover(intent.hit?.nodeId ?? null);
      emit(intent);
    }
    for (const effect of step.effects) applyEffect(effect);
    if (step.intents.length > 0 || step.effects.length > 0) invalidate();
  };

  const emit = (intent: Intent): void => {
    for (const listener of [...intentListeners]) listener(intent);
  };

  const schedule = (): void => {
    if (disposed || !visible || pending !== undefined) return;
    if (keeper.state().kind !== "ready") return;
    const busy = dirty || animation !== undefined || keys.size > 0 || !settled || autoPan !== null || scene.hasMotion(wallNow()) || (host.wires?.busy(wallNow()) ?? false);
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
    animation = undefined;
  };

  const frame = (): void => {
    pending = undefined;
    if (disposed || !visible) return;
    const state = keeper.state();
    if (state.kind !== "ready") return;
    const start = clock();
    if (configuredGeneration !== state.generation) {
      context.configure({ device: state.device, format: state.format, alphaMode: "opaque" });
      renderer.configure(state.device, state.format, state.generation, scene, host.atlas);
      configuredGeneration = state.generation;
      dirty = true;
    }
    const device = state.device;

    // 1–2: the camera.
    if (animation !== undefined) {
      const t = animation.duration <= 0 ? 1 : Math.min(1, (start - animation.start) / animation.duration);
      camera = interpolateCamera(animation.from, animation.to, size, easeCubicInOut(t));
      markCameraMoved(start);
      dirty = true;
      if (t >= 1) animation = undefined;
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

    // 3: the visible set and the order list (culling by whole cards).
    const prepared = scene.prepare(viewRect(camera, size), tier);
    const wall = wallNow();
    scene.setWallClock(wall);
    if (prepared.orderChanged) dirty = true;

    // 5: uploads.
    const bands = scene.bandEnds;
    renderer.beginFrame(bands);
    renderer.writeUniform(scene, {
      width: size.width,
      height: size.height,
      pixelRatio: size.pixelRatio,
      wallMs: wall,
      camera,
      tierBit: TIER_BIT[tier],
      farSeat: farSeatScale(camera.zoom),
      seatFloor: seatFloorScale(camera.zoom),
      nodeScale: nodeScale(camera.zoom),
    });
    renderer.upload(scene, prepared);
    host.wires?.frame?.({ camera, width: size.width, height: size.height, pixelRatio: size.pixelRatio, tier, wall });
    host.wires?.upload(device);

    // 6: draw. Wires rest, then cards, then tracks, then lifted quads.
    const pixelWidth = Math.max(1, Math.round(size.width * size.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(size.height * size.pixelRatio));
    if (surface.width !== pixelWidth) surface.width = pixelWidth;
    if (surface.height !== pixelHeight) surface.height = pixelHeight;
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: ground,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    renderer.encode(pass, 0);
    host.wires?.encodeRest(pass);
    renderer.encode(pass, 1);
    host.wires?.encodeTracks(pass);
    renderer.encode(pass, 2);
    pass.end();
    device.queue.submit([encoder.finish()]);

    // 7: frame facts.
    const anchors: Array<{ id: NodeId; rect: Rect }> = [];
    for (const id of anchored) {
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
    dirty = false;

    const moving = scene.hasMotion(wallNow()) || (host.wires?.busy(wallNow()) ?? false);
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
      animation = { from: camera, to: target, start: now, duration };
      markCameraMoved(now);
      dirty = true;
      schedule();
      return;
    }
    cancelAnimation();
    setCamera(target, now);
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
  });

  const pick = (screen: Point): Hit | null => pickAt(pickWorld(), toBoard(camera, screen));

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
      scene.setWallClock(wallNow());
      for (const op of ops) {
        if (op.kind === "theme") ground = clearColour(themeRuntime(op.mode).ground ?? "");
        scene.apply(op);
      }
      host.wires?.apply(ops);
      invalidate();
    },
    input,
    invalidate,
    camera: () => camera,
    moveCamera,
    screenToBoard: (screen) => toBoard(camera, screen),
    boardToScreen: (board) => toScreen(camera, board),
    pick,
    rectOf: (id) => scene.rectOf(id),
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
    stats: (): EngineStats => ({
      frames,
      generation: configuredGeneration,
      uploadedBytes: renderer.totalBytes,
      lastUploadRanges: lastRanges,
      lastFrameMs,
      rasterQueue: 0,
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
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
