/**
 * Observer evidence freshness and generation coherence.
 *
 * The drive's paste gate reads seat state, composer verdict, and the screen
 * through separate lookups. These tests pin what each lookup may answer from:
 * the settled grid of the slot's own generation, never a dead generation's
 * screen and never a grid the seat state was not judged on.
 */

import { afterEach, describe, expect, it } from "vitest";
import { SeatStateRuntime } from "../src/main/vellum-command/term/agent-state/runtime";
import {
  SessionObserver,
  terminalObserverPlane,
} from "../src/main/vellum-command/term/observer";
import type { ObserverGridSnapshot } from "../src/main/vellum-command/term/observer/types";
import { resetFirstTypedForTest } from "../src/main/vellum-command/term/first-typed";

const HR = "─".repeat(40);
const IDLE_EMPTY = [HR, "❯ ", HR, "footer"];
const IDLE_DRAFT = [HR, "❯ half-typed draft", HR, "footer"];

const snap = (
  bindingId: string,
  epoch: string,
  lines: readonly string[],
  seq = 1n,
): ObserverGridSnapshot => ({
  bindingId,
  epoch,
  cols: 80,
  rows: 24,
  lines: [...lines],
  text: lines.join("\n"),
  seq,
  signals: {
    title: "",
    osc9: "",
    modes: {
      bracketedPaste: true,
      synchronizedOutput: false,
      altScreen: false,
      mouseModes: [],
    },
  },
});

/** Paint a full screen into a live observer: clear, then one line per row. */
const paint = (lines: readonly string[]): string =>
  "\x1b[2J\x1b[H" + lines.join("\r\n");

afterEach(() => {
  resetFirstTypedForTest();
  terminalObserverPlane.disposeAll();
});

describe("generation coherence of runtime evidence", () => {
  it("a replacement generation starts with no screen evidence", () => {
    const rt = new SeatStateRuntime({ turnProgressWatch: false });
    rt.bindHarness("b1", "claude", "e1");
    rt.observe(snap("b1", "e1", IDLE_EMPTY));
    expect(rt.isSeatIdle("b1")).toBe(true);
    expect(rt.composerVerdict("b1")).toBe("empty");

    // The seat respawns under a new epoch. The host binds the new generation
    // before it has painted anything; the old generation's exit witness may
    // never call unbind for it (epoch mismatch is a no-op by design).
    rt.bindHarness("b1", "claude", "e2");
    expect(rt.getState("b1")).toBe("unknown");
    expect(rt.isSeatIdle("b1")).toBe(false);
    // The dead generation's empty composer must not authorize typing into
    // the new one.
    expect(rt.composerVerdict("b1")).toBe(null);
    rt.stop();
  });

  it("announces a replacement generation's first verdict even when it repeats the old one", () => {
    const rt = new SeatStateRuntime({ turnProgressWatch: false });
    rt.bindHarness("b1", "claude", "e1");
    const seen: Array<string | null> = [];
    rt.subscribeComposerVerdict((_, verdict) => {
      seen.push(verdict);
    });
    rt.observe(snap("b1", "e1", IDLE_EMPTY));
    rt.bindHarness("b1", "claude", "e2");
    rt.observe(snap("b1", "e2", IDLE_EMPTY));
    // Two generations, two composers: the drain boundary fires for each.
    expect(seen).toEqual(["empty", "empty"]);
    rt.stop();
  });

  it("the composer lookup refuses a live grid from another generation", async () => {
    const rt = new SeatStateRuntime({ turnProgressWatch: false });
    rt.bindHarness("bx", "claude", "e1");
    rt.observe(snap("bx", "e1", IDLE_EMPTY));
    expect(rt.composerVerdict("bx")).toBe("empty");

    // A grid for a different epoch is live on the plane. Whatever it shows
    // belongs to another generation and must not answer for this slot.
    const other = terminalObserverPlane.attach({
      bindingId: "bx",
      epoch: "e2",
      cols: 60,
      rows: 12,
    });
    terminalObserverPlane.feed("bx", paint(IDLE_DRAFT), 5n);
    await other.snapshot();
    expect(rt.composerVerdict("bx")).toBe("empty");
    rt.stop();
  });
});

describe("freshness of a live observer feed", () => {
  it("snapshotNow omits unparsed bytes but never claims their seq", async () => {
    const obs = new SessionObserver({
      bindingId: "s1",
      epoch: "e1",
      cols: 40,
      rows: 8,
    });
    try {
      const emitted: ObserverGridSnapshot[] = [];
      obs.subscribe((s) => {
        emitted.push(s);
      });
      obs.feed("\x1b]0;busy\x07hello", 3n);
      expect(obs.isSettled()).toBe(false);
      const now = obs.snapshotNow();
      // Fed bytes are not on the grid yet, and the snapshot says so: seq and
      // signals are those of the last settled write, not the pending one.
      expect(now.seq).toBe(0n);
      expect(now.text).not.toContain("hello");
      expect(now.signals.title).toBe("");
      expect(emitted).toEqual([]);

      const settled = await obs.snapshot();
      expect(obs.isSettled()).toBe(true);
      expect(settled.seq).toBe(3n);
      expect(settled.text).toContain("hello");
      expect(settled.signals.title).toBe("busy");
      // What a sync read returns after settle is exactly what listeners saw.
      expect(obs.snapshotNow()).toEqual(emitted.at(-1));
    } finally {
      obs.dispose();
    }
  });

  it("the plane reports settledness per binding", async () => {
    expect(terminalObserverPlane.isSettled("nobody")).toBe(undefined);
    const obs = terminalObserverPlane.attach({
      bindingId: "p1",
      epoch: "e1",
      cols: 40,
      rows: 8,
    });
    expect(terminalObserverPlane.isSettled("p1")).toBe(true);
    terminalObserverPlane.feed("p1", "x", 1n);
    expect(terminalObserverPlane.isSettled("p1")).toBe(false);
    await obs.snapshot();
    expect(terminalObserverPlane.isSettled("p1")).toBe(true);
  });

  it("seat state and composer verdict are judged on the same settled grid", async () => {
    const rt = new SeatStateRuntime({ turnProgressWatch: false });
    rt.start();
    const obs = terminalObserverPlane.attach({
      bindingId: "live",
      epoch: "e1",
      cols: 60,
      rows: 12,
    });
    rt.bindHarness("live", "claude", "e1");
    terminalObserverPlane.feed("live", paint(IDLE_EMPTY), 1n);
    await obs.snapshot();
    expect(rt.getState("live")).toBe("idle");
    expect(rt.isSeatIdle("live")).toBe(true);
    expect(rt.composerVerdict("live")).toBe("empty");

    // A repaint with a draft is fed but not yet parsed: every lookup still
    // answers from the settled grid the state was judged on.
    terminalObserverPlane.feed("live", paint(IDLE_DRAFT), 2n);
    expect(terminalObserverPlane.isSettled("live")).toBe(false);
    expect(rt.composerVerdict("live")).toBe("empty");
    expect(rt.isSeatIdle("live")).toBe(true);

    await obs.snapshot();
    expect(rt.composerVerdict("live")).toBe("draft");
    expect(rt.getState("live")).toBe("idle");
    rt.stop();
  });
});
