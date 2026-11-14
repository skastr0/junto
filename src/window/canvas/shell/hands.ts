/**
 * Hands: every intent the engine emits, wired to the writers the window
 * already has (docs/canvas-gpu-architecture.md, section 15).
 *
 * The engine says what the operator did; this module turns it into the same
 * calls today's cards, pane and toolbar make. The write path is unchanged:
 * one `Move` through `syncPositions` on a drop, one `Move` with `size` on a
 * resize, `addEdge` with the verb on a connect, the existing confirm then one
 * `Remove` on a delete, `activateNodeSurface` on an open, and `state$` for
 * the selection. Undo and redo see exactly the acts they saw before.
 *
 * It also carries the browser's pointer, wheel and held-key input to the
 * engine, and keeps the engine's selection fact in step with `state$`. No
 * React store, no card and no React Flow is read here.
 */

import type { Verb } from "@shared/physics";
import { verbHandleId, addEdge, connectAllToTarget, deleteEdges } from "../../lib/edge-mutations";
import { resizeNode, syncPositions } from "../../lib/geometry";
import { topZ } from "../../lib/model-edits";
import { newNote } from "../../lib/model-factories";
import { addNode, deleteNodes } from "../../lib/mutations";
import { activateNodeSurface } from "../../lib/activate-node-surface";
import { canvasSelectionFact } from "../../lib/canvas-focus";
import { canvasOwnsKeyboard, panKeyFor } from "../../lib/canvas-keyboard-pan";
import { canvasKeyboardTaken } from "../../lib/canvas-keys";
import { dock$, openTaskCreateSurface } from "../../lib/dock-state";
import { claimFocus, isOperatorTyping } from "../../lib/focus-ownership";
import { topModal } from "../../lib/modal-stack";
import { openOperatorModal } from "../../lib/operator-modal";
import { isMac } from "../../lib/platform";
import { dismissPreamble } from "../../lib/preamble-state";
import {
  clearSelection,
  selectEdge,
  selectNode,
  selectNodes,
  state$,
} from "../../lib/state";
import { modelStore } from "../../lib/use-model";
import { openCanvasMenu } from "./canvas-menu";
import type { CanvasInput, Hit, Intent, Point, SelectionFact } from "../contract";

/** The menus the pointer machine asks for, all opened by the shell. */
export type MenuIntent =
  | Extract<Intent, { readonly kind: "menu" }>
  | Extract<Intent, { readonly kind: "connectMenu" }>
  | Extract<Intent, { readonly kind: "marqueeMenu" }>;

/** What input forwarding needs of the engine: one way in. */
export interface InputEngine {
  readonly input: (event: CanvasInput) => void;
}

/** The engine surface hands needs: intents out, scene facts in, input in. */
export interface HandsEngine extends InputEngine {
  readonly apply: (ops: ReadonlyArray<{ readonly kind: "selection"; readonly fact: SelectionFact }>) => void;
  readonly onIntent: (listener: (intent: Intent) => void) => () => void;
}

/** What the shell adds to the wiring: the menus it opens, and the cursor it sets. */
export type HandsHost = {
  /** A context menu was asked for at a board point and the screen point it happened at. */
  readonly menu?: (intent: MenuIntent) => void;
  /** The hovered thing changed; `null` is the pane. */
  readonly hover?: (hit: Hit | null) => void;
};

/** The selection `state$` holds, as the engine is told it — the same fact the feed derives (lib/canvas-focus.ts). */
export const selectionFact = (): SelectionFact => canvasSelectionFact(state$.canvasName.peek());

const toggleInSelection = (id: string): void => {
  const held = state$.selectedNodeIds.peek();
  const single = state$.selectedNodeId.peek();
  const all = held.length === 0 && single !== "" ? [single] : held;
  const next = all.includes(id) ? all.filter((at) => at !== id) : [...all, id];
  if (next.length === 0) clearSelection();
  else selectNodes(next);
};

const select = (intent: Extract<Intent, { readonly kind: "select" }>): void => {
  const ids = [...new Set(intent.nodeIds)];
  if (intent.mode === "toggle") {
    for (const id of ids) toggleInSelection(id);
    return;
  }
  if (intent.mode === "add") {
    const held = state$.selectedNodeIds.peek();
    selectNodes([...new Set([...held, ...ids])]);
    return;
  }
  if (ids.length === 1) selectNode(ids[0]!);
  else selectNodes(ids);
};

/** The kinds whose cards enter text edit on a click while already selected (TextNode.tsx:384-415). */
const textEditable = (id: string): boolean => {
  const name = state$.canvasName.peek();
  if (name === "") return false;
  const node = modelStore.canvasOf(name).nodes.get(id as never);
  return node?.kind === "note" || node?.kind === "label";
};

/** What a click means beyond its intent: whether a gesture is running, and thus what a select is. */
export type HandsMemory = { gesturing: boolean };

/** The verb a connection landed with, when it names one the table knows. */
const verbOf = (intent: Extract<Intent, { readonly kind: "connect" }>): Verb | undefined =>
  intent.verb === undefined ? undefined : (intent.verb as Verb);

/**
 * One intent, at the writer it belongs to. Exported so a test can drive the
 * wiring without a browser and read the command back from the model.
 */
export const handleIntent = (intent: Intent, host: HandsHost = {}, memory: HandsMemory = { gesturing: false }): void => {
  switch (intent.kind) {
    case "select": {
      const ids = [...new Set(intent.nodeIds)];
      const soleBefore =
        ids.length === 1 &&
        state$.selectedNodeIds.peek().length <= 1 &&
        (state$.selectedNodeId.peek() === ids[0] || state$.selectedNodeIds.peek()[0] === ids[0]);
      select(intent);
      // The selection moved to another card: the focus cone was about the old
      // one and is let go (Canvas.tsx:703-708).
      const focus = state$.connectionFocusNodeId.peek();
      const nowSelected = state$.selectedNodeIds.peek();
      const sole = nowSelected.length === 1 ? nowSelected[0] : state$.selectedNodeId.peek();
      if (focus !== "" && focus !== sole) state$.connectionFocusNodeId.set("");
      // The pointer machine reports a click on an already selected note or
      // label as a select. Today that click puts the card into text edit.
      if (!memory.gesturing && intent.mode === "replace" && soleBefore && ids[0] !== undefined && textEditable(ids[0])) {
        state$.editNodeId.set(ids[0]);
      }
      return;
    }
    case "selectWire":
      selectEdge(intent.wireId);
      return;
    case "clearSelection":
      clearSelection();
      return;
    case "move": {
      // Positions are board units; `moved` rounds them, so a drag that lands
      // where it started sends nothing.
      const positions = new Map<string, Point>();
      for (const at of intent.positions) positions.set(at.id, { x: at.x, y: at.y });
      syncPositions(positions);
      return;
    }
    case "resize":
      resizeNode(intent.id, intent.rect);
      return;
    case "connect": {
      const verb = verbOf(intent);
      addEdge({
        source: intent.source,
        target: intent.target,
        sourceHandle: intent.sourceHandle ?? null,
        targetHandle: intent.targetHandle ?? (verb === undefined ? null : verbHandleId(verb)),
      });
      return;
    }
    case "open": {
      // A double click on a note or label opens its text editor on the card
      // today (TextNode.tsx:442-465), not the focused note surface that
      // Cmd+Enter opens.
      if (intent.part.kind === "body" && textEditable(intent.nodeId)) {
        state$.editNodeId.set(intent.nodeId);
        return;
      }
      const surface = activateNodeSurface(intent.nodeId);
      if (surface.opened) return;
      switch (intent.part.kind) {
        case "ringFlag":
          openOperatorModal("feed");
          return;
        case "taskEnqueue":
          openTaskCreateSurface(intent.nodeId);
          return;
        case "bubbleClose":
          dismissPreamble(intent.nodeId);
          return;
        case "regionTitle":
        case "image":
          // The card's own editor: region rename and the image's expanded
          // view both hang off the one-shot edit request the shell observes.
          state$.editNodeId.set(intent.nodeId);
          return;
        default:
          return;
      }
    }
    case "menu":
    case "connectMenu":
    case "marqueeMenu":
      host.menu?.(intent);
      return;
    case "connectAll":
      connectAllToTarget(intent.sourceIds, intent.targetId, { keepSelection: true });
      return;
    case "addNote": {
      const at = { x: Math.round(intent.at.x - 120), y: Math.round(intent.at.y - 50) };
      addNode(newNote({ ...at, z: topZ(modelStore.canvasOf(state$.canvasName.peek())) }));
      return;
    }
    case "hover":
      host.hover?.(intent.hit);
      return;
    case "delete":
      // Today's rule: selected cards win; wires alone are a wire delete. Both
      // ask first through the writer that owns the question.
      if (intent.nodeIds.length > 0) deleteNodes(intent.nodeIds);
      else if (intent.wireIds.length > 0) void deleteEdges(intent.wireIds);
      return;
    case "enqueueTask":
      openTaskCreateSurface(intent.nodeId);
      return;
    case "closeBubble":
      dismissPreamble(intent.nodeId);
      return;
    case "gesture":
      // No writer of its own: the angle of the drag feeds the reach preview
      // (the feed owns it), and the flag tells a click from a gesture so a
      // click on a selected note opens its text editor.
      memory.gesturing = intent.gesture !== null;
      return;
  }
};

/** The canvas's cursor for a hit: the same affordances the DOM chrome showed. */
export const cursorFor = (hit: Hit | null): string => {
  if (hit === null) return "default";
  switch (hit.part.kind) {
    case "pane":
      return "default";
    case "handle":
    case "verbZone":
      return "crosshair";
    case "resize":
      return hit.part.corner === "nw" || hit.part.corner === "se" ? "nwse-resize" : "nesw-resize";
    case "resizeEdge":
      return hit.part.edge === "n" || hit.part.edge === "s" ? "ns-resize" : "ew-resize";
    case "regionTitle":
    case "regionFrame":
      return "grab";
    case "wire":
      return "pointer";
    case "taskEnqueue":
    case "bubbleClose":
    case "noteLink":
    case "ringFlag":
      return "pointer";
    case "image":
    case "body":
      return "grab";
    case "cluster":
      return "pointer";
  }
};

/**
 * Wire the engine's intents to the writers and keep its selection fact in
 * step. Returns the way to stop both.
 */
export const installHands = (engine: HandsEngine, host: HandsHost = {}): (() => void) => {
  const memory: HandsMemory = { gesturing: false };
  const offIntent = engine.onIntent((intent) => handleIntent(intent, host, memory));
  const tell = (): void => engine.apply([{ kind: "selection", fact: selectionFact() }]);
  const offSelection = state$.selectedNodeIds.onChange(tell);
  const offSingle = state$.selectedNodeId.onChange(tell);
  const offEdge = state$.selectedEdgeId.onChange(tell);
  const offFocus = state$.connectionFocusNodeId.onChange(tell);
  tell();
  return () => {
    offIntent();
    offSelection();
    offSingle();
    offEdge();
    offFocus();
  };
};

const modifiersOf = (event: Pick<MouseEvent, "shiftKey" | "altKey" | "ctrlKey" | "metaKey">): {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
} => ({
  shift: event.shiftKey,
  alt: event.altKey,
  ctrl: event.ctrlKey,
  meta: event.metaKey,
});

/**
 * Forward real browser input to the engine: pointer presses, moves and
 * releases (captured, so a drag may leave the element), the wheel as a
 * non-passive gesture, context menus, and the held pan keys. Every shortcut
 * stays in `installKeyDispatcher(KEY_ACTIONS)`; only keys the camera holds
 * are read here, and only while the canvas owns the keyboard.
 */
export const attachCanvasInput = (engine: InputEngine, canvas: HTMLCanvasElement): (() => void) => {
  const point = (event: MouseEvent | WheelEvent): Point => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const pointer = (
    phase: "down" | "move" | "up" | "cancel" | "leave",
    event: PointerEvent,
  ): void => {
    engine.input({
      kind: "pointer",
      phase,
      pointerId: event.pointerId,
      at: point(event),
      // macOS reports a Control-click as the left button; it is the context
      // menu gesture everywhere else, so it is sent as one.
      button: isMac() && event.button === 0 && event.ctrlKey ? 2 : event.button,
      buttons: event.buttons,
      modifiers: modifiersOf(event),
      clicks: event.detail,
    });
  };
  const onDown = (event: PointerEvent): void => {
    claimFocus(canvas, "gesture", { event });
    // A drag keeps its input even when the pointer leaves the canvas.
    if (event.button === 0 || event.button === 1 || event.button === 2) {
      canvas.setPointerCapture?.(event.pointerId);
    }
    pointer("down", event);
  };
  const onMove = (event: PointerEvent): void => pointer("move", event);
  const onUp = (event: PointerEvent): void => {
    pointer("up", event);
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const onCancel = (event: PointerEvent): void => pointer("cancel", event);
  const onLeave = (event: PointerEvent): void => pointer("leave", event);
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    engine.input({
      kind: "wheel",
      at: point(event),
      dx: event.deltaX,
      dy: event.deltaY,
      deltaMode: event.deltaMode,
      modifiers: modifiersOf(event),
    });
  };
  const onContextMenu = (event: MouseEvent): void => {
    // The canvas draws its own menu from the pointer intent.
    event.preventDefault();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    if (panKeyFor(event.key) === null) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isOperatorTyping(event.target) || !canvasOwnsKeyboard(document)) return;
    engine.input({ kind: "key", code: event.key, down: true, modifiers: modifiersOf(event) });
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (panKeyFor(event.key) === null) return;
    engine.input({ kind: "key", code: event.key, down: false, modifiers: modifiersOf(event) });
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onCancel);
  canvas.addEventListener("pointerleave", onLeave);
  // Non-passive: a passive wheel listener makes Chromium treat the gesture as
  // a page scroll, which alone cost refreshes in the spike.
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onCancel);
    canvas.removeEventListener("pointerleave", onLeave);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
  };
};

/**
 * Mount everything the shell needs from the hands: the intent wiring (with
 * the menus and the hover cursor), and the browser's pointer, wheel and held
 * keys. Returns the way to stop all of it.
 */
export const mountHands = (engine: HandsEngine, canvas: HTMLElement): (() => void) => {
  const offHands = installHands(engine, {
    menu: openCanvasMenu,
    hover: (hit) => {
      const cursor = cursorFor(hit);
      if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    },
  });
  return offHands;
};

/**
 * The delete chord the canvas has always bound outside the key table: React
 * Flow listened on the document and refused while a surface was in front.
 * The GPU canvas keeps that behaviour, with the same gates, and sends the
 * same delete the card toolbar sent.
 */
export const attachCanvasDelete = (): (() => void) => {
  // focus-law: refused while the operator types, and while a surface or modal
  // in front owns the keyboard.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key !== "Backspace" && event.key !== "Delete") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isOperatorTyping(event.target)) return;
    if (canvasKeyboardTaken(dock$.registry.surfaces.peek().length > 0, topModal() !== undefined)) return;
    const multi = state$.selectedNodeIds.peek();
    const single = state$.selectedNodeId.peek();
    const nodes = multi.length > 0 ? multi : single === "" ? [] : [single];
    if (nodes.length > 0) {
      event.preventDefault();
      deleteNodes(nodes);
      return;
    }
    const wire = state$.selectedEdgeId.peek();
    if (wire !== "") {
      event.preventDefault();
      void deleteEdges([wire]);
    }
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
};
