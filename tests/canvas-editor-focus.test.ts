import { describe, expect, it, vi } from "vitest";
import {
  commitCanvasEditorDrafts,
  shouldBlurCanvasFlushTarget,
} from "../src/renderer/lib/canvas-editor-flush";
import { CANVAS_DRAFT_FOCUS_SELECTOR } from "../src/renderer/lib/focus-ownership";

describe("canvas editor flush focus boundary", () => {
  it("protects unmarked interactive controls by default", () => {
    const blur = vi.fn();
    const closest = vi.fn(() => null);
    const active = { blur, closest };

    expect(shouldBlurCanvasFlushTarget(active)).toBe(false);
    commitCanvasEditorDrafts(active);

    expect(blur).not.toHaveBeenCalled();
    expect(closest).toHaveBeenCalledWith(CANVAS_DRAFT_FOCUS_SELECTOR);
  });

  it("blurs only an explicit canvas draft owner so its onBlur commit runs", () => {
    const blur = vi.fn();
    const closest = vi.fn(() => ({}));
    const active = { blur, closest };

    expect(shouldBlurCanvasFlushTarget(active)).toBe(true);
    commitCanvasEditorDrafts(active);

    expect(blur).toHaveBeenCalledOnce();
    expect(closest).toHaveBeenCalledWith(CANVAS_DRAFT_FOCUS_SELECTOR);
  });

  it("does not blur a target that cannot declare canvas draft ownership", () => {
    const blur = vi.fn();
    const active = { blur };

    commitCanvasEditorDrafts(active);

    expect(blur).not.toHaveBeenCalled();
  });
});
