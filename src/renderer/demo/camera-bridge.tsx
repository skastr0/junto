import { useEffect } from "react";
import { useReactFlow, type ReactFlowInstance } from "@xyflow/react";

// Demo/scripting engine only (--vellum-demo / VELLUM_DEMO=1). The conductor
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
};
