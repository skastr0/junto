import { describe, expect, it } from "vitest";
import {
  SessionObserver,
  TerminalObserverPlane,
  afterLastHorizontalRule,
  bottomNonEmptyLines,
  footerLine,
  isHorizontalRule,
  promptBoxBody,
  sanitizeTitle,
} from "../src/main/vellum/term/observer";

const feedAndWait = async (
  obs: SessionObserver,
  data: string,
  seq = 1n,
): Promise<void> => {
  obs.feed(data, seq);
  await obs.snapshot();
};

describe("sanitizeTitle", () => {
  it("strips control chars and caps length", () => {
    expect(sanitizeTitle("hello\x1b[0mworld")).toBe("helloworld");
    expect(sanitizeTitle("a".repeat(300)).length).toBe(256);
  });
});

describe("regions", () => {
  it("detects horizontal rules", () => {
    expect(isHorizontalRule("────────────────")).toBe(true);
    expect(isHorizontalRule("─── footer")).toBe(true);
    expect(isHorizontalRule("not a rule")).toBe(false);
  });

  it("bottomNonEmptyLines and footer", () => {
    const lines = ["", "a", "", "b", "c", ""];
    expect(bottomNonEmptyLines(lines, 2)).toEqual(["b", "c", ""]);
    expect(footerLine(lines)).toBe("c");
  });

  it("prompt box body between two rules", () => {
    const lines = [
      "history",
      "────────────────",
      "❯ do the thing",
      "────────────────",
      "footer",
    ];
    expect(promptBoxBody(lines)).toEqual(["❯ do the thing"]);
    expect(afterLastHorizontalRule(lines)).toEqual(["footer"]);
  });
});

describe("SessionObserver", () => {
  it("parses OSC 0/2 title", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 80,
      rows: 24,
    });
    try {
      await feedAndWait(obs, "\x1b]0;Claude · working\x07");
      const snap = await obs.snapshot();
      expect(snap.signals.title).toBe("Claude · working");

      await feedAndWait(obs, "\x1b]2;Action Required\x07", 2n);
      expect((await obs.snapshot()).signals.title).toBe("Action Required");
    } finally {
      obs.dispose();
    }
  });

  it("parses OSC 9 progress payload", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 80,
      rows: 24,
    });
    try {
      // Claude working flag style: OSC 9;4;3
      await feedAndWait(obs, "\x1b]9;4;3\x07");
      expect((await obs.snapshot()).signals.osc9).toBe("4;3");
    } finally {
      obs.dispose();
    }
  });

  it("tracks bracketed paste and synchronized output modes", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 80,
      rows: 24,
    });
    try {
      await feedAndWait(obs, "\x1b[?2004h\x1b[?2026h");
      let snap = await obs.snapshot();
      expect(snap.signals.modes.bracketedPaste).toBe(true);
      expect(snap.signals.modes.synchronizedOutput).toBe(true);

      await feedAndWait(obs, "\x1b[?2004l\x1b[?2026l", 2n);
      snap = await obs.snapshot();
      expect(snap.signals.modes.bracketedPaste).toBe(false);
      expect(snap.signals.modes.synchronizedOutput).toBe(false);
    } finally {
      obs.dispose();
    }
  });

  it("renders plain text into the grid", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 40,
      rows: 10,
    });
    try {
      await feedAndWait(obs, "hello agent\r\nline two\r\n");
      const snap = await obs.snapshot();
      expect(snap.text).toContain("hello agent");
      expect(snap.text).toContain("line two");
      expect(snap.cols).toBe(40);
      expect(snap.rows).toBe(10);
    } finally {
      obs.dispose();
    }
  });

  it("handles wide-char cells without blowing column cap", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 20,
      rows: 5,
      unicodeVersion: "6",
    });
    try {
      // Fullwidth + CJK — column arithmetic must not throw / corrupt.
      // Headless stock only has unicode v6 (same as renderer default).
      await feedAndWait(obs, "日本語テスト\r\n中文\r\n");
      const snap = await obs.snapshot();
      expect(snap.lines.length).toBe(5);
      for (const line of snap.lines) {
        // translateToString trims; we only assert no crash and finite lines.
        expect(typeof line).toBe("string");
      }
      expect(snap.text.length).toBeGreaterThan(0);
    } finally {
      obs.dispose();
    }
  });

  it("resize does not throw on mid-stream reflow", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 80,
      rows: 24,
    });
    try {
      await feedAndWait(obs, "x".repeat(100) + "\r\n");
      obs.resize(40, 12);
      const snap = await obs.snapshot();
      expect(snap.cols).toBe(40);
      expect(snap.rows).toBe(12);
      expect(snap.lines.length).toBe(12);
    } finally {
      obs.dispose();
    }
  });

  it("snapshot seq advances only after the write that owns it settles", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 40,
      rows: 10,
    });
    try {
      const seen: bigint[] = [];
      obs.subscribe((snap) => {
        seen.push(snap.seq);
      });
      obs.feed("a", 1n);
      obs.feed("b", 2n);
      const final = await obs.snapshot();
      expect(final.seq).toBe(2n);
      // Intermediate emits must not jump ahead of the applied write.
      expect(seen).toEqual([1n, 2n]);
    } finally {
      obs.dispose();
    }
  });
});

describe("TerminalObserverPlane", () => {
  it("attaches, feeds, and detaches by epoch", async () => {
    const plane = new TerminalObserverPlane();
    plane.attach({ bindingId: "b", epoch: "e1", cols: 40, rows: 10 });
    plane.feed("b", "\x1b]0;t1\x07hi\r\n", 1n);
    const snap = await plane.get("b")!.snapshot();
    expect(snap.signals.title).toBe("t1");
    expect(snap.text).toContain("hi");

    // Wrong epoch — no detach.
    plane.detach("b", "wrong");
    expect(plane.get("b")).toBeDefined();

    plane.detach("b", "e1");
    expect(plane.get("b")).toBeUndefined();
  });

  it("subscribeAll receives snapshots from sessions attached earlier", async () => {
    const plane = new TerminalObserverPlane();
    plane.attach({ bindingId: "b", epoch: "e1", cols: 40, rows: 10 });
    const seen: string[] = [];
    plane.subscribeAll((snap) => {
      seen.push(snap.signals.title);
    });
    plane.feed("b", "\x1b]0;late-sub\x07", 1n);
    await plane.get("b")!.snapshot();
    expect(seen).toContain("late-sub");
    plane.disposeAll();
  });
});
