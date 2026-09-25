import { describe, expect, it } from "vitest";
import {
  comboboxKeyIntent,
  ghostSuffix,
  type ComboboxKeyState,
} from "../src/renderer/lib/combobox";

describe("ghostSuffix", () => {
  const base = {
    value: "/Users/developer/Pro",
    completion: "/Users/developer/Projects/",
    caretAtEnd: true,
  };

  it("draws the tail the completion adds past what was typed", () => {
    expect(ghostSuffix(base)).toBe("jects/");
  });

  it("continues a word typed in another case", () => {
    expect(ghostSuffix({ ...base, value: "/Users/developer/pro" })).toBe("jects/");
  });

  it("draws nothing unless the caret is at the end", () => {
    expect(ghostSuffix({ ...base, caretAtEnd: false })).toBe("");
  });

  it("draws nothing for a completion that does not extend the value", () => {
    expect(ghostSuffix({ ...base, completion: "/Users/developer/Downloads/" })).toBe("");
    expect(ghostSuffix({ ...base, completion: base.value })).toBe("");
    expect(ghostSuffix({ ...base, completion: undefined })).toBe("");
  });

  it("stays dismissed for the value it was dismissed at, and only that one", () => {
    expect(ghostSuffix({ ...base, dismissedFor: base.value })).toBe("");
    expect(
      ghostSuffix({
        ...base,
        value: "/Users/developer/Proj",
        dismissedFor: base.value,
      }),
    ).toBe("ects/");
  });
});

describe("comboboxKeyIntent", () => {
  const idle: ComboboxKeyState = {
    optionCount: 3,
    activeIndex: -1,
    ghost: false,
    caretAtEnd: true,
  };

  it("enters the list from either end", () => {
    expect(comboboxKeyIntent({ key: "ArrowDown" }, idle)).toEqual({
      type: "highlight",
      index: 0,
    });
    expect(comboboxKeyIntent({ key: "ArrowUp" }, idle)).toEqual({
      type: "highlight",
      index: 2,
    });
  });

  it("wraps the highlight around the list", () => {
    expect(
      comboboxKeyIntent({ key: "ArrowDown" }, { ...idle, activeIndex: 2 }),
    ).toEqual({ type: "highlight", index: 0 });
    expect(
      comboboxKeyIntent({ key: "ArrowUp" }, { ...idle, activeIndex: 0 }),
    ).toEqual({ type: "highlight", index: 2 });
  });

  it("leaves arrows alone over an empty list", () => {
    expect(
      comboboxKeyIntent({ key: "ArrowDown" }, { ...idle, optionCount: 0 }),
    ).toEqual({ type: "none" });
  });

  it("accepts the ghost with Tab, and lets Tab move focus without one", () => {
    expect(comboboxKeyIntent({ key: "Tab" }, { ...idle, ghost: true })).toEqual({
      type: "accept",
    });
    expect(comboboxKeyIntent({ key: "Tab" }, idle)).toEqual({ type: "none" });
    expect(
      comboboxKeyIntent({ key: "Tab", shiftKey: true }, { ...idle, ghost: true }),
    ).toEqual({ type: "none" });
  });

  it("accepts the ghost with ArrowRight only at the end of the value", () => {
    expect(
      comboboxKeyIntent({ key: "ArrowRight" }, { ...idle, ghost: true }),
    ).toEqual({ type: "accept" });
    expect(
      comboboxKeyIntent(
        { key: "ArrowRight" },
        { ...idle, ghost: true, caretAtEnd: false },
      ),
    ).toEqual({ type: "none" });
    expect(comboboxKeyIntent({ key: "ArrowRight" }, idle)).toEqual({
      type: "none",
    });
  });

  it("commits the highlighted row on Enter, or the typed value when none is", () => {
    expect(
      comboboxKeyIntent({ key: "Enter" }, { ...idle, activeIndex: 1 }),
    ).toEqual({ type: "commit", index: 1 });
    expect(comboboxKeyIntent({ key: "Enter" }, idle)).toEqual({
      type: "commit",
      index: undefined,
    });
  });

  it("leaves modified Enter to the surface", () => {
    expect(
      comboboxKeyIntent({ key: "Enter", metaKey: true }, { ...idle, activeIndex: 1 }),
    ).toEqual({ type: "none" });
  });

  it("spends Escape on the highlight or ghost first, then lets it through", () => {
    expect(
      comboboxKeyIntent({ key: "Escape" }, { ...idle, activeIndex: 0 }),
    ).toEqual({ type: "dismiss" });
    expect(
      comboboxKeyIntent({ key: "Escape" }, { ...idle, ghost: true }),
    ).toEqual({ type: "dismiss" });
    expect(comboboxKeyIntent({ key: "Escape" }, idle)).toEqual({ type: "none" });
  });

  it("gives every key to an IME composition", () => {
    expect(
      comboboxKeyIntent(
        { key: "Enter", isComposing: true },
        { ...idle, activeIndex: 1 },
      ),
    ).toEqual({ type: "none" });
  });

  it("ignores typing keys", () => {
    expect(comboboxKeyIntent({ key: "a" }, { ...idle, ghost: true })).toEqual({
      type: "none",
    });
  });
});
