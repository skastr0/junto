import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "../src/shared/managed-terminal-templates";
import {
  BRACKETED_PASTE_HARNESSES,
  MailReadinessLatch,
  mailFirstReady,
  type MailReadinessInput,
} from "../src/core/term/drive/mail-readiness";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  buildMailWriteSequence,
  CR,
  encodeBracketedPaste,
} from "../src/core/term/drive/typing";

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
    // pi proves its TUI from the screen it paints (title + editor footer), so
    // its ready moment is a real settled screen, not a bare input row.
    const BOX = "─".repeat(110);
    const piSettled = {
      harness: "pi",
      title: "π - junto - junto",
      lines: [
        "",
        BOX,
        "",
        BOX,
        "~/Projects/junto (main)",
        "↑34k ↓7.5k R444k CH99.5% $0.011 3.4%/1.0M (auto)   (opencode-go) deepseek-v4.1-flash • high",
      ],
    };
    for (const harness of HARNESS_IDS) {
      const input = harness === "pi" ? seat(piSettled) : seat({ harness });
      expect(mailFirstReady(input), harness).toBe(true);
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

  // pi 1.5.0, live on this machine 2026-11-08. It paints its whole editor box
  // and footer before it takes input: a submit at 0.2 s was dropped, and one at
  // 0.45 s put the text back with `Startup is still in progress`. A handoff
  // line typed then sat unsent for 204 s. These lines are the live screens.
  describe("pi 1.5.0 starts before it listens", () => {
    const BOX = "─".repeat(110);
    const settled = [
      " useful history above the editor",
      "",
      BOX,
      "",
      BOX,
      "~/Projects/junto (main)",
      "↑34k ↓7.5k R444k CH99.5% $0.011 3.4%/1.0M (auto)   (opencode-go) deepseek-v4.1-flash • high",
    ];
    const title = "π - junto - junto";

    it("is ready on a settled seat with the TUI's title and editor footer", () => {
      expect(mailFirstReady(seat({ harness: "pi", lines: settled, title }))).toBe(true);
    });

    it("waits while the title is not up yet, even though the box is painted", () => {
      expect(mailFirstReady(seat({ harness: "pi", lines: settled, title: "" }))).toBe(false);
      expect(mailFirstReady(seat({ harness: "pi", lines: settled }))).toBe(false);
    });

    it("waits while pi says startup is still in progress", () => {
      const starting = [
        " [Context] ~/.pi/agent/AGENTS.md, AGENTS.md",
        " [Skills] composio-cli, impeccable",
        " Startup is still in progress",
        ...settled.slice(-4),
      ];
      expect(mailFirstReady(seat({ harness: "pi", lines: starting, title }))).toBe(false);
    });

    it("waits while pi is working, whatever the box reads", () => {
      expect(
        mailFirstReady(seat({ harness: "pi", seatState: "working", lines: settled, title })),
      ).toBe(false);
    });
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
