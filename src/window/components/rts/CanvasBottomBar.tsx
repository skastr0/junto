/**
 * The bar beside the canvas: command, kind and the minimap.
 *
 * It stands beside whichever canvas is mounted, not inside one. The minimap
 * reads the canvas's `MinimapSource` and the camera calls go through the
 * CanvasApi, so the bar keeps one implementation for both canvases (section
 * 17). The map stays mounted for every pan and zoom; only its own SVG writes.
 */

import { memo, useCallback, useRef, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import { use$ } from "@legendapp/state/react";
import { selectNode, state$ } from "../../lib/state";
import { seatUrgency$ } from "../../lib/region-urgency";
import { useSeatRollups, minimapNodeColors } from "../../lib/minimap-seat-colors";
import { minimapSource, subscribeMinimapSource, type MinimapRect } from "../../canvas/shell/minimap-source";
import { canvasApi } from "../../canvas/shell/canvas-api";
import { themeFor, withAlpha } from "../../lib/theme";
import { themeMode$ } from "../../lib/theme-mode";
import { useCanvas } from "../../lib/use-model";
import { CountedSurface } from "../../lib/performance/surface-commits";
import { FactoryMinimap, type SeatMark } from "../FactoryMinimap";
import { CanvasFieldTools } from "../CanvasFieldTools";
import { RtsBottomBar } from "./RtsBottomBar";
import type { MemberSeverity } from "@shared/region-rollup";

/** The mounted canvas's minimap source, subscribed so a canvas swap remounts the map. */
const useMinimapSource = () => useSyncExternalStore(subscribeMinimapSource, minimapSource, minimapSource);

function RtsMinimapStack() {
  const source = useMinimapSource();
  const severityByNodeId = use$(state$.regionSeverityByNodeId) as Readonly<Record<string, string>>;
  const canvasName = use$(state$.canvasName);
  const minimapCanvas = useCanvas(canvasName);
  const minimapTheme = themeFor(use$(themeMode$));
  const lastClickAt = useRef(0);
  const lastClickPos = useRef<{ x: number; y: number } | null>(null);

  // Agent seats paint their seat rollup (signal, proven attention, Jev's
  // reading, control state), the order their ring and name line use.
  const seatRollups = useSeatRollups();
  const ground = minimapTheme.ground!;
  const miniMapNodeColor = useCallback((rect: MinimapRect): string => {
    const canvasNode = minimapCanvas.nodes.get(rect.id as never);
    const severity = severityByNodeId[rect.id] as MemberSeverity | undefined;
    if (canvasNode) return minimapNodeColors(canvasNode, severity, seatRollups.get(rect.id), ground).fill;
    return "var(--color-amber)";
  }, [minimapCanvas, severityByNodeId, seatRollups, ground]);
  // Agents are dots on the map, rimmed and pinging by urgency (FactoryMinimap).
  // A string key: seatUrgency$ changes in place, so its object never changes identity.
  const seatUrgencyKey = use$(() =>
    Object.entries(seatUrgency$.get())
      .map(([id, urgency]) => `${id}:${urgency}`)
      .sort()
      .join("|"),
  );
  const miniMapSeatMark = useCallback((rect: MinimapRect): SeatMark | undefined => {
    if (rect.kind !== "agent") return undefined;
    const urgency = seatUrgency$[rect.id].peek();
    return urgency ? { urgency } : {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatUrgencyKey]);
  const miniMapNodeStroke = useCallback((rect: MinimapRect): string => {
    const severity = severityByNodeId[rect.id] as MemberSeverity | undefined;
    return minimapNodeColors(minimapCanvas.nodes.get(rect.id as never), severity, seatRollups.get(rect.id), ground).stroke;
  }, [minimapCanvas, severityByNodeId, seatRollups, ground]);

  // Click = pan camera to that world point; double-click = zoom in on it.
  const onMiniMapClick = useCallback((event: ReactMouseEvent, position: { x: number; y: number }) => {
    const api = canvasApi();
    if (api === undefined) return;
    const now = Date.now();
    const prev = lastClickPos.current;
    const dt = now - lastClickAt.current;
    const near =
      prev !== null &&
      Math.hypot(prev.x - position.x, prev.y - position.y) < 40;
    const isDouble = dt > 0 && dt < 320 && near;
    lastClickAt.current = now;
    lastClickPos.current = position;

    const zoom = api.camera().zoom;
    if (isDouble) {
      api.moveCamera(
        { kind: "centre", at: position, zoom: Math.min(Math.max(zoom * 1.55, 0.35), 1.6) },
        { durationMs: 280 },
      );
      return;
    }
    api.moveCamera({ kind: "centre", at: position, zoom }, { durationMs: 240 });
  }, []);

  const onMiniMapNodeClick = useCallback((event: ReactMouseEvent, id: string) => {
    // Prefer unit pick over empty-map click bubbling.
    event.stopPropagation();
    selectNode(id);
    // Focus path = camera fit on the entity (same as command Focus / chip).
    state$.focusNodeId.set(id);
  }, []);

  if (source === undefined) {
    return <div className="rts-minimap-placeholder" aria-hidden="true" />;
  }

  return (
    <>
      <FactoryMinimap
        source={source}
        nodeColor={miniMapNodeColor}
        nodeStrokeColor={miniMapNodeStroke}
        seatMarkOf={miniMapSeatMark}
        nodeStrokeWidth={1.5}
        maskColor={withAlpha(minimapTheme.ground!, 0.72)}
        onClick={onMiniMapClick}
        onNodeClick={onMiniMapNodeClick}
        ariaLabel="Strategic minimap — click to move camera, double-click to zoom, click a node to focus"
        style={{ background: "color-mix(in oklab, var(--color-ground) 90%, transparent)", border: "1px solid var(--color-overlay-4)" }}
      />
      <CanvasFieldTools />
    </>
  );
}

const MINIMAP_STACK = (
  <CountedSurface id="bar-minimap">
    <RtsMinimapStack />
  </CountedSurface>
);

const FIELD_TOOLS = (
  <CountedSurface id="bar-tools">
    <CanvasFieldTools />
  </CountedSurface>
);

/** Mounted once by the app beside the canvas; takes no props so it never re-renders. */
export const CanvasBottomBar = memo(function CanvasBottomBar() {
  return (
    <div className="rts-bar-dock">
      <CountedSurface id="bottom-bar">
        <RtsBottomBar tools={FIELD_TOOLS} minimap={MINIMAP_STACK} />
      </CountedSurface>
    </div>
  );
});
