/**
 * Q2 (docs/plans/0.11/11-quick-capture.md): a capture's title from its first
 * line, and its words kept across a type switch.
 */
import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { decodeArtifactBody, type ArtifactBody } from "../src/shared/artifact";
import { mentionHref } from "../src/shared/mention";
import type { NodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";
import { captureTitleOf, convertCapture, isEmptyCapture, UNTITLED_CAPTURE } from "../src/renderer/components/capture/capture-model";

const doc = (markdown: string): ArtifactBody => ({ type: "document", markdown });
const valid = (body: ArtifactBody): ArtifactBody => {
  const decoded = decodeArtifactBody(body);
  expect(Result.isSuccess(decoded)).toBe(true);
  return body;
};

describe("a capture's title", () => {
  it("is the first line with words, read plain", () => {
    expect(captureTitleOf("\n\n# Call **Ana** about `rates`\nmore")).toBe("Call Ana about rates");
    expect(captureTitleOf("- [ ] buy [[Milk run]]")).toBe("buy Milk run");
    const href = mentionHref({ kind: "artifact", nodeId: "A" as NodeId, artifactId: "01M639AA000000000000000001" as ItemId }, "factory");
    expect(captureTitleOf(`see [Plan](${href}) today`)).toBe("see Plan today");
  });

  it("is none for nothing written, cut to the title bound otherwise", () => {
    expect(captureTitleOf("  \n \n")).toBeUndefined();
    expect(captureTitleOf("x".repeat(300))).toHaveLength(200);
    expect(UNTITLED_CAPTURE).toBe("Untitled capture");
  });
});

describe("a type switch", () => {
  it("of an empty capture just changes its type", () => {
    expect(isEmptyCapture(doc(" \n"))).toBe(true);
    expect(valid(convertCapture(doc(""), "sheet")).type).toBe("sheet");
    expect(isEmptyCapture(convertCapture(doc(""), "pad"))).toBe(true);
  });

  it("keeps a document's text as one pad text box", () => {
    const pad = valid(convertCapture(doc("one\ntwo\n\nthree\n"), "pad"));
    expect(pad.type === "pad" && pad.pad.shapes.map((shape) => [shape.type, shape.text])).toEqual([["label", "one\ntwo\n\nthree"]]);
  });

  it("keeps a document's lines as sheet rows, and the sheet's rows as lines going back", () => {
    const sheet = valid(convertCapture(doc("milk\n\neggs\tsix\nbread"), "sheet"));
    expect(sheet.type === "sheet" && sheet.grid.rows.map((row) => row.cells)).toEqual([{ c1: "milk" }, { c1: "eggs", c2: "six" }, { c1: "bread" }]);
    expect(convertCapture(sheet, "document")).toEqual(doc("milk\neggs\tsix\nbread"));
  });

  it("brings a pad's text boxes back as lines, top to bottom", () => {
    expect(convertCapture(convertCapture(doc("a\nb"), "pad"), "document")).toEqual(doc("a\nb"));
  });
});
