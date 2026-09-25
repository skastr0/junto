/**
 * Focus law: focus is operator-owned, and this module is its only authority.
 *
 * Every programmatic focus(), blur(), and select() in the renderer goes
 * through claimFocus / releaseFocus (gate: `bun run lint:focus-law`). While
 * the operator types in a field (input, textarea, contenteditable, xterm), no
 * other surface may take or drop that focus: not async work, not a live
 * update, not a mount. Only a gesture the operator made outside that field,
 * or a command chord, licenses a claim elsewhere. Global key handlers ask
 * isOperatorTyping before acting.
 */

export const FOCUS_OWNER_ATTRIBUTE = "data-focus-owner";
export const CANVAS_DRAFT_FOCUS_OWNER = "canvas-draft";
export const INTERACTIVE_FOCUS_OWNER = "interactive";

export const CANVAS_DRAFT_FOCUS_SELECTOR =
  `[${FOCUS_OWNER_ATTRIBUTE}='${CANVAS_DRAFT_FOCUS_OWNER}']`;

/**
 * Where the operator types. Terminal hosts count as a whole: focus may sit
 * on xterm chrome rather than its helper textarea.
 */
export const OPERATOR_TYPING_SELECTOR = [
  "input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='color']):not([type='file']):not([type='image'])",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  ".xterm",
  ".native-terminal-surface",
  "[data-terminal-surface]",
].join(", ");

/**
 * One surface the operator works in. Moving focus inside a scope is the
 * surface's own business; moving it across scopes is what the law guards.
 */
export const FOCUS_SCOPE_SELECTOR = [
  "[data-focus-scope]",
  "[data-focus-surface]",
  `[${FOCUS_OWNER_ATTRIBUTE}='${INTERACTIVE_FOCUS_OWNER}']`,
  "[role='dialog']",
  "[role='menu']",
  "[role='listbox']",
  "[data-canvas-menu-surface]",
  ".work-focus-shell",
  ".react-flow__node",
].join(", ");

type Closest = { readonly closest?: (selector: string) => unknown };

const closestOf = (target: unknown, selector: string): unknown => {
  if (!target || typeof (target as Closest).closest !== "function") return null;
  return (target as Closest).closest!(selector) ?? null;
};

/**
 * The one "is the operator typing" guard. Global key handlers return early
 * when this is true for the event target (or, with no argument, for the
 * focused element) so digits, Space, and shortcuts reach the field.
 */
export const isOperatorTyping = (
  target: EventTarget | Element | null | undefined =
    typeof document === "undefined" ? null : document.activeElement,
): boolean => Boolean(closestOf(target, OPERATOR_TYPING_SELECTOR));

/**
 * Canvas flush may release focus only from an explicitly marked authoring
 * draft. Unmarked inputs are protected by default, including future work
 * surfaces that do not yet know about this policy.
 */
export const ownsCanvasDraftFocus = (target: Closest | null): boolean =>
  Boolean(closestOf(target, CANVAS_DRAFT_FOCUS_SELECTOR));

/** A pointer press or key press the operator just made. */
export type OperatorGesture = {
  readonly target: EventTarget | null;
  readonly kind: "pointer" | "key";
  /** Meta/Ctrl held: a command, never text entry. */
  readonly chord: boolean;
  readonly at: number;
};

/**
 * Why focus is moving.
 * - gesture: synchronously inside the operator's own event handler.
 * - open: a surface the operator asked for is mounting or opening.
 * - async: attach, hydrate, reconnect, live update. Never licensed to take
 *   focus from anything but the page itself or its own quiet chrome.
 */
export type FocusClaimCause = "gesture" | "open" | "async";

export type FocusVerdict =
  | { readonly allowed: true; readonly reason: "already-owned" | "free" | "same-scope" | "licensed" }
  | {
      readonly allowed: false;
      readonly reason: "unavailable" | "operator-typing" | "foreign-focus" | "unlicensed";
    };

/** Gestures older than this no longer explain a mount-time claim. */
export const GESTURE_LICENSE_MS = 1000;

type FocusNode = Closest & {
  readonly isConnected?: boolean;
  readonly contains?: (other: never) => boolean;
  readonly getClientRects?: () => { readonly length: number };
};

const containsNode = (outer: unknown, inner: unknown): boolean => {
  if (!outer || !inner) return false;
  if (outer === inner) return true;
  const contains = (outer as FocusNode).contains;
  return typeof contains === "function" && contains.call(outer, inner as never) === true;
};

const scopeOf = (node: unknown): unknown => closestOf(node, FOCUS_SCOPE_SELECTOR);

const isPageRoot = (active: unknown): boolean => {
  if (active === null || active === undefined) return true;
  if (typeof document === "undefined") return false;
  return active === document.body || active === document.documentElement;
};

const isAvailable = (target: FocusNode, cause: FocusClaimCause): boolean => {
  if (target.isConnected !== true) return false;
  if (closestOf(target, "[inert]")) return false;
  // Parked terminals keep their DOM but have no boxes. Async work must not
  // resurrect them under the operator's keyboard.
  if (cause === "async" && typeof target.getClientRects === "function") {
    if (target.getClientRects().length === 0) return false;
  }
  return true;
};

/**
 * A claim across scopes while the operator types is licensed only by a
 * pointer press outside the typing field, or by a command chord. Typing into
 * the field never exports its focus.
 */
const gestureLicenses = (gesture: OperatorGesture | null, typingField: unknown): boolean => {
  if (!gesture) return false;
  if (gesture.chord) return true;
  if (gesture.kind === "key") return false;
  return !containsNode(typingField, gesture.target);
};

/** Pure verdict; claimFocus applies it. Exported for tests. */
export const evaluateFocusClaim = (input: {
  readonly target: FocusNode | null;
  readonly cause: FocusClaimCause;
  readonly active: unknown;
  readonly gesture: OperatorGesture | null;
  /** Async owner that may keep focus already inside itself (a terminal host). */
  readonly owner?: FocusNode | null;
}): FocusVerdict => {
  const { target, cause, active, gesture } = input;
  const owner = input.owner ?? target;
  if (!target || !owner || !isAvailable(owner, cause) || !isAvailable(target, cause)) {
    return { allowed: false, reason: "unavailable" };
  }
  if (active === target) return { allowed: true, reason: "already-owned" };
  if (isPageRoot(active)) return { allowed: true, reason: "free" };

  const typing = isOperatorTyping(active as Element);
  if (cause === "async") {
    // Background work may only settle focus inside its own quiet chrome.
    if (containsNode(owner, active) && !typing) return { allowed: true, reason: "same-scope" };
    return { allowed: false, reason: typing ? "operator-typing" : "foreign-focus" };
  }
  if (!typing) return { allowed: true, reason: "free" };

  const typingScope = scopeOf(active);
  if (typingScope !== null && typingScope === scopeOf(target)) {
    return { allowed: true, reason: "same-scope" };
  }
  if (gestureLicenses(gesture, active)) return { allowed: true, reason: "licensed" };
  return { allowed: false, reason: gesture ? "unlicensed" : "operator-typing" };
};

// Gesture tracker: capture phase on window, so it sees the press before any
// handler that might open a surface in response.
let lastGesture: OperatorGesture | null = null;
let trackerInstalled = false;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export const noteOperatorGesture = (gesture: Omit<OperatorGesture, "at">): void => {
  lastGesture = { ...gesture, at: now() };
};

/** Test seam: forget the last gesture. */
export const resetOperatorGesture = (): void => {
  lastGesture = null;
};

const recentGesture = (): OperatorGesture | null => {
  if (!lastGesture) return null;
  return now() - lastGesture.at <= GESTURE_LICENSE_MS ? lastGesture : null;
};

const installGestureTracker = (): void => {
  if (trackerInstalled || typeof window === "undefined") return;
  if (typeof window.addEventListener !== "function") return;
  trackerInstalled = true;
  const onPointer = (event: Event): void =>
    noteOperatorGesture({ target: event.target, kind: "pointer", chord: false });
  const onKey = (event: KeyboardEvent): void => {
    // Modifier keys alone are not gestures; they precede one.
    if (event.key === "Meta" || event.key === "Control" || event.key === "Shift" || event.key === "Alt") return;
    noteOperatorGesture({
      target: event.target,
      kind: "key",
      chord: event.metaKey || event.ctrlKey,
    });
  };
  window.addEventListener("pointerdown", onPointer, { capture: true });
  window.addEventListener("keydown", onKey, { capture: true });
};

installGestureTracker();

type EventLike = {
  readonly target: EventTarget | null;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly type?: string;
};

const gestureFromEvent = (event: EventLike): OperatorGesture => ({
  target: event.target,
  kind: event.type?.startsWith("key") ? "key" : "pointer",
  chord: event.metaKey === true || event.ctrlKey === true,
  at: now(),
});

type Focusable = { focus: (options?: FocusOptions) => void };

export type ClaimFocusOptions = {
  /** Required for cause "gesture": the operator's event being handled. */
  readonly event?: EventLike;
  /** Select the field's text after focusing (gesture/open only). */
  readonly select?: boolean;
  readonly preventScroll?: boolean;
  /** Widget whose focus() places the caret (xterm focuses its textarea). */
  readonly via?: Focusable;
  /** Async only: container that may already hold focus (terminal host). */
  readonly owner?: HTMLElement | null;
};

const activeElementNow = (): Element | null =>
  typeof document === "undefined" ? null : document.activeElement;

/**
 * The only way to move focus. Returns true when the target owns focus
 * afterwards.
 */
export const claimFocus = (
  target: HTMLElement | null | undefined,
  cause: FocusClaimCause,
  options: ClaimFocusOptions = {},
): boolean => {
  if (!target) return false;
  const gesture =
    cause === "gesture" && options.event
      ? gestureFromEvent(options.event)
      : cause === "async"
        ? null
        : recentGesture();
  const verdict = evaluateFocusClaim({
    target,
    cause,
    active: activeElementNow(),
    gesture,
    owner: options.owner ?? null,
  });
  if (!verdict.allowed) return false;
  if (verdict.reason !== "already-owned") {
    const focusOptions = options.preventScroll ? { preventScroll: true } : undefined;
    if (options.via) options.via.focus(focusOptions);
    else target.focus(focusOptions);
  }
  if (options.select && cause !== "async" && "select" in target) {
    (target as HTMLInputElement).select();
  }
  const active = activeElementNow();
  return active === null || containsNode(options.owner ?? target, active);
};

/**
 * Why a control gives up focus.
 * - gesture: the field's own Enter/Escape handler.
 * - navigation: the document is being swapped or the app is quitting, so
 *   commit-on-blur drafts must land now.
 * There is deliberately no background cause: live updates never blur.
 */
export type FocusReleaseCause = "gesture" | "navigation";

export const releaseFocus = (
  target: (Closest & { blur: () => void }) | null | undefined,
  _cause: FocusReleaseCause,
): boolean => {
  if (!target) return false;
  const active = activeElementNow();
  if (active !== null && !containsNode(target, active)) return false;
  target.blur();
  return true;
};

/**
 * Clipboard fallback: select a detached helper without disturbing the
 * operator's focus or selection. The helper must not be an operator field.
 */
export const selectDetachedForCopy = (helper: HTMLTextAreaElement): void => {
  const previous = activeElementNow() as (HTMLElement & Focusable) | null;
  helper.select();
  if (previous && previous !== helper && activeElementNow() !== previous) {
    previous.focus({ preventScroll: true });
  }
};

/**
 * Async setup (terminal attach, hydration, reconnect) may finish long after
 * the initiating gesture. It can focus only while the operator is still in
 * that surface's quiet chrome, or while nothing owns focus. Parked/inert
 * surfaces never qualify, and a typing field is never taken.
 */
export const canClaimFocusAfterAsyncWork = (
  owner: HTMLElement | null,
  activeElement: Element | null = activeElementNow(),
): boolean =>
  evaluateFocusClaim({
    target: owner,
    cause: "async",
    active: activeElement,
    gesture: null,
    owner,
  }).allowed;

/**
 * First control to receive keyboard when a focus modal opens.
 * Terminals first (xterm helper textarea), then explicit autofocus, then
 * chat/composer drafts and ordinary text fields. Chrome buttons stay out.
 */
export const PRIMARY_FOCUS_SELECTORS = [
  ".xterm-helper-textarea",
  "[data-autofocus]",
  "textarea.chat-composer__input",
  "textarea:not([disabled])",
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([disabled])',
] as const;

type QueryRoot = {
  readonly querySelector: (selector: string) => Element | null;
};

export const pickPrimaryFocusControl = (
  root: QueryRoot | null,
): HTMLElement | null => {
  if (!root) return null;
  for (const selector of PRIMARY_FOCUS_SELECTORS) {
    const found = root.querySelector(selector);
    if (found && typeof (found as HTMLElement).focus === "function") {
      return found as HTMLElement;
    }
  }
  return null;
};

const isNeutralContainer = (owner: HTMLElement, active: Element): boolean => {
  if (active === owner) return true;
  const el = active as HTMLElement;
  const className = typeof el.className === "string" ? el.className : "";
  if (className.includes("focus-surface__panel")) return true;
  if (className.includes("work-focus-shell")) return true;
  if (el.dataset?.focusSurface === "1") return true;
  return false;
};

/**
 * Opening a focus modal is an operator opt-in: take focus from the canvas or
 * the click target that opened it. Do not yank if the operator already chose
 * a real control inside the surface.
 */
export const shouldClaimFocusOnSurfaceOpen = (
  owner: HTMLElement | null,
  activeElement: Element | null = activeElementNow(),
): boolean => {
  if (!owner?.isConnected) return false;
  if (owner.closest("[inert]")) return false;
  if (owner.getClientRects().length === 0) return false;
  if (activeElement === null) return true;
  if (isPageRoot(activeElement)) return true;
  if (owner.contains(activeElement) && !isNeutralContainer(owner, activeElement)) {
    return false;
  }
  return true;
};

export const focusPrimaryControl = (root: HTMLElement | null): boolean => {
  const target = pickPrimaryFocusControl(root);
  if (!target) return false;
  return claimFocus(target, "open") || Boolean(root?.contains(activeElementNow()));
};

/**
 * Focus the primary control now, then briefly retry while xterm / slot
 * adoption finishes. Stops once a real inner control owns focus.
 */
export const scheduleFocusPrimaryControl = (
  getRoot: () => HTMLElement | null,
): (() => void) => {
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const attempt = (): boolean => {
    if (cancelled) return true;
    const root = getRoot();
    if (!root) return false;
    if (!shouldClaimFocusOnSurfaceOpen(root)) return true;
    return focusPrimaryControl(root);
  };
  if (attempt()) {
    return () => {
      cancelled = true;
    };
  }
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(() => {
          if (attempt()) return;
          timers.push(setTimeout(attempt, 48));
          timers.push(setTimeout(attempt, 160));
        })
      : 0;
  if (typeof requestAnimationFrame !== "function") {
    timers.push(setTimeout(attempt, 0));
    timers.push(setTimeout(attempt, 48));
    timers.push(setTimeout(attempt, 160));
  }
  return () => {
    cancelled = true;
    if (typeof cancelAnimationFrame === "function" && raf) {
      cancelAnimationFrame(raf);
    }
    for (const timer of timers) clearTimeout(timer);
  };
};

/**
 * Callback refs that replace JSX autoFocus: the mount is an "open" claim, so
 * a field that appears while the operator types elsewhere stays quiet.
 * Module-level constants keep ref identity stable (runs on mount only).
 */
export const claimFocusOnMount = (element: HTMLElement | null): void => {
  if (element) claimFocus(element, "open");
};

export const claimFocusAndSelectOnMount = (element: HTMLElement | null): void => {
  if (element) claimFocus(element, "open", { select: true });
};
