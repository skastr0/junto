import { describe, expect, it } from "vitest";
import {
  KEY_CONTEXTS,
  KEY_TABLE,
  RESERVED_CHORDS,
  chordKeyCaps,
  chordOfKey,
  chordsFor,
  isBareChord,
  keyConflicts,
  reservedReason,
  resolveChord,
  resolveKey,
  resolveRelease,
  shortcutRepeats,
  type KeyContext,
  type KeyEventLike,
  type KeySituation,
} from "../src/shared/key-table";

const key = (over: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

const TYPING: ReadonlyArray<KeyContext> = ["terminal", "field"];
// Everywhere the app is in normal use: every context but the open switcher.
const APP: ReadonlyArray<KeyContext> = ["canvas", "terminal", "field", "working", "operator"];
const at = (context: KeyContext, mac = true, typing = TYPING.includes(context)): KeySituation => ({
  mac,
  context,
  typing,
});

describe("chordOfKey", () => {
  it("writes modifiers in one order, then the key", () => {
    expect(chordOfKey(key({ key: "k", metaKey: true }))).toBe("Cmd+K");
    expect(chordOfKey(key({ key: "Z", metaKey: true, shiftKey: true }))).toBe("Cmd+Shift+Z");
    expect(chordOfKey(key({ key: "Tab", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+Tab");
    expect(chordOfKey(key({ key: "/" }))).toBe("Slash");
  });

  it("reads digits and the backtick from the physical key", () => {
    expect(chordOfKey(key({ key: "!", code: "Digit1", metaKey: true, shiftKey: true }))).toBe("Cmd+Shift+1");
    expect(chordOfKey(key({ key: "3", code: "Numpad3" }))).toBe("3");
    expect(chordOfKey(key({ key: "~", code: "Backquote", metaKey: true, shiftKey: true }))).toBe(
      "Cmd+Shift+Backquote",
    );
    expect(chordOfKey(key({ key: "4" }))).toBe("4");
  });

  it("does not count Shift for a slash some layouts only reach with it", () => {
    expect(chordOfKey(key({ key: "/", shiftKey: true }))).toBe("Slash");
  });

  it("is nothing for a modifier pressed alone", () => {
    expect(chordOfKey(key({ key: "Meta", metaKey: true }))).toBeNull();
    expect(chordOfKey(key({ key: "Shift", shiftKey: true }))).toBeNull();
  });
});

describe("isBareChord", () => {
  it("is true without Cmd or Control: Alt alone types a character", () => {
    expect(isBareChord("Slash")).toBe(true);
    expect(isBareChord("Shift+A")).toBe(true);
    expect(isBareChord("Cmd+K")).toBe(false);
    expect(isBareChord("Ctrl+Shift+Tab")).toBe(false);
    expect(isBareChord("Alt+1")).toBe(true);
    expect(isBareChord("Alt+Shift+B")).toBe(true);
    expect(isBareChord("Cmd+Alt+1")).toBe(false);
  });
});

describe("the key table on macOS", () => {
  it("opens search and the feed with Cmd from everywhere", () => {
    for (const context of APP) {
      expect(resolveKey(key({ key: "k", metaKey: true }), at(context))).toEqual({ id: "search.open" });
      expect(resolveKey(key({ key: "i", metaKey: true }), at(context))).toEqual({ id: "feed.open" });
    }
  });

  it("never takes a Control chord: Control belongs to the shell", () => {
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const others = ["Tab", "[", "]", "/", " ", "`", "1", "5", "9", "Enter"];
    for (const context of KEY_CONTEXTS) {
      for (const name of [...letters, ...others]) {
        for (const shiftKey of [false, true]) {
          expect(resolveKey(key({ key: name, ctrlKey: true, shiftKey }), at(context))).toBeNull();
        }
      }
    }
  });

  it("has no default chord with Control in it", () => {
    for (const def of KEY_TABLE) {
      for (const chord of def.mac) expect(chord).not.toMatch(/(?:^|\+)Ctrl\+/);
    }
  });

  it("takes exactly one modifier for search: with Shift or Alt the chord is someone else's", () => {
    expect(resolveKey(key({ key: "K", metaKey: true, shiftKey: true }), at("canvas"))).toBeNull();
    expect(resolveKey(key({ key: "k", metaKey: true, altKey: true }), at("canvas"))).toBeNull();
    expect(resolveKey(key({ key: "k", metaKey: true, ctrlKey: true }), at("canvas"))).toBeNull();
  });

  it("never fires a typed character while the operator is typing", () => {
    const typed = ["/", " ", "`", "1", "9", "j", "k", "o"];
    for (const context of KEY_CONTEXTS) {
      for (const name of typed) {
        expect(resolveKey(key({ key: name }), at(context, true, true))).toBeNull();
        expect(resolveKey(key({ key: name, shiftKey: true }), at(context, true, true))).toBeNull();
      }
    }
  });

  it("opens search with a slash when nothing is being typed", () => {
    for (const context of ["canvas", "working", "operator"] as const) {
      expect(resolveKey(key({ key: "/" }), at(context))).toEqual({ id: "search.slash" });
    }
  });

  it("keeps the slash out of the way of chords, and reads it on layouts where it needs Shift", () => {
    expect(resolveKey(key({ key: "/", metaKey: true }), at("canvas"))).toBeNull();
    expect(resolveKey(key({ key: "/", altKey: true }), at("canvas"))).toBeNull();
    expect(resolveKey(key({ key: "/", shiftKey: true }), at("canvas"))).toEqual({ id: "search.slash" });
    expect(resolveKey(key({ key: "/" }), at("field"))).toBeNull();
    expect(resolveKey(key({ key: "/" }), at("terminal"))).toBeNull();
  });

  it("saves a command group with Cmd and a digit, and recalls it with the digit, on the canvas only", () => {
    expect(resolveKey(key({ key: "3", code: "Digit3", metaKey: true }), at("canvas"))).toEqual({
      id: "groups.assign",
      digit: 3,
    });
    expect(resolveKey(key({ key: "7", code: "Numpad7" }), at("canvas"))).toEqual({
      id: "groups.recall",
      digit: 7,
    });
    for (const context of ["terminal", "field", "working", "operator"] as const) {
      expect(resolveKey(key({ key: "3", code: "Digit3", metaKey: true }), at(context))?.id).not.toBe(
        "groups.assign",
      );
      expect(resolveKey(key({ key: "3", code: "Digit3" }), at(context))).toBeNull();
    }
  });

  it("jumps with Cmd and a digit from a terminal, a field or a working modal, and never saves there", () => {
    for (const context of ["terminal", "field", "working"] as const) {
      expect(resolveKey(key({ key: "2", code: "Digit2", metaKey: true }), at(context))).toEqual({
        id: "groups.jump",
        digit: 2,
      });
    }
    expect(resolveKey(key({ key: "2", code: "Digit2", metaKey: true }), at("operator"))).toBeNull();
  });

  it("opens the git review with Cmd+G where an agent is in front, not on the bare canvas or over search", () => {
    for (const context of ["terminal", "field", "working"] as const) {
      expect(resolveKey(key({ key: "g", metaKey: true }), at(context))).toEqual({ id: "git.review" });
    }
    expect(resolveKey(key({ key: "g", metaKey: true }), at("canvas"))).toBeNull();
    expect(resolveKey(key({ key: "g", metaKey: true }), at("operator"))).toBeNull();
    expect(resolveKey(key({ key: "G", metaKey: true, shiftKey: true }), at("terminal"))).toBeNull();
    expect(resolveKey(key({ key: "g", ctrlKey: true }), at("terminal"))).toBeNull();
  });

  it("leaves a digit chord with Shift, Alt or Control alone", () => {
    for (const context of KEY_CONTEXTS) {
      expect(resolveKey(key({ key: "!", code: "Digit1", metaKey: true, shiftKey: true }), at(context))).toBeNull();
      expect(resolveKey(key({ key: "¡", code: "Digit1", metaKey: true, altKey: true }), at(context))).toBeNull();
      expect(resolveKey(key({ key: "1", code: "Digit1", metaKey: true, ctrlKey: true }), at(context))).toBeNull();
      expect(resolveKey(key({ key: "!", code: "Digit1", shiftKey: true }), at(context))).toBeNull();
    }
  });

  it("cycles alerts with Space or the backtick, never with a modifier", () => {
    expect(resolveKey(key({ key: " ", code: "Space" }), at("canvas"))).toEqual({ id: "alerts.next" });
    expect(resolveKey(key({ key: "`", code: "Backquote" }), at("canvas"))).toEqual({ id: "alerts.next" });
    expect(resolveKey(key({ key: " ", code: "Space", shiftKey: true }), at("canvas"))).toBeNull();
    expect(resolveKey(key({ key: " ", code: "Space" }), at("operator"))).toBeNull();
    expect(resolveKey(key({ key: " ", code: "Space" }), at("working"))).toBeNull();
  });

  it("undoes and redoes on the canvas, and leaves Cmd+Z to a field", () => {
    expect(resolveKey(key({ key: "z", metaKey: true }), at("canvas"))).toEqual({ id: "canvas.undo" });
    expect(resolveKey(key({ key: "Z", metaKey: true, shiftKey: true }), at("canvas"))).toEqual({
      id: "canvas.redo",
    });
    expect(resolveKey(key({ key: "z", metaKey: true }), at("field"))).toBeNull();
    expect(resolveKey(key({ key: "z", metaKey: true }), at("terminal"))).toBeNull();
    // A surface in front has its own undo: the canvas behind it is not edited.
    expect(resolveKey(key({ key: "z", metaKey: true }), at("working"))).toBeNull();
  });

  it("steps through the agents that need the operator with Cmd and the backtick", () => {
    for (const context of ["canvas", "terminal", "field", "working", "switcher"] as const) {
      expect(resolveKey(key({ key: "`", code: "Backquote", metaKey: true }), at(context))).toEqual({
        id: "urgency.next",
      });
      expect(resolveKey(key({ key: "~", code: "Backquote", metaKey: true, shiftKey: true }), at(context))).toEqual({
        id: "urgency.previous",
      });
      expect(resolveKey(key({ key: "`", code: "Backquote", ctrlKey: true }), at(context))).toBeNull();
    }
    expect(resolveKey(key({ key: "`", code: "Backquote", metaKey: true }), at("operator"))).toBeNull();
  });

  it("moves inside the open switcher with the arrows and h j k l, Cmd still held", () => {
    const up = at("switcher", true, true);
    for (const name of ["ArrowDown", "ArrowRight", "j", "l"]) {
      expect(resolveKey(key({ key: name, metaKey: true }), up)).toEqual({ id: "switcher.next" });
    }
    for (const name of ["ArrowUp", "ArrowLeft", "k", "h"]) {
      expect(resolveKey(key({ key: name, metaKey: true }), up)).toEqual({ id: "switcher.previous" });
    }
    expect(resolveKey(key({ key: "Enter", metaKey: true }), up)).toEqual({ id: "switcher.commit" });
    expect(resolveKey(key({ key: "Escape", metaKey: true }), up)).toEqual({ id: "switcher.cancel" });
  });

  it("gives the switcher its keys only while it is up: Cmd+K is search again once it is down", () => {
    expect(resolveKey(key({ key: "k", metaKey: true }), at("switcher"))).toEqual({ id: "switcher.previous" });
    expect(resolveKey(key({ key: "k", metaKey: true }), at("terminal"))).toEqual({ id: "search.open" });
    expect(resolveKey(key({ key: "j", metaKey: true }), at("terminal"))).toBeNull();
    expect(resolveKey(key({ key: "w", metaKey: true }), at("switcher"))).toBeNull();
  });

  it("opens the chosen agent when Cmd is let go, only while the switcher is up", () => {
    expect(resolveRelease("Cmd", at("switcher"))).toEqual({ id: "switcher.commit" });
    for (const context of APP) expect(resolveRelease("Cmd", at(context))).toBeNull();
  });

  it("repeats only the stepping keys while a chord is held", () => {
    for (const def of KEY_TABLE) {
      const steps = ["urgency.next", "urgency.previous", "switcher.next", "switcher.previous"].includes(def.id);
      expect(shortcutRepeats(def.id)).toBe(steps);
    }
  });

  it("closes what is in front with Cmd+W from everywhere", () => {
    for (const context of APP) {
      expect(resolveKey(key({ key: "w", metaKey: true }), at(context))).toEqual({ id: "front.close" });
      expect(resolveKey(key({ key: "w", ctrlKey: true }), at(context))).toBeNull();
      expect(resolveKey(key({ key: "w", ctrlKey: true }), at(context, false))).toBeNull();
    }
  });

  it("zooms the canvas with Cmd and plus, minus or zero, only while the canvas has the keyboard", () => {
    expect(resolveKey(key({ key: "=", code: "Equal", metaKey: true }), at("canvas"))).toEqual({ id: "canvas.zoomIn" });
    expect(resolveKey(key({ key: "+", code: "Equal", metaKey: true, shiftKey: true }), at("canvas"))).toEqual({
      id: "canvas.zoomIn",
    });
    expect(resolveKey(key({ key: "+", code: "NumpadAdd", metaKey: true }), at("canvas"))).toEqual({
      id: "canvas.zoomIn",
    });
    expect(resolveKey(key({ key: "-", code: "Minus", metaKey: true }), at("canvas"))).toEqual({ id: "canvas.zoomOut" });
    expect(resolveKey(key({ key: "0", code: "Digit0", metaKey: true }), at("canvas"))).toEqual({
      id: "canvas.zoomReset",
    });
    for (const context of ["terminal", "field", "working", "operator"] as const) {
      expect(resolveKey(key({ key: "=", code: "Equal", metaKey: true }), at(context))).toBeNull();
      expect(resolveKey(key({ key: "-", code: "Minus", metaKey: true }), at(context))).toBeNull();
      expect(resolveKey(key({ key: "0", code: "Digit0", metaKey: true }), at(context))).toBeNull();
    }
  });

  it("has no two shortcuts on one chord in one place", () => {
    expect(keyConflicts(true)).toEqual([]);
  });

  it("binds nothing to a reserved chord", () => {
    for (const def of KEY_TABLE) {
      // Cmd+H is the h of h j k l while the switcher is up, and only there.
      const chords = def.id === "switcher.previous" ? def.mac.filter((chord) => chord !== "Cmd+H") : def.mac;
      for (const chord of chords) expect(reservedReason(chord, true)).toBeNull();
    }
    for (const { chord } of RESERVED_CHORDS) {
      for (const context of APP) expect(resolveChord(chord, at(context))).toBeNull();
    }
  });
});

describe("the key table off macOS", () => {
  it("keeps Ctrl+K and Ctrl+I, anywhere but a terminal", () => {
    for (const context of ["canvas", "field", "working", "operator"] as const) {
      expect(resolveKey(key({ key: "k", ctrlKey: true }), at(context, false))).toEqual({ id: "search.open" });
      expect(resolveKey(key({ key: "i", ctrlKey: true }), at(context, false))).toEqual({ id: "feed.open" });
    }
    expect(resolveKey(key({ key: "k", ctrlKey: true }), at("terminal", false))).toBeNull();
    expect(resolveKey(key({ key: "i", ctrlKey: true }), at("terminal", false))).toBeNull();
  });

  it("does not take the Super key", () => {
    expect(resolveKey(key({ key: "k", metaKey: true }), at("canvas", false))).toBeNull();
    expect(resolveKey(key({ key: "i", metaKey: true }), at("canvas", false))).toBeNull();
  });

  it("takes nothing from a terminal", () => {
    for (const def of KEY_TABLE) {
      if (def.other.length === 0) continue;
      expect(def.whereOther ?? def.where).not.toContain("terminal");
    }
  });

  it("saves a command group with Ctrl and a digit on the canvas, and ignores the Meta key", () => {
    expect(resolveKey(key({ key: "1", code: "Digit1", ctrlKey: true }), at("canvas", false))).toEqual({
      id: "groups.assign",
      digit: 1,
    });
    expect(resolveKey(key({ key: "1", code: "Digit1", metaKey: true }), at("canvas", false))).toBeNull();
    expect(resolveKey(key({ key: "1", code: "Digit1", ctrlKey: true }), at("terminal", false))).toBeNull();
  });

  it("has no two shortcuts on one chord in one place", () => {
    expect(keyConflicts(false)).toEqual([]);
  });
});

describe("rebinding", () => {
  it("answers the operator's chord in place of the default", () => {
    const overrides = { "feed.open": ["Cmd+J"] };
    expect(resolveChord("Cmd+J", at("terminal"), overrides)).toEqual({ id: "feed.open" });
    expect(resolveChord("Cmd+I", at("terminal"), overrides)).toBeNull();
    expect(chordsFor(KEY_TABLE.find((def) => def.id === "feed.open")!, true, overrides)).toEqual(["Cmd+J"]);
  });

  it("never answers a stored chord the system or the terminal owns", () => {
    const overrides = { "feed.open": ["Cmd+Q", "Ctrl+J", "Cmd+J"] };
    const feed = KEY_TABLE.find((def) => def.id === "feed.open")!;
    expect(chordsFor(feed, true, overrides)).toEqual(["Cmd+J"]);
    expect(resolveChord("Ctrl+J", at("terminal"), overrides)).toBeNull();
    expect(resolveChord("Cmd+Q", at("canvas"), overrides)).toBeNull();
  });

  it("ignores a stored chord for a shortcut that cannot change", () => {
    expect(resolveChord("Cmd+N", at("switcher"), { "switcher.next": ["Cmd+N"] })).toBeNull();
    expect(resolveChord("Cmd+J", at("switcher"), { "switcher.next": ["Cmd+N"] })).toEqual({ id: "switcher.next" });
  });

  it("finds a chord two shortcuts would share in one place", () => {
    expect(keyConflicts(true, { "feed.open": ["Cmd+K"] })).toContainEqual({
      chord: "Cmd+K",
      context: "terminal",
      ids: ["search.open", "feed.open"],
    });
    // A single digit collides with the whole digit row.
    expect(keyConflicts(true, { "alerts.next": ["5"] }).map((conflict) => conflict.ids)).toContainEqual([
      "groups.recall",
      "alerts.next",
    ]);
  });

  it("refuses the system's chords, the held ones and, on macOS, anything with Control", () => {
    expect(reservedReason("Cmd+Q", true)).toBe("macOS quits the app");
    expect(reservedReason("Cmd+P", true)).toBe("Held for a later Junto shortcut");
    expect(reservedReason("Ctrl+Tab", true)).toBe("Control belongs to the terminal");
    expect(reservedReason("Ctrl+K", false)).toBeNull();
    expect(reservedReason("Cmd+J", true)).toBeNull();
  });
});

describe("the agent view and the canvas", () => {
  it("widens or narrows the connections list with Cmd+B where an agent is in front", () => {
    expect(resolveKey(key({ key: "b", metaKey: true }), at("terminal"))).toEqual({ id: "rail.toggle" });
    expect(resolveKey(key({ key: "b", metaKey: true }), at("working"))).toEqual({ id: "rail.toggle" });
    // In a field Cmd+B belongs to the text.
    expect(resolveKey(key({ key: "b", metaKey: true }), at("field"))).toBeNull();
    expect(resolveKey(key({ key: "b", metaKey: true }), at("canvas"))).toBeNull();
    expect(resolveKey(key({ key: "b", ctrlKey: true }), at("terminal"))).toBeNull();
  });

  it("lets the keyboard out of a terminal with Cmd+Up and back with Cmd+Down", () => {
    expect(resolveKey(key({ key: "ArrowUp", metaKey: true }), at("terminal"))).toEqual({ id: "focus.toChrome" });
    expect(resolveKey(key({ key: "ArrowDown", metaKey: true }), at("working"))).toEqual({ id: "focus.toTerminal" });
    // In a text field both keep moving the caret; on the canvas they are not ours.
    for (const name of ["ArrowUp", "ArrowDown"]) {
      expect(resolveKey(key({ key: name, metaKey: true }), at("field"))).toBeNull();
      expect(resolveKey(key({ key: name, metaKey: true }), at("canvas"))).toBeNull();
      expect(resolveKey(key({ key: name, metaKey: true }), at("dialog"))).toBeNull();
    }
    // While the switcher is up the arrows are the switcher's.
    expect(resolveKey(key({ key: "ArrowUp", metaKey: true }), at("switcher"))).toEqual({ id: "switcher.previous" });
  });

  it("opens the selected agent from the canvas with Cmd+Enter, and nowhere else", () => {
    expect(resolveKey(key({ key: "Enter", metaKey: true }), at("canvas"))).toEqual({ id: "canvas.open" });
    for (const context of ["terminal", "field", "working", "operator", "dialog"] as const) {
      expect(resolveKey(key({ key: "Enter", metaKey: true }), at(context))).toBeNull();
    }
    expect(resolveKey(key({ key: "Enter" }), at("canvas"))).toBeNull();
  });
});

describe("under a dialog", () => {
  it("answers only search, the feed and closing what is in front", () => {
    const live = new Set<string>();
    for (const def of KEY_TABLE) {
      if (def.surface) continue;
      for (const chord of def.mac) {
        const hit = resolveChord(chord.replace("Digit", "1"), at("dialog", true, false));
        if (hit) live.add(hit.id);
      }
    }
    expect([...live].sort()).toEqual(["feed.open", "front.close", "search.open"]);
  });

  it("does not jump to another agent, undo, or cycle alerts from under a dialog", () => {
    expect(resolveKey(key({ key: "2", code: "Digit2", metaKey: true }), at("dialog"))).toBeNull();
    expect(resolveKey(key({ key: "z", metaKey: true }), at("dialog"))).toBeNull();
    expect(resolveKey(key({ key: " ", code: "Space" }), at("dialog", true, false))).toBeNull();
    expect(resolveKey(key({ key: "g", metaKey: true }), at("dialog"))).toBeNull();
  });
});

describe("under search or the feed", () => {
  it("does not cycle the agent terminals behind it", () => {
    expect(resolveKey(key({ key: "]", metaKey: true }), at("operator"))).toBeNull();
    expect(resolveKey(key({ key: "[", metaKey: true }), at("operator"))).toBeNull();
    expect(resolveKey(key({ key: "]", metaKey: true }), at("terminal"))).toEqual({ id: "mirrors.next" });
  });
});

describe("Alt chords", () => {
  it("never fire while the operator types, whatever is stored", () => {
    const overrides = { "git.review": ["Alt+B"] };
    expect(resolveChord("Alt+B", at("terminal"), overrides)).toBeNull();
    expect(resolveChord("Alt+B", at("field"), overrides)).toBeNull();
  });
});

describe("the table as a list", () => {
  it("gives every key one id and one name", () => {
    expect(new Set(KEY_TABLE.map((def) => def.id)).size).toBe(KEY_TABLE.length);
    expect(new Set(KEY_TABLE.map((def) => def.name)).size).toBe(KEY_TABLE.length);
  });

  it("never acts on a key a screen handles itself", () => {
    for (const def of KEY_TABLE.filter((row) => row.surface)) {
      expect(def.fixed).toBeDefined();
      for (const context of def.where) {
        for (const chord of def.mac) {
          const hit = resolveChord(chord, at(context, true, false));
          expect(hit?.id, `${def.id} ${chord} in ${context}`).not.toBe(def.id);
        }
      }
    }
    // J moves the needs-you feed; the dispatcher leaves it to the feed.
    expect(resolveKey(key({ key: "j" }), at("operator", true, false))).toBeNull();
    expect(resolveKey(key({ key: "w" }), at("canvas"))).toBeNull();
  });

  it("has no middle dot in any name or description", () => {
    const dot = String.fromCharCode(0xb7);
    for (const def of KEY_TABLE) expect(`${def.name}${def.does}${def.fixed ?? ""}`).not.toContain(dot);
  });
});

describe("chordKeyCaps", () => {
  it("shows glyphs on macOS and words elsewhere", () => {
    expect(chordKeyCaps("Cmd+Shift+Backquote", true)).toEqual(["⌘", "⇧", "`"]);
    expect(chordKeyCaps("Ctrl+K", false)).toEqual(["Ctrl", "K"]);
    expect(chordKeyCaps("Cmd+Digit", true)).toEqual(["⌘", "1 to 9"]);
  });
});
