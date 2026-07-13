import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

// Module-level storage for the modal size during the session
let sessionModalSize: { width: number; height: number } | undefined;

// Generic centered overlay shell for the browse row-detail modals
// (glyph/signal/session/dispatch). Escape, a backdrop click, and the × all
// close it; the caller owns what renders inside and — critically — owns
// keeping at most one instance mounted at a time via a single "active
// detail" state slot, so this shell never has to coordinate with a sibling.
export function DetailModal({
  onClose,
  children,
}: {
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Restore modal size from session storage on mount
  useEffect(() => {
    if (sessionModalSize && modalRef.current) {
      modalRef.current.style.width = `${sessionModalSize.width}px`;
      modalRef.current.style.height = `${sessionModalSize.height}px`;
    }
  }, []);

  // Listen for resize events and persist the size
  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    const observer = new ResizeObserver(() => {
      sessionModalSize = {
        width: modal.offsetWidth,
        height: modal.offsetHeight,
      };
    });

    observer.observe(modal);
    return () => observer.disconnect();
  }, []);

  // Portal to <body>: the inspector panel's backdrop-filter makes it the
  // containing block for position:fixed descendants, which would trap this
  // "fullscreen" overlay inside the narrow panel column.
  return createPortal(
    <div
      ref={overlayRef}
      className="vellum-modal-overlay"
      onMouseDown={(event) => {
        if (event.target === overlayRef.current) onClose();
      }}
    >
      <div ref={modalRef} className="vellum-modal nowheel" role="dialog" aria-modal="true">
        <button type="button" className="vellum-modal__close" aria-label="Close" onClick={onClose}>
          <X size={13} />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
