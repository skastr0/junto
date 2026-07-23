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
      "Restore terminal live-work observation through the deployment runbook or support, then retry deployment.",
    ],
    [
      { kind: "provision-station-browser-trust" },
      "Provision station browser trust through Command Center or the deployment runbook, then retry deployment.",
    ],
    [
      { kind: "bootstrap-linux-release-installer" },
      "Install the current signed Linux package and helper, then retry deployment.",
    ],
    [
      { kind: "repair-linux-release-transaction" },
      "Repair the Linux release transaction through the deployment runbook or support, then retry deployment.",
    ],
    [
      { kind: "retry-linux-release-install" },
      "Retry deployment later; the current Linux release install did not complete.",
    ],
  ] as const)("renders fixed guidance for %s", (recoveryAction, guidance) => {
    expect(deployRecoveryGuidance(recoveryAction)).toBe(guidance);
  });
});
