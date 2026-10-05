import { cycleActorMirror } from "./actor-mirrors";
import { cycleAlertFocus } from "./alert-attention";
import { assignSelectionToSlot, jumpToSlot, recallSlot } from "./command-group-runtime";
import { dock$ } from "./dock-state";
import type { KeyActions } from "./key-dispatcher";
import { redo, undo } from "./mutations";

// A browser page in front owns Cmd+Z: it never edits the canvas behind it.
const browserPageInFront = (): boolean => {
  const registry = dock$.registry.peek();
  const front = registry.surfaces.find((surface) => surface.id === registry.focusMru[0]);
  return front?.kind === "browser" && front.zone === "focus";
};

/**
 * What each shortcut in the key table does. The table says which keys and
 * where; this says what happens. Nothing else in the app listens for an app
 * shortcut.
 */
export const KEY_ACTIONS: KeyActions = {
  "groups.assign": ({ digit }) => assignSelectionToSlot(digit! - 1),
  // An empty slot takes nothing: the digit passes.
  "groups.recall": ({ digit }) => recallSlot(digit! - 1),
  "groups.jump": ({ digit }) => jumpToSlot(digit! - 1),
  // With no alert waiting, Space and the backtick stay with whatever has focus.
  "alerts.next": () => cycleAlertFocus(),
  "canvas.undo": () => (browserPageInFront() ? false : undo()),
  "canvas.redo": () => (browserPageInFront() ? false : redo()),
  // The key is taken only when a swap happened.
  "mirrors.next": () => cycleActorMirror(1),
  "mirrors.previous": () => cycleActorMirror(-1),
};
