import { use$ } from "@legendapp/state/react";
import type { CSSProperties, ReactNode } from "react";
import { machineStage, type MachineFigureState } from "@shared/machine-figure";
import type { ThemeMode } from "@shared/theme";
import { portraitOverrides$, startPortraitOverrides } from "../../lib/portrait-overrides-state";
import { themeMode$ } from "../../lib/theme-mode";
import { MachineFigure, type MachineFigureMachine } from "./MachineFigure";
import "./machines.css";

// The stage: one machine given room. It stands at the large size on its own
// tile and halo, the ground a seat portrait sits on, with the seats placed
// there on its roof as themselves. What is said about it goes beside it.

const STAGE_FIGURE = 290;

export interface MachineStageProps {
  readonly machine: MachineFigureMachine;
  readonly state: MachineFigureState;
  /** Node ids of the seats placed on the machine; they stand on its roof. */
  readonly seatIds?: ReadonlyArray<string>;
  readonly theme?: ThemeMode;
  /** The label, the state lines and the actions. */
  readonly children: ReactNode;
}

export function MachineStage({ machine, state, seatIds = [], theme, children }: MachineStageProps) {
  startPortraitOverrides();
  const overrides = use$(portraitOverrides$);
  const live = use$(themeMode$);
  const mode = theme ?? live;
  const ground = machineStage(machine.name, mode, machine.hue);
  const crew = seatIds.map((seed) => ({ seed, config: overrides[seed] }));
  return (
    <div className="machine-stage" style={{ "--machine-tile": ground.tile, "--machine-halo": ground.halo } as CSSProperties}>
      <div className="machine-stage__figure">
        <MachineFigure machine={machine} state={state} size={STAGE_FIGURE} theme={mode} crew={crew} />
      </div>
      <div className="machine-stage__words">{children}</div>
    </div>
  );
}

/** The steps of a send as one strip: a bar and a label each, filled as they arrive. */
export function MachineSteps<Step extends string>({
  steps,
  done,
  labels,
  running,
  ...rest
}: {
  readonly steps: ReadonlyArray<Step>;
  readonly done: ReadonlyArray<Step>;
  readonly labels: Readonly<Record<Step, string>>;
  /** The send is still under way, so the first step not done is the one being waited on. */
  readonly running: boolean;
  readonly "data-testid"?: string;
}) {
  const next = steps.find((step) => !done.includes(step));
  return (
    <ol className="machine-steps" aria-label="Steps" {...rest}>
      {steps.map((step) => {
        const isDone = done.includes(step);
        const phase = isDone ? "done" : running && step === next ? "now" : "ahead";
        return (
          <li key={step} data-step={step} data-done={isDone} data-phase={phase}>
            <i aria-hidden="true" />
            <span className="sr-only">{isDone ? "Done: " : running ? "Waiting: " : "Not reached: "}</span>
            <span>{labels[step]}</span>
          </li>
        );
      })}
    </ol>
  );
}
