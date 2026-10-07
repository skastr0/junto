import type { CanvasNode } from "@shared/canvas";
import { activateSelectedNodeSurface } from "./activate-node-surface";
import { actorRailExpanded, actorRailMode, setActorRailExpanded } from "./actor-rail";
import { cycleActorMirror } from "./actor-mirrors";
import { resetCanvasZoom, zoomCanvasIn, zoomCanvasOut } from "./canvas-zoom";
import { assignSelectionToSlot, jumpToSlot, recallSlot } from "./command-group-runtime";
import { dock$, parseTerminalSurfaceId } from "./dock-state";
import {
  cancelFocusSwitcher,
  commitFocusSwitcher,
  focusMruNodeIds,
  focusSwitcher$,
  moveFocusSwitcher,
  openFocusSwitcher,
} from "./focus-switcher";
import { closeFront } from "./front-close";
import { toggleSeatGitDetail } from "./git-summary";
import type { KeyActions } from "./key-dispatcher";
import { redo, undo } from "./mutations";
import { openOperatorModal, toggleOperatorModal, type OperatorModalId } from "./operator-modal";
import { state$ } from "./state";
import { focusFrontTerminal, focusTerminalChrome } from "./terminal-chrome-focus";
import { spacePressesControl, stepToNextAgent } from "./urgency-step";

// The node whose surface is in front, when one is open.
const frontNode = (): CanvasNode | undefined => {
  const registry = dock$.registry.peek();
  const nodeId = focusMruNodeIds(registry.surfaces, registry.focusMru)[0];
  return nodeId === undefined ? undefined : state$.doc.peek().nodes.find((node) => node.id === nodeId);
};

// The terminal in front shows a list of connections. A raw shell, or an
// agent connected to nothing, has none.
const railInFront = (): boolean => {
  const registry = dock$.registry.peek();
  const front = registry.surfaces.find((surface) => surface.id === registry.focusMru[0]);
  const nodeId = front?.kind === "terminal" && front.zone === "focus" ? parseTerminalSurfaceId(front.id) : null;
  return nodeId !== null && actorRailMode(state$.doc.peek(), nodeId, actorRailExpanded()) !== "none";
};

// The first tap brings the switcher up one step along; later taps move it.
const stepSwitcher = (direction: 1 | -1): boolean =>
  focusSwitcher$.session.peek() ? moveFocusSwitcher(direction) : openFocusSwitcher(direction);

// The switcher is an operator surface too: one at a time.
const toggleOperator = (id: OperatorModalId): void => {
  cancelFocusSwitcher();
  toggleOperatorModal(id);
};

/**
 * What each shortcut in the key table does. The table says which keys and
 * where; this says what happens. Nothing else in the app listens for an app
 * shortcut.
 */
export const KEY_ACTIONS: KeyActions = {
  // A modal's own chord closes it; the other's swaps to it.
  "search.open": () => toggleOperator("search"),
  "feed.open": () => toggleOperator("feed"),
  "search.slash": () => {
    cancelFocusSwitcher();
    openOperatorModal("search");
  },
  "groups.assign": ({ digit }) => assignSelectionToSlot(digit! - 1),
  // An empty slot takes nothing: the digit passes.
  "groups.recall": ({ digit }) => recallSlot(digit! - 1),
  "groups.jump": ({ digit }) => jumpToSlot(digit! - 1),
  // With fewer than two places to go the switcher stays down and the key passes.
  "urgency.next": () => stepSwitcher(1),
  "urgency.previous": () => stepSwitcher(-1),
  "switcher.next": () => moveFocusSwitcher(1),
  "switcher.previous": () => moveFocusSwitcher(-1),
  // Also runs when Cmd is let go.
  "switcher.commit": () => {
    commitFocusSwitcher();
  },
  "switcher.cancel": () => cancelFocusSwitcher(),
  // Nothing to show (no folder, not a git repository): the key passes.
  "git.review": () => {
    const node = frontNode();
    return node !== undefined && toggleSeatGitDetail(node);
  },
  // With no agent on the canvas, Space and the backtick stay with whatever
  // has focus; Space on a focused button or link presses it.
  "alerts.next": (_hit, event) => !spacePressesControl(event) && stepToNextAgent(),
  "canvas.undo": () => undo(),
  "canvas.redo": () => redo(),
  "canvas.zoomIn": () => zoomCanvasIn(),
  "canvas.zoomOut": () => zoomCanvasOut(),
  "canvas.zoomReset": () => resetCanvasZoom(),
  // With no connections list in front the key passes, and the choice it
  // would have flipped for every other agent is left alone.
  "rail.toggle": () => {
    if (!railInFront()) return false;
    setActorRailExpanded(!actorRailExpanded());
    return true;
  },
  // With no terminal in front the key passes.
  "focus.toChrome": (_hit, event) => focusTerminalChrome(event),
  "focus.toTerminal": (_hit, event) => focusFrontTerminal(event),
  // Nothing selected, or nothing it can open: the key passes.
  "canvas.open": () => activateSelectedNodeSurface().opened,
  // Always ours: a press held back by the overshoot guard must not fall
  // through to anything else.
  "front.close": () => {
    closeFront();
  },
  // The key is taken only when a swap happened.
  "mirrors.next": () => cycleActorMirror(1),
  "mirrors.previous": () => cycleActorMirror(-1),
};
