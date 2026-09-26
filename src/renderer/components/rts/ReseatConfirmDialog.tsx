import { useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui";

/**
 * Confirm before re-seating an agent: the old process stops and a new one
 * starts on the seat. Shared by the command card's re-seat and the agent
 * editor's Launch section. Portaled above any popover that asked for it.
 */
export function ReseatConfirmDialog({
  fromLabel,
  toLabel,
  onConfirm,
  onCancel,
}: {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly onConfirm: (dontShowAgain: boolean) => void;
  readonly onCancel: () => void;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  return createPortal(
    <div
      className="agent-reseat-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="reseat-title"
      data-popover-layer
    >
      <button
        type="button"
        className="agent-reseat-confirm__backdrop"
        aria-label="Cancel re-seat"
        onClick={onCancel}
      />
      <div className="agent-reseat-confirm__card">
        <strong id="reseat-title">Re-seat agent process</strong>
        <p>
          Swapping from <em>{fromLabel}</em> to <em>{toLabel}</em> stops the
          current agent process and starts a new one on a fresh seat. Unsaved
          in-process work in the old harness will be lost. The workspace path
          on this seat is kept.
        </p>
        <label className="agent-reseat-confirm__check">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(event) => setDontShowAgain(event.target.checked)}
          />
          Do not show again
        </label>
        <div className="agent-reseat-confirm__actions">
          <Button size="sm" variant="chrome" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => onConfirm(dontShowAgain)}
          >
            Stop and re-seat
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
