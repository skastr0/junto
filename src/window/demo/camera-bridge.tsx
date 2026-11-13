import { canvasApi } from "../canvas/shell/canvas-api";

// Demo/scripting engine only (--junto-demo / JUNTO_DEMO=1). The conductor
// that drives the beat clock lives outside React (a plain module scheduling
// setTimeout callbacks), so it cannot call React hooks itself. This bridge is
// the one place the demo talks to the mounted canvas: everything goes through
// the CanvasApi, so the old canvas and the GPU canvas run the same take.
//
// Kept as a component so the demo mount stays where it was; it registers
// nothing, because the canvas owns the handle.

export function DemoCameraBridge(): null {
  return null;
}

export const demoCamera = {
  /** Absent `ids` fits every node currently on the canvas. No-op before mount. */
  fitNodes: (
    ids: ReadonlyArray<string> | undefined,
    durationMs: number,
    opts?: { readonly padding?: number; readonly maxZoom?: number },
  ): void => {
    const api = canvasApi();
    if (api === undefined) return;
    if (ids === undefined || ids.length === 0) {
      api.fit({ durationMs });
      return;
    }
    api.focusNodes(ids, {
      durationMs,
      ...(opts?.padding === undefined ? {} : { padding: opts.padding }),
      ...(opts?.maxZoom === undefined ? {} : { maxZoom: opts.maxZoom }),
    });
  },
  center: (x: number, y: number, zoom: number | undefined, durationMs: number): void => {
    canvasApi()?.moveCamera(
      { kind: "centre", at: { x, y }, ...(zoom === undefined ? {} : { zoom }) },
      { durationMs },
    );
  },
  /** Animated node moves. The canvas previews the tween; `onDone` fires once
   * with the final moves so the caller reconciles the document exactly once. */
  tweenNodes: (
    moves: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>,
    durationMs: number,
    easing: "linear" | "in-out",
    onDone: (moves: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>) => void,
  ): void => {
    const api = canvasApi();
    if (api === undefined || api.previewMoves === undefined || moves.length === 0) {
      onDone(moves);
      return;
    }
    const starts = new Map<string, { readonly x: number; readonly y: number }>();
    for (const move of moves) {
      const rect = api.rectOf(move.id);
      if (rect) starts.set(move.id, { x: rect.x, y: rect.y });
    }
    const ease = (t: number): number =>
      easing === "linear" ? t : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const t0 = performance.now();
    const frame = (): void => {
      const t = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - t0) / durationMs);
      const k = ease(t);
      api.previewMoves!(
        moves.map((move) => {
          const start = starts.get(move.id);
          return start
            ? { id: move.id, x: start.x + (move.x - start.x) * k, y: start.y + (move.y - start.y) * k }
            : { id: move.id, x: move.x, y: move.y };
        }),
      );
      if (t < 1) requestAnimationFrame(frame);
      else onDone(moves);
    };
    requestAnimationFrame(frame);
  },
};
