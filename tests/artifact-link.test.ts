import { describe, expect, it } from "vitest";
import { artifactLink, artifactLinkLabel, artifactLinkStateOf, artifactLinkTitle, MISSING_ARTIFACT_WORDS } from "../src/shared/artifact-link";
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

describe("what a link names now", () => {
  const head = { artifactId: ref.artifactId, title: "Launch plan, final", type: "document" as const, archived: false };

  it("unread: the words it was written with, brackets or # off", () => {
    expect(artifactLinkStateOf(ref.artifactId, undefined, "[[Launch plan]]")).toEqual({ state: "unread", words: "Launch plan" });
    expect(artifactLinkStateOf(ref.artifactId, undefined, "#Launch plan")).toEqual({ state: "unread", words: "Launch plan" });
  });

  it("live and archived: the title now and the type", () => {
    expect(artifactLinkStateOf(ref.artifactId, [head], "[[Launch plan]]")).toEqual({ state: "live", words: "Launch plan, final", type: "document" });
    expect(artifactLinkStateOf(ref.artifactId, [{ ...head, archived: true }], "[[x]]")).toEqual({ state: "archived", words: "Launch plan, final", type: "document" });
  });

  it("missing claims no title, whether the node is gone or never held it", () => {
    const missing = { state: "missing", words: MISSING_ARTIFACT_WORDS };
    expect(artifactLinkStateOf(ref.artifactId, [], "[[Ghost doc]]")).toEqual(missing);
    expect(artifactLinkStateOf(ref.artifactId, null, "[[Ghost doc]]")).toEqual(missing);
  });
});
