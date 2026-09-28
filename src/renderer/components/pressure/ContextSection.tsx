import { use$ } from "@legendapp/state/react";
import { isHarnessId, templateFor } from "@shared/managed-terminal-templates";
import {
  describeThreshold,
  HARNESS_CONTEXT_SUPPORT,
  harnessReadsContext,
  isSeatTokenPressure,
  pressureKey,
  tokenPressureSettings,
  type SeatTokenPressure,
} from "@shared/token-pressure";
import { setSeatTokenPressure, tokenPressure$ } from "../../lib/token-pressure-state";
import { state$ } from "../../lib/state";
import { Select } from "../ui";
import type { AgentEditorSectionProps } from "../agent-editor/sections";
import { SeatPressureGauge } from "./SeatPressureGauge";
import { ThresholdFields, thresholdStart } from "./ThresholdFields";

// Context: how full this seat's live context is, and the limit at which
// Junto asks it to offboard. The seat follows the Settings default until it
// is given a limit of its own, or turned off. A harness Junto cannot read
// says so, and offers nothing that would not apply.

type Choice = "default" | "percent" | "tokens" | "off";

const choiceOf = (value: SeatTokenPressure | undefined): Choice => value?.kind ?? "default";

export function ContextSection({ seat }: AgentEditorSectionProps) {
  const defaults = use$(() => tokenPressureSettings(state$.settings.get()));
  const canvasName = use$(state$.canvasName);
  const live = use$(() => {
    const snapshot = tokenPressure$.bySeat.get()[pressureKey(canvasName, seat.id)];
    return snapshot !== undefined && snapshot.status === "reading";
  });
  const stored = seat.node.ether?.terminal?.tokenPressure;
  const own = stored !== undefined && isSeatTokenPressure(stored) ? stored : undefined;
  const harness = seat.harness;
  const name = harness !== undefined && isHarnessId(harness) ? templateFor(harness).displayName : "This harness";

  if (!harnessReadsContext(harness)) {
    return (
      <div className="flex flex-col gap-3" data-testid="seat-context-section">
        <p className="agent-editor__hint">
          {name} does not write its context use where Junto can read it, so Junto cannot tell when this seat is
          full and no limit applies to it.
        </p>
      </div>
    );
  }

  const knowsWindow = harness !== undefined && isHarnessId(harness) && HARNESS_CONTEXT_SUPPORT[harness]?.window !== undefined;
  const defaultLabel = defaults.enabled ? `default, ${describeThreshold(defaults.threshold)}` : "default, off";
  const options = [
    { value: "default", label: defaultLabel },
    { value: "percent", label: "a percent of the context window", disabled: !knowsWindow },
    { value: "tokens", label: "a number of tokens" },
    { value: "off", label: "off for this seat" },
  ];
  const choice = choiceOf(own);

  return (
    <div className="flex flex-col gap-4" data-testid="seat-context-section">
      <div className="agent-editor__field">
        <span className="agent-editor__field-label">now</span>
        {live ? (
          <SeatPressureGauge canvasName={canvasName} nodeId={seat.id} className="seat-pressure--large" />
        ) : (
          <p className="agent-editor__hint">Shows while this seat is running a session.</p>
        )}
      </div>
      <div className="agent-editor__field">
        <span className="agent-editor__field-label">ask it to offboard at</span>
        <Select
          value={choice}
          options={options}
          aria-label="Offboard limit for this seat"
          onChange={(next) => {
            if (next === choice) return;
            if (next === "default") setSeatTokenPressure(seat.id, undefined);
            else if (next === "off") setSeatTokenPressure(seat.id, { kind: "off" });
            else setSeatTokenPressure(seat.id, thresholdStart(next === "percent" ? "percent" : "tokens"));
          }}
        />
        {own !== undefined && own.kind !== "off" ? (
          <ThresholdFields
            label="This seat's limit"
            kindPicker={false}
            threshold={own}
            onChange={(threshold) => setSeatTokenPressure(seat.id, threshold)}
          />
        ) : null}
      </div>
      <p className="agent-editor__hint">
        Past the limit, Junto tells the agent once, between turns, to write down where it is and offboard. If it has
        not after {defaults.graceMinutes} minutes, Junto rotates it into a fresh session.
        {knowsWindow ? "" : ` ${name} does not record its context window, so only a token limit applies.`}
      </p>
    </div>
  );
}
