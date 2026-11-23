import { describe, expect, it } from "vitest";
import { quickThreadIntentOf, type QuickThreadKeyState } from "../src/window/lib/quick-thread-keys";

const key = (over: { key: string; shiftKey?: boolean; metaKey?: boolean; isComposing?: boolean }) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

const typing: QuickThreadKeyState = { query: "fe", active: true, chosen: 0, ready: false };
const empty: QuickThreadKeyState = { query: "", active: false, chosen: 1, ready: false };

describe("quick thread keys", () => {
  it("runs seat, another seat, message, send without the mouse", () => {
    // fe, Shift+Enter: product-feed chosen, the keyboard stays for another.
    expect(quickThreadIntentOf(key({ key: "ArrowDown" }), "seats", typing, true)).toBe("next");
    expect(quickThreadIntentOf(key({ key: "Enter", shiftKey: true }), "seats", typing, true)).toBe("pickAnother");
    // sh, Enter: product-shell chosen, on to the message.
    expect(quickThreadIntentOf(key({ key: "Enter" }), "seats", { ...typing, chosen: 1 }, true)).toBe("pick");
    // The message, Enter: one new thread per seat.
    expect(
      quickThreadIntentOf(key({ key: "Enter" }), "message", { query: "", active: false, chosen: 2, ready: true }, true),
    ).toBe("send");
  });

  it("moves with the arrows and picks with Tab, as a combobox does", () => {
    expect(quickThreadIntentOf(key({ key: "ArrowUp" }), "seats", typing, true)).toBe("previous");
    expect(quickThreadIntentOf(key({ key: "Tab" }), "seats", typing, true)).toBe("pick");
    // Nothing active: Tab and Shift+Tab are the field's.
    expect(quickThreadIntentOf(key({ key: "Tab" }), "seats", empty, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Tab", shiftKey: true }), "seats", typing, true)).toBeNull();
  });

  it("moves on to the message on Enter once a seat is chosen and nothing is typed", () => {
    expect(quickThreadIntentOf(key({ key: "Enter" }), "seats", empty, true)).toBe("write");
    expect(quickThreadIntentOf(key({ key: "Enter" }), "seats", { ...empty, chosen: 0 }, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Enter" }), "seats", { ...empty, query: "zz" }, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Enter", shiftKey: true }), "seats", empty, true)).toBeNull();
  });

  it("takes the last seat off with Backspace only when nothing is typed", () => {
    expect(quickThreadIntentOf(key({ key: "Backspace" }), "seats", empty, true)).toBe("unpick");
    expect(quickThreadIntentOf(key({ key: "Backspace" }), "seats", { ...empty, query: "f" }, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Backspace" }), "seats", { ...empty, chosen: 0 }, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Backspace", metaKey: true }), "seats", empty, true)).toBeNull();
  });

  it("sends only with a seat chosen and something to send, and leaves Shift+Enter a new line", () => {
    const ready: QuickThreadKeyState = { query: "", active: false, chosen: 1, ready: true };
    expect(quickThreadIntentOf(key({ key: "Enter" }), "message", { ...ready, chosen: 0 }, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Enter" }), "message", { ...ready, ready: false }, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Enter", shiftKey: true }), "message", ready, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "ArrowDown" }), "message", ready, true)).toBeNull();
  });

  it("leaves Escape to the modal stack and a composing key to the input method", () => {
    expect(quickThreadIntentOf(key({ key: "Escape" }), "seats", typing, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Escape" }), "message", empty, true)).toBeNull();
    expect(quickThreadIntentOf(key({ key: "Enter", isComposing: true }), "seats", typing, true)).toBeNull();
  });
});
