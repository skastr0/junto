import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AnchorFor, ArtifactAnchor } from "../src/shared/artifact";
import { type Anchor, type FileBoxAnchor, type LinesAnchor, type PageBoxAnchor, ThreadSubject } from "../src/shared/thread-subject";

// pty-lead and product-shell, 2026-10-21: thread-subject.ts owns Anchor.
// artifact.ts defines no anchor shape of its own; it narrows Anchor per type.
describe("one anchor", () => {
  it("an artifact anchor is the thread anchor without a file's places", () => {
    expectTypeOf<ArtifactAnchor>().toEqualTypeOf<Exclude<Anchor, { readonly kind: "lines" } | { readonly kind: "pageBox" }>>();
  });

  it("every per-type anchor is a thread anchor", () => {
    expectTypeOf<AnchorFor<"link">>().toExtend<Anchor>();
    expectTypeOf<AnchorFor<"document">>().toExtend<Anchor>();
    expectTypeOf<AnchorFor<"pad">>().toExtend<Anchor>();
    expectTypeOf<AnchorFor<"sheet">>().toExtend<Anchor>();
    expectTypeOf<AnchorFor<"file">>().toExtend<Anchor>();
  });

  it("a subject's anchor is a place, never whole: an artifact's an artifact anchor, a page's its box, a file's its lines or a page box", () => {
    type AnchorOf<K extends "artifact" | "page" | "file"> = NonNullable<Extract<ThreadSubject, { kind: K }>["anchor"]>;
    expectTypeOf<AnchorOf<"artifact">>().toEqualTypeOf<Exclude<ArtifactAnchor, { readonly kind: "whole" }>>();
    expectTypeOf<AnchorOf<"page">>().toEqualTypeOf<PageBoxAnchor>();
    expectTypeOf<AnchorOf<"file">>().toEqualTypeOf<LinesAnchor | FileBoxAnchor>();
  });

  it("decodes one spelling per place and refuses what the artifact anchor refuses", () => {
    const is = Schema.is(ThreadSubject);
    const artifact = { kind: "artifact", nodeId: "artifacts-1", artifactId: "01M5EVKRB1X4P80GXRGDK8V5AS" };
    expect(is(artifact)).toBe(true);
    expect(is({ ...artifact, anchor: { kind: "whole" } })).toBe(false);
    expect(is({ ...artifact, anchor: { kind: "lines", file: "a.ts", from: 1, to: 2 } })).toBe(false);
    expect(is({ ...artifact, anchor: { kind: "pageBox", page: 1, x: 0, y: 0, w: 0.5, h: 0.5 } })).toBe(false);
    expect(is({ ...artifact, anchor: { kind: "box", x: 0, y: 0, w: 0, h: 1 } })).toBe(false);
    expect(is({ ...artifact, anchor: { kind: "cells", range: "C4:A1" } })).toBe(false);
    expect(is({ ...artifact, anchor: { kind: "cells", range: "A1:C4" } })).toBe(true);
    expect(is({ kind: "page", nodeId: "page-1", anchor: { kind: "whole" } })).toBe(false);
    expect(is({ kind: "page", nodeId: "page-1", anchor: { kind: "lines", file: "a.ts", from: 1, to: 2 } })).toBe(false);
    expect(is({ kind: "page", nodeId: "page-1", anchor: { kind: "pageBox", page: 1, x: 0, y: 0, w: 0.5, h: 0.5 } })).toBe(false);
  });

  it("a file names its node and a path inside it, and hangs on its lines or one of its pages", () => {
    const is = Schema.is(ThreadSubject);
    const file = { kind: "file", nodeId: "files-1", path: "src/index.ts" };
    expect(is(file)).toBe(true);
    expect(is({ ...file, anchor: { kind: "lines", file: "src/index.ts", from: 4, to: 9, quote: "const a = 1;" } })).toBe(true);
    expect(is({ ...file, anchor: { kind: "pageBox", page: 3, x: 0.1, y: 0.2, w: 0.5, h: 0.6 } })).toBe(true);
    // An absolute path or a way out is no path a subject names.
    for (const path of ["/etc/passwd", "../up", "a/../b", "a//b", "a\\b", ""]) {
      expect(is({ ...file, path }), path).toBe(false);
    }
    // A page box stays on its page, and a box of no area is no box.
    for (const box of [
      { kind: "pageBox", page: 0, x: 0, y: 0, w: 0.5, h: 0.5 },
      { kind: "pageBox", page: 1, x: 0.6, y: 0, w: 0.5, h: 0.5 },
      { kind: "pageBox", page: 1, x: 0, y: 0, w: 0, h: 0.5 },
      { kind: "pageBox", page: 1.5, x: 0, y: 0, w: 0.5, h: 0.5 },
    ]) {
      expect(is({ ...file, anchor: box }), JSON.stringify(box)).toBe(false);
    }
    expectTypeOf<Extract<ThreadSubject, { readonly kind: "file" }>["path"]>().toEqualTypeOf<string>();
  });
});
