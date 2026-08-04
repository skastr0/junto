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
        ? "Click again to end agent process and work identity (3s)"
        : "Click again to stop process (3s)",
      ariaLabel: agentSeat
        ? "Confirm end agent process"
        : "Confirm stop process",
      disabled: false,
    };
  }
  // idle
  return {
    label: "Stop",
    title: agentSeat
      ? "Ends this agent process and its work identity. Click again to confirm (3s)."
      : "Stop process — click again to confirm (3s)",
    ariaLabel: agentSeat ? "Stop agent process" : "Stop process",
    disabled: false,
  };
};

export const deadStateCopy = (input: {
  readonly agentSeat: boolean;
}): DeadStateCopy => ({
  headline: "Process stopped",
  detail: input.agentSeat
    ? "Work identity revoked - unclaim task if still held."
    : "Last output is frozen below — process is not running.",
  reopenLabel: "Reopen",
  closeViewLabel: "Close view",
});

/** Surface header eyebrow — Close (view) vs Stop (process). */
export const terminalSurfaceEyebrow = (hostId: string): string =>
  `terminal - ${hostId} - Close keeps process - Stop ends it`;
