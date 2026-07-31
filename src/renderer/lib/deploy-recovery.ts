import type { HostsDeployRemoteResult } from "@shared/ipc";

export const deployRecoveryGuidance = (
  recoveryAction: HostsDeployRemoteResult["recoveryAction"],
): string | undefined => {
  if (recoveryAction === undefined) return undefined;

  const sessionLabel =
    recoveryAction.activeTerminalSessions === 1 ? "session" : "sessions";
  return `Close ${recoveryAction.activeTerminalSessions} active Vellum Command terminal ${sessionLabel}, then retry deployment.`;
};
