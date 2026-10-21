import { describe, expect, it } from "vitest";
import { emptyBody } from "../src/shared/artifact";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId } from "../src/shared/resource-command";
import { makeLocalArtifactsSource } from "../src/renderer/lib/artifacts-source";
import {
  ageLabel,
  anchorLabel,
  isLinkUrl,
  textSplice,
  visibleArtifacts,
} from "../src/renderer/components/artifacts/artifacts-pane-model";

const node = asNodeId("artifacts");

const applySplice = (text: string, patch: NonNullable<ReturnType<typeof textSplice>>): string =>
  text.slice(0, patch.at) + patch.insert + text.slice(patch.at + patch.remove);

describe("text splice", () => {
  it("is null for no change", () => {
    expect(textSplice("same", "same")).toBeNull();
  });

  it.each([
    ["", "hello"],
    ["hello", ""],
    ["hello world", "hello brave world"],
    ["abcabc", "abc"],
    ["aaaa", "aaaaa"],
    ["# Title\n\nBody", "# Title\n\nNew body\n"],
  ])("turns %j into %j with one minimal splice", (before, after) => {
    const patch = textSplice(before, after)!;
    expect(applySplice(before, patch)).toBe(after);
    expect(patch.remove + patch.insert.length).toBeLessThanOrEqual(Math.max(before.length, after.length));
  });
});

describe("labels", () => {
  it("says where a thread hangs", () => {
    expect(anchorLabel(undefined)).toBe("Whole artifact");
    expect(anchorLabel({ kind: "cells", range: "B2:C4" })).toBe("Cells B2:C4");
    expect(anchorLabel({ kind: "text", quote: "x".repeat(60) })).toHaveLength(50);
  });

  it("ages", () => {
    expect(ageLabel(1_000, 1_500)).toBe("now");
    expect(ageLabel(0, 5 * 60_000)).toBe("5m");
    expect(ageLabel(0, 3 * 3_600_000)).toBe("3h");
  });

  it("admits only http and https links", () => {
    expect(isLinkUrl("https://junto.dev")).toBe(true);
    expect(isLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isLinkUrl("not a url")).toBe(false);
  });
});

describe("local artifacts source", () => {
  it("creates, edits, lists, filters and keeps versions newest first", async () => {
    const source = makeLocalArtifactsSource({ kind: "operator" }, () => 10);
    const doc = mintItemId();
    const sheet = mintItemId();
    expect((await source.apply("c", node, doc, { op: "create", title: "Plan", body: emptyBody("document") })).kind).toBe("applied");
    await source.apply("c", node, sheet, { op: "create", title: "Budget", body: emptyBody("sheet") });
    const edited = await source.apply("c", node, doc, {
      op: "edit",
      edit: { kind: "patch", type: "document", baseVersion: 1 as never, patches: [{ op: "splice", at: 0, remove: 0, insert: "# Plan" }] },
    });
    expect(edited.kind).toBe("applied");
    const entries = await source.list("c", node);
    expect(entries.map((entry) => entry.artifact.title).sort()).toEqual(["Budget", "Plan"]);
    expect(visibleArtifacts(entries, { type: "sheet", query: "", archived: false }).map((e) => e.artifact.title)).toEqual(["Budget"]);
    expect(visibleArtifacts(entries, { type: "all", query: "PLA", archived: false }).map((e) => e.artifact.title)).toEqual(["Plan"]);
    expect((await source.history("c", doc)).map((record) => record.version)).toEqual([2, 1]);
  });

  it("refuses a stale replace with the head and changes nothing", async () => {
    const source = makeLocalArtifactsSource();
    const doc = mintItemId();
    await source.apply("c", node, doc, { op: "create", title: "Plan", body: emptyBody("document") });
    const replace = (markdown: string) =>
      source.apply("c", node, doc, { op: "edit", edit: { kind: "replace", baseVersion: 1 as never, body: { type: "document", markdown } } });
    expect((await replace("first")).kind).toBe("applied");
    const late = await replace("second");
    expect(late.kind === "refused" && late.error.details).toMatchObject({ reason: "stale", expected: 2 });
    const [entry] = await source.list("c", node);
    expect(entry?.body).toEqual({ type: "document", markdown: "first" });
  });

  it("threads: a whole anchor is stored as no anchor, replies join, resolve toggles", async () => {
    const source = makeLocalArtifactsSource();
    const doc = mintItemId();
    let changes = 0;
    source.subscribe(() => (changes += 1));
    const started = await source.comment("c", doc, { text: "first", anchor: { kind: "whole" }, version: 1 as never });
    expect(started.anchor).toBeUndefined();
    await source.comment("c", doc, { text: "second", threadId: started.threadId, version: 1 as never });
    await source.resolve("c", started.threadId, true);
    const [thread] = await source.threads("c", doc);
    expect(thread?.posts.map((post) => post.text)).toEqual(["first", "second"]);
    expect(thread?.resolved).toBe(true);
    expect(changes).toBe(3);
  });
});
