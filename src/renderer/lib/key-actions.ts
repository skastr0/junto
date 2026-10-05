import { cycleActorMirror } from "./actor-mirrors";
import { assignSelectionToSlot, jumpToSlot, recallSlot } from "./command-group-runtime";
import type { KeyActions } from "./key-dispatcher";

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
  // The key is taken only when a swap happened.
  "mirrors.next": () => cycleActorMirror(1),
  "mirrors.previous": () => cycleActorMirror(-1),
};
