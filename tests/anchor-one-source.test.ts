import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AnchorFor, ArtifactAnchor } from "../src/shared/artifact";
import { type Anchor, type PageBoxAnchor, ThreadSubject } from "../src/shared/thread-subject";

// pty-lead and product-shell, 2026-10-21: thread-subject.ts owns Anchor.
// artifact.ts defines no anchor shape of its own; it narrows Anchor per type.
describe("one anchor", () => {
  it("an artifact anchor is the thread anchor without lines", () => {
    expectTypeOf<ArtifactAnchor>().toEqualTypeOf<Exclude<Anchor, { readonly kind: "lines" }>>();
  });

  it("every per-type anchor is a thread anchor", () => {
    expectTypeOf<AnchorFor<"link">>().toExtend<Anchor>();
    expectTypeOf<AnchorFor<"document">>().toExtend<Anchor>();
    expectTypeOf<AnchorFor<"pad">>().toExtend<Anchor>();
    expectTypeOf<AnchorFor<"sheet">>().toExtend<Anchor>();
    expectTypeOf<AnchorFor<"file">>().toExtend<Anchor>();
  });

  it("a subject's anchor is a place, never whole: an artifact's an artifact anchor, a page's its box", () => {
    type AnchorOf<K extends "artifact" | "page"> = NonNullable<Extract<ThreadSubject, { kind: K }>["anchor"]>;
    expectTypeOf<AnchorOf<"artifact">>().toEqualTypeOf<Exclude<ArtifactAnchor, { readonly kind: "whole" }>>();
    expectTypeOf<AnchorOf<"page">>().toEqualTypeOf<PageBoxAnchor>();
  });

  it("decodes one spelling per place and refuses what the artifact anchor refuses", () => {
    const is = Schema.is(ThreadSubject);
    const artifact = { kind: "artifact", nodeId: "artifacts-1", artifactId: "01M5EVKRB1X4P80GXRGDK8V5AS" };
    expect(is(artifact)).toBe(true);
    expect(is({ ...artifact, anchor: { kind: "whole" } })).toBe(false);
    expect(is({ ...artifact, anchor: { kind: "lines", file: "a.ts", from: 1, to: 2 } })).toBe(false);
    expect(is({ ...artifact, anchor: { kind: "box", x: 0, y: 0, w: 0, h: 1 } })).toBe(false);
    expect(is({ ...artifact, anchor: { kind: "cells", range: "C4:A1" } })).toBe(false);
    expect(is({ ...artifact, anchor: { kind: "cells", range: "A1:C4" } })).toBe(true);
    expect(is({ kind: "page", nodeId: "page-1", anchor: { kind: "whole" } })).toBe(false);
    expect(is({ kind: "page", nodeId: "page-1", anchor: { kind: "lines", file: "a.ts", from: 1, to: 2 } })).toBe(false);
  });
});
