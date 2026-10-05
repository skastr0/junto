import { cycleActorMirror } from "./actor-mirrors";
import type { KeyActions } from "./key-dispatcher";

/**
 * What each shortcut in the key table does. The table says which keys and
 * where; this says what happens. Nothing else in the app listens for an app
 * shortcut.
 */
export const KEY_ACTIONS: KeyActions = {
  // The key is taken only when a swap happened.
  "mirrors.next": () => cycleActorMirror(1),
  "mirrors.previous": () => cycleActorMirror(-1),
};
