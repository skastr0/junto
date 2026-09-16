import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OBSERVER_WRITE_INTERVAL_MS,
  OBSERVER_UNWATCHED_SCROLLBACK,
  OBSERVER_WATCHED_SCROLLBACK,
  SessionObserver,
  TerminalObserverPlane,
  getObserverWriteIntervalMs,
  setObserverWriteIntervalMs,
  afterLastHorizontalRule,
  bottomNonEmptyLines,
  footerLine,
  isHorizontalRule,
  promptBoxBody,
  sanitizeTitle,
} from "../src/main/junto/term/observer";
import { evaluate } from "../src/main/junto/term/agent-state";

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

/**
 * Sampling floor: how OFTEN the headless grid is written, on top of the
 * self-clocking coalescer. Bench (200x50 grid): term.write VT parse is
 * 1.166 ms/chunk and dominates observer cost; the viewport snapshot that
 * follows costs 0.085 ms. Batching the writes is therefore the whole win — and
 * the batch must never drop bytes, because VT is stateful.
 */
describe("SessionObserver sampling floor", () => {
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  /** Count real term.write calls by wrapping the observer's headless grid. */
  const countWrites = (observer: SessionObserver): { readonly n: () => number } => {
    const inner = observer as unknown as {
      term: { write: (data: string, cb?: () => void) => void };
    };
    const original = inner.term.write.bind(inner.term);
    let n = 0;
    inner.term.write = (data: string, cb?: () => void) => {
      n += 1;
      original(data, cb);
    };
    return { n: () => n };
  };

  /**
   * Load the floor exists for: chunks keep arriving while the grid is still
   * parsing the last batch (node-pty hands over ~50k chunks/sec on dense
   * output). Each tick queues a group behind the in-flight write.
   */
  const streamUnderLoad = async (
    observer: SessionObserver,
    opts: { readonly ticks: number; readonly perTick: number; readonly gapMs: number },
  ): Promise<{ readonly chunks: number; readonly bytes: string }> => {
    let seq = 0n;
    let bytes = "";
    for (let tick = 0; tick < opts.ticks; tick++) {
      for (let i = 0; i < opts.perTick; i++) {
        seq += 1n;
        const chunk = `dense build log line ${seq}\r\n`;
        bytes += chunk;
        observer.feed(chunk, seq);
      }
      await delay(opts.gapMs);
    }
    return { chunks: Number(seq), bytes };
  };

  it("caps a loaded stream at the sampling floor instead of writing per batch", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    const writes = countWrites(observer);

    // ~600ms of stream, 10 chunks every 20ms. Unfloored, every tick pays an
    // immediate write plus its coalesced follow-up.
    const { chunks, bytes } = await streamUnderLoad(observer, {
      ticks: 30,
      perTick: 10,
      gapMs: 20,
    });
    const snap = await observer.snapshot();

    // 600ms at a 200ms floor: the leading write, ~3 floor writes, the settle.
    expect(writes.n()).toBeLessThanOrEqual(8);

    // Batched, never skipped: every byte landed, in order, with its seq.
    expect(snap.seq).toBe(BigInt(chunks));
    expect(snap.text).toContain(`dense build log line ${chunks}`);

    const control = new SessionObserver({ bindingId: "c", epoch: "e", cols: 80, rows: 24 });
    control.feed(bytes, BigInt(chunks));
    const controlSnap = await control.snapshot();
    expect(snap.lines).toEqual(controlSnap.lines);

    observer.dispose();
    control.dispose();
  });

  it("writes a lone chunk into an idle observer immediately", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    try {
      const startedAt = Date.now();
      const emitted = new Promise<number>((resolve) => {
        observer.subscribe(() => {
          resolve(Date.now() - startedAt);
        });
      });
      // No snapshot() await — the write must happen on its own, not because a
      // caller forced a settle.
      observer.feed("\x1b]0;Claude - working\x07", 1n);
      expect(await emitted).toBeLessThan(100);
    } finally {
      observer.dispose();
    }
  });

  it("never holds a chunk back when the grid is not mid-write", async () => {
    // The floor is for load, not for cadence: a seat painting once per tick
    // still gets a write (and therefore a snapshot) per paint, so the
    // edge-driven seat state machine sees every transition.
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    const writes = countWrites(observer);
    try {
      for (let i = 0; i < 5; i++) {
        observer.feed(`paint ${i}\r\n`, BigInt(i + 1));
        await observer.snapshot();
      }
      expect(writes.n()).toBe(5);
    } finally {
      observer.dispose();
    }
  });

  it("never holds a seat-signal edge behind the floor", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    try {
      const titles: string[] = [];
      observer.subscribe((snap) => {
        titles.push(snap.signals.title);
      });
      // Put the observer under load first, so the floor is engaged.
      await streamUnderLoad(observer, { ticks: 4, perTick: 10, gapMs: 10 });
      const startedAt = Date.now();
      const seen = new Promise<number>((resolve) => {
        observer.subscribe((snap) => {
          if (snap.signals.title === "Action Required") resolve(Date.now() - startedAt);
        });
      });
      observer.feed("\x1b]0;Action Required\x07", 999n);
      // OSC title / OSC 9 / DEC-private bytes are the seat signal — sampling
      // the grid must not sample them.
      expect(await seen).toBeLessThan(100);
    } finally {
      observer.dispose();
    }
  });

  it("settles buffered bytes without waiting out the floor", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    try {
      // Queue bytes behind an in-flight write so the floor is holding them.
      observer.feed("a".repeat(4_000), 1n);
      observer.feed("b", 2n);
      observer.feed("c", 3n);
      // Let the in-flight write land: the follow-up is now on the floor timer.
      await delay(40);
      const startedAt = Date.now();
      const snap = await observer.snapshot();

      expect(Date.now() - startedAt).toBeLessThan(150);
      expect(snap.text).toContain("bc");
      expect(snap.seq).toBe(3n);
    } finally {
      observer.dispose();
    }
  });

  it("releases held bytes on its own when nobody settles", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    try {
      let lastText = "";
      observer.subscribe((snap) => {
        lastText = snap.text;
      });
      observer.feed("a".repeat(4_000), 1n);
      observer.feed("held-tail\r\n", 2n);

      // The floor timer must fire on its own — no snapshot(), no settle.
      await delay(DEFAULT_OBSERVER_WRITE_INTERVAL_MS + 200);
      expect(lastText).toContain("held-tail");
    } finally {
      observer.dispose();
    }
  });

  it("honors a per-session interval override", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    const writes = countWrites(observer);
    try {
      expect(observer.writeIntervalMs).toBe(DEFAULT_OBSERVER_WRITE_INTERVAL_MS);
      // Zero floor restores per-batch writes for a session that needs them.
      observer.setWriteIntervalMs(0);
      expect(observer.writeIntervalMs).toBe(0);

      await streamUnderLoad(observer, { ticks: 12, perTick: 10, gapMs: 20 });
      await observer.snapshot();
      expect(writes.n()).toBeGreaterThan(8);

      observer.setWriteIntervalMs(undefined);
      expect(observer.writeIntervalMs).toBe(DEFAULT_OBSERVER_WRITE_INTERVAL_MS);
    } finally {
      observer.dispose();
    }
  });

  it("scales the process-wide floor through the setter, clamped", () => {
    try {
      setObserverWriteIntervalMs(450);
      expect(getObserverWriteIntervalMs()).toBe(450);
      const scaled = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
      expect(scaled.writeIntervalMs).toBe(450);
      scaled.dispose();

      setObserverWriteIntervalMs(-5);
      expect(getObserverWriteIntervalMs()).toBe(0);
      setObserverWriteIntervalMs(99_999);
      expect(getObserverWriteIntervalMs()).toBe(2_000);
      setObserverWriteIntervalMs(Number.NaN);
      expect(getObserverWriteIntervalMs()).toBe(DEFAULT_OBSERVER_WRITE_INTERVAL_MS);
    } finally {
      setObserverWriteIntervalMs(DEFAULT_OBSERVER_WRITE_INTERVAL_MS);
    }
  });

  it("dispose drops held bytes and their timer", async () => {
    const observer = new SessionObserver({ bindingId: "b", epoch: "e", cols: 80, rows: 24 });
    let emissions = 0;
    observer.subscribe(() => {
      emissions += 1;
    });
    observer.feed("a".repeat(4_000), 1n);
    observer.feed("held\r\n", 2n);
    const afterFeed = emissions;
    observer.dispose();
    await delay(DEFAULT_OBSERVER_WRITE_INTERVAL_MS + 150);
    expect(emissions).toBe(afterFeed);
  });
});

/**
 * Retention tiering: a session nobody has open keeps a bounded scrollback; a
 * session with an attached surface keeps the full one. The seat signal reads
 * the viewport only, so it must be identical either way.
 */
describe("SessionObserver retention tier", () => {
  const ROWS = 24;
  const COLS = 80;
  const ESC = "\u001b";
  /** OSC string terminator (BEL). */
  const BEL = "\u0007";
  const HR = "─".repeat(40);

  const mkObserver = (bindingId: string): SessionObserver =>
    new SessionObserver({ bindingId, epoch: "e1", cols: COLS, rows: ROWS });

  /** Enough output to overflow the unwatched cap several times over. */
  const backlog = (lines: number): string => {
    let out = "";
    for (let i = 0; i < lines; i++) {
      out += `${ESC}[38;5;${(i % 200) + 16}m* build step ${i} emitted output${ESC}[0m\r\n`;
    }
    return out;
  };

  /** Blank the viewport by scrolling it away, leaving scrollback intact. */
  const clearViewport = (): string => "\r\n".repeat(ROWS + 2);

  const CLAUDE_WORKING =
    `${clearViewport()}${ESC}]0;◐ Puzzling${BEL}` +
    "  Puzzling… (54s, 2.7k tokens, esc to interrupt)\r\n";

  const CLAUDE_PERMISSION =
    `${clearViewport()}${HR}\r\n` +
    "Bash command\r\n" +
    "  rm -rf build/\r\n" +
    "Do you want to proceed?\r\n" +
    "1. Yes\r\n" +
    "2. No, tell Claude what to do differently\r\n";

  const CLAUDE_IDLE =
    `${clearViewport()}${ESC}]0;idle${BEL}${HR}\r\n` +
    "❯ \r\n" +
    `${HR}\r\n` +
    "  ? for shortcuts\r\n";

  const drive = async (
    obs: SessionObserver,
    phase: string,
    seq: bigint,
  ): Promise<ReturnType<SessionObserver["snapshotNow"]>> => {
    obs.feed(phase, seq);
    return obs.snapshot();
  };

  it("keeps the seat signal identical whether or not a surface is attached", async () => {
    const unwatched = mkObserver("unwatched");
    const watched = mkObserver("watched");
    watched.retainSurface();

    // The tier really differs, or this test proves nothing.
    expect(unwatched.scrollbackLines).toBe(OBSERVER_UNWATCHED_SCROLLBACK);
    expect(watched.scrollbackLines).toBe(OBSERVER_WATCHED_SCROLLBACK);

    const stream =
      backlog(OBSERVER_UNWATCHED_SCROLLBACK * 3) +
      `${ESC}]0;◐ Puzzling${BEL}` +
      `${ESC}]9;4;3;50${BEL}` +
      `${HR}\r\n❯ \r\n${HR}\r\n  ? for shortcuts\r\n`;

    unwatched.feed(stream, 7n);
    watched.feed(stream, 7n);
    const a = await unwatched.snapshot();
    const b = await watched.snapshot();

    expect(a.lines).toEqual(b.lines);
    expect(a.text).toBe(b.text);
    expect(a.signals).toEqual(b.signals);
    expect(a.cols).toBe(b.cols);
    expect(a.rows).toBe(b.rows);
    expect(a.seq).toBe(b.seq);
    expect(a.signals.title).toBe("◐ Puzzling");
    expect(a.signals.osc9).toBe("4;3;50");

    unwatched.dispose();
    watched.dispose();
  });

  it("drives the same seat-state transitions with no surface attached", async () => {
    const unwatched = mkObserver("b-unwatched");
    const watched = mkObserver("b-watched");
    watched.retainSurface();

    const preload = backlog(OBSERVER_UNWATCHED_SCROLLBACK * 2);
    unwatched.feed(preload, 1n);
    watched.feed(preload, 1n);
    await unwatched.snapshot();
    await watched.snapshot();

    const phases: ReadonlyArray<readonly [string, string, string]> = [
      ["working", CLAUDE_WORKING, "working"],
      ["permission", CLAUDE_PERMISSION, "attention"],
      ["idle", CLAUDE_IDLE, "idle"],
    ];

    let seq = 2n;
    for (const [label, bytes, expected] of phases) {
      const a = await drive(unwatched, bytes, seq);
      const b = await drive(watched, bytes, seq);
      seq += 1n;
      const evalA = evaluate(a, { harness: "claude" });
      const evalB = evaluate(b, { harness: "claude" });
      expect(`${label}:${evalA.state}`).toBe(`${label}:${expected}`);
      expect(evalA.state).toBe(evalB.state);
      expect(evalA.ruleId).toBe(evalB.ruleId);
      expect(a.lines).toEqual(b.lines);
    }

    unwatched.dispose();
    watched.dispose();
  });

  it("hands a reopened node the same visible screen as a fully retained grid", async () => {
    const unwatched = mkObserver("c-unwatched");
    const watched = mkObserver("c-watched");
    watched.retainSurface();

    const stream = backlog(OBSERVER_UNWATCHED_SCROLLBACK * 2) + CLAUDE_IDLE;
    unwatched.feed(stream, 3n);
    watched.feed(stream, 3n);

    const a = await unwatched.attachScreen();
    const b = await watched.attachScreen();
    expect(a.cols).toBe(b.cols);
    expect(a.rows).toBe(b.rows);
    expect(a.seq).toBe(b.seq);

    // Replay both payloads into fresh grids and compare what the operator sees.
    const replayRequire = createRequire(import.meta.url);
    const { Terminal } = replayRequire("@xterm/headless") as {
      Terminal: new (o?: Record<string, unknown>) => {
        buffer: {
          active: {
            viewportY: number;
            length: number;
            getLine: (
              y: number,
            ) =>
              | {
                  translateToString: (t?: boolean, s?: number, e?: number) => string;
                }
              | undefined;
          };
        };
        write: (d: string, cb?: () => void) => void;
        dispose: () => void;
      };
    };
    const replay = async (serialized: string): Promise<string> => {
      const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
      await new Promise<void>((resolve) => {
        term.write(serialized, resolve);
      });
      const buf = term.buffer.active;
      const out: string[] = [];
      const from = Math.max(0, Math.min(buf.viewportY, buf.length));
      for (let y = 0; y < ROWS; y++) {
        const line = buf.getLine(from + y);
        out.push(line ? line.translateToString(true, 0, COLS) : "");
      }
      term.dispose();
      return out.join("\n");
    };
    expect(await replay(a.serialized)).toBe(await replay(b.serialized));

    // Bounded is not empty: the reopened node still gets scrollback, right up
    // to the cap. The last backlog line written is well inside the window.
    const lastBacklogLine = OBSERVER_UNWATCHED_SCROLLBACK * 2 - 1;
    expect(a.serialized).toContain(`build step ${lastBacklogLine} `);
    // ...and it stops there, which is the whole win: same screen, a fraction
    // of the payload a node open must serialize, ship over IPC, and re-parse.
    expect(a.serialized).not.toContain("build step 0 ");
    expect(b.serialized).toContain("build step 0 ");
    expect(a.serialized.length).toBeLessThan(b.serialized.length / 1.5);

    unwatched.dispose();
    watched.dispose();
  });

  it("refcounts surfaces so the last viewer restores the bounded window", () => {
    const obs = mkObserver("d");
    expect(obs.surfaceCount).toBe(0);
    obs.retainSurface();
    obs.retainSurface();
    expect(obs.surfaceCount).toBe(2);
    expect(obs.scrollbackLines).toBe(OBSERVER_WATCHED_SCROLLBACK);
    obs.releaseSurface();
    expect(obs.scrollbackLines).toBe(OBSERVER_WATCHED_SCROLLBACK);
    obs.releaseSurface();
    expect(obs.surfaceCount).toBe(0);
    expect(obs.scrollbackLines).toBe(OBSERVER_UNWATCHED_SCROLLBACK);
    // Unbalanced release never underflows into negative retention.
    obs.releaseSurface();
    expect(obs.surfaceCount).toBe(0);
    obs.dispose();
  });

  it("carries an open node's retention across a replacement generation", () => {
    const plane = new TerminalObserverPlane();
    plane.attach({ bindingId: "b1", epoch: "e1", cols: COLS, rows: ROWS });
    plane.retainSurface("b1");
    expect(plane.get("b1")?.scrollbackLines).toBe(OBSERVER_WATCHED_SCROLLBACK);

    // Resume / respawn replaces the grid; the lease outlives the epoch.
    plane.attach({ bindingId: "b1", epoch: "e2", cols: COLS, rows: ROWS });
    expect(plane.get("b1")?.surfaceCount).toBe(1);
    expect(plane.get("b1")?.scrollbackLines).toBe(OBSERVER_WATCHED_SCROLLBACK);

    plane.releaseSurface("b1");
    expect(plane.surfaceCount("b1")).toBe(0);
    expect(plane.get("b1")?.scrollbackLines).toBe(OBSERVER_UNWATCHED_SCROLLBACK);

    // A binding with no live grid still records the lease for the next one.
    plane.detach("b1", "e2");
    plane.retainSurface("b1");
    plane.attach({ bindingId: "b1", epoch: "e3", cols: COLS, rows: ROWS });
    expect(plane.get("b1")?.scrollbackLines).toBe(OBSERVER_WATCHED_SCROLLBACK);
    plane.disposeAll();
  });
});

describe("SessionObserver resize ordering", () => {
  const make = (cols: number, rows: number): SessionObserver =>
    new SessionObserver({ bindingId: "rz", epoch: "e1", cols, rows });
  // Two rows painted for a 40-column grid: the second places text at
  // column 35. Parsed at 40 then shrunk to 20, xterm keeps "abc" and drops
  // the cells past the new edge; parsed at 20, column 35 clamps to the edge
  // and "END" wraps onto a third row.
  const WIDE_ROW = "\x1b[2J\x1b[Hrow-one\r\nabc\x1b[35GEND";

  it("bytes fed before a resize are parsed at the geometry they were rendered for", async () => {
    // Reference: parse at 40 columns, then shrink — the order the PTY child
    // and the renderer both saw.
    const ref = make(40, 6);
    const obs = make(40, 6);
    try {
      ref.feed(WIDE_ROW, 1n);
      await ref.snapshot();
      ref.resize(20, 6);
      const expected = await ref.snapshot();

      // Under test: the bytes are still queued when the resize arrives.
      obs.feed(WIDE_ROW, 1n);
      obs.resize(20, 6);
      const settled = await obs.snapshot();
      expect(settled.cols).toBe(20);
      expect(settled.seq).toBe(1n);
      expect(expected.lines.slice(0, 2)).toEqual(["row-one", "abc"]);
      expect(settled.lines).toEqual(expected.lines);
    } finally {
      ref.dispose();
      obs.dispose();
    }
  });

  it("bytes fed after a queued resize land at the new geometry", async () => {
    const ref = make(40, 6);
    const obs = make(40, 6);
    try {
      ref.feed(WIDE_ROW, 1n);
      await ref.snapshot();
      ref.resize(20, 6);
      ref.feed("\r\n\x1b[35GB", 2n);
      const expected = await ref.snapshot();

      obs.feed(WIDE_ROW, 1n);
      obs.resize(20, 6);
      obs.feed("\r\n\x1b[35GB", 2n);
      const settled = await obs.snapshot();
      expect(settled.seq).toBe(2n);
      expect(settled.lines).toEqual(expected.lines);
    } finally {
      ref.dispose();
      obs.dispose();
    }
  });

  it("a resize on a settled grid applies synchronously", async () => {
    const obs = make(40, 6);
    try {
      obs.feed("hi", 1n);
      await obs.snapshot();
      const seen: number[] = [];
      obs.subscribe((s) => {
        seen.push(s.cols);
      });
      obs.resize(20, 6);
      expect(obs.snapshotNow().cols).toBe(20);
      expect(seen).toEqual([20]);
    } finally {
      obs.dispose();
    }
  });
});

describe("SessionObserver queue depth", () => {
  const make = (cols = 40, rows = 6): SessionObserver =>
    new SessionObserver({ bindingId: "qd", epoch: "e1", cols, rows });
  const depthOf = (obs: SessionObserver): number =>
    (obs as unknown as { queueDepth: number }).queueDepth;
  const termOf = (
    obs: SessionObserver,
  ): { write: (data: string, cb?: () => void) => void } =>
    (obs as unknown as { term: { write: (data: string, cb?: () => void) => void } }).term;
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

  it("stays unsettled at the first emit while a settle-chained write is still queued", async () => {
    const obs = make();
    try {
      let atFirstEmit: boolean | undefined;
      obs.subscribe((s) => {
        if (s.seq === 1n && atFirstEmit === undefined) atFirstEmit = obs.isSettled();
      });
      obs.feed("a", 1n);
      obs.feed("b", 2n); // waits behind the first write
      const settled = await obs.snapshot(); // chains the second write now
      expect(atFirstEmit, "second write still queued at the first emit").toBe(false);
      expect(settled.seq).toBe(2n);
      expect(settled.text).toContain("ab");
      expect(obs.isSettled()).toBe(true);
      expect(depthOf(obs)).toBe(0);
    } finally {
      obs.dispose();
    }
  });

  it("queued resizes apply in order behind the bytes and end at the last geometry", async () => {
    const obs = make();
    try {
      const cols: number[] = [];
      obs.subscribe((s) => {
        cols.push(s.cols);
      });
      obs.feed("\x1b[2J\x1b[Habc", 1n);
      obs.resize(20, 6);
      obs.resize(30, 8);
      expect(obs.isSettled()).toBe(false);
      const settled = await obs.snapshot();
      expect(settled.cols).toBe(30);
      expect(settled.rows).toBe(8);
      expect(settled.seq).toBe(1n);
      expect(settled.lines[0]).toBe("abc");
      expect(cols).toEqual([40, 20, 30]);
      expect(obs.isSettled()).toBe(true);
      expect(depthOf(obs)).toBe(0);
    } finally {
      obs.dispose();
    }
  });

  it("a write that throws releases the queue; later bytes still land", async () => {
    const obs = make();
    try {
      const term = termOf(obs);
      const realWrite = term.write.bind(term);
      let throwOnce = true;
      term.write = (data, cb) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("grid refused the write");
        }
        realWrite(data, cb);
      };
      obs.feed("lost", 1n);
      await tick();
      expect(obs.isSettled()).toBe(true);
      expect(depthOf(obs)).toBe(0);

      obs.feed("kept", 2n);
      const settled = await obs.snapshot();
      expect(settled.seq).toBe(2n);
      expect(settled.text).toContain("kept");
      expect(obs.isSettled()).toBe(true);
      expect(depthOf(obs)).toBe(0);
    } finally {
      obs.dispose();
    }
  });

  it("dispose with writes and a resize queued leaves no negative depth and emits nothing after", async () => {
    const obs = make();
    const emitted: bigint[] = [];
    obs.subscribe((s) => {
      emitted.push(s.seq);
    });
    obs.feed("a", 1n);
    obs.feed("b", 2n);
    obs.resize(20, 6);
    expect(obs.isSettled()).toBe(false);
    obs.dispose();
    await tick();
    // The grid still runs the queued callbacks after dispose, so the chain
    // drains to zero rather than sticking; nothing is emitted for it.
    expect(emitted).toEqual([]);
    expect(depthOf(obs)).toBe(0);
    // Late feeds and resizes on a disposed observer are inert.
    obs.feed("c", 3n);
    obs.resize(30, 8);
    await tick();
    expect(depthOf(obs)).toBe(0);
    expect(emitted).toEqual([]);
    // A settle on a disposed observer resolves rather than hanging.
    await obs.snapshot();
  });
});
