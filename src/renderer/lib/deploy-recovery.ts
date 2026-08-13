import type { HostsDeployRemoteResult } from "@shared/ipc";
import { operatorDeployDetail as mapOperatorDeployDetail } from "@shared/operator-remote-copy";

/** Map machine tags to something an operator can do. */
export const operatorDeployDetail = mapOperatorDeployDetail;

export const deployRecoveryGuidance = (
  recoveryAction: HostsDeployRemoteResult["recoveryAction"],
): string | undefined => {
  if (recoveryAction === undefined) return undefined;

  const sessionLabel =
    recoveryAction.activeTerminalSessions === 1 ? "session" : "sessions";
  return `Close ${recoveryAction.activeTerminalSessions} active Vellum Command terminal ${sessionLabel}, then retry deployment.`;
};
