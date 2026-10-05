import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { claimFocus, claimFocusOnMount, focusPrimaryControl } from "../../lib/focus-ownership";
import { useModalLayer } from "../../lib/modal-stack";
import { Button } from "./Button";
import { Eyebrow } from "./Eyebrow";
import "./dialog.css";

/**
 * Dialog: the one working dialog. A small centred card for a short decision
 * or a short form, opened from the base or from a working modal and always
 * above both (--layer-working-dialog). It owns the backdrop, the focus trap,
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
  readonly children?: ReactNode;
  /** The footer row, right aligned: cancel first, the one action last. */
  readonly actions?: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const layer = useModalLayer({ layer: "working-dialog", containerRef: cardRef, onEscape: onClose });

  useEffect(() => {
    const card = cardRef.current;
    // A control inside may already have claimed focus on mount. Otherwise
    // the first control takes it, or the card itself: a dialog always holds
    // the keyboard.
    if (!card || card.contains(document.activeElement)) return;
    if (!focusPrimaryControl(card)) claimFocus(card, "open", { preventScroll: true });
  }, []);

  return createPortal(
    <div className="junto-dialog" data-layer="working-dialog" data-popover-layer onKeyDown={layer.onKeyDown}>
      <button
        type="button"
        data-layer-backdrop
        aria-label="Cancel"
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
