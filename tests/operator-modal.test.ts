import { afterEach, describe, expect, it } from "vitest";
import { OPERATOR_TYPING_SELECTOR } from "../src/renderer/lib/focus-ownership";
import {
  closeOperatorModal,
  isOperatorModalOpen,
  openOperatorModal,
  operatorModal$,
  operatorModalForKey,
  TERMINAL_SELECTOR,
  toggleOperatorModal,
  type OperatorChordContext,
  type OperatorChordKey,
} from "../src/renderer/lib/operator-modal";

const key = (over: Partial<OperatorChordKey> & { key: string }): OperatorChordKey => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...over,
});

const CANVAS: Omit<OperatorChordContext, "mac"> = { typing: false, terminal: false };
const FIELD: Omit<OperatorChordContext, "mac"> = { typing: true, terminal: false };
const TERMINAL: Omit<OperatorChordContext, "mac"> = { typing: true, terminal: true };

describe("operator modal chords on macOS", () => {
  const mac = (where: Omit<OperatorChordContext, "mac">): OperatorChordContext => ({ mac: true, ...where });

  it("opens search and the feed with Cmd from the canvas, a field and a terminal", () => {
    for (const where of [CANVAS, FIELD, TERMINAL]) {
      expect(operatorModalForKey(key({ key: "k", metaKey: true }), mac(where))).toBe("search");
      expect(operatorModalForKey(key({ key: "i", metaKey: true }), mac(where))).toBe("feed");
    }
  });

  it("never takes a Ctrl chord: it belongs to the shell and to the field", () => {
    for (const where of [CANVAS, FIELD, TERMINAL]) {
      expect(operatorModalForKey(key({ key: "k", ctrlKey: true }), mac(where))).toBeNull();
      expect(operatorModalForKey(key({ key: "i", ctrlKey: true }), mac(where))).toBeNull();
    }
  });

  it("wants exactly one modifier", () => {
    expect(operatorModalForKey(key({ key: "K", metaKey: true, shiftKey: true }), mac(CANVAS))).toBeNull();
    expect(operatorModalForKey(key({ key: "i", metaKey: true, altKey: true }), mac(CANVAS))).toBeNull();
    expect(operatorModalForKey(key({ key: "k", metaKey: true, ctrlKey: true }), mac(CANVAS))).toBeNull();
  });

  it("ignores a held chord", () => {
    expect(operatorModalForKey(key({ key: "k", metaKey: true, repeat: true }), mac(CANVAS))).toBeNull();
  });
});

describe("operator modal chords without a Cmd key", () => {
  const other = (where: Omit<OperatorChordContext, "mac">): OperatorChordContext => ({ mac: false, ...where });

  it("opens with Ctrl from the canvas and from a field", () => {
    for (const where of [CANVAS, FIELD]) {
      expect(operatorModalForKey(key({ key: "k", ctrlKey: true }), other(where))).toBe("search");
      expect(operatorModalForKey(key({ key: "i", ctrlKey: true }), other(where))).toBe("feed");
    }
  });

  it("leaves every Ctrl chord to the shell inside a terminal", () => {
    expect(operatorModalForKey(key({ key: "k", ctrlKey: true }), other(TERMINAL))).toBeNull();
    expect(operatorModalForKey(key({ key: "i", ctrlKey: true }), other(TERMINAL))).toBeNull();
  });

  it("does not take the Super key", () => {
    expect(operatorModalForKey(key({ key: "k", metaKey: true }), other(CANVAS))).toBeNull();
  });
});

describe("bare slash", () => {
  it("opens search only while the operator is not typing", () => {
    expect(operatorModalForKey(key({ key: "/" }), { mac: true, ...CANVAS })).toBe("search");
    expect(operatorModalForKey(key({ key: "/" }), { mac: true, ...FIELD })).toBeNull();
    expect(operatorModalForKey(key({ key: "/" }), { mac: false, ...TERMINAL })).toBeNull();
  });

  it("stays out of the way of composition and of chords", () => {
    expect(operatorModalForKey(key({ key: "/", isComposing: true }), { mac: true, ...CANVAS })).toBeNull();
    expect(operatorModalForKey(key({ key: "/", metaKey: true }), { mac: true, ...CANVAS })).toBeNull();
    expect(operatorModalForKey(key({ key: "/", altKey: true }), { mac: true, ...CANVAS })).toBeNull();
  });

  it("works on layouts where slash needs Shift", () => {
    expect(operatorModalForKey(key({ key: "/", shiftKey: true }), { mac: true, ...CANVAS })).toBe("search");
  });
});

describe("the operator slot", () => {
  afterEach(() => closeOperatorModal());

  it("holds one modal: opening another swaps it", () => {
    openOperatorModal("search");
    expect(isOperatorModalOpen("search")).toBe(true);
    openOperatorModal("feed");
    expect(operatorModal$.open.peek()).toBe("feed");
    expect(isOperatorModalOpen("search")).toBe(false);
  });

  it("closes on a modal's own chord and swaps on the other's", () => {
    toggleOperatorModal("search");
    toggleOperatorModal("feed");
    expect(operatorModal$.open.peek()).toBe("feed");
    toggleOperatorModal("feed");
    expect(isOperatorModalOpen()).toBe(false);
  });

  it("a modal that closes itself after handing over leaves the next one open", () => {
    openOperatorModal("search");
    openOperatorModal("feed");
    closeOperatorModal("search");
    expect(operatorModal$.open.peek()).toBe("feed");
  });
});

describe("terminal selector", () => {
  it("names only surfaces the typing guard already knows", () => {
    const typing = OPERATOR_TYPING_SELECTOR.split(", ");
    for (const selector of TERMINAL_SELECTOR.split(", ")) expect(typing).toContain(selector);
  });
});
