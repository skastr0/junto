/**
 * The wire select labels over the GPU canvas (docs/canvas-gpu-architecture.md
 * sections 13 and 16): one transparent 14 px target at each visible wire's
 * label point, the shell's half of the wire layer's `labelsInView`.
 *
 * Today's canvas puts an invisible midpoint button on every wire
 * (`WireEdge.tsx:138-161`): the stroke is deaf at rest, so that button is how
 * a pointer and a screen reader select a relation. The GPU canvas draws the
 * strokes itself, so the button is the one piece of a wire that stays DOM.
 *
 * The buttons sit in board space inside one wrapper, and the wrapper is the
 * only thing the camera moves: a pan or a zoom writes one transform, never
 * one per button. A button's own style changes only when its wire's geometry
 * does, so the frame the engine draws while the camera rests (a seat ring
 * keeps the loop running) writes nothing at all. The wrapper is scaled by the
 * camera, so each button carries the inverse scale in a custom property and
 * keeps its 14 px target at any zoom.
 *
 * The canvas's page box is measured on layout changes only, by a
 * ResizeObserver and the two window events: this module's callback runs on
 * every drawn frame, where a `getBoundingClientRect()` forces style and
 * layout at display rate.
 *
 * The label is silent by design (no visible text); `labelOf`'s point is the
 * midpoint of a route or the longest run of an elbow, exactly React Flow's
 * `labelX`/`labelY`.
 */
import { selectEdge } from "../../lib/state";
import type { Camera, Point } from "../contract";
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
/** Above the canvas, below the card overlays (their toolbar and editors). */
const LABEL_LAYER = 30;
/** The inverse camera scale a button carries, so its target stays 14 px. */
const SCALE_VAR = "--wire-label-scale";

export const mountWireLabels = ({ canvas, layer }: WireLabelsOptions): WireLabels => {
  const host = document.createElement("div");
  host.className = "junto-wire-labels";
  host.dataset["canvasOverlay"] = "wire-labels";
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  host.style.zIndex = String(LABEL_LAYER);
  host.style.pointerEvents = "none";
  host.style.transformOrigin = "0 0";
  host.style.willChange = "transform";
  document.body.appendChild(host);

  const buttons = new Map<string, HTMLButtonElement>();
  /** The canvas's page box at the last layout change: the frame path never reads it. */
  let origin: Point = { x: 0, y: 0 };
  /** A layout change may have moved the canvas and changed what the camera sees. */
  let layoutDirty = true;
  let lastCamera: Camera | undefined;
  let lastOrigin: Point = { x: 0, y: 0 };
  let lastRevision = -1;

  const measure = (): void => {
    const rect = canvas.getBoundingClientRect();
    origin = { x: rect.left, y: rect.top };
    layoutDirty = true;
  };
  measure();
  const sizes = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
  sizes?.observe(canvas);
  window.addEventListener("resize", measure);
  // A scroll above the canvas moves its box; the capture phase hears it.
  window.addEventListener("scroll", measure, { capture: true, passive: true });

  const buttonFor = (id: string): HTMLButtonElement => {
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

  /** Board-space placement. The inverse scale keeps the button's centre on the
   *  label point whatever the camera's zoom does to the wrapper. */
  const place = (button: HTMLButtonElement, at: Point): void => {
    button.style.transform = `translate3d(${at.x}px, ${at.y}px, 0) translate(-50%, -50%) scale(var(${SCALE_VAR}, 1))`;
  };

  const frame = (camera: Camera): void => {
    const wires = layer();
    if (wires === undefined) return;
    const revision = wires.labelsRevision();
    const last = lastCamera;
    const posed =
      !layoutDirty &&
      last !== undefined &&
      last.x === camera.x &&
      last.y === camera.y &&
      last.zoom === camera.zoom &&
      lastOrigin.x === origin.x &&
      lastOrigin.y === origin.y;
    // The resting frame, which is most frames: a seat ring keeps the loop
    // drawing, and there is nothing here for it to write. A layout change
    // reconciles even at a still camera, because the view can reveal or hide
    // labels without the camera moving.
    if (posed && revision === lastRevision) return;
    layoutDirty = false;

    if (!posed) {
      host.style.transform = `translate3d(${origin.x + camera.x}px, ${origin.y + camera.y}px, 0) scale(${camera.zoom})`;
      if (last === undefined || last.zoom !== camera.zoom) host.style.setProperty(SCALE_VAR, String(1 / camera.zoom));
    }
    const relaid = revision !== lastRevision;
    lastCamera = camera;
    lastOrigin = origin;
    lastRevision = revision;

    const seen = new Set<string>();
    for (const label of wires.labelsInView()) {
      seen.add(label.id);
      let button = buttons.get(label.id);
      const created = button === undefined;
      if (button === undefined) button = buttonFor(label.id);
      // A wire's label point moves only when its geometry does, so a pan and
      // a zoom leave every button's own transform alone.
      if (created || relaid) place(button, label.at);
      const verb = label.verb ?? "";
      if (button.dataset["verb"] !== verb) {
        button.dataset["verb"] = verb;
        button.setAttribute("aria-label", `Select edge - ${label.verb ?? "connection"}`);
      }
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
      sizes?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, { capture: true });
      host.remove();
      buttons.clear();
    },
  };
};
