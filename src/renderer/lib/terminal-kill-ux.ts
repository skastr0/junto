/**
 * Kill/stop process chrome for native terminal surfaces.
 * Presentation-only — does not change process-bind or kill semantics.
 *
 * Close = view only (process lives; session may stay warm/detached).
 * Stop = capability-plane terminate (SIGTERM → grace → SIGKILL).
 */

export type KillUxPhase = "idle" | "armed" | "stopping" | "stopped";

export type KillActionCopy = {
  readonly label: string;
  readonly title: string;
  readonly ariaLabel: string;
  readonly disabled: boolean;
};

export type DeadStateCopy = {
  readonly headline: string;
  readonly detail: string;
  readonly reopenLabel: string;
  readonly closeViewLabel: string;
};

/** Two-click arm window (ms) — keep in sync with surface / toolbar timers. */
export const KILL_ARM_MS = 3000;

export const isAgentTerminalSeat = (binding: {
  readonly harness?: string;
  readonly agentKey?: string;
} | null | undefined): boolean =>
  Boolean(binding?.harness?.trim() || binding?.agentKey?.trim());

export const killActionCopy = (input: {
  readonly phase: KillUxPhase;
  readonly agentSeat: boolean;
}): KillActionCopy => {
  const { phase, agentSeat } = input;
  if (phase === "stopping") {
    return {
      label: "Stopping…",
      title: "Stopping process…",
      ariaLabel: "Stopping process",
      disabled: true,
    };
  }
  if (phase === "stopped") {
    return {
      label: "Stopped",
      title: "Process already stopped",
      ariaLabel: "Process stopped",
      disabled: true,
    };
  }
  if (phase === "armed") {
    return {
      label: "Confirm",
      title: agentSeat
        ? "Click again to stop this agent"
        : "Click again to stop the process",
      ariaLabel: agentSeat
        ? "Confirm stop agent"
        : "Confirm stop process",
      disabled: false,
    };
  }
  // idle
  return {
    label: "Stop",
    title: agentSeat
      ? "Stop this agent, click again to confirm"
      : "Stop the process, click again to confirm",
    ariaLabel: agentSeat ? "Stop agent" : "Stop process",
    disabled: false,
  };
};

export const deadStateCopy = (input: {
  readonly agentSeat: boolean;
}): DeadStateCopy => ({
  headline: input.agentSeat ? "Agent stopped" : "Process stopped",
  detail: input.agentSeat
    ? "If it still held a task, unclaim it from the task board."
    : "The last output stays frozen below.",
  reopenLabel: "Reopen",
  closeViewLabel: "Close view",
});

/** Surface header eyebrow. */
export const terminalSurfaceEyebrow = (hostId: string): string =>
  `terminal — ${hostId}`;
