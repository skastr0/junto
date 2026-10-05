import type { CanvasNode } from "@shared/canvas";
import { cycleActorMirror } from "./actor-mirrors";
import { cycleAlertFocus } from "./alert-attention";
import { resetCanvasZoom, zoomCanvasIn, zoomCanvasOut } from "./canvas-zoom";
import { assignSelectionToSlot, jumpToSlot, recallSlot } from "./command-group-runtime";
import { dock$ } from "./dock-state";
import { cancelFocusSwitcher, focusMruNodeIds } from "./focus-switcher";
import { toggleSeatGitDetail } from "./git-summary";
import type { KeyActions } from "./key-dispatcher";
import { redo, undo } from "./mutations";
import { openOperatorModal, toggleOperatorModal, type OperatorModalId } from "./operator-modal";
import { state$ } from "./state";

// A browser page in front owns Cmd+Z: it never edits the canvas behind it.
const browserPageInFront = (): boolean => {
  const registry = dock$.registry.peek();
  const front = registry.surfaces.find((surface) => surface.id === registry.focusMru[0]);
  return front?.kind === "browser" && front.zone === "focus";
};

// The node whose surface is in front, when one is open.
const frontNode = (): CanvasNode | undefined => {
  const registry = dock$.registry.peek();
  const nodeId = focusMruNodeIds(registry.surfaces, registry.focusMru)[0];
  return nodeId === undefined ? undefined : state$.doc.peek().nodes.find((node) => node.id === nodeId);
};

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
  // Nothing to show (no folder, not a git repository): the key passes.
  "git.review": () => {
    const node = frontNode();
    return node !== undefined && toggleSeatGitDetail(node);
  },
  // With no alert waiting, Space and the backtick stay with whatever has focus.
  "alerts.next": () => cycleAlertFocus(),
  "canvas.undo": () => (browserPageInFront() ? false : undo()),
  "canvas.redo": () => (browserPageInFront() ? false : redo()),
  "canvas.zoomIn": () => zoomCanvasIn(),
  "canvas.zoomOut": () => zoomCanvasOut(),
  "canvas.zoomReset": () => resetCanvasZoom(),
  // The key is taken only when a swap happened.
  "mirrors.next": () => cycleActorMirror(1),
  "mirrors.previous": () => cycleActorMirror(-1),
};
