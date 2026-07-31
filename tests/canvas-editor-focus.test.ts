import { describe, expect, it, vi } from "vitest";
import {
  commitCanvasEditorDrafts,
  shouldBlurCanvasFlushTarget,
} from "../src/renderer/lib/canvas-editor-flush";

describe("canvas editor flush focus boundary", () => {
  it("does not blur an input owned by a focus surface", () => {
    const blur = vi.fn();
    const closest = vi.fn(() => ({}));
    const active = { blur, closest };

    expect(shouldBlurCanvasFlushTarget(active)).toBe(false);
    commitCanvasEditorDrafts(active);

    expect(blur).not.toHaveBeenCalled();
    expect(closest).toHaveBeenCalledWith("[data-focus-surface='1']");
  });

  it("still blurs a normal canvas editor so its onBlur commit runs", () => {
    const blur = vi.fn();
    const closest = vi.fn(() => null);
    const active = { blur, closest };

    expect(shouldBlurCanvasFlushTarget(active)).toBe(true);
    commitCanvasEditorDrafts(active);

    expect(blur).toHaveBeenCalledOnce();
  });
});
