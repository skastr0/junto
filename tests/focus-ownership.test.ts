import { describe, expect, it } from "vitest";
import {
  canClaimFocusAfterAsyncWork,
  pickPrimaryFocusControl,
  shouldClaimFocusOnSurfaceOpen,
} from "../src/renderer/lib/focus-ownership";

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

describe("focus modal open", () => {
  it("picks the xterm helper textarea before ordinary fields", () => {
    const hits: string[] = [];
    const textarea = { focus() {} } as HTMLElement;
    const picked = pickPrimaryFocusControl({
      querySelector: (selector) => {
        hits.push(selector);
        return selector === ".xterm-helper-textarea" ? textarea : null;
      },
    });
    expect(picked).toBe(textarea);
    expect(hits[0]).toBe(".xterm-helper-textarea");
  });

  it("falls through to a chat composer when no xterm is present", () => {
    const composer = { focus() {} } as HTMLElement;
    const picked = pickPrimaryFocusControl({
      querySelector: (selector) =>
        selector === "textarea.chat-composer__input" ? composer : null,
    });
    expect(picked).toBe(composer);
  });

  it("claims focus from the canvas or opener on modal open", () => {
    const opener = {} as Element;
    expect(shouldClaimFocusOnSurfaceOpen(focusOwner(), null)).toBe(true);
    expect(shouldClaimFocusOnSurfaceOpen(focusOwner(), opener)).toBe(true);
  });

  it("does not yank a real control already focused inside the modal", () => {
    const inner = {} as Element;
    const owner = focusOwner({ contains: (target) => target === inner });
    expect(shouldClaimFocusOnSurfaceOpen(owner, inner)).toBe(false);
  });

  it("still upgrades from the panel container itself", () => {
    const panel = {
      className: "focus-surface__panel work-focus-shell__panel",
      dataset: {},
    } as unknown as Element;
    const owner = focusOwner({ contains: (target) => target === panel });
    expect(shouldClaimFocusOnSurfaceOpen(owner, panel)).toBe(true);
  });
});
