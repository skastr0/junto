import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_HARNESSES,
  MailReadinessLatch,
  mailFirstReady,
  type MailReadinessInput,
} from "../src/main/junto/term/drive/mail-readiness";

const seat = (over: Partial<MailReadinessInput> = {}): MailReadinessInput => ({
  running: true,
  generation: "ep_1",
  harness: "claude",
  seatState: "idle",
  bracketedPaste: true,
  idleConfirmed: true,
  ...over,
});

describe("mail readiness waits for confirmed idle", () => {
  it("holds mail while a bracketed-paste TUI only reads as fallback idle", () => {
    // Real Claude 2.1.284 cold wake: paste mode on and fallback idle ~370ms
    // after spawn, composer not yet drawn. Mail typed then was lost.
    for (const harness of BRACKETED_PASTE_HARNESSES) {
      expect(mailFirstReady(seat({ harness, idleConfirmed: false })), harness).toBe(false);
    }
  });

  it("latches on the first confirmed idle of the generation", () => {
    const latch = new MailReadinessLatch();
    expect(latch.observe("b1", seat({ idleConfirmed: false }))).toBe(false);
    expect(latch.observe("b1", seat())).toBe(true);
    expect(latch.observe("b1", seat({ seatState: "working", idleConfirmed: false }))).toBe(true);
  });
});
