import { describe, expect, it, vi } from "vitest";
import {
  isEditableEventTarget,
  isMultiSelectGesture,
  stopNodeGestureUnlessMultiSelect,
} from "../src/renderer/lib/multi-select-gesture";

describe("multi-select-gesture", () => {
  it("isMultiSelectGesture is shift only", () => {
    expect(isMultiSelectGesture({ shiftKey: true })).toBe(true);
    expect(isMultiSelectGesture({ shiftKey: false })).toBe(false);
  });

  it("stopNodeGestureUnlessMultiSelect yields on shift (no stopPropagation)", () => {
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const yielded = stopNodeGestureUnlessMultiSelect(
      { shiftKey: true, stopPropagation, preventDefault },
      { preventDefault: true },
    );
    expect(yielded).toBe(true);
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("stopNodeGestureUnlessMultiSelect eats non-shift chrome gestures", () => {
    const stopPropagation = vi.fn();
    const preventDefault = vi.fn();
    const yielded = stopNodeGestureUnlessMultiSelect(
      { shiftKey: false, stopPropagation, preventDefault },
      { preventDefault: true },
    );
    expect(yielded).toBe(false);
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("isEditableEventTarget rejects null and non-elements", () => {
    expect(isEditableEventTarget(null)).toBe(false);
    expect(isEditableEventTarget({} as EventTarget)).toBe(false);
  });
});
