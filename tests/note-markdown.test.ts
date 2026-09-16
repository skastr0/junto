import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../src/renderer/lib/note-markdown";

describe("parseInline", () => {
  it("keeps plain text stable", () => {
    expect(parseInline("hello world")).toEqual([{ kind: "text", value: "hello world" }]);
  });

  it("parses emphasis and code", () => {
    expect(parseInline("a **bold** and *em* and `code`")).toEqual([
      { kind: "text", value: "a " },
      { kind: "strong", children: [{ kind: "text", value: "bold" }] },
      { kind: "text", value: " and " },
      { kind: "em", children: [{ kind: "text", value: "em" }] },
      { kind: "text", value: " and " },
      { kind: "code", value: "code" },
    ]);
  });

  it("rejects unsafe link schemes", () => {
    const tokens = parseInline("[x](javascript:alert(1))");
    expect(tokens).toEqual([
      { kind: "link", href: "#", children: [{ kind: "text", value: "x" }] },
    ]);
  });

  it("parses image markup and allows junto-content src", () => {
    const src =
      "junto-content://object/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?byteLength=12&mediaType=image%2Fpng";
    expect(parseInline(`shot ![cap](${src}) end`)).toEqual([
      { kind: "text", value: "shot " },
      { kind: "image", alt: "cap", src },
      { kind: "text", value: " end" },
    ]);
  });

  it("rejects unsafe image schemes", () => {
    expect(parseInline("![x](javascript:alert(1))")).toEqual([
      { kind: "image", alt: "x", src: "" },
    ]);
  });
});

describe("parseBlocks", () => {
  it("parses headings, lists, and paragraphs without shade metadata", () => {
    const blocks = parseBlocks("# Title\n\n- one\n- two\n\nbody line");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, children: [{ kind: "text", value: "Title" }] },
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", value: "one" }], [{ kind: "text", value: "two" }]],
      },
      { kind: "paragraph", children: [{ kind: "text", value: "body line" }] },
    ]);
  });

  it("parses fenced code blocks", () => {
    const blocks = parseBlocks("```ts\nconst x = 1\n```");
    expect(blocks).toEqual([{ kind: "code", lang: "ts", value: "const x = 1" }]);
  });

  it("parses the sample note as a uniform list (no head/body split)", () => {
    const source = "- Tower Goals + Junto\n- Junto notes with tasks / state";
    const blocks = parseBlocks(source);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: false });
    if (blocks[0]?.kind === "list") {
      expect(blocks[0].items).toHaveLength(2);
    }
  });

  it("parses a sole image line as an image block", () => {
    const src =
      "junto-content://object/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?byteLength=4&mediaType=image%2Fpng";
    const blocks = parseBlocks(`# Title\n\n![diagram](${src})\n\nbody`);
    expect(blocks).toEqual([
      {
        kind: "heading",
        level: 1,
        children: [{ kind: "text", value: "Title" }],
      },
      { kind: "image", alt: "diagram", src },
      { kind: "paragraph", children: [{ kind: "text", value: "body" }] },
    ]);
  });
});
