import { describe, expect, it, vi } from "vitest";
import {
  activateOnPointerUp,
  activateSurfaceOnMouseDown,
  isInteractiveTarget,
} from "../src/renderer/lib/pointer-activation";

describe("activateOnPointerUp", () => {
  it("fires on primary pointer-up and ignores its subsequent click", () => {
    const action = vi.fn();
    const handlers = activateOnPointerUp(action);
    handlers.onPointerUp({ button: 0 } as never);
    handlers.onClick({ detail: 1 } as never);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("preserves synthesized keyboard clicks", () => {
    const action = vi.fn();
    activateOnPointerUp(action).onClick({ detail: 0 } as never);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("ignores non-primary pointer buttons", () => {
    const action = vi.fn();
    activateOnPointerUp(action).onPointerUp({ button: 2 } as never);
    expect(action).not.toHaveBeenCalled();
  });
});

describe("activateSurfaceOnMouseDown", () => {
  it("activates for non-interactive targets", () => {
    const onActivate = vi.fn();
    const target = { closest: () => null };
    activateSurfaceOnMouseDown(onActivate)({ target } as never);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks that originate on chrome buttons", () => {
    const onActivate = vi.fn();
    const button = {};
    const target = {
      closest: (sel: string) => (sel.includes("button") ? button : null),
    };
    activateSurfaceOnMouseDown(onActivate)({ target } as never);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("isInteractiveTarget walks into nested control children", () => {
    const button = {};
    const icon = {
      closest: (sel: string) => (sel.includes("button") ? button : null),
    };
    const plain = { closest: () => null };
    expect(isInteractiveTarget(icon as never)).toBe(true);
    expect(isInteractiveTarget(plain as never)).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
  });
});
