// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { QuickCaptureButton } = await import("../src/renderer/components/QuickCaptureButton");
const { closeOperatorModal, operatorModal$ } = await import("../src/renderer/lib/operator-modal");
const { keyAria, keyCaps } = await import("../src/renderer/lib/key-match");
const { isMac } = await import("../src/renderer/lib/platform");

let root: Root;
let host: HTMLDivElement;

const button = (): HTMLButtonElement => {
  const found = document.querySelector<HTMLButtonElement>('[data-testid="quick-capture-trigger"]');
  if (found === null) throw new Error("no quick capture button");
  return found;
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => closeOperatorModal());
  act(() => root.unmount());
  host.remove();
});

describe("the quick capture button", () => {
  it("is named, and its title and aria-keyshortcuts carry the capture.open key from the key table", async () => {
    await act(async () => root.render(<QuickCaptureButton />));
    const caps = keyCaps("capture.open");
    expect(caps).toBeDefined();
    expect(button().getAttribute("aria-label")).toBe("Quick capture");
    expect(button().title).toBe(`Quick capture (${caps!.join(isMac() ? "" : "+")})`);
    expect(button().getAttribute("aria-keyshortcuts")).toBe(keyAria("capture.open"));
    expect(button().getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("opens the capture surface Cmd+T opens, and closes it when it is open", async () => {
    await act(async () => root.render(<QuickCaptureButton />));
    expect(button().getAttribute("aria-expanded")).toBe("false");
    await act(async () => button().click());
    expect(operatorModal$.open.peek()).toBe("capture");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    await act(async () => button().click());
    expect(operatorModal$.open.peek()).toBeNull();
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });
});
