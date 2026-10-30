/**
 * The text rules a thread renders by: the tag that repeats its author, the tag
 * some mail writes after its subject, and long ids. All of it is render only;
 * nothing here is allowed to rewrite what main stored.
 */
import { describe, expect, it } from "vitest";
import {
  idSegments,
  sentenceCase,
  stripAuthorPreamble,
  stripHeadTag,
  threadHeadline,
} from "../src/renderer/lib/thread-text";

/** The runs as a line of words, to read a composition back. */
const words = (text: string, known: ReadonlyArray<string>): string =>
  threadHeadline(text, known)
    .map((segment) => segment.text)
    .join("");

const ULID = "01M65NSRWSB3PCSBAG7N44SHXN";

describe("stripAuthorPreamble", () => {
  it("drops the tag when it names the author already drawn with the words", () => {
    expect(stripAuthorPreamble("From product-lead, operator request for 0.11.6: a readability upgrade", ["product-lead"])).toBe(
      "Operator request for 0.11.6: a readability upgrade",
    );
    expect(stripAuthorPreamble("From product-lead: thorough review, thank you.", ["product-lead"])).toBe(
      "Thorough review, thank you.",
    );
    expect(stripAuthorPreamble("From product-onboarding. The first run asks three things.", ["product-onboarding"])).toBe(
      "The first run asks three things.",
    );
    expect(stripAuthorPreamble("product-modals: holding. Nothing of mine is uncommitted.", ["product-modals"])).toBe(
      "Holding. Nothing of mine is uncommitted.",
    );
    expect(stripAuthorPreamble("product-modals to product-settings: the cleanup is yours", ["product-modals"])).toBe(
      "The cleanup is yours",
    );
    expect(stripAuthorPreamble("[from product-design] plan approved as written.", ["product-design"])).toBe(
      "Plan approved as written.",
    );
  });

  it("keeps the words when the name is not this message's author", () => {
    const text = "From product-lead, the exact Move to API, landing within the hour.";
    expect(stripAuthorPreamble(text, ["product-documents"])).toBe(text);
  });

  it("keeps a sentence that only opens with a name, and a body that is only the tag", () => {
    expect(stripAuthorPreamble("product-lead thought the diff was fine", ["product-lead"])).toBe(
      "product-lead thought the diff was fine",
    );
    expect(stripAuthorPreamble("product-lead: ", ["product-lead"])).toBe("product-lead: ");
  });

  it("leaves text alone when nothing is known, or when it opens with a mention", () => {
    expect(stripAuthorPreamble("product-modals: holding.", [])).toBe("product-modals: holding.");
    expect(stripAuthorPreamble("[@cli-lead](junto://canvas/factory?node=seat-cli) the review is yours", ["cli-lead"])).toBe(
      "[@cli-lead](junto://canvas/factory?node=seat-cli) the review is yours",
    );
  });
});

describe("sentenceCase", () => {
  it("capitalises a plain opening word and leaves an address or identifier alone", () => {
    expect(sentenceCase("operator request for 0.11.6")).toBe("Operator request for 0.11.6");
    expect(sentenceCase("junto.db is the only store")).toBe("junto.db is the only store");
    expect(sentenceCase("@cli-lead read this")).toBe("@cli-lead read this");
  });
});

describe("stripHeadTag", () => {
  it("drops a tag written after the subject, keeping the comma that introduced it", () => {
    expect(stripHeadTag("Review ask, from product-feed: please read the two notes", ["product-feed"])).toBe(
      "Review ask, please read the two notes",
    );
  });

  it("keeps a body where the same shape is a clause", () => {
    const clause = "The report, from product-feed: it says the cut moved";
    expect(stripHeadTag(clause, ["product-lead"])).toBe(clause);
  });

  it("does not strip when the tag would leave nothing, or when a name is unknown", () => {
    expect(stripHeadTag("from product-feed:", ["product-feed"])).toBe("from product-feed:");
    expect(stripHeadTag("Review ask, from product-feed: read it", ["product-lead"])).toBe(
      "Review ask, from product-feed: read it",
    );
  });
});

describe("long ids", () => {
  it("finds a ULID and a long hex run, and cuts neither word nor path", () => {
    expect(idSegments(`the row ${ULID} stands`).filter((segment) => segment.id !== undefined)).toHaveLength(1);
    expect(idSegments("see 5b13225bd8004d2f for the diff").filter((segment) => segment.id !== undefined)).toHaveLength(1);
    expect(idSegments("ABCDEFGHJKMNPQRSTVWXYZABCDEFGHJKM").filter((segment) => segment.id !== undefined)).toHaveLength(0);
    expect(idSegments("see /tmp/0123456789abcdef/notes").filter((segment) => segment.id !== undefined)).toHaveLength(0);
    expect(idSegments("https://example.com/a/0123456789abcdef").filter((segment) => segment.id !== undefined)).toHaveLength(0);
    expect(idSegments("the bundle is 0123456789abcdef.min.js").filter((segment) => segment.id !== undefined)).toHaveLength(0);
  });

  it("closes a token an id ends a sentence with", () => {
    const [sentence] = idSegments("Sent to pty-lead with the thread id 01M65QV5FYN4DMTRAHA6SF5CMK.").filter(
      (segment) => segment.id !== undefined,
    );
    expect(sentence?.id).toBe("01M65QV5FYN4DMTRAHA6SF5CMK");
    expect(idSegments("(see 01M65QV5FYN4DMTRAHA6SF5CMK)").filter((segment) => segment.id !== undefined)).toHaveLength(1);
    expect(idSegments("id 01M65QV5FYN4DMTRAHA6SF5CMK, then").filter((segment) => segment.id !== undefined)).toHaveLength(1);
  });

  it("keeps the whole id in the segment, so the stylesheet can cut it and copy keeps it", () => {
    const [segment] = idSegments(ULID);
    expect(segment).toEqual({ text: ULID, id: ULID });
  });

  it("keeps a short id out of the token, so a commit sha reads as written", () => {
    expect(idSegments("commit 5b13225bd is fine").every((segment) => segment.id === undefined)).toBe(true);
  });
});

describe("threadHeadline", () => {
  it("composes the row's line: the tags gone, each long id its own run, the rest as written", () => {
    const runs = threadHeadline(`From product-lead, landed ${ULID} today`, ["product-lead"]);
    expect(runs.filter((segment) => segment.id !== undefined)).toEqual([{ text: ULID, id: ULID }]);
    expect(words(`From product-lead, landed ${ULID} today`, ["product-lead"])).toBe(`Landed ${ULID} today`);
    expect(words("Review ask, from product-feed: the Needs you feed's filters", ["product-feed"])).toBe(
      "Review ask, the Needs you feed's filters",
    );
    // An address or an identifier that opens the line keeps its own case.
    expect(words("From product-lead, junto.db is the only store", ["product-lead"])).toBe("junto.db is the only store");
  });
});
