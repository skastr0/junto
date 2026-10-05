import { describe, expect, it } from "vitest";
import { keyAria, keyIs } from "../src/renderer/lib/key-match";

const key = (over: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("keyIs", () => {
  it("sends a message with Cmd+Enter on macOS, and leaves Control+Enter alone", () => {
    expect(keyIs(key({ key: "Enter", metaKey: true }), "message.send", true)).toBe(true);
    expect(keyIs(key({ key: "Enter", ctrlKey: true }), "message.send", true)).toBe(false);
    expect(keyIs(key({ key: "Enter" }), "message.send", true)).toBe(false);
    expect(keyIs(key({ key: "Enter", metaKey: true, shiftKey: true }), "message.send", true)).toBe(false);
  });

  it("sends with Ctrl+Enter where there is no Cmd", () => {
    expect(keyIs(key({ key: "Enter", ctrlKey: true }), "message.send", false)).toBe(true);
    expect(keyIs(key({ key: "Enter", metaKey: true }), "message.send", false)).toBe(false);
  });

  it("is false for a modifier pressed alone", () => {
    expect(keyIs(key({ key: "Meta", metaKey: true }), "message.send", true)).toBe(false);
  });
});

describe("keyAria", () => {
  it("names the chord for assistive tech on each platform", () => {
    expect(keyAria("message.send", true)).toBe("Meta+Enter");
    expect(keyAria("message.send", false)).toBe("Control+Enter");
  });
});
