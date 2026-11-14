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
  FrameFacts,
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
import { farSeatScale, seatFloorScale } from "@shared/canvas-tier";
import { heldRingRect } from "@shared/node-geometry";
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

/**
 * What the mirror needs from the engine once one is mounted: the drawn
 * rectangle of a card, live, and the frame facts that carry the rectangles a
 * pointer is moving. A drag moves the drawn card without touching its row, so
 * a mirror that answers only from rows points overlays at where the card used
 * to be.
 */
export type LiveSource = {
  readonly rectOf: (id: NodeId) => Rect | undefined;
  readonly onFrame: (listener: (facts: FrameFacts) => void) => () => void;
};

export type SurfaceMirror = ReturnType<typeof createSurfaceMirror>;

export const createSurfaceMirror = () => {
  let cards = new Map<NodeId, MirrorCard>();
  let wires = new Map<string, ModelWire>();
  let camera: Camera = { x: 0, y: 0, zoom: 1 };
  let viewport: Size = { width: 0, height: 0 };
  let element: HTMLElement | null = null;
  let live: LiveSource | undefined;
  /** Screen rectangles of cards a pointer is dragging or resizing, as the engine drew them this frame. */
  const liveScreen = new Map<NodeId, Rect>();
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
    const drawn = live?.rectOf(id);
    if (drawn !== undefined) return drawn;
    const card = cards.get(id);
    return card === undefined ? undefined : rectOfRow(card.row);
  };

  const boundsOf = (ids: ReadonlyArray<NodeId>): Rect | undefined =>
    boundsOfRects(ids.map((id) => boardRectOf(id)).filter((rect): rect is Rect => rect !== undefined));

  /** A board rectangle on the page, at a given camera. */
  const pageRectOf = (rect: Rect, at: Camera): Rect => {
    const origin = screenOrigin();
    return {
      x: origin.x + at.x + rect.x * at.zoom,
      y: origin.y + at.y + rect.y * at.zoom,
      width: rect.width * at.zoom,
      height: rect.height * at.zoom,
    };
  };

  /**
   * The square a ringed card is drawn in at far and overview: every seat and
   * kind seat holds its ring at a screen size on its content-box centre
   * (canvas-tier.ts farSeatScale, node-geometry.ts heldRingRect), so at far the
   * ring is the whole card, and the card's own rectangle is not painted at all.
   * At zoom 0.15 that is a 40 screen px ring against an 8 px card box, nearly
   * all of it above the box's top edge.
   */
  const ringRectOf = (id: NodeId): Rect | undefined => {
    const card = cards.get(id);
    if (card === undefined) return undefined;
    const far = Math.max(1, Math.min(farSeatScale(camera.zoom), card.derived.ringCap ?? 1));
    const scale = tier === "overview" ? Math.max(seatFloorScale(camera.zoom), far) : tier === "far" ? far : 1;
    return scale <= 1 ? undefined : heldRingRect(card.row, scale);
  };

  const screenRectOf = (id: NodeId): Rect | undefined => {
    // A frame answered for a card the pointer owns: its rectangle is the one
    // the engine drew, not the row's. It is frame-exact even while the mirror
    // camera is a fraction behind, which a drag cannot be.
    const drawn = liveScreen.get(id);
    if (drawn !== undefined) {
      const origin = screenOrigin();
      return { x: drawn.x + origin.x, y: drawn.y + origin.y, width: drawn.width, height: drawn.height };
    }
    const rect = boardRectOf(id);
    if (rect === undefined) return undefined;
    // An overlay anchored to a ringed card sits on what the operator sees. At
    // far and overview that is the held ring alone, so the answer is the ring
    // and never a union with the unpainted card box: a union would centre the
    // selection toolbar a quarter of a card to the right of a 40 px ring.
    const ring = ringRectOf(id);
    return ring === undefined ? pageRectOf(rect, camera) : pageRectOf(ring, camera);
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

  /**
   * Reconcile the live screen rectangles with the frame the engine drew. A
   * card is live exactly while its drawn rectangle differs from the one its
   * row would put on screen: the engine reports the cards a pointer owns, and
   * also the anchored ones, so a card that sits on its row drops out of the
   * cache rather than letting a camera move read a frame-old rectangle.
   */
  const reconcileLive = (facts: FrameFacts): boolean => {
    let changed = false;
    const reported = new Set<NodeId>();
    for (const anchor of facts.anchors) {
      reported.add(anchor.id);
      const card = cards.get(anchor.id);
      const row = card === undefined ? undefined : rectOfRow(card.row);
      if (row !== undefined && sameRect(pageRectOf(row, facts.camera), anchor.rect)) {
        if (liveScreen.delete(anchor.id)) changed = true;
        continue;
      }
      const before = liveScreen.get(anchor.id);
      if (before === undefined || !sameRect(before, anchor.rect)) {
        liveScreen.set(anchor.id, anchor.rect);
        changed = true;
      }
    }
    for (const id of [...liveScreen.keys()]) {
      if (reported.has(id)) continue;
      liveScreen.delete(id);
      changed = true;
    }
    return changed;
  };

  /**
   * One engine frame: the camera, and the live rectangle of every card the
   * pointer is moving. Overlays subscribed through `onRects` re-place from
   * `screenRectOf` in the same frame the card is drawn at its new spot, with no
   * React work. This is the whole of the drag and resize path for the DOM over
   * the canvas.
   */
  const frame = (facts: FrameFacts): void => {
    const moved = !sameCamera(camera, facts.camera);
    const liveChanged = reconcileLive(facts);
    if (moved) setCamera(facts.camera);
    if (!liveChanged) return;
    if (!moved) writeAnchors();
    notifyRects();
  };

  /** Follow a mounted engine: its live rectangles and its frames. Returns the release. */
  const attachLive = (source: LiveSource): (() => void) => {
    live = source;
    const off = source.onFrame(frame);
    return () => {
      off();
      if (live === source) live = undefined;
      liveScreen.clear();
    };
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
    attachLive,
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
      liveScreen.clear();
      ready = false;
      for (const listener of [...rectListeners]) listener();
    },
  };
};
