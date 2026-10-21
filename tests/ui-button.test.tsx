// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "../src/renderer/components/ui/Button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** A submit Button in a form; counts its presses and the form's submits. */
const inForm = async (inert: boolean) => {
  const onClick = vi.fn();
  const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
  await act(async () =>
    root.render(
      <form onSubmit={onSubmit}>
        <input aria-label="Field" />
        <Button type="submit" aria-disabled={inert} onClick={onClick}>
          Save
        </Button>
      </form>,
    ),
  );
  const button = host.querySelector("button")!;
  return { onClick, onSubmit, button };
};

// Enter on the button, or in a field of its form (implicit submission), reaches
// the button as a click with detail 0; jsdom does not model Enter, so send that click.
const pressEnter = async (button: HTMLButtonElement): Promise<void> =>
  act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  });

describe("ui Button", () => {
  it("aria-disabled ignores the press: no onClick and no submit, by click or by Enter", async () => {
    const { onClick, onSubmit, button } = await inForm(true);
    await act(async () => button.click());
    await pressEnter(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps focus while inert, where disabled would drop it", async () => {
    const { button } = await inForm(true);
    button.focus();
    await act(async () => button.click());
    expect(document.activeElement).toBe(button);
  });

  it("a plain submit Button still calls onClick and submits", async () => {
    const { onClick, onSubmit, button } = await inForm(false);
    await act(async () => button.click());
    await pressEnter(button);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
