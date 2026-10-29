// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { NeedsYouButton } = await import("../src/renderer/components/feed/NeedsYouButton");
const { closeOperatorModal, operatorModal$ } = await import("../src/renderer/lib/operator-modal");
const { focusSwitcher$ } = await import("../src/renderer/lib/focus-switcher");

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => closeOperatorModal());
  act(() => focusSwitcher$.session.set(null));
  act(() => root.unmount());
  host.remove();
});

describe("the needs-you button", () => {
  it("opens the feed Cmd+I opens", async () => {
    await act(async () => root.render(<NeedsYouButton />));
    const button = document.querySelector<HTMLButtonElement>('[data-testid="operator-feed-trigger"]')!;
    await act(async () => button.click());
    expect(operatorModal$.open.peek()).toBe("feed");
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes a focus switcher held open under the press, as Cmd+I does", async () => {
    await act(async () => root.render(<NeedsYouButton />));
    focusSwitcher$.session.set({ entries: [], selectedIndex: 0 });
    const button = document.querySelector<HTMLButtonElement>('[data-testid="operator-feed-trigger"]')!;
    await act(async () => button.click());
    expect(focusSwitcher$.session.peek()).toBeNull();
    expect(operatorModal$.open.peek()).toBe("feed");
  });
});
