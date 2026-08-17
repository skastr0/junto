/**
 * Focus is operator-owned. Background work may preserve it, but must never
 * claim or release it unless the active control explicitly opts into that
 * transition.
 */

export const FOCUS_OWNER_ATTRIBUTE = "data-focus-owner";
export const CANVAS_DRAFT_FOCUS_OWNER = "canvas-draft";
export const INTERACTIVE_FOCUS_OWNER = "interactive";

export const CANVAS_DRAFT_FOCUS_SELECTOR =
  `[${FOCUS_OWNER_ATTRIBUTE}='${CANVAS_DRAFT_FOCUS_OWNER}']`;

type FocusTarget = {
  readonly closest?: (selector: string) => unknown;
};

/**
 * Canvas flush may release focus only from an explicitly marked authoring
 * draft. Unmarked inputs are protected by default, including future work
 * surfaces that do not yet know about this policy.
 */
export const ownsCanvasDraftFocus = (target: FocusTarget | null): boolean => {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest(CANVAS_DRAFT_FOCUS_SELECTOR));
};

/**
 * Async setup (terminal attach, hydration, reconnect) may finish long after
 * the initiating gesture. It can focus only while the operator is still in
 * that surface, or while no control owns focus. Parked/inert surfaces never
 * qualify.
 */
export const canClaimFocusAfterAsyncWork = (
  owner: HTMLElement | null,
  activeElement: Element | null = typeof document === "undefined" ? null : document.activeElement,
): boolean => {
  if (!owner?.isConnected) return false;
  if (owner.closest("[inert]")) return false;
  if (owner.getClientRects().length === 0) return false;
  if (activeElement === null) return true;
  if (typeof document !== "undefined") {
    if (activeElement === document.body || activeElement === document.documentElement) return true;
  }
  return owner.contains(activeElement);
};

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
  activeElement: Element | null = typeof document === "undefined"
    ? null
    : document.activeElement,
): boolean => {
  if (!owner?.isConnected) return false;
  if (owner.closest("[inert]")) return false;
  if (owner.getClientRects().length === 0) return false;
  if (activeElement === null) return true;
  if (typeof document !== "undefined") {
    if (
      activeElement === document.body ||
      activeElement === document.documentElement
    ) {
      return true;
    }
  }
  if (owner.contains(activeElement) && !isNeutralContainer(owner, activeElement)) {
    return false;
  }
  return true;
};

export const focusPrimaryControl = (root: HTMLElement | null): boolean => {
  const target = pickPrimaryFocusControl(root);
  if (!target) return false;
  target.focus();
  if (typeof document === "undefined") return true;
  return document.activeElement === target || target.contains(document.activeElement);
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
