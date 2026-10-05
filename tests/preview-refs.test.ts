import { describe, expect, it } from "vitest";
import { previewComparePair, previewRefsIn } from "@shared/preview";

const RAIL = "/private/tmp/claude-501/-Users-me-Projects-junto/abc/scratchpad/rail";

describe("previewRefsIn", () => {
  it("reads a list of screenshot paths in order, with the agent's captions", () => {
    const refs = previewRefsIn(
      [
        "The rail is ready to review. Screenshots:",
        `- Before: ${RAIL}/before.png`,
        `- Canvas: ${RAIL}/canvas.png`,
        `- **Rail expanded:** \`${RAIL}/rail-expanded.png\``,
        `- Rail collapsed - ${RAIL}/rail-collapsed.png.`,
        `- Details menu: ${RAIL}/details-menu.png`,
      ].join("\n"),
    );
    expect(refs.map((ref) => [ref.caption, ref.name, ref.kind])).toEqual([
      ["Before", "before.png", "image"],
      ["Canvas", "canvas.png", "image"],
      ["Rail expanded", "rail-expanded.png", "image"],
      ["Rail collapsed", "rail-collapsed.png", "image"],
      ["Details menu", "details-menu.png", "image"],
    ]);
    expect(refs[3]?.path).toBe(`${RAIL}/rail-collapsed.png`);
  });

  it("reads markdown images and links, the alt or label as the caption", () => {
    const refs = previewRefsIn(
      "![Before](/tmp/a.png) and [the diff](/tmp/change.diff) and ![](~/shots/b.jpeg)",
    );
    expect(refs).toEqual([
      { path: "/tmp/a.png", name: "a.png", kind: "image", caption: "Before" },
      { path: "/tmp/change.diff", name: "change.diff", kind: "text", caption: "the diff" },
      { path: "~/shots/b.jpeg", name: "b.jpeg", kind: "image" },
    ]);
  });

  it("captions several paths on one line from the words between them", () => {
    const refs = previewRefsIn("Before: /tmp/a.png, after: /tmp/b.png");
    expect(refs.map((ref) => ref.caption)).toEqual(["Before", "after"]);
  });

  it("never invents a caption", () => {
    expect(previewRefsIn("/tmp/a.png")).toEqual([{ path: "/tmp/a.png", name: "a.png", kind: "image" }]);
    expect(previewRefsIn("- `/tmp/a.png`")[0]?.caption).toBeUndefined();
    expect(previewRefsIn("[a.png](/tmp/a.png)")[0]?.caption).toBeUndefined();
  });

  it("keeps a path with spaces when it is quoted as code or a link target", () => {
    expect(previewRefsIn("See `/tmp/my shots/one two.png`")[0]?.path).toBe("/tmp/my shots/one two.png");
    expect(previewRefsIn("![x](</tmp/my shots/a.png>)")[0]?.path).toBe("/tmp/my shots/a.png");
  });

  it("lists a path once, where it first appears", () => {
    expect(previewRefsIn("/tmp/a.png\nagain /tmp/a.png")).toHaveLength(1);
  });

  it("reads other kinds off the extension", () => {
    const refs = previewRefsIn("/tmp/notes.md /tmp/data.JSON /tmp/build.zip file:///tmp/x.log");
    expect(refs.map((ref) => ref.kind)).toEqual(["text", "text", "file", "text"]);
  });

  it("leaves prose, URLs and relative paths alone", () => {
    const text = [
      "Use and/or either/or, 3/4 done.",
      "See https://example.com/shots/a.png and http://x.dev/b.png?c=1",
      "![remote](https://example.com/a.png)",
      "Relative src/renderer/a.png and ./b.png and ../c.png",
      "The folder /usr/local/bin and the root /",
      "A scheme junto-content://sha/a.png",
    ].join("\n");
    expect(previewRefsIn(text)).toEqual([]);
  });
});

describe("previewComparePair", () => {
  it("opens on the pair labelled before and after, whatever their order", () => {
    const refs = previewRefsIn("Canvas: /t/c.png\nAfter: /t/2.png\nBefore: /t/1.png");
    expect(previewComparePair(refs)?.map((ref) => ref.name)).toEqual(["1.png", "2.png"]);
  });

  it("reads before and after off file names when there are no captions", () => {
    const refs = previewRefsIn("/t/x.png\n/t/rail-after.png\n/t/rail-before.png");
    expect(previewComparePair(refs)?.map((ref) => ref.name)).toEqual(["rail-before.png", "rail-after.png"]);
  });

  it("falls back to the first two images", () => {
    const refs = previewRefsIn("/t/notes.md\n/t/a.png\n/t/b.png\n/t/c.png");
    expect(previewComparePair(refs)?.map((ref) => ref.name)).toEqual(["a.png", "b.png"]);
  });

  it("is undefined with fewer than two images", () => {
    expect(previewComparePair(previewRefsIn("/t/a.png /t/notes.md"))).toBeUndefined();
  });
});
