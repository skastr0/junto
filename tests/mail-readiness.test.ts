import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "../src/shared/managed-terminal-templates";
import {
  BRACKETED_PASTE_HARNESSES,
  MailReadinessLatch,
  mailFirstReady,
  type MailReadinessInput,
} from "../src/main/junto/term/drive/mail-readiness";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildMailWriteSequence,
  CR,
  encodeBracketedPaste,
} from "../src/main/junto/term/drive/typing";

const seat = (over: Partial<MailReadinessInput> = {}): MailReadinessInput => ({
  running: true,
  generation: "ep_1",
  harness: "claude",
  seatState: "idle",
  bracketedPaste: true,
  idleConfirmed: true,
  ...over,
});

describe("mail readiness", () => {
  it("holds mail for a started seat whose TUI has not enabled bracketed paste", () => {
    // The operator's screenshot: the seat already published a state, the
    // TUI had not asked for bracketed paste, and the markers showed as text.
    const latch = new MailReadinessLatch();
    for (const state of ["idle", "working", "attention", "unknown"] as const) {
      expect(latch.observe("b1", seat({ seatState: state, bracketedPaste: false }))).toBe(false);
    }
  });

  it("is ready once the TUI has bracketed paste on and the seat has settled idle", () => {
    const latch = new MailReadinessLatch();
    expect(latch.observe("b1", seat({ seatState: "working" }))).toBe(false);
    expect(latch.observe("b1", seat({ seatState: "attention" }))).toBe(false);
    expect(latch.observe("b1", seat())).toBe(true);
  });

  it("after the first ready moment, types into a working or dialog seat", () => {
    const latch = new MailReadinessLatch();
    latch.observe("b1", seat());
    expect(latch.observe("b1", seat({ seatState: "working" }))).toBe(true);
    expect(latch.observe("b1", seat({ seatState: "attention" }))).toBe(true);
  });

  it("never pastes while a bracketed-paste TUI has the mode off", () => {
    const latch = new MailReadinessLatch();
    latch.observe("b1", seat());
    expect(latch.observe("b1", seat({ seatState: "working", bracketedPaste: false }))).toBe(false);
  });

  it("makes a respawned generation wait for its own TUI", () => {
    const latch = new MailReadinessLatch();
    latch.observe("b1", seat());
    expect(latch.observe("b1", seat({ generation: "ep_2", seatState: "working" }))).toBe(false);
    expect(latch.observe("b1", seat({ running: false }))).toBe(false);
    expect(latch.observe("b1", seat({ seatState: "working" }))).toBe(false);
  });

  it("is ready for every harness template once its TUI is up and idle", () => {
    for (const harness of HARNESS_IDS) {
      expect(mailFirstReady(seat({ harness })), harness).toBe(true);
    }
  });

  it("requires bracketed paste from every harness known to use it", () => {
    for (const harness of BRACKETED_PASTE_HARNESSES) {
      expect(mailFirstReady(seat({ harness, bracketedPaste: false })), harness).toBe(false);
    }
  });

  it("accepts confirmed idle chrome from a harness not known to use bracketed paste", () => {
    expect(mailFirstReady(seat({ harness: "cursor", bracketedPaste: false }))).toBe(true);
    expect(
      mailFirstReady(seat({ harness: "cursor", bracketedPaste: false, idleConfirmed: false })),
    ).toBe(false);
  });

  it("waits while Amp still connects behind a painted composer", () => {
    const lines = ["╭─────╮", "│ │ │", "╰ ~ Connecting"];
    expect(mailFirstReady(seat({ harness: "amp", lines }))).toBe(false);
    expect(mailFirstReady(seat({ harness: "amp", lines: ["╭─────╮", "│ │ │", "╰─────╯"] }))).toBe(true);
  });
});

describe("mail write sequence", () => {
  it("wraps the body in bracketed paste when the TUI has it on", () => {
    expect(buildMailWriteSequence("a\nb", true)).toEqual([encodeBracketedPaste("a\nb"), CR]);
  });

  it("types plain text with no escape bytes when the TUI has it off", () => {
    const [paste, cr] = buildMailWriteSequence("mail from A\n  line\u001b[31m two\r\n", false);
    expect(paste).not.toContain("\u001b");
    expect(paste).not.toContain(BRACKETED_PASTE_START);
    expect(paste).not.toContain(BRACKETED_PASTE_END);
    expect(paste).toBe("mail from A line[31m two ");
    expect(cr).toBe(CR);
  });
});
