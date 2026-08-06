import { useEffect } from "react";
import { useReactFlow, type ReactFlowInstance } from "@xyflow/react";

// Demo/scripting engine only (--vellum-demo / VELLUM_COMMAND_DEMO=1). The conductor
// that drives the beat clock lives outside React (a plain module scheduling
// setTimeout callbacks), so it cannot call the useReactFlow() hook itself.
// This bridge is the one place the live React Flow instance crosses from
// component scope into that outside-React world.

let rfInstance: ReactFlowInstance | null = null;

/** Mount INSIDE <ReactFlowProvider>, alongside <Canvas />. Captures the live
 * React Flow instance into a module-scope ref for demoCamera to drive. */
export function DemoCameraBridge(): null {
  const rf = useReactFlow();
  useEffect(() => {
    rfInstance = rf;
    return () => {
      if (rfInstance === rf) rfInstance = null;
    };
  }, [rf]);
  return null;
}

export const demoCamera = {
  /** Absent `ids` fits every node currently on the canvas. No-op if the
   * bridge hasn't mounted yet (demo off, or a beat firing before first paint). */
  fitNodes: (
    ids: ReadonlyArray<string> | undefined,
    durationMs: number,
    opts?: { readonly padding?: number; readonly maxZoom?: number },
  ): void => {
    if (!rfInstance) return;
    void rfInstance
      .fitView({
        ...(ids ? { nodes: ids.map((id) => ({ id })) } : {}),
        padding: opts?.padding,
        maxZoom: opts?.maxZoom,
        duration: durationMs,
      })
      .catch(() => undefined);
  },
  center: (x: number, y: number, zoom: number | undefined, durationMs: number): void => {
    if (!rfInstance) return;
    void rfInstance.setCenter(x, y, { zoom, duration: durationMs }).catch(() => undefined);
  },
  /** Animated node moves. React Flow is the source of truth DURING the tween
   * (per-frame rf.setNodes); `onDone` fires once with the final moves so the
   * caller can reconcile the document exactly once. No-op before mount. */
  tweenNodes: (
    moves: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>,
    durationMs: number,
    easing: "linear" | "in-out",
    onDone: (moves: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>) => void,
  ): void => {
    const rf = rfInstance;
    if (!rf || moves.length === 0) {
      onDone(moves);
      return;
    }
    const starts = new Map<string, { readonly x: number; readonly y: number }>();
    for (const move of moves) {
      const node = rf.getNode(move.id);
      if (node) starts.set(move.id, { x: node.position.x, y: node.position.y });
    }
    const ease = (t: number): number =>
      easing === "linear" ? t : t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const t0 = performance.now();
    const frame = (): void => {
      const t = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - t0) / durationMs);
      const k = ease(t);
      const at = new Map(
        moves.map((move) => {
          const start = starts.get(move.id);
          return [
            move.id,
            start
              ? { x: start.x + (move.x - start.x) * k, y: start.y + (move.y - start.y) * k }
              : { x: move.x, y: move.y },
          ] as const;
        }),
      );
      rf.setNodes((nodes) =>
        nodes.map((node) => {
          const next = at.get(node.id);
          return next ? { ...node, position: next } : node;
        }),
      );
      if (t < 1) requestAnimationFrame(frame);
      else onDone(moves);
    };
    requestAnimationFrame(frame);
  },
};
