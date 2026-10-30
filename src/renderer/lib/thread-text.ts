/**
 * The words a thread shows, cut on the way to the screen.
 *
 * Mail opens with a tag that repeats who wrote it ("From planner,",
 * "planner:", "planner to builder:") and writes code-ish words in angle
 * brackets (<paths>, <author>). A thread already names its author above every
 * message, so the tag is noise, and the angle brackets are words a person
 * typed, not markup. Both are handled here, at render: the stored mail, the
 * thread's title and what main counts as unread never change.
 */
/** A name as the mail writes it: literal, in any case. */
const escapeName = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const knownNames = (known: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(known.map((name) => name.trim()).filter((name) => name !== ""))].sort((a, b) => b.length - a.length);

/**
 * A head that lost its tag opens with a capital: "operator request for 0.11.6"
 * reads as a sentence once "From product-lead," is gone. Only a plain word is
 * capitalised, so an address or an identifier that opens the line is kept.
 */
export const sentenceCase = (text: string): string =>
  /^[a-z]{3,}(?=[\s,:]|\.(?:\s|$)|$)/u.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text;

/**
 * The mail's words without the tag that repeats who wrote them. `known` is
 * the names drawn beside the words: the message's author in a thread, the
 * thread's participants in a list row. A name is dropped only when the mail
 * punctuates it as a tag, so "planner thought the diff was fine" keeps its
 * sentence.
 */
export const stripAuthorPreamble = (text: string, known: ReadonlyArray<string>): string => {
  const names = knownNames(known);
  if (names.length === 0) return text;
  const who = names.map(escapeName).join("|");
  // The bracketed form may stand alone; the rest need their own punctuation.
  const tags = [
    new RegExp(`^\\s*\\[from\\s+(?:${who})\\](?![\\w])\\s*[:,\\u2014\\u2013-]?\\s*`, "iu"),
    new RegExp(`^\\s*from\\s+(?:${who})(?:\\s+to\\s+[^:,\\n]{1,40})?\\s*(?:[:,\\u2014\\u2013-]|\\.(?=\\s|$))\\s*`, "iu"),
    new RegExp(`^\\s*(?:${who})\\s+to\\s+[^:,\\n]{1,40}\\s*:\\s*`, "iu"),
    new RegExp(`^\\s*(?:${who})\\s*(?:[:,\\u2014\\u2013-]|\\.(?=\\s|$))\\s*`, "iu"),
  ];
  for (const tag of tags) {
    const match = tag.exec(text);
    if (match === null) continue;
    const rest = text.slice(match[0].length);
    return rest.trim() === "" ? text : sentenceCase(rest);
  }
  return text;
};

/**
 * The tag some mail writes after its subject: "Review ask, from product-feed:".
 * A thread's first line only, and only when a short subject comes before it:
 * in a body the same shape is a clause ("the report, from product-feed: it
 * says"), and a body keeps its clause.
 */
export const stripHeadTag = (text: string, known: ReadonlyArray<string>): string => {
  const names = knownNames(known);
  if (names.length === 0) return text;
  const who = names.map(escapeName).join("|");
  // The separator before "from" is the tag's own: a comma stays a comma.
  const tag = new RegExp(`(\\s*,\\s*|\\s+)from\\s+(?:${who})\\s*[:.]\\s*`, "iu");
  const match = tag.exec(text);
  if (match === null || match.index > 40) return text;
  const before = text.slice(0, match.index).replace(/[\s,]+$/u, "");
  const after = text.slice(match.index + match[0].length);
  if (before === "" || after.trim() === "") return text;
  return `${before}${(match[1] ?? "").includes(",") ? ", " : " "}${after}`.trim();
};

/**
 * A long machine id: a 26 character ULID in Crockford base32 (no I, L, O or U,
 * and a real one carries digits in its timestamp, so a shouted word is not
 * one), or a hex run of twelve or more. Not beside a slash, a dot, a colon or
 * a dash, so paths and URLs are never touched.
 */
const ID_PATTERN = /(?<![\w/.:-])(?:(?=[0-9A-HJKMNP-TV-Z]*[0-9])[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{12,})(?![\w/.:-])/gu;

/** One run of the words; `id` is set when the run is a long id, whole. */
export type IdSegment = { readonly text: string; readonly id?: string };

/** The words split so each long id is its own segment, the whole id kept. */
export const idSegments = (text: string): ReadonlyArray<IdSegment> => {
  const out: IdSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(ID_PATTERN)) {
    const index = match.index ?? 0;
    if (index > at) out.push({ text: text.slice(at, index) });
    out.push({ text: match[0], id: match[0] });
    at = index + match[0].length;
  }
  if (out.length === 0) return [{ text }];
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
};

/**
 * A list row's or a header's line, as the runs it is drawn from: the tags gone,
 * each long id its own run so the surface can draw it as the token whose whole
 * value stays in the document. Never a cut string: a row is a button whose
 * name is its text, and copy and a screen reader must get the whole id.
 */
export const threadHeadline = (text: string, known: ReadonlyArray<string>): ReadonlyArray<IdSegment> => {
  const stripped = stripHeadTag(stripAuthorPreamble(text, known), known);
  // Only a line that lost its tag is opened with a capital; the writer's own
  // first word is never touched.
  return idSegments(stripped === text ? text : sentenceCase(stripped));
};
