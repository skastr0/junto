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
