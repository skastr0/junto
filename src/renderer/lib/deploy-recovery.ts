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
      return [
        "Command Center could not take a terminal-route maintenance cut for this host.",
        "Common causes: a previous deploy left a cut held (fully quit and reopen Vellum), the terminal plane is shutting down, or the Remote term plane is unreachable while the package is already installed.",
        "Fully restart Command Center, close any terminals to that host, then retry Deploy.",
      ].join("\n");
    case "bootstrap-linux-release-installer":
      return [
        "This host cannot elevate without a password (sudo -n failed).",
        "Option A: enter the Linux administrator password when prompted.",
        "Option B (manual): copy the signed .deb from ~/.vellum/releases/linux-x64-glibc/current/ to the host and run:",
        "  sudo apt-get install -y './Vellum Command-*-x64-linux.deb'",
        "then retry Deploy.",
        "Box fleet users should already have passwordless sudo — if this appears on a Box, SSH access or image policy is wrong.",
      ].join("\n");
    case "repair-linux-release-transaction":
      return [
        "The sealed adopt/start step did not prove readiness.",
        "On the host, inspect:",
        "  systemctl --user status vellum-remote.service",
        "  journalctl --user -u vellum-remote.service -n 80 --no-pager",
        "  ls -la ~/.vellum/work/",
        "Then retry Deploy, or escalate with the step log from Fleet.",
      ].join("\n");
    case "retry-linux-release-install":
      return "Retry deployment later; the current Linux release install did not complete.";
  }
};
