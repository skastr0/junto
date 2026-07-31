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
      "Host preparation is required before Vellum can install or update this Remote. Review Linux host preparation, then retry Deploy.",
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
