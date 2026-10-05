import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placeBesideRect, type Align, type Side } from "../../lib/menu-placement";
import { topModal } from "../../lib/modal-stack";

// Module-level so the default is one stable array: a fresh literal per render
// would re-run the placement layout effect every render and never settle.
const DEFAULT_SIDES: ReadonlyArray<Side> = ["left", "right", "below", "above"];

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
  sides = DEFAULT_SIDES,
  align = "end",
  width = 320,
  className,
  testId,
  children,
}: {
  readonly anchor: HTMLElement;
  readonly onClose: () => void;
  readonly label: string;
  readonly sides?: ReadonlyArray<Side>;
  /** "center" centres the panel on the anchor; the default hugs its far end. */
  readonly align?: Align;
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
    const place = (): void => {
      setPosition(placeBesideRect(
        anchor.getBoundingClientRect(),
        { width: panel.offsetWidth, height: panel.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        sides,
        align,
      ));
    };
    place();
    // Content that arrives late (a list that loads) changes the panel's size:
    // place again, so it never grows over its anchor.
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [anchor, sides, align]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A modal opened above this popover (a confirm it asked for) is the
      // topmost thing: the key is that modal's.
      const above = topModal()?.container();
      if (above && !above.contains(anchor)) return;
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
      // A layer the panel opened portals outside it (a cascade menu, a
      // confirm dialog); it marks itself so a press there stays inside.
      if (target instanceof Element && target.closest("[data-popover-layer]")) return;
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
      // A popover belongs to the layer of its anchor (styles/layers.css).
      data-layer={anchor.closest("[data-layer='operator']") ? "operator-popover" : "popover"}
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
