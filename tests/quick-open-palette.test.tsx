// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickOpen } from "../src/renderer/components/quick-open/QuickOpen";
import { itemsQuickOpen, QUICK_OPEN_WORDS, type QuickOpenItem, type QuickOpenSource } from "../src/renderer/lib/quick-open";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let anchor: HTMLButtonElement;
let root: Root;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  HTMLElement.prototype.scrollIntoView = () => {};
  host = document.createElement("div");
  document.body.appendChild(host);
  // The popover hangs from a real element: its placement reads a rect.
  anchor = document.createElement("button");
  document.body.appendChild(anchor);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  anchor.remove();
});

const items = [
  { id: "a1", title: "Launch brief" },
  { id: "a2", title: "Sprint notes" },
  { id: "a3", title: "Spring board" },
];

const sourceOf = (rows = items): QuickOpenSource =>
  itemsQuickOpen({
    kind: "artifact",
    items: rows,
    itemOf: ({ id, title }) => ({ row: { id, title }, match: { identity: [title] } }),
  });

const field = (): HTMLInputElement => {
  const found = document.querySelector<HTMLInputElement>("[data-testid=\"quick-open-input\"]");
  if (found === null) throw new Error("no field");
  return found;
};

const titles = (): ReadonlyArray<string> =>
  [...document.querySelectorAll(".quick-open__row-title")].map((element) => element.textContent ?? "");

const activeTitle = (): string | null =>
  document.querySelector("[data-active=\"true\"] .quick-open__row-title")?.textContent ?? null;

const render = (source: QuickOpenSource, onOpen = vi.fn(), onClose = vi.fn()) => {
  act(() =>
    root.render(<QuickOpen anchor={anchor} source={source} onOpen={onOpen} onClose={onClose} />),
  );
  return { onOpen, onClose };
};

const type = (value: string): void => {
  act(() => {
    const input = field();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const press = (key: string): void => {
  act(() => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

describe("the quick open palette", () => {
  it("holds the keyboard in its field and opens on the whole list, the top row active", () => {
    render(sourceOf());
    expect(document.activeElement).toBe(field());
    expect(titles()).toEqual(["Launch brief", "Sprint notes", "Spring board"]);
    expect(activeTitle()).toBe("Launch brief");
  });

  it("asks the source per keystroke and moves the highlight with the arrows", () => {
    render(sourceOf());
    type("s");
    expect(titles()).toEqual(["Sprint notes", "Spring board"]);
    expect(activeTitle()).toBe("Sprint notes");
    press("ArrowDown");
    expect(activeTitle()).toBe("Spring board");
    press("ArrowDown");
    // Clamped at the last row, never wrapped.
    expect(activeTitle()).toBe("Spring board");
    press("ArrowUp");
    expect(activeTitle()).toBe("Sprint notes");
  });

  it("opens the top match on Enter without moving the highlight", () => {
    const held = render(sourceOf());
    type("launch");
    press("Enter");
    expect(held.onOpen).toHaveBeenCalledWith({ id: "a1", title: "Launch brief", kind: "artifact" });
  });

  it("opens the row the arrows reached", () => {
    const held = render(sourceOf());
    type("s");
    press("ArrowDown");
    press("Enter");
    expect(held.onOpen).toHaveBeenCalledWith({ id: "a3", title: "Spring board", kind: "artifact" });
  });

  it("closes on Escape without opening anything", () => {
    const held = render(sourceOf());
    type("zzz");
    press("Escape");
    expect(held.onClose).toHaveBeenCalledTimes(1);
    expect(held.onOpen).not.toHaveBeenCalled();
  });

  it("says nothing matched in the source's own words", () => {
    render(sourceOf());
    type("zzz");
    expect(titles()).toEqual([]);
    expect(document.querySelector(".quick-open__empty")?.textContent).toBe(QUICK_OPEN_WORDS.artifact.empty);
  });

  it("never paints an answer the query has moved past", async () => {
    const asked: Array<{ query: string; resolve: (rows: readonly QuickOpenItem[]) => void }> = [];
    const source: QuickOpenSource = {
      kind: "artifact",
      ...QUICK_OPEN_WORDS.artifact,
      search: (query) =>
        new Promise((resolve) => {
          asked.push({ query, resolve });
        }),
    };
    render(source);
    const row = (id: string, title: string): QuickOpenItem => ({ id, title, kind: "artifact" });
    await act(async () => {
      asked.find((entry) => entry.query === "")?.resolve([]);
    });
    type("a");
    type("ab");
    await act(async () => {
      asked.find((entry) => entry.query === "ab")?.resolve([row("ab", "About")]);
    });
    expect(titles()).toEqual(["About"]);
    // The older answer lands late: it belongs to a question already past.
    await act(async () => {
      asked.find((entry) => entry.query === "a")?.resolve([row("a", "Archive")]);
    });
    expect(titles()).toEqual(["About"]);
  });
});
