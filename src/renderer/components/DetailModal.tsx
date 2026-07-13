import { useEffect, useRef } from "react";
import { X } from "lucide-react";

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={overlayRef}
      className="vellum-modal-overlay"
      onMouseDown={(event) => {
        if (event.target === overlayRef.current) onClose();
      }}
    >
      <div className="vellum-modal nowheel" role="dialog" aria-modal="true">
        <button type="button" className="vellum-modal__close" aria-label="Close" onClick={onClose}>
          <X size={13} />
        </button>
        {children}
      </div>
    </div>
  );
}
