import { X } from "lucide-react";
import { FocusSurface } from "./FocusSurface";

/**
 * Browse-row detail shell (glyph / signal / session / dispatch / booth).
 * Thin adapter over FocusSurface with the document measure + resizable height
 * and a shared close control. Callers keep at most one instance mounted via a
 * single "active detail" state slot.
 */
export function DetailModal({
  onClose,
  children,
}: {
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <FocusSurface
      measure="document"
      height="resizable"
      layer="detail"
      label="Detail"
      onClose={onClose}
      closeOnEscape
      closeOnBackdrop
      panelClassName="vellum-modal nowheel"
    >
      <button type="button" className="vellum-modal__close" aria-label="Close" onClick={onClose}>
        <X size={13} />
      </button>
      {children}
    </FocusSurface>
  );
}
