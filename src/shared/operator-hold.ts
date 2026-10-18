/**
 * The operator's hold on a seat: while a window shows the seat's terminal, or
 * the operator has just typed into it, its session is not cut at the cache
 * window. Main keeps the holds (src/main/junto/term/operator-holds.ts); each
 * window reports what it shows and what it is typed into.
 *
 * Imported by the preload's reach: keep this module free of Effect.
 */

/** A seat stays held this long after the operator's last key into its terminal. */
export const OPERATOR_TYPING_GRACE_MS = 30_000;

/**
 * A window reports typing into a seat at most this often. Well under the
 * grace, so a hold never lapses while the operator is still typing.
 */
export const OPERATOR_TYPED_REPORT_MS = 5_000;
