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
import { createWireGpu, type UploadRange } from "./gpu";
import { createWireScene, type WireFrame, type WireInspect } from "./scene";

export type { WireFrame, WireInspect, UploadRange };

export type WireLayerOptions = {
  /** A card's live board rectangle. */
  readonly rectOf: (id: NodeId) => Rect | undefined;
  /** The device keeper: the layer builds on the ready device and its surface format. */
  readonly device: DeviceKeeper;
  readonly mode?: ThemeMode;
  readonly reducedMotion?: () => boolean;
};

export type WiresLayer = {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
  readonly frame: (frame: WireFrame) => boolean;
  readonly upload: (device: GPUDevice) => void;
  readonly encodeRest: (pass: GPURenderPassEncoder) => void;
  readonly encodeTracks: (pass: GPURenderPassEncoder) => void;
  readonly hit: (at: Point) => WireId | undefined;
  readonly busy: (now: number) => boolean;
  /** The wire under the pointer, for hover glow; none clears it. */
  readonly setHover: (id: WireId | undefined) => void;
  /** Where a wire's invisible label button sits, in board units. */
  readonly labelOf: (id: WireId) => Point | undefined;
  readonly inspect: (id: WireId) => WireInspect | undefined;
  /** What the last upload wrote, buffer by buffer. */
  readonly lastUploads: () => ReadonlyArray<UploadRange>;
  readonly dispose: () => void;
};

export const createWireLayer = (options: WireLayerOptions): WiresLayer => {
  const scene = createWireScene({
    rectOf: options.rectOf,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
  });
  const gpu = createWireGpu(scene);
  let wall = 0;
  return {
    apply: (ops) => {
      for (const op of ops) scene.apply(op);
    },
    frame: (frame) => {
      wall = frame.wall;
      return scene.frame(frame);
    },
    upload: (device) => {
      const state = options.device.state();
      if (state.kind !== "ready") return;
      gpu.upload(device, state.format);
    },
    encodeRest: gpu.encodeRest,
    encodeTracks: gpu.encodeTracks,
    hit: scene.pick,
    busy: () => scene.busy(wall),
    setHover: scene.setHover,
    labelOf: scene.labelOf,
    inspect: scene.inspect,
    lastUploads: gpu.lastUploads,
    dispose: gpu.dispose,
  };
};
