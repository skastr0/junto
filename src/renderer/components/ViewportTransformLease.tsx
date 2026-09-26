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
 * The selected node's toolbar needs the same treatment. It is rendered outside
 * the camera, into `.react-flow__renderer`, and React Flow re-positions it with
 * a fresh inline `transform` on every camera change — so while a node is
 * selected, one small element outside the lease re-layerizes the whole board
 * once per pan frame. Measured on the 193-node canvas, 6 s synthetic pan with
 * one card selected: renderer main 2889 ms, `PaintArtifactCompositor::Update`
 * 1147 ms over 384 frames; with the toolbar leased, 1575 ms and the compositor
 * update gone. The toolbar keeps tracking its node exactly as before.
 *
 * The animation is also the viewport's only compositor promotion: it has no
 * `will-change`, which would pin raster scale at native and starve tile
 * memory when zoomed out (styles.css, canvas-raster-scale.spec.ts).
 *
 * Must be mounted inside <ReactFlow> so the store (and its `domNode`) resolve.
 */

const transformString = (t: readonly [number, number, number]): string =>
  `translate(${t[0]}px,${t[1]}px) scale(${t[2]})`;

/**
 * Mirror an element's inline `transform` into a paused, filled Web Animation,
 * which wins the cascade with the identical value and moves on the compositor.
 * Returns a release function.
 */
const leaseInlineTransform = (element: HTMLElement): (() => void) => {
  if (typeof element.animate !== "function") return () => {};
  const read = (): string => element.style.transform || "none";
  let animation: Animation;
  try {
    const initial = read();
    animation = element.animate(
      [{ transform: initial }, { transform: initial }],
      { duration: 1000, fill: "both" },
    );
    animation.pause();
  } catch {
    return () => {};
  }
  const observer = new MutationObserver(() => {
    const next = read();
    (animation.effect as KeyframeEffect | null)?.setKeyframes([
      { transform: next },
      { transform: next },
    ]);
  });
  observer.observe(element, { attributes: true, attributeFilter: ["style"] });
  return () => {
    observer.disconnect();
    animation.cancel();
  };
};

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

  useEffect(() => {
    const renderer = store
      .getState()
      .domNode?.querySelector<HTMLElement>(".react-flow__renderer");
    if (!renderer) return;
    const leases = new Map<HTMLElement, () => void>();
    const sync = (): void => {
      for (const element of renderer.querySelectorAll<HTMLElement>(
        ":scope > .react-flow__node-toolbar",
      )) {
        if (!leases.has(element)) leases.set(element, leaseInlineTransform(element));
      }
      for (const [element, release] of leases) {
        if (element.isConnected) continue;
        release();
        leases.delete(element);
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(renderer, { childList: true });
    return () => {
      observer.disconnect();
      for (const release of leases.values()) release();
      leases.clear();
    };
  }, [store]);
  return null;
}
