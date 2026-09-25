import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_ID = "junto-tooltip";
const SHOW_DELAY_MS = 20;
const TRANSIT_GRACE_MS = 280;
const VIEWPORT_GUTTER = 8;
const TRIGGER_SELECTOR = [
  "[data-tooltip]",
  "[data-junto-tooltip]",
  "[title]",
  "button[aria-label]",
  "a[aria-label]",
  "[role='button'][aria-label]",
  "[role='tab'][aria-label]",
  "[role='option'][aria-label]",
].join(",");

type ActiveTooltip = {
  readonly target: HTMLElement;
  readonly text: string;
};

type TooltipPosition = {
  readonly left: number;
  readonly top: number;
  readonly placement: "top" | "bottom";
};

const triggerFor = (target: EventTarget | null): HTMLElement | null =>
  target instanceof Element ? target.closest<HTMLElement>(TRIGGER_SELECTOR) : null;

/** Minimal surface for absorb — HTMLElement in product, duck type in unit tests. */
export type TitleHost = {
  getAttribute: (name: string) => string | null;
  removeAttribute: (name: string) => void;
  dataset: { tooltip?: string; juntoTooltip?: string };
  querySelectorAll?: (selectors: string) => Iterable<TitleHost>;
};

/**
 * Move native `title` → data-junto-tooltip and strip the attribute so the
 * browser never paints a second OS tooltip beside our branded surface.
 * Safe to call repeatedly (idempotent).
 */
export const absorbNativeTitle = (element: TitleHost): void => {
  const title = element.getAttribute("title")?.trim();
  if (!title) return;
  if (!element.dataset.tooltip) element.dataset.juntoTooltip = title;
  element.removeAttribute("title");
};

/** Absorb titles on a root and every descendant that still carries `title`. */
export const absorbNativeTitlesInTree = (root: TitleHost | null | undefined): void => {
  if (!root) return;
  absorbNativeTitle(root);
  const kids = root.querySelectorAll?.("[title]");
  if (kids) {
    for (const child of kids) absorbNativeTitle(child);
  }
};

const tooltipText = (target: HTMLElement): string => {
  // Always strip native title first so a late React write cannot flash dual tips.
  absorbNativeTitle(target);
  const branded = (
    target.dataset.tooltip
    ?? target.dataset.juntoTooltip
    ?? ""
  ).trim();
  if (branded) return branded;

  const aria = (target.getAttribute("aria-label") ?? "").trim();
  // Icon-only controls: aria-label is the accessible name and the tip text.
  // Skip when the control already exposes the same string as visible text
  // (avoids a redundant tip on labeled text buttons).
  if (!aria) return "";
  const visible = (target.textContent ?? "").replace(/\s+/g, " ").trim();
  if (visible.length > 0 && visible === aria) return "";
  return aria;
};

const removeDescription = (target: HTMLElement): void => {
  const ids = (target.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((id) => id && id !== TOOLTIP_ID);
  if (ids.length > 0) target.setAttribute("aria-describedby", ids.join(" "));
  else target.removeAttribute("aria-describedby");
};

/**
 * One delegated tooltip surface for the entire station. Existing `title`
 * attributes become fast, styled tooltips; icon-only controls fall back to
 * their accessible name. Keeping one portal avoids a component and listener
 * per icon on dense canvases.
 *
 * Native titles are absorbed on mount, on attribute mutation, on subtree
 * insert (React remounts), and again at show-time so the OS tip never races
 * our branded surface.
 */
export function TooltipLayer() {
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const pendingTargetRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef<ActiveTooltip | null>(null);
  const lastShownAtRef = useRef(0);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingTargetRef.current = null;
  };

  const hide = () => {
    clearTimer();
    if (activeRef.current) removeDescription(activeRef.current.target);
    activeRef.current = null;
    setActive(null);
    setPosition(null);
  };

  const show = (target: HTMLElement, immediate = false) => {
    const text = tooltipText(target);
    if (!text) return;
    if (activeRef.current?.target === target && activeRef.current.text === text) return;

    clearTimer();
    pendingTargetRef.current = target;
    const recentlyVisible = performance.now() - lastShownAtRef.current < TRANSIT_GRACE_MS;
    const commit = () => {
      if (!target.isConnected || pendingTargetRef.current !== target) return;
      if (activeRef.current && activeRef.current.target !== target) {
        removeDescription(activeRef.current.target);
      }
      const describedBy = new Set((target.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
      describedBy.add(TOOLTIP_ID);
      target.setAttribute("aria-describedby", [...describedBy].join(" "));
      const next = { target, text };
      activeRef.current = next;
      lastShownAtRef.current = performance.now();
      pendingTargetRef.current = null;
      setPosition(null);
      setActive(next);
    };

    if (immediate || recentlyVisible) commit();
    else timerRef.current = window.setTimeout(commit, SHOW_DELAY_MS);
  };

  useEffect(() => {
    absorbNativeTitlesInTree(document.body);

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.attributeName === "title") {
          if (record.target instanceof HTMLElement) {
            absorbNativeTitle(record.target);
          }
          continue;
        }
        if (record.type === "childList") {
          record.addedNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              absorbNativeTitlesInTree(node);
            } else if (node instanceof Element || node instanceof DocumentFragment) {
              for (const child of node.querySelectorAll("[title]")) {
                if (child instanceof HTMLElement) absorbNativeTitle(child);
              }
            }
          });
        }
      }
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["title"],
      childList: true,
      subtree: true,
    });

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = triggerFor(event.target);
      if (target) show(target);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = activeRef.current?.target ?? pendingTargetRef.current;
      if (!target || target.contains(event.relatedTarget as Node | null)) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = triggerFor(event.target);
      if (target) show(target, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = activeRef.current?.target ?? pendingTargetRef.current;
      if (!target || target.contains(event.relatedTarget as Node | null)) return;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    // focus-law: Escape only hides the tooltip; focus is untouched.
    window.addEventListener("keydown", onKeyDown);

    return () => {
      observer.disconnect();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKeyDown);
      hide();
    };
  }, []);

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!active || !tooltip || !active.target.isConnected) return;
    const anchor = active.target.getBoundingClientRect();
    const tip = tooltip.getBoundingClientRect();
    const roomAbove = anchor.top - VIEWPORT_GUTTER;
    const placement = roomAbove >= tip.height + VIEWPORT_GUTTER ? "top" : "bottom";
    const top = placement === "top"
      ? anchor.top - tip.height - VIEWPORT_GUTTER
      : anchor.bottom + VIEWPORT_GUTTER;
    const idealLeft = anchor.left + anchor.width / 2 - tip.width / 2;
    const left = Math.min(
      window.innerWidth - tip.width - VIEWPORT_GUTTER,
      Math.max(VIEWPORT_GUTTER, idealLeft),
    );
    setPosition({ left: Math.round(left), top: Math.round(top), placement });
  }, [active]);

  if (!active) return null;
  return createPortal(
    <div
      ref={tooltipRef}
      id={TOOLTIP_ID}
      className="junto-tooltip"
      data-placement={position?.placement ?? "top"}
      data-positioned={position ? "true" : "false"}
      role="tooltip"
      style={position ? { left: position.left, top: position.top } : undefined}
    >
      {active.text}
    </div>,
    document.body,
  );
}
