import type { HostsDeployRemoteResult } from "@shared/ipc";

export const deployRecoveryGuidance = (
  recoveryAction: HostsDeployRemoteResult["recoveryAction"],
): string | undefined => {
  if (recoveryAction === undefined) return undefined;

  switch (recoveryAction.kind) {
    case "close-active-vellum-terminals": {
      const sessionLabel =
        recoveryAction.activeTerminalSessions === 1 ? "session" : "sessions";
      return `Close ${recoveryAction.activeTerminalSessions} active Vellum Command terminal ${sessionLabel}, then retry deployment.`;
    }
    case "restore-terminal-live-work-observation":
      return [
        "Command Center could not take a terminal-route maintenance cut for this host.",
        "Common causes: a previous deploy left a cut held (fully quit and reopen Vellum Command), the terminal plane is shutting down, or the Remote term plane is unreachable while the package is already installed.",
        "Fully restart Command Center, close any terminals to that host, then retry Deploy.",
      ].join("\n");
  }
};
