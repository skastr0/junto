import type { HostsDeployRemoteResult } from "@shared/ipc";

export const deployRecoveryGuidance = (
  recoveryAction: HostsDeployRemoteResult["recoveryAction"],
): string | undefined => {
  if (recoveryAction === undefined) return undefined;

  switch (recoveryAction.kind) {
    case "close-active-vellum-terminals": {
      const sessionLabel =
        recoveryAction.activeTerminalSessions === 1 ? "session" : "sessions";
      return `Close ${recoveryAction.activeTerminalSessions} active Vellum terminal ${sessionLabel}, then retry deployment.`;
    }
    case "restore-terminal-live-work-observation":
      return "Restore terminal live-work observation through the deployment runbook or support, then retry deployment.";
    case "bootstrap-linux-release-installer":
      return "The Remote is not a clean first-install host and lacks package-owned release installer custody. Repair the host (or wipe leftover installer state on a true blank machine), then retry Deploy.";
    case "repair-linux-release-transaction":
      return "Repair the Linux release transaction through the deployment runbook or support, then retry deployment.";
    case "retry-linux-release-install":
      return "Retry deployment later; the current Linux release install did not complete.";
  }
};
