import { useEffect } from "react";
import { selectNodes, state$ } from "../lib/state";
import { withViewportBusy } from "../lib/viewport-busy";

type GroupFocusFlow<N> = {
  readonly getNode: (id: string) => N | undefined;
  readonly fitView: (options: {
    readonly nodes: Array<N>;
    readonly padding: number;
    readonly maxZoom: number;
    readonly duration: number;
  }) => Promise<boolean>;
};

const isMeasured = (node: unknown): boolean => {
  const measured = (node as { readonly measured?: { readonly width?: number; readonly height?: number } }).measured;
  return (measured?.width ?? 0) > 0 && (measured?.height ?? 0) > 0;
};

/**
 * Frame a recalled command group: select its members and fit the camera to
 * them with the same gentle animation as a single-node focus. Consumes the
 * one-shot `state$.focusNodeIds` request.
 */
export function useCanvasGroupFocus<N>(rf: GroupFocusFlow<N>): void {
  useEffect(() => {
    let frame = 0;
    let attempts = 0;
    const run = (nodeIds: ReadonlyArray<string>) => {
      if (nodeIds.length === 0) return;
      attempts = 0;
      const focus = () => {
        const present = nodeIds.filter((id) => rf.getNode(id) !== undefined);
        const nodes = present.flatMap((id) => {
          const node = rf.getNode(id);
          return node === undefined ? [] : [node];
        });
        // Freshly added nodes (a placed squad) exist a frame before React
        // Flow measures them; fitting then frames the wrong box. Wait for
        // every size, then fit with whatever is there.
        const measured = nodes.every((node) => isMeasured(node));
        if (present.length === 0 || (!measured && attempts < 24)) {
          attempts += 1;
          if (attempts < 24) frame = requestAnimationFrame(focus);
          else state$.focusNodeIds.set([]);
          return;
        }
        // Select only once the members are mounted (React Flow drops a
        // selection made before). Never re-select when the fit ends: the
        // operator may have changed the selection during the animation.
        selectNodes(present);
        void withViewportBusy(() =>
          rf.fitView({
            nodes,
            padding: 0.3,
            maxZoom: 1.45,
            duration: 360,
          }),
        )
          .catch(() => undefined)
          .finally(() => {
            state$.focusNodeIds.set([]);
          });
      };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(focus);
    };
    run(state$.focusNodeIds.peek());
    const off = state$.focusNodeIds.onChange(() => run(state$.focusNodeIds.peek()));
    return () => {
      cancelAnimationFrame(frame);
      off();
    };
  }, [rf]);
}
