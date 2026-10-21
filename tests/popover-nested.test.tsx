// @vitest-environment jsdom
/**
 * A popover opened from inside another popover is a layer of it: a press in
 * the inner panel keeps both open, and a press in the outer panel closes only
 * the inner one. In the app the signal popover opens from a seat's details
 * popover, and a press in its reply box closed both, so Attach, the pills and
 * Send failed by pointer (product-automation's attachments run on 95c187ec2).
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Popover } from "../src/renderer/components/ui/Popover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Inner({ anchor }: { readonly anchor: HTMLElement }) {
  const [open, setOpen] = useState(true);
  return open ? (
    <Popover anchor={anchor} onClose={() => setOpen(false)} label="Signal" testId="inner">
      <button data-testid="inner-button">Send reply</button>
    </Popover>
  ) : null;
}

function Outer({ anchor }: { readonly anchor: HTMLElement }) {
  const [open, setOpen] = useState(true);
  const [signal, setSignal] = useState<HTMLElement | null>(null);
  return open ? (
    <Popover anchor={anchor} onClose={() => setOpen(false)} label="Seat details" testId="outer">
      <button data-testid="signal-row" ref={setSignal}>signal</button>
      {signal ? <Inner anchor={signal} /> : null}
    </Popover>
  ) : null;
}

let host: HTMLDivElement;
let anchor: HTMLButtonElement;
let root: Root;

const byTestId = (id: string) => document.querySelector(`[data-testid='${id}']`);
const press = (target: Element) =>
  act(() => {
    target.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
  });

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  anchor = document.createElement("button");
  document.body.appendChild(anchor);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Outer anchor={anchor} />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  anchor.remove();
});

describe("a popover opened inside a popover", () => {
  it("keeps both open on a press inside the inner panel", () => {
    expect(byTestId("inner")).not.toBeNull();
    press(byTestId("inner-button")!);
    expect(byTestId("inner")).not.toBeNull();
    expect(byTestId("outer")).not.toBeNull();
  });

  it("closes only the inner one on a press in the outer panel", () => {
    press(byTestId("outer")!);
    expect(byTestId("inner")).toBeNull();
    expect(byTestId("outer")).not.toBeNull();
  });

  it("closes both on a press outside them", () => {
    press(document.body);
    expect(byTestId("inner")).toBeNull();
    expect(byTestId("outer")).toBeNull();
  });
});
