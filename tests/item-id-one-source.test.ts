import { describe, expectTypeOf, it } from "vitest";
import type { Artifact, ArtifactId } from "../src/shared/artifact";
import type { MentionOf } from "../src/shared/mention";
import type { ItemId as ResourceItemId, OpId as ResourceOpId } from "../src/shared/resource-command";
import type { ItemId, OpId } from "../src/shared/work-ids";

// product-lead, 2026-10-21: work-ids.ts owns ItemId and OpId. Every other
// contract imports them and brands no id of its own, so an id the CLI mints
// goes into a command, a ruling, an artifact and a mention without a cast.
describe("one item id and one op id", () => {
  it("resource commands take the CLI's ids", () => {
    expectTypeOf<ResourceItemId>().toEqualTypeOf<ItemId>();
    expectTypeOf<ResourceOpId>().toEqualTypeOf<OpId>();
  });

  it("an artifact's id is the item id", () => {
    expectTypeOf<ArtifactId>().toEqualTypeOf<ItemId>();
    expectTypeOf<Artifact["artifactId"]>().toEqualTypeOf<ItemId>();
  });

  it("a mention names an artifact and a task by the same id", () => {
    expectTypeOf<MentionOf<"artifact">["artifactId"]>().toEqualTypeOf<Artifact["artifactId"]>();
    expectTypeOf<MentionOf<"task">["taskId"]>().toEqualTypeOf<ItemId>();
  });

  it("keeps op and item apart", () => {
    expectTypeOf<OpId>().not.toEqualTypeOf<ItemId>();
  });
});
