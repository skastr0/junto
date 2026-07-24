import { observable } from "@legendapp/state";
import {
  PAUSED_CANVAS,
  type CanvasPauseState,
  type PauseScope,
} from "@shared/pause";
import { getVellumApi } from "./vellum-api";
import { state$ } from "./state";

// Renderer mirror of the main-process pause plane for the OPEN canvas.
//
// Born-paused law (@shared/pause): until hydration answers, the mirror reads
// PAUSED_CANVAS — fail closed, never optimistic. There is no push channel;
// state hydrates via factoryPauseState and refreshes from every
// factoryPauseSet write result (the write carries the fresh post-write
// state, so the renderer never re-derives).
export const pause$ = observable({
  canvasName: "",
  hydrated: false,
  state: PAUSED_CANVAS as CanvasPauseState,
  error: "",
});

/** Re-fetch the open canvas's pause state. Stale responses are dropped. */
export const refreshPauseState = async (canvasName: string): Promise<void> => {
  const api = getVellumApi();
  if (!api?.factoryPauseState || !canvasName) return;
  try {
    const next = await api.factoryPauseState(canvasName);
    if (state$.canvasName.peek() !== canvasName) return;
    pause$.assign({ canvasName, hydrated: true, state: next, error: "" });
  } catch {
    // Unreachable backend: stay born-paused (fail closed), not hydrated.
    if (state$.canvasName.peek() !== canvasName) return;
    pause$.assign({ canvasName, hydrated: false, state: PAUSED_CANVAS, error: "" });
  }
};

/** Idempotent per-canvas hydrate — cheap to call from any mounting control. */
export const ensurePauseState = (canvasName: string): void => {
  if (!canvasName) return;
  if (pause$.canvasName.peek() === canvasName && pause$.hydrated.peek()) return;
  void refreshPauseState(canvasName);
};

/**
 * Flip one pause scope on the open canvas. Resolves to "" on success or the
 * refusal reason (store fault, failed persist) — never swallowed: the reason
 * is also mirrored into pause$.error for inline surfacing.
 */
export const setScopePaused = async (
  scope: PauseScope,
  paused: boolean,
): Promise<string> => {
  const api = getVellumApi();
  const canvasName = state$.canvasName.peek();
  if (!api?.factoryPauseSet || !canvasName) return "no canvas is open";
  try {
    const result = await api.factoryPauseSet(canvasName, scope, paused);
    if (state$.canvasName.peek() !== canvasName) return "";
    if (result.ok) {
      pause$.assign({ canvasName, hydrated: true, state: result.state, error: "" });
      return "";
    }
    pause$.error.set(result.error);
    return result.error;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    pause$.error.set(message);
    return message;
  }
};

/** Is this node itself paused (node scope only — not canvas/region rollup)? */
export const nodePausedIn = (
  state: CanvasPauseState,
  nodeId: string,
): boolean => state.pausedNodes.includes(nodeId);

/** Is this region itself paused (region scope only)? */
export const regionPausedIn = (
  state: CanvasPauseState,
  regionId: string,
): boolean => state.pausedRegions.includes(regionId);
