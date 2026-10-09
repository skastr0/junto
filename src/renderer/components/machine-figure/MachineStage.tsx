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

/**
 * The steps of a send as one strip: a bar, then the phase in words and the
 * step. The words stay in the text, so the strip reads without its bars.
 */
export function MachineSteps<Phase extends string>({
  lines,
  words,
  ...rest
}: {
  readonly lines: ReadonlyArray<{ readonly step: string; readonly label: string; readonly phase: Phase }>;
  /** What each phase is called. */
  readonly words: Readonly<Record<Phase, string>>;
  readonly "data-testid"?: string;
}) {
  return (
    <ol className="machine-steps" aria-label="Steps" {...rest}>
      {lines.map(({ step, label, phase }) => (
        <li key={step} data-step={step} data-done={phase === "done"} data-step-phase={phase}>
          <i aria-hidden="true" />
          <small>{words[phase]}: </small>
          {label}
        </li>
      ))}
    </ol>
  );
}
