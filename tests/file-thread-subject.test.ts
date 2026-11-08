/**
 * A file's thread (0.11 F7): the subject names the Files node and a path
 * inside it, and its anchor finds its place again after the file is edited,
 * because the anchor quotes the lines it was written on.
 */
import { describe, expect, it } from "vitest";
import { asNodeId } from "../src/shared/physics/schema";
import {
  cutLinesQuote,
  locateLines,
  LINES_QUOTE_MAX,
  quoteOfLines,
  sameSubject,
  subjectLabel,
  subjectNodeOf,
  threadSubjectMetadata,
  threadSubjectOf,
  type ResourceSubject,
} from "../src/shared/thread-subject";

const NODE = asNodeId("files-01M5");

const file = (path: string, extra: Partial<Extract<ResourceSubject, { readonly kind: "file" }>> = {}): ResourceSubject => ({
  kind: "file",
  nodeId: NODE,
  path,
  ...extra,
});

const SOURCE = ["const a = 1;", "", "export const b = (x: number): number => {", "  return x * 2;", "};", ""].join("\n");

describe("a file's thread subject", () => {
  it("reads back as written, held at the Files node, and named by its path", () => {
    const subject = file("src/b.ts", { anchor: { kind: "lines", file: "src/b.ts", from: 3, to: 5, quote: "export const b" } });
    expect(threadSubjectOf({ metadata: { factoryMail: true, ...threadSubjectMetadata(subject) } })).toEqual(subject);
    expect(subjectNodeOf(subject)).toBe(NODE);
    expect(subjectLabel(subject)).toBe(`file src/b.ts in ${NODE} (src/b.ts:3-5)`);
    expect(subjectLabel(file("docs/a.pdf", { anchor: { kind: "pageBox", page: 2, x: 0, y: 0, w: 1, h: 1 } }))).toBe(`file docs/a.pdf in ${NODE} (page 2, a box)`);
  });

  it("tells two files in one node apart, and the same file's two places apart", () => {
    expect(sameSubject(file("a.ts"), file("b.ts"))).toBe(false);
    expect(sameSubject(file("a.ts"), file("a.ts"))).toBe(true);
    expect(sameSubject(file("a.ts", { anchor: { kind: "lines", file: "a.ts", from: 1, to: 1 } }), file("a.ts"))).toBe(false);
  });

  it("refuses an absolute path, a way out, and a box off its page", () => {
    for (const held of [
      { kind: "file", nodeId: NODE, path: "/Users/me/secret.ts" },
      { kind: "file", nodeId: NODE, path: "../outside.ts" },
      { kind: "file", nodeId: NODE, path: "a/../../b" },
      { kind: "file", nodeId: NODE, path: "a.pdf", anchor: { kind: "pageBox", page: 1, x: 0.7, y: 0, w: 0.5, h: 0.1 } },
    ]) {
      expect(threadSubjectOf({ metadata: { threadSubject: held } }), JSON.stringify(held)).toBeUndefined();
    }
  });
});

describe("a lines anchor's quote", () => {
  it("is the lines as the file holds them, cut to the bound from their start", () => {
    expect(quoteOfLines(SOURCE, 3, 5)).toBe("export const b = (x: number): number => {\n  return x * 2;\n};");
    expect(quoteOfLines(SOURCE, 2, 2)).toBeUndefined();
    expect(quoteOfLines(SOURCE, 1, 99)).toBeUndefined();
    expect(quoteOfLines(`${"x".repeat(LINES_QUOTE_MAX)}y`, 1, 1)).toBe("x".repeat(LINES_QUOTE_MAX));
  });

  it("finds its lines again after an edit moved them, and says so when they are gone", () => {
    const quoted = { from: 3, to: 5, quote: quoteOfLines(SOURCE, 3, 5) };
    expect(locateLines(quoted, SOURCE)).toEqual({ from: 3, to: 5 });
    const grown = `// a header\n// another\n\n${SOURCE}`;
    expect(locateLines(quoted, grown)).toEqual({ from: 6, to: 8 });
    const edited = SOURCE.replace("return x * 2;", "return x * 3;");
    expect(locateLines(quoted, edited)).toBeUndefined();
    // A comment written before the quote was carried stays where it says.
    expect(locateLines({ from: 9, to: 10 }, SOURCE)).toEqual({ from: 9, to: 10 });
  });

  it("never matches a piece of a longer line", () => {
    // "foo" is gone as a line, but foobar() still holds the word: the thread reads gone, not moved onto it.
    const after = "const x = 1;\nfoobar();\n";
    expect(locateLines({ from: 1, to: 1, quote: "foo" }, after)).toBeUndefined();
    expect(locateLines({ from: 2, to: 2, quote: "foobar();" }, after)).toEqual({ from: 2, to: 2 });
  });

  it("cuts a quote at a whole character", () => {
    const quoted = cutLinesQuote(`${"x".repeat(LINES_QUOTE_MAX - 1)}😀tail`);
    expect(quoted).toBe("x".repeat(LINES_QUOTE_MAX - 1));
  });

  it("picks the copy nearest where the comment was, when the text repeats", () => {
    const twice = "a();\nb();\na();\nb();\n";
    expect(locateLines({ from: 1, to: 2, quote: "a();\nb();" }, twice)).toEqual({ from: 1, to: 2 });
    expect(locateLines({ from: 3, to: 4, quote: "a();\nb();" }, twice)).toEqual({ from: 3, to: 4 });
  });

  it("reads a quote written with plain newlines in a CRLF file, and counts its lines right", () => {
    const crlf = SOURCE.replace(/\n/gu, "\r\n");
    expect(locateLines({ from: 3, to: 5, quote: quoteOfLines(SOURCE, 3, 5) }, crlf)).toEqual({ from: 3, to: 5 });
    expect(locateLines({ from: 3, to: 5, quote: quoteOfLines(SOURCE, 3, 5) }, `one\r\ntwo\r\n${crlf}`)).toEqual({ from: 5, to: 7 });
  });
});
