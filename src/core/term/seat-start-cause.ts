/**
 * Why a seat is starting: the operator opened it (here, or from the machine
 * that edits its canvas), mail or work arrived for it, or it restarts. The
 * seat's own start decides what that means for it.
 */
export type SeatStartCause = "operator" | "mail" | "restart";
