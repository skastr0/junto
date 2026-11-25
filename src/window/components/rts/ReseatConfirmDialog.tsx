import { useState } from "react";
import { ConfirmDialog } from "../ui";

/**
 * Confirm before re-seating: each old process stops and a new one starts in
 * its seat. Shared by the kind strip's re-seat, the agent editor's Launch
 * section, and the command card's re-seat of several seats, which confirms
 * once for all of them.
 */
export function ReseatConfirmDialog({
  fromLabel,
  toLabel,
  count = 1,
  onConfirm,
  onCancel,
}: {
  /** What the one seat runs now. A re-seat of several names no single one. */
  readonly fromLabel?: string;
  readonly toLabel: string;
  /** How many seats move. */
  readonly count?: number;
  readonly onConfirm: (dontShowAgain: boolean) => void;
  readonly onCancel: () => void;
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const many = count > 1;
  return (
    <ConfirmDialog
      title={many ? `Re-seat ${count} agents` : "Re-seat agent process"}
      confirmLabel={many ? `Stop and re-seat ${count} agents` : "Stop and re-seat"}
      onConfirm={() => onConfirm(dontShowAgain)}
      onCancel={onCancel}
    >
      {many ? (
        <span>
          Moving {count} agents to <strong className="text-ink">{toLabel}</strong> stops
          each one&apos;s agent process and starts a new one in the same seat. Unsaved
          in-process work in their old harnesses will be lost. Each seat keeps its
          name, its wires and its folder.
        </span>
      ) : (
        <span>
          Swapping from <strong className="text-ink">{fromLabel ?? "current seat"}</strong> to{" "}
          <strong className="text-ink">{toLabel}</strong> stops the
          current agent process and starts a new one in this seat. Unsaved
          in-process work in the old harness will be lost. The workspace path
          on this seat is kept.
        </span>
      )}
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
