import type { HostsDeployRemoteResult } from "@shared/ipc";

/** Map machine tags to something an operator can do. */
export const operatorDeployDetail = (detail: string): string => {
  if (detail.includes("UNSUPERVISED_INCUMBENT_REQUIRES_LAUNCHAGENT")) {
    return "Quit Vellum Command on this Mac, then Deploy again. A window opened outside LaunchAgent cannot be replaced until it is closed.";
  }
  return detail;
};

export const deployRecoveryGuidance = (
  recoveryAction: HostsDeployRemoteResult["recoveryAction"],
): string | undefined => {
  if (recoveryAction === undefined) return undefined;

  const sessionLabel =
    recoveryAction.activeTerminalSessions === 1 ? "session" : "sessions";
  return `Close ${recoveryAction.activeTerminalSessions} active Vellum Command terminal ${sessionLabel}, then retry deployment.`;
};
