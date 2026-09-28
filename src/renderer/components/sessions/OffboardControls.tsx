import { use$ } from "@legendapp/state/react";
import { useEffect, useState } from "react";
import type { OffboardMode, SeatOffboardProgress } from "@shared/seat-sessions";
import { getJuntoApi } from "../../lib/junto-api";
import { state$ } from "../../lib/state";
import { Button, StatusDot } from "../ui";

// Offboard from the seat: ask the agent to end its session, to rest or to
// continue in a fresh one. The agent writes the notes; Junto closes the
// session once it goes idle. The steps below follow it through.

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
  const [sending, setSending] = useState<OffboardMode | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

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

  const ask = async (mode: OffboardMode) => {
    setSending(mode);
    setProblem(undefined);
    const result = await getJuntoApi()
      ?.seatOffboardAsk?.(canvasName, seatId, mode)
      .catch(() => undefined);
    setSending(undefined);
    if (result?.ok !== true) setProblem(result?.message ?? "Junto could not send the offboard prompt.");
  };

  const inFlight = progress !== undefined && (progress.stage === "asked" || progress.stage === "saved");
  // Once the notes are saved the close is Junto's and moments away. Before
  // that the operator may ask again, or switch the mode.
  const closing = progress?.stage === "saved";
  const steps = progress === undefined ? [] : stepsOf(progress);
  // The step Junto is waiting on now: the first one not done.
  const waitingOn = steps.findIndex((step) => !step.done);

  return (
    <section className="seat-offboard" aria-label="Offboard" data-testid="seat-offboard">
      <div className="seat-offboard__actions">
        <Button
          size="sm"
          disabled={sending !== undefined || closing}
          onClick={() => void ask("rest")}
          data-testid="seat-offboard-rest"
        >
          Offboard
        </Button>
        <Button
          size="sm"
          disabled={sending !== undefined || closing}
          onClick={() => void ask("continue")}
          data-testid="seat-offboard-continue"
        >
          Offboard and continue
        </Button>
      </div>
      <p className="agent-editor__hint">
        Asks the agent to write its notes and end this session. Offboard lets the seat rest until its next wake;
        offboard and continue starts a fresh session right away that picks up from the agent's note.
      </p>
      {problem ? <p className="seat-sessions__problem">{problem}</p> : null}
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
            <p className="seat-sessions__problem">{progress.message ?? "Junto could not close this session."}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
