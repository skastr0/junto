/**
 * `[[Title]]` as a seat types it (plan 0.11, 02, L5): found only in prose,
 * rewritten in every text a write carries, and a document's patches keep
 * the seat's splices and gain one link splice per token they wrote.
 */
import { describe, expect, it } from "vitest";
import { Result } from "effect";
import type { ArtifactBody, ArtifactEdit, ArtifactVersion, TextPatch } from "../src/shared/artifact";
import {
  artifactLinkTokensOf,
  editTexts,
  linkBodyTitles,
  linkEditTitles,
} from "../src/shared/artifact-link-tokens";

const link = (title: string) => `<${title.toUpperCase()}>`;
const resolve = (title: string) => (title === "nope" ? Result.fail(`no ${title}`) : Result.succeed(link(title)));
const v1 = 1 as ArtifactVersion;
/** Splices in order, as the ruler applies them. */
const spliceAll = (markdown: string, patches: ReadonlyArray<TextPatch>): string =>
  patches.reduce((text, patch) => text.slice(0, patch.at) + patch.insert + text.slice(patch.at + patch.remove), markdown);
const ok = <A>(result: Result.Result<A, unknown>): A => {
  if (Result.isFailure(result)) throw new Error(JSON.stringify(result.failure));
  return result.success;
};

describe("[[Title]] tokens", () => {
  it("reads titles in prose only: not in code, not escaped, not in a link already written", () => {
    const text = [
      "see [[Launch plan]] and [[ Budget ]]",
      "`[[in code]]` and \\[[escaped]] and [[]] and [[ ]]",
      "```",
      "[[fenced]]",
      "```",
      "[\\[\\[Stored\\]\\]](junto://canvas/factory?node=a&item=01M5ESMQ2ZT55QZ073EWPH10SG)",
    ].join("\n");
    expect(artifactLinkTokensOf(text).map((token) => token.title)).toEqual(["Launch plan", " Budget "]);
    const [first] = artifactLinkTokensOf(text);
    expect(text.slice(first!.start, first!.end)).toBe("[[Launch plan]]");
  });

  it("links a document, a pad's shape text and a sheet's cells, and the first refused title refuses the body", () => {
    expect(ok(linkBodyTitles({ type: "document", markdown: "a [[x]] b [[x]]" }, resolve))).toEqual({ type: "document", markdown: "a <X> b <X>" });
    const sheet: ArtifactBody = { type: "sheet", grid: { columns: [{ id: "c1", name: "A" }], rows: [{ id: "r1", cells: { c1: "[[y]]" } }] } };
    expect(ok(linkBodyTitles(sheet, resolve))).toMatchObject({ grid: { rows: [{ cells: { c1: "<Y>" } }] } });
    const pad = { type: "pad", pad: { revision: 0, images: [], edges: [], inks: [], shapes: [{ id: "s1", type: "rect", x: 0, y: 0, w: 1, h: 1, z: 0, text: "[[z]]" }] } } as unknown as ArtifactBody;
    expect(ok(linkBodyTitles(pad, resolve))).toMatchObject({ pad: { shapes: [{ text: "<Z>" }] } });
    expect(linkBodyTitles({ type: "document", markdown: "[[nope]] [[x]]" }, resolve)).toEqual(Result.fail("no nope"));
  });

  it("resolves each title once", () => {
    const asked: string[] = [];
    ok(linkBodyTitles({ type: "document", markdown: "[[x]] [[ x ]] [[y]]" }, (title) => {
      asked.push(title);
      return Result.succeed(link(title));
    }));
    expect(asked).toEqual(["x", "y"]);
  });

  it("keeps a document's splices and links each token they wrote, last first, leaving a token already there", () => {
    const head: ArtifactBody = { type: "document", markdown: "old [[kept]] text" };
    const edit: ArtifactEdit = {
      kind: "patch",
      type: "document",
      baseVersion: v1,
      patches: [
        { op: "splice", at: 0, remove: 0, insert: "[[a]] " },
        { op: "splice", at: 6, remove: 3, insert: "new [[b]]" },
        // Closes a token the first splice did not write whole.
        { op: "splice", at: 0, remove: 0, insert: "[[c" },
        { op: "splice", at: 3, remove: 0, insert: "]]" },
      ],
    };
    const linked = ok(linkEditTitles(edit, head, resolve));
    expect(linked.kind === "patch" && linked.patches.slice(0, 4)).toEqual(edit.patches);
    if (linked.kind !== "patch" || linked.type !== "document") throw new Error("a document patch");
    expect(spliceAll("old [[kept]] text", edit.patches)).toBe("[[c]][[a]] new [[b]] [[kept]] text");
    expect(spliceAll("old [[kept]] text", linked.patches)).toBe("<C><A> new <B> [[kept]] text");
  });

  it("links a sheet's cell patches and a pad's shape upserts", () => {
    const sheet: ArtifactEdit = { kind: "patch", type: "sheet", baseVersion: v1, patches: [{ op: "cell", rowId: "r1", columnId: "c1", value: "[[x]]" }, { op: "row.add", rowId: "r2" }] };
    expect(ok(linkEditTitles(sheet, null, resolve))).toMatchObject({ patches: [{ value: "<X>" }, { op: "row.add" }] });
    expect(editTexts(sheet)).toEqual(["[[x]]"]);
    const shape = { id: "s1", type: "rect", x: 0, y: 0, w: 1, h: 1, z: 0, text: "[[x]]" };
    const pad = { kind: "patch", type: "pad", baseVersion: v1, patches: [{ op: "upsert", layer: "shape", shape }, { op: "delete", id: "s2" }] } as unknown as ArtifactEdit;
    expect(ok(linkEditTitles(pad, null, resolve))).toMatchObject({ patches: [{ shape: { text: "<X>" } }, { op: "delete" }] });
  });
});
