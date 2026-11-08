import { use$ } from "@legendapp/state/react";
import { useEffect, useState } from "react";
import type { OffboardMode, SeatOffboardProgress } from "@shared/seat-sessions";
import { getJuntoApi } from "../../lib/junto-api";
import { state$ } from "../../lib/state";
import { StatusDot } from "../ui";

// Where this seat's latest offboard stands. The buttons that start one live
// on the seat itself: the popup above its card and the bottom bar, for one
// seat or a selection. When the agent was asked, it writes the notes and
// Junto closes the session the moment they are saved; the steps below
// follow that through, and say so when it did not finish.

type Step = { readonly label: string; readonly done: boolean };

const FINAL: Record<OffboardMode, string> = {
  rest: "Session closed, seat resting",
  continue: "New session started",
};

const stepsOf = (progress: SeatOffboardProgress): ReadonlyArray<Step> => {
  const saved = progress.stage !== "asked";
  const closed = progress.stage === "resting" || progress.stage === "started";
  return [
    ...(progress.askedAt !== undefined ? [{ label: "Asked", done: true }] : []),
    { label: "Notes saved", done: saved },
    {
      label: progress.stage === "waiting" ? "New session starts when the canvas plays" : FINAL[progress.mode],
      done: closed,
    },
  ];
};

export function OffboardControls({ seatId }: { readonly seatId: string }) {
  const canvasName = use$(state$.canvasName);
  const [progress, setProgress] = useState<SeatOffboardProgress | undefined>();

  useEffect(() => {
    let live = true;
    const mine = (entry: SeatOffboardProgress) => entry.seatId === seatId && entry.canvasName === canvasName;
    void getJuntoApi()
      ?.seatOffboardProgressList?.()
      .then((all) => {
        if (live) setProgress(all.find(mine));
      })
      .catch(() => undefined);
    const off = getJuntoApi()?.onSeatOffboardProgress?.((entry) => {
      if (mine(entry)) setProgress(entry);
    });
    return () => {
      live = false;
      off?.();
    };
  }, [seatId, canvasName]);

  const inFlight = progress !== undefined && (progress.stage === "asked" || progress.stage === "saved");
  const steps = progress === undefined ? [] : stepsOf(progress);
  // The step Junto is waiting on now: the first one not done.
  const waitingOn = steps.findIndex((step) => !step.done);

  return (
    <section className="seat-offboard" aria-label="Offboard" data-testid="seat-offboard">
      <p className="agent-editor__hint" data-testid="seat-offboard-where">
        To end this agent's session, use Offboard on the seat: in the popup above its card, or in the bottom bar
        for one agent or a whole selection.
      </p>
      {progress ? (
        <div className="seat-offboard__progress" data-testid="seat-offboard-progress" data-stage={progress.stage} data-mode={progress.mode}>
          <ol className="seat-offboard__steps" aria-label="Offboard progress">
            {steps.map((step, index) => (
              <li key={step.label} className="seat-offboard__step" data-done={step.done ? "true" : undefined}>
                <StatusDot tone={step.done ? "green" : "dim"} pulse={inFlight && index === waitingOn} />
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
          {progress.stage === "failed" ? (
            // The agent's notes are saved but the session was not closed. Say
            // so plainly: nothing else on this panel would look wrong.
            <p className="seat-sessions__problem" role="alert" data-testid="seat-offboard-failed">
              Offboard did not finish: {progress.message ?? "Junto could not close this session."} The session is
              still open; ask the agent to offboard again.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
