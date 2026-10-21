import { describe, expect, it } from "vitest";
import type { NodeKind } from "../src/shared/model/kinds";
import type { MentionRef } from "../src/shared/mention";
import type { ItemId } from "../src/shared/work-ids";
import { asNodeId, type NodeId } from "../src/shared/physics/schema";
import {
  draftMentions,
  draftOf,
  editDraft,
  filterCandidates,
  mentionQueryAt,
  mentionKeyIntent,
  mentionSpans,
  pickCandidate,
  shownText,
  triggerOf,
  writtenText,
  type MentionCandidate,
  type MentionDraft,
} from "../src/renderer/lib/mention-draft";

const feed: MentionRef = { kind: "seat", nodeId: asNodeId("agent-feed") };
const lead: MentionRef = { kind: "seat", nodeId: asNodeId("agent-lead") };
const task: MentionRef = { kind: "task", nodeId: asNodeId("task-board"), taskId: "01M5ESSJRFWT6RVS5HMWMGJXGD" as ItemId };
const page: MentionRef = { kind: "page", nodeId: asNodeId("page-docs") };

const candidates: ReadonlyArray<MentionCandidate> = [
  { ref: feed, label: "@product-feed" },
  { ref: lead, label: "@product-lead" },
  { ref: page, label: "@docs" },
  { ref: task, label: "#42 fix tabs" },
];

const kinds: Record<string, NodeKind> = {
  "agent-feed": "agent",
  "agent-lead": "agent",
  "task-board": "task",
  "page-docs": "page",
};
const kindOf = (nodeId: NodeId): NodeKind | undefined => kinds[nodeId];

/** Type into an empty draft, then pick the first candidate of the query at the caret. */
const typeAndPick = (draft: MentionDraft, typed: string, label: string) => {
  const typedEdit = editDraft(draft, `${shownText(draft)}${typed}`);
  const query = mentionQueryAt(typedEdit.draft, typedEdit.caret);
  if (!query) throw new Error("no query");
  const candidate = candidates.find((entry) => entry.label === label)!;
  return pickCandidate(typedEdit.draft, query, typedEdit.caret, candidate);
};

describe("mention draft", () => {
  it("a picked mention shows its label and writes its link", () => {
    const picked = typeAndPick([], "ask @prod", "@product-feed");
    expect(picked.shown).toBe("ask @product-feed ");
    expect(picked.caret).toBe("ask @product-feed ".length);
    expect(writtenText(picked.draft, "factory")).toBe("ask [@product-feed](junto://canvas/factory?node=agent-feed) ");
    expect(draftMentions(picked.draft)).toEqual([feed]);
  });

  it("reads a written text back into the same draft", () => {
    const picked = typeAndPick(typeAndPick([], "ask @", "@product-feed").draft, "about #fix", "#42 fix tabs");
    const written = writtenText(picked.draft, "factory");
    const back = draftOf(written, kindOf);
    expect(back).toEqual(picked.draft);
    expect(writtenText(back, "factory")).toBe(written);
  });

  it("leaves a link to a node the canvas does not have as text", () => {
    const text = "see [@gone](junto://canvas/factory?node=agent-gone)";
    expect(draftOf(text, kindOf)).toEqual([{ kind: "text", text }]);
  });

  it("deleting the last letter of a mention removes the whole mention", () => {
    const picked = typeAndPick([], "@prod", "@product-feed");
    const spaceGone = editDraft(picked.draft, "@product-feed");
    expect(draftMentions(spaceGone.draft)).toEqual([feed]);
    const letterGone = editDraft(spaceGone.draft, "@product-fee");
    expect(letterGone.shown).toBe("");
    expect(letterGone.caret).toBe(0);
    expect(draftMentions(letterGone.draft)).toEqual([]);
  });

  it("a selection deleted across a mention takes it whole, and the text around it stays", () => {
    const picked = typeAndPick(editDraft([], "hi ").draft, "@prod", "@product-feed");
    const next = editDraft(editDraft(picked.draft, `${picked.shown}there`).draft, "hi there");
    // The deletion of "@product-feed " reaches the mention: all of it goes.
    expect(next.shown).toBe("hi there");
    expect(draftMentions(next.draft)).toEqual([]);
  });

  it("typing inside a mention turns it into plain text", () => {
    const picked = typeAndPick([], "@prod", "@product-feed");
    const next = editDraft(picked.draft, "@productX-feed ");
    expect(next.shown).toBe("@productX-feed ");
    expect(draftMentions(next.draft)).toEqual([]);
    expect(writtenText(next.draft, "factory")).toBe("@productX-feed ");
  });

  it("typing before or after a mention keeps it and moves it", () => {
    const picked = typeAndPick([], "@prod", "@product-feed");
    const before = editDraft(picked.draft, `ok ${picked.shown}`);
    expect(mentionSpans(before.draft)).toEqual([{ ref: feed, label: "@product-feed", start: 3, end: 16 }]);
    const after = editDraft(before.draft, `${before.shown}now`);
    expect(draftMentions(after.draft)).toEqual([feed]);
    expect(writtenText(after.draft, "factory")).toBe("ok [@product-feed](junto://canvas/factory?node=agent-feed) now");
  });

  it("a paste replacing the whole text drops every mention", () => {
    const picked = typeAndPick([], "@prod", "@product-feed");
    const next = editDraft(picked.draft, "fresh");
    expect(next.draft).toEqual([{ kind: "text", text: "fresh" }]);
  });

  it("picking keeps the space already after the query instead of adding one", () => {
    const draft = editDraft([], "@pro then").draft;
    const query = mentionQueryAt(draft, 4)!;
    const next = pickCandidate(draft, query, 4, candidates[0]!);
    expect(next.shown).toBe("@product-feed then");
    expect(next.caret).toBe("@product-feed ".length);
  });

  it("finds the query at the caret by its trigger", () => {
    const draft = editDraft([], "see #42 and @pro").draft;
    expect(mentionQueryAt(draft, 16)).toEqual({ trigger: "@", start: 12, query: "pro" });
    expect(mentionQueryAt(draft, 7)).toEqual({ trigger: "#", start: 4, query: "42" });
    expect(mentionQueryAt(draft, 3)).toBeUndefined();
    // An @ inside a word is an address, not a mention.
    expect(mentionQueryAt(editDraft([], "me@pro").draft, 6)).toBeUndefined();
  });

  it("never opens a query inside a placed mention", () => {
    const picked = typeAndPick([], "@prod", "@product-feed");
    expect(mentionQueryAt(picked.draft, 5)).toBeUndefined();
    expect(mentionQueryAt(picked.draft, 13)).toBeUndefined();
  });

  it("filters by trigger, starts-with first, then contains", () => {
    expect(filterCandidates(candidates, { trigger: "@", query: "" }).map((entry) => entry.label)).toEqual([
      "@product-feed",
      "@product-lead",
      "@docs",
    ]);
    expect(filterCandidates(candidates, { trigger: "@", query: "LEAD" }).map((entry) => entry.label)).toEqual([
      "@product-lead",
    ]);
    expect(filterCandidates(candidates, { trigger: "@", query: "o" }).map((entry) => entry.label)).toEqual([
      "@product-feed",
      "@product-lead",
      "@docs",
    ]);
    expect(filterCandidates(candidates, { trigger: "#", query: "tabs" }).map((entry) => entry.label)).toEqual([
      "#42 fix tabs",
    ]);
  });

  it("names seats and pages with @, tasks and artifacts with #", () => {
    expect(triggerOf(feed)).toBe("@");
    expect(triggerOf(page)).toBe("@");
    expect(triggerOf(task)).toBe("#");
  });
});

describe("mention keys", () => {
  const open = { open: true, optionCount: 3, activeIndex: 0 };
  it("moves the highlight with wrapping", () => {
    expect(mentionKeyIntent({ key: "ArrowDown" }, open)).toEqual({ type: "highlight", index: 1 });
    expect(mentionKeyIntent({ key: "ArrowUp" }, open)).toEqual({ type: "highlight", index: 2 });
    expect(mentionKeyIntent({ key: "ArrowDown" }, { ...open, activeIndex: 2 })).toEqual({ type: "highlight", index: 0 });
  });
  it("Enter and Tab pick, Escape dismisses", () => {
    expect(mentionKeyIntent({ key: "Enter" }, { ...open, activeIndex: 1 })).toEqual({ type: "pick", index: 1 });
    expect(mentionKeyIntent({ key: "Tab" }, open)).toEqual({ type: "pick", index: 0 });
    expect(mentionKeyIntent({ key: "Escape" }, open)).toEqual({ type: "dismiss" });
  });
  it("leaves chords, Shift+Enter, Home and End, composition and a closed list to the field", () => {
    expect(mentionKeyIntent({ key: "Enter", metaKey: true }, open)).toEqual({ type: "none" });
    expect(mentionKeyIntent({ key: "Enter", shiftKey: true }, open)).toEqual({ type: "none" });
    expect(mentionKeyIntent({ key: "Home" }, open)).toEqual({ type: "none" });
    expect(mentionKeyIntent({ key: "End" }, open)).toEqual({ type: "none" });
    expect(mentionKeyIntent({ key: "Enter", isComposing: true }, open)).toEqual({ type: "none" });
    expect(mentionKeyIntent({ key: "Enter" }, { ...open, open: false })).toEqual({ type: "none" });
  });
  it("with no matches Enter is the composer's, Escape still closes", () => {
    const empty = { open: true, optionCount: 0, activeIndex: -1 };
    expect(mentionKeyIntent({ key: "Enter" }, empty)).toEqual({ type: "none" });
    expect(mentionKeyIntent({ key: "Escape" }, empty)).toEqual({ type: "dismiss" });
  });
});
