import { describe, expect, it, vi } from "vitest";
import { activateOnPointerUp } from "../src/renderer/lib/pointer-activation";

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
