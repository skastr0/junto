import { describe, expect, it } from "vitest";
import {
  previewBeforeAfter,
  previewComparePair,
  previewLinkedMarkdown,
  previewLinkIndex,
  previewMarkdownText,
  previewRefsIn,
} from "@shared/preview";

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

describe("previewBeforeAfter", () => {
  it("is undefined unless the agent labelled both", () => {
    expect(previewBeforeAfter(previewRefsIn("/t/a.png /t/b.png"))).toBeUndefined();
    expect(previewBeforeAfter(previewRefsIn("Before: /t/a.png\nCanvas: /t/b.png"))).toBeUndefined();
  });
});

describe("previewMarkdownText", () => {
  it("turns a local markdown image into its words and path, never an image", () => {
    expect(previewMarkdownText("![Before](/tmp/a.png)")).toBe("Before: `/tmp/a.png`");
    expect(previewMarkdownText("![](/tmp/a.png)")).toBe("`/tmp/a.png`");
  });

  it("turns a remote markdown image into a link, so nothing is fetched until the operator opens it", () => {
    expect(previewMarkdownText("![chart](https://example.com/a.png)")).toBe("[chart](https://example.com/a.png)");
    expect(previewMarkdownText("![](https://example.com/a.png)")).toBe(
      "[https://example.com/a.png](https://example.com/a.png)",
    );
  });

  it("names the same paths after the rewrite, so main serves what the card shows", () => {
    const source = "![Before](/tmp/a.png) then ![After](</tmp/my shots/b.png>)";
    expect(previewRefsIn(previewMarkdownText(source)).map((ref) => ref.path)).toEqual(
      previewRefsIn(source).map((ref) => ref.path),
    );
  });

  it("leaves everything else as written", () => {
    const text = "Plain [link](https://x.dev) and `code` and ![content](junto-content://abc)";
    expect(previewMarkdownText(text)).toBe(text);
  });
});

describe("previewLinkedMarkdown", () => {
  const text = [
    "- Before: /tmp/shots/before.png",
    "- After: `/tmp/shots/after.png`.",
    "- ![Rail](/tmp/shots/rail.png) and [the notes](/tmp/shots/notes.md)",
    "- Gone: /tmp/shots/gone.png, sorry.",
  ].join("\n");

  it("shows a claimed path as its file name, linked to its preview, the full path as the title", () => {
    const claimed = new Set(["/tmp/shots/before.png", "/tmp/shots/after.png", "/tmp/shots/rail.png", "/tmp/shots/notes.md"]);
    expect(previewLinkedMarkdown(text, claimed).split("\n")).toEqual([
      '- Before: [before.png](#preview-0 "/tmp/shots/before.png")',
      '- After: [after.png](#preview-1 "/tmp/shots/after.png").',
      '- Rail: [rail.png](#preview-2 "/tmp/shots/rail.png") and [the notes](#preview-3 "/tmp/shots/notes.md")',
      "- Gone: /tmp/shots/gone.png, sorry.",
    ]);
  });

  it("leaves a path nobody claimed as the agent wrote it", () => {
    expect(previewLinkedMarkdown(text, new Set())).toBe(previewMarkdownText(text));
    expect(previewLinkedMarkdown("see /tmp/a.png", new Set(["/tmp/other.png"]))).toBe("see /tmp/a.png");
  });

  it("links every mention of a claimed path to the same preview", () => {
    expect(previewLinkedMarkdown("/tmp/a.png then /tmp/b.png then /tmp/a.png", new Set(["/tmp/a.png"]))).toBe(
      '[a.png](#preview-0 "/tmp/a.png") then /tmp/b.png then [a.png](#preview-0 "/tmp/a.png")',
    );
  });

  it("keeps a file name from turning into markdown", () => {
    expect(previewLinkedMarkdown("/tmp/rail_v2_final.png", new Set(["/tmp/rail_v2_final.png"]))).toBe(
      '[rail\\_v2\\_final.png](#preview-0 "/tmp/rail_v2_final.png")',
    );
  });

  it("reads the index back off a link and nothing else", () => {
    expect(previewLinkIndex("#preview-3")).toBe(3);
    expect(previewLinkIndex("#preview-x")).toBeUndefined();
    expect(previewLinkIndex("#section")).toBeUndefined();
    expect(previewLinkIndex(undefined)).toBeUndefined();
  });
});

describe("a bare path with spaces", () => {
  it("reads a screenshot name as one path, marked loose", () => {
    const refs = previewRefsIn("Shot: /Users/me/Desktop/Screenshot 2026-10-05 at 19.20.11.png, taken now");
    expect(refs).toEqual([
      {
        path: "/Users/me/Desktop/Screenshot 2026-10-05 at 19.20.11.png",
        name: "Screenshot 2026-10-05 at 19.20.11.png",
        kind: "image",
        caption: "Shot",
        loose: true,
      },
    ]);
  });

  it("never swallows a file that stands by itself, or the start of another path", () => {
    expect(previewRefsIn("/tmp/a.txt is shown in shot.png").map((ref) => ref.path)).toEqual(["/tmp/a.txt"]);
    expect(previewRefsIn("Before: /tmp/a.png, after: /tmp/b.png").map((ref) => ref.path)).toEqual([
      "/tmp/a.png",
      "/tmp/b.png",
    ]);
    expect(previewRefsIn("/tmp/my dir /tmp/b.png").map((ref) => ref.path)).toEqual(["/tmp/b.png"]);
  });

  it("links it like any other claimed path", () => {
    const path = "/tmp/with space/bare shot.png";
    expect(previewLinkedMarkdown(`See ${path} now`, new Set([path]))).toBe(
      `See [bare shot.png](#preview-0 "${path}") now`,
    );
  });
});
