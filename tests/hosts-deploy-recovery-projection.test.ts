import { describe, expect, it } from "vitest";
import { deployRecoveryGuidance } from "../src/renderer/lib/deploy-recovery";

describe("Remote deploy recovery guidance", () => {
  it.each([
    [
      { kind: "close-active-vellum-terminals", activeTerminalSessions: 1 },
      "Close 1 active Vellum terminal session, then retry deployment.",
    ],
    [
      { kind: "restore-terminal-live-work-observation" },
      [
        "Command Center could not take a terminal-route maintenance cut for this host.",
        "Common causes: a previous deploy left a cut held (fully quit and reopen Vellum), the terminal plane is shutting down, or the Remote term plane is unreachable while the package is already installed.",
        "Fully restart Command Center, close any terminals to that host, then retry Deploy.",
      ].join("\n"),
    ],
    [
      { kind: "bootstrap-linux-release-installer" },
      [
        "This host cannot elevate without a password (sudo -n failed).",
        "Option A: enter the Linux administrator password when prompted.",
        "Option B (manual): copy the signed .deb from ~/.vellum/releases/linux-x64-glibc/current/ to the host and run:",
        "  sudo apt-get install -y './Vellum Command-*-x64-linux.deb'",
        "then retry Deploy.",
        "Box fleet users should already have passwordless sudo — if this appears on a Box, SSH access or image policy is wrong.",
      ].join("\n"),
    ],
    [
      { kind: "repair-linux-release-transaction" },
      [
        "The sealed adopt/start step did not prove readiness.",
        "On the host, inspect:",
        "  systemctl --user status vellum-remote.service",
        "  journalctl --user -u vellum-remote.service -n 80 --no-pager",
        "  ls -la ~/.vellum/work/",
        "Then retry Deploy, or escalate with the step log from Fleet.",
      ].join("\n"),
    ],
    [
      { kind: "retry-linux-release-install" },
      "Retry deployment later; the current Linux release install did not complete.",
    ],
  ] as const)("renders fixed guidance for %s", (recoveryAction, guidance) => {
    expect(deployRecoveryGuidance(recoveryAction)).toBe(guidance);
  });
});
