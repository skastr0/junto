import { describe, expect, it, vi } from "vitest";
import {
  selectionTextForCopy,
  shouldAutoCopySelection,
  type XtermSelectionApi,
} from "../src/renderer/lib/xterm-auto-copy";

const term = (
  selection: string | undefined,
  has = selection !== undefined && selection.length > 0,
): XtermSelectionApi => ({
  hasSelection: () => has,
  getSelection: () => selection ?? "",
});

describe("selectionTextForCopy", () => {
  it("rejects empty and whitespace-only", () => {
    expect(selectionTextForCopy("")).toBeUndefined();
    expect(selectionTextForCopy("   \n\t  ")).toBeUndefined();
    expect(selectionTextForCopy(null)).toBeUndefined();
    expect(selectionTextForCopy(undefined)).toBeUndefined();
  });

  it("keeps interior and trailing newlines", () => {
    expect(selectionTextForCopy("hello\n")).toBe("hello\n");
    expect(selectionTextForCopy("  indented")).toBe("  indented");
  });
});

describe("shouldAutoCopySelection", () => {
  it("returns text when there is a new selection", () => {
    expect(shouldAutoCopySelection(term("copy me"), undefined)).toBe("copy me");
  });

  it("skips when hasSelection is false", () => {
    expect(shouldAutoCopySelection(term("x", false), undefined)).toBeUndefined();
  });

  it("skips re-copy of the same text", () => {
    expect(shouldAutoCopySelection(term("same"), "same")).toBeUndefined();
  });

  it("allows a different selection after a prior copy", () => {
    expect(shouldAutoCopySelection(term("next"), "same")).toBe("next");
  });
});

describe("attachXtermAutoCopy", () => {
  const mockHost = (): {
    readonly el: HTMLElement;
    readonly fireMouseUp: () => void;
  } => {
    const handlers = new Map<string, EventListener>();
    const el = {
      addEventListener: (type: string, fn: EventListener) => {
        handlers.set(type, fn);
      },
      removeEventListener: (type: string) => {
        handlers.delete(type);
      },
    } as unknown as HTMLElement;
    return {
      el,
      fireMouseUp: () => {
        handlers.get("mouseup")?.(new Event("mouseup"));
      },
    };
  };

  it("writes clipboard on mouseup when selection is present", async () => {
    const { attachXtermAutoCopy } = await import(
      "../src/renderer/lib/xterm-auto-copy"
    );
    const host = mockHost();
    const write = vi.fn(async () => undefined);
    const dispose = attachXtermAutoCopy(host.el, term("picked text"), write);
    host.fireMouseUp();
    await Promise.resolve();
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith("picked text");
    dispose();
  });

  it("does not write when selection is empty", async () => {
    const { attachXtermAutoCopy } = await import(
      "../src/renderer/lib/xterm-auto-copy"
    );
    const host = mockHost();
    const write = vi.fn(async () => undefined);
    const dispose = attachXtermAutoCopy(host.el, term("   "), write);
    host.fireMouseUp();
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    dispose();
  });
});
