import { useEffect, useState } from "react";
import type { SeatCacheDueAnswer } from "@shared/seat-cache-due";
import { answerSeatCacheDue, cacheDueLine, useSeatCacheDue } from "../../lib/seat-cache-due-state";
import { Button } from "../ui/Button";

/** How often the "expired 12m ago" line is read again. */
const LINE_REFRESH_MS = 30_000;

/**
 * The auto cache mode's question, inside the seat's open terminal view: its
 * cache window ended while the operator had it open, so Junto asks before it
 * starts the seat fresh. Shown only while main lists this seat. The whole
 * drawing is this component, so a different look swaps it alone.
 */
export function SeatCacheDuePopup({
  canvasName,
  seatId,
}: {
  readonly canvasName: string;
  readonly seatId: string;
}) {
  const due = useSeatCacheDue(canvasName, seatId);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<SeatCacheDueAnswer>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    if (due === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), LINE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [due]);

  // A new ask starts clean: the last one's failure was about that ask.
  useEffect(() => {
    setFailure(undefined);
  }, [due?.windowEndsAt]);

  if (due === undefined) return null;

  const answer = async (choice: SeatCacheDueAnswer): Promise<void> => {
    setPending(choice);
    setFailure(undefined);
    const result = await answerSeatCacheDue(canvasName, seatId, choice);
    setPending(undefined);
    if (!result.ok) setFailure(result.message);
  };

  return (
    <div className="seat-cache-due" role="region" aria-label="Cache expired" data-testid="seat-cache-due">
      <div className="seat-cache-due__text">
        <span>{cacheDueLine(due.windowEndsAt, now)} Start fresh, or keep this session?</span>
        {failure ? (
          <span className="seat-cache-due__failure" role="alert" data-testid="seat-cache-due-failure">
            {failure}
          </span>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="primary"
        disabled={pending !== undefined}
        data-testid="seat-cache-due-fresh"
        onClick={() => void answer("fresh")}
      >
        {pending === "fresh" ? "Starting fresh…" : "Start fresh"}
      </Button>
      <Button
        size="sm"
        variant="chrome"
        disabled={pending !== undefined}
        data-testid="seat-cache-due-keep"
        onClick={() => void answer("keep")}
      >
        Keep this session
      </Button>
    </div>
  );
}
