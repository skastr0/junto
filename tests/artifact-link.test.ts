import { describe, expect, it } from "vitest";
import { artifactLink, artifactLinkLabel, artifactLinkTitle } from "../src/shared/artifact-link";
import { mentionLinksOf, mentionRefOf, type MentionOf } from "../src/shared/mention";
import type { NodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";

const ref: MentionOf<"artifact"> = {
  kind: "artifact",
  nodeId: "artifacts-01M5ZC0000000000000000000A" as NodeId,
  artifactId: "01M5ZC0000000000000000000B" as ItemId,
};

describe("a [[ ]] link", () => {
  it("is a mention link by id, its label the title in double brackets, escaped", () => {
    expect(artifactLink(ref, "Launch plan", "factory")).toBe(
      `[\\[\\[Launch plan\\]\\]](junto://canvas/factory?node=${ref.nodeId}&item=${ref.artifactId})`,
    );
  });

  it("reads back through every mention reader, label and target", () => {
    const text = `See ${artifactLink(ref, "Launch [v2] plan", "factory")} today.`;
    const [link] = mentionLinksOf(text);
    expect(link?.label).toBe(artifactLinkLabel("Launch [v2] plan"));
    expect(mentionRefOf(link!.target, () => "artifacts")).toEqual(ref);
    expect(artifactLinkTitle(link!.label)).toBe("Launch [v2] plan");
  });

  it("tells its label from a # mention's, raw or read", () => {
    expect(artifactLinkTitle("[[Launch plan]]")).toBe("Launch plan");
    expect(artifactLinkTitle("\\[\\[Launch plan\\]\\]")).toBe("Launch plan");
    expect(artifactLinkTitle("#Launch plan")).toBeUndefined();
    expect(artifactLinkTitle("[[ ]]")).toBeUndefined();
  });

  it("refuses an empty title", () => {
    expect(() => artifactLink(ref, "  ", "factory")).toThrow(RangeError);
  });
});
