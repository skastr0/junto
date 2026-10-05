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
  it("is true only without Cmd, Ctrl or Alt", () => {
    expect(isBareChord("Slash")).toBe(true);
    expect(isBareChord("Shift+A")).toBe(true);
    expect(isBareChord("Cmd+K")).toBe(false);
    expect(isBareChord("Ctrl+Shift+Tab")).toBe(false);
    expect(isBareChord("Alt+1")).toBe(false);
  });
});

describe("the key table on macOS", () => {
  it("opens search and the feed with Cmd from everywhere", () => {
    for (const context of KEY_CONTEXTS) {
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
  });

  it("undoes and redoes on the canvas, and leaves Cmd+Z to a field", () => {
    expect(resolveKey(key({ key: "z", metaKey: true }), at("canvas"))).toEqual({ id: "canvas.undo" });
    expect(resolveKey(key({ key: "Z", metaKey: true, shiftKey: true }), at("canvas"))).toEqual({
      id: "canvas.redo",
    });
    expect(resolveKey(key({ key: "z", metaKey: true }), at("field"))).toBeNull();
    expect(resolveKey(key({ key: "z", metaKey: true }), at("terminal"))).toBeNull();
  });

  it("has no two shortcuts on one chord in one place", () => {
    expect(keyConflicts(true)).toEqual([]);
  });

  it("binds nothing to a reserved chord", () => {
    for (const def of KEY_TABLE) {
      for (const chord of def.mac) expect(reservedReason(chord, true)).toBeNull();
    }
    for (const { chord } of RESERVED_CHORDS) {
      for (const context of KEY_CONTEXTS) expect(resolveChord(chord, at(context))).toBeNull();
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

describe("chordKeyCaps", () => {
  it("shows glyphs on macOS and words elsewhere", () => {
    expect(chordKeyCaps("Cmd+Shift+Backquote", true)).toEqual(["⌘", "⇧", "`"]);
    expect(chordKeyCaps("Ctrl+K", false)).toEqual(["Ctrl", "K"]);
    expect(chordKeyCaps("Cmd+Digit", true)).toEqual(["⌘", "1 to 9"]);
  });
});
