/**
 * Compact 16×16 session-load spinner + label for actor seat open.
 * Tone colors map load phases (finding / starting / resuming / attaching / stuck).
 *
 * `pill` — centered stage chrome (bordered chip)
 * `inline` — header status row (no chip chrome)
 */

import {
  sessionLoadPresentation,
  type SessionLoadPhase,
} from "../../lib/session-load";

export function SessionLoadSpinner({
  phase,
  sessionId,
  className,
  variant = "pill",
}: {
  readonly phase: SessionLoadPhase;
  readonly sessionId?: string | null;
  readonly className?: string;
  readonly variant?: "pill" | "inline";
}) {
  const presentation = sessionLoadPresentation({ phase, sessionId });
  return (
    <div
      className={[
        "session-load",
        variant === "inline" ? "session-load--inline" : "session-load--pill",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-live="polite"
      aria-label={presentation.label}
      data-phase={presentation.phase}
      data-tone={presentation.tone}
      style={{ ["--session-load-tone" as string]: presentation.hex }}
    >
      <span className="session-load__spinner" aria-hidden />
      <span className="session-load__label">{presentation.label}</span>
    </div>
  );
}
