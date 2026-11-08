import { useState } from "react";
import { ConfirmDialog } from "../ui";

/**
 * Confirm before re-seating an agent: the old process stops and a new one
 * starts on the seat. Shared by the command card's re-seat and the agent
 * editor's Launch section.
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
  return (
    <ConfirmDialog
      title="Re-seat agent process"
      confirmLabel="Stop and re-seat"
      onConfirm={() => onConfirm(dontShowAgain)}
      onCancel={onCancel}
    >
      <span>
        Swapping from <strong className="text-ink">{fromLabel}</strong> to{" "}
        <strong className="text-ink">{toLabel}</strong> stops the
        current agent process and starts a new one on a fresh seat. Unsaved
        in-process work in the old harness will be lost. The workspace path
        on this seat is kept.
      </span>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={dontShowAgain}
          onChange={(event) => setDontShowAgain(event.target.checked)}
        />
        Do not show again
      </label>
    </ConfirmDialog>
  );
}
