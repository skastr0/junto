import { createRequire } from "node:module";
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
      await feedAndWait(obs, "\x1b]0;Claude - working\x07");
      const snap = await obs.snapshot();
      expect(snap.signals.title).toBe("Claude - working");

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

  it("tracks bracketed paste, sync, alt-screen, and mouse modes", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 80,
      rows: 24,
    });
    try {
      await feedAndWait(
        obs,
        "\x1b[?2004h\x1b[?2026h\x1b[?1049h\x1b[?1000;1003;1006h",
      );
      let snap = await obs.snapshot();
      expect(snap.signals.modes.bracketedPaste).toBe(true);
      expect(snap.signals.modes.synchronizedOutput).toBe(true);
      expect(snap.signals.modes.altScreen).toBe(true);
      expect(snap.signals.modes.mouseModes).toEqual([1000, 1003, 1006]);

      await feedAndWait(
        obs,
        "\x1b[?2004l\x1b[?2026l\x1b[?1000;1003;1006l\x1b[?1049l",
        2n,
      );
      snap = await obs.snapshot();
      expect(snap.signals.modes.bracketedPaste).toBe(false);
      expect(snap.signals.modes.synchronizedOutput).toBe(false);
      expect(snap.signals.modes.altScreen).toBe(false);
      expect(snap.signals.modes.mouseModes).toEqual([]);
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

  it("attachScreen dumps full buffer for long-session reopen", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 40,
      rows: 5,
      scrollback: 1000,
    });
    try {
      // More lines than viewport — must all be retained for attach.
      let blob = "";
      for (let i = 0; i < 30; i++) blob += `line-${i}\r\n`;
      await feedAndWait(obs, blob);
      const screen = await obs.attachScreen();
      expect(screen.serialized).toContain("line-0");
      expect(screen.serialized).toContain("line-29");
      expect(screen.bindingId).toBe("b1");
    } finally {
      obs.dispose();
    }
  });

  it("attachScreen preserves SGR color as serialized VT state", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 40,
      rows: 5,
    });
    try {
      await feedAndWait(obs, "\u001b[31mred\u001b[0m\r\n");
      const screen = await obs.attachScreen();
      expect(screen.serialized).toContain("\u001b[31mred");
      expect(screen.serialized).toContain("\u001b[0m");
    } finally {
      obs.dispose();
    }
  });

  /**
   * DEC private modes Grok 0.2.x sets at startup (measured from a real PTY):
   * alt screen, any-event tracking, SGR encoding, focus, bracketed paste.
   */
  const GROK_STARTUP_MODES =
    "[?1049h[?1000h[?1002h[?1003h" +
    "[?1015h[?1006h[?1004h[?2004h";

  it("attachScreen restores the negotiated mouse report encoding", async () => {
    const obs = new SessionObserver({
      bindingId: "b1",
      epoch: "e1",
      cols: 40,
      rows: 5,
    });
    try {
      await feedAndWait(obs, `${GROK_STARTUP_MODES}grok is up\r\n`);
      const screen = await obs.attachScreen();

      // Replay into a fresh grid the way TerminalSurface does on attach: a
      // wheel tick only reaches the TUI when the encoding survives too.
      const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as {
        Terminal: new (options?: Record<string, unknown>) => {
          write: (data: string, cb?: () => void) => void;
          modes: { readonly mouseTrackingMode: string };
          dispose: () => void;
        };
      };
      const reattached = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
      try {
        await new Promise<void>((resolve) => {
          reattached.write(screen.serialized, resolve);
        });
        expect(reattached.modes.mouseTrackingMode).toBe("any");
        expect(
          (reattached as unknown as {
            _core: { coreMouseService: { activeEncoding: string } };
          })._core.coreMouseService.activeEncoding,
        ).toBe("SGR");
      } finally {
        reattached.dispose();
      }
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
      const seen: Array<{ readonly seq: bigint; readonly text: string }> = [];
      obs.subscribe((snap) => {
        seen.push({ seq: snap.seq, text: snap.text });
      });
      obs.feed("a", 1n);
      obs.feed("b", 2n);
      const final = await obs.snapshot();
      expect(final.seq).toBe(2n);
      // A seq is only claimed once the grid holds the bytes it covers.
      expect(seen.length).toBeGreaterThan(0);
      for (const emit of seen) {
        if (emit.seq >= 1n) expect(emit.text).toContain("a");
        if (emit.seq >= 2n) expect(emit.text).toContain("ab");
      }
      expect(seen.map((e) => e.seq)).toEqual([...seen.map((e) => e.seq)].sort());
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

  it("subscribeAll immediately replays sessions attached earlier", async () => {
    const plane = new TerminalObserverPlane();
    const observer = plane.attach({ bindingId: "b", epoch: "e1", cols: 40, rows: 10 });
    plane.feed("b", "\x1b]0;before-sub\x07", 1n);
    await observer.snapshot();
    const seen: string[] = [];
    plane.subscribeAll((snap) => {
      seen.push(snap.signals.title);
    });
    expect(seen).toEqual(["before-sub"]);
    plane.disposeAll();
  });
});

describe("SessionObserver write cadence", () => {
  const dense = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `dense build log line ${i}\r\n`);

  it("produces the same grid whether bytes arrive as one chunk or many", async () => {
    const chunks = dense(2000);

    const split = new SessionObserver({ bindingId: "split", epoch: "e", cols: 80, rows: 24 });
    chunks.forEach((c, i) => split.feed(c, BigInt(i + 1)));
    const splitSnap = await split.snapshot();

    const whole = new SessionObserver({ bindingId: "whole", epoch: "e", cols: 80, rows: 24 });
    whole.feed(chunks.join(""), BigInt(chunks.length));
    const wholeSnap = await whole.snapshot();

    expect(splitSnap.lines).toEqual(wholeSnap.lines);
    expect(splitSnap.seq).toBe(BigInt(chunks.length));

    split.dispose();
    whole.dispose();
  });

  it("coalesces a burst into a handful of writes, not one per chunk", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    let emissions = 0;
    observer.subscribe(() => {
      emissions += 1;
    });

    const chunks = dense(500);
    chunks.forEach((c, i) => observer.feed(c, BigInt(i + 1)));
    await observer.snapshot();

    // Cost scales with how many writes are in flight, not with chunk count.
    expect(emissions).toBeLessThanOrEqual(5);
    expect(emissions).toBeLessThan(chunks.length);
    observer.dispose();
  });

  it("writes a chunk straight through when no write is in flight", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    let emissions = 0;
    observer.subscribe(() => {
      emissions += 1;
    });

    observer.feed("first\r\n", 1n);
    await observer.snapshot();
    observer.feed("second\r\n", 2n);
    const snap = await observer.snapshot();

    // A quiet seat pays no batching latency — each paint is its own write,
    // so the state machine still sees every transition.
    expect(emissions).toBe(2);
    expect(snap.text).toContain("first");
    expect(snap.text).toContain("second");
    observer.dispose();
  });

  it("attach includes bytes still inside the flush window", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    observer.feed("\x1b]0;live-title\x07buffered output\r\n", 7n);

    const screen = await observer.attachScreen();

    expect(screen.serialized).toContain("buffered output");
    expect(screen.seq).toBe(7n);
    observer.dispose();
  });
});
