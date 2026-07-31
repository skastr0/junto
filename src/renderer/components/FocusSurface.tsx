import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  focusMeasureCssVars,
  type FocusHeight,
  type FocusLayer,
  type FocusMeasure,
} from "../lib/focus-measure";

/**
 * Focused single-subject overlay shell.
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
 * Close: backdrop click (optional), Escape (optional). Herdr keeps Esc for
 * the PTY and only closes via Close / ⌘W / backdrop.
 */
export function FocusSurface({
  measure,
  height = "immersive",
  layer = "work",
  contain = "viewport",
  onClose,
  closeOnEscape = true,
  closeOnBackdrop = true,
  label,
  panelClassName,
  children,
}: {
  readonly measure: FocusMeasure;
  readonly height?: FocusHeight;
  readonly layer?: FocusLayer;
  /** `viewport` = body portal (default). `parent` = absolute fill of parent. */
  readonly contain?: "viewport" | "parent";
  readonly onClose: () => void;
  readonly closeOnEscape?: boolean;
  readonly closeOnBackdrop?: boolean;
  readonly label: string;
  readonly panelClassName?: string;
  readonly children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Keep latest onClose without re-binding Escape every parent render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!closeOnEscape) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeOnEscape]);

  // Resizable document surfaces: restore last size for this session.
  useEffect(() => {
    if (height !== "resizable" || !panelRef.current) return;
    const stored = readSessionSize(measure);
    if (!stored) return;
    panelRef.current.style.width = `${stored.width}px`;
    panelRef.current.style.height = `${stored.height}px`;
  }, [height, measure]);

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
      className={[
        "focus-surface",
        `focus-surface--layer-${layer}`,
        `focus-surface--height-${height}`,
        contain === "parent" ? "focus-surface--contain-parent" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="dialog"
      aria-modal={contain === "viewport" ? "true" : undefined}
      aria-label={label}
      style={focusMeasureCssVars(measure)}
    >
      <button
        type="button"
        className="focus-surface__backdrop"
        aria-label={`Close ${label}`}
        tabIndex={-1}
        onClick={() => {
          if (closeOnBackdrop) onClose();
        }}
      />
      <div
        ref={panelRef}
        className={["focus-surface__panel", `focus-surface__panel--${measure}`, panelClassName]
          .filter(Boolean)
          .join(" ")}
        data-measure={measure}
        data-height={height}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
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
