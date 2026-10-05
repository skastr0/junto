import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IconButton, Textarea } from "../src/renderer/components/ui";

const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

describe("ui IconButton sizes", () => {
  it("xs is a 16px square, so it fits inside one 18px diff row", () => {
    const out = html(<IconButton size="xs" aria-label="Add comment">+</IconButton>);
    expect(out).toContain("size-4");
    expect(out).not.toMatch(/size-6|size-7/);
  });

  it("shows keyboard focus at every size with an inset ring", () => {
    for (const size of ["xs", "sm", "md"] as const) {
      expect(html(<IconButton size={size} aria-label="x">x</IconButton>)).toContain("focus-visible:ring-inset");
    }
  });

  it("keeps md as the default", () => {
    expect(html(<IconButton aria-label="Close">x</IconButton>)).toContain("size-7");
  });
});

describe("ui Textarea", () => {
  it("dense is two lines that grow with the text, with one size and one padding", () => {
    const out = html(<Textarea dense aria-label="Comment" />);
    expect(out).toContain('rows="2"');
    expect(out).toContain("field-sizing-content");
    expect(out).toContain("min-h-[calc(2lh+10px)]");
    expect(out).toContain("max-h-40");
    expect(out).toContain("resize-none");
    expect(out.match(/\btext-(?:micro|caption|label|body-lg|body|title)\b/g)).toEqual(["text-body-lg"]);
    expect(out.match(/\bpy-[\d.]+/g)).toEqual(["py-1"]);
    expect(out).not.toContain("min-h-24");
  });

  it("regular keeps its 96px minimum and resize handle", () => {
    const out = html(<Textarea aria-label="Notes" />);
    expect(out).toContain("min-h-24");
    expect(out).toContain("resize-y");
    expect(out).toContain("py-1.5");
    expect(out).not.toContain("field-sizing-content");
    expect(out).not.toContain("rows=");
  });
});
