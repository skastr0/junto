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
  ] as const)("renders fixed guidance for %s", (recoveryAction, guidance) => {
    expect(deployRecoveryGuidance(recoveryAction)).toBe(guidance);
  });
});
