import { describe, expect, it, vi } from "vitest";
import { OPERATOR_TYPING_SELECTOR } from "../src/renderer/lib/focus-ownership";
import { focusSwitcher$ } from "../src/renderer/lib/focus-switcher";
import {
  TERMINAL_SELECTOR,
  dispatchKey,
  dispatchRelease,
  holdKeyDispatch,
  installKeyDispatcher,
  keyContextOf,
  type KeyActions,
} from "../src/renderer/lib/key-dispatcher";
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
  const place = { switcher: false, dialog: false, operator: false, terminal: false, typing: false, working: false };

  it("puts the open switcher above everything", () => {
    expect(
      keyContextOf({ switcher: true, dialog: true, operator: true, terminal: true, typing: true, working: true }),
    ).toBe("switcher");
  });

  it("puts a dialog above whatever it was opened over, a field inside it included", () => {
    expect(keyContextOf({ ...place, dialog: true, operator: true, working: true })).toBe("dialog");
    expect(keyContextOf({ ...place, dialog: true, typing: true, working: true })).toBe("dialog");
  });

  it("puts an open operator modal above the rest", () => {
    expect(keyContextOf({ ...place, operator: true, terminal: true, typing: true, working: true })).toBe("operator");
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

  it("takes a held chord without acting again, so it reaches neither the terminal nor the menu bar", () => {
    const close = vi.fn();
    const event = press({ key: "w", metaKey: true, repeat: true });
    expect(dispatchKey(event, { "front.close": close }, at("terminal"))).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("steps again on every repeat of the switcher keys", () => {
    const next = vi.fn();
    const event = press({ key: "`", code: "Backquote", metaKey: true, repeat: true });
    expect(dispatchKey(event, { "urgency.next": next }, at("terminal"))).toBe("urgency.next");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not act while a composition is open", () => {
    const next = vi.fn();
    expect(dispatchKey(press({ key: "]", metaKey: true, isComposing: true }), { "mirrors.next": next }, at("canvas"))).toBeNull();
    expect(next).not.toHaveBeenCalled();
  });

  it("answers the chord the operator chose in place of the default", () => {
    const feed = vi.fn();
    const overrides = { "feed.open": ["Cmd+J"] };
    expect(dispatchKey(press({ key: "j", metaKey: true }), { "feed.open": feed }, at("terminal"), overrides)).toBe(
      "feed.open",
    );
    expect(dispatchKey(press({ key: "i", metaKey: true }), { "feed.open": feed }, at("terminal"), overrides)).toBeNull();
    expect(feed).toHaveBeenCalledTimes(1);
  });

  it("passes a shortcut that has no action", () => {
    const event = press({ key: "k", metaKey: true });
    expect(dispatchKey(event, {}, at("canvas"))).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("what the menu bar gives up", () => {
  const withMenu = (run: (calls: string[]) => void): void => {
    const calls: string[] = [];
    const listeners: Record<string, unknown> = {};
    (globalThis as { window?: unknown }).window = {
      junto: { yieldMenuKeys: (yielding: string) => calls.push(yielding) },
      addEventListener: (type: string, listener: unknown) => (listeners[type] = listener),
      removeEventListener: () => undefined,
    };
    try {
      run(calls);
    } finally {
      focusSwitcher$.session.set(null);
      delete (globalThis as { window?: unknown }).window;
    }
  };

  it("gives up every chord for as long as anything records, and takes them back once", () => {
    withMenu((calls) => {
      const first = holdKeyDispatch();
      const second = holdKeyDispatch();
      expect(calls).toEqual(["all"]);
      first();
      first();
      expect(calls).toEqual(["all"]);
      second();
      expect(calls).toEqual(["all", "none"]);
    });
  });

  it("gives up Cmd+H while the switcher is up, so h moves the selection and does not hide the app", () => {
    withMenu((calls) => {
      const uninstall = installKeyDispatcher({});
      focusSwitcher$.session.set({ entries: [], selectedIndex: 0 });
      expect(calls).toEqual(["switcher"]);
      focusSwitcher$.session.set(null);
      expect(calls).toEqual(["switcher", "none"]);
      uninstall();
    });
  });
});

describe("dispatchRelease", () => {
  it("opens the chosen agent when Cmd is let go with the switcher up", () => {
    const commit = vi.fn();
    expect(dispatchRelease(press({ key: "Meta" }), { "switcher.commit": commit }, at("switcher"))).toBe(
      "switcher.commit",
    );
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("does nothing for any other key, or with the switcher down", () => {
    const commit = vi.fn();
    expect(dispatchRelease(press({ key: "`", metaKey: true }), { "switcher.commit": commit }, at("switcher"))).toBeNull();
    expect(dispatchRelease(press({ key: "Meta" }), { "switcher.commit": commit }, at("terminal"))).toBeNull();
    expect(dispatchRelease(press({ key: "Shift" }), { "switcher.commit": commit }, at("switcher"))).toBeNull();
    // The other Cmd key is still down.
    expect(dispatchRelease(press({ key: "Meta", metaKey: true }), { "switcher.commit": commit }, at("switcher"))).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("terminal selector", () => {
  it("names only surfaces the typing guard already knows", () => {
    const typing = OPERATOR_TYPING_SELECTOR.split(", ");
    for (const selector of TERMINAL_SELECTOR.split(", ")) expect(typing).toContain(selector);
  });
});
