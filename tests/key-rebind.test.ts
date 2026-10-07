import { describe, expect, it } from "vitest";
import { clearChords, isRebound, proposeRebind, resetChords } from "../src/shared/key-rebind";
import { KEY_TABLE, keyConflicts, resolveChord } from "../src/shared/key-table";

describe("proposeRebind", () => {
  it("stores a free chord for the shortcut", () => {
    expect(proposeRebind("feed.open", "Cmd+J", true)).toEqual({
      kind: "ok",
      overrides: { "feed.open": ["Cmd+J"] },
    });
  });

  it("stores nothing when the chord is the default again", () => {
    expect(proposeRebind("feed.open", "Cmd+I", true, { "feed.open": ["Cmd+J"] })).toEqual({
      kind: "ok",
      overrides: {},
    });
  });

  it("refuses a chord the system owns, a held one, and anything with Control on macOS", () => {
    expect(proposeRebind("feed.open", "Cmd+Q", true)).toEqual({ kind: "refused", why: "macOS quits the app" });
    expect(proposeRebind("feed.open", "Cmd+P", true)).toEqual({
      kind: "refused",
      why: "Held for a later Junto shortcut",
    });
    expect(proposeRebind("feed.open", "Ctrl+J", true)).toEqual({
      kind: "refused",
      why: "Control belongs to the terminal",
    });
  });

  it("refuses a bare key for a shortcut that works while typing", () => {
    expect(proposeRebind("git.review", "G", true)).toEqual({
      kind: "refused",
      why: "Without Cmd it would be typed into the terminal",
    });
    // Option and a letter types a character on macOS; the shell moves by word with Alt.
    expect(proposeRebind("git.review", "Alt+B", true).kind).toBe("refused");
    expect(proposeRebind("groups.jump", "Alt+Shift+3", true).kind).toBe("refused");
    // On the canvas nothing is typed: a bare key is fine there.
    expect(proposeRebind("alerts.next", "N", true).kind).toBe("ok");
  });

  it("keeps Cmd in the switcher chord, and does not move the keys inside the switcher", () => {
    expect(proposeRebind("urgency.next", "Alt+Tab", true)).toEqual({
      kind: "refused",
      why: "Needs Cmd: letting Cmd go opens the agent",
    });
    expect(proposeRebind("urgency.next", "Cmd+E", true).kind).toBe("ok");
    expect(proposeRebind("switcher.next", "Cmd+N", true)).toEqual({
      kind: "refused",
      why: "Cmd is held while the switcher is up",
    });
  });

  it("names the shortcut that already has the chord, and what replacing would store", () => {
    const verdict = proposeRebind("feed.open", "Cmd+K", true);
    expect(verdict).toEqual({
      kind: "taken",
      by: "search.open",
      overrides: { "feed.open": ["Cmd+K"], "search.open": [] },
    });
    if (verdict.kind !== "taken") return;
    expect(keyConflicts(true, verdict.overrides)).toEqual([]);
    expect(resolveChord("Cmd+K", { mac: true, context: "terminal", typing: true }, verdict.overrides)).toEqual({
      id: "feed.open",
    });
  });

  it("takes only the clashing chord from a shortcut that has two", () => {
    expect(proposeRebind("search.slash", "Space", true)).toEqual({
      kind: "taken",
      by: "alerts.next",
      overrides: { "search.slash": ["Space"], "alerts.next": ["Backquote"] },
    });
  });

  it("does not see a clash between shortcuts that are never live in the same place", () => {
    // Zoom is canvas only; the git review is never live on the bare canvas.
    expect(proposeRebind("git.review", "Cmd+0", true).kind).toBe("ok");
  });

  it("reads a pressed digit as the whole digit row for a command group shortcut", () => {
    expect(proposeRebind("groups.jump", "Cmd+Alt+3", true)).toEqual({
      kind: "ok",
      overrides: { "groups.jump": ["Cmd+Alt+Digit"] },
    });
    expect(proposeRebind("feed.open", "Cmd+3", true).kind).toBe("taken");
  });

  it("leaves no two shortcuts on one chord for any single change it accepts", () => {
    for (const def of KEY_TABLE) {
      const verdict = proposeRebind(def.id, "Cmd+Shift+Y", true);
      if (verdict.kind === "refused") continue;
      expect(keyConflicts(true, verdict.overrides)).toEqual([]);
    }
  });
});

describe("clearing and resetting", () => {
  it("clears a shortcut to no key, and resets it to its default", () => {
    const cleared = clearChords("feed.open", true);
    expect(cleared).toEqual({ "feed.open": [] });
    expect(isRebound("feed.open", cleared)).toBe(true);
    expect(resolveChord("Cmd+I", { mac: true, context: "canvas", typing: false }, cleared)).toBeNull();
    const reset = resetChords("feed.open", cleared);
    expect(reset).toEqual({});
    expect(isRebound("feed.open", reset)).toBe(false);
  });

  it("does not clear a shortcut whose chord cannot change", () => {
    expect(clearChords("switcher.commit", true)).toEqual({});
  });
});
