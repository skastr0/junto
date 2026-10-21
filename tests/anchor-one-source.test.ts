import { describe, expectTypeOf, it } from "vitest";
import type { AnchorFor, ArtifactAnchor } from "../src/shared/artifact";
import type { Anchor } from "../src/shared/thread-subject";

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
});
