/**
 * The old canvas's CanvasApi (docs/canvas-gpu-architecture.md, section 19).
 * Both canvases implement the one interface while both exist: React Flow's
 * store and instance answer behind it, so every consumer can move to the API
 * without a second code path. Deleted with React Flow (plan, the finish).
 */

import { useEffect, useMemo, type ReactNode } from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import type { Camera, CameraTarget, CanvasApi, Hit, NodeId, Point, Rect, WireMode } from "../contract";
import { cameraForTarget, boundsOfRects } from "./camera-targets";
import { canvasTier$ } from "../../lib/canvas-tier";
import type { MinimapRect, MinimapSource } from "./minimap-source";
import { clearCanvasApi, setCanvasApi } from "./canvas-api";
import { clearMinimapSource, setMinimapSource } from "./minimap-source";
import { CanvasApiProvider } from "./CanvasApiContext";

type FlowStore = ReturnType<typeof useStoreApi>;
type FlowInstance = ReturnType<typeof useReactFlow>;

export function LegacyCanvasApiProvider({ children }: { readonly children: ReactNode }) {
  const rf = useReactFlow();
  const store = useStoreApi();

  const api = useMemo<CanvasApi>(() => {
    const dom = (): HTMLElement | null => (store.getState().domNode as HTMLElement | null) ?? null;
    const cameraNow = (): Camera => {
      const [x, y, zoom] = store.getState().transform;
      return { x, y, zoom };
    };
    const viewport = (): { width: number; height: number } => {
      const state = store.getState();
      return { width: state.width, height: state.height };
    };
    const nodeRect = (id: NodeId): Rect | undefined => {
      const internal = store.getState().nodeLookup.get(id);
      if (internal === undefined) return undefined;
      const measured = internal.measured;
      const user = internal.internals.userNode;
      return {
        x: internal.internals.positionAbsolute.x,
        y: internal.internals.positionAbsolute.y,
        width: measured.width ?? user.width ?? 0,
        height: measured.height ?? user.height ?? 0,
      };
    };
    const boundsOf = (ids: ReadonlyArray<NodeId>): Rect | undefined =>
      boundsOfRects(ids.map((id) => nodeRect(id)).filter((rect): rect is Rect => rect !== undefined));
    const origin = (): Point => {
      const node = dom();
      if (node === null) return { x: 0, y: 0 };
      const box = node.getBoundingClientRect();
      return { x: box.left, y: box.top };
    };
    const screenRectOf = (id: NodeId): Rect | undefined => {
      const rect = nodeRect(id);
      if (rect === undefined) return undefined;
      const camera = cameraNow();
      const at = origin();
      return {
        x: at.x + camera.x + rect.x * camera.zoom,
        y: at.y + camera.y + rect.y * camera.zoom,
        width: rect.width * camera.zoom,
        height: rect.height * camera.zoom,
      };
    };
    const setCamera = (camera: Camera, durationMs?: number): void => {
      const moved = rf.setViewport(camera, durationMs === undefined || durationMs <= 0 ? undefined : { duration: durationMs });
      void moved.catch(() => undefined);
    };
    const targetCamera = (target: CameraTarget): Camera =>
      cameraForTarget(target, cameraNow(), viewport(), (ids) => boundsOf(ids));
    const writeAnchor = (id: NodeId, element: HTMLElement): void => {
      const rect = screenRectOf(id);
      if (rect === undefined) {
        element.style.visibility = "hidden";
        return;
      }
      element.style.visibility = "";
      element.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
      element.style.setProperty("--anchor-width", `${rect.width}px`);
      element.style.setProperty("--anchor-height", `${rect.height}px`);
      element.style.setProperty("--anchor-zoom", String(cameraNow().zoom));
    };
    return {
      screenToBoard: (screen) => {
        const point = rf.screenToFlowPosition({ x: screen.x, y: screen.y });
        return { x: point.x, y: point.y };
      },
      boardToScreen: (board) => {
        const point = rf.flowToScreenPosition({ x: board.x, y: board.y });
        return { x: point.x, y: point.y };
      },
      camera: cameraNow,
      onCamera: (listener) => {
        let last = cameraNow();
        return store.subscribe((state) => {
          const next = { x: state.transform[0], y: state.transform[1], zoom: state.transform[2] };
          if (next.x === last.x && next.y === last.y && next.zoom === last.zoom) return;
          last = next;
          listener(next);
        });
      },
      moveCamera: (target, options) => setCamera(targetCamera(target), options?.durationMs),
      fit: (options) => {
        void rf.fitView({ padding: 0.18, maxZoom: 1.35, duration: options?.durationMs ?? 320 }).catch(() => undefined);
      },
      focusNodes: (ids, options) => {
        void rf.fitView({
          nodes: ids.map((id) => ({ id })),
          padding: options?.padding ?? 0.35,
          maxZoom: options?.maxZoom ?? 1.45,
          duration: options?.durationMs ?? 360,
        }).catch(() => undefined);
      },
      zoomBy: (factor, options) => setCamera(targetCamera({ kind: "zoomBy", factor }), options?.durationMs),
      zoomTo: (zoom, options) => setCamera(targetCamera({ kind: "zoomTo", zoom }), options?.durationMs),
      rectOf: nodeRect,
      boundsOf,
      screenRectOf,
      pick: (screen) => {
        const element = document.elementFromPoint(screen.x, screen.y);
        const at = { x: screen.x, y: screen.y };
        const node = element?.closest<HTMLElement>(".react-flow__node");
        const wire = element?.closest<HTMLElement>(".react-flow__edge");
        if (node !== null && node !== undefined) {
          return { nodeId: node.dataset["id"] ?? "", part: { kind: "body" }, at };
        }
        if (wire !== null && wire !== undefined) {
          const id = wire.dataset["id"] ?? "";
          return { wireId: id, part: { kind: "wire" }, at };
        }
        return { part: { kind: "pane" }, at };
      },
      anchor: (id, element) => {
        writeAnchor(id, element);
        return store.subscribe((state) => {
          if (state.domNode === null) return;
          writeAnchor(id, element);
        });
      },
      setWireMode: (mode: WireMode) => {
        const element = dom();
        if (element === null) return;
        if (mode === "loupe" || mode === "cone" || mode === "connecting") element.dataset["wires"] = "shown";
        else delete element.dataset["wires"];
      },
      tier: () => canvasTier$.peek(),
      element: dom,
      previewMoves: (moves) => {
        if (moves === null) return;
        const at = new Map(moves.map((move) => [move.id, move]));
        rf.setNodes((nodes) =>
          nodes.map((node) => {
            const move = at.get(node.id);
            return move === undefined ? node : { ...node, position: { x: move.x, y: move.y } };
          }),
        );
      },
      cardElements: (id) => {
        const element = dom();
        if (element === null) return [];
        return [...element.querySelectorAll(`.react-flow__node[data-id="${CSS.escape(id)}"]`)];
      },
    } satisfies CanvasApi;
  }, [rf, store]);

  const minimap = useMemo<MinimapSource>(() => {
    const dom = (): HTMLElement | null => (store.getState().domNode as HTMLElement | null) ?? null;
    const cameraNow = (): Camera => {
      const [x, y, zoom] = store.getState().transform;
      return { x, y, zoom };
    };
    const rects = (): ReadonlyArray<MinimapRect> => {
      const found: MinimapRect[] = [];
      for (const internal of store.getState().nodeLookup.values()) {
        const user = internal.internals.userNode;
        if (user.hidden === true) continue;
        const width = internal.measured.width ?? user.width ?? 0;
        const height = internal.measured.height ?? user.height ?? 0;
        if (width <= 0 || height <= 0) continue;
        const kind = (user.data as { readonly kind?: MinimapRect["kind"] } | undefined)?.kind;
        if (kind === undefined) continue;
        found.push({ id: user.id, kind, x: internal.internals.positionAbsolute.x, y: internal.internals.positionAbsolute.y, width, height });
      }
      return found;
    };
    return {
      rects,
      onRects: (listener) => {
        let lastNodes = store.getState().nodes;
        let lastLookup = store.getState().nodeLookup;
        return store.subscribe((state) => {
          if (state.nodes === lastNodes && state.nodeLookup === lastLookup) return;
          lastNodes = state.nodes;
          lastLookup = state.nodeLookup;
          listener();
        });
      },
      camera: cameraNow,
      onCamera: (listener) => {
        let last = cameraNow();
        return store.subscribe((state) => {
          const next = { x: state.transform[0], y: state.transform[1], zoom: state.transform[2] };
          if (next.x === last.x && next.y === last.y && next.zoom === last.zoom) return;
          last = next;
          listener(next);
        });
      },
      viewport: () => ({ width: store.getState().width, height: store.getState().height }),
      onViewport: (listener) => {
        let last = `${store.getState().width}x${store.getState().height}`;
        return store.subscribe((state) => {
          const size = `${state.width}x${state.height}`;
          if (size === last) return;
          last = size;
          listener();
        });
      },
      setCamera: (camera) => {
        void rf.setViewport(camera).catch(() => undefined);
      },
      zoomBy: (factor) => {
        const camera = cameraNow();
        const viewport = { width: store.getState().width, height: store.getState().height };
        void rf.setViewport(cameraForTarget({ kind: "zoomBy", factor }, camera, viewport, () => undefined)).catch(() => undefined);
      },
      moveCamera: (target, durationMs) => {
        const camera = cameraForTarget(target, cameraNow(), { width: store.getState().width, height: store.getState().height }, (ids) => {
          const lookup = store.getState().nodeLookup;
          return boundsOfRects(ids.map((id) => {
            const internal = lookup.get(id);
            if (internal === undefined) return undefined;
            const measured = internal.measured;
            const user = internal.internals.userNode;
            return {
              x: internal.internals.positionAbsolute.x,
              y: internal.internals.positionAbsolute.y,
              width: measured.width ?? user.width ?? 0,
              height: measured.height ?? user.height ?? 0,
            };
          }).filter((rect): rect is Rect => rect !== undefined));
        });
        void rf.setViewport(camera, durationMs === undefined ? undefined : { duration: durationMs }).catch(() => undefined);
      },
      screenToBoard: (screen) => {
        const point = rf.screenToFlowPosition({ x: screen.x, y: screen.y });
        return { x: point.x, y: point.y };
      },
      element: dom,
    } satisfies MinimapSource;
  }, [rf, store]);

  useEffect(() => {
    setCanvasApi(api);
    setMinimapSource(minimap);
    return () => {
      clearCanvasApi(api);
      clearMinimapSource(minimap);
    };
  }, [api, minimap]);

  return <CanvasApiProvider api={api}>{children}</CanvasApiProvider>;
}
