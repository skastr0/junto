/**
 * Words in markdown as a reader counts them, for a work signal's condition
 * ("at least 500 words", plan 0.11/07). A word is a run of characters
 * between spaces holding at least one letter or digit. Markdown's own marks
 * (`#`, `-`, `>`, `**` alone), a fence line and an address are not words;
 * `**bold**` is one, a link counts by its text, and an HTML comment counts
 * nothing. Code inside a fence counts, as written words: only the fence
 * lines themselves do not. One rule, here, so the field that fills as the operator writes
 * and main's ruling agree.
 */
const COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;
const FENCE = /^[ \t]*(?:```|~~~).*$/gmu;
// A link's or an image's address, `](...)`, and an address in angle brackets.
const LINK_TARGET = /\]\([^)]*\)/gu;
const AUTOLINK = /<[a-z][a-z0-9+.-]*:[^>\s]*>/giu;
const ADDRESS = /^[([<]?(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S*$/iu;
const WORDISH = /[\p{L}\p{N}]/u;

export const signalWordCount = (markdown: string): number =>
  markdown
    .replace(COMMENT, " ")
    .replace(FENCE, " ")
    .replace(LINK_TARGET, "]")
    .replace(AUTOLINK, " ")
    .split(/\s+/u)
    .reduce((count, run) => (WORDISH.test(run) && !ADDRESS.test(run) ? count + 1 : count), 0);
