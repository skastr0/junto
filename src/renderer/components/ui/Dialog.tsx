import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { claimFocus, claimFocusOnMount, focusPrimaryControl } from "../../lib/focus-ownership";
import { isModalLayerOpen, useModalLayer, type ModalLayer } from "../../lib/modal-stack";
import { Button } from "./Button";
import { Eyebrow } from "./Eyebrow";
import "./dialog.css";

/**
 * Dialog: the one working dialog. A small centred card for a short decision
 * or a short form, opened from the base or from a working modal and always
 * above both (--layer-working-dialog). Opened while an operator modal is up
 * (a confirm from the feed, a viewer over it), it lands above that modal
 * instead (--layer-operator-dialog). It owns the backdrop, the focus trap,
 * focus restore, and Escape that closes only the topmost layer.
 *
 * For a yes or no question use ConfirmDialog. For deep single-subject work
 * use FocusSurface.
 */
export function Dialog({
  title,
  eyebrow,
  onClose,
  closeOnBackdrop = true,
  alert = false,
  width = 420,
  className,
  testId,
  onKeyDown,
  children,
  actions,
}: {
  readonly title: ReactNode;
  /** Small context label above the title. */
  readonly eyebrow?: ReactNode;
  /** Escape, the backdrop, and Cancel all mean this. */
  readonly onClose: () => void;
  readonly closeOnBackdrop?: boolean;
  /** An interruption that needs an answer (role alertdialog). */
  readonly alert?: boolean;
  readonly width?: number;
  readonly className?: string;
  readonly testId?: string;
  /**
   * The body's keys (arrows in a viewer), heard wherever focus sits inside
   * the dialog, before Escape and the Tab trap.
   */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  readonly children?: ReactNode;
  /** The footer row, right aligned: cancel first, the one action last. */
  readonly actions?: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // A dialog belongs to the layer it was opened from, decided once at open.
  const [layerName] = useState<ModalLayer>(() =>
    isModalLayerOpen("operator") ? "operator-dialog" : "working-dialog",
  );
  const layer = useModalLayer({ layer: layerName, containerRef: cardRef, onEscape: onClose, onClose, onKeyDown });

  useEffect(() => {
    const card = cardRef.current;
    // A control inside may already have claimed focus on mount. Otherwise
    // the first control takes it, or the card itself: a dialog always holds
    // the keyboard.
    if (!card || card.contains(document.activeElement)) return;
    if (!focusPrimaryControl(card)) claimFocus(card, "open", { preventScroll: true });
  }, []);

  return createPortal(
    <div className="junto-dialog" data-layer={layerName} data-popover-layer onKeyDown={layer.onKeyDown}>
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
      <div
        ref={cardRef}
        className={["layer-frame", "junto-dialog__card", className].filter(Boolean).join(" ")}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-testid={testId}
        style={{ width }}
      >
        {eyebrow ? <Eyebrow tone="amber">{eyebrow}</Eyebrow> : null}
        <h2 id={titleId} className="junto-dialog__title">
          {title}
        </h2>
        {children ? <div className="junto-dialog__body">{children}</div> : null}
        {actions ? <div className="junto-dialog__actions">{actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/**
 * ConfirmDialog: one question, two answers. Focus starts on Cancel, so Enter
 * never confirms by accident. `tone="danger"` is for actions that destroy or
 * stop something.
 */
export function ConfirmDialog({
  title,
  eyebrow,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
  testId,
  children,
}: {
  readonly title: ReactNode;
  readonly eyebrow?: ReactNode;
  /** The verb of the action: "Delete canvas", "Stop and re-seat". */
  readonly confirmLabel: ReactNode;
  readonly cancelLabel?: ReactNode;
  readonly tone?: "danger" | "primary";
  /** The action is running: both answers wait. */
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly testId?: string;
  /** What happens if the operator confirms, in plain words. */
  readonly children?: ReactNode;
}) {
  return (
    <Dialog
      alert
      title={title}
      eyebrow={eyebrow}
      testId={testId}
      onClose={() => {
        if (!busy) onCancel();
      }}
      actions={
        <>
          <Button ref={claimFocusOnMount} size="md" variant="chrome" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button size="md" variant={tone} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
