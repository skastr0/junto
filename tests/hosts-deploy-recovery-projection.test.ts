import { describe, expect, it } from "vitest";
import {
  deployRecoveryGuidance,
  operatorDeployDetail,
} from "../src/renderer/lib/deploy-recovery";

describe("Remote deploy recovery guidance", () => {
  it("renders exact guidance for active terminal sessions", () => {
    expect(
      deployRecoveryGuidance({
        kind: "close-active-vellum-terminals",
        activeTerminalSessions: 1,
      }),
    ).toBe(
      "Close 1 active Vellum Command terminal session, then retry deployment.",
    );
  });

  it("tells the operator to quit a window opened outside LaunchAgent", () => {
    expect(
      operatorDeployDetail(
        "remote-a: UNSUPERVISED_INCUMBENT_REQUIRES_LAUNCHAGENT exe_pids=333,",
      ),
    ).toBe(
      "Quit Vellum Command on that Mac, then Deploy again. A window opened outside LaunchAgent cannot be replaced until it is closed.",
    );
    expect(operatorDeployDetail("supervised Remote runtime ready")).toBe(
      "supervised Remote runtime ready",
    );
    expect(operatorDeployDetail("SSH process I/O failed")).toContain(
      "dropped while copying",
    );
    expect(
      operatorDeployDetail("Station API ready - installation station-1"),
    ).toContain("Vellum Command ready");
  });
});
