import { describe, expect, it } from "vitest";
import type { ConfiguredRemoteDeployResult } from "../src/main/vellum/hosts/deploy-configured-remote";
import { projectDeployRemoteResult } from "../src/main/vellum/hosts/ipc";
import { deployRecoveryGuidance } from "../src/renderer/components/SettingsPanel";

const deployResult = (
  recoveryAction: NonNullable<ConfiguredRemoteDeployResult["recoveryAction"]>,
): ConfiguredRemoteDeployResult => ({
  ok: false,
  detail: "deployment blocked",
  code: "conflict",
  stages: [],
  outcome: "failed",
  packageState: "previous",
  role: "previous",
  rollback: "not-required",
  configuration: { ok: false, detail: "deployment blocked" },
  recoveryAction,
});

describe("Remote deploy recovery projection", () => {
  it("preserves the exact bounded recovery action through the IPC boundary", () => {
    const recoveryAction = {
      kind: "close-active-vellum-terminals" as const,
      activeTerminalSessions: 2,
    };

    expect(projectDeployRemoteResult(deployResult(recoveryAction))).toMatchObject({
      recoveryAction,
    });
  });

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
