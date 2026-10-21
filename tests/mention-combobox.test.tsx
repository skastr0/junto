// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MentionRef } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";
import { MentionCombobox } from "../src/renderer/components/ui/MentionCombobox";
import type { MentionCandidate } from "../src/renderer/lib/mention-draft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const candidates: ReadonlyArray<MentionCandidate> = [
  { ref: { kind: "seat", nodeId: asNodeId("agent-feed") }, label: "@product-feed" },
  { ref: { kind: "seat", nodeId: asNodeId("agent-lead") }, label: "@product-lead", note: "not running" },
  { ref: { kind: "task", nodeId: asNodeId("task-board"), taskId: "01M5ESSJRFWT6RVS5HMWMGJXGD" as ItemId }, label: "#42 fix tabs" },
];

let host: HTMLDivElement;
let root: Root;
let written: string;
let mentions: ReadonlyArray<MentionRef>;
let outerKeys: string[];

function Harness({ initial = "" }: { readonly initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <div onKeyDown={(event) => outerKeys.push(event.key)}>
      <MentionCombobox
        value={value}
        onValueChange={(next, refs) => {
          written = next;
          mentions = refs;
          setValue(next);
        }}
        canvasName="factory"
        candidates={candidates}
        listLabel={(trigger) => (trigger === "@" ? "Seats connected to product-lead" : "Tasks in reach")}
        noun={{ one: "seat", other: "seats" }}
        aria-label="Reply"
        onKeyDown={(event) => {
          if (event.key === "Enter") outerKeys.push("composer-send");
        }}
      />
      <button type="button" onClick={() => setValue("")}>
        clear
      </button>
    </div>
  );
}

const field = (): HTMLTextAreaElement => host.querySelector("textarea")!;
const list = (): HTMLUListElement | null => host.querySelector('[role="listbox"]');
const options = (): HTMLLIElement[] => [...host.querySelectorAll<HTMLLIElement>('[role="option"]')];
const live = (): string => host.querySelector('[aria-live="polite"]')!.textContent ?? "";

/** Type: the field takes the new value with the caret at its end, as a keystroke leaves it. */
const type = (text: string): void => {
  const element = field();
  const next = `${element.value}${text}`;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(element, next);
    element.setSelectionRange(next.length, next.length);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const setField = (next: string, caret = next.length): void => {
  const element = field();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(element, next);
    element.setSelectionRange(caret, caret);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const press = (key: string, init: KeyboardEventInit = {}): void => {
  act(() => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
};

beforeEach(() => {
  written = "";
  mentions = [];
  outerKeys = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("MentionCombobox", () => {
  it("the field is a combobox whose list opens on @ and closes after a pick", () => {
    const element = field();
    expect(element.getAttribute("role")).toBe("combobox");
    expect(element.getAttribute("aria-haspopup")).toBe("listbox");
    expect(element.getAttribute("aria-expanded")).toBe("false");
    expect(element.getAttribute("aria-controls")).toBeNull();

    type("hi @prod");
    expect(element.getAttribute("aria-expanded")).toBe("true");
    expect(list()!.getAttribute("aria-label")).toBe("Seats connected to product-lead");
    expect(element.getAttribute("aria-controls")).toBe(list()!.id);
    expect(options().map((option) => option.textContent)).toEqual(["@product-feedSeat", "@product-leadSeatnot running"]);
    // The first row is highlighted, named from the field, selected only while highlighted.
    expect(element.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    expect(options().map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(live()).toBe("2 seats");

    press("ArrowDown");
    expect(element.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    press("Enter");
    expect(field().value).toBe("hi @product-lead ");
    expect(written).toBe("hi [@product-lead](junto://canvas/factory?node=agent-lead) ");
    expect(mentions).toEqual([{ kind: "seat", nodeId: "agent-lead" }]);
    expect(list()).toBeNull();
    expect(field().getAttribute("aria-activedescendant")).toBeNull();
    // Enter went to the list, not to the composer's send.
    expect(outerKeys).not.toContain("composer-send");
  });

  it("option ids follow the option, not its row", () => {
    type("@");
    const leadId = options()[1]!.id;
    type("product-l");
    expect(options()).toHaveLength(1);
    expect(options()[0]!.id).toBe(leadId);
  });

  it("# lists tasks under its own name", () => {
    type("see #fix");
    expect(list()!.getAttribute("aria-label")).toBe("Tasks in reach");
    press("Tab");
    expect(field().value).toBe("see #42 fix tabs ");
    expect(mentions).toEqual([candidates[2]!.ref]);
  });

  it("Escape closes the list only, and the surface around never hears it", () => {
    type("@");
    press("Escape");
    expect(list()).toBeNull();
    expect(outerKeys).not.toContain("Escape");
    // Enter now is the composer's.
    press("Enter");
    expect(outerKeys).toContain("composer-send");
  });

  it("with no match it says so, and Enter is the composer's", () => {
    type("@zzz");
    expect(options()).toHaveLength(0);
    expect(host.querySelector('[data-testid="mention-empty"]')!.textContent).toBe("No matches");
    expect(live()).toBe("No matches");
    press("Enter");
    expect(outerKeys).toContain("composer-send");
  });

  it("deleting into a chip removes the whole mention", () => {
    type("@prod");
    press("Enter");
    setField("@product-feed");
    expect(mentions).toHaveLength(1);
    setField("@product-fee");
    expect(field().value).toBe("");
    expect(mentions).toEqual([]);
    expect(written).toBe("");
  });

  it("draws each mention as a hidden chip over its words", () => {
    type("@prod");
    press("Enter");
    const mirror = host.querySelector(".mention-combobox__mirror")!;
    expect(mirror.getAttribute("aria-hidden")).toBe("true");
    expect(mirror.querySelector(".mention-combobox__chip")!.textContent).toBe("@product-feed");
  });

  it("a value set from outside is read back from its links", () => {
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<Harness initial="ask [@product-feed](junto://canvas/factory?node=agent-feed) now" />));
    expect(field().value).toBe("ask @product-feed now");
    expect(host.querySelector(".mention-combobox__chip")!.textContent).toBe("@product-feed");
    act(() => host.querySelector("button")!.click());
    expect(field().value).toBe("");
  });

  it("a key in composition is never the list's", () => {
    type("@");
    act(() => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true });
      field().dispatchEvent(event);
    });
    expect(field().value).toBe("@");
  });
});
