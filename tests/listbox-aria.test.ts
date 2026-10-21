/**
 * Field, listbox and option ARIA for the house typeaheads: focus stays in the
 * field, ids follow keys, and the field never names a list or row it is not
 * showing.
 */
import { describe, expect, it } from "vitest";
import {
  comboboxFieldAria,
  listboxAnnouncement,
  listboxAria,
  optionAria,
  optionId,
  type ListboxAriaState,
  type ListboxSelection,
} from "../src/renderer/lib/listbox-aria";

const mention = (overrides: Partial<ListboxAriaState> = {}): ListboxAriaState => ({
  baseId: ":r1:",
  presentation: "popup",
  autocomplete: "list",
  open: true,
  keys: ["agent-01A", "agent-01B"],
  activeKey: "agent-01B",
  selection: { kind: "highlight" },
  ...overrides,
});

const seats = { one: "seat", other: "seats" };

describe("combobox field", () => {
  it("points at the highlighted row by its key", () => {
    const field = comboboxFieldAria(mention());
    expect(field).toMatchObject({
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-expanded": true,
      "aria-controls": listboxAria(mention()).id,
      "aria-activedescendant": optionId(":r1:", "agent-01B"),
    });
  });

  it("names no list and no row while a popup is closed", () => {
    const field = comboboxFieldAria(mention({ open: false }));
    expect(field["aria-expanded"]).toBe(false);
    expect(field["aria-controls"]).toBeUndefined();
    expect(field["aria-activedescendant"]).toBeUndefined();
  });

  it("drops the active row once it leaves the list", () => {
    const field = comboboxFieldAria(mention({ keys: ["agent-01A"] }));
    expect(field["aria-activedescendant"]).toBeUndefined();
  });

  it("keeps an id with its option when the list refills", () => {
    const before = comboboxFieldAria(mention({ keys: ["agent-01A", "agent-01B"] }));
    const after = comboboxFieldAria(mention({ keys: ["agent-01B"] }));
    expect(after["aria-activedescendant"]).toBe(before["aria-activedescendant"]);
  });

  it("an inline list is expanded only while it has rows, and claims no popup", () => {
    const inline = mention({ presentation: "inline", autocomplete: "both" });
    expect(comboboxFieldAria(inline)["aria-haspopup"]).toBeUndefined();
    expect(comboboxFieldAria(inline)["aria-expanded"]).toBe(true);
    expect(comboboxFieldAria({ ...inline, keys: [] })["aria-expanded"]).toBe(false);
  });
});

describe("option ids", () => {
  it("never collide across keys that differ only in unsafe characters", () => {
    const keys = ["a b", "a_b", "a_0020b", "a:b", "a.b", "task-1&item=2"];
    const ids = keys.map((key) => optionId(":r1:", key));
    expect(new Set(ids).size).toBe(keys.length);
    for (const id of ids) expect(id.slice(":r1:".length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("aria-selected", () => {
  it("follows the highlight in a list with no committed choice", () => {
    const state = mention();
    expect(optionAria(state, "agent-01A")["aria-selected"]).toBe(false);
    expect(optionAria(state, "agent-01B")["aria-selected"]).toBe(true);
    expect(optionAria({ ...state, open: false }, "agent-01B")["aria-selected"]).toBe(false);
  });

  it("marks the committed option, not the highlight, in a picker", () => {
    const state = mention({ selection: { kind: "committed", key: "agent-01A" } });
    expect(optionAria(state, "agent-01A")["aria-selected"]).toBe(true);
    expect(optionAria(state, "agent-01B")["aria-selected"]).toBe(false);
  });

  it("closes the selection model", () => {
    const highlight: ListboxSelection = { kind: "highlight" };
    // @ts-expect-error: a committed selection must say which key it names.
    const unnamed: ListboxSelection = { kind: "committed" };
    // @ts-expect-error: there is no multiple selection model.
    const multiple: ListboxSelection = { kind: "multiple" };
    expect([highlight, unnamed, multiple]).toHaveLength(3);
  });

  it("closes presentation and autocomplete", () => {
    // @ts-expect-error: a dialog popup is not a listbox combobox.
    const dialog: ListboxAriaState["presentation"] = "dialog";
    // @ts-expect-error: inline-only completion has no list to wire.
    const inlineOnly: ListboxAriaState["autocomplete"] = "inline";
    expect([dialog, inlineOnly]).toHaveLength(2);
  });
});

describe("result announcement", () => {
  it("counts rows with the right noun", () => {
    expect(listboxAnnouncement({ open: true, count: 1, noun: seats })).toBe("1 seat");
    expect(listboxAnnouncement({ open: true, count: 3, noun: seats })).toBe("3 seats");
  });

  it("says when nothing matched, and is silent while closed", () => {
    expect(listboxAnnouncement({ open: true, count: 0, noun: seats })).toBe("No matches");
    expect(listboxAnnouncement({ open: false, count: 3, noun: seats })).toBe("");
  });
});
