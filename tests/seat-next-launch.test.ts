/**
 * What a seat that is not running does at its next start, from the facts
 * main reads: its open session, the harness's own proof, and how its last
 * session ended.
 */
import { describe, expect, it } from "vitest";
import { SEAT_NEXT_LAUNCH_LINE, seatNextLaunch } from "../src/shared/seat-next-launch";

const open = (harness = "claude") => ({ harness, sessionId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" });

describe("seatNextLaunch", () => {
  it("resumes a captured session the harness still holds", () => {
    expect(seatNextLaunch({ harness: "claude", open: open(), provisioned: false, provenOnDisk: true })).toBe("resume");
  });

  it("resumes a provisioned thread by its id alone", () => {
    expect(seatNextLaunch({ harness: "amp", open: open("amp"), provisioned: true, provenOnDisk: false })).toBe("resume");
  });

  it("starts fresh after an offboard, with or without a pin minted for the next session", () => {
    // Pin harness: offboard records a new id with nothing behind it yet.
    expect(seatNextLaunch({ harness: "claude", open: open(), provisioned: false, provenOnDisk: false, lastEnded: "offboard" })).toBe("offboarded");
    // Capture harness: offboard leaves no open session.
    expect(seatNextLaunch({ harness: "codex", provisioned: false, provenOnDisk: false, lastEnded: "offboard" })).toBe("offboarded");
  });

  it("starts fresh with no session, or one from another harness", () => {
    expect(seatNextLaunch({ harness: "claude", provisioned: false, provenOnDisk: false })).toBe("fresh");
    expect(seatNextLaunch({ harness: "claude", open: open("codex"), provisioned: false, provenOnDisk: true, lastEnded: "reseat" })).toBe("fresh");
    expect(seatNextLaunch({ harness: "claude", open: { harness: "claude", sessionId: " " }, provisioned: false, provenOnDisk: true })).toBe("fresh");
  });

  it("says each outcome in words a seat line holds uncut at fit-all", () => {
    expect(SEAT_NEXT_LAUNCH_LINE).toEqual({
      resume: "will resume",
      offboarded: "offboarded, fresh",
      fresh: "starts fresh",
    });
    for (const line of Object.values(SEAT_NEXT_LAUNCH_LINE)) expect(line.length).toBeLessThanOrEqual(18);
  });
});
