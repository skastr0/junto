/**
 * Words in markdown as a reader counts them, for a work signal's condition
 * ("at least 500 words", plan 0.11/07). A word is a run of characters
 * between spaces holding at least one letter or digit, so markdown's own
 * marks (`#`, `-`, `>`, `**` alone) are not words, `**bold**` is one, a link
 * counts the words of its text and its address joins the word before it,
 * and an HTML comment counts nothing. One rule, here, so the field that
 * fills as the operator writes and main's ruling agree.
 */
const COMMENT = /<!--[\s\S]*?(?:-->|$)/gu;
const WORDISH = /[\p{L}\p{N}]/u;

export const wordCountOf = (markdown: string): number =>
  markdown
    .replace(COMMENT, " ")
    .split(/\s+/u)
    .reduce((count, run) => (WORDISH.test(run) ? count + 1 : count), 0);
