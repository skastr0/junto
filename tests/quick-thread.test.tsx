// @vitest-environment jsdom
/**
 * Quick thread on the canvas: its key opens a small frame with the keyboard
 * in the seat field; a seat or a region is typed, a region narrows the list
 * and is never a recipient, a seat is chipped and the keyboard moves to the
 * message; Send starts one thread per chosen seat and the frame closes. A
 * seat that got nothing stays, named, with the text, while the frame is
 * open. A close clears the chosen seats; the text is there on the next open.
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
import { closeOperatorModal, operatorModal$ } from "../src/window/lib/operator-modal";
import { openQuickThread, quickThreadSeats, resetQuickThreads, setQuickThreadSeats } from "../src/window/lib/quick-thread";
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
/** How main says a seat's mail went, when not delivered. */
let delivery: Record<string, "waiting_for_seat" | "failed">;

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
/** The narrow key: Cmd+Enter or Ctrl+Enter, whichever is this platform's. */
const narrowKey = async (element: Element | null) => {
  await key(element, "Enter", { metaKey: true });
  await key(element, "Enter", { ctrlKey: true });
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
  delivery = {};
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
        ? { ok: true, messageId: `m-${input.nodeId}`, threadId: `t-${input.nodeId}`, delivery: delivery[input.nodeId] ?? "delivered" }
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

  it("narrows to a region's seats on the narrow key, and adds nobody", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "design sys");
    expect(all("quick-thread-option")[0]?.getAttribute("data-kind")).toBe("region");
    // Heard for what it is, so narrowing does not surprise.
    expect(all("quick-thread-option")[0]?.textContent).toBe("Design System, region, 2 seats");
    await narrowKey(seatField());
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
    expect(spoken()).toBe("Every seat, not only Design System");
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
    expect(document.getElementById(seatField()!.getAttribute("aria-describedby")!)?.textContent).toBe(
      "1 seat chosen. Shift+Enter adds another",
    );
    // The caps beside the field are for the eye only.
    expect(document.querySelector(".quick-thread__hint")?.getAttribute("aria-hidden")).toBe("true");
    // A list to choose from, with no inline completion promised.
    expect(seatField()!.getAttribute("aria-autocomplete")).toBe("list");

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

    // With a seat chosen it is said the same, once.
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter", { shiftKey: true });
    await typeIn(seatField()!, "zzzz");
    await key(seatField(), "Enter");
    expect(spoken()).toBe("No seat matches zzzz");
    expect(chosenNames()).toEqual(["s-pty"]);
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

  it("keeps the words for the next open and clears the chosen seats on close", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter");
    await typeIn(messageField(), "half a thought");
    await key(messageField(), "Escape");
    expect(operatorModal$.open.peek()).toBeNull();
    expect(quickThreadSeats(CANVAS)).toEqual([]);

    await open();
    expect(chosenNames()).toEqual([]);
    expect(messageField().value).toBe("half a thought");
  });

  it("a canvas switch with it open clears the canvas it opened on, not the new one", async () => {
    await mountHost();
    setQuickThreadSeats("other", ["s-cli"]);
    state$.selectedNodeIds.set(["s-pty"]);
    await open();
    expect(quickThreadSeats(CANVAS)).toEqual(["s-pty"]);
    // The switch makes the new canvas current first, then closes the frame.
    await act(async () => {
      state$.canvasName.set("other");
      closeOperatorModal("quick-thread");
    });
    expect(quickThreadSeats(CANVAS)).toEqual([]);
    expect(quickThreadSeats("other")).toEqual(["s-cli"]);
  });

  it("starts with the seats selected on the canvas, every open", async () => {
    await mountHost();
    state$.selectedNodeIds.set(["s-cli", "r-design", "s-type"]);
    await open();
    expect(chosenNames()).toEqual(["s-cli", "s-type"]);
    expect(document.activeElement).toBe(messageField());
    await key(messageField(), "Escape");

    state$.selectedNodeIds.set(["s-pty"]);
    await open();
    expect(chosenNames()).toEqual(["s-pty"]);
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

  it("holds the row still while a send is on its way", async () => {
    await mountHost();
    state$.selectedNodeIds.set(["s-pty", "s-cli"]);
    await open();
    let land: (() => void) | undefined;
    const api = (window as unknown as { junto: { seatThreadSend: (input: Sent) => Promise<unknown> } }).junto;
    const send = api.seatThreadSend;
    api.seatThreadSend = async (input) => {
      await new Promise<void>((resolve) => (land = resolve));
      return send(input);
    };
    await typeIn(messageField(), "status?");
    await press(sendButton());
    expect(sendButton().textContent).toBe("Sending");
    const row = document.querySelector(".quick-thread__to") as HTMLElement;
    expect(row.hasAttribute("inert")).toBe(true);
    // A press that gets through anyway changes nothing.
    act(() => (all("quick-thread-seat")[0]?.querySelector("button") as HTMLElement).click());
    await flush();
    expect(chosenNames()).toEqual(["s-pty", "s-cli"]);
    api.seatThreadSend = send;
    act(() => land?.());
    await flush();
  });

  it("takes several seats off in a row by keyboard: the next seat's control takes the keyboard", async () => {
    await mountHost();
    state$.selectedNodeIds.set(["s-design", "s-pty", "s-cli"]);
    await open();
    const removeOf = (seatId: string) =>
      all("quick-thread-seat").find((entry) => entry.getAttribute("data-seat") === seatId)?.querySelector("button") as HTMLElement;
    const pressKey = async (button: HTMLElement) => {
      act(() => {
        button.focus();
        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        button.click();
      });
      await flush();
    };
    await pressKey(removeOf("s-pty"));
    expect(chosenNames()).toEqual(["s-design", "s-cli"]);
    expect(document.activeElement).toBe(removeOf("s-cli"));
    // No seat after it: the one before.
    await pressKey(removeOf("s-cli"));
    expect(document.activeElement).toBe(removeOf("s-design"));
    // The last one off: the seat field.
    await pressKey(removeOf("s-design"));
    expect(chosenNames()).toEqual([]);
    expect(document.activeElement).toBe(seatField());
  });

  it("Escape from a control beside the brought-back seat field returns to the message too", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter");
    await press(q("quick-thread-add"));
    await typeIn(seatField()!, "design sys");
    await narrowKey(seatField());
    const showAll = q("quick-thread-narrowed")?.querySelector("button") as HTMLElement;
    act(() => showAll.focus());
    await key(showAll, "Escape");
    expect(operatorModal$.open.peek()).toBe("quick-thread");
    expect(q("quick-thread-picker")).toBeNull();
    expect(document.activeElement).toBe(messageField());
  });
});

describe("a send that leaves a seat waiting", () => {
  const sentSeats = () => all("quick-thread-sent-seat").map((entry) => `${entry.getAttribute("data-seat")}:${entry.getAttribute("data-arrival")}`);

  it("turns into a receipt that names the seat, and closes on Done", async () => {
    await mountHost();
    state$.selectedNodeIds.set(["s-design", "s-pty", "s-cli"]);
    await open();
    delivery["s-pty"] = "waiting_for_seat";
    await typeIn(messageField(), "status?");
    const region = q("quick-thread-spoken");
    await press(sendButton());
    // The live region is the one that was there with the input: a region that arrives with its text is not said.
    expect(q("quick-thread-spoken")).toBe(region);
    // Done is read with the result it closes.
    expect(
      q("quick-thread-done")!
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" "),
    ).toBe("Sent to 3 seats Waiting for pty-lead. It arrives when the seat is back.");
    expect(all("quick-thread-sent-seat").map((entry) => entry.textContent)).toEqual([
      "@product-design, Seat, has it",
      "@pty-lead, Seat, waiting",
      "@cli-lead, Seat, has it",
    ]);
    // Sent to all three, once; it does not close without a word, and the input is gone so nothing sends twice.
    expect(sends.length).toBe(3);
    expect(operatorModal$.open.peek()).toBe("quick-thread");
    expect(q("thread-composer")).toBeNull();
    expect(q("quick-thread-receipt")?.querySelector(".quick-thread__sent")?.textContent).toBe("Sent to 3 seats");
    expect(sentSeats()).toEqual(["s-design:arrived", "s-pty:waiting", "s-cli:arrived"]);
    expect(q("quick-thread-waiting-line")?.textContent).toBe("Waiting for pty-lead. It arrives when the seat is back.");
    expect(spoken()).toBe("Sent to 3 seats. Waiting for pty-lead. It arrives when the seat is back.");
    expect(document.activeElement).toBe(q("quick-thread-done"));
    // Nothing is kept to send again.
    expect(quickThreadSeats(CANVAS)).toEqual([]);

    await press(q("quick-thread-done"));
    expect(operatorModal$.open.peek()).toBeNull();
    expect(sends.length).toBe(3);
  });

  it("counts the seats when more than one waits, a failed hand-over included, and Escape closes", async () => {
    await mountHost();
    state$.selectedNodeIds.set(["s-pty", "s-cli"]);
    await open();
    delivery["s-pty"] = "waiting_for_seat";
    delivery["s-cli"] = "failed";
    await typeIn(messageField(), "status?");
    await press(sendButton());
    expect(q("quick-thread-waiting-line")?.textContent).toBe("Waiting for 2 seats. Each gets it when it is back.");
    await key(q("quick-thread-done"), "Escape");
    expect(operatorModal$.open.peek()).toBeNull();

    // The next open starts clean.
    state$.selectedNodeIds.set([]);
    await open();
    expect(q("quick-thread-receipt")).toBeNull();
    expect(chosenNames()).toEqual([]);
    expect(messageField().value).toBe("");
  });

  it("keeps a waiting seat in sight while the seat that got nothing is sent again, and never sends to it twice", async () => {
    await mountHost();
    state$.selectedNodeIds.set(["s-pty", "s-cli"]);
    await open();
    delivery["s-pty"] = "waiting_for_seat";
    refused["s-cli"] = "cli-lead could not be written to.";
    await typeIn(messageField(), "status?");
    await press(sendButton());
    expect(chosenNames()).toEqual(["s-cli"]);
    expect(all("quick-thread-waiting").map((entry) => entry.getAttribute("data-seat"))).toEqual(["s-pty"]);
    expect(messageField().value).toBe("status?");

    expect(spoken()).toBe("Not sent to 1 seat. Waiting for pty-lead. It arrives when the seat is back.");

    refused = {};
    sends.length = 0;
    await press(sendButton());
    expect(sends.map((send) => send.nodeId)).toEqual(["s-cli"]);
    expect(sentSeats()).toEqual(["s-pty:waiting", "s-cli:arrived"]);
    expect(q("quick-thread-receipt")?.querySelector(".quick-thread__sent")?.textContent).toBe("Sent to 2 seats");
  });

  it("closes at once when every seat has it", async () => {
    await mountHost();
    state$.selectedNodeIds.set(["s-pty"]);
    await open();
    await typeIn(messageField(), "status?");
    await press(sendButton());
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
    delivery["s-pty"] = "waiting_for_seat";
    await press(sendButton());
    // No receipt here: the host shows the thread, and is told which seat the mail waits for.
    expect(q("quick-thread-receipt")).toBeNull();
    expect(sent).toEqual([
      [
        { seatId: "s-pty", threadId: "t-s-pty", arrival: "waiting" },
        { seatId: "s-cli", threadId: "t-s-cli", arrival: "arrived" },
      ],
    ]);
    // Sent: it is ready for the next one, the seat field back.
    expect(chosenNames()).toEqual([]);
    expect(messageField().value).toBe("");
    expect(seatField()).not.toBeNull();
  });
});

describe("Broadcast: a region as a recipient", () => {
  const tokens = () => all("quick-thread-region").map((token) => token.textContent);

  it("chooses the region on Enter, as one token with its count, and asks before it sends", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "design sys");
    await key(seatField(), "Enter");
    // One token, not two seats: the region and the seats it holds now.
    expect(chosenNames()).toEqual([]);
    expect(tokens()).toEqual(["Design System2"]);
    expect(spoken()).toBe("Design System, 2 seats added, 1 region chosen");
    expect(document.activeElement).toBe(messageField());
    expect(sendButton().textContent).toBe("Send to 2");

    await typeIn(messageField(), "status?");
    await key(messageField(), "Enter");
    // Nothing has gone: the confirm has the press.
    expect(sends).toEqual([]);
    expect(q("quick-thread-confirm")?.textContent).toContain("Send to 2 seats?");
    expect(q("quick-thread-confirm")?.textContent).toContain("Each gets its own thread.");
    // On the question, not on Send: a key still held from the press that opened it sends nothing.
    expect(document.activeElement).toBe(q("quick-thread-confirm"));
    expect(spoken()).toContain("Send to 2 seats? Each gets its own thread.");

    await press(q("quick-thread-confirm-send"));
    expect(sends.map((entry) => entry.nodeId).sort()).toEqual(["s-design", "s-type"]);
    // Both have it: it closes.
    expect(operatorModal$.open.peek()).toBeNull();
    expect(quickThreadSeats(CANVAS)).toEqual([]);
  });

  it("Cancel and Escape on the confirm give the draft back as it was", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "design sys");
    await key(seatField(), "Enter");
    await typeIn(messageField(), "status?");
    await key(messageField(), "Enter");
    await press(q("quick-thread-confirm-cancel"));
    expect(q("quick-thread-confirm")).toBeNull();
    expect(tokens()).toEqual(["Design System2"]);
    expect(messageField()?.value).toBe("status?");
    expect(sends).toEqual([]);

    await key(messageField(), "Enter");
    expect(q("quick-thread-confirm")).not.toBeNull();
    await key(q("quick-thread-confirm"), "Escape");
    expect(q("quick-thread-confirm")).toBeNull();
    expect(operatorModal$.open.peek()).toBe("quick-thread");
  });

  it("a seat picked one by one never asks", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "ptyl");
    await key(seatField(), "Enter");
    await typeIn(messageField(), "status?");
    await key(messageField(), "Enter");
    expect(q("quick-thread-confirm")).toBeNull();
    expect(sends.map((entry) => entry.nodeId)).toEqual(["s-pty"]);
  });

  it("offers the region with a typed limit, ranked first, and the limits on the token", async () => {
    await mountHost();
    await open();
    await typeIn(seatField()!, "design sys working");
    const first = all("quick-thread-option")[0]!;
    expect(first.getAttribute("data-kind")).toBe("region");
    expect(first.textContent).toContain("Design System, working");
    await key(seatField(), "Enter");
    // The seats have no reading in this test, so a doing limit holds none of them: they are left out, not sent to.
    expect(tokens()).toEqual(["Design System, working0"]);
    expect(sendButton().disabled).toBe(true);
  });

  it("a failed seat is named in the receipt and Send again goes to it alone", async () => {
    refused["s-type"] = "That seat is not reachable.";
    await mountHost();
    await open();
    await typeIn(seatField()!, "design sys");
    await key(seatField(), "Enter");
    await typeIn(messageField(), "status?");
    await key(messageField(), "Enter");
    await press(q("quick-thread-confirm-send"));
    expect(q("quick-thread-not-sent")?.textContent).toContain("1 not sent");
    expect(q("quick-thread-have")?.textContent).toContain("1 have it");
    expect(q("quick-thread-later")).toBeNull();
    // Open for a few seats, with its names.
    expect(q("quick-thread-not-sent")?.textContent).toContain("product-typography");
    // Why, under the line, as the seat-by-seat flow says it.
    expect(q("quick-thread-not-sent-reasons")?.textContent).toBe("Not sent to @product-typography. That seat is not reachable.");

    delete refused["s-type"];
    sends = [];
    await press(q("quick-thread-send-again"));
    expect(sends.map((entry) => entry.nodeId)).toEqual(["s-type"]);
    // Everyone has it now: it closes.
    expect(operatorModal$.open.peek()).toBeNull();
  });
});
