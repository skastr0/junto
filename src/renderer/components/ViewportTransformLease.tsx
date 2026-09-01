import { useEffect } from "react";
import { useStoreApi } from "@xyflow/react";

/**
 * Keeps the camera transform on the compositor.
 *
 * In this Chromium a JS-driven inline `transform` change on a promoted
 * (will-change) element is not applied as a direct compositor update: every
 * pan frame re-layerizes everything under `.react-flow__viewport`, and that
 * cost scales with the canvas (measured 5 to 10 ms per frame on a 191-node
 * board, the largest main-thread item of a pan). A transform owned by a Web
 * Animation is applied on the compositor instead, and inline style writes to
 * the same property no longer re-layerize while the animation is live.
 *
 * So: one paused, filled animation on the viewport whose two identical
 * keyframes are rewritten to the store transform on every viewport change.
 * React Flow keeps writing `style.transform`; the animation overrides it in
 * the cascade with the same value, so nothing else changes.
 *
 * Must be mounted inside <ReactFlow> so the store (and its `domNode`) resolve.
 */

const transformString = (t: readonly [number, number, number]): string =>
  `translate(${t[0]}px,${t[1]}px) scale(${t[2]})`;

export function ViewportTransformLease() {
  const store = useStoreApi();
  useEffect(() => {
    const viewport = store
      .getState()
      .domNode?.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport || typeof viewport.animate !== "function") return;
    let last = store.getState().transform;
    const initial = transformString(last);
    let animation: Animation;
    try {
      animation = viewport.animate(
        [{ transform: initial }, { transform: initial }],
        { duration: 1000, fill: "both" },
      );
      animation.pause();
    } catch {
      return;
    }
    const unsubscribe = store.subscribe((state) => {
      if (state.transform === last) return;
      last = state.transform;
      const next = transformString(last);
      (animation.effect as KeyframeEffect | null)?.setKeyframes([
        { transform: next },
        { transform: next },
      ]);
    });
    return () => {
      unsubscribe();
      animation.cancel();
    };
  }, [store]);
  return null;
}
