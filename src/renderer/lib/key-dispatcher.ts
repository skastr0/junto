import {
  resolveKey,
  type KeyContext,
  type KeyHit,
  type KeySituation,
  type ShortcutId,
} from "../../shared/key-table";
import { dock$ } from "./dock-state";
import { isOperatorTyping } from "./focus-ownership";
import { isModalLayerOpen } from "./modal-stack";
import { isOperatorModalOpen, TERMINAL_SELECTOR } from "./operator-modal";
import { isMac } from "./platform";
import { state$ } from "./state";

/**
 * The key dispatcher: the one window listener for app shortcuts. It works
 * out where the keyboard is, asks the key table what the keydown means
 * there, and runs that shortcut's action.
 *
 * Capture phase, so a chord that is ours never reaches a terminal or a
 * field. A key the table does not name, and a shortcut whose action had
 * nothing to do, pass through untouched.
 */

/** Runs a shortcut. Return false when there was nothing to do: the key passes. */
export type KeyAction = (hit: KeyHit, event: KeyboardEvent) => boolean | void;

export type KeyActions = Readonly<Partial<Record<ShortcutId, KeyAction>>>;

export type KeyPlace = {
  /** An operator modal (search, the needs-you feed) is open. */
  readonly operator: boolean;
  /** Focus is in a terminal. */
  readonly terminal: boolean;
  /** Focus is in a field the operator types in (terminals included). */
  readonly typing: boolean;
  /** A working modal or Settings is open. */
  readonly working: boolean;
};

/** The one answer to "where is the keyboard". */
export const keyContextOf = (place: KeyPlace): KeyContext => {
  if (place.operator) return "operator";
  if (place.terminal) return "terminal";
  if (place.typing) return "field";
  return place.working ? "working" : "canvas";
};

const workingModalOpen = (): boolean =>
  state$.settingsOpen.peek() ||
  dock$.registry.surfaces.peek().some((surface) => surface.zone === "focus") ||
  isModalLayerOpen("working") ||
  isModalLayerOpen("working-dialog");

type Closest = { readonly closest?: (selector: string) => unknown };

/** Where the keyboard is for a key aimed at `target`. */
export const keySituation = (target: EventTarget | null): KeySituation => {
  const typing = isOperatorTyping(target);
  const terminal =
    typing && typeof (target as Closest | null)?.closest === "function"
      ? (target as Closest).closest!(TERMINAL_SELECTOR) != null
      : false;
  return {
    mac: isMac(),
    typing,
    context: keyContextOf({
      operator: isOperatorModalOpen() || isModalLayerOpen("operator"),
      terminal,
      typing,
      working: workingModalOpen(),
    }),
  };
};

/** What a keydown did: nothing of ours, or the shortcut that took it. */
export const dispatchKey = (
  event: KeyboardEvent,
  actions: KeyActions,
  situation: KeySituation = keySituation(event.target),
): ShortcutId | null => {
  // Auto-repeat never acts: holding a chord is one press.
  if (event.repeat || event.isComposing) return null;
  const hit = resolveKey(event, situation);
  if (hit === null) return null;
  const action = actions[hit.id];
  if (!action || action(hit, event) === false) return null;
  event.preventDefault();
  event.stopPropagation();
  return hit.id;
};

export const installKeyDispatcher = (actions: KeyActions): (() => void) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    dispatchKey(event, actions);
  };
  // focus-law: every shortcut goes through the key table, which never fires a typed character while the operator types.
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
};
