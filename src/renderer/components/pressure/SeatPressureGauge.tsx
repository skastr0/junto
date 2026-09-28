import { use$ } from "@legendapp/state/react";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import {
  formatTokens,
  pressureGaugeLabel,
  pressureKey,
  type SeatPressureSnapshot,
} from "@shared/token-pressure";
import { tokenPressure$ } from "../../lib/token-pressure-state";
import "./seat-pressure.css";

// A seat's live context, as a hairline gauge with "142k of 200k" beside it.
// Quiet until it matters: the fill turns amber once the seat is past its
// limit, and the line says what Junto did about it. Nothing renders while
// the seat is not running or has no session yet.

const harnessName = (harness: string | undefined): string =>
  harness !== undefined && isHarnessId(harness) ? templateFor(harness).displayName : "This harness";

/** What the gauge line says after the numbers, when something happened. */
export const pressureStateNote = (snapshot: SeatPressureSnapshot): string | undefined => {
  if (snapshot.rotation === "unavailable" || snapshot.rotation === "failed") return "offboard overdue";
  if (snapshot.phase === "rotating") return "rotating";
  if (snapshot.phase === "nudged") return "asked to offboard";
  if (snapshot.phase === "over") return "past limit";
  return undefined;
};

/** The hover line: the numbers in full, and where the limit came from. */
export const pressureTitle = (snapshot: SeatPressureSnapshot): string => {
  if (snapshot.status === "unsupported") {
    return `${harnessName(snapshot.harness)} does not write its context use where Junto can read it, so no limit applies to this seat.`;
  }
  const used = formatTokens(snapshot.usedTokens ?? 0);
  const window = snapshot.window !== undefined
    ? ` of a ${formatTokens(snapshot.window)} window${snapshot.windowSource === "table" ? " (Junto's figure for this model)" : ""}`
    : "";
  const lines = [`${used} tokens in context${window}.`];
  if (snapshot.limitBlocked === "no-window") {
    lines.push(`${harnessName(snapshot.harness)} does not record its context window, so a percent limit cannot apply. Set a token limit for this seat instead.`);
  } else if (snapshot.limitTokens !== undefined) {
    lines.push(`Junto asks it to offboard at ${formatTokens(snapshot.limitTokens)}${snapshot.thresholdFrom === "seat" ? ", this seat's own limit" : ""}.`);
  } else {
    lines.push("No limit is set for this seat.");
  }
  if (snapshot.rotation === "unavailable") lines.push("Rotating it is not available on this build yet.");
  if (snapshot.rotation === "failed") lines.push("Junto could not rotate it.");
  return lines.join(" ");
};

export function SeatPressureGauge({
  canvasName,
  nodeId,
  className,
}: {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly className?: string;
}) {
  const snapshot = use$(() => tokenPressure$.bySeat.get()[pressureKey(canvasName, nodeId)]);
  if (snapshot === undefined || snapshot.status === "no-session") return null;
  if (snapshot.status === "unsupported") {
    return (
      <div className={`seat-pressure seat-pressure--quiet ${className ?? ""}`} title={pressureTitle(snapshot)} data-testid="seat-pressure">
        <span className="seat-pressure__label">context not readable</span>
      </div>
    );
  }
  const label = pressureGaugeLabel(snapshot) ?? "";
  const of = snapshot.limitTokens ?? snapshot.window;
  const fraction = of !== undefined && of > 0 ? Math.min(1, (snapshot.usedTokens ?? 0) / of) : 0;
  const over = snapshot.phase !== "below";
  const note = pressureStateNote(snapshot);
  return (
    <div
      className={`seat-pressure ${className ?? ""}`}
      data-over={over ? "true" : undefined}
      title={pressureTitle(snapshot)}
      data-testid="seat-pressure"
    >
      {of !== undefined ? (
        <span
          className="seat-pressure__track"
          role="meter"
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={of}
          aria-valuenow={snapshot.usedTokens ?? 0}
          aria-valuetext={label}
        >
          <span className="seat-pressure__fill" style={{ transform: `scaleX(${fraction})` }} />
        </span>
      ) : null}
      <span className="seat-pressure__label">{label}</span>
      {note ? <span className="seat-pressure__note">{note}</span> : null}
    </div>
  );
}
