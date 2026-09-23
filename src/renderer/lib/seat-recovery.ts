/**
 * Recovery budget for an open agent seat surface.
 *
 * An agent seat is lazy: opening it re-ensures a live generation, and an
 * attach that lands on an exited generation waits for its replacement. A seat
 * that cannot start at all (a missing folder, a missing harness) produces a
 * new dead generation on every attempt. Each attempt is a fresh attach-effect
 * run, and every run re-arms its own spinner and stuck timer, so without a
 * budget that outlives the runs the surface said "starting new session"
 * forever and never reached a stopped state.
 *
 * The budget counts consecutive dead generations across attach-effect runs.
 * A live attach or an operator Reopen resets it.
 */

/** Consecutive dead generations an open surface recovers through before it settles. */
export const SEAT_RECOVERY_LIMIT = 2;

export type SeatRecoveryDecision = "recover" | "settle";

/**
 * Decide what to do after another attach landed on a dead generation.
 * `deadGenerations` counts that attach.
 */
export const seatRecoveryDecision = (deadGenerations: number): SeatRecoveryDecision =>
  deadGenerations > SEAT_RECOVERY_LIMIT ? "settle" : "recover";

/** Plain copy for a classified exit reason when the host sent no message. */
const EXIT_REASON_COPY: Readonly<Record<string, string>> = {
  "cli-missing": "the harness is not installed on this machine",
  spawn_failed: "the seat could not start",
};

/**
 * The reason a settled seat shows. The host's exit message is the real reason
 * and wins over the classified code; a raw code never reaches the operator.
 * A status line adds only what the message does not already say.
 */
export const seatDeadReason = (input: {
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  readonly status?: string | undefined;
}): string => {
  const message = input.message?.trim() ?? "";
  const code = input.reason?.trim() ?? "";
  const headline = message || (code ? (EXIT_REASON_COPY[code] ?? code) : "");
  const status = input.status?.trim() ?? "";
  const extra =
    status &&
    status !== "exited" &&
    (!headline || (!headline.includes(status) && !status.includes(headline)))
      ? status
      : "";
  return [headline, extra]
    .filter((part) => part.length > 0)
    .join(" — ")
    .slice(0, 300);
};
