import { describe, expect, it } from "vitest";
import { deployRecoveryGuidance } from "../src/renderer/lib/deploy-recovery";

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
});
