import { describe, expect, it } from "vitest";
import {
  absorbNativeTitle,
  absorbNativeTitlesInTree,
  type TitleHost,
} from "../src/renderer/components/TooltipLayer";

const host = (init: {
  title?: string;
  tooltip?: string;
  children?: TitleHost[];
}): TitleHost => {
  let title = init.title;
  const dataset: { tooltip?: string; juntoTooltip?: string } = {
    tooltip: init.tooltip,
  };
  return {
    getAttribute: (name) => (name === "title" ? (title ?? null) : null),
    removeAttribute: (name) => {
      if (name === "title") title = undefined;
    },
    dataset,
    querySelectorAll: (sel) => {
      if (sel !== "[title]") return [];
      return (init.children ?? []).filter((c) => c.getAttribute("title"));
    },
  };
};

describe("absorbNativeTitle", () => {
  it("moves title to data-junto-tooltip and strips the attribute", () => {
    const button = host({ title: "Open settings" });
    absorbNativeTitle(button);
    expect(button.getAttribute("title")).toBeNull();
    expect(button.dataset.juntoTooltip).toBe("Open settings");
  });

  it("is idempotent and does not clobber data-tooltip", () => {
    const button = host({ title: "Native", tooltip: "Branded" });
    absorbNativeTitle(button);
    absorbNativeTitle(button);
    expect(button.getAttribute("title")).toBeNull();
    expect(button.dataset.tooltip).toBe("Branded");
    expect(button.dataset.juntoTooltip).toBeUndefined();
  });

  it("walks newly mounted subtrees (React remount shape)", () => {
    const a = host({ title: "A" });
    const b = host({ title: "B" });
    const root = host({ children: [a, b] });
    absorbNativeTitlesInTree(root);
    expect(a.getAttribute("title")).toBeNull();
    expect(b.getAttribute("title")).toBeNull();
    expect(a.dataset.juntoTooltip).toBe("A");
    expect(b.dataset.juntoTooltip).toBe("B");
  });
});
