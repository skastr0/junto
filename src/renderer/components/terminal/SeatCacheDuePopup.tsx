import { useEffect, useRef, useState } from "react";
import type { SeatCacheDueAnswer } from "@shared/seat-cache-due";
import { answerSeatCacheDue, cacheDueLine, useSeatCacheDue } from "../../lib/seat-cache-due-state";
import { tokensWords } from "../../lib/seat-offboard";
import { Button } from "../ui/Button";

/** How often the "expired 12m ago" line is read again. */
const LINE_REFRESH_MS = 30_000;

/**
 * The auto cache mode's question, inside the seat's open terminal view: its
 * cache window ended while the operator had it open, so Junto asks before it
 * starts the seat fresh. Shown only while main lists this seat. The whole
 * drawing is this component, so a different look swaps it alone.
 *
 * Presses are heard by a native listener, not React's: in a grid cell the
 * view is adopted DOM outside the app root, where React hears nothing, and a
 * seat in a grid cell is asked too.
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
  const rootRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<(choice: SeatCacheDueAnswer) => Promise<void>>(async () => undefined);

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

  answerRef.current = async (choice) => {
    if (pending !== undefined) return;
    setPending(choice);
    setFailure(undefined);
    const result = await answerSeatCacheDue(canvasName, seatId, choice);
    setPending(undefined);
    if (!result.ok) setFailure(result.message);
  };

  const shown = due !== undefined;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onClick = (event: MouseEvent): void => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-answer]") : null;
      if (!button || button.disabled) return;
      const choice = button.dataset.answer;
      if (choice === "fresh" || choice === "keep") void answerRef.current(choice);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [shown]);

  if (due === undefined) return null;

  return (
    <div ref={rootRef} className="seat-cache-due" role="region" aria-label="Cache expired" data-testid="seat-cache-due">
      <div className="seat-cache-due__text">
        <span>
          {cacheDueLine(due.windowEndsAt, now)}
          {due.tokens === undefined ? "" : ` Continuing re-reads about ${tokensWords(due.tokens)} tokens.`} Start fresh, or keep
          this session?
        </span>
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
        data-answer="fresh"
        data-testid="seat-cache-due-fresh"
      >
        {pending === "fresh" ? "Starting fresh…" : "Start fresh"}
      </Button>
      <Button
        size="sm"
        variant="chrome"
        disabled={pending !== undefined}
        data-answer="keep"
        data-testid="seat-cache-due-keep"
      >
        Keep this session
      </Button>
    </div>
  );
}
