import { keyboardSettings } from "../../shared/settings";
import {
  resolveKey,
  resolveRelease,
  shortcutRepeats,
  type KeyContext,
  type KeyHit,
  type KeyOverrides,
  type KeySituation,
  type ShortcutId,
} from "../../shared/key-table";
import { dock$ } from "./dock-state";
import { isOperatorTyping } from "./focus-ownership";
import { focusSwitcher$ } from "./focus-switcher";
import { getJuntoApi } from "./junto-api";
import { frontModalLayer } from "./modal-stack";
import { isOperatorModalOpen } from "./operator-modal";
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

// Mirrors the terminal entries of OPERATOR_TYPING_SELECTOR (focus-ownership);
// a test holds the two together.
export const TERMINAL_SELECTOR = ".xterm, .native-terminal-surface, [data-terminal-surface]";

/** Runs a shortcut. Return false when there was nothing to do: the key passes. */
export type KeyAction = (hit: KeyHit, event: KeyboardEvent) => boolean | void;

export type KeyActions = Readonly<Partial<Record<ShortcutId, KeyAction>>>;

export type KeyPlace = {
  /** The urgency switcher is up. */
  readonly switcher: boolean;
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
  if (place.switcher) return "switcher";
  if (place.operator) return "operator";
  if (place.terminal) return "terminal";
  if (place.typing) return "field";
  return place.working ? "working" : "canvas";
};

const workingModalOpen = (): boolean =>
  state$.settingsOpen.peek() ||
  dock$.registry.surfaces.peek().some((surface) => surface.zone === "focus");

type Closest = { readonly closest?: (selector: string) => unknown };

/** Where the keyboard is for a key aimed at `target`. */
export const keySituation = (target: EventTarget | null): KeySituation => {
  const typing = isOperatorTyping(target);
  const terminal =
    typing && typeof (target as Closest | null)?.closest === "function"
      ? (target as Closest).closest!(TERMINAL_SELECTOR) != null
      : false;
  const front = frontModalLayer();
  return {
    mac: isMac(),
    typing,
    context: keyContextOf({
      switcher: focusSwitcher$.session.peek() !== null,
      operator: isOperatorModalOpen() || front === "operator" || front === "operator-dialog",
      terminal,
      typing,
      working: front !== null || workingModalOpen(),
    }),
  };
};

/** The chords the operator changed, from Settings. */
const storedOverrides = (): KeyOverrides => keyboardSettings(state$.settings.peek()).overrides;

let holds = 0;

/**
 * Stand every shortcut down while a new chord is being recorded: the
 * dispatcher's and the menu bar's. Every key then belongs to the recorder,
 * Cmd+Q included. Call the returned function to let go.
 */
export const holdKeyDispatch = (): (() => void) => {
  holds += 1;
  if (holds === 1) getJuntoApi()?.ignoreMenuShortcuts(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) getJuntoApi()?.ignoreMenuShortcuts(false);
  };
};

const take = (event: KeyboardEvent): void => {
  event.preventDefault();
  event.stopPropagation();
};

/** What a keydown did: nothing of ours, or the shortcut that took it. */
export const dispatchKey = (
  event: KeyboardEvent,
  actions: KeyActions,
  situation: KeySituation = keySituation(event.target),
  overrides: KeyOverrides = storedOverrides(),
): ShortcutId | null => {
  if (event.isComposing) return null;
  const hit = resolveKey(event, situation, overrides);
  if (hit === null) return null;
  const action = actions[hit.id];
  if (!action) return null;
  // Holding a chord is one press, unless its row says it repeats. The
  // repeats are still ours: they reach neither the terminal nor the menu bar.
  if (event.repeat && !shortcutRepeats(hit.id)) {
    take(event);
    return null;
  }
  if (action(hit, event) === false) return null;
  take(event);
  return hit.id;
};

/** A held modifier was let go: run the shortcut that waits on it here. */
export const dispatchRelease = (
  event: KeyboardEvent,
  actions: KeyActions,
  situation: KeySituation = keySituation(event.target),
): ShortcutId | null => {
  if (event.key !== "Meta") return null;
  const hit = resolveRelease("Cmd", situation);
  if (hit === null) return null;
  actions[hit.id]?.(hit, event);
  return hit.id;
};

export const installKeyDispatcher = (actions: KeyActions): (() => void) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (holds === 0) dispatchKey(event, actions);
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (holds === 0) dispatchRelease(event, actions);
  };
  // focus-law: every shortcut goes through the key table, which never fires a typed character while the operator types.
  window.addEventListener("keydown", onKeyDown, { capture: true });
  // focus-law: acts only when Cmd is let go while the switcher is up.
  window.addEventListener("keyup", onKeyUp, { capture: true });
  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    window.removeEventListener("keyup", onKeyUp, { capture: true });
  };
};
