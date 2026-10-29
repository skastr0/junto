// @vitest-environment jsdom
/**
 * The trigger's name (0.11/09 H3): the caller's label and the value it holds,
 * so a reader hears the choice on focus instead of the label alone. With
 * nothing chosen the name is the label alone, aria-label stays the caller's
 * plain label for the tests and specs that read it, and the button's own text
 * is still only its value.
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
  { value: "desk", label: "Desk" },
  { value: "mini", label: "Mini" },
];

const render = (value: string, placeholder?: string): HTMLButtonElement => {
  act(() => root.render(<Dropdown aria-label="Machine" value={value} options={options} onChange={() => undefined} placeholder={placeholder} />));
  return host.querySelector("button")!;
};

/** The name a reader computes from aria-labelledby: the referenced text, joined by spaces. */
const labelOf = (trigger: HTMLButtonElement): string =>
  (trigger.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/u)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

it("names the trigger by its label and the value it holds", () => {
  const trigger = render("mini");
  expect(labelOf(trigger).replace(/\s+/gu, " ").trim()).toBe("Machine, Mini");
  // The attribute callers and their tests read keeps its plain words.
  expect(trigger.getAttribute("aria-label")).toBe("Machine");
  // The button's own text is still only the value.
  expect(trigger.textContent).toBe("Mini");
});

it("names it by the label alone with nothing chosen, and leaves the placeholder there", () => {
  const trigger = render("", "Pick a machine");
  expect(trigger.hasAttribute("aria-labelledby")).toBe(false);
  expect(trigger.getAttribute("aria-label")).toBe("Machine");
  expect(trigger.textContent).toBe("Pick a machine");
});
