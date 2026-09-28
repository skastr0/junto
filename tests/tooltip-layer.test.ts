import { describe, expect, it } from "vitest";
import {
  absorbNativeTitle,
  absorbNativeTitlesInTree,
  placeTooltip,
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

describe("placeTooltip", () => {
  const viewport = { width: 1000, height: 800 };
  const tip = { width: 100, height: 24 };
  // A seat's name, with the seat's selection toolbar right above it.
  const name = { left: 450, top: 300, right: 550, bottom: 316 };
  const toolbar = { left: 380, top: 250, right: 620, bottom: 292 };

  it("goes above by default, centred on the anchor", () => {
    expect(placeTooltip(name, tip, viewport)).toEqual({ left: 450, top: 268, placement: "top" });
  });

  it("goes below when above would cover a node toolbar", () => {
    expect(placeTooltip(name, tip, viewport, [toolbar])).toEqual({ left: 450, top: 324, placement: "bottom" });
  });

  it("keeps the usual side when neither side is clear", () => {
    const below = { left: 380, top: 318, right: 620, bottom: 360 };
    expect(placeTooltip(name, tip, viewport, [toolbar, below]).placement).toBe("top");
  });

  it("goes below when there is no room above, and stays inside the viewport", () => {
    const edge = { left: 0, top: 10, right: 20, bottom: 26 };
    expect(placeTooltip(edge, tip, viewport)).toEqual({ left: 8, top: 34, placement: "bottom" });
  });
});
