import { Result } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  admitsAnchor,
  type AnchorFor,
  type ArtifactBody,
  type ArtifactEdit,
  type ArtifactEditErrorCode,
  ArtifactVersion,
  type BodyOf,
  decodeArtifactBody,
  decodeArtifactEdit,
  type EditFor,
  emptyBody,
  FIRST_ARTIFACT_VERSION,
  type PatchableArtifactType,
  patchKeys,
  ruleArtifactEdit,
  type SheetPatch,
  type SheetPatchEdit,
} from "../src/shared/artifact";
import type { ContentRef } from "../src/shared/content";
import { asPadElementId } from "../src/shared/pad";

const v = (n: number): ArtifactVersion => ArtifactVersion.make(n);

const sheet = emptyBody("sheet");
const doc = (markdown: string): BodyOf<"document"> => ({ type: "document", markdown });
const file = (mediaType: string): BodyOf<"file"> => ({
  type: "file",
  content: { sha256: "0".repeat(64), byteLength: 1, mediaType } as unknown as ContentRef,
});

const sheetEdit = (baseVersion: number, ...patches: [SheetPatch, ...SheetPatch[]]): SheetPatchEdit => ({
  kind: "patch",
  type: "sheet",
  baseVersion: v(baseVersion),
  patches,
});

const shape = (id: string) =>
  ({ op: "upsert", layer: "shape", shape: { id: asPadElementId(id), type: "box", x: 0, y: 0, w: 1, h: 1, z: 0 } }) as const;
const padEdit = (baseVersion: number, ...ids: string[]): ArtifactEdit => ({
  kind: "patch",
  type: "pad",
  baseVersion: v(baseVersion),
  patches: ids.map(shape) as unknown as [ReturnType<typeof shape>],
});

const codeOf = (result: ReturnType<typeof ruleArtifactEdit>): ArtifactEditErrorCode | "ok" =>
  Result.isFailure(result) ? result.failure.code : "ok";

describe("artifact edits on the head", () => {
  it("moves the head one version per applied edit", () => {
    const ruled = ruleArtifactEdit({ version: v(3), body: doc("abc") }, {
      kind: "patch",
      type: "document",
      baseVersion: v(3),
      patches: [{ op: "splice", at: 1, remove: 1, insert: "XY" }],
    });
    expect(Result.isSuccess(ruled) && ruled.success).toEqual({ version: 4, body: doc("aXYc") });
  });

  it("refuses an edit for another type", () => {
    expect(codeOf(ruleArtifactEdit({ version: v(1), body: doc("") }, sheetEdit(1, { op: "row.add", rowId: "r2" })))).toBe(
      "type_mismatch",
    );
    expect(
      codeOf(ruleArtifactEdit({ version: v(1), body: doc("") }, { kind: "replace", baseVersion: v(1), body: sheet })),
    ).toBe("type_mismatch");
  });

  it("refuses a base after the head and names the head", () => {
    const ruled = ruleArtifactEdit({ version: v(2), body: doc("") }, {
      kind: "replace",
      baseVersion: v(5),
      body: doc("x"),
    });
    expect(Result.isFailure(ruled) && [ruled.failure.code, ruled.failure.expected]).toEqual(["future_base", 2]);
  });

  it("refuses a replace against an old base as stale, with the head, always", () => {
    const head = { version: v(3), body: doc("abc") };
    const since: ArtifactEdit[] = [
      { kind: "replace", baseVersion: v(1), body: doc("a") },
      { kind: "replace", baseVersion: v(2), body: doc("abc") },
    ];
    const ruled = ruleArtifactEdit(head, { kind: "replace", baseVersion: v(1), body: doc("zzz") }, since);
    expect(Result.isFailure(ruled) && [ruled.failure.code, ruled.failure.expected]).toEqual(["stale", 3]);
  });

  it("never rebases a document text patch", () => {
    const head = { version: v(2), body: doc("abcdef") };
    const prior: ArtifactEdit = {
      kind: "patch",
      type: "document",
      baseVersion: v(1),
      patches: [{ op: "splice", at: 5, remove: 1, insert: "F" }],
    };
    const mine: ArtifactEdit = {
      kind: "patch",
      type: "document",
      baseVersion: v(1),
      patches: [{ op: "splice", at: 0, remove: 1, insert: "A" }],
    };
    expect(codeOf(ruleArtifactEdit(head, mine, [prior]))).toBe("stale");
  });

  it("is stale when the edits since the base are not all supplied", () => {
    const head = { version: v(3), body: sheet };
    const mine = sheetEdit(1, { op: "cell", rowId: "r1", columnId: "c1", value: "x" });
    expect(codeOf(ruleArtifactEdit(head, mine, [sheetEdit(1, { op: "row.add", rowId: "r9" })]))).toBe("stale");
  });

  it("refuses a splice past the end instead of clamping", () => {
    const ruled = ruleArtifactEdit({ version: v(1), body: doc("ab") }, {
      kind: "patch",
      type: "document",
      baseVersion: v(1),
      patches: [{ op: "splice", at: 2, remove: 1, insert: "" }],
    });
    expect(codeOf(ruled)).toBe("invalid");
  });

  it("refuses a replace whose body does not decode", () => {
    const ruled = ruleArtifactEdit({ version: v(1), body: doc("") }, {
      kind: "replace",
      baseVersion: v(1),
      body: { type: "document", markdown: "x".repeat(600_000) },
    });
    expect(codeOf(ruled)).toBe("invalid");
  });
});

describe("sheet patches", () => {
  const head = { version: v(1), body: sheet };

  it("refuses a miss instead of ignoring it", () => {
    expect(codeOf(ruleArtifactEdit(head, sheetEdit(1, { op: "cell", rowId: "nope", columnId: "c1", value: "x" })))).toBe(
      "missing",
    );
    expect(codeOf(ruleArtifactEdit(head, sheetEdit(1, { op: "column.remove", columnId: "nope" })))).toBe("missing");
  });

  it("refuses an id that is already there", () => {
    expect(codeOf(ruleArtifactEdit(head, sheetEdit(1, { op: "row.add", rowId: "r1" })))).toBe("duplicate_id");
    expect(codeOf(ruleArtifactEdit(head, sheetEdit(1, { op: "column.add", columnId: "c1", name: "A" })))).toBe(
      "duplicate_id",
    );
  });

  it("lets a later patch in the same edit name a row an earlier one added", () => {
    const ruled = ruleArtifactEdit(
      head,
      sheetEdit(1, { op: "row.add", rowId: "r2" }, { op: "cell", rowId: "r2", columnId: "c2", value: "hi" }),
    );
    expect(Result.isSuccess(ruled) && ruled.success.body).toMatchObject({
      grid: { rows: [{ id: "r1" }, { id: "r2", cells: { c2: "hi" } }] },
    });
  });

  it("clears a cell on blank text and drops a removed column from every row", () => {
    const filled = ruleArtifactEdit(head, sheetEdit(1, { op: "cell", rowId: "r1", columnId: "c1", value: "x" }));
    if (!Result.isSuccess(filled)) throw new Error("fill failed");
    const cleared = ruleArtifactEdit(filled.success, sheetEdit(2, { op: "cell", rowId: "r1", columnId: "c1", value: "  " }));
    expect(Result.isSuccess(cleared) && cleared.success.body).toMatchObject({ grid: { rows: [{ cells: {} }] } });
    const removed = ruleArtifactEdit(filled.success, sheetEdit(2, { op: "column.remove", columnId: "c1" }));
    expect(Result.isSuccess(removed) && removed.success.body).toMatchObject({
      grid: { columns: [{ id: "c2" }], rows: [{ cells: {} }] },
    });
  });
});

describe("rebase", () => {
  const head = { version: v(2), body: { ...sheet, grid: { ...sheet.grid, rows: [{ id: "r1", cells: {} }, { id: "r2", cells: {} }] } } };

  it("applies a sheet cell edit against an old base when only other cells changed", () => {
    const prior = sheetEdit(1, { op: "cell", rowId: "r1", columnId: "c2", value: "theirs" });
    const mine = sheetEdit(1, { op: "cell", rowId: "r1", columnId: "c1", value: "mine" });
    const ruled = ruleArtifactEdit(head, mine, [prior]);
    expect(Result.isSuccess(ruled) && ruled.success.version).toBe(3);
  });

  it("is a rebase conflict when both write the same cell", () => {
    const prior = sheetEdit(1, { op: "cell", rowId: "r1", columnId: "c1", value: "theirs" });
    const mine = sheetEdit(1, { op: "cell", rowId: "r1", columnId: "c1", value: "mine" });
    expect(codeOf(ruleArtifactEdit(head, mine, [prior]))).toBe("rebase_conflict");
  });

  it("is a rebase conflict when the row or column under the cell was changed", () => {
    const mine = sheetEdit(1, { op: "cell", rowId: "r2", columnId: "c1", value: "mine" });
    expect(codeOf(ruleArtifactEdit(head, mine, [sheetEdit(1, { op: "row.remove", rowId: "r2" })]))).toBe(
      "rebase_conflict",
    );
    expect(codeOf(ruleArtifactEdit(head, mine, [sheetEdit(1, { op: "column.rename", columnId: "c1", name: "B" })]))).toBe(
      "rebase_conflict",
    );
  });

  it("is stale behind any replace", () => {
    const mine = sheetEdit(1, { op: "cell", rowId: "r1", columnId: "c1", value: "mine" });
    expect(codeOf(ruleArtifactEdit(head, mine, [{ kind: "replace", baseVersion: v(1), body: head.body }]))).toBe("stale");
  });

  it("rebases pad patches on disjoint elements only", () => {
    const padHead = { version: v(2), body: emptyBody("pad") };
    const prior = padEdit(1, "a");
    expect(codeOf(ruleArtifactEdit(padHead, padEdit(1, "b"), [prior]))).toBe("ok");
    expect(codeOf(ruleArtifactEdit(padHead, padEdit(1, "a"), [prior]))).toBe("rebase_conflict");
  });

  it("keys a replace and a document patch as touching everything", () => {
    expect(patchKeys({ kind: "replace", baseVersion: v(1), body: doc("") })).toBe("all");
    expect(
      patchKeys({ kind: "patch", type: "document", baseVersion: v(1), patches: [{ op: "splice", at: 0, remove: 0, insert: "" }] }),
    ).toBe("all");
  });
});

describe("anchors", () => {
  it("admits only the anchor kinds of the artifact's type", () => {
    expect(admitsAnchor(doc("x"), { kind: "text", quote: "x" })).toBe(true);
    expect(admitsAnchor(doc("x"), { kind: "cells", range: "A1" })).toBe(false);
    expect(admitsAnchor(sheet, { kind: "cells", range: "A1:C4" })).toBe(true);
    expect(admitsAnchor(sheet, { kind: "box", x: 0, y: 0, w: 1, h: 1 })).toBe(false);
    expect(admitsAnchor(emptyBody("pad"), { kind: "box", x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    for (const body of [doc(""), sheet, emptyBody("pad"), file("text/plain")] as ArtifactBody[]) {
      expect(admitsAnchor(body, { kind: "whole" })).toBe(true);
    }
  });

  it("admits a box on a file only when the file is an image", () => {
    expect(admitsAnchor(file("image/png"), { kind: "box", x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(admitsAnchor(file("application/pdf"), { kind: "box", x: 0, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it("refuses a cell range that is not A1 notation", () => {
    for (const range of ["a1", "A0", "1A", "A1:", "AAAA1", "A1:B2:C3"]) {
      expect(admitsAnchor(sheet, { kind: "cells", range })).toBe(false);
    }
  });
});

describe("decoding at the boundary", () => {
  it("refuses excess properties, pins on a pad and a non-http link", () => {
    expect(Result.isFailure(decodeArtifactBody({ type: "document", markdown: "", extra: 1 }))).toBe(true);
    const pinned = emptyBody("pad");
    expect(Result.isSuccess(decodeArtifactBody(pinned))).toBe(true);
    expect(Result.isFailure(decodeArtifactBody({ ...pinned, pad: { ...pinned.pad, pins: [{}] } }))).toBe(true);
    expect(Result.isFailure(decodeArtifactBody({ type: "link", target: { kind: "url", url: "file:///etc/passwd" } }))).toBe(
      true,
    );
    expect(Result.isSuccess(decodeArtifactBody({ type: "link", target: { kind: "url", url: "https://a.example/" } }))).toBe(
      true,
    );
  });

  it("refuses an empty patch list, a patch on a link and a version below 1", () => {
    expect(Result.isFailure(decodeArtifactEdit({ kind: "patch", type: "sheet", baseVersion: 1, patches: [] }))).toBe(true);
    expect(
      Result.isFailure(decodeArtifactEdit({ kind: "patch", type: "link", baseVersion: 1, patches: [{ op: "splice" }] })),
    ).toBe(true);
    expect(Result.isFailure(decodeArtifactEdit({ kind: "replace", baseVersion: 0, body: { type: "document", markdown: "" } }))).toBe(
      true,
    );
  });

  it("starts every artifact at version 1 with an empty body that decodes", () => {
    expect(FIRST_ARTIFACT_VERSION).toBe(1);
    for (const type of ["document", "pad", "sheet"] as const) {
      expect(Result.isSuccess(decodeArtifactBody(emptyBody(type)))).toBe(true);
    }
  });
});

describe("type level", () => {
  it("lets only pad, sheet and document take patches", () => {
    expectTypeOf<PatchableArtifactType>().toEqualTypeOf<"pad" | "sheet" | "document">();
    expectTypeOf<Extract<EditFor<"link">, { kind: "patch" }>>().toBeNever();
    expectTypeOf<Extract<EditFor<"file">, { kind: "patch" }>>().toBeNever();
  });

  it("ties a replace to its own type's body", () => {
    const ok: EditFor<"document"> = { kind: "replace", baseVersion: v(1), body: doc("") };
    // @ts-expect-error: a document's replace cannot carry a sheet body.
    const wrong: EditFor<"document"> = { kind: "replace", baseVersion: v(1), body: sheet };
    // @ts-expect-error: a sheet patch is not an edit for a document.
    const patch: EditFor<"document"> = sheetEdit(1, { op: "row.add", rowId: "r2" });
    void [ok, wrong, patch];
  });

  it("ties anchors to the type", () => {
    expectTypeOf<AnchorFor<"link">["kind"]>().toEqualTypeOf<"whole">();
    expectTypeOf<AnchorFor<"document">["kind"]>().toEqualTypeOf<"whole" | "text">();
    expectTypeOf<AnchorFor<"sheet">["kind"]>().toEqualTypeOf<"whole" | "cells">();
    // @ts-expect-error: a sheet takes no box.
    const box: AnchorFor<"sheet"> = { kind: "box", x: 0, y: 0, w: 1, h: 1 };
    void box;
  });

  it("brands versions so a bare number never stands in", () => {
    // @ts-expect-error: a bare number is not a version.
    const version: ArtifactVersion = 2;
    void version;
    // @ts-expect-error: an empty body is only for types that have one.
    emptyBody("link");
  });
});
