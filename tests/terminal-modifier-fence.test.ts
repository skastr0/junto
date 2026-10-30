// @vitest-environment jsdom
/**
 * Shift and Cmd typed in a terminal never reach window or document key
 * listeners (xyflow's selection and zoom keys repaint the whole board on each
 * flip), while every other key, and every keyup, still travels.
 */
import { afterEach, expect, it } from "vitest";
import { attachTerminalModifierFence, isModifierOnlyKey } from "../src/renderer/lib/terminal-modifier-fence";

const seen: string[] = [];
const onDocument = (event: KeyboardEvent): void => {
  seen.push(`${event.type}:${event.key}`);
};
document.addEventListener("keydown", onDocument);
document.addEventListener("keyup", onDocument);

afterEach(() => {
  seen.length = 0;
  document.body.replaceChildren();
});

const terminal = () => {
  const host = document.createElement("div");
  const textarea = document.createElement("textarea");
  host.append(textarea);
  document.body.append(host);
  return { host, textarea, detach: attachTerminalModifierFence(host) };
};

const press = (target: Element, type: "keydown" | "keyup", key: string): void => {
  target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
};

it("stops modifier-only keydown at the terminal", () => {
  const { textarea } = terminal();
  for (const key of ["Shift", "Meta", "Control", "Alt"]) press(textarea, "keydown", key);
  expect(seen).toEqual([]);
});

it("lets typed keys and every keyup through", () => {
  const { textarea } = terminal();
  press(textarea, "keydown", "Z");
  press(textarea, "keydown", "c");
  press(textarea, "keyup", "Shift");
  press(textarea, "keyup", "Meta");
  expect(seen).toEqual(["keydown:Z", "keydown:c", "keyup:Shift", "keyup:Meta"]);
});

it("the target still sees its own modifier keydown", () => {
  const { textarea } = terminal();
  const own: string[] = [];
  textarea.addEventListener("keydown", (event) => own.push(event.key));
  press(textarea, "keydown", "Shift");
  expect(own).toEqual(["Shift"]);
});

it("detaches", () => {
  const { textarea, detach } = terminal();
  detach();
  press(textarea, "keydown", "Shift");
  expect(seen).toEqual(["keydown:Shift"]);
});

it("names only the four modifiers", () => {
  expect(["Shift", "Meta", "Control", "Alt"].every(isModifierOnlyKey)).toBe(true);
  expect(["CapsLock", "a", "Enter", "Escape"].some(isModifierOnlyKey)).toBe(false);
});
