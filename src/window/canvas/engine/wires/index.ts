/**
 * Track D's wire layer, as the engine hosts it (`EngineHost.wires`).
 *
 *   apply     every op the wire scene reads: `load`, `wire`, `removeWire`,
 *             `routes`, `selection`, `theme`, `wireMode`, `preview`, `pulse`
 *   frame     once per drawn frame, before `upload`: the camera, the surface,
 *             the tier and the wall clock; true while anything visible moves
 *   upload    the device's copy of what changed, then
 *   encodeRest / encodeTracks   the two draws between the engine's bands
 *   hit       the wire a board point picks (loupe or cone only)
 *   busy      whether the engine must keep drawing for a pulse, a track or a fade
 *
 * The layer reads cards' live rectangles through `rectOf` each frame, so a
 * drag moves a wire with no message of its own: wires on a moved card fall
 * back to the elbow, and return to the loom's route when the model has taken
 * the move and the loom has answered.
 */

import type { ThemeMode } from "@shared/theme";
import type { NodeId, Point, Rect, SceneOp, WireId } from "../../contract";
import type { DeviceKeeper } from "../device";
import { createWireGpu, type UploadRange, type WireLensFrame } from "./gpu";
import { createWireScene, type WireFrame, type WireInspect, type WireLabel } from "./scene";

export type { WireFrame, WireInspect, WireLabel, UploadRange };

export type WireLayerOptions = {
  /** A card's live board rectangle. */
  readonly rectOf: (id: NodeId) => Rect | undefined;
  /** The visible body a card draws at this tier, when it is narrower than the card. */
  readonly surfaceOf?: (id: NodeId) => Rect | undefined;
  /** The device keeper: the layer builds on the ready device and its surface format. */
  readonly device: DeviceKeeper;
  readonly mode?: ThemeMode;
  readonly reducedMotion?: () => boolean;
  /** Draw a wire only once the loom has sent its route (`WireHost.awaitRoutes`). */
  readonly awaitRoutes?: boolean;
};

/** The layer's own counters, for a real-Electron measurement (the canvas test hook). */
export type WireStats = {
  readonly frames: number;
  /** Script time inside `frame` over the last frame and since the layer was made, ms. */
  readonly lastFrameMs: number;
  readonly frameMsTotal: number;
  /** Wires rebuilt (a strip rebuilt) since the layer was made. */
  readonly rebuilds: number;
  /** Draw calls the last encoded frame issued for wires, glow, tracks and pulses. */
  readonly draws: number;
  /** Index count the last encoded frame's visible draw covered. */
  readonly indices: number;
  /** Bytes the last upload wrote. */
  readonly uploadBytes: number;
  /** Wires the scene holds. */
  readonly wires: number;
  /** The last tier-crossing repaint, ms. */
  readonly refreshMs: number;
  /** The last motion step: the wires' tweens and pulses, ms. */
  readonly stepMs: number;
  /** Every strip pool's CPU bytes: what keeping a body and a pill strip costs. */
  readonly poolBytes: number;
  /** Wires the loom has not answered yet, all and in view: drawn as nothing until it does. */
  readonly waiting: { readonly total: number; readonly inView: number };
};

export type WiresLayer = {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
  readonly frame: (frame: WireFrame) => boolean;
  readonly upload: (device: GPUDevice) => void;
  readonly encodeRest: (pass: GPURenderPassEncoder) => void;
  readonly encodeTracks: (pass: GPURenderPassEncoder) => void;
  /** The lens's camera for the same strips, then its draws (item 13 of issue 915). */
  readonly uploadLens: (lens: WireLensFrame) => void;
  readonly encodeLensRest: (pass: GPURenderPassEncoder) => void;
  readonly encodeLensTracks: (pass: GPURenderPassEncoder) => void;
  readonly hit: (at: Point) => WireId | undefined;
  readonly busy: (now: number) => boolean;
  /** The wire under the pointer, for hover glow; none clears it. */
  readonly setHover: (id: WireId | undefined) => void;
  /** Where a wire's invisible label button sits, in board units. */
  readonly labelOf: (id: WireId) => Point | undefined;
  /** The labels of the wires the camera can see, for the shell's select buttons. */
  readonly labelsInView: () => ReadonlyArray<WireLabel>;
  /** The last label whose button covers the board point. */
  readonly labelAt: (at: Point, half: number) => WireId | undefined;
  readonly labelsRevision: () => number;
  readonly inspect: (id: WireId) => WireInspect | undefined;
  readonly stats: () => WireStats;
  /** What the last upload wrote, buffer by buffer. */
  readonly lastUploads: () => ReadonlyArray<UploadRange>;
  readonly dispose: () => void;
};

export const createWireLayer = (options: WireLayerOptions): WiresLayer => {
  const scene = createWireScene({
    rectOf: options.rectOf,
    ...(options.surfaceOf ? { surfaceOf: options.surfaceOf } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
    ...(options.awaitRoutes === true ? { awaitRoutes: true } : {}),
  });
  const gpu = createWireGpu(scene);
  let wall = 0;
  let frames = 0;
  let lastFrameMs = 0;
  let frameMsTotal = 0;
  const clock = (): number => (typeof performance === "object" ? performance.now() : Date.now());
  return {
    apply: (ops) => {
      for (const op of ops) scene.apply(op);
    },
    frame: (frame) => {
      wall = frame.wall;
      const before = clock();
      const busy = scene.frame(frame);
      lastFrameMs = clock() - before;
      frameMsTotal += lastFrameMs;
      frames += 1;
      return busy;
    },
    upload: (device) => {
      const state = options.device.state();
      if (state.kind !== "ready") return;
      gpu.upload(device, state.format);
    },
    encodeRest: gpu.encodeRest,
    encodeTracks: gpu.encodeTracks,
    uploadLens: gpu.uploadLens,
    encodeLensRest: gpu.encodeLensRest,
    encodeLensTracks: gpu.encodeLensTracks,
    hit: scene.pick,
    busy: () => scene.busy(wall),
    setHover: scene.setHover,
    labelOf: scene.labelOf,
    labelsInView: scene.labelsInView,
    labelAt: scene.labelAt,
    labelsRevision: scene.labelsRevision,
    inspect: scene.inspect,
    stats: () => ({
      frames,
      lastFrameMs,
      frameMsTotal,
      rebuilds: scene.builds(),
      draws: gpu.draws(),
      indices: gpu.indices(),
      uploadBytes: gpu.lastBytes(),
      wires: scene.wires(),
      refreshMs: scene.refreshMs(),
      stepMs: scene.stepMs(),
      poolBytes: scene.poolBytes(),
      waiting: scene.waiting(),
    }),
    lastUploads: gpu.lastUploads,
    dispose: gpu.dispose,
  };
};
