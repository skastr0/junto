import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRow } from "../src/renderer/components/ui/ListRow";

const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

describe("ui ListRow", () => {
  it("renders a two-line row at the fixed 44px height, with the detail as hover text", () => {
    const out = html(<ListRow leading={<i data-mark />} title="product-shell" meta="working 4m" detail="reading the rail" />);
    expect(out).toContain('type="button"');
    expect(out).toContain("h-11");
    expect(out).not.toContain("h-7");
    expect(out).toContain("<i data-mark");
    expect(out).toContain("product-shell");
    expect(out).toContain("working 4m");
    expect(out).toContain('title="reading the rail"');
  });

  it("keeps its height when there is no detail, and prints no placeholder", () => {
    const out = html(<ListRow title="idle-seat" meta="idle 2h 3m" />);
    expect(out).toContain("h-11");
    expect(out).not.toContain("leading-dense");
  });

  it("dense is one 28px line and drops the detail", () => {
    const out = html(<ListRow dense title="notes.md" detail="never shown" />);
    expect(out).toContain("h-7");
    expect(out).not.toContain("h-11");
    expect(out).not.toContain("never shown");
  });

  it("marks the selected row for assistive tech and for its background", () => {
    expect(html(<ListRow selected title="a" />)).toContain('aria-current="true"');
    expect(html(<ListRow title="a" />)).not.toContain("aria-current");
  });

  it("takes every size from the type scale", () => {
    const out = html(<ListRow title="a" meta="b" detail="c" />);
    expect(out).not.toMatch(/text-\[|tracking-\[|leading-\[|rounded-\[/);
    expect(out).toContain("text-body");
    expect(out).toContain("text-label");
  });
});
