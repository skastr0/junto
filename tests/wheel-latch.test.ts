// @vitest-environment jsdom
/**
 * A wheel gesture that pans the canvas keeps panning it when a card, terminal
 * or wire label scrolls under the still pointer (wheel-latch.ts, Firefox's
 * wheel transaction rules).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WHEEL_TRANSACTION_IGNORE_MOVE_MS,
  WHEEL_TRANSACTION_TIMEOUT_MS,
  copyWheel,
  createWheelLatch,
  installWheelLatch,
} from "../src/window/lib/wheel-latch";

describe("createWheelLatch", () => {
  it("holds nothing before the canvas takes an event", () => {
    expect(createWheelLatch().holds(0)).toBe(false);
  });

  it("holds the gesture until 1500 ms pass with no wheel event", () => {
    const latch = createWheelLatch();
    latch.took(1000);
    expect(latch.holds(1000 + WHEEL_TRANSACTION_TIMEOUT_MS)).toBe(true);
    expect(latch.holds(1001 + WHEEL_TRANSACTION_TIMEOUT_MS)).toBe(false);
  });

  it("ignores pointer moves within 100 ms of the last wheel event, and ends on a later one", () => {
    const latch = createWheelLatch();
    latch.took(1000);
    latch.moved(1000 + WHEEL_TRANSACTION_IGNORE_MOVE_MS);
    expect(latch.holds(1200)).toBe(true);
    latch.moved(1201 + WHEEL_TRANSACTION_IGNORE_MOVE_MS);
    expect(latch.holds(1302)).toBe(false);
  });
});

describe("installWheelLatch", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.innerHTML = "";
  });

  const setup = () => {
    const canvas = document.createElement("div");
    const label = document.createElement("button");
    const elsewhere = document.createElement("div");
    document.body.append(canvas, label, elsewhere);
    const labelTook = vi.fn();
    label.addEventListener("wheel", labelTook);
    let clock = 0;
    const forward = vi.fn();
    const installed = installWheelLatch(
      {
        surface: () => new DOMRect(0, 0, 800, 600),
        ownTarget: (target) => target === canvas,
        forward,
      },
      window,
      () => clock,
    );
    dispose = installed.dispose;
    const wheel = (target: Element, x = 400, y = 300): WheelEvent => {
      const event = new WheelEvent("wheel", { deltaY: 40, clientX: x, clientY: y, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    return { canvas, label, elsewhere, labelTook, forward, latch: installed.latch, wheel, tick: (ms: number) => (clock += ms) };
  };

  it("hands the rest of a canvas gesture to the canvas when a label arrives under the pointer", () => {
    const { label, labelTook, forward, latch, wheel, tick } = setup();
    latch.took(0); // the canvas took the gesture's first event
    tick(16);
    const event = wheel(label);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0]![0]).toBe(event);
    expect(event.defaultPrevented).toBe(true);
    expect(labelTook).not.toHaveBeenCalled();
    // Each forwarded event extends the gesture.
    tick(WHEEL_TRANSACTION_TIMEOUT_MS);
    wheel(label);
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it("leaves a gesture that started on the label to the label", () => {
    const { label, labelTook, forward, wheel } = setup();
    wheel(label);
    expect(forward).not.toHaveBeenCalled();
    expect(labelTook).toHaveBeenCalledTimes(1);
  });

  it("leaves events the canvas receives itself to the canvas's own listener", () => {
    const { canvas, forward, latch, wheel } = setup();
    latch.took(0);
    wheel(canvas);
    expect(forward).not.toHaveBeenCalled();
  });

  it("releases the label once the operator moves the pointer on purpose", () => {
    const { label, labelTook, forward, latch, wheel, tick } = setup();
    latch.took(0);
    tick(WHEEL_TRANSACTION_IGNORE_MOVE_MS + 1);
    window.dispatchEvent(new Event("pointermove"));
    wheel(label);
    expect(forward).not.toHaveBeenCalled();
    expect(labelTook).toHaveBeenCalledTimes(1);
  });

  it("never takes an event outside the canvas's box", () => {
    const { elsewhere, forward, latch, wheel } = setup();
    latch.took(0);
    wheel(elsewhere, 900, 300);
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("copyWheel", () => {
  it("copies the deltas, point and keys, and bubbles", () => {
    const source = new WheelEvent("wheel", { deltaX: 3, deltaY: -7, deltaMode: 1, clientX: 11, clientY: 13, ctrlKey: true });
    const copy = copyWheel(source);
    expect([copy.deltaX, copy.deltaY, copy.deltaMode, copy.clientX, copy.clientY, copy.ctrlKey, copy.bubbles, copy.cancelable]).toEqual([
      3, -7, 1, 11, 13, true, true, true,
    ]);
  });
});
