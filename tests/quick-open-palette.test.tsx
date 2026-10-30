// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickOpen } from "../src/renderer/components/quick-open/QuickOpen";
import { itemsQuickOpen, QUICK_OPEN_WORDS, type QuickOpenItem, type QuickOpenSource } from "../src/renderer/lib/quick-open";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The count announces on a settle timer, which fake time advances.
  vi.useFakeTimers();
  HTMLElement.prototype.scrollIntoView = () => {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
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

/** The one live region: what a reader hears, which arrives once the query rests. */
const announced = (): string => document.querySelector("[role='status']")?.textContent ?? "";
const settle = (): void => {
  act(() => {
    vi.advanceTimersByTime(500);
  });
};

const render = (source: QuickOpenSource, onOpen = vi.fn(), onClose = vi.fn()) => {
  act(() => root.render(<QuickOpen source={source} onOpen={onOpen} onClose={onClose} />));
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

const clearButton = (): HTMLButtonElement => {
  const found = document.querySelector<HTMLButtonElement>(".quick-open__clear");
  if (found === null) throw new Error("no clear button");
  return found;
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

  it("says nothing matched once, in the source's own words, and the footer stays quiet", () => {
    render(sourceOf());
    type("zzz");
    expect(titles()).toEqual([]);
    expect(document.querySelector(".quick-open__empty")?.textContent).toBe(QUICK_OPEN_WORDS.artifact.empty);
    // The words are for eyes at once; the one live region says them once the query rests.
    expect(announced()).toBe("");
    settle();
    expect(announced()).toBe(QUICK_OPEN_WORDS.artifact.empty);
    // One live region, not two saying the same thing.
    expect(document.querySelectorAll("[role='status']")).toHaveLength(1);
  });

  it("asks for a word under an empty field with no list to show, and says nothing unasked", () => {
    render({ ...sourceOf(), search: () => [] });
    expect(document.querySelector(".quick-open__empty")?.textContent).toBe(QUICK_OPEN_WORDS.artifact.hint);
    // Opening a palette is not a search: the region stays quiet until one is asked.
    settle();
    expect(announced()).toBe("");
    expect(document.querySelectorAll("[role='status']")).toHaveLength(1);
  });

  it("counts its rows in the footer at once and says the count once the query rests", () => {
    render(sourceOf());
    expect(document.querySelector(".quick-open__count")?.textContent).toBe("3 artifacts");
    expect(document.querySelector(".quick-open__empty")).toBeNull();
    // The opening count is not announced.
    settle();
    expect(announced()).toBe("");
    type("s");
    expect(announced()).toBe("");
    settle();
    // "Sprint notes" and "Spring board" hold an s.
    expect(announced()).toBe("2 artifacts");
  });

  it("says a pending search's count only when its answer arrives", async () => {
    let answer: (rows: QuickOpenItem[]) => void = () => {};
    const asked = sourceOf();
    render({
      ...asked,
      search: () => new Promise<QuickOpenItem[]>((resolve) => {
        answer = resolve;
      }),
    });
    type("s");
    settle();
    expect(announced()).toBe("");
    await act(async () => {
      answer(asked.search("") as QuickOpenItem[]);
    });
    settle();
    expect(announced()).toBe("3 artifacts");
  });

  it("closes on Tab, so no combobox stays armed behind the keyboard", () => {
    const held = render(sourceOf());
    act(() => {
      field().dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(held.onClose).toHaveBeenCalledTimes(1);
  });

  it("clears on the click a keyboard or a screen reader activation dispatches", () => {
    render(sourceOf());
    type("launch");
    expect(titles()).toEqual(["Launch brief"]);

    // Enter and Space on a button, and a screen reader's invoke, all arrive as
    // this click, with no press before it. It must be the clear on its own.
    act(() => {
      clearButton().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    });

    expect(field().value).toBe("");
    expect(titles()).toEqual(["Launch brief", "Sprint notes", "Spring board"]);
    expect(document.activeElement).toBe(field());
  });

  it("keeps Enter and Space on the clear button its own, so nothing behind it acts", () => {
    const held = render(sourceOf());
    type("launch");
    const button = clearButton();

    // The palette's Enter opens the top row; the modal behind owns its keys.
    const heard: string[] = [];
    const listen = (event: KeyboardEvent): void => {
      heard.push(event.key);
    };
    document.addEventListener("keydown", listen);
    act(() => button.focus());
    for (const key of ["Enter", " "]) {
      act(() => {
        button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    }
    document.removeEventListener("keydown", listen);

    expect(held.onOpen).not.toHaveBeenCalled();
    expect(heard).toEqual([]);

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
    });
    expect(field().value).toBe("");
    expect(held.onOpen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field());
  });

  it("clears on a press, keeping the caret in the field", () => {
    render(sourceOf());
    type("launch");
    const button = clearButton();

    // The press only holds focus: it is not the clear on its own.
    act(() => {
      button.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    });
    expect(field().value).toBe("launch");
    expect(document.activeElement).toBe(field());

    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    expect(field().value).toBe("");
    expect(document.activeElement).toBe(field());
  });

  it("stays open when the modal behind takes the focus asynchronously", () => {
    const held = render(sourceOf());
    const behind = document.createElement("input");
    document.body.appendChild(behind);
    act(() => behind.focus());
    expect(held.onClose).not.toHaveBeenCalled();
    behind.remove();
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
