/**
 * A review's comments become one mail per recipient, each standing alone.
 */
import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { reviewCandidates } from "../src/shared/review-candidates";
import {
  applyMention,
  filterMentionCandidates,
  mentionedIn,
  mentionQueryAt,
  reviewCandidateLabel,
  quoteDiffLines,
  reviewCommentAnchor,
  reviewCountLine,
  reviewIsEmpty,
  reviewMails,
  type PendingReview,
  type ReviewComment,
} from "../src/shared/git-review";

const SECTION = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,5 +10,6 @@ export const a = () => {",
  " const one = 1;",
  "-const two = 2;",
  "+const two = 22;",
  "+const three = 3;",
  " return one + two;",
  " };",
  "@@ -40,2 +41,2 @@",
  "-old tail",
  "+new tail",
  " end",
  "\\ No newline at end of file",
].join("\n");

const comment = (over: Partial<ReviewComment>): ReviewComment => ({
  id: "c1",
  file: "src/a.ts",
  side: "additions",
  line: 11,
  endLine: 12,
  quote: ["+const two = 22;", "+const three = 3;"],
  text: "Why 22?",
  to: [],
  ...over,
});

describe("quoting the diff lines a comment refers to", () => {
  it("takes the new side by its line numbers, context included", () => {
    expect(quoteDiffLines(SECTION, "additions", 10, 12)).toEqual([" const one = 1;", "+const two = 22;", "+const three = 3;"]);
    expect(quoteDiffLines(SECTION, "additions", 41, 41)).toEqual(["+new tail"]);
  });
  it("takes the removed side by the old line numbers", () => {
    expect(quoteDiffLines(SECTION, "deletions", 11, 11)).toEqual(["-const two = 2;"]);
    expect(quoteDiffLines(SECTION, "deletions", 40, 41)).toEqual(["-old tail", " end"]);
  });
  it("reads a range given backwards, and gives nothing outside the hunks", () => {
    expect(quoteDiffLines(SECTION, "additions", 12, 11)).toEqual(["+const two = 22;", "+const three = 3;"]);
    expect(quoteDiffLines(SECTION, "additions", 200, 210)).toEqual([]);
  });
});

describe("what the surface says about a pending review", () => {
  it("counts comments and files, and names the overall note", () => {
    const review: PendingReview = { comments: [comment({}), comment({ id: "c2", file: "b.ts" }), comment({ id: "c3" })], note: "" };
    expect(reviewCountLine(review)).toBe("3 comments in 2 files");
    expect(reviewCountLine({ comments: [comment({})], note: " tidy " })).toBe("1 comment in 1 file, and an overall note");
    expect(reviewCountLine({ comments: [], note: "tidy" })).toBe("1 overall note");
    expect(reviewCountLine({ comments: [], note: "  " })).toBe("No comments yet");
    expect(reviewIsEmpty({ comments: [], note: "  " })).toBe(true);
    expect(reviewIsEmpty({ comments: [], note: "x" })).toBe(false);
  });
  it("anchors a comment by the file's short name and its lines", () => {
    expect(reviewCommentAnchor(comment({ line: 214, endLine: 214, file: "src/git/GitDetail.tsx" }))).toBe("GitDetail.tsx 214");
    expect(reviewCommentAnchor(comment({}))).toBe("a.ts 11 to 12");
  });
});

describe("one mail per recipient", () => {
  const nameOf = (id: string): string => ({ atlas: "Atlas", brook: "Brook" })[id] ?? id;
  const base = { reviewed: "uncommitted changes in the folder, on feat/x at 0123abc", repository: "junto", nameOf };

  it("sends every unmentioned comment and the note to the review's own recipient, as one mail", () => {
    const { mails, unaddressed } = reviewMails({
      ...base,
      defaultTo: "atlas",
      review: { note: "Good direction.", comments: [comment({}), comment({ id: "c2", line: 41, endLine: 41, quote: ["+new tail"], text: "Rename this." })] },
    });
    expect(unaddressed).toEqual([]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "atlas", comments: 2 });
    expect(mails[0]!.text).toBe(
      [
        "Code review from the operator.",
        "Reviewed: uncommitted changes in the folder, on feat/x at 0123abc, repository junto.",
        "",
        "Overall: Good direction.",
        "",
        "1. src/a.ts, lines 11 to 12",
        "   +const two = 22;",
        "   +const three = 3;",
        "   Comment: Why 22?",
        "",
        "2. src/a.ts, line 41",
        "   +new tail",
        "   Comment: Rename this.",
        "",
        "2 comments in this review. The line numbers are from the state named above; check them against your working copy.",
      ].join("\n"),
    );
  });

  it("sends a mentioned comment to the mentioned agent instead, still one mail each", () => {
    const { mails } = reviewMails({
      ...base,
      defaultTo: "atlas",
      review: {
        note: "",
        comments: [
          comment({ id: "plain" }),
          comment({ id: "mention", text: "Brook, this is yours.", to: ["brook"], side: "deletions", line: 11, endLine: 11, quote: ["-const two = 2;"] }),
          comment({ id: "both", text: "For both of you.", to: ["atlas", "brook", "brook"] }),
        ],
      },
    });
    expect(mails.map((mail) => [mail.to, mail.comments])).toEqual([
      ["atlas", 2],
      ["brook", 2],
    ]);
    const brook = mails.find((mail) => mail.to === "brook")!.text;
    expect(brook).toContain("1. src/a.ts, line 11 (removed text)\n   -const two = 2;\n   Comment: Brook, this is yours.");
    expect(brook).toContain("Comment: For both of you.\n   Also sent to: Atlas");
    expect(brook).not.toContain("Why 22?");
    expect(mails.find((mail) => mail.to === "atlas")!.text).toContain("Also sent to: Brook");
  });

  it("with no recipient of its own, an unmentioned comment is not sent and comes back", () => {
    const plain = comment({ id: "plain" });
    const { mails, unaddressed } = reviewMails({
      ...base,
      defaultTo: undefined,
      review: { note: "nobody to tell", comments: [plain, comment({ id: "m", to: ["brook"] })] },
    });
    expect(mails.map((mail) => mail.to)).toEqual(["brook"]);
    expect(mails[0]!.text).not.toContain("Overall:");
    expect(unaddressed).toEqual([plain]);
  });

  it("a note alone is a mail, and a long quote is cut with a count", () => {
    const alone = reviewMails({ ...base, defaultTo: "atlas", review: { note: "Ship it.", comments: [] } });
    expect(alone.mails).toHaveLength(1);
    expect(alone.mails[0]!.text).toContain("Overall: Ship it.\n\nNo line comments in this review.");
    const long = reviewMails({
      ...base,
      defaultTo: "atlas",
      review: { note: "", comments: [comment({ quote: Array.from({ length: 11 }, (_, i) => `+line ${i}`) })] },
    });
    expect(long.mails[0]!.text).toContain("   +line 7\n   (3 more lines)\n   Comment: Why 22?");
  });
});

describe("who a review can go to", () => {
  const agent = (id: string, name: string, x: number, y: number): CanvasNode =>
    ({ id, type: "text", text: name, x, y, width: 100, height: 60, ether: { entity: { kind: "agent", name: `local:${id}` } } }) as unknown as CanvasNode;
  const doc = {
    nodes: [
      { id: "team", type: "group", label: "Team", x: 0, y: 0, width: 1000, height: 1000 },
      { id: "sub", type: "group", label: "", x: 10, y: 10, width: 400, height: 400 },
      agent("lead", "Lead", 600, 600),
      agent("a", "Atlas", 50, 50),
      agent("b", "Atlas", 200, 50),
      agent("far", "Far", 5000, 5000),
      { id: "note", type: "text", text: "A note", x: 60, y: 200, width: 50, height: 50 },
      { id: "git", type: "text", text: "repo", x: 300, y: 300, width: 50, height: 50, ether: { entity: { kind: "git" } } },
    ],
    edges: [],
  } as unknown as CanvasDoc;
  const nameOf = (node: CanvasNode): string => (node.type === "text" ? node.text : node.id);

  it("lists the innermost region's agents first, then each containing region's, never outsiders", () => {
    const fromSeat = reviewCandidates(doc, "a", nameOf);
    expect(fromSeat.map((candidate) => candidate.nodeId)).toEqual(["a", "b", "lead"]);
    expect(fromSeat[0]?.regionPath).toEqual(["Team", "unnamed region"]);
    // Opened from a git node in the same region: the same agents.
    expect(reviewCandidates(doc, "git", nameOf).map((candidate) => candidate.nodeId)).toEqual(["a", "b", "lead"]);
  });

  it("from the open field, or from nowhere, offers every agent on the canvas", () => {
    expect(reviewCandidates(doc, "far", nameOf).map((candidate) => candidate.nodeId)).toEqual(["lead", "a", "b", "far"]);
    expect(reviewCandidates(doc, undefined, nameOf)).toHaveLength(4);
  });

  it("adds the region path to a name only when two candidates share it", () => {
    const all = reviewCandidates(doc, "a", nameOf);
    expect(all.map((candidate) => reviewCandidateLabel(candidate, all))).toEqual([
      "Atlas, Team / unnamed region",
      "Atlas, Team / unnamed region",
      "Lead",
    ]);
  });
});

describe("mentioning an agent in a comment", () => {
  const candidates = [
    { nodeId: "a", name: "Atlas", regionPath: [] },
    { nodeId: "b", name: "Brook", regionPath: [] },
    { nodeId: "c", name: "Coral Atlas", regionPath: [] },
  ];

  it("finds the @word being typed before the caret", () => {
    expect(mentionQueryAt("ask @Bro", 8)).toEqual({ start: 4, query: "Bro" });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("mail me@host", 12)).toBeUndefined();
    expect(mentionQueryAt("ask @Brook now", 14)).toBeUndefined();
  });

  it("filters by name, starts-with first", () => {
    expect(filterMentionCandidates(candidates, "atl").map((candidate) => candidate.nodeId)).toEqual(["a", "c"]);
    expect(filterMentionCandidates(candidates, "").map((candidate) => candidate.nodeId)).toEqual(["a", "b", "c"]);
    expect(filterMentionCandidates(candidates, "zzz")).toEqual([]);
  });

  it("puts the picked name in place of the @word, and reads mentions back from the text", () => {
    const at = mentionQueryAt("ask @Bro about it", 8)!;
    expect(applyMention("ask @Bro about it", at, "Brook")).toEqual({ text: "ask @Brook  about it", caret: 11 });
    const picked = [
      { nodeId: "b", name: "Brook" },
      { nodeId: "a", name: "Atlas" },
    ];
    expect(mentionedIn("ask @Brook about it", picked)).toEqual(["b"]);
    // Deleting the words removes the recipient.
    expect(mentionedIn("ask about it", picked)).toEqual([]);
  });
});
