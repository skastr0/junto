import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { NodeKind } from "../src/shared/model/kinds";
import { asNodeId, type NodeId } from "../src/shared/physics/schema";
import { ItemId } from "../src/shared/work-ids";
import {
  MentionRef,
  matchMention,
  mentionHref,
  mentionLink,
  mentionLinksOf,
  mentionRefOf,
  mentionedOnce,
  mentionsOf,
  parseMentionHref,
} from "../src/shared/mention";

const seat = asNodeId("agent-01M4727PH6NV810ND26XQ2WXX2");
const board = asNodeId("task-01M5");
const shelf = asNodeId("artifacts-01M5");
const page = asNodeId("page-01M5");
const note = asNodeId("note-01M5");
const taskId = Schema.decodeSync(ItemId)("01M5ESZPWMZZM3TZ88P6FVVK33");
const artifactId = Schema.decodeSync(ItemId)("01M5ESR42S7P9YNR8FEH0TD2QC");
const T = "01M5ESZPWMZZM3TZ88P6FVVK33";
const A = "01M5ESR42S7P9YNR8FEH0TD2QC";

const kinds: Record<string, NodeKind> = { [seat]: "agent", [board]: "task", [shelf]: "artifacts", [page]: "page", [note]: "note" };
const kindOf = (nodeId: NodeId): NodeKind | undefined => kinds[nodeId];

describe("mention links", () => {
  it("is the node ref, with the item for a task or an artifact, and never the kind", () => {
    expect(mentionHref({ kind: "seat", nodeId: seat }, "factory")).toBe("junto://canvas/factory?node=agent-01M4727PH6NV810ND26XQ2WXX2");
    expect(mentionHref({ kind: "task", nodeId: board, taskId }, "factory")).toBe(`junto://canvas/factory?node=task-01M5&item=${T}`);
    expect(mentionHref({ kind: "artifact", nodeId: shelf, artifactId }, "factory")).toBe(
      `junto://canvas/factory?node=artifacts-01M5&item=${A}`,
    );
  });

  it("parses only the canonical spelling, and keeps no canvas name: a renamed canvas's links still resolve", () => {
    expect(parseMentionHref(`junto://canvas/factory?node=task-01M5&item=${T}`)).toEqual({ nodeId: board, item: taskId });
    expect(parseMentionHref(`junto://canvas/old-name?node=task-01M5&item=${T}`)).toEqual({ nodeId: board, item: taskId });
    expect(parseMentionHref("junto://canvas/factory?node=spec%20%28v2%29")).toEqual({ nodeId: "spec (v2)" });
    for (const href of [
      "junto://canvas?node=task-01M5",
      "junto://canvas/factory?node=",
      "junto://canvas/factory?node=a&item=",
      "junto://canvas/factory?node=a&item=01M5TASK",
      `junto://canvas/factory?node=a&item=${T}&item=${A}`,
      "junto://canvas/factory?node=a&x=b",
      "junto://canvas/factory?node=spec (v2)",
      "junto://canvas/Factory?node=a",
      "https://example.com?node=a",
    ]) {
      expect(parseMentionHref(href), href).toBeUndefined();
    }
  });

  it("resolves a target by its node's kind, and an item only where the kind takes one", () => {
    expect(mentionRefOf({ nodeId: seat }, kindOf)).toEqual({ kind: "seat", nodeId: seat });
    expect(mentionRefOf({ nodeId: page }, kindOf)).toEqual({ kind: "page", nodeId: page });
    expect(mentionRefOf({ nodeId: board, item: taskId }, kindOf)).toEqual({ kind: "task", nodeId: board, taskId });
    expect(mentionRefOf({ nodeId: seat, item: taskId }, kindOf)).toBeUndefined();
    expect(mentionRefOf({ nodeId: board }, kindOf)).toBeUndefined();
    expect(mentionRefOf({ nodeId: note }, kindOf)).toBeUndefined();
    expect(mentionRefOf({ nodeId: asNodeId("gone") }, kindOf)).toBeUndefined();
    expect(mentionRefOf({ nodeId: asNodeId("toString") }, () => "toString" as NodeKind)).toBeUndefined();
  });
});

describe("mentions in text", () => {
  it("writes [label](href) and reads it back with its offsets, in text order", () => {
    const task = { kind: "task", nodeId: board, taskId } as const;
    const text = `ask ${mentionLink({ kind: "seat", nodeId: seat }, "@product-feed", "factory")} about ${mentionLink(task, "#42 fix [tabs]", "factory")}.`;
    expect(text).toBe(
      `ask [@product-feed](junto://canvas/factory?node=agent-01M4727PH6NV810ND26XQ2WXX2) about [#42 fix \\[tabs\\]](junto://canvas/factory?node=task-01M5&item=${T}).`,
    );
    const found = mentionsOf(text, kindOf);
    expect(found.map((mention) => [mention.ref.kind, mention.label])).toEqual([
      ["seat", "@product-feed"],
      ["task", "#42 fix [tabs]"],
    ]);
    for (const mention of found) expect(text.slice(mention.start, mention.end)).toBe(mentionLink(mention.ref, mention.label, "factory"));
  });

  it("leaves other links, unknown nodes and multi-line labels as text", () => {
    const text = [
      "[docs](https://example.com)",
      "[@gone](junto://canvas/factory?node=gone)",
      "[two\nlines](junto://canvas/factory?node=page-01M5)",
      "[@page](junto://canvas/factory?node=page-01M5)",
    ].join(" ");
    expect(mentionLinksOf(text).map((link) => link.target.nodeId)).toEqual(["gone", "page-01M5"]);
    expect(mentionsOf(text, kindOf).map((mention) => mention.ref)).toEqual([{ kind: "page", nodeId: page }]);
  });

  it("names each thing once, first mention first", () => {
    const text = `${mentionLink({ kind: "seat", nodeId: seat }, "@a", "factory")} ${mentionLink({ kind: "page", nodeId: page }, "@p", "factory")} ${mentionLink({ kind: "seat", nodeId: seat }, "@again", "renamed")}`;
    expect(mentionedOnce(mentionsOf(text, kindOf))).toEqual([
      { kind: "seat", nodeId: seat },
      { kind: "page", nodeId: page },
    ]);
  });

  it("refuses an empty label", () => {
    expect(() => mentionLink({ kind: "seat", nodeId: seat }, "  ", "factory")).toThrow(RangeError);
  });
});

describe("the mention contract's types", () => {
  it("decodes closed, and a match must handle every kind", () => {
    const decode = Schema.decodeUnknownSync(MentionRef);
    expect(decode({ kind: "seat", nodeId: "a" })).toEqual({ kind: "seat", nodeId: "a" });
    expect(() => decode({ kind: "task", nodeId: "a" })).toThrow();
    expect(() => decode({ kind: "folder", nodeId: "a" })).toThrow();
    const label = (ref: MentionRef) =>
      matchMention(ref, { seat: () => "seat", task: (t) => t.taskId, artifact: (a) => a.artifactId, page: () => "page" });
    expect(label({ kind: "task", nodeId: board, taskId })).toBe(T);
    // @ts-expect-error: a match without the page case does not compile.
    matchMention({ kind: "seat", nodeId: seat }, { seat: () => 1, task: () => 2, artifact: () => 3 });
    // @ts-expect-error: a task mention needs its task id.
    mentionHref({ kind: "task", nodeId: board }, "factory");
    // @ts-expect-error: a bare string is not an ItemId.
    mentionHref({ kind: "task", nodeId: board, taskId: T }, "factory");
    // @ts-expect-error: a bare string is not a NodeId.
    mentionHref({ kind: "seat", nodeId: "agent-01" }, "factory");
  });
});
