import { mentionLink, type MentionOf } from "./mention";

/**
 * A `[[ ]]` link between artifacts (plan 0.11, 02): typed as `[[Title]]`,
 * stored as a plain mention link by id whose label is `[[Title]]`, the title
 * when it was written:
 *
 *   [\[\[Launch plan\]\]](junto://canvas/factory?node=artifacts-01M...&item=01M...)
 *
 * Every reader of mentions already reads it (`mentionLinksOf` gives the label
 * back as `[[Launch plan]]`); a reader that draws it shows the artifact's
 * current title, so a rename never breaks a link. The label's brackets are
 * what tell it from a `#` mention of the same artifact.
 *
 * A wire module (0.11.3), so the phone writes and reads `[[ ]]` links as the
 * desktop does: its import closure is `effect` alone. `src/shared/artifact-link.ts`
 * re-exports it and keeps what a link names now (its states and words).
 */

const OPEN = "[[";
const CLOSE = "]]";

/** The link text for a title: `[[Title]]`. */
export const artifactLinkLabel = (title: string): string => `${OPEN}${title}${CLOSE}`;

/** `[[[Title]]](junto://...)` with the brackets escaped, as every writer (document, pad, sheet, CLI) writes it. */
export const artifactLink = (ref: MentionOf<"artifact">, title: string, canvasName: string): string => {
  if (title.trim() === "") throw new RangeError("an artifact link needs a title");
  return mentionLink(ref, artifactLinkLabel(title), canvasName);
};

/**
 * The title a link was written with, when its label is a `[[ ]]` link's, or
 * undefined for any other label. Takes the label as `mentionLinksOf` gives it,
 * or as written in the source with its brackets escaped.
 */
export const artifactLinkTitle = (label: string): string | undefined => {
  const plain = label.replace(/\\([\\[\]])/g, "$1");
  if (!plain.startsWith(OPEN) || !plain.endsWith(CLOSE)) return undefined;
  const title = plain.slice(OPEN.length, -CLOSE.length);
  return title.trim() === "" ? undefined : title;
};
