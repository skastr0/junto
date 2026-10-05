import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  focusMeasureCssVars,
  type FocusHeight,
  type FocusLayer,
  type FocusMeasure,
} from "../lib/focus-measure";
import { claimFocus, scheduleFocusPrimaryControl } from "../lib/focus-ownership";
import { useModalLayer } from "../lib/modal-stack";

/**
 * Focused single-subject overlay shell: the working modal. It sits at
 * --layer-working and joins the modal stack, so Escape closes only the
 * topmost surface and closing returns focus to where it was.
 *
 * Default: portal to document.body so inspector backdrop-filter / canvas
 * transforms cannot clip or reparent `position: fixed`. One instance per
 * caller state slot — the shell does not coordinate siblings.
 *
 * `contain="parent"`: render in place with absolute fill (parent must be
 * positioned). WorkFocusShell uses this so the pinned stage dock stays
 * interactive — a body portal at z-index 10000 would cover the dock and
 * steal wheel/pointer from pinned PTYs when focus + pinned are both open.
 *
 * Measure constrains width for human readability (see focus-measure.ts).
 * Height policy picks immersive (agent work), fit (forms), or resizable
 * (browse detail with session size memory).
 *
 * Close: backdrop click (optional), Escape (optional). The PTY keeps Esc for
 * the PTY and only closes via Close / ⌘W / backdrop.
 */
export function FocusSurface({
  measure,
  height = "immersive",
  contain = "viewport",
  onClose,
  closeOnEscape = true,
  closeOnBackdrop = true,
  label,
  panelClassName,
  terminalRailsPx,
  aside,
  claimFocusOnOpen = true,
  onKeyDown,
  children,
}: {
  readonly measure: FocusMeasure;
  readonly height?: FocusHeight;
  /**
   * Retired: every focus surface is a working modal now, at one layer. The
   * prop is ignored and goes once its last caller drops it.
   */
  readonly layer?: FocusLayer;
  /** `viewport` = body portal (default). `parent` = absolute fill of parent. */
  readonly contain?: "viewport" | "parent";
  readonly onClose: () => void;
  readonly closeOnEscape?: boolean;
  readonly closeOnBackdrop?: boolean;
  readonly label: string;
  readonly panelClassName?: string;
  /**
   * Extra panel width budgeted for an in-panel actor context pane. Zero for
   * pane-less surfaces.
   */
  readonly terminalRailsPx?: number;
  /**
   * Optional rail outside the modal plate (sibling of the panel, still above
   * the dim backdrop). Used for actor edge inventory so it never covers the
   * focused subject.
   */
  readonly aside?: ReactNode;
  /**
   * Put the keyboard on the primary control when opening. False for surfaces
   * where the operator picks the subject first (the terminal grid).
   */
  readonly claimFocusOnOpen?: boolean;
  /**
   * The body's keys, heard wherever focus sits inside the surface, before
   * Escape and the Tab trap. Call preventDefault to keep a key from them.
   */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const modal = useModalLayer({
    layer: "working",
    containerRef: rootRef,
    // A parent-contained surface shares the screen with the pinned dock.
    trap: contain === "viewport",
    isolate: false,
    onKeyDown,
    onEscape: () => {
      if (!closeOnEscape) return false;
      onClose();
      return true;
    },
  });

  // Resizable document surfaces: restore last size for this session.
  useEffect(() => {
    if (height !== "resizable" || !panelRef.current) return;
    const stored = readSessionSize(measure);
    if (!stored) return;
    panelRef.current.style.width = `${stored.width}px`;
    panelRef.current.style.height = `${stored.height}px`;
  }, [height, measure]);

  // Opening the modal is the operator opt-in: put keyboard on the subject
  // (xterm textarea, composer, first field) instead of leaving it on the canvas.
  useEffect(() => {
    // A modal always holds the keyboard: first on its own panel, then on
    // the subject when it has one. Without this a surface with no primary
    // control leaves focus on whatever opened it, behind the dim.
    const panel = panelRef.current;
    if (contain === "viewport" && panel && !rootRef.current?.contains(document.activeElement)) {
      claimFocus(panel, "open", { preventScroll: true });
    }
    if (!claimFocusOnOpen) return;
    return scheduleFocusPrimaryControl(() => panelRef.current);
  }, [claimFocusOnOpen, contain]);

  useEffect(() => {
    if (height !== "resizable") return;
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      writeSessionSize(measure, {
        width: panel.offsetWidth,
        height: panel.offsetHeight,
      });
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [height, measure]);

  const root = (
    <div
      ref={rootRef}
      data-focus-surface="1"
      data-focus-owner="interactive"
      data-layer="working"
      onKeyDown={modal.onKeyDown}
      className={[
        "focus-surface",
        `focus-surface--height-${height}`,
        contain === "parent" ? "focus-surface--contain-parent" : "",
        aside ? "focus-surface--has-aside" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="dialog"
      aria-modal={contain === "viewport" ? "true" : undefined}
      aria-label={label}
      style={focusMeasureCssVars(measure, { terminalRailsPx })}
    >
      <button
        type="button"
        data-layer-backdrop
        aria-label={`Close ${label}`}
        tabIndex={-1}
        onClick={() => {
          if (closeOnBackdrop) onClose();
        }}
      />
      <div className="focus-surface__frame">
        <div
          ref={panelRef}
          className={["focus-surface__panel", `focus-surface__panel--${measure}`, panelClassName]
            .filter(Boolean)
            .join(" ")}
          data-measure={measure}
          data-height={height}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
        {aside ? (
          <div
            className="focus-surface__aside"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {aside}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (contain === "parent") return root;
  return createPortal(root, document.body);
}

// --- session size memory (resizable only) ------------------------------------

const sessionSizes = new Map<FocusMeasure, { width: number; height: number }>();

function readSessionSize(measure: FocusMeasure) {
  return sessionSizes.get(measure);
}

function writeSessionSize(measure: FocusMeasure, size: { width: number; height: number }) {
  sessionSizes.set(measure, size);
}
