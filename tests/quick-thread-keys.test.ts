import { describe, expect, it } from "vitest";
import {
  chosenSeatsSpoken,
  quickThreadIntentOf,
  quickThreadSpoken,
  unpickSpoken,
  type QuickThreadKeyState,
} from "../src/window/lib/quick-thread-keys";

const key = (over: { key: string; shiftKey?: boolean; metaKey?: boolean; isComposing?: boolean }) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

const typing: QuickThreadKeyState = { query: "fe", active: true, chosen: 0 };
const empty: QuickThreadKeyState = { query: "", active: false, chosen: 1 };

describe("quick thread keys", () => {
  it("runs seat, another seat, then on to the message without the mouse", () => {
    expect(quickThreadIntentOf(key({ key: "ArrowDown" }), typing, true)).toBe("next");
    // fe, Shift+Enter: product-feed chosen, the keyboard stays for another.
    expect(quickThreadIntentOf(key({ key: "Enter", shiftKey: true }), typing, true)).toBe("pickAnother");
    // sh, Enter: product-shell chosen, on to the message, which sends as a thread does.
    expect(quickThreadIntentOf(key({ key: "Enter" }), { ...typing, chosen: 1 }, true)).toBe("pick");
  });

  it("moves with the arrows, and leaves Tab to the house combobox", () => {
    expect(quickThreadIntentOf(key({ key: "ArrowUp" }), typing, true)).toBe("previous");
    expect(quickThreadIntentOf(key({ key: "Tab" }), typing, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Tab", shiftKey: true }), typing, true)).toBeNull();
  });

  it("moves on to the message on Enter once a seat is chosen and nothing is typed", () => {
    expect(quickThreadIntentOf(key({ key: "Enter" }), empty, true)).toBe("write");
    expect(quickThreadIntentOf(key({ key: "Enter", shiftKey: true }), empty, true)).toBeNull();
  });

  it("answers an Enter with nothing to pick and nowhere to go, so it can be said", () => {
    expect(quickThreadIntentOf(key({ key: "Enter" }), { ...empty, chosen: 0 }, true)).toBe("nothing");
    expect(quickThreadIntentOf(key({ key: "Enter" }), { query: "zz", active: false, chosen: 0 }, true)).toBe("nothing");
    // A query that matches nothing is said even with a seat chosen.
    expect(quickThreadIntentOf(key({ key: "Enter" }), { ...empty, query: "zz" }, true)).toBe("nothing");
  });

  it("takes the last seat off with Backspace only when nothing is typed", () => {
    expect(quickThreadIntentOf(key({ key: "Backspace" }), empty, true)).toBe("unpick");
    expect(quickThreadIntentOf(key({ key: "Backspace" }), { ...empty, query: "f" }, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Backspace" }), { ...empty, chosen: 0 }, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Backspace", metaKey: true }), empty, true)).toBeNull();
  });

  it("shows every seat again before any seat comes off, when the list is narrowed to a region", () => {
    expect(quickThreadIntentOf(key({ key: "Backspace" }), { ...empty, narrowed: true }, true)).toBe("widen");
    expect(quickThreadIntentOf(key({ key: "Backspace" }), { ...empty, chosen: 0, narrowed: true }, true)).toBe("widen");
    expect(quickThreadIntentOf(key({ key: "Backspace" }), { ...empty, query: "f", narrowed: true }, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Backspace", shiftKey: true }), { ...empty, narrowed: true }, true)).toBeNull();
    expect(quickThreadSpoken({ kind: "widened", region: "Design System" })).toBe("Every seat, not only Design System");
  });

  it("leaves Escape to the modal stack and a composing key to the input method", () => {
    expect(quickThreadIntentOf(key({ key: "Escape" }), typing, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Enter", isComposing: true }), typing, true)).toBeNull();
  });
});

describe("what quick thread says", () => {
  it("says each pick, each unpick and each narrowing with the count", () => {
    expect(quickThreadSpoken({ kind: "added", seat: "product-feed", chosen: 2 })).toBe("product-feed added, 2 seats chosen");
    expect(quickThreadSpoken({ kind: "removed", seat: "product-feed", chosen: 1 })).toBe(
      "product-feed taken off, 1 seat chosen",
    );
    expect(quickThreadSpoken({ kind: "removed", seat: "product-feed", chosen: 0 })).toBe(
      "product-feed taken off, no seat chosen",
    );
    expect(quickThreadSpoken({ kind: "narrowed", region: "Design System", seats: 6 })).toBe("Design System, 6 seats");
    expect(quickThreadSpoken({ kind: "narrowed", region: "Cron", seats: 1 })).toBe("Cron, 1 seat");
  });

  it("says why an Enter did nothing", () => {
    expect(quickThreadSpoken({ kind: "nothing", query: "" })).toBe("Pick a seat first");
    expect(quickThreadSpoken({ kind: "nothing", query: "zz" })).toBe("No seat matches zz");
    expect(quickThreadSpoken({ kind: "noSeat" })).toBe("Pick a seat first");
  });

  it("names the count and the remove control", () => {
    expect(chosenSeatsSpoken(0)).toBe("No seat chosen");
    expect(chosenSeatsSpoken(3)).toBe("3 seats chosen");
    expect(unpickSpoken("product-feed")).toBe("Take product-feed off");
  });

  it("has no middle dot in anything it says", () => {
    const lines = [
      quickThreadSpoken({ kind: "added", seat: "a", chosen: 2 }),
      quickThreadSpoken({ kind: "nothing", query: "x" }),
      chosenSeatsSpoken(2),
      unpickSpoken("a"),
    ];
    for (const line of lines) expect(line).not.toContain("·");
  });
});
