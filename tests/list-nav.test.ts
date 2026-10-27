import { describe, expect, it } from "vitest";
import { listIntentOf, stepList } from "../src/renderer/lib/list-nav";

const key = (over: Partial<Parameters<typeof listIntentOf>[0]> & { key: string }) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: null,
  ...over,
});

describe("stepping through a list", () => {
  const ids = ["a", "b", "c"];
  it("starts at the ends and clamps", () => {
    expect(stepList(ids, null, "next")).toBe("a");
    expect(stepList(ids, null, "previous")).toBe("c");
    expect(stepList(ids, "c", "next")).toBe("c");
    expect(stepList(ids, "a", "previous")).toBe("a");
    expect(stepList(ids, "a", "next")).toBe("b");
  });

  it("jumps to the first and last rows", () => {
    expect(stepList(ids, "b", "first")).toBe("a");
    expect(stepList(ids, "b", "last")).toBe("c");
  });

  it("recovers when the picked row left", () => {
    expect(stepList(ids, "gone", "next")).toBe("a");
    expect(stepList([], "a", "next")).toBeNull();
  });
});

describe("what a key means to a list", () => {
  it("reads J and K, the arrows, Home, End and Enter from the key table", () => {
    expect(listIntentOf(key({ key: "j" }))).toBe("next");
    expect(listIntentOf(key({ key: "ArrowDown" }))).toBe("next");
    expect(listIntentOf(key({ key: "k" }))).toBe("previous");
    expect(listIntentOf(key({ key: "ArrowUp" }))).toBe("previous");
    expect(listIntentOf(key({ key: "Home" }))).toBe("first");
    expect(listIntentOf(key({ key: "End" }))).toBe("last");
    expect(listIntentOf(key({ key: "Enter" }))).toBe("open");
  });

  it("leaves a chord, a handled key and any other key alone", () => {
    expect(listIntentOf(key({ key: "j", metaKey: true }))).toBeNull();
    expect(listIntentOf(key({ key: "ArrowDown", altKey: true }))).toBeNull();
    expect(listIntentOf(key({ key: "j", defaultPrevented: true }))).toBeNull();
    expect(listIntentOf(key({ key: "x" }))).toBeNull();
  });
});
