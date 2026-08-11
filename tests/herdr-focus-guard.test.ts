import { describe, expect, it } from "vitest";
import { shouldHerdrCaptureWindowTarget } from "../src/renderer/components/herdr/HerdrTerminalModal";

const targetWithControl = (
  control: Element | null,
  selectorNeedle?: string,
): Element =>
  ({
    closest: (selector: string) =>
      selectorNeedle == null || selector.includes(selectorNeedle)
        ? control
        : null,
  }) as unknown as Element;

const hostContaining = (...members: Element[]): HTMLElement =>
  ({
    contains: (candidate: Element) => members.includes(candidate),
  }) as unknown as HTMLElement;

describe("Herdr window capture focus guard", () => {
  it.each(["input", "textarea", "select", "button", "[contenteditable]"])(
    "yields to an external %s even when logical Herdr focus is stale",
    (selectorNeedle) => {
      const externalControl = {} as Element;

      expect(
        shouldHerdrCaptureWindowTarget(
          targetWithControl(externalControl, selectorNeedle),
          hostContaining(),
        ),
      ).toBe(false);
    },
  );

  it("preserves terminal input through xterm's helper textarea", () => {
    const xtermTextarea = {} as Element;

    expect(
      shouldHerdrCaptureWindowTarget(
        targetWithControl(xtermTextarea),
        hostContaining(xtermTextarea),
      ),
    ).toBe(true);
  });

  it("preserves Herdr command handling for controls inside its own panel", () => {
    const herdrButton = {} as Element;

    expect(
      shouldHerdrCaptureWindowTarget(
        targetWithControl(herdrButton),
        hostContaining(herdrButton),
      ),
    ).toBe(true);
  });

  it("keeps logical Herdr capture for non-control canvas targets", () => {
    expect(
      shouldHerdrCaptureWindowTarget(targetWithControl(null), hostContaining()),
    ).toBe(true);
  });

  it("fails closed for a control when the active host is unavailable", () => {
    expect(
      shouldHerdrCaptureWindowTarget(
        targetWithControl({} as Element),
        null,
      ),
    ).toBe(false);
  });
});
