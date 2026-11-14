/**
 * `window.__juntoCanvas`, the canvas test hook (docs/canvas-gpu-architecture.md,
 * section 22). Test and development builds only. The e2e helper reads it under
 * the GPU canvas; clicks and drags stay real pointer input at the points it
 * gives. Facts come from the shell's mirror, never from a DOM card.
 */

import type { CanvasTestHook, NodeId, Part, Rect } from "../contract";
import { farSeatScale, seatFloorScale } from "@shared/canvas-tier";
import type { SeamEngine } from "../engine/engine";
import { engineStats } from "./gpu-canvas-api";
import type { SurfaceMirror } from "./surface-mirror";
import { lastReachMarks } from "./reach-live";

type HookPart = Part["kind"] | "toolbar" | "region-handle" | `handle:${"source" | "target"}:${"top" | "right" | "bottom" | "left"}` | `verb:${string}`;

type FullHook = CanvasTestHook & {
  /** The helper's vocabulary (e2e/harness/canvas.ts). */
  readonly ids: () => ReadonlyArray<NodeId>;
  readonly regionCount: () => number;
  readonly rect: (id: NodeId, part?: string) => Rect | null;
  readonly text: (id: NodeId) => string;
  readonly selected: () => ReadonlyArray<NodeId>;
  /** The card holding the cyan keyboard focus ring, or "" when none does. */
  readonly focused: () => NodeId | "";
  /** The wire mode the shell has pushed to the engine (shell/wire-mode.ts). */
  readonly wireMode: () => string;
};

const inset = (rect: Rect, dx: number, dy: number): Rect => ({
  x: rect.x + dx,
  y: rect.y + dy,
  width: Math.min(rect.width, Math.max(0, rect.width - dx * 2)),
  height: Math.min(rect.height, Math.max(0, rect.height - dy * 2)),
});

const centred = (rect: Rect, atX: number, atY: number, size: number): Rect => ({
  x: atX - size / 2,
  y: atY - size / 2,
  width: size,
  height: size,
});

/** A part's screen rectangle, as the DOM would draw it. */
const partRect = (mirror: SurfaceMirror, id: NodeId, part: string | undefined): Rect | undefined => {
  const card = mirror.screenRectOf(id);
  if (card === undefined) return undefined;
  if (part === undefined || part === "" || part === "body" || (part as HookPart) === "body") return card;
  if (part.startsWith("handle:")) {
    const [, , side] = part.split(":");
    const size = 14;
    if (side === "left") return centred(card, card.x, card.y + card.height / 2, size);
    if (side === "right") return centred(card, card.x + card.width, card.y + card.height / 2, size);
    if (side === "top") return centred(card, card.x + card.width / 2, card.y, size);
    return centred(card, card.x + card.width / 2, card.y + card.height, size);
  }
  if (part.startsWith("verb:")) {
    // The verb halves sit under the card's bottom edge while a connect is over it.
    const height = Math.max(18, Math.min(card.height / 3, 54));
    return { x: card.x, y: card.y + card.height - height, width: card.width, height };
  }
  if (part === "region-handle") return inset(card, 0, 0).height > 24 ? { x: card.x, y: card.y, width: Math.min(card.width, 160), height: 24 } : card;
  if (part === "regionTitle") return { x: card.x, y: card.y, width: Math.min(card.width, 160), height: 24 };
  if (part === "regionFrame") return card;
  if (part === "ringFlag") return inset(card, 8, 8);
  if (part === "taskEnqueue") return inset(card, 8, 8);
  if (part === "bubbleClose") return inset(card, 8, 8);
  if (part === "image") return inset(card, 0, 0);
  if (part === "resize") return centred(card, card.x + card.width, card.y + card.height, 12);
  if (part === "resizeEdge") return { x: card.x + card.width - 4, y: card.y, width: 4, height: card.height };
  // The selection toolbar is DOM chrome; its box is not the canvas's fact.
  if (part === "toolbar") return undefined;
  return undefined;
};

const build = (mirror: SurfaceMirror, engine: () => SeamEngine | undefined, atlasRequests: () => number): FullHook => {
  const cardIds = (): ReadonlyArray<NodeId> =>
    mirror.cardIds().filter((id) => mirror.card(id)?.row.kind !== "region");
  const rect = (id: NodeId, part?: string): Rect | null => {
    if (id === "") {
      const el = mirror.element();
      if (el === null) return null;
      const box = el.getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: box.height };
    }
    return partRect(mirror, id, part) ?? null;
  };
  return {
    ready: () => mirror.ready() && mirror.element() !== null,
    cardIds,
    regionIds: () => mirror.regionIds(),
    ids: cardIds,
    regionCount: () => mirror.regionIds().length,
    rectOf: (id, part) => rect(id, part) ?? undefined,
    rect,
    textOf: (id) => mirror.card(id)?.text,
    text: (id) => mirror.card(id)?.text ?? "",
    selection: () => mirror.selection().nodeIds,
    selected: () => mirror.selection().nodeIds,
    focused: () => mirror.selection().focusedNodeId ?? "",
    camera: () => mirror.camera(),
    // The engine's own fact: the mirror follows the next frame's camera.
    moveCamera: (camera) => engine()?.moveCamera(camera),
    settled: () => mirror.settled(),
    tier: () => mirror.tier(),
    ringAngle: (id) => engine()?.ringAngle?.(id),
    ringCapOf: (id) => mirror.card(id)?.derived.ringCap,
    seatScaleOf: (id) => {
      const cap = mirror.card(id)?.derived.ringCap;
      if (cap === undefined) return undefined;
      const zoom = mirror.camera().zoom;
      const far = Math.max(1, Math.min(farSeatScale(zoom), cap));
      const tier = mirror.tier();
      if (tier === "far") return far;
      if (tier === "overview") return Math.max(seatFloorScale(zoom), Math.min(farSeatScale(zoom), cap));
      return 1;
    },
    stats: () => engineStats(engine()),
    reachMarks: () => lastReachMarks(),
    wireMode: () => mirror.wireMode(),
    atlasRequests,
  };
};

/** Test and development builds only. */
export const canvasTestHookWanted = (): boolean => {
  if (typeof window === "undefined") return false;
  if (import.meta.env.DEV) return true;
  const chassis = (window as { readonly chassis?: { readonly testHarness?: boolean } }).chassis;
  return chassis?.testHarness === true;
};

/** Install the hook; returns the uninstall. A no-op outside test builds. */
export const installCanvasTestHook = (
  mirror: SurfaceMirror,
  engine: () => SeamEngine | undefined,
  atlasRequests: () => number = () => 0,
): (() => void) => {
  if (!canvasTestHookWanted()) return () => undefined;
  const hook = build(mirror, engine, atlasRequests);
  (window as unknown as { __juntoCanvas?: FullHook }).__juntoCanvas = hook;
  return () => {
    const held = (window as unknown as { __juntoCanvas?: FullHook }).__juntoCanvas;
    if (held === hook) delete (window as unknown as { __juntoCanvas?: FullHook }).__juntoCanvas;
  };
};
