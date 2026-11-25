// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ThreadsButton } = await import("../src/window/components/feed/ThreadsButton");
const { closeOperatorModal, operatorModal$ } = await import("../src/window/lib/operator-modal");
const { resetOperatorThreads, setOperatorThreadsSource } = await import("../src/window/lib/operator-threads");
const { state$ } = await import("../src/window/lib/state");

let root: Root;
let host: HTMLDivElement;

const button = () => document.querySelector<HTMLButtonElement>('[data-testid="threads-trigger"]')!;
const pill = () => button().querySelector(".operator-feed-trigger__count");

/** A source whose list of every thread holds this many unread. */
const withUnread = (unread: number) =>
  setOperatorThreadsSource({
    list: async () => ({ rows: [], total: unread, unread, regions: [], seatCounts: [], generation: 1 }),
    watch: async () => ({ watchId: "w" }),
    unwatch: async () => {},
    onChanged: () => () => {},
  });
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

beforeEach(() => {
  resetOperatorThreads();
  setOperatorThreadsSource(undefined);
  state$.canvasName.set("c");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => closeOperatorModal());
  act(() => root.unmount());
  host.remove();
  state$.canvasName.set("");
});

describe("the threads button", () => {
  it("opens Global threads and reads pressed while it is open", async () => {
    await act(async () => root.render(<ThreadsButton />));
    expect(button().getAttribute("aria-expanded")).toBe("false");
    await act(async () => button().click());
    expect(operatorModal$.open.peek()).toBe("threads");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    await act(async () => button().click());
    expect(operatorModal$.open.peek()).toBeNull();
  });

  it("says its key from the key table, and nothing unread as words with no pill", async () => {
    await act(async () => root.render(<ThreadsButton />));
    expect(button().getAttribute("aria-label")).toBe("Threads, nothing unread");
    expect(button().getAttribute("title")).toMatch(/^Threads \((⌘U|Ctrl\+U)\)$/);
    expect(button().getAttribute("aria-keyshortcuts")).toBeTruthy();
    expect(pill()).toBeNull();
  });

  it("shows the unread over the whole canvas in an amber pill, never the blocked one, and 99+ past 99", async () => {
    withUnread(3);
    await act(async () => root.render(<ThreadsButton />));
    await settle();
    expect(pill()?.textContent).toBe("3");
    expect(pill()?.className).toBe("operator-feed-trigger__count");
    expect(button().getAttribute("aria-label")).toBe("Threads, 3 unread");
    // The icon stays steel with unread or not: amber on an icon is Needs you's.
    expect(button().style.color).toBe("var(--color-steel)");
    act(() => root.unmount());
    root = createRoot(host);
    resetOperatorThreads();
    withUnread(120);
    await act(async () => root.render(<ThreadsButton />));
    await settle();
    expect(pill()?.textContent).toBe("99+");
  });
});
