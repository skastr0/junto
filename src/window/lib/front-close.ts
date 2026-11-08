import { getJuntoApi } from "./junto-api";
import { closeFrontModal } from "./modal-stack";

/**
 * Cmd+W: close what is in front, one layer per press. A dialog over an
 * agent's modal takes two presses to reach the canvas. On the canvas with
 * nothing open, the press closes the window; the app and its sessions keep
 * running, and the window comes back from the Dock.
 *
 * One press per layer makes it easy to overshoot, so a press that follows a
 * layer closing within WINDOW_CLOSE_GUARD_MS never closes the window.
 */
export const WINDOW_CLOSE_GUARD_MS = 1000;

export type FrontClose = "layer" | "window" | "held";

/** What a close press does. `layerClosedAtMs` is null when none closed yet. */
export const frontCloseFor = (
  closedLayer: boolean,
  nowMs: number,
  layerClosedAtMs: number | null,
  guardMs: number = WINDOW_CLOSE_GUARD_MS,
): FrontClose => {
  if (closedLayer) return "layer";
  return layerClosedAtMs !== null && nowMs - layerClosedAtMs < guardMs ? "held" : "window";
};

let layerClosedAtMs: number | null = null;

export const closeFront = (): FrontClose => {
  const now = performance.now();
  const verdict = frontCloseFor(closeFrontModal(), now, layerClosedAtMs);
  if (verdict === "layer") layerClosedAtMs = now;
  if (verdict === "window") getJuntoApi()?.closeWindow();
  return verdict;
};
