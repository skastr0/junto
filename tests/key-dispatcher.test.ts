import { describe, expect, it, vi } from "vitest";
import { dispatchKey, keyContextOf, type KeyActions } from "../src/renderer/lib/key-dispatcher";
import type { KeyContext, KeySituation } from "../src/shared/key-table";

const press = (over: Partial<KeyboardEvent> & { key: string }) => {
  const event = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...over,
  };
  return event as unknown as KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
  };
};

const at = (context: KeyContext, mac = true): KeySituation => ({
  mac,
  context,
  typing: context === "terminal" || context === "field",
});

describe("keyContextOf", () => {
  const place = { operator: false, terminal: false, typing: false, working: false };

  it("puts an open operator modal above everything", () => {
    expect(keyContextOf({ operator: true, terminal: true, typing: true, working: true })).toBe("operator");
  });

  it("names a terminal before any other field, wherever it is open", () => {
    expect(keyContextOf({ ...place, terminal: true, typing: true })).toBe("terminal");
    expect(keyContextOf({ ...place, terminal: true, typing: true, working: true })).toBe("terminal");
  });

  it("names a field the operator types in", () => {
    expect(keyContextOf({ ...place, typing: true })).toBe("field");
    expect(keyContextOf({ ...place, typing: true, working: true })).toBe("field");
  });

  it("is the working modal when one is open and nothing is typed, else the canvas", () => {
    expect(keyContextOf({ ...place, working: true })).toBe("working");
    expect(keyContextOf(place)).toBe("canvas");
  });
});

describe("dispatchKey", () => {
  it("runs the shortcut and keeps the key from a terminal", () => {
    const next = vi.fn();
    const event = press({ key: "]", metaKey: true });
    expect(dispatchKey(event, { "mirrors.next": next }, at("terminal"))).toBe("mirrors.next");
    expect(next).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("lets the key through when the action had nothing to do", () => {
    const event = press({ key: "[", metaKey: true });
    expect(dispatchKey(event, { "mirrors.previous": () => false }, at("terminal"))).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("hands the digit to the action", () => {
    const assign = vi.fn();
    dispatchKey(press({ key: "4", code: "Digit4", metaKey: true }), { "groups.assign": assign }, at("canvas"));
    expect(assign.mock.calls[0]?.[0]).toEqual({ id: "groups.assign", digit: 4 });
  });

  it("never touches a key the table does not name", () => {
    const actions: KeyActions = {
      "search.open": vi.fn(),
      "mirrors.next": vi.fn(),
      "groups.recall": vi.fn(),
      "alerts.next": vi.fn(),
    };
    const shellKeys = [
      press({ key: "c", ctrlKey: true }),
      press({ key: "k", ctrlKey: true }),
      press({ key: "Tab", ctrlKey: true }),
      press({ key: "r", ctrlKey: true }),
      press({ key: "1", code: "Digit1" }),
      press({ key: " ", code: "Space" }),
      press({ key: "`", code: "Backquote" }),
      press({ key: "/" }),
      press({ key: "Enter" }),
      press({ key: "Escape" }),
    ];
    for (const event of shellKeys) {
      expect(dispatchKey(event, actions, at("terminal"))).toBeNull();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });

  it("does not act on auto-repeat or while a composition is open", () => {
    const next = vi.fn();
    expect(dispatchKey(press({ key: "]", metaKey: true, repeat: true }), { "mirrors.next": next }, at("canvas"))).toBeNull();
    expect(dispatchKey(press({ key: "]", metaKey: true, isComposing: true }), { "mirrors.next": next }, at("canvas"))).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it("passes a shortcut that has no action", () => {
    const event = press({ key: "k", metaKey: true });
    expect(dispatchKey(event, {}, at("canvas"))).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
