import type { KeyboardEvent } from "react";
import { claimFocus } from "../../lib/focus-ownership";

/**
 * Arrow keys inside a group of role=radio buttons, as native radios behave:
 * Left and Up go to the previous one, Right and Down to the next, wrapping.
 * Moving selects, unless selecting has a cost worth a deliberate press (a
 * choice that rescales the whole window): then arrows only move, and Space or
 * Enter, the button's own keys, select.
 *
 * The group gives the checked radio tabIndex 0 and the others -1, so the
 * group is one Tab stop.
 */
export const radioGroupKeys =
  (selectOnMove: boolean) =>
  (event: KeyboardEvent<HTMLElement>): void => {
    const step =
      event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : 0;
    if (step === 0) return;
    const radios = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role='radio']"));
    const at = radios.findIndex((radio) => radio === event.target);
    if (at < 0) return;
    event.preventDefault();
    const next = radios[(at + step + radios.length) % radios.length];
    if (!next) return;
    claimFocus(next, "gesture");
    if (selectOnMove) next.click();
  };

/** The one radio in its group that Tab lands on. */
export const radioTabIndex = (checked: boolean): 0 | -1 => (checked ? 0 : -1);
