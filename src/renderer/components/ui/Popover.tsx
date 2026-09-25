import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeBesideRect, type Side } from "../../lib/menu-placement";

/**
 * Popover — a small floating panel anchored beside an element, for a short
 * task about that element (answer, confirm, inspect). Portals to the body,
 * sits beside the anchor without covering it where the viewport allows, and
 * closes on Escape or a press outside it. It is a non-modal dialog: callers
 * give it a label, and the first field may claim focus on mount.
 */
export function Popover({
  anchor,
  onClose,
  label,
  sides = ["left", "right", "below", "above"],
  width = 320,
  className,
  testId,
  children,
}: {
  readonly anchor: HTMLElement;
  readonly onClose: () => void;
  readonly label: string;
  readonly sides?: ReadonlyArray<Side>;
  readonly width?: number;
  readonly className?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = anchor.getBoundingClientRect();
    setPosition(placeBesideRect(
      rect,
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      sides,
    ));
  }, [anchor, sides]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Esc belongs to the popover while it is open; the surface under it
      // (a focus modal, a PTY) must not also act on it.
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      if (target instanceof Node && anchor.contains(target)) return;
      onCloseRef.current();
    };
    // focus-law: Escape-only close for an open popover, never a typing shortcut.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      data-testid={testId}
      className={`junto-popover${className ? ` ${className}` : ""}`}
      style={{
        width,
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
