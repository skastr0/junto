/**
 * Wire pulse feed — renders nothing.
 *
 * Mounted inside `<ReactFlow>` beside the loom. Listens to main's wire
 * traffic (one event per message typed into a seat), maps each event onto
 * the wire it crossed, and lights that wire only when it can be seen: the
 * current canvas, a visible window, and a wire whose ends meet the viewport.
 * No subscription to geometry or the viewport; both are read once per event.
 */
import { useEffect, useRef } from "react";
import { useStoreApi } from "@xyflow/react";
import type { WireTrafficEvent } from "@shared/wire-traffic";
import type { FlowEdge } from "../../lib/convert";
import { state$ } from "../../lib/state";
import {
  pickPulseEdge,
  pulseOnScreen,
  wirePulseScheduler,
  type PulseRect,
} from "../../lib/wire-pulse";

type BoxNode = {
  readonly width?: number | null;
  readonly height?: number | null;
  readonly measured?: { readonly width?: number; readonly height?: number };
  readonly internals: { readonly positionAbsolute: { readonly x: number; readonly y: number } };
};

const boxOf = (node: BoxNode | undefined): PulseRect | undefined => {
  if (node === undefined) return undefined;
  const { x, y } = node.internals.positionAbsolute;
  return {
    x,
    y,
    width: node.measured?.width ?? node.width ?? 0,
    height: node.measured?.height ?? node.height ?? 0,
  };
};

export function WirePulseFeed({ edges }: { readonly edges: ReadonlyArray<FlowEdge> }) {
  const store = useStoreApi();
  // Read per event, never subscribed: a new edges array costs nothing here.
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  useEffect(() => {
    const onTraffic = (event: WireTrafficEvent): void => {
      if (event.canvasName !== state$.canvasName.peek()) return;
      // A failed write crossed nothing.
      if (event.failed === true) return;
      if (document.visibilityState === "hidden") return;
      const target = pickPulseEdge(edgesRef.current, event);
      if (target === undefined || event.fromNodeId === undefined) return;
      const { nodeLookup, transform, width, height } = store.getState();
      const from = boxOf(nodeLookup.get(event.fromNodeId) as BoxNode | undefined);
      const to = boxOf(nodeLookup.get(event.toNodeId) as BoxNode | undefined);
      if (from === undefined || to === undefined) return;
      const [tx, ty, zoom] = transform;
      const viewport: PulseRect = {
        x: -tx / zoom,
        y: -ty / zoom,
        width: width / zoom,
        height: height / zoom,
      };
      if (!pulseOnScreen(from, to, viewport)) return;
      wirePulseScheduler.fire(target, event.kind);
    };
    const off = window.junto?.onWireTraffic?.(onTraffic);
    return () => {
      off?.();
      wirePulseScheduler.clear();
    };
  }, [store]);

  return null;
}
