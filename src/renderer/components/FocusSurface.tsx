import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  focusMeasureCssVars,
  type FocusHeight,
  type FocusMeasure,
} from "../lib/focus-measure";
import { claimFocus, pickPrimaryFocusControl, scheduleFocusPrimaryControl } from "../lib/focus-ownership";
import { noteSubjectInUse, subjectOf, useModalLayer } from "../lib/modal-stack";
import { clampToFrame, watchOperatorResize } from "../lib/operator-resize";
import { nodeViewStore } from "../lib/node-view-state";
import { FocusWindowContext, type FocusWindow } from "./ui/FocusWindow";

// What a press may land on and keep: controls, fields, and the terminal.
// Anything else in the panel is blank chrome or plain text.
const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "label",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
  "[role='button']",
  "[role='tab']",
  "[role='option']",
  "[role='menuitem']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='slider']",
  // The terminal itself. Not the terminal surface or its body: the header
  // and the rail live inside those, and a blank press there must give the
  // keyboard back.
  ".xterm",
].join(", ");

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
 * Maximize: any surface that is not `fit` offers its header a toggle that
 * widens the panel to the full frame, less the surface's own padding
 * (`data-maximized`, styled in styles.css). Size memory is the operator's
 * drag on the resize grip and nothing else, so restoring returns the size
 * they chose.
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
  maximizable = true,
  onKeyDown,
  children,
}: {
  readonly measure: FocusMeasure;
  readonly height?: FocusHeight;
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
   * False for a surface that already fills the frame (the terminal grid):
   * a Maximize there would do nothing.
   */
  readonly maximizable?: boolean;
  /**
   * The body's keys, heard wherever focus sits inside the surface, before
   * Escape and the Tab trap. Call preventDefault to keep a key from them.
   */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  readonly children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  const focusWindow = useMemo<FocusWindow | null>(
    () => (height === "fit" || !maximizable ? null : { maximized, toggleMaximized: () => setMaximized((on) => !on) }),
    [height, maximizable, maximized],
  );
  const asideRef = useRef<HTMLDivElement>(null);
  const modal = useModalLayer({
    layer: "working",
    containerRef: rootRef,
    // A parent-contained surface shares the screen with live chrome.
    trap: contain === "viewport",
    isolate: false,
    onClose,
    onKeyDown,
    onEscape: () => {
      if (!closeOnEscape) return false;
      onClose();
      return true;
    },
  });

  // Resizable document surfaces: restore the size the operator last dragged
  // this surface to, never more than the frame has now.
  useEffect(() => {
    if (height !== "resizable" || !panelRef.current) return;
    const stored = nodeViewStore().surfaceSize(label);
    if (!stored) return;
    const frame = panelRef.current.parentElement;
    panelRef.current.style.width = `${clampToFrame(stored.width, frame?.clientWidth ?? 0)}px`;
    panelRef.current.style.height = `${clampToFrame(stored.height, frame?.clientHeight ?? 0)}px`;
  }, [height, label]);

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

  // Only a drag on the resize grip is remembered, and a double click on it
  // forgets the size (see operator-resize.ts).
  useEffect(() => {
    const panel = panelRef.current;
    if (height !== "resizable" || !panel) return;
    return watchOperatorResize(panel, {
      onResize: (size) => nodeViewStore().writeSurfaceSize(label, { width: Math.round(size.width), height: Math.round(size.height) }),
      onReset: () => {
        nodeViewStore().writeSurfaceSize(label, null);
        panel.style.removeProperty("width");
        panel.style.removeProperty("height");
      },
    });
  }, [height, label]);

  // A press on blank chrome (an empty header, the space under a list, an
  // empty stretch of the rail) would park the keyboard on the panel or drop
  // it on the page, and typing would stop reaching the subject. Give it back
  // to the primary control. A press on a control keeps what it did, and a
  // drag that selected text is left alone.
  //
  // Native listeners, not React's: a terminal surface is adopted into the
  // panel's DOM from another React tree, so React never routes its clicks
  // through this component.
  const hasAside = aside !== undefined && aside !== null && aside !== false;
  useEffect(() => {
    const regions = [panelRef.current, asideRef.current].filter((el): el is HTMLDivElement => el !== null);
    const onClick = (event: globalThis.MouseEvent): void => {
      const region = event.currentTarget;
      const target = event.target;
      if (!(region instanceof Element) || !(target instanceof Element)) return;
      const control = target.closest(INTERACTIVE_SELECTOR);
      if (control !== null && control !== region && region.contains(control)) return;
      if (window.getSelection()?.isCollapsed === false) return;
      // The subject in use: in a grid, the terminal last typed into.
      const subject = subjectOf(region) ?? pickPrimaryFocusControl(panelRef.current);
      if (subject) claimFocus(subject, "gesture", { event, preventScroll: true });
    };
    const root = rootRef.current;
    const onFocusIn = (event: FocusEvent): void => {
      if (root && event.target instanceof HTMLElement) noteSubjectInUse(root, event.target);
    };
    for (const region of regions) region.addEventListener("click", onClick);
    root?.addEventListener("focusin", onFocusIn);
    return () => {
      for (const region of regions) region.removeEventListener("click", onClick);
      root?.removeEventListener("focusin", onFocusIn);
    };
  }, [hasAside]);

  const root = (
    <div
      ref={rootRef}
      data-focus-surface="1"
      data-focus-owner="interactive"
      data-layer="working"
      data-maximized={maximized ? "true" : undefined}
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
        // The dim is a pointer target only: Escape and the close button are the named ways out.
        aria-hidden="true"
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
          <FocusWindowContext.Provider value={focusWindow}>{children}</FocusWindowContext.Provider>
        </div>
        {aside ? (
          <div
            ref={asideRef}
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

// --- size memory (resizable only) --------------------------------------------
// Kept in view state by surface, not by measure (0.11, 04, V3): eight
// surfaces share the document measure, and one's size is not another's. A
// quit brings it back.
