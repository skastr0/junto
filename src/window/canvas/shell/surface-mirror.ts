/**
 * The shell's mirror of the scene and the camera (docs/canvas-gpu-architecture.md,
 * sections 16 and 19).
 *
 * The engine reports frame facts; the shell keeps the facts the rest of the
 * app asks for synchronously: a card's board rectangle, board and screen
 * points, the camera, the tier, and the elements anchored to a card. Nothing
 * here renders. Anchors are written straight to the overlay element's style
 * on every camera change and every scene change, so a pan, a drag or a seat
 * report commits no React work.
 *
 * It imports the contract and nothing else from the canvas: no engine, no
 * React, no React Flow.
 */

import { titleOf } from "@shared/model/title";
import type { Node as ModelNode } from "@shared/model/kinds";
import { renderedNodeSize } from "@shared/node-geometry";
import type { Wire as ModelWire } from "@shared/model/wire";
import type {
  Camera,
  CanvasTier,
  CardFact,
  Hit,
  NodeId,
  Point,
  Rect,
  SceneOp,
  SelectionFact,
  Size,
  WireMode,
} from "../contract";
import { boundsOfRects, sameCamera } from "./camera-targets";
import { publishCanvasTier, tierForZoom } from "../../lib/canvas-tier";

export type MirrorCard = {
  readonly id: NodeId;
  readonly row: ModelNode;
  readonly derived: CardFact["derived"];
  readonly text: string;
};

// The rectangle the canvas draws, not the one the row stores: a seat keeps
// its resized row while the engine draws the fixed card size, and the mirror
// must answer the same rectangle the pick, the anchors and the overlay use.
// The stored row is for resize previews and writes only.
const rectOfRow = (row: ModelNode): Rect => ({
  x: row.x,
  y: row.y,
  ...renderedNodeSize(row.kind, row),
});

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export type SurfaceMirror = ReturnType<typeof createSurfaceMirror>;

export const createSurfaceMirror = () => {
  let cards = new Map<NodeId, MirrorCard>();
  let wires = new Map<string, ModelWire>();
  let camera: Camera = { x: 0, y: 0, zoom: 1 };
  let viewport: Size = { width: 0, height: 0 };
  let element: HTMLElement | null = null;
  let wireMode: WireMode = "rest";
  let selection: SelectionFact = { nodeIds: [] };
  let editing: NodeId | null = null;
  let tier: CanvasTier = tierForZoom(1);
  let movedAt = 0;
  let ready = false;
  const cameraListeners = new Set<(camera: Camera) => void>();
  const rectListeners = new Set<() => void>();
  const viewportListeners = new Set<() => void>();
  const selectionListeners = new Set<(fact: SelectionFact) => void>();
  const anchors = new Map<NodeId, Set<HTMLElement>>();

  const screenOrigin = (): Point => {
    if (element === null) return { x: 0, y: 0 };
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  };

  const screenToBoard = (screen: Point): Point => {
    const origin = screenOrigin();
    return {
      x: (screen.x - origin.x - camera.x) / camera.zoom,
      y: (screen.y - origin.y - camera.y) / camera.zoom,
    };
  };

  const boardToScreen = (board: Point): Point => {
    const origin = screenOrigin();
    return {
      x: origin.x + camera.x + board.x * camera.zoom,
      y: origin.y + camera.y + board.y * camera.zoom,
    };
  };

  const boardRectOf = (id: NodeId): Rect | undefined => {
    const card = cards.get(id);
    return card === undefined ? undefined : rectOfRow(card.row);
  };

  const boundsOf = (ids: ReadonlyArray<NodeId>): Rect | undefined =>
    boundsOfRects(ids.map((id) => boardRectOf(id)).filter((rect): rect is Rect => rect !== undefined));

  const screenRectOf = (id: NodeId): Rect | undefined => {
    const rect = boardRectOf(id);
    if (rect === undefined) return undefined;
    const origin = boardToScreen({ x: rect.x, y: rect.y });
    return { x: origin.x, y: origin.y, width: rect.width * camera.zoom, height: rect.height * camera.zoom };
  };

  const writeAnchor = (id: NodeId, node: HTMLElement): void => {
    const rect = screenRectOf(id);
    if (rect === undefined) {
      node.style.visibility = "hidden";
      return;
    }
    node.style.visibility = "";
    node.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
    node.style.setProperty("--anchor-width", `${rect.width}px`);
    node.style.setProperty("--anchor-height", `${rect.height}px`);
    node.style.setProperty("--anchor-zoom", String(camera.zoom));
    node.dataset["anchored"] = id;
  };

  const writeAnchors = (): void => {
    for (const [id, elements] of anchors) for (const node of elements) writeAnchor(id, node);
  };

  const publishTier = (): void => {
    const next = publishCanvasTier(camera.zoom);
    tier = next;
  };

  const notifyCamera = (): void => {
    for (const listener of [...cameraListeners]) listener(camera);
  };

  const setCamera = (next: Camera): void => {
    if (sameCamera(camera, next)) return;
    camera = next;
    movedAt = typeof performance === "undefined" ? Date.now() : performance.now();
    publishTier();
    writeAnchors();
    notifyCamera();
  };

  const notifyRects = (): void => {
    for (const listener of [...rectListeners]) listener();
  };

  const mirrorCard = (fact: CardFact): MirrorCard => ({
    id: fact.id,
    row: fact.row,
    derived: fact.derived,
    text: titleOf(fact.row),
  });

  const apply = (ops: ReadonlyArray<SceneOp>): void => {
    let rectsChanged = false;
    let next = cards;
    for (const op of ops) {
      switch (op.kind) {
        case "load": {
          next = new Map(op.cards.map((fact) => [fact.id, mirrorCard(fact)]));
          wires = new Map(op.wires.map((fact) => [fact.id, fact.row]));
          rectsChanged = true;
          ready = true;
          break;
        }
        case "card": {
          const before = next.get(op.fact.id);
          const after = mirrorCard(op.fact);
          if (before !== undefined && before.text === after.text && sameRect(rectOfRow(before.row), rectOfRow(after.row)) && before.row.z === after.row.z && before.row.kind === after.row.kind) {
            next.set(op.fact.id, { ...after, row: before.row });
            break;
          }
          next = new Map(next);
          next.set(op.fact.id, after);
          rectsChanged = true;
          break;
        }
        case "removeCard": {
          if (!next.has(op.id)) break;
          next = new Map(next);
          next.delete(op.id);
          anchors.delete(op.id);
          rectsChanged = true;
          break;
        }
        case "wire":
          wires.set(op.fact.id, op.fact.row);
          break;
        case "removeWire":
          wires.delete(op.id);
          break;
        case "selection":
          selection = op.fact;
          for (const listener of [...selectionListeners]) listener(selection);
          break;
        case "editing":
          editing = op.id;
          break;
        default:
          break;
      }
    }
    cards = next;
    if (rectsChanged) {
      writeAnchors();
      notifyRects();
    }
  };

  const pick = (screen: Point): Hit | null => {
    const at = screenToBoard(screen);
    let best: MirrorCard | undefined;
    for (const card of cards.values()) {
      const rect = rectOfRow(card.row);
      if (at.x < rect.x || at.y < rect.y || at.x > rect.x + rect.width || at.y > rect.y + rect.height) continue;
      if (best === undefined || card.row.z > best.row.z || (card.row.z === best.row.z && card.row.id > best.row.id)) best = card;
    }
    return best === undefined ? { part: { kind: "pane" }, at } : { nodeId: best.id, part: { kind: "body" }, at };
  };

  return {
    apply,
    ready: () => ready,
    camera: () => camera,
    setCamera,
    viewport: () => viewport,
    setViewport: (next: Size) => {
      if (viewport.width === next.width && viewport.height === next.height) return;
      viewport = next;
      for (const listener of [...viewportListeners]) listener();
    },
    onViewport: (listener: () => void) => {
      viewportListeners.add(listener);
      return () => {
        viewportListeners.delete(listener);
      };
    },
    element: () => element,
    setElement: (next: HTMLElement | null) => {
      element = next;
      writeAnchors();
    },
    screenToBoard,
    boardToScreen,
    boardRectOf,
    screenRectOf,
    boundsOf,
    pick,
    card: (id: NodeId) => cards.get(id),
    cardIds: () => [...cards.keys()].sort((a, b) => {
      const za = cards.get(a)!.row.z;
      const zb = cards.get(b)!.row.z;
      return za === zb ? (a < b ? -1 : a > b ? 1 : 0) : za - zb;
    }),
    regionIds: () => [...cards.values()].filter((card) => card.row.kind === "region").map((card) => card.id),
    selection: () => selection,
    editing: () => editing,
    wireMode: () => wireMode,
    setWireMode: (mode: WireMode) => {
      wireMode = mode;
    },
    onCamera: (listener: (next: Camera) => void) => {
      cameraListeners.add(listener);
      return () => {
        cameraListeners.delete(listener);
      };
    },
    onRects: (listener: () => void) => {
      rectListeners.add(listener);
      return () => {
        rectListeners.delete(listener);
      };
    },
    onSelection: (listener: (fact: SelectionFact) => void) => {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
    anchor: (id: NodeId, node: HTMLElement) => {
      let elements = anchors.get(id);
      if (elements === undefined) anchors.set(id, (elements = new Set()));
      elements.add(node);
      writeAnchor(id, node);
      return () => {
        elements?.delete(node);
        if (elements !== undefined && elements.size === 0) anchors.delete(id);
        delete node.dataset["anchored"];
        node.style.transform = "";
      };
    },
    tier: () => tier,
    settled: () => {
      const now = typeof performance === "undefined" ? Date.now() : performance.now();
      return now - movedAt >= 160;
    },
    markReady: () => {
      ready = true;
    },
    clear: () => {
      cards = new Map();
      wires = new Map();
      ready = false;
      for (const listener of [...rectListeners]) listener();
    },
  };
};
