import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRow } from "../src/renderer/components/ui/ListRow";

const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

describe("ui ListRow", () => {
  it("renders one 28px button line with its mark, title and meta", () => {
    const out = html(<ListRow leading={<i data-mark />} title="notes.md" meta="2 edges" />);
    expect(out).toContain('type="button"');
    expect(out).toContain("h-7");
    expect(out).toContain("<i data-mark");
    expect(out).toContain("notes.md");
    expect(out).toContain("2 edges");
  });

  it("selected sets the fill and tells assistive tech, from one prop", () => {
    const on = html(<ListRow selected title="a" />);
    expect(on).toContain('data-selected="true"');
    expect(on).toContain('aria-current="true"');
    const off = html(<ListRow title="a" />);
    expect(off).not.toContain("data-selected");
    expect(off).not.toContain("aria-current");
  });

  it("a caller cannot fight its height, type or selected state", () => {
    // className and aria-current are not props; a cast is the only way in.
    const smuggled = { className: "h-9 text-title", "aria-current": "page" } as object;
    const out = html(<ListRow title="a" {...smuggled} />);
    expect(out).not.toContain("h-9");
    expect(out).not.toContain("text-title");
    expect(out).not.toContain("aria-current");
    expect(out.match(/\bh-\d+\b/g)).toEqual(["h-7"]);
  });

  it("shows keyboard focus with an inset ring that a clipping list cannot cut off", () => {
    const out = html(<ListRow title="a" />);
    expect(out).toContain("focus-visible:ring-inset");
    expect(out).toContain("focus-visible:ring-cyan/60");
  });

  it("declares no bracket value for type, tracking, leading or radius", () => {
    expect(html(<ListRow title="a" meta="b" />)).not.toMatch(/text-\[|tracking-\[|leading-\[|rounded-\[/);
  });
});
