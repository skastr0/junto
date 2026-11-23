// @vitest-environment jsdom
/**
 * Quick thread on the canvas: its key opens a small frame with the keyboard
 * in the seat field; a seat or a region is typed, a region narrows the list
 * and is never a recipient, a seat is chipped and the keyboard moves to the
 * message; Send starts one thread per chosen seat and the frame closes. A
 * seat that got nothing stays, named, with the text. What was not sent is
 * there on the next open.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { OperatorModalHost } from "../src/window/components/operator-modal/OperatorModalHost";
import { QuickThread, type QuickThreadSent } from "../src/window/components/quick-thread/QuickThread";
import { resetOperatorGesture } from "../src/window/lib/focus-ownership";
import { KEY_ACTIONS } from "../src/window/lib/key-actions";
import { installKeyDispatcher } from "../src/window/lib/key-dispatcher";
import { operatorModal$ } from "../src/window/lib/operator-modal";
import { openQuickThread, quickThreadSeats, resetQuickThreads } from "../src/window/lib/quick-thread";
import { resetSeatThreads } from "../src/window/lib/seat-threads";
import { state$ } from "../src/window/lib/state";
import { modelStore } from "../src/window/lib/use-model";
import { region, seat } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

const CANVAS = "quick-thread";
const at = (x: number, y: number) => ({ x, y, width: 100, height: 60 });
const NODES = [
  region("r-design", { x: 0, y: 0, width: 500, height: 300 }, { label: "Design System" }),
  seat("s-design", { ...at(20, 20), label: "product-design" }),
  seat("s-type", { ...at(200, 20), label: "product-typography" }),
  seat("s-pty", { ...at(2000, 20), label: "pty-lead", host: "mac-mini" as never }),
  seat("s-cli", { ...at(3000, 20), label: "cli-lead" }),
];

type Sent = { readonly nodeId: string; readonly text: string };

let host: HTMLDivElement;
let root: Root;
let release: (() => void) | undefined;
let sends: Sent[];
let refused: Record<string, string>;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
const all = (testId: string) => [...document.querySelectorAll(`[data-testid="${testId}"]`)];
const seatField = () => document.querySelector('input[role="combobox"]') as HTMLInputElement | null;
const messageField = () => q("thread-composer-input") as HTMLTextAreaElement;
const sendButton = () => q("thread-composer-send") as HTMLButtonElement;
const optionNames = () => all("quick-thread-option").map((option) => option.querySelector(".quick-thread__option-name")?.textContent);
const chosenNames = () => all("quick-thread-seat").map((entry) => entry.getAttribute("data-seat"));
const spoken = () => q("quick-thread-spoken")?.textContent?.trim();

const typeIn = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.setSelectionRange(value.length, value.length);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};
const key = async (element: Element | null, name: string, init: KeyboardEventInit = {}) => {
  act(() => {
    element!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });
  await flush();
};
/** A press with the pointer, as the app hears one. */
const press = async (element: Element | null) => {
  act(() => {
    element?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    (element as HTMLElement).focus();
    (element as HTMLElement).click();
  });
  await flush();
};

beforeEach(() => {
  sends = [];
  refused = {};
  resetQuickThreads();
  resetSeatThreads();
  resetOperatorGesture();
  state$.canvasName.set(CANVAS);
  state$.selectedNodeIds.set([]);
  state$.seatVisitOrder.set([]);
  operatorModal$.open.set(null);
  modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: NODES });
  (window as { junto?: unknown }).junto = {
    seatThreadMentionables: async () => [],
    seatThreadSend: async (input: Sent) => {
      sends.push(input);
      const words = refused[input.nodeId];
      return words === undefined
        ? { ok: true, messageId: `m-${input.nodeId}`, threadId: `t-${input.nodeId}`, delivery: "delivered" }
        : { ok: false, reason: "failed", message: words };
    },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  release?.();
  release = undefined;
  act(() => root.unmount());
  host.remove();
  operatorModal$.open.set(null);
  delete (window as { junto?: unknown }).junto;
});

const mountHost = async () => {
  release = installKeyDispatcher(KEY_ACTIONS);
  await act(async () => root.render(<OperatorModalHost />));
  await flush();
};
const open = async () => {
  act(() => void openQuickThread());
  await flush();
};

describe("Quick thread from the canvas", () => {
  it("opens on its key with the keyboard in the seat field", async () => {
    await mountHost();
    expect(q("quick-thread")).toBeNull();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "u", code: "KeyU", metaKey: true, ctrlKey: false, shiftKey: true, bubbles: true, cancelable: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "U", code: "KeyU", metaKey: false, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    await flush();
    // One of the two chords is this platform's; the other is not a key here.
    expect(operatorModal$.open.peek()).toBe("quick-thread");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Quick thread");
    expect(seatField()?.getAttribute("placeholder")).toBe("Seat or region");
    expect(document.activeElement).toBe(seatField());
    // Nobody chosen: nothing to send to.
    expect(sendButton().disabled).toBe(true);
  });

  it("does not open with no canvas", async () => {
    await mountHost();
    state$.canvasName.set("");
    expect(openQuickThread()).toBe(false);
    expect(operatorModal$.open.peek()).toBeNull();
  });

  it("lists every seat, one on another machine like any other, and a region only once something is typed", async () => {
    await mountHost();
    await open();
    expect(optionNames().sort()).toEqual(["cli-lead", "product-design", "product-typography", "pty-lead"]);
    await typeIn(seatField()!, "design");
    expect(all("quick-thread-option").map((option) => option.getAttribute("data-kind"))).toContain("region");
  });

  it("goes seat, message, send without the mouse, then closes", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "ptyl");
    expect(optionNames()).toEqual(["pty-lead"]);
    // The best match is where Enter lands.
    expect(seatField()!.getAttribute("aria-activedescendant")).toBeTruthy();
    await key(seatField(), "Enter");
    expect(chosenNames()).toEqual(["s-pty"]);
    expect(spoken()).toBe("pty-lead added, 1 seat chosen");
    // The picker folds away and the keyboard is in the message.
    expect(q("quick-thread-picker")).toBeNull();
    expect(document.activeElement).toBe(messageField());

    await typeIn(messageField(), "status?");
    expect(sendButton().textContent).toBe("Send");
    await key(messageField(), "Enter");
    expect(sends).toEqual([{ canvasName: CANVAS, nodeId: "s-pty", text: "status?" }]);
    // All sent: the close is the confirmation.
    expect(operatorModal$.open.peek()).toBeNull();
    expect(quickThreadSeats(CANVAS)).toEqual([]);
  });

  it("narrows to a region's seats and never adds the region", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "design sys");
    expect(all("quick-thread-option")[0]?.getAttribute("data-kind")).toBe("region");
    expect(all("quick-thread-option")[0]?.textContent).toContain("2 seats");
    await key(seatField(), "Enter");
    expect(chosenNames()).toEqual([]);
    expect(q("quick-thread-narrowed")?.textContent).toContain("in Design System");
    expect(spoken()).toBe("Design System, 2 seats");
    expect(optionNames().sort()).toEqual(["product-design", "product-typography"]);
    // The keyboard stays in the seat field, emptied for the seat.
    expect(document.activeElement).toBe(seatField());
    expect(seatField()!.value).toBe("");

    // Backspace in the empty field takes the region off, before any seat.
    await key(seatField(), "Backspace");
    expect(q("quick-thread-narrowed")).toBeNull();
    expect(optionNames().length).toBe(4);
  });

  it("adds another with Shift+Enter, marks the chosen, and takes the last off with Backspace", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter", { shiftKey: true });
    expect(chosenNames()).toEqual(["s-pty"]);
    // Still in the seat field, emptied, for the next seat.
    expect(document.activeElement).toBe(seatField());
    expect(seatField()!.value).toBe("");
    expect(document.querySelector('[data-seat="s-pty"][data-kind="seat"]')?.closest('[role="option"]')?.getAttribute("aria-selected")).toBe("true");
    expect(seatField()!.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(seatField()!.getAttribute("aria-describedby")!)?.textContent).toBe("1 seat chosen");

    await typeIn(seatField()!, "cli");
    await key(seatField(), "Enter");
    expect(chosenNames()).toEqual(["s-pty", "s-cli"]);
    expect(sendButton().textContent).toBe("Send to 2");

    // The row: a named list, each seat with a control that takes it off, and one that adds.
    const list = document.querySelector('[role="list"]');
    expect(list?.getAttribute("aria-label")).toBe("Chosen seats");
    expect(all("quick-thread-seat")[0]?.querySelector("button")?.getAttribute("aria-label")).toBe("Take pty-lead off");
    expect(all("quick-thread-seat")[0]?.querySelector('[data-testid="seat-portrait-mark"]')).not.toBeNull();

    await press(q("quick-thread-add"));
    expect(document.activeElement).toBe(seatField());
    await key(seatField(), "Backspace");
    expect(chosenNames()).toEqual(["s-pty"]);
    expect(spoken()).toBe("cli-lead taken off, 1 seat chosen");
  });

  it("takes a chosen seat off when it is picked again", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter", { shiftKey: true });
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter");
    expect(chosenNames()).toEqual([]);
    expect(document.activeElement).toBe(seatField());
  });

  it("says why Enter did nothing", async () => {
    await mountHost();
    await open();
    await key(seatField(), "Enter");
    expect(spoken()).toBe("Pick a seat first");
    await typeIn(seatField()!, "zzzz");
    expect(q("quick-thread-empty")?.textContent).toBe("No seat or region matches");
    await key(seatField(), "Enter");
    expect(spoken()).toBe("No seat matches zzzz");
  });

  it("Escape in the picker brought back to add a seat returns to the message; Escape again closes", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter");
    await press(q("quick-thread-add"));
    expect(q("quick-thread-picker")).not.toBeNull();
    await key(seatField(), "Escape");
    expect(operatorModal$.open.peek()).toBe("quick-thread");
    expect(q("quick-thread-picker")).toBeNull();
    expect(chosenNames()).toEqual(["s-pty"]);
    expect(document.activeElement).toBe(messageField());
    await key(messageField(), "Escape");
    expect(operatorModal$.open.peek()).toBeNull();
  });

  it("Escape closes from the seat field even with a row lit", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "lead");
    await key(seatField(), "ArrowDown");
    await key(seatField(), "Escape");
    expect(operatorModal$.open.peek()).toBeNull();
  });

  it("keeps what was not sent for the next open", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter");
    await typeIn(messageField(), "half a thought");
    await key(messageField(), "Escape");
    expect(operatorModal$.open.peek()).toBeNull();

    await open();
    expect(chosenNames()).toEqual(["s-pty"]);
    expect(messageField().value).toBe("half a thought");
    // Seats already chosen: the keyboard starts in the message.
    expect(document.activeElement).toBe(messageField());
  });

  it("starts with the seats selected on the canvas, unless a draft with seats is waiting", async () => {
    await mountHost();
    state$.selectedNodeIds.set(["s-cli", "r-design", "s-type"]);
    await open();
    expect(chosenNames()).toEqual(["s-cli", "s-type"]);
    expect(document.activeElement).toBe(messageField());
    await key(messageField(), "Escape");

    state$.selectedNodeIds.set(["s-pty"]);
    await open();
    expect(chosenNames()).toEqual(["s-cli", "s-type"]);
  });

  it("keeps a seat that got nothing, with the reason and the text, and sends again to it alone", async () => {
    await mountHost();
    state$.selectedNodeIds.set(["s-pty", "s-cli"]);
    await open();
    refused["s-cli"] = "cli-lead is on a machine that is not connected.";
    await typeIn(messageField(), "status?");
    await press(sendButton());
    expect(sends.map((send) => send.nodeId)).toEqual(["s-pty", "s-cli"]);
    expect(operatorModal$.open.peek()).toBe("quick-thread");
    expect(chosenNames()).toEqual(["s-cli"]);
    expect(q("quick-thread-unsent")?.textContent).toBe("Not sent to @cli-lead. cli-lead is on a machine that is not connected.");
    expect(messageField().value).toBe("status?");
    expect(spoken()).toBe("Not sent to 1 seat");

    refused = {};
    sends.length = 0;
    await press(sendButton());
    expect(sends.map((send) => send.nodeId)).toEqual(["s-cli"]);
    expect(operatorModal$.open.peek()).toBeNull();
  });
});

describe("Quick thread in a pane of its host's", () => {
  it("draws no frame and hands the host every thread it started", async () => {
    const sent: QuickThreadSent[] = [];
    act(() => root.render(<QuickThread canvasName={CANVAS} onSent={(threads) => sent.push(threads)} />));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter", { shiftKey: true });
    await typeIn(seatField()!, "cli");
    await key(seatField(), "Enter");
    await typeIn(messageField(), "status?");
    await press(sendButton());
    expect(sent).toEqual([
      [
        { seatId: "s-pty", threadId: "t-s-pty" },
        { seatId: "s-cli", threadId: "t-s-cli" },
      ],
    ]);
    // Sent: it is ready for the next one, the seat field back.
    expect(chosenNames()).toEqual([]);
    expect(messageField().value).toBe("");
    expect(seatField()).not.toBeNull();
  });
});
