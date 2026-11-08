/**
 * Why an open agent seat stopped, in words the operator can act on.
 *
 * A seat whose generation dies settles into the stopped state on the first
 * failure and shows this reason; the only generation the surface follows
 * without a click is the host's own fail-open replacement of a dead resume.
 */

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
