import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ListRow } from "../src/renderer/components/ui/ListRow";

const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

describe("ui ListRow", () => {
  it("renders one 28px button line with its mark, title and meta", () => {
    const out = html(<ListRow leading={<i data-mark />} title="notes.md" meta="2 edges" onClick={() => {}} />);
    expect(out).toContain('type="button"');
    expect(out).toContain("h-7");
    expect(out).toContain("<i data-mark");
    expect(out).toContain("notes.md");
    expect(out).toContain("2 edges");
  });

  it("selected sets the fill and tells assistive tech, from one prop", () => {
    const on = html(<ListRow selected title="a" onClick={() => {}} />);
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
    const out = html(<ListRow title="a" onClick={() => {}} />);
    expect(out).toContain("focus-visible:shadow-[inset_0_0_0_2px_var(--color-cyan)]");
    expect(out).not.toContain("ring-inset");
    expect(out).toContain("select-none");
  });

  it("without an onClick is a plain line: not a button, no hover, never faded", () => {
    const out = html(<ListRow title="notes.md" meta="page" disabled data-testid="row" />);
    expect(out.startsWith("<div")).toBe(true);
    expect(out).not.toContain("<button");
    expect(out).not.toContain("disabled");
    expect(out).not.toContain("hover:");
    expect(out).not.toContain("opacity-40");
    // A line that only informs can be selected and copied.
    expect(out).not.toContain("select-none");
    expect(out).toContain('data-testid="row"');
    expect(out).toContain("h-7");
  });

  it("declares no bracket value for type, tracking, leading or radius", () => {
    expect(html(<ListRow title="a" meta="b" />)).not.toMatch(/text-\[|tracking-\[|leading-\[|rounded-\[/);
  });
});
