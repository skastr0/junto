import { describe, expect, it } from "vitest";
import { canClaimFocusAfterAsyncWork } from "../src/renderer/lib/focus-ownership";

type OwnerOptions = {
  readonly connected?: boolean;
  readonly visible?: boolean;
  readonly inert?: boolean;
  readonly contains?: (target: Element) => boolean;
};

const focusOwner = ({
  connected = true,
  visible = true,
  inert = false,
  contains = () => false,
}: OwnerOptions = {}): HTMLElement =>
  ({
    isConnected: connected,
    closest: (selector: string) =>
      selector === "[inert]" && inert ? ({} as Element) : null,
    getClientRects: () => ({ length: visible ? 1 : 0 }),
    contains,
  }) as unknown as HTMLElement;

describe("async focus ownership", () => {
  it("allows a connected visible owner to claim neutral focus", () => {
    expect(canClaimFocusAfterAsyncWork(focusOwner(), null)).toBe(true);
  });

  it("allows an owner to retain focus already inside itself", () => {
    const active = {} as Element;
    const owner = focusOwner({ contains: (target) => target === active });

    expect(canClaimFocusAfterAsyncWork(owner, active)).toBe(true);
  });

  it("refuses to take focus from a foreign control", () => {
    const active = {} as Element;

    expect(canClaimFocusAfterAsyncWork(focusOwner(), active)).toBe(false);
  });

  it("refuses claims from inert owners", () => {
    expect(canClaimFocusAfterAsyncWork(focusOwner({ inert: true }), null)).toBe(
      false,
    );
  });

  it("refuses claims from hidden owners", () => {
    expect(
      canClaimFocusAfterAsyncWork(focusOwner({ visible: false }), null),
    ).toBe(false);
  });

  it("refuses claims from disconnected owners", () => {
    expect(
      canClaimFocusAfterAsyncWork(focusOwner({ connected: false }), null),
    ).toBe(false);
  });
});
