/**
 * The wire select labels over the GPU canvas (docs/canvas-gpu-architecture.md
 * sections 13 and 16): one transparent 14 px target at each visible wire's
 * label point, the shell's half of the wire layer's `labelsInView`.
 *
 * Today's canvas puts an invisible midpoint button on every wire
 * (`WireEdge.tsx:138-161`): the stroke is deaf at rest, so that button is how
 * a pointer and a screen reader select a relation. The GPU canvas draws the
 * strokes itself, so the button is the one piece of a wire that stays DOM. It
 * follows the camera without a React render, as the selection toolbar and the
 * marquee do; only the wires the camera can see have a button.
 *
 * The label is silent by design (no visible text); `labelOf`'s point is the
 * midpoint of a route or the longest run of an elbow, exactly React Flow's
 * `labelX`/`labelY`.
 */
import { selectEdge } from "../../lib/state";
import type { Camera } from "../contract";
import type { WiresLayer } from "../engine/wires";

export type WireLabels = {
  /** Follow the engine's frame: place the buttons for the camera it drew. */
  readonly frame: (camera: Camera) => void;
  readonly dispose: () => void;
};

export type WireLabelsOptions = {
  readonly canvas: HTMLCanvasElement;
  /** The mounted wire layer, which the shell creates after the engine. */
  readonly layer: () => WiresLayer | undefined;
};

const LABEL_SIZE = 14;
/** Above the canvas and its overlays' common band, below operator modals. */
const LABEL_LAYER = 40;

export const mountWireLabels = ({ canvas, layer }: WireLabelsOptions): WireLabels => {
  const host = document.createElement("div");
  host.className = "junto-wire-labels";
  host.dataset["canvasOverlay"] = "wire-labels";
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  host.style.zIndex = String(LABEL_LAYER);
  host.style.pointerEvents = "none";
  document.body.appendChild(host);

  const buttons = new Map<string, HTMLButtonElement>();
  let lastCamera: Camera | undefined;
  let lastRevision = -1;
  let lastOrigin: { readonly x: number; readonly y: number } | undefined;

  const buttonFor = (id: string): HTMLButtonElement => {
    const existing = buttons.get(id);
    if (existing !== undefined) return existing;
    const button = document.createElement("button");
    button.type = "button";
    // The DOM canvas's own class and label, so the same role query and the
    // same silent paint work on both canvases.
    button.className = "nodrag nopan junto-edge-label junto-edge-label--silent";
    button.style.position = "absolute";
    button.style.left = "0";
    button.style.top = "0";
    button.style.width = `${String(LABEL_SIZE)}px`;
    button.style.height = `${String(LABEL_SIZE)}px`;
    button.style.padding = "0";
    button.style.opacity = "0";
    button.style.pointerEvents = "auto";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      selectEdge(id);
    });
    host.appendChild(button);
    buttons.set(id, button);
    return button;
  };

  const frame = (camera: Camera): void => {
    const wires = layer();
    if (wires === undefined) return;
    const revision = wires.labelsRevision();
    const origin = canvas.getBoundingClientRect();
    const still =
      lastCamera !== undefined &&
      lastRevision === revision &&
      lastCamera.x === camera.x &&
      lastCamera.y === camera.y &&
      lastCamera.zoom === camera.zoom &&
      lastOrigin?.x === origin.left &&
      lastOrigin.y === origin.top;
    if (still) return;
    lastCamera = camera;
    lastRevision = revision;
    lastOrigin = { x: origin.left, y: origin.top };

    const seen = new Set<string>();
    for (const label of wires.labelsInView()) {
      seen.add(label.id);
      const button = buttonFor(label.id);
      button.setAttribute("aria-label", `Select edge - ${label.verb ?? "connection"}`);
      const x = origin.left + camera.x + label.at.x * camera.zoom;
      const y = origin.top + camera.y + label.at.y * camera.zoom;
      const transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
      if (button.style.transform !== transform) button.style.transform = transform;
    }
    for (const [id, button] of buttons) {
      if (seen.has(id)) continue;
      button.remove();
      buttons.delete(id);
    }
  };

  return {
    frame,
    dispose: () => {
      host.remove();
      buttons.clear();
    },
  };
};
