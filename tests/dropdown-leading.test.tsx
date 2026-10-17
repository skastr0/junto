// @vitest-environment jsdom
/**
 * A dropdown option's leading mark and state word: the mark shows on the
 * trigger only for the chosen option, the word only in the menu, and neither
 * is read as part of an option's name.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Dropdown } from "../src/renderer/components/ui/Dropdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const options = [
  { value: "desk", label: "Desk", detail: "this machine", leading: <img alt="Desk" data-mark="desk" /> },
  { value: "mini", label: "Mini", detail: "unreachable", leading: <img alt="Mini" data-mark="mini" /> },
];

const render = (value: string): HTMLButtonElement => {
  act(() => root.render(<Dropdown aria-label="Machine" value={value} options={options} onChange={() => {}} />));
  return host.querySelector("button")!;
};

it("shows the chosen option's mark on the trigger, and no state word", () => {
  const trigger = render("mini");
  expect(trigger.querySelector("[data-mark]")?.getAttribute("data-mark")).toBe("mini");
  expect(trigger.querySelector("[data-mark]")?.closest("[aria-hidden]")).not.toBeNull();
  expect(trigger.textContent).toBe("Mini");
});

it("shows every mark and state word in the menu, hidden from an option's name", () => {
  const trigger = render("desk");
  act(() => trigger.click());
  const rows = Array.from(document.querySelectorAll<HTMLElement>("[role='option']"));
  expect(rows.map((row) => row.textContent)).toEqual(["Deskthis machine", "Miniunreachable"]);
  for (const row of rows) expect(row.querySelector("[data-mark]")?.closest("[aria-hidden]")).not.toBeNull();
});
