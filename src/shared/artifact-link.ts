import type { ArtifactType } from "./artifact";
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

// --- what a link names now ---------------------------------------------------

/** What a reader knows of an artifact a link names: one entry of its Artifacts node's list. */
export type LinkedArtifactHead = {
  readonly artifactId: string;
  readonly title: string;
  readonly type: ArtifactType;
  readonly archived: boolean;
};

/**
 * One link state for every surface that draws an artifact link (document,
 * pad, sheet): `unread` until its node is read (the words it was written
 * with), `live`, `archived` (still opens, read-only), or `missing` (the node
 * or the artifact is gone, or never held it). A missing link claims no title.
 */
export type ArtifactLinkState =
  | { readonly state: "unread"; readonly words: string }
  | { readonly state: "live"; readonly words: string; readonly type: ArtifactType }
  | { readonly state: "archived"; readonly words: string; readonly type: ArtifactType }
  | { readonly state: "missing"; readonly words: string };

/** What a missing link says in place of a title. */
export const MISSING_ARTIFACT_WORDS = "Missing artifact";

/** What opening a missing link says. */
export const ARTIFACT_GONE_LINE = "This artifact is gone: it was deleted, or the link names one that never existed.";

/**
 * The state of a link to `artifactId`, from what its node holds: `heads`
 * undefined while the node is unread, null when the node is gone or is not
 * an Artifacts node. `written` is the link's label as written (`[[Title]]`
 * or `#Title`); a `[[ ]]` link and a `#` mention resolve alike, words aside:
 * the words are the title as it is now.
 */
export const artifactLinkStateOf = (
  artifactId: string,
  heads: ReadonlyArray<LinkedArtifactHead> | null | undefined,
  written: string,
): ArtifactLinkState => {
  if (heads === undefined) return { state: "unread", words: artifactLinkTitle(written) ?? written.replace(/^#/u, "") };
  const head = heads?.find((entry) => entry.artifactId === artifactId);
  if (head === undefined) return { state: "missing", words: MISSING_ARTIFACT_WORDS };
  return { state: head.archived ? "archived" : "live", words: head.title, type: head.type };
};
